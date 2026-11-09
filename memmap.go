package main

// The Memory map's server half: every process on the machine with its
// memory, CPU, age and cwd, attributed to the herdr pane (thread,
// coordinator, leftover) it runs in or left outside ("Not herdr"), plus the
// machine's totals, memory pressure (PSI) and the herdr server's cgroup
// against its MemoryHigh / MemoryMax.
//
// It rides on the System strip's sampler (sysstat.go): the same /proc walk,
// the same HERDR_PANE_ID mapping. While a Memory map is open ("detail"),
// that walk also reads the stat file of processes outside herdr panes, and
// each process's cwd and cgroup once. smaps_rollup (PSS: shared pages split
// between the processes that map them) is read at most every --pss-every,
// as the kernel walks the page tables to answer it. With no Memory map open
// none of this runs.
//
// The page gets the whole frame when it opens the map's stream, then only
// what changed (memDiff). History, per owner and per project, comes from the
// strip's own per-pane RSS sums, so it builds up whenever any page is open:
// a bounded ring in memory, never on disk.

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

// MemOpts are the Memory map's settings (flags).
type MemOpts struct {
	Cgroup    string        // cgroup v2 root, "" when unknown
	PSSEvery  time.Duration // smaps_rollup at most this often
	HistEvery time.Duration // one history point per owner this often
}

const histPoints = 120 // history window: histPoints × HistEvery (30 min at 15 s)

type memState struct {
	opts      MemOpts
	btime     uint64            // boot time, unix seconds
	info      map[string]uint64 // the last meminfo
	samples   uint64            // detail samples
	pssPasses uint64
	pssAt     time.Time
	pssBusy   bool // a pass is running (pssPass)
	pssCost   time.Duration
	hist      map[string]*memSeries
	histAt    time.Time
}

type memPoint struct {
	At  int64  `json:"t"` // unix seconds
	RSS uint64 `json:"v"`
}

type memSeries struct {
	kind, project, thread string
	pts                   []memPoint
}

// MemFrame is the Memory map's whole picture.
type MemFrame struct {
	Head   MemHead    `json:"head"`
	Owners []MemOwner `json:"owners"`
	Procs  []MemProc  `json:"procs"`
	At     string     `json:"at"`
}

// MemHead is the machine: totals, pressure, cgroup, how memory is measured.
type MemHead struct {
	Available bool       `json:"available"`
	Reason    string     `json:"reason,omitempty"`
	WSL       bool       `json:"wsl"`
	Total     uint64     `json:"total"`
	Used      uint64     `json:"used"`
	Avail     uint64     `json:"avail"`
	Cache     uint64     `json:"cache"` // page cache + buffers + reclaimable slab
	Shmem     uint64     `json:"shmem"`
	SwapTotal uint64     `json:"swap_total"`
	SwapUsed  uint64     `json:"swap_used"`
	PSI       *MemPSI    `json:"psi"`
	Cgroup    *MemCgroup `json:"cgroup"`
	PSS       bool       `json:"pss"`       // smaps_rollup was read for some processes
	PSSEvery  float64    `json:"pss_every"` // the cost of a pass is in /api/system/stats (pss_ms)
	Every     float64    `json:"every"`
}

// MemPSI is /proc/pressure/memory: % of time some (full) tasks stalled.
type MemPSI struct {
	Some [3]float64 `json:"some"` // avg10, avg60, avg300
	Full [3]float64 `json:"full"`
}

// MemCgroup is the cgroup herdr's panes run in (the herdr server's unit).
type MemCgroup struct {
	Path    string            `json:"path"`
	Name    string            `json:"name"`
	Current uint64            `json:"current"`
	High    uint64            `json:"high"` // 0: no limit
	Max     uint64            `json:"max"`  // 0: no limit
	Peak    uint64            `json:"peak,omitempty"`
	Events  map[string]uint64 `json:"events,omitempty"`
}

// MemOwner is what a group of processes belongs to (a SysProc's identity).
type MemOwner struct {
	Tag     string `json:"tag"` // "dash", "voice", "pane:<id>"
	Key     string `json:"key"`
	Kind    string `json:"kind"` // thread, coordinator, leftover, pane, dash, voice
	Project string `json:"project,omitempty"`
	Thread  string `json:"thread,omitempty"`
	Pane    string `json:"pane,omitempty"`
	Agent   string `json:"agent,omitempty"`
	Exited  bool   `json:"exited,omitempty"`
}

// MemProc is one process.
type MemProc struct {
	ID    string   `json:"id"` // pid:starttime, so a reused pid is another process
	PID   int      `json:"pid"`
	PPID  int      `json:"ppid"`
	Comm  string   `json:"comm"`
	RSS   uint64   `json:"rss"`
	PSS   uint64   `json:"pss,omitempty"` // 0: not read
	CPU   *float64 `json:"cpu"`           // % of one core; nil while measuring
	Start int64    `json:"start"`         // unix seconds
	Cwd   string   `json:"cwd,omitempty"`
	Tag   string   `json:"tag,omitempty"` // its owner; "" outside herdr panes
}

// detail reads a process's cwd and cgroup, once.
func (m *SysMon) detail(pid int, e *procEntry) {
	e.detailed = true
	dir := filepath.Join(m.dir, strconv.Itoa(pid))
	e.cwd, _ = os.Readlink(filepath.Join(dir, "cwd"))
	if strings.HasPrefix(e.tag, "pane:") {
		b, _ := os.ReadFile(filepath.Join(dir, "cgroup"))
		for _, line := range strings.Split(string(b), "\n") {
			if p, ok := strings.CutPrefix(line, "0::"); ok {
				e.cgroup = strings.TrimSpace(p)
			}
		}
	}
}

// readPSS reads Pss from smaps_rollup: 0 when it cannot (another user's
// process, an old kernel).
func (m *SysMon) readPSS(pid int) uint64 {
	b, err := os.ReadFile(m.dir + "/" + strconv.Itoa(pid) + "/smaps_rollup")
	if err != nil {
		return 0
	}
	i := bytes.Index(b, []byte("\nPss:"))
	if i < 0 {
		return 0
	}
	line, _, _ := bytes.Cut(b[i+5:], []byte("\n"))
	n, _ := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(string(line)), " kB"), 10, 64)
	return n * 1024
}

// pssPass reads smaps_rollup for the given processes outside m.mu: the
// kernel walks each one's page tables, which takes a second or more on a
// busy machine, and the pane tick must not wait for it. The results land in
// the next frame.
func (m *SysMon) pssPass(todo map[int]uint64) {
	t0 := time.Now()
	got := make(map[int]uint64, len(todo))
	for pid := range todo {
		got[pid] = m.readPSS(pid)
	}
	cost := time.Since(t0)
	m.mu.Lock()
	defer m.mu.Unlock()
	for pid, v := range got {
		if e := m.procs[pid]; e != nil && e.start == todo[pid] {
			e.pss = v
		}
	}
	m.mem.pssCost, m.mem.pssBusy = cost, false
	m.mem.pssPasses++
}

func (m *SysMon) readPSI() *MemPSI {
	b, err := os.ReadFile(filepath.Join(m.dir, "pressure/memory"))
	if err != nil {
		return nil
	}
	p := &MemPSI{}
	for _, line := range strings.Split(string(b), "\n") {
		fs := strings.Fields(line)
		if len(fs) < 4 {
			continue
		}
		var dst *[3]float64
		switch fs[0] {
		case "some":
			dst = &p.Some
		case "full":
			dst = &p.Full
		default:
			continue
		}
		for i, k := range []string{"avg10=", "avg60=", "avg300="} {
			for _, f := range fs[1:] {
				if v, ok := strings.CutPrefix(f, k); ok {
					dst[i], _ = strconv.ParseFloat(v, 64)
				}
			}
		}
	}
	return p
}

// readCgroup reads the memory files of the cgroup most pane processes run in.
func (m *SysMon) readCgroup() *MemCgroup {
	root := m.mem.opts.Cgroup
	if root == "" {
		return nil
	}
	count := map[string]int{}
	for _, e := range m.procs {
		if e.cgroup != "" && e.seen == m.samples {
			count[e.cgroup]++
		}
	}
	best, n := "", 0
	for p, c := range count {
		if c > n || (c == n && p < best) {
			best, n = p, c
		}
	}
	if best == "" || best == "/" {
		return nil
	}
	dir := filepath.Join(root, filepath.FromSlash(best))
	num := func(name string) (uint64, bool) {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return 0, false
		}
		s := strings.TrimSpace(string(b))
		if s == "max" {
			return 0, true
		}
		v, err := strconv.ParseUint(s, 10, 64)
		return v, err == nil
	}
	cur, ok := num("memory.current")
	if !ok {
		return nil
	}
	c := &MemCgroup{Path: best, Name: path.Base(best), Current: cur}
	c.High, _ = num("memory.high")
	c.Max, _ = num("memory.max")
	c.Peak, _ = num("memory.peak")
	if b, err := os.ReadFile(filepath.Join(dir, "memory.events")); err == nil {
		c.Events = map[string]uint64{}
		for _, line := range strings.Split(string(b), "\n") {
			if k, v, ok := strings.Cut(strings.TrimSpace(line), " "); ok {
				c.Events[k], _ = strconv.ParseUint(v, 10, 64)
			}
		}
	}
	return c
}

// memFrame builds the Memory map's frame from the sample just taken.
func (m *SysMon) memFrame(owners map[string]paneOwner, f SysFrame, now time.Time) *MemFrame {
	m.mem.samples++
	o := m.mem.opts
	if o.PSSEvery > 0 && now.Sub(m.mem.pssAt) >= o.PSSEvery && !m.mem.pssBusy {
		m.mem.pssAt, m.mem.pssBusy = now, true
		todo := map[int]uint64{} // pid -> starttime
		for pid, e := range m.procs {
			if e.seen == m.samples && e.rss > 0 {
				todo[pid] = e.start
			}
		}
		go m.pssPass(todo)
	}
	v := m.mem.info
	h := MemHead{Available: true, WSL: m.wsl, PSSEvery: o.PSSEvery.Seconds(), Every: m.every.Seconds()}
	if f.Mem != nil {
		h.Total, h.Used = f.Mem.Total, f.Mem.Used
		h.Avail = f.Mem.Total - f.Mem.Used
	}
	if f.Swap != nil {
		h.SwapTotal, h.SwapUsed = f.Swap.Total, f.Swap.Used
	}
	h.Cache = v["Cached"] + v["Buffers"] + v["SReclaimable"]
	h.Shmem = v["Shmem"]
	h.PSI = m.readPSI()
	h.Cgroup = m.readCgroup()

	out := &MemFrame{Head: h, Procs: []MemProc{}, Owners: []MemOwner{}, At: now.UTC().Format(time.RFC3339)}
	tags := map[string]bool{}
	for pid, e := range m.procs {
		if e.seen != m.samples || e.at != now || e.rss == 0 {
			continue // gone, not read this time, or a kernel thread
		}
		p := MemProc{ID: strconv.Itoa(pid) + ":" + strconv.FormatUint(e.start, 10), PID: pid, PPID: e.ppid, Comm: e.comm, RSS: e.rss, PSS: e.pss,
			Start: int64(m.mem.btime + e.start/userHZ), Cwd: e.cwd, Tag: e.tag}
		if e.pss > 0 {
			out.Head.PSS = true
		}
		if e.cpu >= 0 {
			c := math.Round(e.cpu)
			p.CPU = &c
		}
		out.Procs = append(out.Procs, p)
		if e.tag != "" {
			tags[e.tag] = true
		}
	}
	sort.Slice(out.Procs, func(i, j int) bool { return out.Procs[i].PID < out.Procs[j].PID })
	for t := range tags {
		d := m.describe(t, owners)
		out.Owners = append(out.Owners, MemOwner{Tag: t, Key: d.Key, Kind: d.Kind, Project: d.Project, Thread: d.Thread, Pane: d.Pane, Agent: d.Agent, Exited: d.Exited})
	}
	sort.Slice(out.Owners, func(i, j int) bool { return out.Owners[i].Tag < out.Owners[j].Tag })
	return out
}

// MemDelta is what changed between two frames; empty when nothing did.
type MemDelta struct {
	Head   *MemHead   `json:"head,omitempty"`
	Owners []MemOwner `json:"owners,omitempty"` // all of them, when any changed
	Up     []MemProc  `json:"up,omitempty"`     // new or changed processes
	Gone   []string   `json:"gone,omitempty"`   // ids
	At     string     `json:"at"`
}

func (d *MemDelta) empty() bool {
	return d.Head == nil && d.Owners == nil && len(d.Up) == 0 && len(d.Gone) == 0
}

