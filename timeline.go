package main

// Thread timelines: what happened to each thread of a project, newest first,
// for the Threads view (static/threads.js). Built only from what Dash
// already has: the inbox items herdr-projects writes (inbox/ and
// inbox/done/: reports, PR opened/updated/merged, idle, waiting on you,
// resolved…), each thread's creation time, and the progress changes the
// collector saw between two thread lists. No command runs for it.
//
// Inbox files never change once written (they only move to done/), so each
// is parsed once; a project's answer is rebuilt only when its inbox folders
// or its progress history changed (Project.EventsSig).

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// TLEvent is one entry of a thread's timeline.
type TLEvent struct {
	At      string `json:"at"`
	Type    string `json:"type"` // started, progress, report, pr-opened, pr-updated, pr-failing, pr-merged, pr-closed, idle, waiting, blocked, prompted, resolved, warn, other
	Label   string `json:"label"`
	Text    string `json:"text,omitempty"`
	Percent int    `json:"percent,omitempty"`
}

type tlFile struct {
	subject string
	ev      TLEvent
}

type tlAnswer struct {
	sig  string
	body map[string][]TLEvent
}

const (
	tlPerThread   = 40 // events kept per thread in an answer
	tlProgressCap = 20 // progress changes remembered per thread
)

var (
	inboxNameRe = regexp.MustCompile(`^(\d{8}T\d{6}Z)-([a-z-]+?)-(t-\d+)-\d+\.md$`)
	subjectRe   = regexp.MustCompile(`^t-\d{1,6}$`)
	// `t-0030 "Title": rest` → rest (the card already shows id and title).
	tlPrefixRe = regexp.MustCompile(`^t-\d+ "(?:[^"\\]|\\.)*":?\s*`)
)

// eventsSig says when a project's timeline may have changed: its inbox
// folders (a new item, or one moved to done/) and the progress it recorded.
// Two stats, cheap enough for every thread tick.
func eventsSig(dir string, progress int) string {
	h := fmt.Sprintf("%d", progress)
	for _, p := range []string{filepath.Join(dir, "inbox"), filepath.Join(dir, "inbox", "done")} {
		if fi, err := os.Stat(p); err == nil {
			h += fmt.Sprintf("/%d.%d", fi.ModTime().UnixNano(), fi.Size())
		} else {
			h += "/-"
		}
	}
	return h
}

// recordProgress notes each thread whose reported percent or activity
// changed between two thread lists. Called with c.mu held.
func (c *Collector) recordProgress(slug string, old, rows []RawThread, now time.Time) {
	if c.progress == nil {
		c.progress = map[string][]TLEvent{}
	}
	prev := make(map[string]RawThread, len(old))
	for _, t := range old {
		prev[t.ID] = t
	}
	for _, t := range rows {
		o, ok := prev[t.ID]
		if !ok || t.Status == "resolved" || (o.Percent == t.Percent && o.Activity == t.Activity) {
			continue
		}
		if t.Percent == 0 && t.Activity == "" {
			continue
		}
		k := slug + "/" + t.ID
		ev := TLEvent{At: now.UTC().Format(time.RFC3339), Type: "progress", Label: fmt.Sprintf("%d%%", t.Percent), Text: t.Activity, Percent: t.Percent}
		if t.Percent == 0 {
			ev.Label = "Progress"
		}
		l := append(c.progress[k], ev)
		if len(l) > tlProgressCap {
			l = l[len(l)-tlProgressCap:]
		}
		c.progress[k] = l
		c.progressN[slug]++
	}
}

