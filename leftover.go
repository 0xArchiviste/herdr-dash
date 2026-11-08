package main

// Leftovers: resolved threads whose agents still run, and agent panes of a
// project that match no thread at all (orphans). herdr-projects resolves a
// thread and removes its worktree, but a pane it no longer tracks can stay
// open with its agent idle in a deleted folder, holding memory.
//
// Detection reads only the pane list the collector already polls and the
// thread records it already has: no herdr call of its own. It is cached
// until the pane list or a thread list changes.
//
// A pane belongs to a resolved thread when
//   - it is the pane the record names, and something else agrees (its cwd is
//     under the thread's folder, or it carries the project's hp tokens):
//     herdr reuses pane ids, so the id alone could be someone else's pane;
//   - it is named "t-NNNN · …" in herdr's sidebar with the project's tokens;
//   - its cwd is under the thread's worktree (or own folder), deleted or not.
// Panes of open threads and coordinators are never leftovers. An agent pane
// with a project's tokens that matches no thread is that project's orphan.
//
// Closing one is explicit, per pane, confirmed in the page, re-checked here
// against a fresh `herdr pane get`, refused when the agent is working, and
// written to the fleet audit log:
//
//   POST /api/project/{slug}/leftovers/close
//     {panes: [{pane, thread, agent, cwd, workspace}]}           one pane
//     {all: true, count: N, panes: [...every leftover of slug]}  all of them

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0xArchiviste/herdr-dash/internal/fleet"
)

// LeftoverPane is one live pane of a resolved thread, or an orphan.
type LeftoverPane struct {
	Pane      string `json:"pane"`
	Tab       string `json:"tab,omitempty"`
	Workspace string `json:"workspace,omitempty"`
	Agent     string `json:"agent"`  // "" when the agent exited and a shell is left
	Status    string `json:"status"` // herdr's agent_status
	Cwd       string `json:"cwd"`
	Deleted   bool   `json:"deleted,omitempty"` // the cwd is a deleted folder
	Name      string `json:"name,omitempty"`    // herdr's sidebar name
	Thread    string `json:"thread,omitempty"`  // "" for an orphan
	Match     string `json:"match"`             // pane, title, cwd, tokens (orphan)
}

type leftoverSet struct {
	threads map[string][]LeftoverPane // thread id -> its live panes
	orphans []LeftoverPane
}

type leftoverCache struct {
	key string
	set map[string]*leftoverSet
}

const deletedSuffix = " (deleted)"

var titleIDRe = regexp.MustCompile(`^(t-[0-9]{1,6}) ·`)

// leftovers is every project's leftovers, by slug. c.mu must be held.
func (c *Collector) leftovers() map[string]*leftoverSet {
	var kb strings.Builder
	fmt.Fprintf(&kb, "%x", c.panesHash)
	for _, slug := range c.order {
		if p := c.projects[slug]; p != nil {
			fmt.Fprintf(&kb, "|%s %d %s %d", slug, p.fetched.UnixNano(), p.record.PaneID, len(p.coords))
		}
	}
	if kb.String() == c.leftover.key && c.leftover.set != nil {
		return c.leftover.set
	}
	c.leftover = leftoverCache{key: kb.String(), set: c.detectLeftovers()}
	return c.leftover.set
}

type threadRef struct {
	slug string
	t    *RawThread
}

// guarded are folders too wide to say a pane in them is a thread's.
func (c *Collector) guarded() map[string]bool {
	g := map[string]bool{"/": true, filepath.Clean(c.cfg.Root): true}
	if h, err := os.UserHomeDir(); err == nil {
		g[filepath.Clean(h)] = true
	}
	for _, slug := range c.order {
		g[filepath.Join(c.cfg.Root, slug)] = true
	}
	return g
}

