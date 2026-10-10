package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Config names the data sources and the write settings. Every external
// command the collector runs is read-only; writes live in actions.go.
type Config struct {
	Auth          string
	ReadOnly      bool
	WriteBurst    int
	WritePerMin   int
	Root          string
	HerdrProjects string
	Herdr         string
	GH            string
	ClaudeDir     string
	CodexDir      string
	Poll          time.Duration // herdr pane list
	ThreadsEvery  time.Duration // herdr-projects thread list, projects with open threads
	QuietEvery    time.Duration // projects whose threads are all resolved
	GHEvery       time.Duration
}

// RawThread is one row of `herdr-projects thread list <slug> --json`.
type RawThread struct {
	ID               string   `json:"id"`
	Title            string   `json:"title"`
	Status           string   `json:"status"`
	Group            string   `json:"group"`
	GroupToken       string   `json:"group_token"`
	LastState        string   `json:"last_state"`
	Activity         string   `json:"activity"`
	Percent          int      `json:"percent"`
	Agent            string   `json:"agent"`
	Profile          string   `json:"profile"`
	Kind             string   `json:"kind"`
	PaneID           string   `json:"pane_id"`
	TabID            string   `json:"tab_id"`
	WorkspaceID      string   `json:"workspace_id"`
	Branch           string   `json:"branch"`
	Origin           string   `json:"origin"`
	PR               string   `json:"pr"`
	PRState          string   `json:"pr_state"`
	PRReview         string   `json:"pr_review"`
	Created          string   `json:"created"`
	Updated          string   `json:"updated"`
	LastStateChange  string   `json:"last_state_change"`
	LastReportChange string   `json:"last_report_change"`
	Next             []string `json:"next"`
	Note             string   `json:"note"`
	StateLine        string   `json:"state_line"`
	Error            string   `json:"error"`
	Machine          string   `json:"machine"`
	ReportHash       string   `json:"report_hash"`
	AckedReportHash  string   `json:"acked_report_hash"`
	ResolvedReason   string   `json:"resolved_reason"`
	WorktreePath     string   `json:"worktree_path"`
}

type Pane struct {
	PaneID       string `json:"pane_id"`
	TabID        string `json:"tab_id"`
	Agent        string `json:"agent"`
	AgentStatus  string `json:"agent_status"`
	Cwd          string `json:"cwd"`
	AgentSession *struct {
		Agent string `json:"agent"`
		Value string `json:"value"`
	} `json:"agent_session"`
	// herdr-projects' sidebar tokens; hp_sub is its state line ("needs you · ~40%").
	Tokens map[string]any `json:"tokens"`
}

func (p Pane) session() string {
	if p.AgentSession == nil {
		return ""
	}
	return p.AgentSession.Value
}

// liveCoord is one row of `.state/coordinators.json`: the coordinator panes
// the herdr-projects ticker last saw.
type liveCoord struct {
	PaneID         string `json:"pane_id"`
	TabID          string `json:"tab_id"`
	Agent          string `json:"agent"`
	StateChangeSeq uint64 `json:"state_change_seq"`
	PairSince      string `json:"pair_since"`
	AgentSession   string `json:"agent_session"`
}

// coordRecord is `.state/coordinator.json`: the pane `open` last started.
type coordRecord struct {
	PaneID       string `json:"pane_id"`
	TabID        string `json:"tab_id"`
	Cwd          string `json:"cwd"`
	Agent        string `json:"agent"`
	AgentSession string `json:"agent_session"`
	Updated      string `json:"updated"`
}

// Coordinator is a project's coordinator as the page sees it. State is
// blocked, waiting (herdr-projects says it needs you), working, idle, or
// none when no live pane can be identified.
type Coordinator struct {
	PaneID       string `json:"pane_id"`
	TabID        string `json:"tab_id"`
	Agent        string `json:"agent"`
	LiveStatus   string `json:"live_status"`
	State        string `json:"state"`
	Activity     string `json:"activity"`
	LastActivity string `json:"last_activity"`
	NeedsYou     bool   `json:"needs_you"`
}

type ghPR struct {
	Number      int    `json:"number"`
	URL         string `json:"url"`
	State       string `json:"state"`
	HeadRefName string `json:"headRefName"`
}

type Project struct {
	Slug    string         `json:"slug"`
	Name    string         `json:"name"`
	Goal    string         `json:"goal"`
	Status  string         `json:"status"`
	Summary string         `json:"summary"`
	Counts  map[string]int `json:"counts"`
	Inbox   int            `json:"inbox"`
	Error   string         `json:"error,omitempty"`

	Coordinator Coordinator `json:"coordinator"`
}

type Thread struct {
	Key          string   `json:"key"`
	Project      string   `json:"project"`
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	State        string   `json:"state"`
	Group        string   `json:"group"`
	LiveStatus   string   `json:"live_status"`
	Activity     string   `json:"activity"`
	Percent      int      `json:"percent"`
	Agent        string   `json:"agent"`
	Kind         string   `json:"kind"`
	PaneID       string   `json:"pane_id"`
	TabID        string   `json:"tab_id"`
	PaneAlive    bool     `json:"pane_alive"`
	Branch       string   `json:"branch"`
	PR           string   `json:"pr"`
	PRState      string   `json:"pr_state"`
	Created      string   `json:"created"`
	Updated      string   `json:"updated"`
	LastActivity string   `json:"last_activity"`
	NeedsYou     bool     `json:"needs_you"`
	Acked        bool     `json:"acked"`
	Note         string   `json:"note"`
	Error        string   `json:"error,omitempty"`
	Next         []string `json:"next"`
}

type Snapshot struct {
	GeneratedAt string    `json:"generated_at"`
	Projects    []Project `json:"projects"`
	Threads     []Thread  `json:"threads"`
	PRsChecked  bool      `json:"prs_checked"`
	Errors      []string  `json:"errors"`
}

type projectRaw struct {
	Project
	threads   []RawThread
	fetched   time.Time
	hasOpen   bool
	listError string
	coords    []liveCoord
	record    coordRecord
}

type Collector struct {
	cfg Config

	mu         sync.Mutex
	projects   map[string]*projectRaw
	order      []string
	panes      map[string]Pane
	panesErr   string
	prs        map[string]ghPR // repo + "#" + branch
	prsChecked bool
	transcript map[string]transcriptHit
	snapJSON   []byte
	snap       Snapshot
	subs       map[chan []byte]struct{}
	screens    map[string]screenHit
	burst      map[string]time.Time // pane -> read its screen fast until
	kick       chan struct{}
}

type transcriptHit struct {
	path    string
	checked time.Time
}

type screenHit struct {
	text string
	at   time.Time
}

func NewCollector(cfg Config) *Collector {
	return &Collector{
		cfg:        cfg,
		projects:   map[string]*projectRaw{},
		panes:      map[string]Pane{},
		prs:        map[string]ghPR{},
		transcript: map[string]transcriptHit{},
		subs:       map[chan []byte]struct{}{},
		screens:    map[string]screenHit{},
		burst:      map[string]time.Time{},
		kick:       make(chan struct{}, 1),
		snap:       Snapshot{Projects: []Project{}, Threads: []Thread{}, Errors: []string{}},
	}
}

func run(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	return runIn(ctx, timeout, "", name, args...)
}

// runIn runs name with args (no shell), feeding stdin when it is not empty.
func runIn(ctx context.Context, timeout time.Duration, stdin string, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return out, &cmdError{cmd: filepath.Base(name) + " " + strings.Join(args, " "), err: err, stderr: msg}
	}
	return out, nil
}

// cmdError keeps the command's own message apart, so the page can show it
// without the command line (and its paths).
type cmdError struct {
	cmd    string
	err    error
	stderr string
}

func (e *cmdError) Error() string { return fmt.Sprintf("%s: %v %s", e.cmd, e.err, e.stderr) }

// Message is what the command said, else how it failed.
func (e *cmdError) Message() string {
	if e.stderr != "" {
		return strings.TrimPrefix(e.stderr, "herdr-projects: ")
	}
	return e.err.Error()
}

// Run blocks, polling until ctx is done. One collector serves every client.
func (c *Collector) Run(ctx context.Context) {
	c.refreshThreads(ctx, true)
	c.refreshPanes(ctx)
	c.rebuild()
	c.refreshPRs(ctx)
	c.rebuild()

	paneT := time.NewTicker(c.cfg.Poll)
	threadT := time.NewTicker(c.cfg.ThreadsEvery)
	ghT := time.NewTicker(c.cfg.GHEvery)
	defer paneT.Stop()
	defer threadT.Stop()
	defer ghT.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-paneT.C:
			c.refreshPanes(ctx)
		case <-threadT.C:
			c.refreshThreads(ctx, false)
		case <-ghT.C:
			c.refreshPRs(ctx)
		case <-c.kick: // a write just landed: show its effect now
			c.refreshPanes(ctx)
			c.refreshThreads(ctx, false)
		}
		c.rebuild()
	}
}

func (c *Collector) refreshPanes(ctx context.Context) {
	out, err := run(ctx, 5*time.Second, c.cfg.Herdr, "pane", "list")
	var doc struct {
		Result struct {
			Panes []Pane `json:"panes"`
		} `json:"result"`
	}
	if err == nil {
		err = json.Unmarshal(out, &doc)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		c.panesErr = err.Error()
		return
	}
	c.panesErr = ""
	c.panes = map[string]Pane{}
	for _, p := range doc.Result.Panes {
		c.panes[p.PaneID] = p
	}
}

var countRe = regexp.MustCompile(`([A-Za-z ]+): (\d+)`)

func (c *Collector) refreshThreads(ctx context.Context, all bool) {
	out, err := run(ctx, 10*time.Second, c.cfg.HerdrProjects, "--root", c.cfg.Root, "list")
	if err != nil {
		log.Printf("list: %v", err)
		return
	}
	var order []string
	now := time.Now()
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.SplitN(line, "\t", 3)
		if len(f) < 2 || !slugRe.MatchString(f[0]) {
			continue
		}
		slug := f[0]
		order = append(order, slug)
		summary := ""
		if len(f) == 3 {
			summary = f[2]
		}
		counts := map[string]int{}
		for _, m := range countRe.FindAllStringSubmatch(summary, -1) {
			var n int
			fmt.Sscan(m[2], &n)
			counts[strings.TrimSpace(m[1])] = n
		}
		c.mu.Lock()
		p := c.projects[slug]
		if p == nil {
			p = &projectRaw{}
			c.projects[slug] = p
		}
		p.Slug, p.Status, p.Summary, p.Counts = slug, f[1], summary, counts
		p.Name, p.Goal = readProjectMeta(filepath.Join(c.cfg.Root, slug, "PROJECT.md"))
		p.coords, p.record, p.Inbox = readCoordState(filepath.Join(c.cfg.Root, slug))
		if p.Name == "" {
			p.Name = slug
		}
		quiet := len(counts) == 0 || (len(counts) == 1 && counts["Resolved"] > 0)
		due := all || p.fetched.IsZero() || !quiet || now.Sub(p.fetched) >= c.cfg.QuietEvery
		c.mu.Unlock()
		if !due {
			continue
		}
		if len(counts) == 0 {
			c.mu.Lock()
			p.threads, p.fetched, p.listError = nil, now, ""
			c.mu.Unlock()
			continue
		}
		tout, terr := run(ctx, 10*time.Second, c.cfg.HerdrProjects, "--root", c.cfg.Root, "thread", "list", slug, "--json")
		var rows []RawThread
		if terr == nil {
			terr = json.Unmarshal(tout, &rows)
		}
		c.mu.Lock()
		p.fetched = now
		if terr != nil {
			p.listError = terr.Error()
		} else {
			p.listError = ""
			p.threads = rows
		}
		c.mu.Unlock()
	}
	c.mu.Lock()
	c.order = order
	c.mu.Unlock()
}

// readCoordState reads the coordinator records herdr-projects keeps and
// counts the open inbox items (inbox/done/ holds handled ones).
func readCoordState(dir string) (coords []liveCoord, rec coordRecord, inbox int) {
	if b, err := os.ReadFile(filepath.Join(dir, ".state/coordinators.json")); err == nil {
		json.Unmarshal(b, &coords)
	}
	if b, err := os.ReadFile(filepath.Join(dir, ".state/coordinator.json")); err == nil {
		json.Unmarshal(b, &rec)
	}
	ents, _ := os.ReadDir(filepath.Join(dir, "inbox"))
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			inbox++
		}
	}
	return
}

// coordinator identifies a project's live coordinator pane without guessing:
// a pane the ticker listed that is still in `herdr pane list` with the same
// session, else the pane `open` recorded if it still runs in the project
// folder. Called with c.mu held.
func (c *Collector) coordinator(p *projectRaw) Coordinator {
	var pane Pane
	var since, tab string
	var best *liveCoord
	for i := range p.coords {
		lc := &p.coords[i]
		pn, ok := c.panes[lc.PaneID]
		if !ok || lc.PaneID == "" || (lc.AgentSession != "" && pn.session() != "" && lc.AgentSession != pn.session()) {
			continue
		}
		if best == nil || lc.StateChangeSeq > best.StateChangeSeq {
			best, pane = lc, pn
		}
	}
	if best != nil {
		since, tab = best.PairSince, best.TabID
	} else if pn, ok := c.panes[p.record.PaneID]; ok && p.record.PaneID != "" && p.record.Cwd != "" && pn.Cwd == p.record.Cwd {
		pane, since, tab = pn, p.record.Updated, p.record.TabID
	} else {
		return Coordinator{State: "none"}
	}
	if tab == "" {
		tab = pane.TabID
	}
	sub, _ := pane.Tokens["hp_sub"].(string)
	co := Coordinator{PaneID: pane.PaneID, TabID: tab, Agent: pane.Agent, LiveStatus: pane.AgentStatus, Activity: sub}
	switch {
	case pane.AgentStatus == "blocked":
		co.State = "blocked"
	case strings.HasPrefix(sub, "needs you"):
		co.State = "waiting"
	case pane.AgentStatus == "working":
		co.State = "working"
	default:
		co.State = "idle"
	}
	co.NeedsYou = co.State == "blocked" || co.State == "waiting"
	last := parseTime(since)
	if v := c.lastTranscript(pane); v.After(last) {
		last = v
	}
	if !last.IsZero() {
		co.LastActivity = last.UTC().Format(time.RFC3339)
	}
	return co
}

// coordPane is the live coordinator pane of slug, if one is identified.
func (c *Collector) coordPane(slug string) (Coordinator, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.projects[slug]
	if p == nil {
		return Coordinator{}, false
	}
	co := c.coordinator(p)
	return co, co.PaneID != ""
}

var nameRe = regexp.MustCompile(`(?m)^name\s*=\s*"((?:[^"\\]|\\.)*)"`)
var goalRe = regexp.MustCompile(`(?m)^goal\s*=\s*"((?:[^"\\]|\\.)*)"`)

// readProjectMeta reads name and goal from the TOML front matter.
func readProjectMeta(path string) (name, goal string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	s := string(b)
	if strings.HasPrefix(s, "+++") {
		if end := strings.Index(s[3:], "\n+++"); end >= 0 {
			s = s[3 : 3+end]
		}
	}
	unq := func(m []string) string {
		if m == nil {
			return ""
		}
		var v string
		if json.Unmarshal([]byte(`"`+m[1]+`"`), &v) == nil {
			return v
		}
		return m[1]
	}
	return unq(nameRe.FindStringSubmatch(s)), unq(goalRe.FindStringSubmatch(s))
}

var ghRepoRe = regexp.MustCompile(`github\.com[:/]([\w.-]+/[\w.-]+?)(?:\.git)?/?$`)

func ghRepo(origin string) string {
	if m := ghRepoRe.FindStringSubmatch(origin); m != nil {
		return m[1]
	}
	return ""
}

// refreshPRs asks gh only about repos that have an open thread with a branch
// and no recorded PR; herdr-projects already tracks the rest.
func (c *Collector) refreshPRs(ctx context.Context) {
	c.mu.Lock()
	repos := map[string]bool{}
	for _, p := range c.projects {
		for _, t := range p.threads {
			if t.Status != "resolved" && t.PR == "" && t.Branch != "" {
				if r := ghRepo(t.Origin); r != "" {
					repos[r] = true
				}
			}
		}
	}
	c.mu.Unlock()
	list := make([]string, 0, len(repos))
	for r := range repos {
		list = append(list, r)
	}
	sort.Strings(list)
	if len(list) > 15 {
		list = list[:15]
	}
	found := map[string]ghPR{}
	for _, r := range list {
		out, err := run(ctx, 30*time.Second, c.cfg.GH, "pr", "list", "--repo", r, "--state", "all", "--limit", "100", "--json", "number,url,state,headRefName")
		if err != nil {
			log.Printf("gh: %v", err)
			continue
		}
		var prs []ghPR
		if json.Unmarshal(out, &prs) != nil {
			continue
		}
		for _, pr := range prs {
			k := r + "#" + pr.HeadRefName
			if _, ok := found[k]; !ok { // gh lists newest first
				found[k] = pr
			}
		}
	}
	c.mu.Lock()
	for k, v := range found {
		c.prs[k] = v
	}
	c.prsChecked = true
	c.mu.Unlock()
}

// lastTranscript returns the mtime of the agent's session transcript, if any.
// Paths are cached so the trees are searched once per session id.
func (c *Collector) lastTranscript(p Pane) time.Time {
	if p.AgentSession == nil || p.AgentSession.Value == "" {
		return time.Time{}
	}
	id := p.AgentSession.Value
	if strings.ContainsAny(id, "/*?[\\") {
		return time.Time{}
	}
	hit, ok := c.transcript[id]
	if !ok || (hit.path == "" && time.Since(hit.checked) > 2*time.Minute) {
		hit = transcriptHit{path: c.findTranscript(p.AgentSession.Agent, id), checked: time.Now()}
		c.transcript[id] = hit
	}
	if hit.path == "" {
		return time.Time{}
	}
	st, err := os.Stat(hit.path)
	if err != nil {
		delete(c.transcript, id)
		return time.Time{}
	}
	return st.ModTime()
}

func (c *Collector) findTranscript(agent, id string) string {
	switch agent {
	case "claude":
		m, _ := filepath.Glob(filepath.Join(c.cfg.ClaudeDir, "*", id+".jsonl"))
		if len(m) > 0 {
			return m[0]
		}
	case "codex":
		// Look only in the last 60 day folders: YYYY/MM/DD.
		for d := 0; d < 60; d++ {
			day := time.Now().AddDate(0, 0, -d)
			m, _ := filepath.Glob(filepath.Join(c.cfg.CodexDir, day.Format("2006/01/02"), "*"+id+".jsonl"))
			if len(m) > 0 {
				return m[0]
			}
		}
		// Fixture or clock skew: one level deeper scan of known years.
		m, _ := filepath.Glob(filepath.Join(c.cfg.CodexDir, "*", "*", "*", "*"+id+".jsonl"))
		if len(m) > 0 {
			return m[0]
		}
	}
	return ""
}

func dashState(t RawThread, live string) string {
	switch t.GroupToken {
	case "resolved":
		return "resolved"
	case "waiting-on-you":
		if live == "blocked" || t.Error != "" {
			return "blocked"
		}
		return "waiting"
	case "ready-for-review":
		return "review"
	case "landing":
		return "landing"
	case "working":
		return "working"
	}
	if t.Status == "resolved" {
		return "resolved"
	}
	return "idle"
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func (c *Collector) rebuild() {
	c.mu.Lock()
	snap := Snapshot{PRsChecked: c.prsChecked, Projects: []Project{}, Threads: []Thread{}, Errors: []string{}}
	if c.panesErr != "" {
		snap.Errors = append(snap.Errors, c.panesErr)
	}
	for _, slug := range c.order {
		p := c.projects[slug]
		if p == nil {
			continue
		}
		pr := p.Project
		pr.Error = p.listError
		pr.Coordinator = c.coordinator(p)
		if p.listError != "" {
			snap.Errors = append(snap.Errors, p.listError)
		}
		snap.Projects = append(snap.Projects, pr)
		for _, t := range p.threads {
			pane, alive := c.panes[t.PaneID]
			live := ""
			if alive && t.Status != "resolved" {
				live = pane.AgentStatus
			}
			last := parseTime(t.Updated)
			for _, s := range []string{t.LastStateChange, t.LastReportChange, t.Created} {
				if v := parseTime(s); v.After(last) {
					last = v
				}
			}
			if alive {
				if v := c.lastTranscript(pane); v.After(last) {
					last = v
				}
			}
			th := Thread{
				Key: slug + "/" + t.ID, Project: slug, ID: t.ID, Title: t.Title,
				State: dashState(t, live), Group: t.Group, LiveStatus: live,
				Activity: t.Activity, Percent: t.Percent, Agent: t.Agent, Kind: t.Kind,
				PaneID: t.PaneID, TabID: t.TabID, PaneAlive: alive, Branch: t.Branch,
				PR: t.PR, PRState: t.PRState, Created: t.Created, Updated: t.Updated,
				Note: t.Note, Error: t.Error, Next: t.Next,
				Acked: t.ReportHash != "" && t.ReportHash == t.AckedReportHash,
			}
			if th.Next == nil {
				th.Next = []string{}
			}
			if !last.IsZero() {
				th.LastActivity = last.UTC().Format(time.RFC3339)
			}
			if th.PR == "" && t.Branch != "" {
				if g, ok := c.prs[ghRepo(t.Origin)+"#"+t.Branch]; ok {
					th.PR, th.PRState = g.URL, g.State
				}
			}
			switch th.State {
			case "waiting", "blocked", "review", "landing":
				th.NeedsYou = true
			}
			snap.Threads = append(snap.Threads, th)
		}
	}
	body, _ := json.Marshal(struct {
		Projects []Project `json:"projects"`
		Threads  []Thread  `json:"threads"`
		E        []string  `json:"errors"`
		P        bool      `json:"p"`
	}{snap.Projects, snap.Threads, snap.Errors, snap.PRsChecked})
	changed := !bytes.Equal(body, c.snapJSON)
	if changed || c.snap.GeneratedAt == "" {
		c.snapJSON = body
		snap.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
		c.snap = snap
	}
	var payload []byte
	if changed {
		payload, _ = json.Marshal(c.snap)
		for ch := range c.subs {
			select {
			case ch <- payload:
			default: // slow client: it gets the next one
			}
		}
	}
	c.mu.Unlock()
}

func (c *Collector) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snap
}

func (c *Collector) Subscribe() chan []byte {
	ch := make(chan []byte, 1)
	c.mu.Lock()
	c.subs[ch] = struct{}{}
	c.mu.Unlock()
	return ch
}

func (c *Collector) Unsubscribe(ch chan []byte) {
	c.mu.Lock()
	delete(c.subs, ch)
	c.mu.Unlock()
}

// raw returns the raw thread record and whether its pane is alive.
func (c *Collector) raw(slug, id string) (RawThread, bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.projects[slug]
	if p == nil {
		return RawThread{}, false, false
	}
	for _, t := range p.threads {
		if t.ID == id {
			_, alive := c.panes[t.PaneID]
			return t, alive, true
		}
	}
	return RawThread{}, false, false
}

// Kick asks the collector to refresh panes and threads soon (coalesced).
func (c *Collector) Kick() {
	select {
	case c.kick <- struct{}{}:
	default:
	}
}

// Burst makes screen streams of pane read fast for a while, so the reply
// to a prompt or key press shows up quickly.
func (c *Collector) Burst(pane string) {
	if pane == "" {
		return
	}
	c.mu.Lock()
	c.burst[pane] = time.Now().Add(15 * time.Second)
	c.mu.Unlock()
}

func (c *Collector) bursting(pane string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	until, ok := c.burst[pane]
	if ok && time.Now().After(until) {
		delete(c.burst, pane)
		return false
	}
	return ok
}

func (c *Collector) liveStatus(pane string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.panes[pane].AgentStatus
}

func (c *Collector) hasProject(slug string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.projects[slug] != nil
}

// Screen reads the visible screen of a pane, reusing a read younger than
// maxAge so several viewers cost one read.
func (c *Collector) Screen(ctx context.Context, pane string, maxAge time.Duration) string {
	c.mu.Lock()
	if h, ok := c.screens[pane]; ok && time.Since(h.at) < maxAge {
		c.mu.Unlock()
		return h.text
	}
	c.mu.Unlock()
	// "recent", not "visible": visible is the pane's viewport, which misses
	// the newest lines whenever someone scrolled the pane up in herdr.
	out, err := run(ctx, 4*time.Second, c.cfg.Herdr, "pane", "read", pane, "--source", "recent", "--lines", "40")
	text := stripANSI(string(out))
	if err != nil {
		text = ""
	}
	c.mu.Lock()
	c.screens[pane] = screenHit{text: text, at: time.Now()}
	for k, h := range c.screens {
		if time.Since(h.at) > time.Minute {
			delete(c.screens, k)
		}
	}
	c.mu.Unlock()
	return text
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07`)

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }
