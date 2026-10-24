// herdr-dash: an animated web dashboard of every herdr project and thread on
// this machine, with a few allow-listed actions (see actions.go).
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
)

//go:embed static
var staticFS embed.FS

var (
	slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,80}$`)
	idRe   = regexp.MustCompile(`^t-[0-9]{1,6}$`)
	// No WithUnsafe: raw HTML is dropped and dangerous link schemes emptied.
	md = goldmark.New(goldmark.WithExtensions(extension.GFM))
)

func main() {
	home, _ := os.UserHomeDir()
	// HERDR_DASH_BUILD_ID stands in for a new build in tests.
	cfg := Config{Voice: voiceConfigFromEnv(), STT: sttConfigFromEnv(), Build: env("HERDR_DASH_BUILD_ID", buildID())}
	// Flags win over env; env wins over built-in defaults.
	addr := flag.String("addr", env("HERDR_DASH_ADDR", "127.0.0.1:8791"), "listen address, $HERDR_DASH_ADDR (use 0.0.0.0:8791 to serve other machines)")
	flag.StringVar(&cfg.Root, "root", env("HERDR_DASH_ROOT", env("HERDR_PROJECTS_ROOT", filepath.Join(home, ".herdr-projects"))), "herdr-projects root, $HERDR_DASH_ROOT")
	flag.StringVar(&cfg.HerdrProjects, "herdr-projects", env("HERDR_DASH_HERDR_PROJECTS", ""), "herdr-projects binary, $HERDR_DASH_HERDR_PROJECTS (default: on PATH, else the installed herdr plugin)")
	flag.StringVar(&cfg.Auth, "auth", env("HERDR_DASH_AUTH", "none"), "auth mode, $HERDR_DASH_AUTH; only \"none\" (trusted network) exists yet")
	flag.StringVar(&cfg.PublicURL, "public-url", env("HERDR_DASH_PUBLIC_URL", ""), "HTTPS address of this dashboard (e.g. a tailscale serve URL), $HERDR_DASH_PUBLIC_URL; remote plain-http page loads redirect there, since browsers only allow the microphone over HTTPS")
	flag.BoolVar(&cfg.ReadOnly, "read-only", env("HERDR_DASH_READ_ONLY", "") != "", "refuse every write action, $HERDR_DASH_READ_ONLY")
	flag.IntVar(&cfg.WriteBurst, "write-burst", 10, "write actions allowed in a burst")
	flag.IntVar(&cfg.WritePerMin, "write-per-min", 30, "write actions refilled per minute")
	flag.StringVar(&cfg.Herdr, "herdr", "herdr", "herdr binary")
	flag.StringVar(&cfg.GH, "gh", "gh", "gh binary")
	flag.StringVar(&cfg.SessionProfiles, "session-profiles", filepath.Join(home, ".config/herdr-projects/config.toml"), "herdr-projects profile config for session fallbacks")
	flag.StringVar(&cfg.OpencodeDB, "opencode-db", filepath.Join(home, ".local/share/opencode/opencode.db"), "OpenCode session database (optional sqlite3 CLI)")
	flag.StringVar(&cfg.ClaudeDir, "claude-dir", filepath.Join(home, ".claude/projects"), "Claude Code transcripts")
	flag.StringVar(&cfg.CodexDir, "codex-dir", filepath.Join(home, ".codex/sessions"), "Codex sessions")
	flag.DurationVar(&cfg.Poll, "poll", 5*time.Second, "herdr pane list interval")
	flag.DurationVar(&cfg.ThreadsEvery, "threads-every", 0, "thread list interval (default 3x poll, min 3s)")
	flag.DurationVar(&cfg.QuietEvery, "quiet-every", 5*time.Minute, "interval for projects with only resolved threads")
	flag.DurationVar(&cfg.ThreadsMaxAge, "threads-max-age", time.Minute, "re-list a project at least this often even when none of its files or panes changed")
	flag.DurationVar(&cfg.GHEvery, "gh-every", 10*time.Minute, "gh pr list interval")
	// Off by default: `memex search` also ingests new transcripts, which can
	// cost seconds of CPU and hundreds of MB (see README, Content search).
	flag.StringVar(&cfg.Memex, "memex", env("HERDR_DASH_MEMEX", "off"), "memex binary for transcript search, e.g. \"memex\" (on PATH), $HERDR_DASH_MEMEX; default off; disabled when not found")
	flag.DurationVar(&cfg.MemexTimeout, "memex-timeout", 2*time.Second, "time limit of one memex search")
	flag.IntVar(&cfg.MemexPerMin, "memex-per-min", 30, "memex searches allowed a minute")
	sttFetch := flag.Bool("stt-fetch", false, "download and verify the local Parakeet TDT v3 model, then exit")
	pprofAddr := flag.String("pprof-addr", env("HERDR_DASH_PPROF_ADDR", ""), "serve Go's profiler on this loopback address, e.g. 127.0.0.1:6060, $HERDR_DASH_PPROF_ADDR; default off")
	usage := usageFlags(home)
	flag.Parse()
	if *sttFetch {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := NewSTT(cfg.STT).fetchModel(ctx); err != nil {
			log.Fatal(err)
		}
		return
	}
	cfg.Usage = *usage
	cfg.Usage.CodexDir = cfg.CodexDir
	cfg.Memex = resolveMemex(cfg.Memex)
	if cfg.HerdrProjects == "" {
		cfg.HerdrProjects = defaultHerdrProjects(home)
	}
	if cfg.Auth != "none" {
		log.Fatalf("--auth %q is not implemented; only \"none\" is (the network is trusted)", cfg.Auth)
	}
	pu, err := parsePublicURL(cfg.PublicURL)
	if err != nil {
		log.Fatal(err)
	}
	cfg.PublicURL = pu
	if cfg.ThreadsEvery == 0 {
		cfg.ThreadsEvery = max(3*cfg.Poll, 3*time.Second)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	col := NewCollector(cfg)
	go col.Run(ctx)
	if *pprofAddr != "" {
		if err := servePprof(*pprofAddr); err != nil {
			log.Fatal(err)
		}
	}

	stt := NewSTT(cfg.STT)
	srv := &http.Server{Addr: *addr, Handler: secureRedirect(cfg.PublicURL, newMux(col, cfg, stt)), ReadHeaderTimeout: 10 * time.Second}
	defer stt.stopSidecar("shutdown")
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
		stt.stopSidecar("shutdown")
	}()
	log.Printf("herdr-dash listening on %s (public %q, herdr-projects %s, root %s, read-only %v, memex %q, voice intent %v, transcribe %v, stt local %v)", *addr, cfg.PublicURL, cfg.HerdrProjects, cfg.Root, cfg.ReadOnly, cfg.Memex, cfg.Voice.Intent(), cfg.Voice.STT(), cfg.STT.Local())
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// buildID is a short hash of the embedded frontend: it changes exactly when
// an install would give open pages new code.
func buildID() string {
	h := sha256.New()
	fs.WalkDir(staticFS, "static", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := staticFS.ReadFile(p)
			fmt.Fprintf(h, "%s %d\n", p, len(b))
			h.Write(b)
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:12]
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// defaultHerdrProjects finds herdr-projects on PATH, else the newest build
// under herdr's plugin checkouts.
func defaultHerdrProjects(home string) string {
	if p, err := exec.LookPath("herdr-projects"); err == nil {
		return p
	}
	best, bestT := "herdr-projects", time.Time{}
	matches, _ := filepath.Glob(filepath.Join(home, ".config/herdr/plugins/*/herdr-projects-*/target/release/herdr-projects"))
	for _, m := range matches {
		if fi, err := os.Stat(m); err == nil && fi.ModTime().After(bestT) {
			best, bestT = m, fi.ModTime()
		}
	}
	return best
}

func newMux(col *Collector, cfg Config, localSTT ...*STT) *http.ServeMux {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(staticFS, "static")
	files := http.FileServer(http.FS(sub))
	mux.Handle("GET /", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, col.Snapshot())
	})
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "no streaming", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		// A snapshot is large and mostly repeats itself: gzip cuts it ~10x on
		// the wire, which matters to a phone that gets one every few seconds.
		var out io.Writer = w
		flush := fl.Flush
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Add("Vary", "Accept-Encoding")
			gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
			defer gz.Close()
			out = gz
			flush = func() { gz.Flush(); fl.Flush() }
		}
		ch := col.Subscribe()
		defer col.Unsubscribe(ch)
		first, _ := json.Marshal(col.Snapshot())
		send := func(b []byte) bool {
			_, err := io.WriteString(out, "event: state\ndata: "+string(b)+"\n\n")
			flush()
			return err == nil
		}
		if !send(first) {
			return
		}
		ping := time.NewTicker(25 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case b := <-ch:
				if !send(b) {
					return
				}
			case <-ping.C:
				io.WriteString(out, ": ping\n\n")
				flush()
			}
		}
	})
	NewActions(cfg, col).register(mux)
	NewSearcher(cfg, col).register(mux)
	NewVoice(cfg.Voice).register(mux)
	stt := NewSTT(cfg.STT)
	if len(localSTT) > 0 {
		stt = localSTT[0]
	}
	stt.register(mux)
	NewUsage(cfg.Usage).register(mux)
	mux.HandleFunc("GET /api/thread/{slug}/{id}", func(w http.ResponseWriter, r *http.Request) {
		slug, id := r.PathValue("slug"), r.PathValue("id")
		if !slugRe.MatchString(slug) || !idRe.MatchString(id) {
			http.Error(w, "bad thread", http.StatusBadRequest)
			return
		}
		t, alive, ok := col.raw(slug, id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, threadDetail(r.Context(), col, cfg, slug, t, alive))
	})
	safety := newSafetyCache()
	mux.HandleFunc("GET /api/project/{slug}", func(w http.ResponseWriter, r *http.Request) {
		slug := r.PathValue("slug")
		if !slugRe.MatchString(slug) {
			http.Error(w, "bad project", http.StatusBadRequest)
			return
		}
		if !col.hasProject(slug) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, projectDetail(r.Context(), col, cfg, safety, slug))
	})
	return mux
}

type Jump struct {
	Label   string `json:"label"`
	Command string `json:"command"`
}

type Detail struct {
	Task       string   `json:"task_summary"`
	TaskHTML   string   `json:"task_html"`
	ReportHTML string   `json:"report_html"`
	ReportSum  string   `json:"report_summary"`
	Next       []string `json:"next"`
	Screen     string   `json:"screen"`
	Jump       []Jump   `json:"jump"`
	Branch     string   `json:"branch"`
	Worktree   string   `json:"worktree"`
	Origin     string   `json:"origin"`
	Profile    string   `json:"profile"`
	StateLine  string   `json:"state_line"`
	Resolved   string   `json:"resolved_reason"`
}

func threadDetail(ctx context.Context, col *Collector, cfg Config, slug string, t RawThread, alive bool) Detail {
	threads := filepath.Join(cfg.Root, slug, "threads")
	task := readCapped(filepath.Join(threads, t.ID+".task.md"))
	report := readCapped(filepath.Join(threads, t.ID+".md"))
	d := Detail{
		Task:       summary(task),
		TaskHTML:   render(task),
		ReportHTML: render(report),
		ReportSum:  reportSummary(report),
		Next:       t.Next,
		Branch:     t.Branch,
		Worktree:   t.WorktreePath,
		Origin:     t.Origin,
		Profile:    t.Profile,
		StateLine:  t.StateLine,
		Resolved:   t.ResolvedReason,
	}
	if d.Next == nil {
		d.Next = []string{}
	}
	if alive && t.Status != "resolved" && t.PaneID != "" {
		d.Screen, _ = col.Screen(ctx, t.PaneID, 5*time.Second)
	}
	if t.PaneID != "" && t.Status != "resolved" {
		d.Jump = append(d.Jump, Jump{"Focus the agent pane", "herdr agent focus " + t.PaneID})
		if t.TabID != "" {
			d.Jump = append(d.Jump, Jump{"Focus its tab", "herdr tab focus " + t.TabID})
		}
	}
	hp := shellQuote(cfg.HerdrProjects)
	d.Jump = append(d.Jump,
		Jump{"Show the thread", hp + " thread show " + slug + " " + t.ID},
		Jump{"Open the project coordinator", hp + " open " + slug},
	)
	return d
}

func shellQuote(s string) string {
	if regexp.MustCompile(`^[\w./:@-]+$`).MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func readCapped(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, 256<<10))
	return string(b)
}

func render(src string) string {
	if strings.TrimSpace(src) == "" {
		return ""
	}
	var buf bytes.Buffer
	if err := md.Convert([]byte(src), &buf); err != nil {
		return ""
	}
	return buf.String()
}

// reportSummary is a one-line preview of a report: its first paragraph after
// the `PR:` line and the headings, without markup.
func reportSummary(report string) string {
	var keep []string
	for _, l := range strings.Split(report, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "PR: ") {
			keep = append(keep, l)
		}
	}
	s := tagRe.ReplaceAllString(summary(strings.Join(keep, "\n")), "")
	if r := []rune(s); len(r) > 160 {
		s = string(r[:160]) + "…"
	}
	return strings.TrimSpace(s)
}

var tagRe = regexp.MustCompile(`<[^>]*>`)

// summary is the first paragraph of a task, capped.
func summary(task string) string {
	var lines []string
	for _, l := range strings.Split(task, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			if len(lines) > 0 {
				break
			}
			continue
		}
		lines = append(lines, l)
	}
	s := strings.Join(lines, " ")
	if r := []rune(s); len(r) > 400 {
		s = string(r[:400]) + "…"
	}
	return s
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
