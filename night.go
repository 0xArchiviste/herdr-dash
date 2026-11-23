package main

// Night mode: while it is on (switched on by hand, or inside a nightly
// window), the server answers the permission prompts that hold up threads
// and coordinators, so nothing hangs while the user sleeps. It runs with the
// collector, needs no page open, and reads only the panes the collector
// already parses (blocked ones).
//
// What it answers: a permission prompt, with its allow-once option ("Yes",
// "Yes, just this once", "Allow once"); never a lasting grant ("don't ask
// again", "always", auto mode, trust). A harness with no allow-once option
// gets its plain allow option when one exists that is not lasting, logged as
// such. Optionally, a question with exactly one "(Recommended)" option.
// Plans, trust screens, y/n confirmations and anything ambiguous are left.
//
// Guardrails, each refusal logged and left on screen for the morning:
//   - an editable deny list of command patterns (regular expressions, case
//     folded) plus a built-in check for rm -r outside the worktree;
//   - a per-pane loop limit: a pane that asks more than N times in M
//     minutes is flagged and not answered again this night;
//   - a prompt is answered only once it has looked the same for
//     stable_seconds, after a fresh read that still shows it, and through
//     the same identity checks and key path as /answer (actions.go);
//   - keys only ever come from the server's own parse of that fresh read.
//
// Every decision is a line in the fleet audit log (op night-approve); the
// Night log window reads them back. Settings live in a small JSON file
// (--night-config); night mode ships switched off.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/0xArchiviste/herdr-dash/internal/fleet"
)

const (
	nightActor     = "night@dash"
	nightOp        = "night-approve"
	nightModeOp    = "night-mode"
	builtinRm      = "builtin:rm-outside-worktree"
	maxDenyRules   = 100
	maxNightLogDay = 30
)

type DenyRule struct {
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
}

// defaultDeny is the deny list a new install starts with.
var defaultDeny = []DenyRule{
	{"rm -rf of /, ~ or outside the worktree", builtinRm},
	{"git push --force to main or master", `\bgit\s+push\b.*(\s--force\S*|\s-f\b).*\b(main|master)\b|\bgit\s+push\b.*\b(main|master)\b.*(\s--force|\s-f\b)|\bgit\s+push\b.*\s\+(refs/heads/)?(main|master)\b`},
	{"git reset --hard on main", `\bgit\s+reset\s+--hard\b.*\b(main|master)\b|\b(checkout|switch)\s+(main|master)\b.*\bgit\s+reset\s+--hard\b`},
	{"Deleting branches or repos", `\bgit\s+branch\s+.*(-D|-d|--delete)\b|\bgit\s+push\b.*(\s--delete\b|\s-d\b|\s:[\w./-]+)|\bgh\s+repo\s+delete\b|\brm\s+-\w*\s+.*\.git\b`},
	{"Dropping databases", `\bdrop\s+(database|schema)\b|\bdropdb\b|\bflushall\b|\bdropDatabase\s*\(`},
	{"herdr-projects update", `\bherdr-projects\b.*\bupdate\b|\bherdr\s+plugin\s+update\b`},
	{"Credential or secret files", `(^|[\s/'"=~])\.ssh/|(^|[\s/'"=])[\w.-]*\.env(\.[\w-]+)?($|[\s'";|&>)?])|\bcredentials?(\.json|\.ya?ml|\.toml)?\b|\.aws/|\.netrc\b|\.gnupg/|\bid_(rsa|ecdsa|ed25519)\b|\bsecrets?\.(json|ya?ml|toml|env)\b`},
	{"sudo", `(^|[\s;&|(` + "`" + `])(sudo|doas)\s`},
	{"curl | sh (a download piped into a shell)", `\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b[^|]*\|\s*(python3?|perl|ruby|node)\b|\bsh\s+-c\s+["']?\$\((curl|wget)`},
	{"systemctl stop/disable of a service", `\bsystemctl\b(\s+--?\S+)*\s+(stop|disable|mask|kill)\b|\bservice\s+\S+\s+stop\b`},
	{"wsl --shutdown", `\bwsl(\.exe)?\b.*\s--(shutdown|terminate)\b|\bwsl(\.exe)?\s+-t\b`},
}

type NightSettings struct {
	Mode          string     `json:"mode"`            // off, on, schedule
	OffAt         string     `json:"off_at"`          // on: switch off at this local time ("" never)
	Until         string     `json:"until,omitempty"` // on: when OffAt comes next after it was switched on
	Start         string     `json:"start"`           // schedule: local HH:MM[:SS]
	End           string     `json:"end"`
	Projects      []string   `json:"projects"` // empty: all
	Coordinators  bool       `json:"coordinators"`
	Questions     bool       `json:"questions"`
	Deny          []DenyRule `json:"deny"`
	LoopMax       int        `json:"loop_max"`
	LoopMinutes   int        `json:"loop_minutes"`
	StableSeconds int        `json:"stable_seconds"`
}

func defaultNight() NightSettings {
	return NightSettings{Mode: "off", OffAt: "08:00", Start: "23:00", End: "08:00", Projects: []string{}, Coordinators: true,
		Deny: append([]DenyRule(nil), defaultDeny...), LoopMax: 20, LoopMinutes: 10, StableSeconds: 3}
}

type denyRule struct {
	DenyRule
	re *regexp.Regexp // nil: builtin
}

// clockRe is a local time of day, HH:MM or HH:MM:SS.
var clockRe = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$`)

func dayClock(s string) (time.Duration, bool) {
	m := clockRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	sec, _ := strconv.Atoi(m[3])
	return time.Duration(h)*time.Hour + time.Duration(mi)*time.Minute + time.Duration(sec)*time.Second, true
}

// nextClock is the first time at or after now (local) that reads clock.
func nextClock(now time.Time, clock string) time.Time {
	d, _ := dayClock(clock)
	y, mo, da := now.Date()
	t := time.Date(y, mo, da, 0, 0, 0, 0, now.Location()).Add(d)
	if !t.After(now) {
		t = t.AddDate(0, 0, 1)
	}
	return t
}

func (s *NightSettings) check() ([]denyRule, error) {
	switch s.Mode {
	case "off", "on", "schedule":
	default:
		return nil, fail(http.StatusBadRequest, "mode must be off, on or schedule")
	}
	for name, v := range map[string]string{"start": s.Start, "end": s.End} {
		if _, ok := dayClock(v); !ok {
			return nil, fail(http.StatusBadRequest, "%s must be a time of day (HH:MM)", name)
		}
	}
	if s.Start == s.End {
		return nil, fail(http.StatusBadRequest, "the schedule's start and end are the same")
	}
	if _, ok := dayClock(s.OffAt); s.OffAt != "" && !ok {
		return nil, fail(http.StatusBadRequest, "off_at must be a time of day (HH:MM) or empty")
	}
	if s.Projects == nil {
		s.Projects = []string{}
	}
	if len(s.Projects) > 500 {
		return nil, fail(http.StatusBadRequest, "too many projects")
	}
	for _, p := range s.Projects {
		if !slugRe.MatchString(p) {
			return nil, fail(http.StatusBadRequest, "bad project %q", p)
		}
	}
	if s.LoopMax < 1 || s.LoopMax > 1000 || s.LoopMinutes < 1 || s.LoopMinutes > 1440 {
		return nil, fail(http.StatusBadRequest, "the loop limit must be 1 to 1000 prompts in 1 to 1440 minutes")
	}
	if s.StableSeconds < 1 || s.StableSeconds > 60 {
		return nil, fail(http.StatusBadRequest, "stable_seconds must be 1 to 60")
	}
	if s.Deny == nil {
		s.Deny = append([]DenyRule(nil), defaultDeny...)
	}
	if len(s.Deny) > maxDenyRules {
		return nil, fail(http.StatusBadRequest, "at most %d deny rules", maxDenyRules)
	}
	out := make([]denyRule, 0, len(s.Deny))
	for i, d := range s.Deny {
		d.Name, d.Pattern = strings.TrimSpace(d.Name), strings.TrimSpace(d.Pattern)
		s.Deny[i] = d
		if d.Pattern == "" || len(d.Pattern) > 1000 || len(d.Name) > 120 {
			return nil, fail(http.StatusBadRequest, "deny rule %d: a pattern (up to 1000 bytes) and a name (up to 120) are needed", i+1)
		}
		if d.Name == "" {
			s.Deny[i].Name, d.Name = d.Pattern, d.Pattern
		}
		if d.Pattern == builtinRm {
			out = append(out, denyRule{DenyRule: d})
			continue
		}
		re, err := regexp.Compile(`(?i)` + d.Pattern)
		if err != nil {
			return nil, fail(http.StatusBadRequest, "deny rule %q: %v", d.Name, err)
		}
		out = append(out, denyRule{DenyRule: d, re: re})
	}
	return out, nil
}

// ---------------------------------------------------------------- engine

type nightSession struct {
	Started  string `json:"started"`
	Ended    string `json:"ended,omitempty"`
	Why      string `json:"why"`
	Approved int    `json:"approved"`
	Refused  int    `json:"refused"`
	Failed   int    `json:"failed"`
	Loops    int    `json:"loops"`
}

// NightEntry is one decision, as the Night log shows it.
type NightEntry struct {
	TS          string `json:"ts"`
	Project     string `json:"project"`
	Thread      string `json:"thread"`
	Coordinator bool   `json:"coordinator"`
	Pane        string `json:"pane"`
	Harness     string `json:"harness"`
	Kind        string `json:"kind"`
	Command     string `json:"command"`
	Option      string `json:"option,omitempty"`
	Result      string `json:"result"` // approved, refused, failed
	Reason      string `json:"reason,omitempty"`
	Pending     bool   `json:"pending,omitempty"` // refused and still on screen
	sig         string
}

type nightFlag struct {
	Pane    string `json:"pane"`
	Project string `json:"project"`
	Thread  string `json:"thread"`
	Count   int    `json:"count"`
	Since   string `json:"since"`
}

type nightWatch struct {
	sig     string
	since   time.Time
	decided bool
}

type Night struct {
	cfg   Config
	col   *Collector
	act   *Actions
	audit *fleet.Audit
	path  string
	now   func() time.Time

	mu        sync.Mutex
	s         NightSettings
	deny      []denyRule
	active    bool
	why       string
	session   *nightSession
	last      *nightSession
	watch     map[string]*nightWatch
	approvals map[string][]time.Time
	flagged   map[string]*nightFlag
	pending   map[string]NightEntry
	busy      atomic.Bool
}

// NightPath is where the settings are kept by default.
func NightPath(getenv func(string) string, home string) string {
	base := getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "herdr-dash", "night.json")
}

func NewNight(cfg Config, col *Collector, act *Actions, audit *fleet.Audit) *Night {
	n := &Night{cfg: cfg, col: col, act: act, audit: audit, path: cfg.NightConfig, now: time.Now,
		watch: map[string]*nightWatch{}, approvals: map[string][]time.Time{}, flagged: map[string]*nightFlag{}, pending: map[string]NightEntry{}}
	n.s = defaultNight()
	if b, err := os.ReadFile(n.path); err == nil {
		s := defaultNight()
		s.Deny = nil
		if err := json.Unmarshal(b, &s); err != nil {
			log.Printf("night: %s: %v; night mode stays off", n.path, err)
		} else if deny, err := s.check(); err != nil {
			log.Printf("night: %s: %v; night mode stays off", n.path, err)
		} else {
			n.s, n.deny = s, deny
		}
	}
	if n.deny == nil {
		n.deny, _ = n.s.check()
	}
	n.mu.Lock()
	n.evaluate(n.now())
	n.mu.Unlock()
	col.mu.Lock()
	col.onPrompts = n.Tick // the schedule is checked with each poll too
	col.mu.Unlock()
	return n
}

func (n *Night) save() error {
	if n.path == "" {
		return nil
	}
	b, _ := json.MarshalIndent(n.s, "", "  ")
	if err := os.MkdirAll(filepath.Dir(n.path), 0o700); err != nil {
		return err
	}
	tmp := n.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, n.path)
}

// shouldBeOn says whether night mode is on at now, and why. n.mu held.
func (n *Night) shouldBeOn(now time.Time) (bool, string) {
	switch n.s.Mode {
	case "on":
		if n.s.Until != "" {
			if u, err := time.Parse(time.RFC3339, n.s.Until); err == nil && !now.Before(u) {
				return false, ""
			}
		}
		return true, "manual"
	case "schedule":
		st, _ := dayClock(n.s.Start)
		en, _ := dayClock(n.s.End)
		y, mo, d := now.Date()
		t := now.Sub(time.Date(y, mo, d, 0, 0, 0, 0, now.Location()))
		if st < en {
			return t >= st && t < en, "schedule"
		}
		return t >= st || t < en, "schedule"
	}
	return false, ""
}

// until is when night mode goes off next, "" when only by hand. n.mu held.
func (n *Night) until(now time.Time) string {
	switch {
	case !n.active:
		return ""
	case n.s.Mode == "on":
		return n.s.Until
	case n.s.Mode == "schedule":
		return nextClock(now, n.s.End).Format(time.RFC3339)
	}
	return ""
}

// evaluate switches night mode on or off as the settings and the clock say,
// opening or closing a session. n.mu held.
func (n *Night) evaluate(now time.Time) {
	on, why := n.shouldBeOn(now)
	if !on && n.s.Mode == "on" {
		// The auto-off time came: off for good, until switched on again.
		n.s.Mode, n.s.Until = "off", ""
		if err := n.save(); err != nil {
			log.Printf("night: save: %v", err)
		}
	}
	if on == n.active {
		return
	}
	n.active, n.why = on, why
	ts := now.UTC().Format(time.RFC3339)
	if on {
		n.session = &nightSession{Started: ts, Why: why}
		n.watch, n.approvals, n.flagged, n.pending = map[string]*nightWatch{}, map[string][]time.Time{}, map[string]*nightFlag{}, map[string]NightEntry{}
		log.Printf("night: on (%s)", why)
		n.auditLine(now, fleet.AuditLine{Op: nightModeOp, Result: "ok", Reason: "on (" + why + ")"})
		return
	}
	if s := n.session; s != nil {
		s.Ended = ts
		n.last = s
		n.session = nil
		msg := fmt.Sprintf("off: %d approved, %d left for you, %d failed, %d loops flagged", s.Approved, s.Refused, s.Failed, s.Loops)
		log.Printf("night: %s", msg)
		n.auditLine(now, fleet.AuditLine{Op: nightModeOp, Result: "ok", Reason: msg})
	}
	n.watch = map[string]*nightWatch{}
}

func (n *Night) auditLine(now time.Time, l fleet.AuditLine) {
	if n.audit == nil {
		return
	}
	l.Actor = nightActor
	if err := n.audit.Append(now, l); err != nil {
		log.Printf("night audit: %v", err)
	}
}

// nightCand is a prompt the collector holds for a thread or coordinator.
type nightCand struct {
	slug, thread string
	coord        bool
	pane, agent  string
	session      string
	root         string // the worktree (or folder) rm -r may stay inside
	prompt       *Prompt
}

// nightCandidates lists the prompts the collector parsed at its last
// poll, for open threads with live panes and for coordinators.
func (c *Collector) nightCandidates() []nightCand {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []nightCand
	for _, slug := range c.order {
		p := c.projects[slug]
		if p == nil {
			continue
		}
		for _, t := range p.threads {
			pn, ok := c.panes[t.PaneID]
			pr := c.prompts[t.PaneID]
			if t.Status == "resolved" || t.PaneID == "" || !ok || pr == nil || !c.showsPrompt(pn) {
				continue
			}
			root := t.WorktreePath
			if root == "" {
				root = t.Cwd
			}
			if root == "" {
				root = pn.Cwd
			}
			out = append(out, nightCand{slug: slug, thread: t.ID, pane: t.PaneID, agent: pn.Agent, session: pn.session(), root: root, prompt: pr})
		}
		if co := c.coordinator(p); co.State == "blocked" && co.Prompt != nil && co.PaneID != "" {
			pn := c.panes[co.PaneID]
			out = append(out, nightCand{slug: slug, coord: true, pane: co.PaneID, agent: co.Agent, session: pn.session(), root: pn.Cwd, prompt: co.Prompt})
		}
	}
	return out
}

// Tick looks at the prompts the collector holds and answers the ones that
// are due. One tick at a time; a tick that finds one running is skipped.
func (n *Night) Tick() {
	if !n.busy.CompareAndSwap(false, true) {
		return
	}
	defer n.busy.Store(false)
	now := n.now()
	n.mu.Lock()
	n.evaluate(now)
	active, s := n.active, n.s
	n.mu.Unlock()
	if !active || n.cfg.ReadOnly {
		return
	}
	inScope := map[string]bool{}
	for _, p := range s.Projects {
		inScope[p] = true
	}
	stable := time.Duration(s.StableSeconds) * time.Second
	seen := map[string]bool{}
	var due []nightCand
	n.mu.Lock()
	for _, c := range n.col.nightCandidates() {
		if len(inScope) > 0 && !inScope[c.slug] || c.coord && !s.Coordinators {
			continue
		}
		seen[c.pane] = true
		w := n.watch[c.pane]
		if w == nil || w.sig != c.prompt.Sig {
			n.watch[c.pane] = &nightWatch{sig: c.prompt.Sig, since: now}
			if e, ok := n.pending[c.pane]; ok && e.sig != c.prompt.Sig {
				delete(n.pending, c.pane)
			}
			continue
		}
		if w.decided || now.Sub(w.since) < stable {
			continue
		}
		w.decided = true
		due = append(due, c)
	}
	for pane := range n.watch {
		if !seen[pane] {
			delete(n.watch, pane)
			delete(n.pending, pane)
		}
	}
	n.mu.Unlock()
	for _, c := range due {
		n.handle(c, s)
	}
}

// handle decides one prompt that has been stable long enough, and acts.
func (n *Night) handle(c nightCand, s NightSettings) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	fresh := n.col.FreshPrompt(ctx, c.pane, c.agent)
	cancel()
	if fresh == nil || fresh.Sig != c.prompt.Sig {
		// Gone or changed since the poll: watch it again from the start.
		n.mu.Lock()
		delete(n.watch, c.pane)
		n.mu.Unlock()
		return
	}
	p := fresh
	e := NightEntry{Project: c.slug, Thread: c.thread, Coordinator: c.coord, Pane: c.pane, Harness: p.Harness, Kind: p.Kind, Command: promptCommand(p), sig: p.Sig}
	opt, reason := n.decide(p, s, c)
	if opt >= 0 {
		e.Option = p.Options[opt].Label
	}
	now := n.now()
	if opt >= 0 {
		// The loop limit: approvals in this pane within the window.
		win := time.Duration(s.LoopMinutes) * time.Minute
		n.mu.Lock()
		var keep []time.Time
		for _, t := range n.approvals[c.pane] {
			if now.Sub(t) < win {
				keep = append(keep, t)
			}
		}
		n.approvals[c.pane] = keep
		if f := n.flagged[c.pane]; f != nil {
			opt, reason = -1, fmt.Sprintf("loop: this pane was flagged at %s (asked more than %d times in %d minutes); not answered again tonight", localClock(f.Since), s.LoopMax, s.LoopMinutes)
		} else if len(keep) >= s.LoopMax {
			opt, reason = -1, fmt.Sprintf("loop: the pane asked more than %d times in %d minutes; auto-approval stopped for this pane", s.LoopMax, s.LoopMinutes)
			n.flagged[c.pane] = &nightFlag{Pane: c.pane, Project: c.slug, Thread: c.thread, Count: len(keep) + 1, Since: now.UTC().Format(time.RFC3339)}
			if n.session != nil {
				n.session.Loops++
			}
		}
		n.mu.Unlock()
	}
	if opt < 0 {
		e.Result, e.Reason = "refused", reason
		n.record(now, e)
		return
	}
	res, err := n.press(c, p, opt)
	now = n.now()
	switch {
	case err != nil:
		e.Result, e.Reason = "failed", failed(err).Error
	default:
		e.Result = "approved"
		e.Reason = strings.TrimSpace(reason + " (" + res.After + ")")
		n.mu.Lock()
		n.approvals[c.pane] = append(n.approvals[c.pane], now)
		delete(n.watch, c.pane) // the same prompt again is a new ask
		n.mu.Unlock()
	}
	n.record(now, e)
}

// record logs a decision: the audit line, the session counts, pending.
func (n *Night) record(now time.Time, e NightEntry) {
	e.TS = now.UTC().Format(time.RFC3339)
	who := e.Thread
	if e.Coordinator {
		who = "coordinator"
	}
	result := map[string]string{"approved": "ok", "refused": "refused", "failed": "failed"}[e.Result]
	l := fleet.AuditLine{Op: nightOp, Target: e.Project, Args: []string{who, e.Pane, e.Harness, e.Kind}, Command: e.Command, Text: e.Option, Result: result, Reason: e.Reason}
	if e.Result == "failed" {
		l.Error = e.Reason
	}
	log.Printf("night: %s/%s %s: %s %q %s", e.Project, who, e.Pane, e.Result, e.Option, e.Reason)
	n.mu.Lock()
	n.auditLine(now, l)
	if s := n.session; s != nil {
		switch e.Result {
		case "approved":
			s.Approved++
		case "refused":
			s.Refused++
		case "failed":
			s.Failed++
		}
	}
	if e.Result != "approved" {
		n.pending[e.Pane] = e
	}
	n.mu.Unlock()
}

// press answers through the same checks as the page's /answer: the
// thread (or coordinator) still owns the pane, the agent session is the
// same, a fresh read shows the same prompt, and the keys are the server's.
func (n *Night) press(c nightCand, p *Prompt, opt int) (answerResult, error) {
	a := n.act
	req := answerReq{Pane: c.pane, Sig: p.Sig, Option: opt}
	if n.col.paneSession(c.pane) != c.session {
		return answerResult{}, httpErr{http.StatusConflict, "pane_changed: another agent session runs in the pane now"}
	}
	if c.coord {
		slug, co, err := a.coordVerifiedSlug(c.slug)
		if err != nil {
			return answerResult{}, err
		}
		if co.PaneID != c.pane {
			return answerResult{}, httpErr{http.StatusConflict, "pane_changed: the coordinator runs in another pane now"}
		}
		steps, q, err := a.answerSteps(co.PaneID, req)
		if err != nil {
			return answerResult{}, err
		}
		return a.pressChecked(co.PaneID, steps, q, req, func(st keyStep) (string, error) { return a.herdrKeys(slug, co.PaneID, st) })
	}
	t, _, ok := n.col.raw(c.slug, c.thread)
	if !ok || t.PaneID != c.pane || t.Status == "resolved" {
		return answerResult{}, httpErr{http.StatusConflict, "pane_changed: the thread runs in another pane now"}
	}
	steps, q, err := a.answerSteps(c.pane, req)
	if err != nil {
		return answerResult{}, err
	}
	for _, st := range steps {
		if st.text != "" {
			return answerResult{}, errors.New("night mode never types text")
		}
	}
	return a.pressChecked(c.pane, steps, q, req, func(st keyStep) (string, error) {
		return a.hpLocked(30*time.Second, "", append([]string{"thread", "keys", c.slug, c.thread}, st.keys...)...)
	})
}

var (
	allowLabel   = regexp.MustCompile(`(?i)^(yes|allow|approve|accept|proceed|confirm|ok|run)\b`)
	lastingLabel = regexp.MustCompile(`(?i)don['’]?t ask again|always|auto mode|accept edits|auto-approve|in the future|trust|(from|for) this project|allow all`)
	recommended  = regexp.MustCompile(`(?i)\(recommended\)`)
)

// decide picks the option to press, or -1 and why the prompt is left.
func (n *Night) decide(p *Prompt, s NightSettings, c nightCand) (int, string) {
	switch p.Kind {
	case "plan":
		return -1, "plan approval: always left for you"
	case "trust":
		return -1, "trust screen: a lasting grant, left for you"
	case "confirm":
		return -1, "a y/n confirmation is ambiguous (not a permission prompt): left for you"
	case "question":
		if !s.Questions {
			return -1, "question: answering questions is off"
		}
		if p.Multi || len(p.Tabs) > 1 || p.Notes || p.Focused {
			return -1, "question: several answers or questions at once (ambiguous), left for you"
		}
		pick, count := -1, 0
		for i, o := range p.Options {
			if recommended.MatchString(o.Label) {
				pick, count = i, count+1
			}
		}
		if count != 1 {
			return -1, fmt.Sprintf("question: %d options are marked (Recommended), not exactly one; left for you", count)
		}
		if o := p.Options[pick]; len(o.Keys) == 0 || o.Text == "required" {
			return -1, "question: the (Recommended) option cannot be picked with keys from here"
		}
		return pick, "the one (Recommended) option"
	case "permission":
	default:
		return -1, "not a permission prompt (ambiguous): left for you"
	}
	if p.Focused {
		return -1, "a text field in the pane has the keyboard: left for you"
	}
	if name, hit := n.denied(p, c.root); name != "" {
		return -1, fmt.Sprintf("deny list: %s (%s)", name, clip(hit, 80))
	}
	usable := func(o PromptOption) bool {
		return allowLabel.MatchString(o.Label) && len(o.Keys) > 0 && o.Text != "required" && !o.Submit
	}
	for i, o := range p.Options {
		if usable(o) && !o.Always && !alwaysRe.MatchString(o.Label) {
			return i, ""
		}
	}
	// No allow-once option: the harness's plain allow, when it is not a
	// lasting grant and the prompt is not about one.
	if !lastingLabel.MatchString(p.Title + " " + p.Question) {
		for i, o := range p.Options {
			if usable(o) && !lastingLabel.MatchString(o.Label) {
				return i, "no allow-once option: used the harness's allow option"
			}
		}
	}
	return -1, "no allow-once option (only lasting grants): left for you"
}

// promptCommand is what a prompt asks to do, for the log: the command,
// file or URL, else its summary.
func promptCommand(p *Prompt) string {
	s := p.Summary
	if p.Subject != "" {
		s = strings.TrimSpace(p.Title + " " + p.Subject)
	} else if p.Kind == "question" {
		s = p.Question
	}
	return clip(strings.ReplaceAll(s, "\n", " "), 300)
}

// denyText is the prompt as the deny list sees it: what it asks, with
// whitespace folded. A diff's lines are left out (text being written to a
// file is not a command); its file name is not.
func denyText(p *Prompt) string {
	var det []string
	for _, l := range strings.Split(p.Detail, "\n") {
		if !diffRe.MatchString(l) {
			det = append(det, l)
		}
	}
	all := strings.Join([]string{p.Title, p.Subject, p.Question, p.Desc, strings.Join(det, "\n")}, "\n")
	return strings.Join(strings.Fields(all), " ")
}

// denied is the first deny rule the prompt hits, and what it matched.
func (n *Night) denied(p *Prompt, root string) (string, string) {
	n.mu.Lock()
	rules := n.deny
	n.mu.Unlock()
	text := denyText(p)
	for _, r := range rules {
		if r.re == nil {
			if hit := rmOutside(p.Subject+"\n"+p.Desc, root); hit != "" {
				return r.Name, hit
			}
			continue
		}
		if m := r.re.FindString(text); m != "" {
			return r.Name, strings.TrimSpace(m)
		}
	}
	return "", ""
}

