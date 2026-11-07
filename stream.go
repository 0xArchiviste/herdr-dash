package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"
)

// The live stream is incremental. A page gets one snapshot when it connects
// and then a delta per change: the projects and threads that changed, were
// added or were removed, keyed by slug and key, each delta numbered (version)
// and naming the version it applies to (base). A page that sees a gap
// reconnects for a fresh snapshot.
//
// Resolved threads (most of them, on a long-running machine) stay out of the
// live snapshot: the projects' counts still include them, and a view that
// needs them asks /api/threads?state=resolved. A thread that becomes resolved
// still comes in a delta, so a page that loaded them keeps them current.
// /api/state is unchanged: every thread, with the version.

// streamState is what the last rebuild sent, per item, so the next one can
// tell what changed. Guarded by Collector.mu.
type streamState struct {
	version   uint64
	projects  map[string][]byte // slug -> JSON
	projOrder []string
	threads   map[string][]byte // key -> JSON
	thrOrder  []string
	resolved  map[string]bool   // key -> the thread is resolved
	thrProj   map[string]string // key -> project slug
	errors    []byte
	prs       bool
}

// streamMsg is one delta, already marshalled.
type streamMsg struct {
	version, base uint64
	data          []byte
}

type deltaMsg struct {
	Version         uint64            `json:"version"`
	Base            uint64            `json:"base"`
	GeneratedAt     string            `json:"generated_at"`
	Projects        []json.RawMessage `json:"projects,omitempty"`
	ProjectsRemoved []string          `json:"projects_removed,omitempty"`
	ProjectOrder    []string          `json:"project_order,omitempty"`
	Threads         []json.RawMessage `json:"threads,omitempty"`
	ThreadsRemoved  []string          `json:"threads_removed,omitempty"`
	Errors          json.RawMessage   `json:"errors,omitempty"`
	PRsChecked      *bool             `json:"prs_checked,omitempty"`
}

// diffStream compares snap with what was last sent. It returns the delta's
// body (version and base still unset) and whether anything changed, and
// records snap as sent. c.mu must be held.
func (c *Collector) diffStream(snap *Snapshot) (deltaMsg, bool) {
	st := &c.stream
	first := st.projects == nil
	d := deltaMsg{}
	projects := make(map[string][]byte, len(snap.Projects))
	order := make([]string, 0, len(snap.Projects))
	for _, p := range snap.Projects {
		b, _ := json.Marshal(p)
		projects[p.Slug] = b
		order = append(order, p.Slug)
		if !bytes.Equal(st.projects[p.Slug], b) {
			d.Projects = append(d.Projects, b)
		}
	}
	for _, slug := range st.projOrder {
		if _, ok := projects[slug]; !ok {
			d.ProjectsRemoved = append(d.ProjectsRemoved, slug)
		}
	}
	if !equalStrings(order, st.projOrder) {
		d.ProjectOrder = order
	}
	threads := make(map[string][]byte, len(snap.Threads))
	resolved := make(map[string]bool, len(snap.Threads))
	thrProj := make(map[string]string, len(snap.Threads))
	thrOrder := make([]string, 0, len(snap.Threads))
	for _, t := range snap.Threads {
		b, _ := json.Marshal(t)
		threads[t.Key] = b
		thrOrder = append(thrOrder, t.Key)
		thrProj[t.Key] = t.Project
		if t.State == "resolved" {
			resolved[t.Key] = true
		}
		if !bytes.Equal(st.threads[t.Key], b) {
			d.Threads = append(d.Threads, b)
		}
	}
	for _, k := range st.thrOrder {
		if _, ok := threads[k]; !ok {
			d.ThreadsRemoved = append(d.ThreadsRemoved, k)
		}
	}
	errs, _ := json.Marshal(snap.Errors)
	if !bytes.Equal(errs, st.errors) {
		d.Errors = errs
	}
	if snap.PRsChecked != st.prs {
		v := snap.PRsChecked
		d.PRsChecked = &v
	}
	changed := first || len(d.Projects) > 0 || len(d.ProjectsRemoved) > 0 || d.ProjectOrder != nil ||
		len(d.Threads) > 0 || len(d.ThreadsRemoved) > 0 || d.Errors != nil || d.PRsChecked != nil
	if changed {
		st.projects, st.projOrder, st.threads, st.thrOrder = projects, order, threads, thrOrder
		st.resolved, st.thrProj, st.errors, st.prs = resolved, thrProj, errs, snap.PRsChecked
	}
	return d, changed
}

