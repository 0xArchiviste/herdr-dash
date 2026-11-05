package fleet

// Bulk actions (Master window, stage 1b): the dry-run plan.
//
// MakePlan turns a request (an op, its arguments, the selected projects)
// and the facts of the moment (World) into a Plan: per project the exact
// command, what it changes, its undo, or why it is refused or queued. The
// plan's hash binds a confirmation to exactly that plan: if the fleet
// changes before the apply, the recomputed plan hashes differently and the
// apply is refused.
//
// Executing a plan goes through an Actuator, one step per project. Today
// Dash's actuator runs herdr-projects 0.2.35 subcommands (and writes
// fleet.toml for the priority flag); the Go manager can implement the same
// interface natively later, and the plan, the audit and the API stay.
//
// There is deliberately no tier-3 op: no merge, resolve, delete, rename,
// archive, key press, safety or profile change, update, hibernate or sweep
// --yes. An unknown op is "not a fleet action".

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// OpSpec describes one op for the page.
type OpSpec struct {
	Op    string `json:"op"`
	Label string `json:"label"`
	Tier  int    `json:"tier"` // 0 always, 1 reversible and logged, 2 confirmed per batch
	Undo  bool   `json:"undo"` // records an undo
	Help  string `json:"help"`
}

// Ops is every action the Master window can take.
var Ops = []OpSpec{
	{"nudge", "Nudge", 0, false, "Send idle coordinators the fixed nudge line"},
	{"message", "Message…", 2, false, "Broadcast your message to idle coordinators; busy ones are queued"},
	{"open", "Open coordinator", 1, false, "Start missing or exited coordinators (herdr-projects open)"},
	{"pause", "Pause", 1, true, "Pause projects: the ticker skips them and thread start is refused"},
	{"resume", "Resume", 1, true, "Make paused projects active again"},
	{"set", "Set…", 1, true, "Change max_parallel_threads, nudge or mute; the previous value is kept for undo"},
	{"priority", "Priority…", 1, true, "Turn the priority flag in fleet.toml on or off"},
	{"sweep", "Sweep (dry run)", 0, false, "List what each project left behind; nothing is removed"},
}

func opSpec(op string) (OpSpec, bool) {
	for _, o := range Ops {
		if o.Op == op {
			return o, true
		}
	}
	return OpSpec{}, false
}

// SetKeys are the PROJECT.md settings a bulk set may change.
var SetKeys = []string{"max_parallel_threads", "nudge", "mute"}

// SettingDefaults are herdr-projects' defaults for SetKeys, the previous
// value when PROJECT.md does not name the key.
var SettingDefaults = map[string]string{"max_parallel_threads": "10", "nudge": "true", "mute": "false"}

const (
	// BroadcastPrefix starts every relayed message, so a coordinator can
	// tell the user's relayed instruction from data.
	BroadcastPrefix = "[fleet master, relaying the user]"
	// NudgeLine is the fixed nudge: no free text, nothing from reports.
	NudgeLine = "[fleet master] Nudge: read your inbox (herdr-projects context) and carry on with what is waiting."
	// QuietFor is how long a coordinator's state must be unchanged before
	// a message is typed into it (the ticker's own nudge condition).
	QuietFor     = 60 * time.Second
	MaxTextBytes = 4000
)

// Verdicts of a step.
const (
	Will   = "will"
	Queue  = "queue"
	Refuse = "refuse"
)

// Request is what the page asks to preview.
type Request struct {
	Op      string   `json:"op"`
	Targets []string `json:"targets"`
	Key     string   `json:"key,omitempty"`
	Value   string   `json:"value,omitempty"`
	Text    string   `json:"text,omitempty"`
	Batch   string   `json:"batch,omitempty"` // op undo: the batch to undo
}

// Target is what a plan needs to know of one project.
type Target struct {
	Slug        string
	Name        string
	Status      string // active, paused, archived
	Coordinator Coordinator
	Settings    map[string]string // current SetKeys values (defaults filled in)
	SettingsErr string
}

// UndoSource is a batch's audit, for op undo.
type UndoSource struct {
	Batch   string
	Lines   []AuditLine
	Undone  bool // an undo of it already ran
	Unknown bool // no such batch
}

// World is the facts of the moment.
type World struct {
	Now               time.Time
	Policy            Policy
	Projects          map[string]Target
	ActionsLastMinute int                  // executed steps fleet-wide in the last minute
	LastBroadcast     map[string]time.Time // by slug
	Queued            map[string]bool      // a broadcast waits for this coordinator
	Undo              *UndoSource
}

// Undo is the recorded inverse of one step.
type Undo struct {
	Op      string   `json:"op"`
	Args    []string `json:"args,omitempty"`
	Command string   `json:"command"`
}

// Step is one project's line of a plan.
type Step struct {
	Slug     string   `json:"slug"`
	Name     string   `json:"name"`
	Verdict  string   `json:"verdict"`
	Reason   string   `json:"reason,omitempty"`
	Op       string   `json:"op"` // what runs (an undo step runs the inverse op)
	Args     []string `json:"args,omitempty"`
	Command  string   `json:"command,omitempty"`
	Change   string   `json:"change,omitempty"`
	Undo     string   `json:"undo,omitempty"` // the undo's command, for display
	Previous string   `json:"previous,omitempty"`
	UndoStep *Undo    `json:"-"`
}

type Counts struct {
	Will   int `json:"will"`
	Queue  int `json:"queue"`
	Refuse int `json:"refuse"`
}

// Plan is a preview.
type Plan struct {
	Op            string `json:"op"`
	Tier          int    `json:"tier"`
	NeedsConfirm  bool   `json:"needs_confirm"`
	ConfirmReason string `json:"confirm_reason,omitempty"`
	ConfirmCount  int    `json:"confirm_count"` // what the user types for tier 2
	Key           string `json:"key,omitempty"`
	Value         string `json:"value,omitempty"`
	Text          string `json:"text,omitempty"` // exactly what is sent (message, nudge)
	UndoOf        string `json:"undo_of,omitempty"`
	Steps         []Step `json:"steps"`
	Counts        Counts `json:"counts"`
	Hash          string `json:"hash"`
}

// PlanError is a request that cannot be planned at all.
type PlanError struct {
	Status int // HTTP status
	Msg    string
}

func (e *PlanError) Error() string { return e.Msg }

func planErr(status int, format string, a ...any) error {
	return &PlanError{status, fmt.Sprintf(format, a...)}
}

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,80}$`)

// Argv is the herdr-projects argv (after --root) of op on slug; nil for an
// op that is not a herdr-projects command (priority).
func Argv(op, slug string, args []string) []string {
	switch op {
	case "nudge", "message":
		return []string{"coordinator", "prompt", slug, "--text-file", "-"}
	case "open", "pause", "resume":
		return []string{op, slug}
	case "set":
		return append([]string{"set", slug}, args...)
	case "sweep":
		return []string{"sweep", slug, "--dry-run"}
	}
	return nil
}

// Command is how a step is shown: the herdr-projects command line, or the
// fleet.toml change.
func Command(op, slug string, args []string) string {
	if op == "priority" {
		return fmt.Sprintf("fleet.toml: projects.%s.priority = %s", slug, args[0])
	}
	return "herdr-projects " + strings.Join(Argv(op, slug, args), " ")
}

func parseBool(v string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "on", "yes", "1":
		return "true", true
	case "false", "off", "no", "0":
		return "false", true
	}
	return "", false
}

// normalize checks the request's arguments; it returns the value to set.
func normalize(req *Request) error {
	switch req.Op {
	case "set":
		switch req.Key {
		case "max_parallel_threads":
			n, err := strconv.Atoi(strings.TrimSpace(req.Value))
			if err != nil || n < 1 || n > 1000 {
				return planErr(400, "max_parallel_threads must be a number from 1 to 1000")
			}
			req.Value = strconv.Itoa(n)
		case "nudge", "mute":
			v, ok := parseBool(req.Value)
			if !ok {
				return planErr(400, "%s must be true or false", req.Key)
			}
			req.Value = v
		default:
			return planErr(400, "set changes only %s, not %q", strings.Join(SetKeys, ", "), req.Key)
		}
	case "priority":
		v, ok := parseBool(req.Value)
		if !ok {
			return planErr(400, "priority must be true or false")
		}
		req.Value, req.Key = v, ""
	case "message":
		t := strings.TrimSpace(req.Text)
		if t == "" {
			return planErr(400, "the message is empty")
		}
		if len(req.Text) > MaxTextBytes {
			return planErr(400, "the message is longer than %d bytes", MaxTextBytes)
		}
		req.Text, req.Key, req.Value = t, "", ""
	default:
		req.Key, req.Value, req.Text = "", "", ""
	}
	return nil
}

// MakePlan builds the preview of req against w.
func MakePlan(req Request, w World) (Plan, error) {
	if req.Op == "undo" {
		return undoPlan(req, w)
	}
	spec, ok := opSpec(req.Op)
	if !ok {
		return Plan{}, planErr(400, "%q is not a fleet action", req.Op)
	}
	if err := normalize(&req); err != nil {
		return Plan{}, err
	}
	targets, err := targetsOf(req.Targets, w.Policy.Limits)
	if err != nil {
		return Plan{}, err
	}
	p := Plan{Op: req.Op, Tier: spec.Tier, Key: req.Key, Value: req.Value, Steps: []Step{}}
	switch req.Op {
	case "message":
		p.Text = BroadcastPrefix + " " + req.Text
	case "nudge":
		p.Text = NudgeLine
	}
	raises := false
	for _, slug := range targets {
		st := step(req, spec, slug, w)
		if req.Op == "set" && req.Key == "max_parallel_threads" && st.Verdict == Will {
			if prev, err := strconv.Atoi(st.Previous); err == nil {
				if n, _ := strconv.Atoi(req.Value); n > prev {
					raises = true
				}
			}
		}
		p.Steps = append(p.Steps, st)
	}
	if raises {
		p.Tier, p.ConfirmReason = 2, "raises max_parallel_threads"
	}
	finish(&p, w)
	return p, nil
}

func targetsOf(in []string, lim Limits) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, s := range in {
		if !slugRe.MatchString(s) {
			return nil, planErr(400, "bad project name %q", s)
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil, planErr(400, "select at least one project")
	}
	if len(out) > lim.BatchMax {
		return nil, planErr(400, "%d projects selected: at most %d per batch (fleet.toml limits.batch_max)", len(out), lim.BatchMax)
	}
	return out, nil
}

// finish applies the fleet-wide rate limit, counts, the tier escalation and
// the hash.
func finish(p *Plan, w World) {
	lim := w.Policy.Limits
	used := w.ActionsLastMinute
	for i := range p.Steps {
		s := &p.Steps[i]
		if s.Verdict != Will {
			continue
		}
		if used >= lim.ActionsPerMinute {
			s.Verdict = Refuse
			s.Reason = fmt.Sprintf("over the rate limit (%d actions a minute fleet-wide)", lim.ActionsPerMinute)
			continue
		}
		used++
	}
	for _, s := range p.Steps {
		switch s.Verdict {
		case Will:
			p.Counts.Will++
		case Queue:
			p.Counts.Queue++
		default:
			p.Counts.Refuse++
		}
	}
	p.ConfirmCount = p.Counts.Will + p.Counts.Queue
	if p.Tier == 1 && p.ConfirmCount > lim.BatchWithoutConfirm {
		p.Tier, p.ConfirmReason = 2, fmt.Sprintf("more than %d projects", lim.BatchWithoutConfirm)
	}
	if p.Tier == 2 && p.ConfirmReason == "" {
		p.ConfirmReason = "a message to coordinators is always confirmed"
	}
	p.NeedsConfirm = p.Tier == 2
	p.Hash = hashPlan(*p)
}

// hashPlan covers everything the user saw and nothing that moves on its
// own (no clock): op, arguments, the exact text, and each step's verdict,
// reason and command.
func hashPlan(p Plan) string {
	type hs struct{ Slug, Verdict, Reason, Op, Command, Change, Undo string }
	steps := make([]hs, len(p.Steps))
	for i, s := range p.Steps {
		steps[i] = hs{s.Slug, s.Verdict, s.Reason, s.Op, s.Command, s.Change, s.Undo}
	}
	b, _ := json.Marshal(struct {
		Op, Key, Value, Text, UndoOf string
		Tier                         int
		Steps                        []hs
	}{p.Op, p.Key, p.Value, p.Text, p.UndoOf, p.Tier, steps})
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func refuse(st Step, format string, a ...any) Step {
	st.Verdict, st.Reason = Refuse, fmt.Sprintf(format, a...)
	st.Command, st.Change, st.Undo, st.UndoStep = "", "", "", nil
	return st
}

func coordReady(c Coordinator, now time.Time) (ready bool, why string) {
	switch c.State {
	case CoordIdle, CoordWaiting:
		if c.StateSince.IsZero() || now.Sub(c.StateSince) < QuietFor {
			return false, "state changed under 60 s ago"
		}
		return true, ""
	case CoordMissing, CoordExited, "":
		return false, "no live coordinator"
	}
	return false, "busy: " + c.State
}

// step plans one project for a regular op.
func step(req Request, spec OpSpec, slug string, w World) Step {
	t, ok := w.Projects[slug]
	st := Step{Slug: slug, Name: slug, Op: req.Op}
	if !ok {
		return refuse(st, "no such project")
	}
	if t.Name != "" {
		st.Name = t.Name
	}
	switch w.Policy.Mode(slug) {
	case ModeOff:
		return refuse(st, "opted out of bulk actions (fleet.toml mode = off)")
	case ModeReadOnly:
		// The priority flag is the fleet's own setting, not an action on
		// the project; everything else above tier 0 is refused.
		if spec.Tier > 0 && req.Op != "priority" {
			return refuse(st, "read-only project (fleet.toml mode = read-only): reads and nudges only")
		}
	}
	switch req.Op {
	case "set":
		st.Args = []string{req.Key, req.Value}
	case "priority":
		st.Args = []string{req.Value}
	}
	st.Verdict = Will
	st.Command = Command(req.Op, slug, st.Args)
	inactive := func() (Step, bool) {
		if t.Status != "active" {
			return refuse(st, "project is %s", t.Status), true
		}
		return st, false
	}
	switch req.Op {
	case "nudge":
		if s, bad := inactive(); bad {
			return s
		}
		if ok, why := coordReady(t.Coordinator, w.Now); !ok {
			return refuse(st, "%s: a nudge is typed only into an idle coordinator", why)
		}
		st.Change = "types the nudge line into the idle coordinator"
	case "message":
		if s, bad := inactive(); bad {
			return s
		}
		if last, ok := w.LastBroadcast[slug]; ok && w.Now.Sub(last) < time.Duration(w.Policy.Limits.BroadcastCooldownMinutes)*time.Minute {
			return refuse(st, "cooldown: a broadcast reached it in the last %d min", w.Policy.Limits.BroadcastCooldownMinutes)
		}
		if w.Queued[slug] {
			return refuse(st, "a broadcast is already queued for it")
		}
		ready, why := coordReady(t.Coordinator, w.Now)
		switch {
		case ready:
			st.Change = "types the message into the idle coordinator"
		case why == "no live coordinator":
			return refuse(st, "no live coordinator (open it first)")
		default:
			st.Verdict, st.Reason = Queue, why+"; queued: send it from the queue once idle"
			st.Change = "waits in the queue"
		}
	case "open":
		if t.Status != "active" {
			return refuse(st, "project is %s", t.Status)
		}
		switch t.Coordinator.State {
		case CoordMissing, CoordExited, "":
			st.Change = "starts a coordinator (" + map[bool]string{true: "exited", false: "none running"}[t.Coordinator.State == CoordExited] + ")"
		default:
			return refuse(st, "coordinator already running (%s)", t.Coordinator.State)
		}
	case "pause":
		switch t.Status {
		case "paused":
			return refuse(st, "already paused")
		case "active":
		default:
			return refuse(st, "project is %s", t.Status)
		}
		st.Change = "active → paused"
		st.UndoStep = &Undo{Op: "resume", Command: Command("resume", slug, nil)}
	case "resume":
		switch t.Status {
		case "active":
			return refuse(st, "not paused")
		case "paused":
		default:
			return refuse(st, "project is %s", t.Status)
		}
		st.Change = "paused → active"
		st.UndoStep = &Undo{Op: "pause", Command: Command("pause", slug, nil)}
	case "set":
		if t.Status == "archived" {
			return refuse(st, "project is archived")
		}
		if t.SettingsErr != "" {
			return refuse(st, "%s", t.SettingsErr)
		}
		prev := t.Settings[req.Key]
		if prev == req.Value {
			return refuse(st, "%s is already %s", req.Key, prev)
		}
		st.Previous = prev
		st.Change = fmt.Sprintf("%s %s → %s", req.Key, prev, req.Value)
		args := []string{req.Key, prev}
		st.UndoStep = &Undo{Op: "set", Args: args, Command: Command("set", slug, args)}
	case "priority":
		cur := strconv.FormatBool(w.Policy.Priority[slug])
		if cur == req.Value {
			return refuse(st, "priority is already %s", map[string]string{"true": "on", "false": "off"}[cur])
		}
		st.Previous = cur
		st.Change = "priority " + cur + " → " + req.Value
		st.UndoStep = &Undo{Op: "priority", Args: []string{cur}, Command: Command("priority", slug, []string{cur})}
	case "sweep":
		st.Change = "lists leftovers; removes nothing"
	}
	if st.UndoStep != nil {
		st.Undo = st.UndoStep.Command
	}
	return st
}

// undoPlan is the recorded undo of a batch: per project the inverse op,
// refused when the project changed since (someone else's value would be
// overwritten).
func undoPlan(req Request, w World) (Plan, error) {
	u := w.Undo
	if u == nil || u.Unknown || req.Batch == "" {
		return Plan{}, planErr(404, "no batch %q in the audit log", req.Batch)
	}
	if u.Undone {
		return Plan{}, planErr(409, "batch %s was already undone", req.Batch)
	}
	p := Plan{Op: "undo", Tier: 1, UndoOf: req.Batch, Steps: []Step{}}
	for _, l := range u.Lines {
		if l.Result != "ok" || l.Undo == nil {
			continue
		}
		if len(p.Steps) >= w.Policy.Limits.BatchMax {
			break
		}
		inv := l.Undo
		spec, _ := opSpec(inv.Op)
		st := step(Request{Op: inv.Op, Key: first(inv.Args, 0), Value: last(inv.Args)}, spec, l.Target, w)
		st.Args = inv.Args
		if st.Verdict == Will || st.Verdict == Refuse && !strings.HasPrefix(st.Reason, "no such") && !strings.HasPrefix(st.Reason, "opted") && !strings.HasPrefix(st.Reason, "read-only") {
			if why := changedSince(l, w); why != "" {
				st = refuse(st, "changed since the batch: %s", why)
			}
		}
		if st.Verdict == Will {
			st.Command = inv.Command
		}
		// An undo is not undone in turn.
		st.UndoStep, st.Undo = nil, ""
		p.Steps = append(p.Steps, st)
	}
	if len(p.Steps) == 0 {
		return Plan{}, planErr(409, "batch %s has nothing to undo", req.Batch)
	}
	finish(&p, w)
	return p, nil
}

func first(a []string, i int) string {
	if len(a) > i+1 {
		return a[i]
	}
	return ""
}

func last(a []string) string {
	if len(a) == 0 {
		return ""
	}
	return a[len(a)-1]
}

// changedSince says how a project moved away from what the batch left.
func changedSince(l AuditLine, w World) string {
	t, ok := w.Projects[l.Target]
	if !ok {
		return "the project is gone"
	}
	switch l.Op {
	case "pause":
		if t.Status != "paused" {
			return "it is " + t.Status
		}
	case "resume":
		if t.Status != "active" {
			return "it is " + t.Status
		}
	case "set":
		if len(l.Args) == 2 {
			if t.SettingsErr != "" {
				return t.SettingsErr
			}
			if cur := t.Settings[l.Args[0]]; cur != l.Args[1] {
				return fmt.Sprintf("%s is now %s", l.Args[0], cur)
			}
		}
	case "priority":
		if len(l.Args) == 1 && strconv.FormatBool(w.Policy.Priority[l.Target]) != l.Args[0] {
			return "priority was changed again"
		}
	}
	return ""
}

// Actuator performs one step on one project. Dash's implementation runs
// herdr-projects; the Go manager's will act natively.
type Actuator interface {
	Do(ctx context.Context, s Step, text string) (output string, err error)
}