var shellSplit = regexp.MustCompile(`&&|\|\||[;|&\n` + "`" + `()]|\$\(`)

// rmOutside finds an rm -r in a command whose target is /, ~, a variable,
// has "..", or is an absolute path outside root. It returns the target.
func rmOutside(cmd, root string) string {
	root = strings.TrimRight(root, "/")
	for _, seg := range shellSplit.Split(cmd, -1) {
		f := strings.Fields(seg)
		at := -1
		for i, w := range f {
			if w == "rm" || strings.HasSuffix(w, "/rm") {
				at = i
				break
			}
		}
		if at < 0 {
			continue
		}
		recursive, flags := false, true
		var targets []string
		for _, w := range f[at+1:] {
			switch {
			case flags && w == "--":
				flags = false
			case flags && strings.HasPrefix(w, "--"):
				if w == "--recursive" {
					recursive = true
				}
			case flags && strings.HasPrefix(w, "-") && len(w) > 1:
				if strings.ContainsAny(w, "rR") {
					recursive = true
				}
			default:
				targets = append(targets, strings.Trim(w, `'"`))
			}
		}
		if !recursive {
			continue
		}
		for _, t := range targets {
			clean := filepath.Clean(t)
			switch {
			case t == "" || strings.HasPrefix(t, "~") || strings.Contains(t, "$"):
				return t
			case clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../"):
				return t
			case strings.HasPrefix(t, "/"):
				if root == "" || clean == root || !strings.HasPrefix(clean, root+"/") {
					return t
				}
			case clean == "." || clean == "*" || clean == ".*":
				// the working folder itself: inside the worktree only for a thread
				if root == "" {
					return t
				}
			}
		}
	}
	return ""
}

