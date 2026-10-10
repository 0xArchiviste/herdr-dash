package main

// Optional usage strip: how much is left on the agent plans and providers on
// this machine. Three auto-detected sources, each disabled cleanly when its
// files are absent:
//
//   - claude: Claude Code's plan limits (5-hour session, weekly, per-model
//     weekly). Claude Code's own cached /usage answer in ~/.claude.json is
//     used while it is fresh; otherwise the endpoint Claude Code calls
//     (GET /api/oauth/usage) with the OAuth token from .credentials.json.
//     The token is only read: never refreshed, written or used once expired.
//   - codex: the last rate_limits event in the newest Codex session file.
//   - opencode: the configured model's provider; OpenRouter's /credits when
//     that is the provider, "unavailable" for providers without a balance API.
//
// Nothing runs until the page asks (GET /api/usage); answers are cached per
// source, network answers for longer, and one read per source runs at a time.
// Credentials go only to the provider's own endpoint, never to the page or
// the log.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	usageTimeout   = 3 * time.Second
	usageBodyMax   = 1 << 20
	codexTailBytes = 512 << 10
	claudeBeta     = "oauth-2025-04-20"
)

type UsageConfig struct {
	Mode           string // auto, off, or a comma list of source ids
	ClaudeHome     string // holds .credentials.json
	ClaudeState    string // Claude Code's .claude.json
	ClaudeURL      string
	CodexDir       string
	OpencodeConfig string
	OpencodeData   string
	LocalEvery     time.Duration // re-read local files at most this often
	NetEvery       time.Duration // call a provider at most this often
}

// usageFlags registers the usage flags; call before flag.Parse.
func usageFlags(home string) *UsageConfig {
	c := &UsageConfig{}
	claudeHome := env("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	claudeState := filepath.Join(home, ".claude.json")
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		claudeState = filepath.Join(d, ".claude.json")
	}
	xdg := func(key, def string) string { return filepath.Join(env(key, filepath.Join(home, def)), "opencode") }
	flag.StringVar(&c.Mode, "usage", env("HERDR_DASH_USAGE", "auto"), "usage sources, $HERDR_DASH_USAGE: auto, off, or a list like claude,codex,opencode")
	flag.StringVar(&c.ClaudeHome, "claude-home", env("HERDR_DASH_CLAUDE_HOME", claudeHome), "Claude Code config dir with .credentials.json, $HERDR_DASH_CLAUDE_HOME")
	flag.StringVar(&c.ClaudeState, "claude-state", env("HERDR_DASH_CLAUDE_STATE", claudeState), "Claude Code state file (.claude.json), $HERDR_DASH_CLAUDE_STATE")
	flag.StringVar(&c.ClaudeURL, "claude-usage-url", env("HERDR_DASH_CLAUDE_USAGE_URL", "https://api.anthropic.com/api/oauth/usage"), "Claude plan usage endpoint, $HERDR_DASH_CLAUDE_USAGE_URL")
	flag.StringVar(&c.OpencodeConfig, "opencode-config", env("HERDR_DASH_OPENCODE_CONFIG", xdg("XDG_CONFIG_HOME", ".config")), "opencode config dir, $HERDR_DASH_OPENCODE_CONFIG")
	flag.StringVar(&c.OpencodeData, "opencode-data", env("HERDR_DASH_OPENCODE_DATA", xdg("XDG_DATA_HOME", ".local/share")), "opencode data dir (auth.json), $HERDR_DASH_OPENCODE_DATA")
	flag.DurationVar(&c.LocalEvery, "usage-every", 2*time.Minute, "re-read local usage files at most this often")
	flag.DurationVar(&c.NetEvery, "usage-net-every", 5*time.Minute, "call a provider's usage endpoint at most this often")
	return c
}

func (c UsageConfig) on(id string) bool {
	switch m := strings.TrimSpace(c.Mode); m {
	case "", "auto", "on":
		return true
	case "off", "none":
		return false
	default:
		for _, s := range strings.Split(m, ",") {
			if strings.TrimSpace(s) == id {
				return true
			}
		}
		return false
	}
}

type UsageWindow struct {
	Label       string     `json:"label"`
	UsedPercent float64    `json:"used_percent"`
	ResetsAt    *time.Time `json:"resets_at,omitempty"`
	Minutes     int        `json:"window_minutes,omitempty"`
	ResetPassed bool       `json:"reset_passed,omitempty"`
}

