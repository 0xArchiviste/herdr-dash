package main

// The Master window's bulk actions (stage 1b): preview, confirm, execute,
// undo, the broadcast queue and the audit log, over internal/fleet.
//
//   GET  /api/fleet/ops          the ops, their tiers, the limits
//   POST /api/fleet/preview      {op, targets, key, value, text | op:"undo", batch} → plan + token
//   POST /api/fleet/apply        {token, confirm} → {batch}; runs in the background
//   GET  /api/fleet/batch/{id}   live per-project results
//   GET  /api/fleet/queue        broadcasts waiting for a busy coordinator
//   POST /api/fleet/queue/send   {slug, batch}: "send now", once it is idle
//   GET  /api/fleet/audit        the log, newest first, filtered
//
// A preview runs no command. An apply passes the same write guard as every
// other Dash write (read-only mode, same-origin JSON, the write bucket), then
// needs the preview's token: single use, expiring, and bound to the plan's
// hash, which is recomputed against the fleet of the moment. A tier-2 plan
// also needs its count typed back. Steps run one at a time; three failures
// in a row stop the batch.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/0xArchiviste/herdr-dash/internal/fleet"
	"github.com/0xArchiviste/herdr-dash/internal/projects"
)

const (
	breakerAfter = 3 // consecutive failures that stop a batch
	auditActor   = "user@dash"
	keepBatches  = 50
)

type pendingPlan struct {
	req     fleet.Request
	hash    string
	expires time.Time
	used    bool
	needs   int // the typed count a tier-2 plan needs; 0 for none
}

type batchResult struct {
	Slug    string `json:"slug"`
	Name    string `json:"name"`
	Command string `json:"command,omitempty"`
	Result  string `json:"result"` // pending ok failed refused queued not-attempted
	Reason  string `json:"reason,omitempty"`
	Output  string `json:"output,omitempty"`
	Error   string `json:"error,omitempty"`
}

type batchRun struct {
	Batch    string        `json:"batch"`
	Op       string        `json:"op"`
	UndoOf   string        `json:"undo_of,omitempty"`
	Status   string        `json:"status"` // running done stopped
	Note     string        `json:"note,omitempty"`
	Started  string        `json:"started"`
	Results  []batchResult `json:"results"`
	Undoable bool          `json:"undoable"`
}

type queued struct {
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Batch    string `json:"batch"`
	Text     string `json:"text"`
	QueuedAt string `json:"queued_at"`
	Reason   string `json:"reason"`
	preview  string
	token    string
}

// FleetActions holds the pending tokens, the running and recent batches,
// the rate window and the broadcast queue (all in memory: a restart drops
// pending previews and queued messages; the audit log keeps the record).
type FleetActions struct {
	f     *Fleet
	a     *Actions
	cfg   Config
	audit *fleet.Audit
	act   fleet.Actuator
	ttl   time.Duration

	mu            sync.Mutex
	tokens        map[string]*pendingPlan
	batches       map[string]*batchRun
	order         []string
	running       bool
	recent        []time.Time
	lastBroadcast map[string]time.Time
	queue         []*queued
}

func NewFleetActions(cfg Config, f *Fleet, a *Actions) *FleetActions {
	path := cfg.FleetAudit
	if path == "" {
		path = fleet.DefaultAuditPath(cfg.Root)
	}
	ttl := cfg.FleetConfirmTTL
	if ttl <= 0 {
		ttl = 2 * time.Minute
	}
	fa := &FleetActions{f: f, a: a, cfg: cfg, audit: &fleet.Audit{Path: path}, ttl: ttl,
		tokens: map[string]*pendingPlan{}, batches: map[string]*batchRun{}, lastBroadcast: map[string]time.Time{}}
	fa.act = hpActuator{a: a, policy: f.policy}
	f.queued = fa.queued
	fa.audit.Rotate(time.Now())
	return fa
}