func localClock(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ts
	}
	return t.Local().Format("15:04")
}

// ---------------------------------------------------------------- HTTP

func (n *Night) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/night", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, n.status()) })
	mux.HandleFunc("POST /api/night", n.act.guard(n.update))
	mux.HandleFunc("GET /api/night/log", n.logHTTP)
}

func (n *Night) status() map[string]any {
	now := n.now()
	n.mu.Lock()
	defer n.mu.Unlock()
	n.evaluate(now)
	pending := []NightEntry{}
	for _, e := range n.pending {
		if q := n.col.promptOf(e.Pane); q != nil && q.Sig == e.sig {
			e.Pending = true
			pending = append(pending, e)
		}
	}
	flagged := []nightFlag{}
	for _, f := range n.flagged {
		flagged = append(flagged, *f)
	}
	return map[string]any{"settings": n.s, "default_deny": defaultDeny, "active": n.active, "why": n.why, "until": n.until(now),
		"session": n.session, "last_session": n.last, "pending": pending, "flagged": flagged,
		"read_only": n.cfg.ReadOnly, "now": now.Format(time.RFC3339)}
}

func (n *Night) update(r *http.Request, body []byte) (any, error) {
	n.mu.Lock()
	s := n.s
	s.Projects = append([]string(nil), n.s.Projects...)
	s.Deny = append([]DenyRule(nil), n.s.Deny...)
	wasOn, oldOff := s.Mode == "on", s.OffAt
	n.mu.Unlock()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fail(http.StatusBadRequest, "bad JSON body: %v", err)
	}
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, fail(http.StatusBadRequest, "bad JSON body: %v", err)
	}
	if v, ok := raw["deny"]; ok && string(v) == "null" {
		s.Deny = append([]DenyRule(nil), defaultDeny...) // null: back to the defaults
	}
	deny, err := s.check()
	if err != nil {
		return nil, err
	}
	now := n.now()
	switch {
	case s.Mode != "on":
		s.Until = ""
	case !wasOn || s.OffAt != oldOff:
		s.Until = ""
		if s.OffAt != "" {
			s.Until = nextClock(now, s.OffAt).Format(time.RFC3339)
		}
	}
	n.mu.Lock()
	n.s, n.deny = s, deny
	err = n.save()
	// Prompts left under the old settings are decided again under the new
	// ones (a prompt whose keys were pressed is never pressed again).
	for pane, e := range n.pending {
		if e.Result == "refused" {
			delete(n.watch, pane)
		}
	}
	n.evaluate(now)
	n.mu.Unlock()
	if err != nil {
		return nil, fail(http.StatusInternalServerError, "night settings not saved: %v", err)
	}
	log.Printf("night: settings: mode %s, %d projects, coordinators %v, questions %v, %d deny rules", s.Mode, len(s.Projects), s.Coordinators, s.Questions, len(s.Deny))
	go n.Tick()
	return n.status(), nil
}