type UsageBalance struct {
	Remaining float64  `json:"remaining"`
	Total     *float64 `json:"total,omitempty"`
	Unit      string   `json:"unit"` // USD or credits
}

type UsageSource struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	Status    string        `json:"status"` // ok, unavailable, disabled
	Reason    string        `json:"reason,omitempty"`
	Plan      string        `json:"plan,omitempty"`
	AsOf      *time.Time    `json:"as_of,omitempty"` // when the numbers were true
	CheckedAt time.Time     `json:"checked_at"`
	Stale     bool          `json:"stale"`
	Windows   []UsageWindow `json:"windows"`
	Balance   *UsageBalance `json:"balance"`
}

type Usage struct {
	cfg     UsageConfig
	client  *http.Client
	sources []*usageSource
}

// usageSource caches one source's answer and lets one read run at a time.
type usageSource struct {
	id, name string
	read     func(ctx context.Context) UsageSource
	every    time.Duration
	mu       sync.Mutex
	last     UsageSource
	at       time.Time
	running  chan struct{}
}

func NewUsage(cfg UsageConfig) *Usage {
	if cfg.LocalEvery <= 0 {
		cfg.LocalEvery = 2 * time.Minute
	}
	if cfg.NetEvery < time.Minute {
		cfg.NetEvery = 5 * time.Minute
	}
	u := &Usage{cfg: cfg, client: &http.Client{
		Timeout: usageTimeout,
		// A credential never follows a redirect anywhere.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	cl := &claudeUsage{u: u}
	cx := &codexUsage{u: u}
	oc := &opencodeUsage{u: u}
	u.sources = []*usageSource{
		{id: "claude", name: "Claude", read: cl.read},
		{id: "codex", name: "Codex", read: cx.read},
		{id: "opencode", name: "opencode", read: oc.read},
	}
	for _, s := range u.sources {
		s.every = cfg.LocalEvery
	}
	return u
}

func (u *Usage) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/usage", func(w http.ResponseWriter, r *http.Request) {
		out := make([]UsageSource, len(u.sources))
		var wg sync.WaitGroup
		for i, s := range u.sources {
			wg.Add(1)
			go func() { defer wg.Done(); out[i] = u.get(s) }()
		}
		wg.Wait()
		enabled := false
		for _, s := range out {
			enabled = enabled || s.Status != "disabled"
		}
		writeJSON(w, map[string]any{"enabled": enabled, "generated_at": time.Now().UTC(), "sources": out,
			"refresh_seconds": int(u.cfg.LocalEvery.Seconds())})
	})
}

func (u *Usage) get(s *usageSource) UsageSource {
	if !u.cfg.on(s.id) {
		return UsageSource{ID: s.id, Name: s.name, Status: "disabled", Reason: "turned off", CheckedAt: time.Now().UTC(), Windows: []UsageWindow{}}
	}
	s.mu.Lock()
	if !s.at.IsZero() && time.Since(s.at) < s.every {
		defer s.mu.Unlock()
		return s.last
	}
	if ch := s.running; ch != nil {
		s.mu.Unlock()
		<-ch
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.last
	}
	ch := make(chan struct{})
	s.running = ch
	s.mu.Unlock()

	// Not the request's context: a closed tab must not spoil the shared read.
	ctx, cancel := context.WithTimeout(context.Background(), usageTimeout+500*time.Millisecond)
	res := s.read(ctx)
	cancel()
	res.ID, res.Name, res.CheckedAt = s.id, s.name, time.Now().UTC()
	if res.Windows == nil {
		res.Windows = []UsageWindow{}
	}

	s.mu.Lock()
	s.last, s.at, s.running = res, time.Now(), nil
	s.mu.Unlock()
	close(ch)
	return res
}

// fetchJSON GETs url with a bearer token and decodes a 200 answer into v.
// Errors name the failure, never the token or the body.
func (u *Usage) fetchJSON(ctx context.Context, rawURL, token string, headers map[string]string, v any) error {
	ctx, cancel := context.WithTimeout(ctx, usageTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return errors.New("bad endpoint URL")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "herdr-dash")
	for k, val := range headers {
		req.Header.Set(k, val)
	}
	resp, err := u.client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) || ctx.Err() != nil {
			return errors.New("timed out")
		}
		return errors.New("unreachable")
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return fmt.Errorf("credentials rejected (HTTP %d)", resp.StatusCode)
	case resp.StatusCode == http.StatusTooManyRequests:
		return errors.New("rate limited (HTTP 429)")
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, usageBodyMax)).Decode(v); err != nil {
		return errors.New("unexpected answer")
	}
	return nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func ptrTime(t time.Time) *time.Time { t = t.UTC(); return &t }

func unavailable(reason string) UsageSource {
	return UsageSource{Status: "unavailable", Reason: reason}
}

// ---------------------------------------------------------------- Claude Code

type claudeUsage struct {
	u      *Usage
	mu     sync.Mutex
	netAt  time.Time
	netWin []UsageWindow
	netErr error
}

type claudeLimits struct {
	Limits []struct {
		Kind     string   `json:"kind"`
		Percent  *float64 `json:"percent"`
		ResetsAt string   `json:"resets_at"`
		Scope    *struct {
			Model *struct {
				DisplayName string `json:"display_name"`
			} `json:"model"`
			Surface *struct {
				DisplayName string `json:"display_name"`
			} `json:"surface"`
		} `json:"scope"`
	} `json:"limits"`
	FiveHour   *claudeWindow `json:"five_hour"`
	SevenDay   *claudeWindow `json:"seven_day"`
	SevenOpus  *claudeWindow `json:"seven_day_opus"`
	SevenSonet *claudeWindow `json:"seven_day_sonnet"`
}

type claudeWindow struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

func usageTime(s string) *time.Time {
	if s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return nil
	}
	return ptrTime(t)
}

func (l claudeLimits) windows() []UsageWindow {
	var out []UsageWindow
	for _, x := range l.Limits {
		if x.Percent == nil {
			continue
		}
		label := map[string]string{"session": "5h", "weekly_all": "Week", "weekly_scoped": "Week"}[x.Kind]
		if label == "" {
			label = strings.ReplaceAll(x.Kind, "_", " ")
		}
		if x.Scope != nil {
			if x.Scope.Model != nil && x.Scope.Model.DisplayName != "" {
				label += " · " + x.Scope.Model.DisplayName
			} else if x.Scope.Surface != nil && x.Scope.Surface.DisplayName != "" {
				label += " · " + x.Scope.Surface.DisplayName
			}
		}
		out = append(out, UsageWindow{Label: label, UsedPercent: *x.Percent, ResetsAt: usageTime(x.ResetsAt)})
	}
	if len(out) > 0 {
		return out
	}
	for _, w := range []struct {
		label string
		w     *claudeWindow
	}{{"5h", l.FiveHour}, {"Week", l.SevenDay}, {"Week · Opus", l.SevenOpus}, {"Week · Sonnet", l.SevenSonet}} {
		if w.w != nil && w.w.Utilization != nil {
			out = append(out, UsageWindow{Label: w.label, UsedPercent: *w.w.Utilization, ResetsAt: usageTime(w.w.ResetsAt)})
		}
	}
	return out
}

type claudeCreds struct {
	OAuth *struct {
		AccessToken      string `json:"accessToken"`
		ExpiresAt        int64  `json:"expiresAt"`
		SubscriptionType string `json:"subscriptionType"`
	} `json:"claudeAiOauth"`
}

// cache reads Claude Code's own last /usage answer from its state file. The
// file is large and holds other data: only that one key is decoded.
func (c *claudeUsage) cache() (wins []UsageWindow, at time.Time, ok bool) {
	b, err := os.ReadFile(c.u.cfg.ClaudeState)
	if err != nil {
		return nil, at, false
	}
	var st struct {
		Cached *struct {
			FetchedAtMs int64        `json:"fetchedAtMs"`
			Util        claudeLimits `json:"utilization"`
		} `json:"cachedUsageUtilization"`
	}
	if json.Unmarshal(b, &st) != nil || st.Cached == nil || st.Cached.FetchedAtMs == 0 {
		return nil, at, false
	}
	wins = st.Cached.Util.windows()
	return wins, time.UnixMilli(st.Cached.FetchedAtMs), len(wins) > 0
}