// parseInboxItem reads one inbox item: TOML (+++) or YAML-ish (---) front
// matter with kind, subject, created, event and summary; the file name
// gives what the front matter leaves out.
func parseInboxItem(path string) (tlFile, bool) {
	name := filepath.Base(path)
	m := inboxNameRe.FindStringSubmatch(name)
	f := map[string]string{}
	var body []string
	if fh, err := os.Open(path); err == nil {
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 16<<10), 64<<10)
		fence, in, done := "", false, false
		for n := 0; sc.Scan() && n < 60; n++ {
			line := strings.TrimRight(sc.Text(), "\r")
			if !done && (line == "+++" || line == "---") && (fence == "" || line == fence) {
				if !in && fence == "" {
					fence, in = line, true
					continue
				}
				if in {
					in, done = false, true
					continue
				}
			}
			if in {
				k, v, ok := strings.Cut(line, "=")
				if fence == "---" {
					k, v, ok = strings.Cut(line, ":")
				}
				if ok {
					v = strings.TrimSpace(v)
					if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
						v = v[1 : len(v)-1]
						if strings.HasPrefix(strings.TrimSpace(line[len(k)+1:]), `"`) {
							v = strings.NewReplacer(`\"`, `"`, `\\`, `\`).Replace(v)
						}
					}
					f[strings.TrimSpace(k)] = v
				}
				continue
			}
			if s := strings.TrimSpace(line); s != "" && len(body) < 3 {
				body = append(body, s)
			}
		}
		fh.Close()
	} else {
		return tlFile{}, false
	}
	kind, subject, at := f["kind"], f["subject"], f["created"]
	if m != nil {
		if kind == "" {
			kind = m[2]
		}
		if subject == "" {
			subject = m[3]
		}
		if at == "" {
			if t, err := time.Parse("20060102T150405Z", m[1]); err == nil {
				at = t.UTC().Format(time.RFC3339)
			}
		}
	}
	if !subjectRe.MatchString(subject) || parseTime(at).IsZero() {
		return tlFile{}, false
	}
	text := f["summary"]
	if text == "" {
		text = strings.Join(body, " ")
	}
	text = tlPrefixRe.ReplaceAllString(text, "")
	if r := []rune(text); len(r) > 280 {
		text = string(r[:279]) + "…"
	}
	typ, label := eventType(kind, f["event"])
	return tlFile{subject: subject, ev: TLEvent{At: at, Type: typ, Label: label, Text: text}}, true
}

// eventType maps herdr-projects' event names onto the timeline's types.
func eventType(kind, event string) (string, string) {
	e := strings.ToLower(strings.TrimSpace(event))
	label := event
	if label == "" {
		label = map[string]string{"pr": "PR update", "thread-state": "State change"}[kind]
		if label == "" {
			label = "Event"
		}
	} else {
		label = strings.ToUpper(label[:1]) + label[1:]
	}
	switch {
	case e == "new report":
		return "report", "New report"
	case e == "pr opened":
		return "pr-opened", label
	case e == "pr merged":
		return "pr-merged", label
	case e == "pr checks failing":
		return "pr-failing", label
	case e == "pr closed" || e == "pr ignored":
		return "pr-closed", label
	case strings.HasPrefix(e, "bad pr"), e == "could not prompt its thread", e == "pane closed":
		return "warn", label
	case strings.HasPrefix(e, "pr "):
		return "pr-updated", label
	case e == "idle":
		return "idle", "Idle"
	case e == "waiting on you":
		return "waiting", "Waiting on you"
	case e == "blocked on a prompt":
		return "blocked", "Blocked on a prompt"
	case e == "resolved":
		return "resolved", "Resolved"
	case e == "prompted its thread":
		return "prompted", "Coordinator prompted it"
	case e == "" && kind == "pr":
		return "pr-updated", label
	}
	return "other", label
}

// Timeline answers /api/project/{slug}/timeline: events per thread id,
// newest first, and the signature they were built for.
func (c *Collector) Timeline(slug string) (string, map[string][]TLEvent, bool) {
	c.mu.Lock()
	p := c.projects[slug]
	if p == nil {
		c.mu.Unlock()
		return "", nil, false
	}
	threads := append([]RawThread(nil), p.threads...)
	progress := map[string][]TLEvent{}
	for _, t := range threads {
		if l := c.progress[slug+"/"+t.ID]; len(l) > 0 {
			progress[t.ID] = append([]TLEvent(nil), l...)
		}
	}
	dir := filepath.Join(c.cfg.Root, slug)
	sig := eventsSig(dir, c.progressN[slug])
	// The thread rows count too: a new thread brings its "started" event.
	for _, t := range threads {
		sig += "|" + t.ID + t.Created
	}
	if a, ok := c.timelines[slug]; ok && a.sig == sig {
		c.mu.Unlock()
		return sig, a.body, true
	}
	c.mu.Unlock()

	// Parse outside the lock: new files only, the rest from the cache.
	c.tlMu.Lock()
	defer c.tlMu.Unlock()
	if c.tlFiles == nil {
		c.tlFiles = map[string]tlFile{}
	}
	ids := map[string]bool{}
	for _, t := range threads {
		ids[t.ID] = true
	}
	out := map[string][]TLEvent{}
	seen := map[string]bool{}
	for _, sub := range []string{"inbox", filepath.Join("inbox", "done")} {
		ents, _ := os.ReadDir(filepath.Join(dir, sub))
		for _, e := range ents {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
				continue
			}
			path := filepath.Join(dir, sub, e.Name())
			seen[path] = true
			f, ok := c.tlFiles[path]
			if !ok {
				if m := inboxNameRe.FindStringSubmatch(e.Name()); m != nil && !ids[m[3]] {
					continue // not a thread of this project (yet): parse it once it is
				}
				f, ok = parseInboxItem(path)
				if !ok {
					f = tlFile{} // remembered as unusable
				}
				c.tlFiles[path] = f
			}
			if f.subject != "" && ids[f.subject] {
				out[f.subject] = append(out[f.subject], f.ev)
			}
		}
	}
	prefix := dir + string(filepath.Separator)
	for path := range c.tlFiles {
		if strings.HasPrefix(path, prefix) && !seen[path] {
			delete(c.tlFiles, path)
		}
	}
	for _, t := range threads {
		l := append(out[t.ID], progress[t.ID]...)
		if at := t.Created; !parseTime(at).IsZero() {
			l = append(l, TLEvent{At: parseTime(at).UTC().Format(time.RFC3339), Type: "started", Label: "Started", Text: t.Title})
		}
		sort.SliceStable(l, func(i, j int) bool { return parseTime(l[i].At).After(parseTime(l[j].At)) })
		if len(l) > tlPerThread {
			l = l[:tlPerThread]
		}
		if len(l) > 0 {
			out[t.ID] = l
		}
	}
	c.mu.Lock()
	if c.timelines == nil {
		c.timelines = map[string]tlAnswer{}
	}
	c.timelines[slug] = tlAnswer{sig: sig, body: out}
	c.mu.Unlock()
	return sig, out, true
}

func timelineHTTP(col *Collector) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := r.PathValue("slug")
		if !slugRe.MatchString(slug) {
			http.Error(w, "bad project", http.StatusBadRequest)
			return
		}
		sig, ev, ok := col.Timeline(slug)
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, map[string]any{"sig": sig, "threads": ev})
	}
}
