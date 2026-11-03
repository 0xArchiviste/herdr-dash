package main

// Agent routing, stage 1 (internal/routing): the policy editor's API and the
// headless `herdr-dash routing preview`. Previews only: nothing here starts,
// stops or changes an agent, and saving writes routing.toml alone.
//
//	GET  /api/routing          policy, revision, catalog, usage per provider
//	POST /api/routing/preview  {project, thread?, mode} -> decision (no writes)
//	POST /api/routing          {expected_revision, ops} -> typed patch, saved

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"text/tabwriter"
	"time"

	"github.com/0xArchiviste/herdr-dash/internal/routing"
)

type Routing struct {
	cfg   Config
	col   *Collector // nil in the CLI
	usage *Usage
	act   *Actions // nil in the CLI
	store *routing.Store
	now   func() time.Time
}

func NewRouting(cfg Config, col *Collector, usage *Usage, act *Actions) *Routing {
	return &Routing{cfg: cfg, col: col, usage: usage, act: act, store: routing.NewStore(cfg.RoutingConfig), now: time.Now}
}

func (rt *Routing) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/routing", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, rt.state(rt.store.Load()))
	})
	mux.HandleFunc("POST /api/routing/preview", rt.previewHTTP)
	mux.HandleFunc("POST /api/routing", rt.save)
	mux.HandleFunc("GET /api/routing/preview", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "POST")
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
	})
}

type routingProject struct {
	Slug          string          `json:"slug"`
	Name          string          `json:"name"`
	LegacyProfile string          `json:"legacy_profile"`
	Threads       []routingThread `json:"threads"`
}

type routingThread struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state"`
}

type routingProvider struct {
	routing.Provider
	Usage routing.Signal `json:"usage"`
}

type routingState struct {
	Path          string                `json:"path"`
	Exists        bool                  `json:"exists"`
	Revision      string                `json:"revision"`
	Valid         bool                  `json:"valid"`
	Errors        []routing.FieldError  `json:"errors"`
	Warnings      []routing.FieldError  `json:"warnings"`
	Problem       string                `json:"problem,omitempty"`
	WriteBlock    string                `json:"write_block,omitempty"`
	ReadOnly      bool                  `json:"read_only"`
	Policy        *routing.Policy       `json:"policy"`
	Modes         []routing.Mode        `json:"modes"`
	Providers     []routingProvider     `json:"providers"`
	Profiles      []routing.Profile     `json:"profiles"`
	ProfilesKnown bool                  `json:"profiles_known"`
	Projects      []routingProject      `json:"projects"`
	Enforcement   map[string]string     `json:"enforcement"`
	Usage         routing.UsageSettings `json:"usage_settings"`
	GeneratedAt   time.Time             `json:"generated_at"`
}

func (rt *Routing) state(snap routing.Snapshot) routingState {
	st := routingState{
		Path: tildePath(rt.cfg.RoutingConfig), Exists: snap.Exists, Revision: snap.Revision,
		Valid: snap.Err == nil && len(snap.Errors) == 0, Errors: snap.Errors, Warnings: snap.Warnings,
		WriteBlock: snap.WriteBlock, ReadOnly: rt.cfg.ReadOnly, Policy: snap.Policy, Modes: routing.Modes,
		Usage:       routing.UsageSettings{MaxAgeSeconds: routing.DefaultMaxAgeSeconds, AvoidAtPercent: routing.DefaultAvoidAtPercent},
		GeneratedAt: rt.now().UTC(),
		Enforcement: map[string]string{
			"threads":   "Preview only: herdr-projects does not ask Dash before a launch yet, so saving changes no launch and no running agent.",
			"helpers":   "Only helpers herdr launches will be routed.",
			"subagents": "Claude and Codex internal subagents: not enforced.",
		},
	}
	if snap.Err != nil {
		st.Problem = snap.Err.Error()
	}
	if snap.Policy != nil {
		st.Usage = snap.Policy.Usage
	}
	if st.Errors == nil {
		st.Errors = []routing.FieldError{}
	}
	if st.Warnings == nil {
		st.Warnings = []routing.FieldError{}
	}
	sig := rt.usage.Signals()
	for _, p := range routing.Providers {
		st.Providers = append(st.Providers, routingProvider{p, sig[p.ID]})
	}
	cat, known := rt.profiles()
	st.ProfilesKnown = known
	st.Profiles = []routing.Profile{}
	for _, p := range cat {
		st.Profiles = append(st.Profiles, p)
	}
	sort.Slice(st.Profiles, func(i, j int) bool { return st.Profiles[i].Name < st.Profiles[j].Name })
	st.Projects = rt.projects()
	return st
}

// tildePath shows a path under $HOME as ~/…: the page never needs the home.
func tildePath(p string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if rel, err := filepath.Rel(home, p); err == nil && !strings.HasPrefix(rel, "..") {
			return "~/" + filepath.ToSlash(rel)
		}
	}
	return p
}

// profiles reads the herdr-projects profile catalog.
func (rt *Routing) profiles() (map[string]routing.Profile, bool) {
	b, err := os.ReadFile(rt.cfg.SessionProfiles)
	if err != nil {
		return nil, false
	}
	var cfg profileConfig
	if tomlDecode(b, &cfg) != nil {
		return nil, false
	}
	out := map[string]routing.Profile{}
	for name, p := range cfg.Profiles {
		out[name] = routing.Profile{Name: name, Agent: p.Agent, Model: p.Model}
	}
	return out, true
}

// legacyProfile is what a launch uses without routing: PROJECT.md
// thread_profile, else the herdr-projects default.
func (rt *Routing) legacyProfile(slug string) string {
	b, err := os.ReadFile(filepath.Join(rt.cfg.Root, slug, "PROJECT.md"))
	if err != nil {
		return ""
	}
	if p := parseSettings(string(b))["thread_profile"]; p != "" {
		return p
	}
	if b, err := os.ReadFile(rt.cfg.SessionProfiles); err == nil {
		var cfg profileConfig
		if tomlDecode(b, &cfg) == nil {
			p, _ := cfg.Defaults["thread_profile"].(string)
			return p
		}
	}
	return ""
}

func (rt *Routing) projects() []routingProject {
	out := []routingProject{}
	if rt.col == nil {
		return out
	}
	snap := rt.col.Snapshot()
	threads := map[string][]routingThread{}
	for _, t := range snap.Threads {
		threads[t.Project] = append(threads[t.Project], routingThread{t.ID, t.Title, t.State})
	}
	for _, p := range snap.Projects {
		ts := threads[p.Slug]
		if ts == nil {
			ts = []routingThread{}
		}
		sort.Slice(ts, func(i, j int) bool { return ts[i].ID < ts[j].ID })
		out = append(out, routingProject{p.Slug, p.Name, rt.legacyProfile(p.Slug), ts})
	}
	return out
}

type previewReq struct {
	Project string `json:"project"`
	Thread  string `json:"thread,omitempty"`
	Mode    string `json:"mode"`
}

// preview is the one decision path the page and the CLI share.
func (rt *Routing) preview(req previewReq) (routing.Decision, error) {
	if !slugRe.MatchString(req.Project) {
		return routing.Decision{}, fail(http.StatusBadRequest, "bad project")
	}
	if req.Thread != "" && !idRe.MatchString(req.Thread) {
		return routing.Decision{}, fail(http.StatusBadRequest, "bad thread")
	}
	if !routing.IsMode(req.Mode) {
		return routing.Decision{}, fail(http.StatusBadRequest, "unknown mode; modes are planning, coding, crawl")
	}
	if _, err := os.Stat(filepath.Join(rt.cfg.Root, req.Project, "PROJECT.md")); err != nil {
		return routing.Decision{}, fail(http.StatusNotFound, "no project %s", req.Project)
	}
	snap := rt.store.Load()
	cat, known := rt.profiles()
	in := routing.Input{Policy: snap.Policy, Revision: snap.Revision, Project: req.Project, Thread: req.Thread, Mode: req.Mode,
		LegacyProfile: rt.legacyProfile(req.Project), Signals: rt.usage.Signals(), Profiles: cat, ProfilesKnown: known, Now: rt.now()}
	switch {
	case snap.Err != nil:
		in.Invalid = routing.FieldErrors{{Field: "(file)", Message: snap.Err.Error()}}
	case len(snap.Errors) > 0:
		in.Invalid = snap.Errors
	}
	return routing.Decide(in), nil
}

