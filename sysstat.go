package main

// The System strip's server half: machine CPU, memory, swap and load, and
// the CPU and RSS of every process that runs in a herdr pane, summed per
// pane and named after the thread or coordinator in it.
//
// Everything is read from /proc; no process is started. A process belongs
// to a pane when its environment carries HERDR_PANE_ID (herdr sets it in
// the pane's shell; every child inherits it). Dash marks its own children
// with HERDR_DASH_ROLE=<role>:<pid>, so its helpers and the voice sidecar
// get rows of their own. The environment is read once per process; after
// that each tick reads one stat file per pane process and skips the rest.
//
// Samples run on the collector's pane tick, and only while some page holds
// the event stream open (pages close it while hidden). A frame is sent only
// when it differs from the last one.

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const userHZ = 100 // USER_HZ: clock ticks a second in /proc on every Linux arch

// dashRoleEnv marks Dash's own children: "dash:<pid>" or "voice:<pid>".
const dashRoleEnv = "HERDR_DASH_ROLE"

// SysFrame is one sample, as /api/system and the `system` event send it.
type SysFrame struct {
	Available bool      `json:"available"`
	Reason    string    `json:"reason,omitempty"`
	WSL       bool      `json:"wsl"`
	NCPU      int       `json:"ncpu"`
	CPU       *SysCPU   `json:"cpu"` // nil until two samples
	Mem       *SysMem   `json:"mem"`
	Swap      *SysMem   `json:"swap"`
	Load      []float64 `json:"load"`
	Procs     []SysProc `json:"procs"`
	Every     float64   `json:"every"` // seconds between samples
	At        string    `json:"at"`
}

type SysCPU struct {
	Pct   float64   `json:"pct"`   // of all cores
	Cores []float64 `json:"cores"` // each of one core
}

type SysMem struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

// SysProc is the processes of one pane (or Dash, or the voice sidecar).
type SysProc struct {
	Key     string   `json:"key"`  // thread key, hub:<slug>, pane:<id>, dash, voice
	Kind    string   `json:"kind"` // thread, coordinator, pane, dash, voice
	Project string   `json:"project,omitempty"`
	Thread  string   `json:"thread,omitempty"`
	Pane    string   `json:"pane,omitempty"`
	Agent   string   `json:"agent,omitempty"`
	Exited  bool     `json:"exited,omitempty"` // the pane's agent exited
	Top     string   `json:"top"`              // name of its busiest process
	CPU     *float64 `json:"cpu"`              // % of one core; nil while measuring
	RSS     uint64   `json:"rss"`              // bytes, summed (shared pages count twice)
	N       int      `json:"n"`                // processes
}

// paneOwner names what runs in a pane, from the last snapshot.
type paneOwner struct {
	key, kind, project, thread, agent string
	exited                            bool // its agent exited; a shell is left
}

type procEntry struct {
	start uint64 // starttime: a reused pid gets a new one
	tag   string // "" (not ours), "dash", "voice", "pane:<id>"
	comm  string
	ticks uint64
	rss   uint64
	at    time.Time // when ticks was read
	seen  uint64    // sample number it was last listed in
	// The Memory map's extras (memmap.go), read only while one is open.
	ppid     int
	cpu      float64 // % of one core over the last sample; -1 unknown
	pss      uint64  // bytes, from smaps_rollup; 0 when unreadable
	cwd      string
	cgroup   string // cgroup v2 path of a pane process
	detailed bool   // cwd and cgroup read
}

type cpuTimes struct{ busy, total uint64 }

type SysMon struct {
	dir   string // "" when off
	why   string // why it is off or unavailable
	self  int
	page  uint64
	every time.Duration
	wsl   bool

	mu       sync.Mutex
	buf      [1024]byte // stat reads, under mu
	procs    map[int]*procEntry
	cpu      []cpuTimes // [0] all, then each core
	cpuAt    time.Time
	last     time.Time // last sample
	samples  uint64
	frame    SysFrame
	frameKey []byte // frame minus its timestamp, for change detection
	sent     uint64

	mem memState // the Memory map's state (memmap.go)
}

func NewSysMon(dir string, every time.Duration, mo MemOpts) *SysMon {
	m := &SysMon{dir: dir, self: os.Getpid(), page: uint64(os.Getpagesize()), every: every, procs: map[int]*procEntry{}}
	m.mem.opts = mo
	m.mem.hist = map[string]*memSeries{}
	switch {
	case dir == "" || dir == "off":
		m.dir, m.why = "", "system view is off (--proc off)"
	default:
		if _, err := os.Stat(filepath.Join(dir, "stat")); err != nil {
			m.dir, m.why = "", "no /proc on this system: CPU and memory are only read on Linux"
		}
	}
	if m.dir != "" {
		b, _ := os.ReadFile(filepath.Join(m.dir, "sys/kernel/osrelease"))
		m.wsl = bytes.Contains(bytes.ToLower(b), []byte("microsoft"))
		// Children (herdr calls, gh, the voice sidecar) carry the mark.
		os.Setenv(dashRoleEnv, "dash:"+strconv.Itoa(m.self))
	}
	m.frame = SysFrame{Available: m.dir != "", Reason: m.why, WSL: m.wsl, Procs: []SysProc{}, Every: every.Seconds()}
	return m
}

// Frame is the last sample (or why there is none).
func (m *SysMon) Frame() SysFrame {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.frame
}

// Stale reports whether the last sample is too old to diff against: the
// next one would average over the whole pause.
func (m *SysMon) Stale() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.dir != "" && time.Since(m.last) > 2*m.every+time.Second
}

// Stats are the sample and frame counts (tests, and the cost in the README).
func (m *SysMon) Stats() map[string]uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return map[string]uint64{"samples": m.samples, "frames": m.sent, "tracked": uint64(len(m.procs)),
		"mem_samples": m.mem.samples, "pss_passes": m.mem.pssPasses, "pss_ms": uint64(m.mem.pssCost.Milliseconds())}
}

// Sample reads /proc and returns the new frame's JSON when it differs from
// the last one (nil otherwise). owners maps pane ids to what runs in them.
// detail (a Memory map is open) also reads every other process and returns
// the Memory map's frame.
func (m *SysMon) Sample(owners map[string]paneOwner, detail bool) ([]byte, *MemFrame) {
	if m.dir == "" {
		return nil, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	fresh := !m.last.IsZero() && now.Sub(m.last) <= 2*m.every+time.Second
	m.last = now
	m.samples++
	f := SysFrame{Available: true, WSL: m.wsl, Every: m.every.Seconds(), Procs: []SysProc{}, At: now.UTC().Format(time.RFC3339)}

	if cpu := m.readCPU(); len(cpu) > 0 {
		f.NCPU = len(cpu) - 1
		if fresh && len(m.cpu) == len(cpu) {
			pct := func(a, b cpuTimes) float64 {
				if b.total <= a.total {
					return 0
				}
				return round1(100 * float64(b.busy-min(b.busy, a.busy)) / float64(b.total-a.total))
			}
			c := &SysCPU{Pct: pct(m.cpu[0], cpu[0]), Cores: make([]float64, len(cpu)-1)}
			for i := 1; i < len(cpu); i++ {
				c.Cores[i-1] = math.Round(pct(m.cpu[i], cpu[i]))
			}
			f.CPU = c
		}
		m.cpu = cpu
	}
	f.Mem, f.Swap = m.readMem()
	f.Load = m.readLoad()
	f.Procs = m.readProcs(owners, fresh, now, detail)
	m.record(f.Procs, now)
	var mf *MemFrame
	if detail {
		mf = m.memFrame(owners, f, now)
	}

	f.At = ""
	key, _ := json.Marshal(f)
	f.At = now.UTC().Format(time.RFC3339)
	m.frame = f
	if bytes.Equal(key, m.frameKey) {
		return nil, mf
	}
	m.frameKey = key
	m.sent++
	b, _ := json.Marshal(f)
	return b, mf
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// readCPU parses the cpu lines of /proc/stat: all cores, then each.
func (m *SysMon) readCPU() []cpuTimes {
	b, err := os.ReadFile(filepath.Join(m.dir, "stat"))
	if err != nil {
		return nil
	}
	if m.mem.btime == 0 { // boot time, for process ages
		if i := bytes.Index(b, []byte("\nbtime ")); i >= 0 {
			line, _, _ := bytes.Cut(b[i+7:], []byte("\n"))
			m.mem.btime, _ = strconv.ParseUint(string(bytes.TrimSpace(line)), 10, 64)
		}
	}
	var out []cpuTimes
	for _, line := range bytes.Split(b, []byte("\n")) {
		if !bytes.HasPrefix(line, []byte("cpu")) {
			if len(out) > 0 {
				break
			}
			continue
		}
		fs := strings.Fields(string(line))
		var t cpuTimes
		for i, s := range fs[1:] {
			if i >= 8 { // guest time is already in user
				break
			}
			v, _ := strconv.ParseUint(s, 10, 64)
			t.total += v
			if i != 3 && i != 4 { // idle, iowait
				t.busy += v
			}
		}
		out = append(out, t)
	}
	return out
}

// meminfo reads /proc/meminfo's figures in bytes (nil without it).
func (m *SysMon) meminfo() map[string]uint64 {
	b, err := os.ReadFile(filepath.Join(m.dir, "meminfo"))
	if err != nil {
		return nil
	}
	v := map[string]uint64{}
	for _, line := range strings.Split(string(b), "\n") {
		k, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch k {
		case "MemTotal", "MemAvailable", "MemFree", "SwapTotal", "SwapFree", "Cached", "Buffers", "SReclaimable", "Shmem":
			n, _ := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(rest), " kB"), 10, 64)
			v[k] = n * 1024
		}
	}
	m.mem.info = v
	return v
}

func (m *SysMon) readMem() (mem, swap *SysMem) {
	v := m.meminfo()
	if v == nil {
		return nil, nil
	}
	avail, ok := v["MemAvailable"]
	if !ok {
		avail = v["MemFree"]
	}
	mem = &SysMem{Total: v["MemTotal"], Used: v["MemTotal"] - min(avail, v["MemTotal"])}
	swap = &SysMem{Total: v["SwapTotal"], Used: v["SwapTotal"] - min(v["SwapFree"], v["SwapTotal"])}
	return mem, swap
}

func (m *SysMon) readLoad() []float64 {
	b, _ := os.ReadFile(filepath.Join(m.dir, "loadavg"))
	fs := strings.Fields(string(b))
	out := []float64{}
	for i := 0; i < 3 && i < len(fs); i++ {
		v, _ := strconv.ParseFloat(fs[i], 64)
		out = append(out, v)
	}
	return out
}

// statFields reads comm, starttime, utime+stime and rss (bytes) from
// /proc/<pid>/stat, into a reused buffer and without allocating fields:
// this runs for every pane process on every sample.
func (m *SysMon) statFields(pid int) (comm string, ppid int, start, ticks, rss uint64, ok bool) {
	f, err := os.Open(m.dir + "/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", 0, 0, 0, 0, false
	}
	n, _ := f.Read(m.buf[:])
	f.Close()
	b := m.buf[:n]
	// comm may hold spaces and parentheses: it ends at the last ')'.
	open, end := bytes.IndexByte(b, '('), bytes.LastIndexByte(b, ')')
	if open < 0 || end < open {
		return "", 0, 0, 0, 0, false
	}
	// After ") " comes field 3 (state); utime is 14, stime 15, starttime
	// 22, rss 24.
	field, i := 3, end+2
	var v [25]uint64
	for i < len(b) && field <= 24 {
		j := i
		var x uint64
		for j < len(b) && b[j] != ' ' && b[j] != '\n' {
			if c := b[j]; c >= '0' && c <= '9' {
				x = x*10 + uint64(c-'0')
			}
			j++
		}
		v[field] = x
		field++
		i = j + 1
	}
	if field <= 24 {
		return "", 0, 0, 0, 0, false
	}
	return string(b[open+1 : end]), int(v[4]), v[22], v[14] + v[15], v[24] * m.page, true
}

// tagOf classifies a new process from its environment.
func (m *SysMon) tagOf(pid int) string {
	if pid == m.self {
		return "dash"
	}
	b, err := os.ReadFile(filepath.Join(m.dir, strconv.Itoa(pid), "environ"))
	if err != nil {
		return ""
	}
	self := ":" + strconv.Itoa(m.self)
	pane := ""
	for _, kv := range bytes.Split(b, []byte{0}) {
		k, v, ok := bytes.Cut(kv, []byte("="))
		if !ok {
			continue
		}
		switch string(k) {
		case dashRoleEnv:
			if role, ok := strings.CutSuffix(string(v), self); ok && (role == "dash" || role == "voice") {
				return role
			}
		case "HERDR_PANE_ID":
			pane = string(v)
		}
	}
	if pane != "" {
		return "pane:" + pane
	}
	return ""
}

func (m *SysMon) readProcs(owners map[string]paneOwner, fresh bool, now time.Time, detail bool) []SysProc {
	d, err := os.Open(m.dir)
	if err != nil {
		return []SysProc{}
	}
	names, _ := d.Readdirnames(-1)
	d.Close()
	type group struct {
		SysProc
		cpu     float64
		has     bool
		topTick float64
	}
	groups := map[string]*group{}
	for _, name := range names {
		if name[0] < '0' || name[0] > '9' {
			continue
		}
		pid, err := strconv.Atoi(name)
		if err != nil {
			continue
		}
		e := m.procs[pid]
		if e != nil && e.tag == "" && !detail {
			e.seen = m.samples // not ours: no further reads (unless a Memory map is open)
			continue
		}
		comm, ppid, start, ticks, rss, ok := m.statFields(pid)
		if !ok {
			continue
		}
		if e == nil || e.start != start {
			e = &procEntry{start: start, tag: m.tagOf(pid), cpu: -1}
			m.procs[pid] = e
		}
		prev, prevAt := e.ticks, e.at
		e.comm, e.ppid, e.ticks, e.rss, e.at, e.seen = comm, ppid, ticks, rss, now, m.samples
		if detail {
			e.cpu = -1
			if !prevAt.IsZero() && ticks >= prev && now.Sub(prevAt) <= 2*m.every+time.Second {
				if dt := now.Sub(prevAt).Seconds(); dt > 0 {
					e.cpu = 100 * float64(ticks-prev) / userHZ / dt
				}
			}
			if !e.detailed {
				m.detail(pid, e)
			}
		}
		if e.tag == "" {
			continue
		}
		g := groups[e.tag]
		if g == nil {
			g = &group{SysProc: m.describe(e.tag, owners)}
			groups[e.tag] = g
		}
		g.N++
		g.RSS += rss
		if fresh && !prevAt.IsZero() && ticks >= prev {
			dt := now.Sub(prevAt).Seconds()
			if dt > 0 {
				p := 100 * float64(ticks-prev) / userHZ / dt
				g.cpu += p
				g.has = true
				if p > g.topTick || g.Top == "" {
					g.topTick, g.Top = p, comm
				}
				continue
			}
		}
		if g.Top == "" {
			g.Top = comm
		}
	}
	for pid, e := range m.procs {
		if e.seen != m.samples {
			delete(m.procs, pid)
		}
	}
	out := make([]SysProc, 0, len(groups))
	for _, g := range groups {
		if g.has {
			v := math.Round(g.cpu)
			g.CPU = &v
		}
		out = append(out, g.SysProc)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		ac, bc := -1.0, -1.0
		if a.CPU != nil {
			ac = *a.CPU
		}
		if b.CPU != nil {
			bc = *b.CPU
		}
		if ac != bc {
			return ac > bc
		}
		if a.RSS != b.RSS {
			return a.RSS > b.RSS
		}
		return a.Key < b.Key
	})
	return out
}

func (m *SysMon) describe(tag string, owners map[string]paneOwner) SysProc {
	switch tag {
	case "dash":
		return SysProc{Key: "dash", Kind: "dash"}
	case "voice":
		return SysProc{Key: "voice", Kind: "voice"}
	}
	pane := strings.TrimPrefix(tag, "pane:")
	if o, ok := owners[pane]; ok {
		return SysProc{Key: o.key, Kind: o.kind, Project: o.project, Thread: o.thread, Pane: pane, Agent: o.agent, Exited: o.exited}
	}
	return SysProc{Key: "pane:" + pane, Kind: "pane", Pane: pane}
}