func memDiff(a, b *MemFrame) *MemDelta {
	d := &MemDelta{At: b.At}
	if !reflect.DeepEqual(a.Head, b.Head) {
		h := b.Head
		d.Head = &h
	}
	if !reflect.DeepEqual(a.Owners, b.Owners) {
		d.Owners = b.Owners
	}
	old := make(map[string]*MemProc, len(a.Procs))
	for i := range a.Procs {
		old[a.Procs[i].ID] = &a.Procs[i]
	}
	for i := range b.Procs {
		p := &b.Procs[i]
		if q, ok := old[p.ID]; !ok || !reflect.DeepEqual(*q, *p) {
			d.Up = append(d.Up, *p)
		}
		delete(old, p.ID)
	}
	for id := range old {
		d.Gone = append(d.Gone, id)
	}
	sort.Strings(d.Gone)
	return d
}

// ---------------------------------------------------------------- history

// record adds a history point per owner and per project from the strip's
// per-pane RSS sums, at most every HistEvery, and drops series that left
// the window.
func (m *SysMon) record(procs []SysProc, now time.Time) {
	every := m.mem.opts.HistEvery
	if every <= 0 || now.Sub(m.mem.histAt) < every {
		return
	}
	m.mem.histAt = now
	t := now.Unix()
	add := func(key, kind, project, thread string, v uint64) {
		s := m.mem.hist[key]
		if s == nil {
			s = &memSeries{}
			m.mem.hist[key] = s
		}
		s.kind, s.project, s.thread = kind, project, thread
		if n := len(s.pts); n > 0 && s.pts[n-1].At == t {
			s.pts[n-1].RSS += v
			return
		}
		s.pts = append(s.pts, memPoint{t, v})
		if len(s.pts) > histPoints {
			s.pts = append(s.pts[:0:0], s.pts[len(s.pts)-histPoints:]...)
		}
	}
	proj := map[string]uint64{}
	for _, p := range procs {
		add(p.Key, p.Kind, p.Project, p.Thread, p.RSS)
		if p.Project != "" {
			proj[p.Project] += p.RSS
		}
	}
	for slug, v := range proj {
		add("proj:"+slug, "project", slug, "", v)
	}
	cut := t - int64(histPoints*every/time.Second)
	for k, s := range m.mem.hist {
		if s.pts[len(s.pts)-1].At < cut {
			delete(m.mem.hist, k)
		}
	}
}

// MemHistory is the history the Memory map shows: a series per project and
// the owners that grew most within the window.
type MemHistory struct {
	Every    float64               `json:"every"`  // seconds between points
	Window   float64               `json:"window"` // seconds
	Projects map[string][]memPoint `json:"projects"`
	Growers  []MemGrower           `json:"growers"`
}

type MemGrower struct {
	Key     string  `json:"key"`
	Kind    string  `json:"kind"`
	Project string  `json:"project,omitempty"`
	Thread  string  `json:"thread,omitempty"`
	From    uint64  `json:"from"`
	To      uint64  `json:"to"`
	Delta   int64   `json:"delta"`
	Over    float64 `json:"over"` // seconds between the two points
}

func (m *SysMon) History() MemHistory {
	m.mu.Lock()
	defer m.mu.Unlock()
	every := m.mem.opts.HistEvery
	h := MemHistory{Every: every.Seconds(), Window: (time.Duration(histPoints) * every).Seconds(), Projects: map[string][]memPoint{}, Growers: []MemGrower{}}
	last := m.mem.histAt.Unix()
	for k, s := range m.mem.hist {
		if s.kind == "project" {
			h.Projects[s.project] = append([]memPoint(nil), s.pts...)
			continue
		}
		n := len(s.pts)
		if n < 2 || s.pts[n-1].At != last {
			continue // gone now, or a single point
		}
		a, b := s.pts[0], s.pts[n-1]
		if b.RSS > a.RSS {
			h.Growers = append(h.Growers, MemGrower{Key: k, Kind: s.kind, Project: s.project, Thread: s.thread, From: a.RSS, To: b.RSS, Delta: int64(b.RSS - a.RSS), Over: float64(b.At - a.At)})
		}
	}
	sort.Slice(h.Growers, func(i, j int) bool {
		if h.Growers[i].Delta != h.Growers[j].Delta {
			return h.Growers[i].Delta > h.Growers[j].Delta
		}
		return h.Growers[i].Key < h.Growers[j].Key
	})
	if len(h.Growers) > 10 {
		h.Growers = h.Growers[:10]
	}
	return h
}

// MemFrameNow is the last Memory map frame, nil when none was taken lately.
func (c *Collector) MemFrameNow() *MemFrame {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.memLast
}

func memJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