func (fa *FleetActions) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/fleet/ops", func(w http.ResponseWriter, r *http.Request) {
		pol := fa.f.policy.Load()
		fa.mu.Lock()
		used := fa.usedLocked(time.Now())
		fa.mu.Unlock()
		writeJSON(w, map[string]any{"ops": fleet.Ops, "set_keys": fleet.SetKeys, "limits": pol.Limits, "enabled": pol.Enabled,
			"read_only": fa.cfg.ReadOnly, "actions_last_minute": used, "prefix": fleet.BroadcastPrefix, "nudge_line": fleet.NudgeLine,
			"confirm_ttl_seconds": int(fa.ttl.Seconds()), "audit_path": tildePath(fa.audit.Path)})
	})
	// A preview is a read: it is served in --read-only mode too.
	mux.HandleFunc("POST /api/fleet/preview", fa.a.guardOpt(64<<10, true, fa.preview))
	mux.HandleFunc("POST /api/fleet/apply", fa.a.guard(fa.apply))
	mux.HandleFunc("POST /api/fleet/queue/send", fa.a.guard(fa.sendNow))
	mux.HandleFunc("GET /api/fleet/batch/{id}", func(w http.ResponseWriter, r *http.Request) {
		fa.mu.Lock()
		b, ok := fa.batches[r.PathValue("id")]
		var cp batchRun
		if ok {
			cp = *b
			cp.Results = append([]batchResult(nil), b.Results...)
		}
		fa.mu.Unlock()
		if !ok {
			http.Error(w, "no such batch", http.StatusNotFound)
			return
		}
		writeJSON(w, cp)
	})
	mux.HandleFunc("GET /api/fleet/queue", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"items": fa.queued()})
	})
	mux.HandleFunc("GET /api/fleet/audit", fa.auditList)
	for _, p := range []string{"GET /api/fleet/preview", "GET /api/fleet/apply", "GET /api/fleet/queue/send"} {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Allow", "POST")
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
		})
	}
}

func (fa *FleetActions) queued() []queued {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	items := make([]queued, 0, len(fa.queue))
	for _, q := range fa.queue {
		items = append(items, *q)
	}
	return items
}

// usedLocked is the executed steps in the last minute.
func (fa *FleetActions) usedLocked(now time.Time) int {
	keep := fa.recent[:0]
	for _, t := range fa.recent {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	fa.recent = keep
	return len(keep)
}

// world gathers the facts a plan needs. It reads PROJECT.md of the targets
// (for set and undo) and fleet.toml; it runs no command.
func (fa *FleetActions) world(req fleet.Request, now time.Time) (fleet.World, error) {
	pol := fa.f.policy.Load()
	w := fleet.World{Now: now, Policy: pol, Projects: map[string]fleet.Target{}, LastBroadcast: map[string]time.Time{}, Queued: map[string]bool{}}
	want := map[string]bool{}
	for _, s := range req.Targets {
		want[s] = true
	}
	if req.Op == "undo" {
		lines, err := fa.audit.Read()
		if err != nil {
			return w, fail(http.StatusInternalServerError, "audit log: %v", err)
		}
		w.Undo = fleet.UndoOf(lines, req.Batch)
		for _, l := range w.Undo.Lines {
			want[l.Target] = true
		}
	}
	for _, p := range fa.f.src.Projects() {
		if !want[p.Slug] {
			continue
		}
		t := fleet.Target{Slug: p.Slug, Name: p.Name, Status: p.Status, Coordinator: p.Coordinator}
		if t.Name == "" {
			t.Name = p.Slug
		}
		if req.Op == "set" || req.Op == "undo" {
			t.Settings, t.SettingsErr = fleetSettings(fa.cfg.Root, p.Slug)
		}
		w.Projects[p.Slug] = t
	}
	fa.mu.Lock()
	w.ActionsLastMinute = fa.usedLocked(now)
	for k, v := range fa.lastBroadcast {
		w.LastBroadcast[k] = v
	}
	for _, q := range fa.queue {
		w.Queued[q.Slug] = true
	}
	fa.mu.Unlock()
	return w, nil
}

// fleetSettings is the SetKeys of slug's PROJECT.md, herdr-projects'
// defaults filled in.
func fleetSettings(root, slug string) (map[string]string, string) {
	b, err := os.ReadFile(filepath.Join(root, slug, "PROJECT.md"))
	if err != nil {
		return nil, "PROJECT.md: " + err.Error()
	}
	s, _, err := projects.ParseProjectMD(string(b))
	if err != nil {
		return nil, err.Error()
	}
	return map[string]string{"max_parallel_threads": fmt.Sprint(s.MaxParallelThreads), "nudge": fmt.Sprint(s.Nudge), "mute": fmt.Sprint(s.Mute)}, ""
}

func (fa *FleetActions) plan(req fleet.Request, now time.Time) (fleet.Plan, error) {
	w, err := fa.world(req, now)
	if err != nil {
		return fleet.Plan{}, err
	}
	p, err := fleet.MakePlan(req, w)
	var pe *fleet.PlanError
	if errors.As(err, &pe) {
		return p, fail(pe.Status, "%s", pe.Msg)
	}
	return p, err
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

type previewOut struct {
	fleet.Plan
	Token   string `json:"token"`
	Expires string `json:"expires"`
}

func (fa *FleetActions) preview(r *http.Request, body []byte) (any, error) {
	var req fleet.Request
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	now := time.Now()
	p, err := fa.plan(req, now)
	if err != nil {
		return nil, err
	}
	tok := "c-" + randHex(12)
	pp := &pendingPlan{req: req, hash: p.Hash, expires: now.Add(fa.ttl)}
	if p.NeedsConfirm {
		pp.needs = p.ConfirmCount
	}
	fa.mu.Lock()
	for k, v := range fa.tokens {
		if now.After(v.expires.Add(10 * time.Minute)) {
			delete(fa.tokens, k)
		}
	}
	fa.tokens[tok] = pp
	fa.mu.Unlock()
	return previewOut{Plan: p, Token: tok, Expires: pp.expires.UTC().Format(time.RFC3339Nano)}, nil
}

// refuseApply logs a refused apply and returns its error.
func (fa *FleetActions) refuseApply(token, hash string, status int, code, format string, a ...any) error {
	msg := fmt.Sprintf(format, a...)
	if code != "" {
		msg = code + ": " + msg
	}
	if err := fa.audit.Append(time.Now(), fleet.AuditLine{Actor: auditActor, Op: "apply", Confirm: token, Preview: hash, Result: "refused", Reason: msg}); err != nil {
		log.Printf("fleet audit: %v", err)
	}
	return fail(status, "%s", msg)
}

func (fa *FleetActions) apply(r *http.Request, body []byte) (any, error) {
	var in struct {
		Token   string `json:"token"`
		Confirm string `json:"confirm"`
	}
	if err := decode(body, &in); err != nil {
		return nil, err
	}
	if in.Token == "" {
		return nil, fail(http.StatusBadRequest, "confirm_unknown: give the token of a preview")
	}
	pol := fa.f.policy.Load()
	if !pol.Enabled {
		return nil, fa.refuseApply(in.Token, "", http.StatusForbidden, "", "bulk actions are off (fleet.toml enabled = false, or it does not parse): previews only")
	}
	now := time.Now()
	fa.mu.Lock()
	pp, ok := fa.tokens[in.Token]
	var hash string
	if ok {
		hash = pp.hash
	}
	switch {
	case !ok:
		fa.mu.Unlock()
		return nil, fa.refuseApply(in.Token, "", http.StatusBadRequest, "confirm_unknown", "no such preview; preview again")
	case pp.used:
		fa.mu.Unlock()
		return nil, fa.refuseApply(in.Token, hash, http.StatusConflict, "confirm_used", "this preview was already used; preview again")
	case now.After(pp.expires):
		fa.mu.Unlock()
		return nil, fa.refuseApply(in.Token, hash, http.StatusGone, "confirm_expired", "the preview expired (%s); preview again", fa.ttl)
	case pp.needs > 0 && strings.TrimSpace(in.Confirm) != fmt.Sprint(pp.needs):
		fa.mu.Unlock()
		return nil, fail(http.StatusBadRequest, "confirm_count: type %d to confirm this batch", pp.needs)
	case fa.running:
		fa.mu.Unlock()
		return nil, fail(http.StatusConflict, "a batch is running; wait for it")
	}
	pp.used = true
	fa.running = true
	fa.mu.Unlock()
	started := false
	defer func() {
		if !started {
			fa.mu.Lock()
			fa.running = false
			fa.mu.Unlock()
		}
	}()
	if !fa.a.bucket.take() {
		return nil, fa.refuseApply(in.Token, hash, http.StatusTooManyRequests, "", "too many writes; wait a moment")
	}
	p, err := fa.plan(pp.req, now)
	if err != nil {
		return nil, fa.refuseApply(in.Token, hash, http.StatusConflict, "plan_changed", "the plan cannot be made again (%v); preview again", err)
	}
	if p.Hash != pp.hash {
		return nil, fa.refuseApply(in.Token, hash, http.StatusConflict, "plan_changed", "the fleet changed since the preview; preview again")
	}
	id := "b-" + now.UTC().Format("20060102-150405") + "-" + randHex(2)
	b := &batchRun{Batch: id, Op: p.Op, UndoOf: p.UndoOf, Status: "running", Started: now.UTC().Format(time.RFC3339)}
	for _, s := range p.Steps {
		res := batchResult{Slug: s.Slug, Name: s.Name, Command: s.Command, Result: "pending", Reason: s.Reason}
		switch s.Verdict {
		case fleet.Refuse:
			res.Result = "refused"
		case fleet.Queue:
			res.Result = "queued"
		}
		b.Results = append(b.Results, res)
	}
	fa.mu.Lock()
	fa.batches[id] = b
	fa.order = append(fa.order, id)
	if len(fa.order) > keepBatches {
		delete(fa.batches, fa.order[0])
		fa.order = fa.order[1:]
	}
	fa.mu.Unlock()
	started = true
	go fa.execute(b, p, in.Token)
	return map[string]any{"batch": id, "status": "running"}, nil
}

// execute runs a plan's steps in order, one audit line per project.
func (fa *FleetActions) execute(b *batchRun, p fleet.Plan, token string) {
	defer func() {
		fa.mu.Lock()
		fa.running = false
		fa.mu.Unlock()
		fa.f.col.Kick()
	}()
	line := func(s fleet.Step) fleet.AuditLine {
		return fleet.AuditLine{Actor: auditActor, Batch: b.Batch, Op: s.Op, Target: s.Slug, Args: s.Args, Command: s.Command,
			Text: p.Text, Preview: p.Hash, Confirm: token, Reason: s.Reason, Previous: s.Previous, UndoOf: p.UndoOf}
	}
	set := func(i int, f func(r *batchResult)) {
		fa.mu.Lock()
		f(&b.Results[i])
		fa.mu.Unlock()
	}
	fails, stopped := 0, false
	for i, s := range p.Steps {
		l := line(s)
		switch {
		case s.Verdict == fleet.Refuse:
			l.Result = "refused"
		case s.Verdict == fleet.Queue:
			l.Result = "queued"
			fa.mu.Lock()
			fa.queue = append(fa.queue, &queued{Slug: s.Slug, Name: s.Name, Batch: b.Batch, Text: p.Text, QueuedAt: time.Now().UTC().Format(time.RFC3339), Reason: s.Reason, preview: p.Hash, token: token})
			fa.mu.Unlock()
		case stopped:
			l.Result, l.Reason = "not-attempted", fmt.Sprintf("the batch stopped after %d failures in a row", breakerAfter)
			set(i, func(r *batchResult) { r.Result, r.Reason = l.Result, l.Reason })
		default:
			fa.mu.Lock()
			fa.recent = append(fa.recent, time.Now())
			fa.mu.Unlock()
			out, err := fa.act.Do(context.Background(), s, p.Text)
			if err != nil {
				fails++
				l.Result, l.Error = "failed", failed(err).Error
				set(i, func(r *batchResult) { r.Result, r.Error, r.Output = "failed", l.Error, out })
				if fails >= breakerAfter {
					stopped = true
				}
			} else {
				fails = 0
				l.Result, l.Output, l.Undo = "ok", out, s.UndoStep
				if s.Op == "message" {
					fa.mu.Lock()
					fa.lastBroadcast[s.Slug] = time.Now()
					fa.mu.Unlock()
				}
				set(i, func(r *batchResult) { r.Result, r.Output = "ok", out })
			}
		}
		if err := fa.audit.Append(time.Now(), l); err != nil {
			log.Printf("fleet audit: %v", err)
		}
	}
	fa.mu.Lock()
	b.Status = "done"
	if stopped {
		b.Status, b.Note = "stopped", fmt.Sprintf("circuit breaker: %d failures in a row; the rest was not attempted", breakerAfter)
	}
	for i, r := range b.Results {
		if r.Result == "ok" && p.Steps[i].UndoStep != nil {
			b.Undoable = true
		}
	}
	fa.mu.Unlock()
	log.Printf("fleet batch %s (%s): %s", b.Batch, p.Op, b.Status)
}

// sendNow delivers one queued broadcast once its coordinator is idle (no
// 60-second wait: the user asked for it), never into a busy one.
func (fa *FleetActions) sendNow(r *http.Request, body []byte) (any, error) {
	var in struct{ Slug, Batch string }
	if err := decode(body, &in); err != nil {
		return nil, err
	}
	pol := fa.f.policy.Load()
	if !pol.Enabled {
		return nil, fail(http.StatusForbidden, "bulk actions are off (fleet.toml enabled = false)")
	}
	fa.mu.Lock()
	idx := -1
	for i, q := range fa.queue {
		if q.Slug == in.Slug && q.Batch == in.Batch {
			idx = i
		}
	}
	if idx < 0 {
		fa.mu.Unlock()
		return nil, fail(http.StatusNotFound, "nothing queued for %s in %s", in.Slug, in.Batch)
	}
	q := *fa.queue[idx]
	used := fa.usedLocked(time.Now())
	fa.mu.Unlock()
	if used >= pol.Limits.ActionsPerMinute {
		return nil, fail(http.StatusTooManyRequests, "over the rate limit (%d actions a minute fleet-wide)", pol.Limits.ActionsPerMinute)
	}
	var t *fleet.Project
	for _, p := range fa.f.src.Projects() {
		if p.Slug == q.Slug {
			t = &p
			break
		}
	}
	switch {
	case t == nil:
		return nil, fail(http.StatusConflict, "%s is gone", q.Slug)
	case pol.Mode(q.Slug) != fleet.ModeFull:
		return nil, fail(http.StatusConflict, "%s is %s in fleet.toml now", q.Slug, pol.Mode(q.Slug))
	case t.Status != "active":
		return nil, fail(http.StatusConflict, "%s is %s", q.Slug, t.Status)
	case t.Coordinator.State != fleet.CoordIdle && t.Coordinator.State != fleet.CoordWaiting:
		return nil, fail(http.StatusConflict, "the coordinator is %s: a message is never typed into a busy agent", t.Coordinator.State)
	}
	if !fa.a.bucket.take() {
		return nil, fail(http.StatusTooManyRequests, "too many writes; wait a moment")
	}
	s := fleet.Step{Slug: q.Slug, Name: q.Name, Op: "message", Verdict: fleet.Will, Command: fleet.Command("message", q.Slug, nil)}
	fa.mu.Lock()
	fa.recent = append(fa.recent, time.Now())
	fa.mu.Unlock()
	out, err := fa.act.Do(r.Context(), s, q.Text)
	l := fleet.AuditLine{Actor: auditActor, Batch: q.Batch, Op: "message", Target: q.Slug, Command: s.Command, Text: q.Text, Preview: q.preview, Confirm: q.token, Reason: "sent from the queue"}
	if err != nil {
		l.Result, l.Error = "failed", failed(err).Error
	} else {
		l.Result, l.Output = "ok", out
	}
	if aerr := fa.audit.Append(time.Now(), l); aerr != nil {
		log.Printf("fleet audit: %v", aerr)
	}
	if err != nil {
		return nil, err
	}
	fa.mu.Lock()
	for i, x := range fa.queue {
		if x.Slug == q.Slug && x.Batch == q.Batch {
			fa.queue = append(fa.queue[:i], fa.queue[i+1:]...)
			break
		}
	}
	fa.lastBroadcast[q.Slug] = time.Now()
	fa.mu.Unlock()
	fa.f.col.Kick()
	return actionResult{OK: true, Output: out}, nil
}

func (fa *FleetActions) auditList(w http.ResponseWriter, r *http.Request) {
	lines, err := fa.audit.Read()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	q := r.URL.Query()
	limit := 500
	if n, err := fmt.Sscan(q.Get("limit"), &limit); n != 1 || err != nil || limit < 1 || limit > 5000 {
		limit = 500
	}
	match := func(l fleet.AuditLine) bool {
		for k, v := range map[string]string{"project": l.Target, "op": l.Op, "result": l.Result, "actor": l.Actor, "batch": l.Batch} {
			if want := q.Get(k); want != "" && want != v {
				return false
			}
		}
		if d := q.Get("day"); d != "" && !strings.HasPrefix(l.TS, d) {
			return false
		}
		return true
	}
	out := []fleet.AuditLine{}
	for i := len(lines) - 1; i >= 0 && len(out) < limit; i-- {
		if match(lines[i]) {
			out = append(out, lines[i])
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS > out[j].TS })
	writeJSON(w, map[string]any{"lines": out, "path": tildePath(fa.audit.Path)})
}

// hpActuator is today's fleet.Actuator: herdr-projects 0.2.35 subcommands
// (one at a time, under the same lock as every other Dash write) and
// fleet.toml for the priority flag.
type hpActuator struct {
	a      *Actions
	policy *fleet.PolicyFile
}

func (h hpActuator) Do(ctx context.Context, s fleet.Step, text string) (string, error) {
	if s.Op == "priority" {
		if len(s.Args) != 1 {
			return "", errors.New("priority needs true or false")
		}
		if err := h.policy.SetPriority(s.Slug, s.Args[0] == "true"); err != nil {
			return "", err
		}
		return "fleet.toml: " + s.Slug + " priority " + s.Args[0], nil
	}
	argv := fleet.Argv(s.Op, s.Slug, s.Args)
	if argv == nil {
		return "", fmt.Errorf("%s is not a herdr-projects action", s.Op)
	}
	stdin := ""
	if s.Op == "nudge" || s.Op == "message" {
		stdin = text
	}
	timeout := time.Minute
	if s.Op == "open" || s.Op == "sweep" {
		timeout = 3 * time.Minute
	}
	h.a.mu.Lock()
	defer h.a.mu.Unlock()
	return h.a.hpLocked(timeout, stdin, argv...)
}