// publish numbers d and hands it to every subscriber. A subscriber whose
// buffer is full misses it and is told to resync. c.mu must be held.
func (c *Collector) publish(d deltaMsg) {
	c.stream.version++
	d.Base, d.Version = c.stream.version-1, c.stream.version
	b, _ := json.Marshal(d)
	m := streamMsg{version: d.Version, base: d.Base, data: b}
	for s := range c.subs {
		select {
		case s.Delta <- m:
		default:
			select {
			case s.Resync <- struct{}{}:
			default:
			}
		}
	}
}

// liveSnapshot is the stream's first event: every project and every thread
// that is not resolved, at the current version. c.mu must be held.
func (c *Collector) liveSnapshot() ([]byte, uint64) {
	st := &c.stream
	var buf bytes.Buffer
	head, _ := json.Marshal(struct {
		Build       string `json:"build"`
		GeneratedAt string `json:"generated_at"`
		Version     uint64 `json:"version"`
		PRsChecked  bool   `json:"prs_checked"`
	}{c.cfg.Build, c.snap.GeneratedAt, st.version, st.prs})
	buf.Write(head[:len(head)-1])
	buf.WriteString(`,"resolved_omitted":true,"projects":[`)
	for i, slug := range st.projOrder {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(st.projects[slug])
	}
	buf.WriteString(`],"threads":[`)
	n := 0
	for _, k := range st.thrOrder {
		if st.resolved[k] {
			continue
		}
		if n > 0 {
			buf.WriteByte(',')
		}
		buf.Write(st.threads[k])
		n++
	}
	buf.WriteString(`],"errors":`)
	if st.errors == nil {
		buf.WriteString("[]")
	} else {
		buf.Write(st.errors)
	}
	buf.WriteByte('}')
	return buf.Bytes(), st.version
}

// SubscribeLive registers a stream and returns its first snapshot, taken
// under the same lock so the first delta it receives follows it.
func (c *Collector) SubscribeLive() (*Sub, []byte, uint64) {
	s := newSub()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.subs[s] = struct{}{}
	b, v := c.liveSnapshot()
	return s, b, v
}

// LiveSnapshot is a fresh first event, for a stream that has to resync.
func (c *Collector) LiveSnapshot() ([]byte, uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.liveSnapshot()
}

// Resolved is the resolved threads (of one project, or all when slug is
// empty) as a JSON array, with the version they are current at.
func (c *Collector) Resolved(slug string) ([]byte, uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := &c.stream
	var buf bytes.Buffer
	buf.WriteByte('[')
	n := 0
	for _, k := range st.thrOrder {
		if !st.resolved[k] || (slug != "" && st.thrProj[k] != slug) {
			continue
		}
		if n > 0 {
			buf.WriteByte(',')
		}
		buf.Write(st.threads[k])
		n++
	}
	buf.WriteByte(']')
	return buf.Bytes(), st.version
}

// resolvedHTTP serves GET /api/threads?state=resolved[&project=slug].
func resolvedHTTP(col *Collector) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("state") != "resolved" {
			http.Error(w, "state must be resolved", http.StatusBadRequest)
			return
		}
		slug := q.Get("project")
		if slug != "" && !slugRe.MatchString(slug) {
			http.Error(w, "bad project", http.StatusBadRequest)
			return
		}
		list, v := col.Resolved(slug)
		writeJSON(w, struct {
			Version uint64          `json:"version"`
			Threads json.RawMessage `json:"threads"`
		}{v, list})
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }
