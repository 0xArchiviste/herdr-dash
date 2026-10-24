package main

// The coordinator panel: one project's settings, files, coordinator progress
// and screen, and its threads' latest reports. Reads only.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxReports = 10

type Progress struct {
	Activity   string `json:"activity"`
	Percent    int    `json:"percent"`
	ReportedAt string `json:"reported_at"`
}

type ReportItem struct {
	Key   string `json:"key"`
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state"`
	Time  string `json:"time"`
	HTML  string `json:"html"`
}

type ProjectDetail struct {
	Slug        string            `json:"slug"`
	Name        string            `json:"name"`
	Goal        string            `json:"goal"`
	Status      string            `json:"status"`
	Settings    map[string]string `json:"settings"`
	Safety      string            `json:"safety"`
	Progress    *Progress         `json:"progress"`
	TasksHTML   string            `json:"tasks_html"`
	MemoryHTML  string            `json:"memory_html"`
	Inbox       int               `json:"inbox"`
	Screen      string            `json:"screen"`
	Jump        []Jump            `json:"jump"`
	Reports     []ReportItem      `json:"reports"`
	Coordinator Coordinator       `json:"coordinator"`
}

func projectDetail(ctx context.Context, col *Collector, cfg Config, safety *safetyCache, slug string) ProjectDetail {
	dir := filepath.Join(cfg.Root, slug)
	d := ProjectDetail{Slug: slug, Settings: readSettings(filepath.Join(dir, "PROJECT.md")), Reports: []ReportItem{}}
	for _, p := range col.Snapshot().Projects {
		if p.Slug == slug {
			d.Name, d.Goal, d.Status, d.Inbox = p.Name, p.Goal, p.Status, p.Inbox
		}
	}
	d.TasksHTML = render(readCapped(filepath.Join(dir, "TASKS.md")))
	d.MemoryHTML = render(readCapped(filepath.Join(dir, "MEMORY.md")))
	d.Safety = safety.get(ctx, cfg, slug)
	co, alive := col.coordPane(slug)
	d.Coordinator = co
	hp := shellQuote(cfg.HerdrProjects)
	if alive {
		d.Screen, _ = col.Screen(ctx, co.PaneID, 5*time.Second)
		d.Progress = readProgress(ctx, cfg, co.PaneID)
		d.Jump = append(d.Jump, Jump{"Focus the coordinator pane", "herdr agent focus " + co.PaneID})
		if co.TabID != "" {
			d.Jump = append(d.Jump, Jump{"Focus its tab", "herdr tab focus " + co.TabID})
		}
	}
	d.Jump = append(d.Jump, Jump{"Open the project coordinator", hp + " open " + slug})
	d.Reports = reports(col, cfg, slug)
	return d
}

var settingRe = regexp.MustCompile(`(?m)^(thread_profile|coordinator_profile|max_parallel_threads|auto_resolve_days|nudge|mute)\s*=\s*(.+?)\s*$`)

// readSettings reads the PROJECT.md front matter settings worth showing.
func readSettings(path string) map[string]string {
	b, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}
	}
	return parseSettings(string(b))
}

func parseSettings(s string) map[string]string {
	out := map[string]string{}
	if strings.HasPrefix(s, "+++") {
		if end := strings.Index(s[3:], "\n+++"); end >= 0 {
			s = s[3 : 3+end]
		}
	} else {
		return out
	}
	out["repos"] = strconv.Itoa(strings.Count(s, "[[repos]]"))
	if i := strings.Index(s, "\n["); i >= 0 {
		s = s[:i] // top-level keys only
	}
	for _, m := range settingRe.FindAllStringSubmatch(s, -1) {
		v := m[2]
		if uq, err := strconv.Unquote(v); err == nil {
			v = uq
		}
		out[m[1]] = v
	}
	return out
}

// readProgress is the coordinator's own `report --percent/--activity`.
func readProgress(ctx context.Context, cfg Config, pane string) *Progress {
	out, err := run(ctx, 4*time.Second, cfg.HerdrProjects, "--root", cfg.Root, "progress", "--pane", pane)
	if err != nil {
		return nil
	}
	var rec *struct {
		Activity   string `json:"activity"`
		Percent    *int   `json:"percent"`
		ReportedAt int64  `json:"reported_at"`
	}
	if json.Unmarshal(out, &rec) != nil || rec == nil || (rec.Activity == "" && rec.Percent == nil) {
		return nil
	}
	p := &Progress{Activity: rec.Activity}
	if rec.Percent != nil {
		p.Percent = *rec.Percent
	}
	if rec.ReportedAt > 0 {
		p.ReportedAt = time.Unix(rec.ReportedAt, 0).UTC().Format(time.RFC3339)
	}
	return p
}

// reports are the project's newest thread reports, newest first.
func reports(col *Collector, cfg Config, slug string) []ReportItem {
	type hit struct {
		ReportItem
		at time.Time
	}
	var hits []hit
	for _, t := range col.Snapshot().Threads {
		if t.Project != slug {
			continue
		}
		raw, _, _ := col.raw(slug, t.ID)
		st, err := os.Stat(filepath.Join(cfg.Root, slug, "threads", t.ID+".md"))
		if err != nil || st.Size() == 0 {
			continue
		}
		at := parseTime(raw.LastReportChange)
		if at.IsZero() {
			at = st.ModTime()
		}
		hits = append(hits, hit{ReportItem{Key: t.Key, ID: t.ID, Title: t.Title, State: t.State, Time: at.UTC().Format(time.RFC3339)}, at})
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].at.After(hits[j].at) })
	if len(hits) > maxReports {
		hits = hits[:maxReports]
	}
	out := make([]ReportItem, 0, len(hits))
	for _, h := range hits {
		h.HTML = render(readCapped(filepath.Join(cfg.Root, slug, "threads", h.ID+".md")))
		out = append(out, h.ReportItem)
	}
	return out
}

// safetyCache keeps `safety show` summaries for a minute: they change by
// hand only, and the panel polls every few seconds.
type safetyCache struct {
	mu sync.Mutex
	m  map[string]safetyHit
}

type safetyHit struct {
	text string
	at   time.Time
}

func newSafetyCache() *safetyCache { return &safetyCache{m: map[string]safetyHit{}} }

var safetyRe = regexp.MustCompile(`(?m)^  (yolo|start_threads|trust_screens)\s+(.+?)\s+\[[^\]]*\]\s*$`)

func (s *safetyCache) get(ctx context.Context, cfg Config, slug string) string {
	s.mu.Lock()
	h, ok := s.m[slug]
	s.mu.Unlock()
	if ok && time.Since(h.at) < time.Minute {
		return h.text
	}
	text := ""
	if out, err := run(ctx, 5*time.Second, cfg.HerdrProjects, "--root", cfg.Root, "safety", "show", slug); err == nil {
		var parts []string
		for _, m := range safetyRe.FindAllStringSubmatch(string(out), -1) {
			parts = append(parts, strings.ReplaceAll(m[1], "_", " ")+" "+m[2])
		}
		text = strings.Join(parts, " · ")
	}
	s.mu.Lock()
	s.m[slug] = safetyHit{text, time.Now()}
	s.mu.Unlock()
	return text
}