func (c *Collector) detectLeftovers() map[string]*leftoverSet {
	taken := map[string]bool{} // panes of open threads and coordinators
	byPane := map[string][]threadRef{}
	byDir := map[string]threadRef{}
	byTitle := map[string]threadRef{} // slug + " " + id
	guard := c.guarded()
	for _, slug := range c.order {
		p := c.projects[slug]
		if p == nil {
			continue
		}
		for _, lc := range p.coords {
			taken[lc.PaneID] = true
		}
		taken[p.record.PaneID] = true
		for i := range p.threads {
			t := &p.threads[i]
			if t.Status != "resolved" {
				taken[t.PaneID] = true
				continue
			}
			r := threadRef{slug, t}
			if t.PaneID != "" {
				byPane[t.PaneID] = append(byPane[t.PaneID], r)
			}
			byTitle[slug+" "+t.ID] = r
			// An adopted thread ran in the user's own checkout: a pane there
			// is not the thread's for being there.
			if t.Kind == "adopted" {
				continue
			}
			for _, d := range []string{t.WorktreePath, t.Cwd} {
				if d == "" || !filepath.IsAbs(d) {
					continue
				}
				d = filepath.Clean(d)
				if guard[d] || d == filepath.Clean(t.Repo) {
					continue
				}
				byDir[d] = r
			}
		}
	}
	delete(taken, "")
	out := map[string]*leftoverSet{}
	set := func(slug string) *leftoverSet {
		s := out[slug]
		if s == nil {
			s = &leftoverSet{threads: map[string][]LeftoverPane{}}
			out[slug] = s
		}
		return s
	}
	ids := make([]string, 0, len(c.panes))
	for id := range c.panes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		pn := c.panes[id]
		if taken[id] {
			continue
		}
		cwd, deleted := strings.CutSuffix(pn.Cwd, deletedSuffix)
		var dirRef *threadRef
		if filepath.IsAbs(cwd) {
			for d := filepath.Clean(cwd); ; d = filepath.Dir(d) {
				if r, ok := byDir[d]; ok {
					dirRef = &r
					break
				}
				if d == "/" || d == "." {
					break
				}
			}
		}
		proj, _ := pn.Tokens["hp_project"].(string)
		var titleRef *threadRef
		if m := titleIDRe.FindStringSubmatch(pn.DisplayAgent); m != nil && proj != "" {
			if r, ok := byTitle[proj+" "+m[1]]; ok {
				titleRef = &r
			}
		}
		var hit *threadRef
		match := ""
		// The record's pane, newest thread first, when something agrees.
		cands := byPane[id]
		for i := len(cands) - 1; i >= 0; i-- {
			r := cands[i]
			if (dirRef != nil && dirRef.t == r.t) || (titleRef != nil && titleRef.t == r.t) || proj == r.slug {
				hit, match = &r, "pane"
				break
			}
		}
		if hit == nil && titleRef != nil {
			hit, match = titleRef, "title"
		}
		if hit == nil && dirRef != nil {
			hit, match = dirRef, "cwd"
		}
		lp := LeftoverPane{Pane: id, Tab: pn.TabID, Workspace: pn.WorkspaceID, Agent: pn.Agent, Status: pn.AgentStatus, Cwd: pn.Cwd, Deleted: deleted, Name: pn.DisplayAgent, Match: match}
		switch {
		case hit != nil:
			lp.Thread = hit.t.ID
			s := set(hit.slug)
			s.threads[hit.t.ID] = append(s.threads[hit.t.ID], lp)
		case proj != "" && pn.Agent != "" && c.projects[proj] != nil:
			lp.Match = "tokens"
			s := set(proj)
			s.orphans = append(s.orphans, lp)
		}
	}
	return out
}

// leftoverPanes is slug's leftovers as of the last rebuild: every resolved
// thread's live panes, then the orphans.
func (c *Collector) leftoverPanes(slug string) []LeftoverPane {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.leftover.set[slug]
	if s == nil {
		return nil
	}
	var out []LeftoverPane
	ids := make([]string, 0, len(s.threads))
	for id := range s.threads {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		out = append(out, s.threads[id]...)
	}
	return append(out, s.orphans...)
}

// rssOf is the pane's processes' RSS in the last System frame (0: unknown).
func (c *Collector) rssOf(pane string) uint64 {
	for _, p := range c.sys.Frame().Procs {
		if p.Pane == pane {
			return p.RSS
		}
	}
	return 0
}

func gbText(b uint64) string { return fmt.Sprintf("%.1f GB", float64(b)/(1<<30)) }

// ---------------------------------------------------------------- closing

type leftoverWant struct {
	Pane      string `json:"pane"`
	Thread    string `json:"thread"`
	Agent     string `json:"agent"`
	Cwd       string `json:"cwd"`
	Workspace string `json:"workspace"`
}

