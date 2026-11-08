package main

// GET /api/fleet: the Master window's fleet table (internal/fleet), built
// from what the collector already holds. It runs no command: the snapshot
// and the System strip's last /proc frame are in memory, and fleet.toml is
// re-read only when it changes.

import (
	"net/http"
	"time"

	"github.com/0xArchiviste/herdr-dash/internal/fleet"
)

type Fleet struct {
	// queued lists the broadcasts waiting for a busy coordinator
	// (fleet_actions.go), served with the table.
	queued func() []queued
	col    *Collector
	src    fleet.Source
	policy *fleet.PolicyFile
	now    func() time.Time
}

func NewFleet(cfg Config, col *Collector) *Fleet {
	return &Fleet{col: col, src: collectorFleet{col}, policy: &fleet.PolicyFile{Path: cfg.FleetConfig}, now: time.Now}
}

func (f *Fleet) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/fleet", func(w http.ResponseWriter, r *http.Request) {
		var q []queued
		if f.queued != nil {
			q = f.queued()
		}
		if q == nil {
			q = []queued{}
		}
		writeJSON(w, struct {
			fleet.Table
			Queue []queued `json:"queue"`
		}{f.table(), q})
	})
}

func (f *Fleet) table() fleet.Table {
	pol := f.policy.Load()
	pol.Path = tildePath(pol.Path)
	return fleet.Build(f.src.Projects(), f.src.Usage(), pol, f.now())
}

// collectorFleet is the collector as a fleet.Source: today's adapter until
// the internal/projects read model serves the same facts.
type collectorFleet struct{ col *Collector }

var _ fleet.Source = collectorFleet{}

var coordStates = map[string]string{
	"working": fleet.CoordWorking, "idle": fleet.CoordIdle, "waiting": fleet.CoordWaiting,
	"blocked": fleet.CoordBlocked, "exited": fleet.CoordExited, "none": fleet.CoordMissing, "": fleet.CoordMissing,
}

func (c collectorFleet) Projects() []fleet.Project {
	snap := c.col.Snapshot()
	byProject := map[string][]fleet.Thread{}
	for _, t := range snap.Threads {
		ft := fleet.Thread{ID: t.ID, Title: t.Title, State: t.State, HasReport: t.hasReport, Acked: t.Acked, LastActivity: parseTime(t.LastActivity)}
		if l := t.Launch; l != nil {
			ft.Launch = &fleet.Launch{Stage: l.Stage, Attempt: l.Attempt, Error: l.Error, Since: parseTime(l.Since)}
		}
		byProject[t.Project] = append(byProject[t.Project], ft)
	}
	rss := map[string]uint64{}
	for _, pr := range c.col.sys.Frame().Procs {
		if pr.Kind == "leftover" {
			rss[pr.Project] += pr.RSS
		}
	}
	out := make([]fleet.Project, 0, len(snap.Projects))
	for _, p := range snap.Projects {
		st, ok := coordStates[p.Coordinator.State]
		if !ok {
			st = p.Coordinator.State
		}
		out = append(out, fleet.Project{
			Slug: p.Slug, Name: p.Name, Status: p.Status, Inbox: p.Inbox, Error: p.Error, Threads: byProject[p.Slug],
			Leftovers: p.Leftovers, LeftoverAgents: p.LeftoverAgents, LeftoverRSS: rss[p.Slug],
			Coordinator: fleet.Coordinator{State: st, Activity: p.Coordinator.Activity, LastActivity: parseTime(p.Coordinator.LastActivity), StateSince: parseTime(p.Coordinator.StateSince)},
		})
	}
	return out
}

// Usage sums the System strip's process rows of each project's coordinator
// and thread panes.
func (c collectorFleet) Usage() map[string]fleet.Usage {
	fr := c.col.sys.Frame()
	out := map[string]fleet.Usage{}
	for _, p := range fr.Procs {
		if p.Project == "" || (p.Kind != "coordinator" && p.Kind != "thread") {
			continue
		}
		u := out[p.Project]
		if p.CPU != nil {
			v := *p.CPU
			if u.CPU != nil {
				v += *u.CPU
			}
			u.CPU = &v
		}
		u.RSS += p.RSS
		u.Agents++
		out[p.Project] = u
	}
	return out
}