func strictDecode(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fail(http.StatusBadRequest, "bad JSON body: %v", err)
	}
	if dec.More() {
		return fail(http.StatusBadRequest, "bad JSON body: trailing data")
	}
	return nil
}

type routingErr struct {
	OK     bool                 `json:"ok"`
	Error  string               `json:"error"`
	Code   string               `json:"code,omitempty"`
	Fields []routing.FieldError `json:"fields,omitempty"`
	State  *routingState        `json:"state,omitempty"`
}

func writeStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (rt *Routing) previewHTTP(w http.ResponseWriter, r *http.Request) {
	// A preview writes nothing, so read-only mode allows it; a foreign page
	// still may not drive it.
	var req previewReq
	err := sameOriginJSON(r)
	if err == nil {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<10))
		err = strictDecode(body, &req)
	}
	var d routing.Decision
	if err == nil {
		d, err = rt.preview(req)
	}
	var he httpErr
	if errors.As(err, &he) {
		writeStatus(w, he.status, routingErr{Error: he.msg})
		return
	}
	writeJSON(w, d)
}

// save shares the write guard of every other action: read-only refusal,
// same-origin JSON, the write rate limit. It never runs herdr-projects.
func (rt *Routing) save(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	refuse := func(status int, e routingErr) {
		log.Printf("action routing from %s: refused %d: %s", r.RemoteAddr, status, e.Error)
		writeStatus(w, status, e)
	}
	if err := rt.act.precheck(r); err != nil {
		he := err.(httpErr)
		refuse(he.status, routingErr{Error: he.msg})
		return
	}
	if !rt.act.bucket.take() {
		refuse(http.StatusTooManyRequests, routingErr{Error: "too many writes; wait a moment"})
		return
	}
	var req struct {
		ExpectedRevision string       `json:"expected_revision"`
		Ops              []routing.Op `json:"ops"`
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err := strictDecode(body, &req); err != nil {
		refuse(http.StatusBadRequest, routingErr{Error: err.Error()})
		return
	}
	if req.ExpectedRevision == "" {
		refuse(http.StatusBadRequest, routingErr{Error: "expected_revision is required (\"none\" for a new file)"})
		return
	}
	if fe := rt.checkProfiles(req.Ops); len(fe) > 0 {
		refuse(http.StatusUnprocessableEntity, routingErr{Error: fe.Error(), Code: "invalid", Fields: fe})
		return
	}
	snap, err := rt.store.Apply(req.ExpectedRevision, req.Ops)
	var fe routing.FieldErrors
	switch {
	case err == nil:
		log.Printf("action routing from %s: ok, revision %s (%s)", r.RemoteAddr, snap.Revision, time.Since(start).Round(time.Millisecond))
		st := rt.state(snap)
		writeJSON(w, map[string]any{"ok": true, "state": st})
	case errors.Is(err, routing.ErrConflict):
		st := rt.state(rt.store.Load())
		refuse(http.StatusConflict, routingErr{Error: "routing.toml changed since you loaded it (another tab or a hand edit). Reload to see it, then redo your change.", Code: "conflict", State: &st})
	case errors.As(err, &fe):
		refuse(http.StatusUnprocessableEntity, routingErr{Error: fe.Error(), Code: "invalid", Fields: fe})
	case errors.Is(err, routing.ErrUnsafe):
		refuse(http.StatusForbidden, routingErr{Error: err.Error(), Code: "unsafe"})
	default:
		refuse(http.StatusInternalServerError, routingErr{Error: err.Error()})
	}
}

// checkProfiles refuses candidates naming a profile herdr-projects does not
// define (the built-in claude, codex and opencode always exist).
func (rt *Routing) checkProfiles(ops []routing.Op) routing.FieldErrors {
	cat, known := rt.profiles()
	if !known {
		return nil
	}
	var fe routing.FieldErrors
	for i, op := range ops {
		for j, c := range op.Candidates {
			if !knownProvider(c.Provider) {
				continue // the schema check names it
			}
			if _, ok := cat[c.Profile]; !ok && c.Profile != c.Provider {
				fe = append(fe, routing.FieldError{Field: fmt.Sprintf("ops[%d].candidates[%d].profile", i, j), Message: fmt.Sprintf("herdr-projects has no profile %q", c.Profile)})
			}
		}
	}
	return fe
}

func knownProvider(id string) bool {
	for _, p := range routing.Providers {
		if p.ID == id {
			return true
		}
	}
	return false
}

// Signals is each usage source as routing sees it, read through the same
// per-source cache as the usage strip.
func (u *Usage) Signals() map[string]routing.Signal {
	out := map[string]routing.Signal{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, s := range u.sources {
		wg.Add(1)
		go func() {
			defer wg.Done()
			src := u.get(s)
			sig := routing.Signal{Provider: s.id, Status: src.Status, Reason: src.Reason, Plan: src.Plan, AsOf: src.AsOf,
				ValidUntil: src.ValidUntil, CheckedAt: src.CheckedAt, Stale: src.Stale, Metered: src.Metered, Windows: []routing.Window{}}
			if s.id == "opencode" {
				sig.Plan, sig.Model = "", src.Plan
			}
			for _, w := range src.Windows {
				sig.Windows = append(sig.Windows, routing.Window{Label: w.Label, UsedPercent: w.UsedPercent, ResetsAt: w.ResetsAt, ResetPassed: w.ResetPassed})
			}
			mu.Lock()
			out[s.id] = sig
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out
}

// routingMain is `herdr-dash routing preview`: the same decision as the
// page's "Why this choice?", without a server. Server flags (root, usage
// sources, --routing-config, --session-profiles) apply.
func routingMain(args []string) int {
	if len(args) == 0 || args[0] != "preview" {
		fmt.Fprintln(os.Stderr, "usage: herdr-dash routing preview --project SLUG --mode planning|coding|crawl [--thread t-0001] [--json] [server flags]")
		return 2
	}
	o := defineServerFlags()
	project := flag.String("project", "", "routing preview: project slug")
	thread := flag.String("thread", "", "routing preview: thread id (default: a new thread)")
	mode := flag.String("mode", "coding", "routing preview: planning, coding or crawl")
	asJSON := flag.Bool("json", false, "routing preview: print the decision as JSON")
	if err := flag.CommandLine.Parse(args[1:]); err != nil {
		return 2
	}
	if err := o.finish(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	rt := NewRouting(o.cfg, nil, NewUsage(o.cfg.Usage), nil)
	d, err := rt.preview(previewReq{Project: *project, Thread: *thread, Mode: *mode})
	if err != nil {
		fmt.Fprintln(os.Stderr, "herdr-dash routing preview:", err)
		return 2
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(d)
		return 0
	}
	who := "a new " + d.Mode + " thread"
	if d.Thread != "" {
		who = d.Mode + " thread " + d.Thread
	}
	fmt.Printf("%s in %s: %s\n%s\n", who, d.Project, d.Outcome, d.Reason)
	tw := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	for i, c := range d.Candidates {
		fmt.Fprintf(tw, "%d.\t%s/%s\t%s\t%s\n", i+1, c.Provider, c.Profile, c.Status, c.Reason)
	}
	tw.Flush()
	return 0
}