type leftoverResult struct {
	Pane   string `json:"pane"`
	Thread string `json:"thread,omitempty"`
	Result string `json:"result"` // ok refused failed
	Code   string `json:"code,omitempty"`
	Error  string `json:"error,omitempty"`
}

type Leftovers struct {
	a     *Actions
	audit *fleet.Audit
	now   func() time.Time
}

func NewLeftovers(a *Actions, audit *fleet.Audit) *Leftovers {
	return &Leftovers{a: a, audit: audit, now: time.Now}
}

func (l *Leftovers) register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/project/{slug}/leftovers/close", l.a.guard(l.close))
	mux.HandleFunc("GET /api/project/{slug}/leftovers/close", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "POST")
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
	})
}

func (l *Leftovers) close(r *http.Request, body []byte) (any, error) {
	slug := r.PathValue("slug")
	if !slugRe.MatchString(slug) {
		return nil, fail(http.StatusBadRequest, "bad project")
	}
	var req struct {
		All   bool           `json:"all"`
		Count int            `json:"count"`
		Panes []leftoverWant `json:"panes"`
	}
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	if len(req.Panes) == 0 || len(req.Panes) > maxBulk || (!req.All && len(req.Panes) != 1) {
		return nil, fail(http.StatusBadRequest, "name one pane, or every leftover with all and count")
	}
	col := l.a.col
	if !col.hasProject(slug) {
		return nil, fail(http.StatusNotFound, "no project %s", slug)
	}
	current := col.leftoverPanes(slug)
	batch := ""
	if req.All {
		// The typed count and the list must be the project's leftovers of
		// the moment: a pane that came or went since the dialog stops it.
		same := req.Count == len(current) && len(req.Panes) == len(current)
		if same {
			want := map[string]bool{}
			for _, w := range req.Panes {
				want[w.Pane] = true
			}
			for _, cur := range current {
				same = same && want[cur.Pane]
			}
		}
		if !same {
			return nil, fail(http.StatusConflict, "confirm_count: %s has %d leftover pane(s) now, not the %d confirmed; look at the list again", slug, len(current), req.Count)
		}
		batch = "lo-" + randHex(4)
	}
	if !l.a.bucket.take() {
		return nil, fail(http.StatusTooManyRequests, "too many writes; wait a moment")
	}
	l.a.mu.Lock()
	results := make([]leftoverResult, 0, len(req.Panes))
	for _, w := range req.Panes {
		results = append(results, l.closeOne(slug, w, current, batch))
	}
	l.a.mu.Unlock()
	col.Kick()
	closed := 0
	for _, res := range results {
		if res.Result == "ok" {
			closed++
		}
	}
	out := struct {
		OK      bool             `json:"ok"`
		Closed  int              `json:"closed"`
		Batch   string           `json:"batch,omitempty"`
		Results []leftoverResult `json:"results"`
		Error   string           `json:"error,omitempty"`
		Code    string           `json:"code,omitempty"`
	}{OK: closed == len(results), Closed: closed, Batch: batch, Results: results}
	if !req.All && closed == 0 {
		out.Error, out.Code = results[0].Error, results[0].Code
		return nil, bodyErr{status: http.StatusConflict, msg: results[0].Code + ": " + results[0].Error, body: out}
	}
	return out, nil
}

// closeOne checks one pane against what the user confirmed and what herdr
// says now, closes it, and writes the audit line. Under a.mu.
func (l *Leftovers) closeOne(slug string, w leftoverWant, current []LeftoverPane, batch string) (res leftoverResult) {
	col := l.a.col
	res = leftoverResult{Pane: w.Pane, Thread: w.Thread}
	who := w.Thread
	if who == "" {
		who = "orphan"
	}
	rss := col.rssOf(w.Pane)
	line := fleet.AuditLine{Actor: auditActor, Batch: batch, Op: "close-leftover", Target: slug, Args: []string{who, w.Pane}, Command: "herdr pane close " + w.Pane}
	describe := func(agent, status, cwd, ws, match string) string {
		s := fmt.Sprintf("agent %s (%s) · cwd %s · workspace %s", orNone(agent), orNone(status), orNone(cwd), orNone(ws))
		if rss > 0 {
			s += " · RSS " + gbText(rss)
		}
		if match != "" {
			s += " · matched by " + match
		}
		return s
	}
	line.Text = describe(w.Agent, "", w.Cwd, w.Workspace, "")
	defer func() {
		line.Result = res.Result
		if res.Code != "" {
			line.Reason = res.Code + ": " + res.Error
		} else if res.Result == "failed" {
			line.Error = res.Error
		}
		l.audit.Append(l.now(), line)
	}()
	refuse := func(code, format string, a ...any) leftoverResult {
		res.Result, res.Code, res.Error = "refused", code, fmt.Sprintf(format, a...)
		return res
	}
	var cur *LeftoverPane
	for i := range current {
		if current[i].Pane == w.Pane {
			cur = &current[i]
		}
	}
	if !validPane(w.Pane) {
		return refuse("not_leftover", "%q is not a pane id", w.Pane)
	}
	if cur == nil {
		return refuse("not_leftover", "pane %s is not a leftover of %s: its thread is open, or the pane is gone", w.Pane, slug)
	}
	if cur.Thread != w.Thread {
		return refuse("pane_changed", "pane %s now belongs to %s, not %s", w.Pane, orNone(cur.Thread), orNone(w.Thread))
	}
	if cur.Thread != "" {
		t, _, ok := col.raw(slug, cur.Thread)
		if !ok || t.Status != "resolved" {
			return refuse("not_resolved", "%s is not resolved: only a resolved thread's pane is closed here", cur.Thread)
		}
	}
	// What herdr says now, not what the last poll saw.
	outb, err := run(context.Background(), 5*time.Second, col.cfg.Herdr, "pane", "get", w.Pane)
	var doc struct {
		Result struct {
			Pane Pane `json:"pane"`
		} `json:"result"`
	}
	if err == nil {
		err = json.Unmarshal(outb, &doc)
	}
	if err != nil || doc.Result.Pane.PaneID != w.Pane {
		return refuse("pane_gone", "herdr does not show pane %s any more", w.Pane)
	}
	fresh := doc.Result.Pane
	line.Text = describe(fresh.Agent, fresh.AgentStatus, fresh.Cwd, fresh.WorkspaceID, cur.Match)
	var changed []string
	if fresh.Agent != w.Agent {
		changed = append(changed, fmt.Sprintf("agent %s → %s", orNone(w.Agent), orNone(fresh.Agent)))
	}
	if fresh.Cwd != w.Cwd {
		changed = append(changed, fmt.Sprintf("cwd %s → %s", orNone(w.Cwd), orNone(fresh.Cwd)))
	}
	if fresh.WorkspaceID != w.Workspace {
		changed = append(changed, fmt.Sprintf("workspace %s → %s", orNone(w.Workspace), orNone(fresh.WorkspaceID)))
	}
	if len(changed) > 0 {
		return refuse("pane_changed", "pane %s changed since you looked (%s); nothing was closed", w.Pane, strings.Join(changed, ", "))
	}
	if fresh.AgentStatus == "working" {
		return refuse("agent_working", "the %s agent in pane %s is working; it is not stopped mid-task", orNone(fresh.Agent), w.Pane)
	}
	outb, err = run(context.Background(), 10*time.Second, col.cfg.Herdr, "pane", "close", w.Pane)
	if code, msg := herdrError(outb, err); code != "" || err != nil {
		if code == "confirmation_required" {
			return refuse("worktree_group", "herdr would close a whole worktree group with pane %s (%s); close it in herdr", w.Pane, msg)
		}
		res.Result, res.Error = "failed", strings.TrimSpace(code+" "+msg)
		return res
	}
	res.Result = "ok"
	return res
}

// herdrError is the {"error":{code,message}} herdr prints on a refusal (on
// stdout or stderr), or the command's own failure.
func herdrError(out []byte, err error) (string, string) {
	texts := []string{string(out)}
	var ce *cmdError
	if e, ok := err.(*cmdError); ok {
		ce = e
		texts = append(texts, ce.stderr)
	}
	for _, t := range texts {
		var doc struct {
			Error *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(t)), &doc) == nil && doc.Error != nil {
			return doc.Error.Code, doc.Error.Message
		}
	}
	if ce != nil {
		return "", ce.Message()
	}
	if err != nil {
		return "", err.Error()
	}
	return "", ""
}

var paneIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{1,40}$`)

func validPane(s string) bool { return paneIDRe.MatchString(s) }

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}