func (c *claudeUsage) read(ctx context.Context) UsageSource {
	var creds claudeCreds
	b, err := os.ReadFile(filepath.Join(c.u.cfg.ClaudeHome, ".credentials.json"))
	haveCreds := err == nil && json.Unmarshal(b, &creds) == nil && creds.OAuth != nil && creds.OAuth.AccessToken != ""
	cached, cachedAt, haveCache := c.cache()
	if !haveCreds && !haveCache {
		return UsageSource{Status: "disabled", Reason: "no Claude Code credentials or cached usage"}
	}
	plan := ""
	if haveCreds {
		plan = creds.OAuth.SubscriptionType
	}
	fromCache := func(reason string) UsageSource {
		stale := time.Since(cachedAt) > c.u.cfg.NetEvery
		return UsageSource{Status: "ok", Plan: plan, Windows: cached, AsOf: ptrTime(cachedAt), Stale: stale, Reason: reason}
	}
	// Passive first: Claude Code's own answer while it is fresh.
	if haveCache && time.Since(cachedAt) < c.u.cfg.NetEvery {
		return fromCache("")
	}
	fail := func(reason string) UsageSource {
		if haveCache {
			return fromCache(reason)
		}
		s := unavailable(reason)
		s.Plan = plan
		return s
	}
	if !haveCreds {
		return fail("no Claude Code credentials file")
	}
	if exp := creds.OAuth.ExpiresAt; exp > 0 && time.Now().UnixMilli() >= exp {
		return fail("token expired; Claude Code renews it when it next runs")
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.netAt.IsZero() || time.Since(c.netAt) >= c.u.cfg.NetEvery {
		var l claudeLimits
		err := c.u.fetchJSON(ctx, c.u.cfg.ClaudeURL, creds.OAuth.AccessToken, map[string]string{"anthropic-beta": claudeBeta}, &l)
		c.netAt, c.netWin, c.netErr = time.Now(), l.windows(), err
		if err == nil && len(c.netWin) == 0 {
			c.netErr = errors.New("no limits in the answer")
		}
		if c.netErr != nil {
			log.Printf("usage: claude: %v", c.netErr)
		}
	}
	if c.netErr != nil {
		return fail(c.netErr.Error())
	}
	return UsageSource{Status: "ok", Plan: plan, Windows: c.netWin, AsOf: ptrTime(c.netAt)}
}

// ---------------------------------------------------------------- Codex

type codexUsage struct{ u *Usage }

type codexWindow struct {
	UsedPercent     *float64 `json:"used_percent"`
	WindowMinutes   int      `json:"window_minutes"`
	ResetsAt        int64    `json:"resets_at"`
	ResetsInSeconds int64    `json:"resets_in_seconds"`
}

type codexEvent struct {
	Timestamp string `json:"timestamp"`
	Payload   struct {
		RateLimits *struct {
			Primary   *codexWindow `json:"primary"`
			Secondary *codexWindow `json:"secondary"`
			Credits   *struct {
				HasCredits bool            `json:"has_credits"`
				Unlimited  bool            `json:"unlimited"`
				Balance    json.RawMessage `json:"balance"`
			} `json:"credits"`
			PlanType string `json:"plan_type"`
		} `json:"rate_limits"`
	} `json:"payload"`
}

func windowLabel(min int) string {
	switch {
	case min == 300:
		return "5h"
	case min == 10080:
		return "Week"
	case min > 0 && min%1440 == 0:
		return fmt.Sprintf("%dd", min/1440)
	case min > 0 && min%60 == 0:
		return fmt.Sprintf("%dh", min/60)
	case min > 0:
		return fmt.Sprintf("%dm", min)
	}
	return "Window"
}

// recentFiles lists session files in the newest few day directories
// (YYYY/MM/DD), newest modification first. A session lives in the directory
// of the day it started, so a long one can be in an older directory.
func recentFiles(dir string, days int) []string {
	type f struct {
		p string
		t time.Time
	}
	var all []f
	desc := func(p string) []string {
		ents, _ := os.ReadDir(p)
		var names []string
		for _, e := range ents {
			if e.IsDir() {
				names = append(names, e.Name())
			}
		}
		sort.Sort(sort.Reverse(sort.StringSlice(names)))
		return names
	}
	seen := 0
	for _, y := range desc(dir) {
		for _, m := range desc(filepath.Join(dir, y)) {
			for _, d := range desc(filepath.Join(dir, y, m)) {
				if seen >= days {
					break
				}
				seen++
				ents, _ := os.ReadDir(filepath.Join(dir, y, m, d))
				for _, e := range ents {
					if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
						if fi, err := e.Info(); err == nil {
							all = append(all, f{filepath.Join(dir, y, m, d, e.Name()), fi.ModTime()})
						}
					}
				}
			}
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.After(all[j].t) })
	out := make([]string, len(all))
	for i, x := range all {
		out[i] = x.p
	}
	return out
}

var rateLimitsRe = regexp.MustCompile(`"rate_limits":\s*\{`)

// lastRateLimits finds the last event with rate limits in the tail of path.
func lastRateLimits(path string) (codexEvent, bool) {
	f, err := os.Open(path)
	if err != nil {
		return codexEvent{}, false
	}
	defer f.Close()
	if fi, err := f.Stat(); err == nil && fi.Size() > codexTailBytes {
		f.Seek(fi.Size()-codexTailBytes, io.SeekStart)
	}
	var found codexEvent
	ok := false
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), codexTailBytes)
	for sc.Scan() {
		line := sc.Bytes()
		if !rateLimitsRe.Match(line) {
			continue
		}
		var ev codexEvent
		if json.Unmarshal(line, &ev) == nil && ev.Payload.RateLimits != nil {
			found, ok = ev, true
		}
	}
	return found, ok
}

func (c *codexUsage) read(ctx context.Context) UsageSource {
	dir := c.u.cfg.CodexDir
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return UsageSource{Status: "disabled", Reason: "no Codex sessions directory"}
	}
	files := recentFiles(dir, 3)
	for i, p := range files {
		if i >= 4 {
			break
		}
		ev, ok := lastRateLimits(p)
		if !ok {
			continue
		}
		at := time.Now()
		if t := usageTime(ev.Timestamp); t != nil {
			at = *t
		}
		rl := ev.Payload.RateLimits
		s := UsageSource{Status: "ok", Plan: rl.PlanType, AsOf: ptrTime(at)}
		for _, w := range []*codexWindow{rl.Primary, rl.Secondary} {
			if w == nil || w.UsedPercent == nil {
				continue
			}
			uw := UsageWindow{Label: windowLabel(w.WindowMinutes), UsedPercent: *w.UsedPercent, Minutes: w.WindowMinutes}
			if w.ResetsAt > 0 {
				uw.ResetsAt = ptrTime(time.Unix(w.ResetsAt, 0))
			} else if w.ResetsInSeconds > 0 {
				uw.ResetsAt = ptrTime(at.Add(time.Duration(w.ResetsInSeconds) * time.Second))
			}
			if uw.ResetsAt != nil && time.Now().After(*uw.ResetsAt) {
				// The window has rolled over since Codex last said: nothing used yet.
				uw.UsedPercent, uw.ResetPassed = 0, true
			}
			s.Windows = append(s.Windows, uw)
		}
		if cr := rl.Credits; cr != nil && cr.HasCredits && !cr.Unlimited {
			raw := strings.Trim(string(cr.Balance), `"`)
			if v, err := strconv.ParseFloat(raw, 64); err == nil {
				s.Balance = &UsageBalance{Remaining: v, Unit: "credits"}
			}
		}
		return s
	}
	return unavailable("no rate-limit data in recent Codex sessions")
}

// ---------------------------------------------------------------- opencode

type opencodeUsage struct {
	u      *Usage
	mu     sync.Mutex
	netAt  time.Time
	netKey string // which provider/base the cached answer is for
	net    UsageSource
}

type opencodeProvider struct {
	Name    string `json:"name"`
	Options struct {
		BaseURL string `json:"baseURL"`
		APIKey  string `json:"apiKey"`
	} `json:"options"`
}

// jsonc strips // and /* */ comments outside strings, then trailing commas.
func jsonc(b []byte) []byte {
	return stripJSON(stripJSON(b, true), false)
}

// stripJSON copies b, skipping comments (comments) or trailing commas (!comments)
// outside strings.
func stripJSON(b []byte, comments bool) []byte {
	var out bytes.Buffer
	inStr, esc := false, false
	for i := 0; i < len(b); i++ {
		ch := b[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case ch == '\\':
				esc = true
			case ch == '"':
				inStr = false
			}
			out.WriteByte(ch)
			continue
		}
		switch {
		case ch == '"':
			inStr = true
		case comments && ch == '/' && i+1 < len(b) && b[i+1] == '/':
			for i < len(b) && b[i] != '\n' {
				i++
			}
		case comments && ch == '/' && i+1 < len(b) && b[i+1] == '*':
			for i += 2; i+1 < len(b) && !(b[i] == '*' && b[i+1] == '/'); i++ {
			}
			i++
			continue
		case !comments && ch == ',':
			j := i + 1
			for j < len(b) && strings.ContainsRune(" \t\r\n", rune(b[j])) {
				j++
			}
			if j < len(b) && (b[j] == '}' || b[j] == ']') {
				continue
			}
		}
		if i < len(b) {
			out.WriteByte(b[i])
		}
	}
	return out.Bytes()
}

