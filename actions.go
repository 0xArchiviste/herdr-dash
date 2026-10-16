package main

// The write side: a small, allow-listed set of herdr-projects subcommands the
// page may run. Every argument is validated here, free text goes through
// stdin (or one `--text=` argv element for `thread keys`, which has no stdin
// form), and no shell is ever involved. Raw `herdr agent ...` writes are never
// used: herdr-projects owns the refusals (blocked agent, draft in the input
// box, trust screens) and records follow-ups in the task file.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxPromptBytes = 8000
	maxKeysText    = 500
	maxKeys        = 8
	maxBulk        = 200
	maxScreenSubs  = 16
)

// allowedKeys are the key names `thread keys` may press: enough to answer a
// question menu or a permission prompt. No ctrl chords: ctrl+c would kill
// the agent.
var allowedKeys = map[string]bool{
	"enter": true, "esc": true, "up": true, "down": true, "left": true, "right": true,
	"tab": true, "space": true, "backspace": true, "y": true, "n": true,
	"0": true, "1": true, "2": true, "3": true, "4": true, "5": true, "6": true, "7": true, "8": true, "9": true,
}

// codeRe pulls the machine-readable refusal out of a herdr-projects error.
var codeRe = regexp.MustCompile(`\b(agent_blocked|prompt_unconfirmed|draft_in_box)\b`)

type Actions struct {
	cfg     Config
	col     *Collector
	mu      sync.Mutex // one write command at a time keeps load tiny
	bucket  *bucket
	screens atomic.Int32
}

func NewActions(cfg Config, col *Collector) *Actions {
	return &Actions{cfg: cfg, col: col, bucket: newBucket(cfg.WriteBurst, cfg.WritePerMin)}
}

// bucket is a token bucket: burst tokens, refilled at perMin a minute.
type bucket struct {
	mu     sync.Mutex
	tokens float64
	burst  float64
	rate   float64 // per second
	last   time.Time
}

func newBucket(burst, perMin int) *bucket {
	return &bucket{tokens: float64(burst), burst: float64(burst), rate: float64(perMin) / 60, last: time.Now()}
}

func (b *bucket) take() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.tokens = math.Min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

type actionResult struct {
	OK     bool   `json:"ok"`
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
	Code   string `json:"code,omitempty"`
}

type httpErr struct {
	status int
	msg    string
}

func (e httpErr) Error() string { return e.msg }

func fail(status int, format string, a ...any) error {
	return httpErr{status, fmt.Sprintf(format, a...)}
}

func (a *Actions) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"read_only": a.cfg.ReadOnly, "auth": a.cfg.Auth, "memex": a.cfg.Memex != "",
			"public_url": a.cfg.PublicURL,
			"voice":      map[string]bool{"intent": a.cfg.Voice.Intent(), "transcribe": a.cfg.Voice.STT(), "local": a.cfg.STT.Local()}})
	})
	mux.HandleFunc("POST /api/thread/{slug}/{id}/{action}", a.guard(a.threadAction))
	mux.HandleFunc("POST /api/project/{slug}/coordinator", a.guard(a.coordinator))
	mux.HandleFunc("POST /api/project/{slug}/answer", a.guard(a.coordAnswer))
	mux.HandleFunc("POST /api/project/{slug}/keys", a.guard(a.coordKeys))
	mux.HandleFunc("POST /api/ack", a.guard(a.bulkAck))
	// Anything but POST on a write path is refused, not served as a file.
	for _, p := range []string{"GET /api/thread/{slug}/{id}/{action}", "GET /api/project/{slug}/coordinator", "GET /api/project/{slug}/answer", "GET /api/project/{slug}/keys", "GET /api/ack"} {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Allow", "POST")
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
		})
	}
	mux.HandleFunc("GET /api/thread/{slug}/{id}/screen", a.threadScreen)
	mux.HandleFunc("GET /api/project/{slug}/screen", a.coordScreen)
	mux.HandleFunc("GET /api/thread/{slug}/{id}/history", a.threadHistory)
	mux.HandleFunc("GET /api/project/{slug}/history", a.coordHistory)
}