// logHTTP is the Night log: the night-approve lines of the last days
// (?days=, default 3), oldest first.
func (n *Night) logHTTP(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 {
		days = 3
	}
	days = min(days, maxNightLogDay)
	out := []NightEntry{}
	if n.audit != nil {
		lines, err := n.audit.Read()
		if err != nil {
			http.Error(w, "audit log: "+err.Error(), http.StatusInternalServerError)
			return
		}
		cut := n.now().Add(-time.Duration(days) * 24 * time.Hour)
		n.mu.Lock()
		pend := map[string]string{}
		for _, e := range n.pending {
			if q := n.col.promptOf(e.Pane); q != nil && q.Sig == e.sig {
				pend[e.Pane] = e.TS
			}
		}
		n.mu.Unlock()
		for _, l := range lines {
			if l.Op != nightOp || l.Actor != nightActor {
				continue
			}
			if t, err := time.Parse(time.RFC3339, l.TS); err != nil || t.Before(cut) {
				continue
			}
			e := NightEntry{TS: l.TS, Project: l.Target, Command: l.Command, Option: l.Text, Reason: l.Reason}
			e.Result = map[string]string{"ok": "approved", "refused": "refused", "failed": "failed"}[l.Result]
			if len(l.Args) == 4 {
				e.Thread, e.Pane, e.Harness, e.Kind = l.Args[0], l.Args[1], l.Args[2], l.Args[3]
			}
			if e.Thread == "coordinator" {
				e.Thread, e.Coordinator = "", true
			}
			e.Pending = e.Result != "approved" && pend[e.Pane] == e.TS
			out = append(out, e)
		}
	}
	writeJSON(w, map[string]any{"entries": out, "days": days})
}