func (o *opencodeUsage) config() (map[string]json.RawMessage, string, bool) {
	for _, name := range []string{"opencode.jsonc", "opencode.json", "config.json"} {
		p := filepath.Join(o.u.cfg.OpencodeConfig, name)
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(jsonc(b), &m) == nil {
			return m, p, true
		}
	}
	return nil, "", false
}

// key resolves a provider key the way opencode does: a literal, {env:VAR},
// {file:path}, else auth.json.
func (o *opencodeUsage) key(id, apiKey, cfgPath string) string {
	if v, ok := strings.CutPrefix(apiKey, "{env:"); ok {
		return os.Getenv(strings.TrimSuffix(v, "}"))
	}
	if v, ok := strings.CutPrefix(apiKey, "{file:"); ok {
		p := strings.TrimSuffix(v, "}")
		if rest, ok := strings.CutPrefix(p, "~/"); ok {
			home, _ := os.UserHomeDir()
			p = filepath.Join(home, rest)
		} else if !filepath.IsAbs(p) {
			p = filepath.Join(filepath.Dir(cfgPath), p)
		}
		b, _ := os.ReadFile(p)
		return strings.TrimSpace(string(b))
	}
	if apiKey != "" {
		return apiKey
	}
	var auth map[string]struct {
		Type string `json:"type"`
		Key  string `json:"key"`
	}
	if b, err := os.ReadFile(filepath.Join(o.u.cfg.OpencodeData, "auth.json")); err == nil && json.Unmarshal(b, &auth) == nil {
		if a, ok := auth[id]; ok && a.Type == "api" && a.Key != "" {
			return a.Key
		}
	}
	if id == "openrouter" {
		return os.Getenv("OPENROUTER_API_KEY")
	}
	return ""
}

func (o *opencodeUsage) read(ctx context.Context) UsageSource {
	cfg, cfgPath, ok := o.config()
	if !ok {
		return UsageSource{Status: "disabled", Reason: "no opencode config"}
	}
	var model string
	json.Unmarshal(cfg["model"], &model)
	if model == "" {
		return unavailable("no model set in the opencode config")
	}
	id, _, _ := strings.Cut(model, "/")
	var providers map[string]opencodeProvider
	json.Unmarshal(cfg["provider"], &providers)
	p := providers[id]
	name := p.Name
	if name == "" {
		name = id
	}
	base := strings.TrimRight(p.Options.BaseURL, "/")
	host := ""
	if u, err := url.Parse(base); err == nil {
		host = u.Hostname()
	}
	isOpenRouter := id == "openrouter" || host == "openrouter.ai" || strings.HasSuffix(host, ".openrouter.ai")
	if !isOpenRouter {
		s := unavailable(name + " has no balance API")
		s.Plan = model
		return s
	}
	if base == "" {
		base = "https://openrouter.ai/api/v1"
	}
	key := o.key(id, p.Options.APIKey, cfgPath)
	if key == "" {
		s := unavailable("no API key found for " + name)
		s.Plan = model
		return s
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	if o.netKey != base || o.netAt.IsZero() || time.Since(o.netAt) >= o.u.cfg.NetEvery {
		var r struct {
			Data struct {
				TotalCredits *float64 `json:"total_credits"`
				TotalUsage   *float64 `json:"total_usage"`
			} `json:"data"`
		}
		err := o.u.fetchJSON(ctx, base+"/credits", key, nil, &r)
		switch {
		case err != nil:
			log.Printf("usage: opencode: %s: %v", name, err)
			o.net = unavailable(err.Error())
		case r.Data.TotalCredits == nil || r.Data.TotalUsage == nil:
			o.net = unavailable("unexpected answer")
		default:
			total := *r.Data.TotalCredits
			rem := math.Round((total-*r.Data.TotalUsage)*100) / 100
			o.net = UsageSource{Status: "ok", AsOf: ptrTime(time.Now()), Balance: &UsageBalance{Remaining: rem, Total: &total, Unit: "USD"}}
		}
		o.netAt, o.netKey = time.Now(), base
	}
	s := o.net
	s.Plan = model
	return s
}
