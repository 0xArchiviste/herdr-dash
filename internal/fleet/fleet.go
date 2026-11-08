// Package fleet builds the Master window's fleet table: one row per
// project and a ranked Attention list, from facts a read model already has.
//
// The package does no I/O of its own beyond reading fleet.toml (policy.go).
// Its input is the Source interface: today Dash's collector implements it
// from the snapshot it already builds; the coming internal/projects read
// model (the Go port of herdr-projects) can implement it directly, and the
// table, the ranking and GET /api/fleet stay as they are.
package fleet

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Source is what the fleet table reads. Implementations must not run
// commands: Projects and Usage are served from memory.
type Source interface {
	// Projects lists every project the read model knows, in its order.
	Projects() []Project
	// Usage is CPU and memory of each project's agents, by slug (nil when
	// no process sampler runs).
	Usage() map[string]Usage
}

// Project is one project's facts.
type Project struct {
	Slug        string
	Name        string
	Status      string // active, paused, archived
	Inbox       int    // unhandled inbox items
	Coordinator Coordinator
	Threads     []Thread
	Error       string // the read model could not list it
	// Leftovers counts live panes of resolved threads and orphan agent
	// panes, LeftoverAgents those with an agent still in them (the rest
	// are shells); LeftoverRSS is their memory (0: not sampled).
	Leftovers      int
	LeftoverAgents int
	LeftoverRSS    uint64
}

// Coordinator states, as the table shows them.
const (
	CoordWorking = "working"
	CoordIdle    = "idle"
	CoordWaiting = "waiting" // waiting on you
	CoordBlocked = "blocked" // a prompt on its screen
	CoordExited  = "exited"  // its pane is there, the agent exited
	CoordMissing = "missing" // no live coordinator pane
)

type Coordinator struct {
	State        string
	Activity     string
	LastActivity time.Time
	// StateSince is when its live state last changed (the ticker's
	// pair_since); zero when unknown.
	StateSince time.Time
}

// Thread states (Dash's): working waiting blocked review landing idle
// resolved, and leftover (resolved, its agent still running: not open).
type Thread struct {
	ID           string
	Title        string
	State        string
	HasReport    bool // a report the user could acknowledge
	Acked        bool // the current report is acknowledged
	LastActivity time.Time
	Launch       *Launch // nil once launched (or resolved)
}

// Launch is a thread still in the launch pipeline.
type Launch struct {
	Stage   string // placing, queued, launching, briefing, stuck, failed
	Attempt int
	Error   string
	Since   time.Time
}

// Usage of one project's agents (coordinator and thread panes).
type Usage struct {
	CPU    *float64 // % of one core; nil while measuring
	RSS    uint64   // bytes
	Agents int      // panes with processes
}

// Stages counts open threads per stage. Threads still launching (queued,
// retrying, stuck or failed) count under Launching, not their group.
type Stages struct {
	Working   int `json:"working"`
	Waiting   int `json:"waiting"`
	Blocked   int `json:"blocked"`
	Review    int `json:"review"`
	Landing   int `json:"landing"`
	Idle      int `json:"idle"`
	Launching int `json:"launching"`
}

type RowCoordinator struct {
	State        string `json:"state"`
	Activity     string `json:"activity,omitempty"`
	LastActivity string `json:"last_activity,omitempty"`
	StateSince   string `json:"state_since,omitempty"`
}

type Launches struct {
	Failed int      `json:"failed"`
	Stuck  int      `json:"stuck"`
	Errors []string `json:"errors"` // distinct, most frequent first
}

// Row is one project in the table.
type Row struct {
	Slug          string         `json:"slug"`
	Name          string         `json:"name"`
	Status        string         `json:"status"`
	Coordinator   RowCoordinator `json:"coordinator"`
	Stages        Stages         `json:"stages"`
	Open          int            `json:"open"`
	NeedsYou      int            `json:"needs_you"` // threads waiting on you or blocked
	Unacked       int            `json:"unacked"`   // reports not acknowledged
	OldestUnacked string         `json:"oldest_unacked,omitempty"`
	Inbox         int            `json:"inbox"`
	Launches      Launches       `json:"launches"`
	Priority      bool           `json:"priority"`
	Mode          string         `json:"mode"` // full, read-only, off (fleet.toml)
	CPU           *float64       `json:"cpu"`
	RSS           uint64         `json:"rss"`
	Agents        int            `json:"agents"`
	LastActivity  string         `json:"last_activity"`
	Leftovers     int            `json:"leftovers"` // agents left running by resolved threads, and orphans
	Score         int            `json:"score"`     // its highest attention score, 0 for none
	Error         string         `json:"error,omitempty"`
}

// Attention kinds, highest first.
const (
	KindCoordBlocked   = "coordinator-blocked"
	KindCoordWaiting   = "coordinator-waiting"
	KindThreadsBlocked = "threads-blocked"
	KindThreadsWaiting = "threads-waiting"
	KindLaunchFailed   = "launch-failed"
	KindLaunchStuck    = "launch-stuck"
	KindCoordMissing   = "coordinator-missing"
	KindCoordExited    = "coordinator-exited"
	KindReviewPile     = "review-pile"
	KindLeftovers      = "leftovers"
)

// Base scores. The bands are far enough apart that the priority bonus moves
// a project up within its band (or just past the next one down), never past
// a blocked coordinator.
var base = map[string]int{
	KindCoordBlocked:   1000,
	KindCoordWaiting:   900,
	KindThreadsBlocked: 850,
	KindThreadsWaiting: 800,
	KindLaunchFailed:   700,
	KindLaunchStuck:    650,
	KindCoordMissing:   600,
	KindCoordExited:    550,
	KindReviewPile:     300,
	KindLeftovers:      250,
}

const (
	priorityBonus = 40
	// ReviewPileMin is the unacked report count that makes a review pile
	// worth the user's attention.
	ReviewPileMin = 10
)

// Item is one entry of the Attention list.
type Item struct {
	Slug  string `json:"slug"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Score int    `json:"score"`
	Text  string `json:"text"`
	Key   string `json:"key"`             // what a click opens: hub:<slug> or <slug>/<id>
	Since string `json:"since,omitempty"` // how long it has been so
	Count int    `json:"count"`
}

// Table is GET /api/fleet.
type Table struct {
	GeneratedAt string `json:"generated_at"`
	Rows        []Row  `json:"rows"`      // triage order: score, then name
	Attention   []Item `json:"attention"` // ranked
	Policy      Policy `json:"policy"`
	// Leftovers (orphan worktrees, merged branches) need `sweep --dry-run`,
	// a command per project: not in 1a.
	Leftovers *int `json:"leftovers"`
}

// Build makes the table. It reads nothing but its arguments.
func Build(projects []Project, usage map[string]Usage, pol Policy, now time.Time) Table {
	t := Table{GeneratedAt: now.UTC().Format(time.RFC3339), Rows: []Row{}, Attention: []Item{}, Policy: pol}
	for _, p := range projects {
		row, items := build(p, usage[p.Slug], pol.Priority[p.Slug])
		row.Mode = pol.Mode(p.Slug)
		t.Rows = append(t.Rows, row)
		t.Attention = append(t.Attention, items...)
	}
	sort.SliceStable(t.Attention, func(i, j int) bool {
		a, b := t.Attention[i], t.Attention[j]
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		if a.Since != b.Since && a.Since != "" && b.Since != "" {
			return a.Since < b.Since // older first
		}
		return a.Slug < b.Slug
	})
	sort.SliceStable(t.Rows, func(i, j int) bool {
		a, b := t.Rows[i], t.Rows[j]
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return t
}

func stamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func build(p Project, u Usage, prio bool) (Row, []Item) {
	r := Row{Slug: p.Slug, Name: p.Name, Status: p.Status, Inbox: p.Inbox, Priority: prio, Leftovers: p.Leftovers, CPU: u.CPU, RSS: u.RSS, Agents: u.Agents, Error: p.Error,
		Coordinator: RowCoordinator{State: p.Coordinator.State, Activity: p.Coordinator.Activity, LastActivity: stamp(p.Coordinator.LastActivity), StateSince: stamp(p.Coordinator.StateSince)},
		Launches:    Launches{Errors: []string{}}}
	if r.Name == "" {
		r.Name = p.Slug
	}
	if r.Coordinator.State == "" {
		r.Coordinator.State = CoordMissing
	}
	last := p.Coordinator.LastActivity
	var oldestUnacked, oldestWaiting, oldestBlocked, oldestFail, oldestStuck time.Time
	older := func(cur *time.Time, t time.Time) {
		if !t.IsZero() && (cur.IsZero() || t.Before(*cur)) {
			*cur = t
		}
	}
	errs := map[string]int{}
	for _, th := range p.Threads {
		if th.LastActivity.After(last) {
			last = th.LastActivity
		}
		if th.State == "resolved" || th.State == "leftover" {
			continue
		}
		r.Open++
		if th.HasReport && !th.Acked && (th.State == "review" || th.State == "landing") {
			r.Unacked++
			older(&oldestUnacked, th.LastActivity)
		}
		if l := th.Launch; l != nil {
			r.Stages.Launching++
			switch l.Stage {
			case "failed":
				r.Launches.Failed++
				older(&oldestFail, l.Since)
				e := l.Error
				if e == "" {
					e = "launch failed"
				}
				errs[e]++
			case "stuck":
				r.Launches.Stuck++
				older(&oldestStuck, l.Since)
			}
			continue
		}
		switch th.State {
		case "working":
			r.Stages.Working++
		case "waiting":
			r.Stages.Waiting++
			r.NeedsYou++
			older(&oldestWaiting, th.LastActivity)
		case "blocked":
			r.Stages.Blocked++
			r.NeedsYou++
			older(&oldestBlocked, th.LastActivity)
		case "review":
			r.Stages.Review++
		case "landing":
			r.Stages.Landing++
		default:
			r.Stages.Idle++
		}
	}
	r.LastActivity = stamp(last)
	r.OldestUnacked = stamp(oldestUnacked)
	for e := range errs {
		r.Launches.Errors = append(r.Launches.Errors, e)
	}
	sort.Slice(r.Launches.Errors, func(i, j int) bool {
		a, b := r.Launches.Errors[i], r.Launches.Errors[j]
		if errs[a] != errs[b] {
			return errs[a] > errs[b]
		}
		return a < b
	})

	var items []Item
	add := func(kind, text, key string, since time.Time, n int) {
		s := base[kind]
		if kind == KindReviewPile {
			s += min(n, 99)
		}
		if prio {
			s += priorityBonus
		}
		items = append(items, Item{Slug: p.Slug, Name: r.Name, Kind: kind, Score: s, Text: text, Key: key, Since: stamp(since), Count: n})
		r.Score = max(r.Score, s)
	}
	hub := "hub:" + p.Slug
	switch r.Coordinator.State {
	case CoordBlocked:
		add(KindCoordBlocked, "Coordinator blocked on a prompt", hub, p.Coordinator.LastActivity, 1)
	case CoordWaiting:
		add(KindCoordWaiting, "Coordinator waiting on you", hub, p.Coordinator.LastActivity, 1)
	}
	if r.Stages.Blocked > 0 {
		add(KindThreadsBlocked, plural(r.Stages.Blocked, "thread blocked", "threads blocked")+" on a prompt", hub, oldestBlocked, r.Stages.Blocked)
	}
	if r.Stages.Waiting > 0 {
		add(KindThreadsWaiting, plural(r.Stages.Waiting, "thread waiting", "threads waiting")+" on you", hub, oldestWaiting, r.Stages.Waiting)
	}
	if r.Launches.Failed > 0 {
		add(KindLaunchFailed, plural(r.Launches.Failed, "launch failed", "launches failed")+": "+strings.Join(r.Launches.Errors, "; "), hub, oldestFail, r.Launches.Failed)
	}
	if r.Launches.Stuck > 0 {
		add(KindLaunchStuck, plural(r.Launches.Stuck, "thread", "threads")+" stuck before the brief", hub, oldestStuck, r.Launches.Stuck)
	}
	// A project that is not active (paused, archived) needs no coordinator,
	// nor does one with no open thread.
	if p.Status == "active" && r.Open > 0 {
		switch r.Coordinator.State {
		case CoordMissing:
			add(KindCoordMissing, "No coordinator; "+plural(r.Open, "open thread", "open threads"), hub, time.Time{}, r.Open)
		case CoordExited:
			add(KindCoordExited, "Coordinator exited; "+plural(r.Open, "open thread", "open threads"), hub, p.Coordinator.LastActivity, r.Open)
		}
	}
	if r.Unacked >= ReviewPileMin {
		add(KindReviewPile, plural(r.Unacked, "unacked report", "unacked reports"), hub, oldestUnacked, r.Unacked)
	}
	// Agents left running after their threads were resolved hold memory.
	// Closing them is the user's call, pane by pane, in the project's
	// Threads view: never a bulk action here.
	if p.Leftovers > 0 {
		var parts []string
		if p.LeftoverAgents > 0 {
			parts = append(parts, plural(p.LeftoverAgents, "leftover agent", "leftover agents"))
		}
		if shells := p.Leftovers - p.LeftoverAgents; shells > 0 {
			parts = append(parts, plural(shells, "leftover pane", "leftover panes")+" (agent exited)")
		}
		text := strings.Join(parts, ", ")
		if p.LeftoverRSS > 0 {
			text += fmt.Sprintf(" · %.1f GB", float64(p.LeftoverRSS)/(1<<30))
		}
		add(KindLeftovers, text, hub, time.Time{}, p.Leftovers)
	}
	return r, items
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}
