package main

// Content search: finds threads by what was said or done in them. Two
// sources, both read-only and only touched when someone searches (nothing
// runs while the dashboard is idle):
//
//   - herdr's own files (thread task, report and Next files; a project's
//     PROJECT.md, TASKS.md and MEMORY.md), held in a small in-memory index
//     that is refreshed by mtime at most once a second, on search;
//   - agent transcripts and memories through memex (optional; off when the
//     binary is missing). At most one memex process runs at a time: a newer
//     search cancels the older one, each run has a timeout, results are
//     cached per query and runs are rate limited.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

const (
	minQuery      = 3
	maxHits       = 60
	perKeySource  = 3
	memexLimit    = 40
	cacheTTL      = 2 * time.Minute
	cacheMax      = 64
	scanEvery     = time.Second
	snippetBefore = 80
	snippetAfter  = 180
)

// memexFields are the only fields asked for: no record text, no metadata.
const memexFields = "kind,ts,mtime_ms,session_id,cwd,source,source_path,snippet"

type SearchHit struct {
	Key         string `json:"key"` // "slug/t-NNNN", or "hub:slug" for a project
	Project     string `json:"project"`
	Thread      string `json:"thread,omitempty"`
	Title       string `json:"title"`
	Source      string `json:"source"` // task, report, next, project, tasks, memory, transcript, agent-memory
	Time        string `json:"time"`
	Snippet     string `json:"snippet"`
	ProjectOnly bool   `json:"project_only,omitempty"` // a transcript of the project's repo, no single thread
}

type MemexStatus struct {
	Status  string `json:"status"` // ok, disabled, timeout, cancelled, rate_limited, error
	Ms      int64  `json:"ms"`
	Dropped int    `json:"dropped"` // hits that belong to no herdr project
	Cached  bool   `json:"cached,omitempty"`
}

type SearchResult struct {
	Query string      `json:"query"`
	Hits  []SearchHit `json:"hits"`
	Memex MemexStatus `json:"memex"`
}

type fileDoc struct {
	mtime   time.Time
	size    int64
	text    string
	lower   string // ASCII-lowered: same byte offsets as text
	key     string
	project string
	thread  string
	source  string
}

type memexHit struct {
	Kind       string `json:"kind"`
	TS         string `json:"ts"`
	MtimeMs    int64  `json:"mtime_ms"`
	SessionID  string `json:"session_id"`
	Cwd        string `json:"cwd"`
	Source     string `json:"source"`
	SourcePath string `json:"source_path"`
	Snippet    string `json:"snippet"`
}

type cacheEntry struct {
	hits []memexHit
	at   time.Time
}

type Searcher struct {
	cfg Config
	col *Collector

	imu     sync.Mutex
	files   map[string]*fileDoc
	scanned time.Time

	slot     chan struct{} // one memex process at a time
	cmu      sync.Mutex
	cancel   context.CancelFunc
	cache    map[string]cacheEntry
	codexCwd map[string]string
	bucket   *bucket
}

func NewSearcher(cfg Config, col *Collector) *Searcher {
	burst := min(10, max(1, cfg.MemexPerMin))
	return &Searcher{
		cfg: cfg, col: col,
		files:    map[string]*fileDoc{},
		slot:     make(chan struct{}, 1),
		cache:    map[string]cacheEntry{},
		codexCwd: map[string]string{},
		bucket:   newBucket(burst, cfg.MemexPerMin),
	}
}

// resolveMemex turns the --memex setting into a binary path, "" when off
// or not installed.
func resolveMemex(v string) string {
	if v == "" || v == "off" || v == "none" {
		return ""
	}
	p, err := exec.LookPath(v)
	if err != nil {
		log.Printf("memex %q not found: transcript search disabled", v)
		return ""
	}
	return p
}

func (s *Searcher) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/search", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, s.Search(r.Context(), r.URL.Query().Get("q")))
	})
}

// queryWords keeps letters and digits only, lowercased: memex's lexical mode
// parses query syntax (field:value, quotes, AND, leading dashes), and none
// of that should reach it from a search box.
func queryWords(q string) []string {
	if r := []rune(q); len(r) > 200 {
		q = string(r[:200])
	}
	return strings.FieldsFunc(strings.ToLower(q), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

func (s *Searcher) Search(ctx context.Context, q string) SearchResult {
	words := queryWords(q)
	query := strings.Join(words, " ")
	res := SearchResult{Query: query, Hits: []SearchHit{}, Memex: MemexStatus{Status: "disabled"}}
	if len([]rune(query)) < minQuery {
		return res
	}
	type mres struct {
		hits []memexHit
		st   MemexStatus
	}
	ch := make(chan mres, 1)
	go func() {
		h, st := s.memex(ctx, query)
		ch <- mres{h, st}
	}()
	hits := s.searchFiles(words)
	m := <-ch
	res.Memex = m.st
	mapped, dropped := s.mapMemex(m.hits)
	res.Memex.Dropped = dropped
	hits = append(hits, mapped...)

	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Time > hits[j].Time })
	seen := map[string]int{}
	for _, h := range hits {
		k := h.Key + "|" + h.Source
		if seen[k] >= perKeySource {
			continue
		}
		seen[k]++
		res.Hits = append(res.Hits, h)
		if len(res.Hits) >= maxHits {
			break
		}
	}
	return res
}