// guard applies the checks every write shares: read-only mode, a JSON body
// (an HTML form cannot send one cross-site without a preflight) and a
// same-origin Origin when the browser sends one.
func (a *Actions) guard(h func(r *http.Request, body []byte) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		target := strings.TrimPrefix(r.URL.Path, "/api/")
		err := a.precheck(r)
		var out any
		if err == nil {
			var body []byte
			body, err = io.ReadAll(io.LimitReader(r.Body, 64<<10))
			if err == nil {
				out, err = h(r, body)
			}
		}
		var he httpErr
		switch {
		case err == nil:
			log.Printf("action %s from %s: ok (%s)", target, r.RemoteAddr, time.Since(start).Round(time.Millisecond))
			writeJSON(w, out)
		case errors.As(err, &he):
			log.Printf("action %s from %s: refused %d: %s", target, r.RemoteAddr, he.status, he.msg)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(he.status)
			json.NewEncoder(w).Encode(actionResult{Error: he.msg})
		default:
			res := failed(err)
			log.Printf("action %s from %s: failed (%s): %v", target, r.RemoteAddr, time.Since(start).Round(time.Millisecond), err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(res)
		}
	}
}

func (a *Actions) precheck(r *http.Request) error {
	if a.cfg.ReadOnly {
		return fail(http.StatusForbidden, "this dashboard is read-only (--read-only)")
	}
	return sameOriginJSON(r)
}

// sameOriginJSON refuses requests a foreign page could send: a cross-origin
// Origin, a cross-site fetch, or a body that is not JSON.
func sameOriginJSON(r *http.Request) error {
	if o := r.Header.Get("Origin"); o != "" {
		u, err := url.Parse(o)
		if err != nil || u.Host != r.Host {
			return fail(http.StatusForbidden, "cross-origin write refused")
		}
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return fail(http.StatusForbidden, "cross-site write refused")
	}
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		return fail(http.StatusUnsupportedMediaType, "Content-Type must be application/json")
	}
	return nil
}

// failed turns a herdr-projects error into the page's result.
func failed(err error) actionResult {
	msg := err.Error()
	var ce *cmdError
	if errors.As(err, &ce) {
		msg = ce.Message()
	}
	res := actionResult{Error: msg}
	if m := codeRe.FindStringSubmatch(msg); m != nil {
		res.Code = m[1]
	}
	return res
}

func decode(body []byte, v any) error {
	if err := json.Unmarshal(body, v); err != nil {
		return fail(http.StatusBadRequest, "bad JSON body: %v", err)
	}
	return nil
}

// cleanText checks free text: valid UTF-8, within max bytes, not blank, and no
// control characters except newline and tab where multiline is allowed.
func cleanText(s string, max int, multiline bool) (string, error) {
	if !utf8.ValidString(s) {
		return "", fail(http.StatusBadRequest, "text is not UTF-8")
	}
	if len(s) > max {
		return "", fail(http.StatusBadRequest, "text is longer than %d bytes", max)
	}
	for _, r := range s {
		if unicode.IsControl(r) && !(multiline && (r == '\n' || r == '\t' || r == '\r')) {
			return "", fail(http.StatusBadRequest, "text holds a control character")
		}
	}
	if strings.TrimSpace(s) == "" {
		return "", fail(http.StatusBadRequest, "text is empty")
	}
	return s, nil
}

// thread validates the path's slug and id and looks the thread up.
func (a *Actions) thread(r *http.Request) (string, string, RawThread, error) {
	slug, id := r.PathValue("slug"), r.PathValue("id")
	if !slugRe.MatchString(slug) || !idRe.MatchString(id) {
		return "", "", RawThread{}, fail(http.StatusBadRequest, "bad thread")
	}
	t, _, ok := a.col.raw(slug, id)
	if !ok {
		return "", "", RawThread{}, fail(http.StatusNotFound, "no thread %s/%s", slug, id)
	}
	return slug, id, t, nil
}

// hp runs one herdr-projects write under the write lock and rate limit.
func (a *Actions) hp(timeout time.Duration, stdin string, args ...string) (string, error) {
	if !a.bucket.take() {
		return "", fail(http.StatusTooManyRequests, "too many writes; wait a moment")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.hpLocked(timeout, stdin, args...)
}

func (a *Actions) hpLocked(timeout time.Duration, stdin string, args ...string) (string, error) {
	// Not the request context: a write must not be cut off half way because
	// the browser went away.
	out, err := runIn(context.Background(), timeout, stdin, a.cfg.HerdrProjects, append([]string{"--root", a.cfg.Root}, args...)...)
	return strings.TrimSpace(string(out)), err
}

func (a *Actions) threadAction(r *http.Request, body []byte) (any, error) {
	slug, id, t, err := a.thread(r)
	if err != nil {
		return nil, err
	}
	var out string
	switch r.PathValue("action") {
	case "prompt":
		var req struct{ Text string }
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		text, err := cleanText(req.Text, maxPromptBytes, true)
		if err != nil {
			return nil, err
		}
		out, err = a.hp(2*time.Minute, text, "thread", "prompt", slug, id, "--text-file", "-")
		a.col.Burst(t.PaneID)
		if err != nil {
			return nil, err
		}
	case "keys":
		var req struct {
			Keys []string
			Text string
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if len(req.Keys) == 0 || len(req.Keys) > maxKeys {
			return nil, fail(http.StatusBadRequest, "give 1 to %d keys", maxKeys)
		}
		for _, k := range req.Keys {
			if !allowedKeys[k] {
				return nil, fail(http.StatusBadRequest, "key %q is not allowed", k)
			}
		}
		args := append([]string{"thread", "keys", slug, id}, req.Keys...)
		if req.Text != "" {
			text, err := cleanText(req.Text, maxKeysText, false)
			if err != nil {
				return nil, err
			}
			args = append(args, "--text="+text)
		}
		out, err = a.hp(30*time.Second, "", args...)
		a.col.Burst(t.PaneID)
		if err != nil {
			return nil, err
		}
	case "answer":
		var req answerReq
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if t.PaneID == "" {
			return nil, fail(http.StatusConflict, "%s has no pane", id)
		}
		steps, _, err := a.answerSteps(t.PaneID, req)
		if err != nil {
			return nil, err
		}
		if !a.bucket.take() {
			return nil, fail(http.StatusTooManyRequests, "too many writes; wait a moment")
		}
		a.mu.Lock()
		var outs []string
		for i, st := range steps {
			if i > 0 {
				time.Sleep(400 * time.Millisecond) // let the menu open its text field
			}
			args := append([]string{"thread", "keys", slug, id}, st.keys...)
			if st.text != "" {
				args = append(args, "--text="+st.text)
			}
			o, err := a.hpLocked(30*time.Second, "", args...)
			if err != nil {
				a.mu.Unlock()
				a.col.Burst(t.PaneID)
				return nil, err
			}
			outs = append(outs, o)
		}
		a.mu.Unlock()
		a.col.Burst(t.PaneID)
		a.kickSoon()
		out = strings.Join(outs, "\n")
	case "next":
		var req struct{ Line int }
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if req.Line < 1 || req.Line > 99 {
			return nil, fail(http.StatusBadRequest, "line must be 1 to 99")
		}
		out, err = a.hp(2*time.Minute, "", "thread", "next", slug, id, "--line", fmt.Sprint(req.Line))
		a.col.Burst(t.PaneID)
		if err != nil {
			return nil, err
		}
	case "ack":
		if out, err = a.hp(30*time.Second, "", "thread", "ack", slug, id); err != nil {
			return nil, err
		}
	case "resolve":
		var req struct{ Confirm string }
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if req.Confirm != slug+"/"+id {
			return nil, fail(http.StatusBadRequest, "resolve needs confirm: %q", slug+"/"+id)
		}
		if out, err = a.hp(3*time.Minute, "", "thread", "resolve", slug, id); err != nil {
			return nil, err
		}
	default:
		return nil, fail(http.StatusNotFound, "unknown action")
	}
	a.col.Kick()
	return actionResult{OK: true, Output: out}, nil
}

func (a *Actions) coordinator(r *http.Request, body []byte) (any, error) {
	slug := r.PathValue("slug")
	if !slugRe.MatchString(slug) {
		return nil, fail(http.StatusBadRequest, "bad project")
	}
	if !a.col.hasProject(slug) {
		return nil, fail(http.StatusNotFound, "no project %s", slug)
	}
	var req struct{ Text string }
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	text, err := cleanText(req.Text, maxPromptBytes, true)
	if err != nil {
		return nil, err
	}
	out, err := a.hp(time.Minute, text, "coordinator", "prompt", slug, "--text-file", "-")
	if co, ok := a.col.coordPane(slug); ok {
		a.col.Burst(co.PaneID)
	}
	if err != nil {
		return nil, err
	}
	a.col.Kick()
	return actionResult{OK: true, Output: out}, nil
}

type bulkResult struct {
	Key   string `json:"key"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// bulkAck acks many threads, one command at a time, for one rate-limit token.
// All keys are validated before anything runs.
func (a *Actions) bulkAck(r *http.Request, body []byte) (any, error) {
	var req struct{ Threads []string }
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	if len(req.Threads) == 0 || len(req.Threads) > maxBulk {
		return nil, fail(http.StatusBadRequest, "give 1 to %d threads", maxBulk)
	}
	type key struct{ slug, id string }
	keys := make([]key, 0, len(req.Threads))
	for _, k := range req.Threads {
		slug, id, ok := strings.Cut(k, "/")
		if !ok || !slugRe.MatchString(slug) || !idRe.MatchString(id) {
			return nil, fail(http.StatusBadRequest, "bad thread %q", k)
		}
		keys = append(keys, key{slug, id})
	}
	if !a.bucket.take() {
		return nil, fail(http.StatusTooManyRequests, "too many writes; wait a moment")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	res := make([]bulkResult, 0, len(keys))
	for _, k := range keys {
		br := bulkResult{Key: k.slug + "/" + k.id}
		if _, _, ok := a.col.raw(k.slug, k.id); !ok {
			br.Error = "no such thread"
		} else if _, err := a.hpLocked(30*time.Second, "", "thread", "ack", k.slug, k.id); err != nil {
			br.Error = failed(err).Error
		} else {
			br.OK = true
		}
		log.Printf("action ack %s: ok=%v %s", br.Key, br.OK, br.Error)
		res = append(res, br)
	}
	a.col.Kick()
	return map[string]any{"results": res}, nil
}

type screenEvent struct {
	Screen     string  `json:"screen"`
	LiveStatus string  `json:"live_status"`
	PaneAlive  bool    `json:"pane_alive"`
	Prompt     *Prompt `json:"prompt,omitempty"`
}

// screenTarget says which pane a screen stream reads right now: its id,
// whether the pane is alive, and whether it may be read.
type screenTarget func() (pane string, alive, readable bool)

// threadTarget resolves a thread's pane for its screen and history, or
// answers the request with an error.
func (a *Actions) threadTarget(w http.ResponseWriter, r *http.Request) (screenTarget, bool) {
	slug, id := r.PathValue("slug"), r.PathValue("id")
	if !slugRe.MatchString(slug) || !idRe.MatchString(id) {
		http.Error(w, "bad thread", http.StatusBadRequest)
		return nil, false
	}
	if _, _, ok := a.col.raw(slug, id); !ok {
		http.NotFound(w, r)
		return nil, false
	}
	return func() (string, bool, bool) {
		t, alive, ok := a.col.raw(slug, id)
		return t.PaneID, alive, ok && alive && t.Status != "resolved" && t.PaneID != ""
	}, true
}

// coordTarget re-identifies the coordinator's pane on every read, so a
// restarted coordinator is followed and a vanished one is never guessed.
func (a *Actions) coordTarget(w http.ResponseWriter, r *http.Request) (screenTarget, bool) {
	slug := r.PathValue("slug")
	if !slugRe.MatchString(slug) {
		http.Error(w, "bad project", http.StatusBadRequest)
		return nil, false
	}
	if !a.col.hasProject(slug) {
		http.NotFound(w, r)
		return nil, false
	}
	return func() (string, bool, bool) {
		co, ok := a.col.coordPane(slug)
		return co.PaneID, ok, ok
	}, true
}

func (a *Actions) threadScreen(w http.ResponseWriter, r *http.Request) {
	if target, ok := a.threadTarget(w, r); ok {
		a.screenEvents(w, r, target)
	}
}

func (a *Actions) coordScreen(w http.ResponseWriter, r *http.Request) {
	if target, ok := a.coordTarget(w, r); ok {
		a.screenEvents(w, r, target)
	}
}

func (a *Actions) threadHistory(w http.ResponseWriter, r *http.Request) {
	if target, ok := a.threadTarget(w, r); ok {
		a.history(w, r, target)
	}
}

func (a *Actions) coordHistory(w http.ResponseWriter, r *http.Request) {
	if target, ok := a.coordTarget(w, r); ok {
		a.history(w, r, target)
	}
}

var linesRe = regexp.MustCompile(`^[0-9]{1,7}$`)

// history answers a reader scrolling up in a screen box: the pane's last
// ?lines= lines, capped, from a short per-pane cache. Asked for on demand
// only; the page never polls it.
func (a *Actions) history(w http.ResponseWriter, r *http.Request, target screenTarget) {
	q := r.URL.Query().Get("lines")
	if !linesRe.MatchString(q) {
		http.Error(w, "lines: a number of lines", http.StatusBadRequest)
		return
	}
	n, _ := strconv.Atoi(q)
	n = max(liveLines, min(n, maxHistory))
	pane, alive, readable := target()
	ev := map[string]any{"screen": "", "lines": n, "pane_alive": alive}
	if readable {
		ev["screen"] = a.col.History(r.Context(), pane, n)
	}
	writeJSON(w, ev)
}

// screenEvents streams a pane's screen over SSE: read every few seconds
// while someone watches, faster for a short burst after a write.
func (a *Actions) screenEvents(w http.ResponseWriter, r *http.Request, target screenTarget) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no streaming", http.StatusInternalServerError)
		return
	}
	if a.screens.Add(1) > maxScreenSubs {
		a.screens.Add(-1)
		http.Error(w, "too many screen streams", http.StatusServiceUnavailable)
		return
	}
	defer a.screens.Add(-1)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	var last []byte
	var lastRead, lastWrite time.Time
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for first := true; ; first = false {
		if !first {
			select {
			case <-r.Context().Done():
				return
			case <-tick.C:
			}
		}
		pane, alive, readable := target()
		every := 3 * time.Second
		if a.col.bursting(pane) {
			every = 700 * time.Millisecond
		}
		if !first && time.Since(lastRead) < every {
			if time.Since(lastWrite) > 25*time.Second {
				io.WriteString(w, ": ping\n\n")
				fl.Flush()
				lastWrite = time.Now()
			}
			continue
		}
		lastRead = time.Now()
		ev := screenEvent{PaneAlive: alive}
		if readable {
			var raw string
			ev.Screen, raw = a.col.Screen(r.Context(), pane, every-100*time.Millisecond)
			ev.LiveStatus = a.col.liveStatus(pane)
			if ev.LiveStatus == "blocked" {
				ev.Prompt = ParsePrompt(raw, a.col.paneAgent(pane))
			}
		}
		b, _ := json.Marshal(ev)
		if string(b) == string(last) {
			continue
		}
		last = b
		if _, err := io.WriteString(w, "event: screen\ndata: "+string(b)+"\n\n"); err != nil {
			return
		}
		fl.Flush()
		lastWrite = time.Now()
	}
}

// ---------------------------------------------------------------- prompt answers

type answerReq struct {
	Sig    string `json:"sig"`
	Option int    `json:"option"`
	Text   string `json:"text"`
}

type keyStep struct {
	keys []string
	text string
}

// answerSteps re-reads pane right now, checks it still shows the prompt the
// page answered (same sig), and returns the key presses for the chosen
// option: its keys, then for an option that takes text, the text and Enter.
// The keys come from the server's own parse, never from the page.
func (a *Actions) answerSteps(pane string, req answerReq) ([]keyStep, *Prompt, error) {
	if req.Sig == "" || len(req.Sig) > 64 {
		return nil, nil, fail(http.StatusBadRequest, "sig missing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	p := a.col.FreshPrompt(ctx, pane, a.col.paneAgent(pane))
	if p == nil {
		return nil, nil, httpErr{http.StatusConflict, "prompt_gone: no prompt shows in the pane now"}
	}
	if p.Sig != req.Sig {
		return nil, nil, httpErr{http.StatusConflict, "prompt_changed: the pane shows another prompt now; check it and answer again"}
	}
	if req.Option < 0 || req.Option >= len(p.Options) {
		return nil, nil, fail(http.StatusBadRequest, "no option %d", req.Option)
	}
	o := p.Options[req.Option]
	log.Printf("answer pane %s: %s %q", pane, p.Kind, o.Label)
	if len(o.Keys) == 0 {
		return nil, nil, fail(http.StatusConflict, "%q cannot be picked with keys from here (the highlight is not visible); use the keys below the screen", o.Label)
	}
	for _, k := range o.Keys {
		if !allowedKeys[k] {
			return nil, nil, fail(http.StatusBadRequest, "key %q is not allowed", k)
		}
	}
	steps := []keyStep{{keys: o.Keys}}
	switch {
	case o.Text == "" && req.Text != "":
		return nil, nil, fail(http.StatusBadRequest, "%q takes no text", o.Label)
	case o.Text == "required" && strings.TrimSpace(req.Text) == "":
		return nil, nil, fail(http.StatusBadRequest, "%q needs text", o.Label)
	case o.Text != "" && req.Text != "":
		text, err := cleanText(req.Text, maxKeysText, false)
		if err != nil {
			return nil, nil, err
		}
		steps = append(steps, keyStep{keys: []string{"enter"}, text: text})
	}
	return steps, p, nil
}

// kickSoon refreshes the snapshot now and once more shortly after, when the
// agent has redrawn: the strip learns the prompt cleared.
func (a *Actions) kickSoon() {
	a.col.Kick()
	time.AfterFunc(1500*time.Millisecond, a.col.Kick)
}

// coordVerified finds the project's coordinator pane the strict way the
// panel does, then asks herdr about that pane right now: it must still run
// the same agent session and be blocked on a prompt. Anything else refuses.
func (a *Actions) coordVerified(r *http.Request) (string, Coordinator, error) {
	slug := r.PathValue("slug")
	if !slugRe.MatchString(slug) {
		return "", Coordinator{}, fail(http.StatusBadRequest, "bad project")
	}
	if !a.col.hasProject(slug) {
		return "", Coordinator{}, fail(http.StatusNotFound, "no project %s", slug)
	}
	co, ok := a.col.coordPane(slug)
	if !ok {
		return "", Coordinator{}, fail(http.StatusConflict, "no live coordinator pane is identified for %s", slug)
	}
	out, err := run(context.Background(), 5*time.Second, a.cfg.Herdr, "pane", "get", co.PaneID)
	var doc struct {
		Result struct {
			Pane Pane `json:"pane"`
		} `json:"result"`
	}
	if err == nil {
		err = json.Unmarshal(out, &doc)
	}
	if err != nil {
		return "", Coordinator{}, fail(http.StatusConflict, "cannot check the coordinator pane: %v", err)
	}
	got := doc.Result.Pane
	if got.PaneID != co.PaneID || got.Agent != co.Agent || got.session() != a.col.paneSession(co.PaneID) {
		return "", Coordinator{}, fail(http.StatusConflict, "the coordinator pane changed; reload and try again")
	}
	if got.AgentStatus != "blocked" {
		return "", Coordinator{}, httpErr{http.StatusConflict, "agent_not_blocked: the coordinator is not waiting on a prompt (it is " + got.AgentStatus + "); send it a message instead"}
	}
	return slug, co, nil
}

// herdrKeys presses keys (after typing text) in a verified coordinator pane
// with herdr itself: herdr-projects has no key command for coordinators.
func (a *Actions) herdrKeys(slug, pane string, st keyStep) (string, error) {
	if st.text != "" {
		if _, err := runIn(context.Background(), 10*time.Second, "", a.cfg.Herdr, "pane", "send-text", pane, st.text); err != nil {
			return "", err
		}
	}
	if len(st.keys) > 0 {
		if _, err := runIn(context.Background(), 10*time.Second, "", a.cfg.Herdr, append([]string{"pane", "send-keys", pane}, st.keys...)...); err != nil {
			return "", err
		}
	}
	log.Printf("coordinator %s keys: pane %s pressed %s (typed %d chars)", slug, pane, strings.Join(st.keys, " "), len([]rune(st.text)))
	return "pressed " + strings.Join(st.keys, " "), nil
}

func (a *Actions) coordAnswer(r *http.Request, body []byte) (any, error) {
	var req answerReq
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	slug, co, err := a.coordVerified(r)
	if err != nil {
		return nil, err
	}
	steps, p, err := a.answerSteps(co.PaneID, req)
	if err != nil {
		return nil, err
	}
	if p.Kind == "trust" {
		return nil, fail(http.StatusForbidden, "trust screens are answered in the coordinator's own pane")
	}
	if !a.bucket.take() {
		return nil, fail(http.StatusTooManyRequests, "too many writes; wait a moment")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var outs []string
	for i, st := range steps {
		if i > 0 {
			time.Sleep(400 * time.Millisecond)
		}
		o, err := a.herdrKeys(slug, co.PaneID, st)
		if err != nil {
			a.col.Burst(co.PaneID)
			return nil, err
		}
		outs = append(outs, o)
	}
	a.col.Burst(co.PaneID)
	a.kickSoon()
	return actionResult{OK: true, Output: strings.Join(outs, "\n")}, nil
}

func (a *Actions) coordKeys(r *http.Request, body []byte) (any, error) {
	var req struct {
		Keys []string
		Text string
	}
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	if len(req.Keys) == 0 || len(req.Keys) > maxKeys {
		return nil, fail(http.StatusBadRequest, "give 1 to %d keys", maxKeys)
	}
	for _, k := range req.Keys {
		if !allowedKeys[k] {
			return nil, fail(http.StatusBadRequest, "key %q is not allowed", k)
		}
	}
	st := keyStep{keys: req.Keys}
	if req.Text != "" {
		text, err := cleanText(req.Text, maxKeysText, false)
		if err != nil {
			return nil, err
		}
		st.text = text
	}
	slug, co, err := a.coordVerified(r)
	if err != nil {
		return nil, err
	}
	if p := a.col.promptOf(co.PaneID); p != nil && p.Kind == "trust" {
		return nil, fail(http.StatusForbidden, "trust screens are answered in the coordinator's own pane")
	}
	if !a.bucket.take() {
		return nil, fail(http.StatusTooManyRequests, "too many writes; wait a moment")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	out, err := a.herdrKeys(slug, co.PaneID, st)
	a.col.Burst(co.PaneID)
	if err != nil {
		return nil, err
	}
	a.kickSoon()
	return actionResult{OK: true, Output: out}, nil
}