// ---------------------------------------------------------------- files

var threadFileRe = regexp.MustCompile(`^(t-[0-9]{1,6})(\.task|\.next)?\.md$`)

// refreshFiles re-reads only files whose mtime or size changed, and drops
// files that are gone. Called with s.imu held.
func (s *Searcher) refreshFiles() {
	if time.Since(s.scanned) < scanEvery {
		return
	}
	s.scanned = time.Now()
	seen := map[string]bool{}
	add := func(path, key, slug, id, source string) {
		st, err := os.Stat(path)
		if err != nil || !st.Mode().IsRegular() {
			return
		}
		seen[path] = true
		if d := s.files[path]; d != nil && d.mtime.Equal(st.ModTime()) && d.size == st.Size() {
			return
		}
		text := readCapped(path)
		s.files[path] = &fileDoc{mtime: st.ModTime(), size: st.Size(), text: text, lower: asciiLower(text), key: key, project: slug, thread: id, source: source}
	}
	for _, slug := range s.col.projectSlugs() {
		dir := filepath.Join(s.cfg.Root, slug)
		for name, source := range map[string]string{"PROJECT.md": "project", "TASKS.md": "tasks", "MEMORY.md": "memory"} {
			add(filepath.Join(dir, name), "hub:"+slug, slug, "", source)
		}
		ents, _ := os.ReadDir(filepath.Join(dir, "threads"))
		for _, e := range ents {
			m := threadFileRe.FindStringSubmatch(e.Name())
			if m == nil || e.IsDir() {
				continue
			}
			source := map[string]string{"": "report", ".task": "task", ".next": "next"}[m[2]]
			add(filepath.Join(dir, "threads", e.Name()), slug+"/"+m[1], slug, m[1], source)
		}
	}
	for p := range s.files {
		if !seen[p] {
			delete(s.files, p)
		}
	}
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func (s *Searcher) searchFiles(words []string) []SearchHit {
	s.imu.Lock()
	s.refreshFiles()
	var docs []*fileDoc
	for _, d := range s.files {
		docs = append(docs, d)
	}
	s.imu.Unlock()
	titles := s.col.titles()
	phrase := strings.Join(words, " ")
	var hits []SearchHit
	for _, d := range docs {
		ok := true
		for _, w := range words {
			if !strings.Contains(d.lower, w) {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		at := strings.Index(d.lower, phrase)
		if at < 0 {
			at = strings.Index(d.lower, words[0])
		}
		hits = append(hits, SearchHit{
			Key: d.key, Project: d.project, Thread: d.thread, Title: titles[d.key], Source: d.source,
			Time: d.mtime.UTC().Format(time.RFC3339), Snippet: snippetAt(d.text, at, len(words[0])),
		})
	}
	return hits
}

var spaceRe = regexp.MustCompile(`\s+`)

// snippetAt is the text around [at, at+n), on rune boundaries, one line.
func snippetAt(text string, at, n int) string {
	start, end := max(0, at-snippetBefore), min(len(text), at+n+snippetAfter)
	for start > 0 && !utf8Start(text[start]) {
		start--
	}
	for end < len(text) && !utf8Start(text[end]) {
		end++
	}
	s := strings.TrimSpace(spaceRe.ReplaceAllString(text[start:end], " "))
	if start > 0 {
		s = "…" + s
	}
	if end < len(text) {
		s += "…"
	}
	return s
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// ---------------------------------------------------------------- memex

func (s *Searcher) memex(ctx context.Context, query string) ([]memexHit, MemexStatus) {
	if s.cfg.Memex == "" {
		return nil, MemexStatus{Status: "disabled"}
	}
	s.cmu.Lock()
	if e, ok := s.cache[query]; ok && time.Since(e.at) < cacheTTL {
		s.cmu.Unlock()
		return e.hits, MemexStatus{Status: "ok", Cached: true}
	}
	if !s.bucket.take() {
		s.cmu.Unlock()
		return nil, MemexStatus{Status: "rate_limited"}
	}
	// A newer search wins: cancel the running one.
	if s.cancel != nil {
		s.cancel()
	}
	rctx, cancel := context.WithTimeout(ctx, s.cfg.MemexTimeout)
	s.cancel = cancel
	s.cmu.Unlock()
	defer cancel()

	start := time.Now()
	status := func(err error) MemexStatus {
		st := MemexStatus{Status: "error", Ms: time.Since(start).Milliseconds()}
		switch {
		case errors.Is(rctx.Err(), context.DeadlineExceeded):
			st.Status = "timeout"
		case rctx.Err() != nil:
			st.Status = "cancelled"
		default:
			log.Printf("memex: %v", err)
		}
		return st
	}
	// Wait for the previous process to exit before starting this one.
	select {
	case s.slot <- struct{}{}:
	case <-rctx.Done():
		return nil, status(rctx.Err())
	}
	defer func() { <-s.slot }()

	cmd := exec.CommandContext(rctx, s.cfg.Memex, "search", "--non-interactive", "--no-update-check",
		"--content", "all", "--mode", "lexical", "--format", "jsonl",
		"--limit", strconv.Itoa(memexLimit), "--top-n-per-session", "2", "--fields", memexFields, "--", query)
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 500 * time.Millisecond
	var out bytes.Buffer
	cmd.Stdout = &capped{w: &out, n: 2 << 20}
	if err := cmd.Run(); err != nil || rctx.Err() != nil {
		return nil, status(err)
	}
	var hits []memexHit
	for _, line := range bytes.Split(out.Bytes(), []byte("\n")) {
		var h memexHit
		if len(bytes.TrimSpace(line)) > 0 && json.Unmarshal(line, &h) == nil {
			hits = append(hits, h)
		}
	}
	s.cmu.Lock()
	if len(s.cache) >= cacheMax {
		clear(s.cache)
	}
	s.cache[query] = cacheEntry{hits, time.Now()}
	s.cmu.Unlock()
	return hits, MemexStatus{Status: "ok", Ms: time.Since(start).Milliseconds()}
}

// capped writes at most n bytes and then discards the rest.
type capped struct {
	w io.Writer
	n int
}

func (c *capped) Write(p []byte) (int, error) {
	if c.n > 0 {
		k := min(len(p), c.n)
		c.w.Write(p[:k])
		c.n -= k
	}
	return len(p), nil
}

// ---------------------------------------------------------------- mapping

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// encDir names a directory the way Claude Code names its project folders:
// every character but letters and digits becomes "-". Both cwd paths and
// those folder names compare equal in this form.
func encDir(p string) string { return nonAlnum.ReplaceAllString(filepath.Clean(p), "-") }

type dirCand struct {
	key, slug        string
	created, updated time.Time
}

// hitDir is the working directory a memex hit came from, encoded.
func (s *Searcher) hitDir(h memexHit) string {
	if h.Cwd != "" {
		return encDir(h.Cwd)
	}
	if h.SourcePath == "" {
		return ""
	}
	if rel, err := filepath.Rel(s.cfg.ClaudeDir, h.SourcePath); err == nil && !strings.HasPrefix(rel, "..") {
		if first, _, ok := strings.Cut(rel, string(filepath.Separator)); ok {
			return encDir(first)
		}
	}
	if h.Source == "codex" {
		if cwd := s.rolloutCwd(h.SourcePath); cwd != "" {
			return encDir(cwd)
		}
	}
	return ""
}

// rolloutCwd reads the cwd from a Codex rollout's first (session_meta) line.
func (s *Searcher) rolloutCwd(path string) string {
	s.cmu.Lock()
	cwd, ok := s.codexCwd[path]
	s.cmu.Unlock()
	if ok {
		return cwd
	}
	if f, err := os.Open(path); err == nil {
		line, _ := bufio.NewReaderSize(io.LimitReader(f, 1<<20), 64<<10).ReadBytes('\n')
		f.Close()
		var meta struct {
			Payload struct {
				Cwd string `json:"cwd"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &meta) == nil {
			cwd = meta.Payload.Cwd
		}
	}
	s.cmu.Lock()
	if len(s.codexCwd) > 4096 {
		clear(s.codexCwd)
	}
	s.codexCwd[path] = cwd
	s.cmu.Unlock()
	return cwd
}

// mapMemex assigns each hit to a thread or a project hub: by the live pane
// running its session, else by its working directory (a thread's cwd, a
// project folder, or a subfolder of one), else to the project whose repo it
// ran in. Hits that fit no herdr project are dropped and counted.
func (s *Searcher) mapMemex(in []memexHit) (out []SearchHit, dropped int) {
	if len(in) == 0 {
		return nil, 0
	}
	ix := s.col.searchIndex(s.cfg.Root)
	for _, h := range in {
		t := parseTime(h.TS)
		if t.IsZero() && h.MtimeMs > 0 {
			t = time.UnixMilli(h.MtimeMs)
		}
		hit := SearchHit{Source: "transcript", Snippet: strings.TrimSpace(spaceRe.ReplaceAllString(h.Snippet, " "))}
		if h.Kind == "memory" {
			hit.Source = "agent-memory"
		}
		if !t.IsZero() {
			hit.Time = t.UTC().Format(time.RFC3339)
		}
		key, slug, projectOnly := ix.match(h.SessionID, s.hitDir(h), t)
		if key == "" {
			dropped++
			continue
		}
		hit.Key, hit.Project, hit.ProjectOnly, hit.Title = key, slug, projectOnly, ix.titles[key]
		if !strings.HasPrefix(key, "hub:") {
			_, hit.Thread, _ = strings.Cut(key, "/")
		}
		out = append(out, hit)
	}
	return out, dropped
}

type searchIndex struct {
	sessions map[string]string    // agent session id -> key
	dirs     map[string][]dirCand // encoded cwd -> threads or hub
	repos    map[string]string    // encoded repo -> slug
	titles   map[string]string
}

func (ix searchIndex) match(session, dir string, t time.Time) (key, slug string, projectOnly bool) {
	if k, ok := ix.sessions[session]; ok && session != "" {
		return k, keySlug(k), false
	}
	if dir == "" {
		return "", "", false
	}
	// Exact folder first, then the longest folder the hit ran inside.
	cands := ix.dirs[dir]
	if cands == nil {
		best := ""
		for d := range ix.dirs {
			if strings.HasPrefix(dir, d+"-") && len(d) > len(best) {
				best = d
			}
		}
		cands = ix.dirs[best]
	}
	if len(cands) > 1 {
		// Several threads shared the folder (checkouts): the one live then.
		var live []dirCand
		for _, c := range cands {
			if !t.IsZero() && !t.Before(c.created) && !t.After(c.updated.Add(6*time.Hour)) {
				live = append(live, c)
			}
		}
		if len(live) == 1 {
			cands = live
		}
	}
	if len(cands) == 1 {
		return cands[0].key, cands[0].slug, false
	}
	if len(cands) > 1 {
		return "hub:" + cands[0].slug, cands[0].slug, true
	}
	if s, ok := ix.repos[dir]; ok {
		return "hub:" + s, s, true
	}
	return "", "", false
}

func keySlug(k string) string {
	if s, ok := strings.CutPrefix(k, "hub:"); ok {
		return s
	}
	s, _, _ := strings.Cut(k, "/")
	return s
}

// ---------------------------------------------------------------- collector views

func (c *Collector) projectSlugs() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.order...)
}

// titles maps thread keys to thread titles and hub keys to project names.
func (c *Collector) titles() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	m := map[string]string{}
	for slug, p := range c.projects {
		m["hub:"+slug] = p.Name
		for _, t := range p.threads {
			m[slug+"/"+t.ID] = t.Title
		}
	}
	return m
}

func (c *Collector) searchIndex(root string) searchIndex {
	c.mu.Lock()
	defer c.mu.Unlock()
	ix := searchIndex{sessions: map[string]string{}, dirs: map[string][]dirCand{}, repos: map[string]string{}, titles: map[string]string{}}
	for _, slug := range c.order {
		p := c.projects[slug]
		if p == nil {
			continue
		}
		hub := "hub:" + slug
		ix.titles[hub] = p.Name
		ix.dirs[encDir(filepath.Join(root, slug))] = []dirCand{{key: hub, slug: slug}}
		// Coordinator sessions: the ones herdr-projects recorded, and the live pane's.
		for _, lc := range p.coords {
			if lc.AgentSession != "" {
				ix.sessions[lc.AgentSession] = hub
			}
		}
		if p.record.AgentSession != "" {
			ix.sessions[p.record.AgentSession] = hub
		}
		if co := c.coordinator(p); co.PaneID != "" {
			if s := c.panes[co.PaneID].session(); s != "" {
				ix.sessions[s] = hub
			}
		}
		for _, t := range p.threads {
			key := slug + "/" + t.ID
			ix.titles[key] = t.Title
			if pane, ok := c.panes[t.PaneID]; ok && t.PaneID != "" && t.Status != "resolved" && pane.session() != "" {
				ix.sessions[pane.session()] = key
			}
			if t.Repo != "" {
				ix.repos[encDir(t.Repo)] = slug
			}
			for _, d := range []string{t.Cwd, t.WorktreePath} {
				if d == "" {
					continue
				}
				e := encDir(d)
				if len(ix.dirs[e]) == 1 && ix.dirs[e][0].key == key {
					continue
				}
				upd := parseTime(t.Updated)
				for _, v := range []string{t.LastStateChange, t.LastReportChange} {
					if x := parseTime(v); x.After(upd) {
						upd = x
					}
				}
				if t.Status != "resolved" {
					upd = time.Now()
				}
				ix.dirs[e] = append(ix.dirs[e], dirCand{key: key, slug: slug, created: parseTime(t.Created), updated: upd})
			}
		}
	}
	return ix
}
