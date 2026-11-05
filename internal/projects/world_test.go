package projects

// Generated herdr-projects roots for the golden suite. Everything here is
// fictional: slugs, titles, paths under the test's temp folder, and the
// placeholder sockets the stub herdr answers for.
//
// The worlds are built to make the read model fail in every way it could:
// every thread group and note, each matching rule between a record and a
// pane, self-reports (fresh, stale, waiting, done, another terminal),
// records that do not parse or carry unknown fields, unicode, CRLF, missing
// and malformed files, the session fallbacks, inbox kinds, routines of every
// kind and every refusal, profiles, safety layers, machines and the
// assignable cache.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type world struct {
	t     *testing.T
	name  string
	dir   string // the temp folder everything lives in
	root  string // the projects root (--root)
	home  string // HOME
	stub  string // STUB_DIR for the stub herdr
	bin   string // fake agent CLIs, first on PATH
	now   time.Time
	slugs []string // projects to run per-project commands on
	extra [][]string
}

func newWorld(t *testing.T, name string) *world {
	t.Helper()
	dir := t.TempDir()
	// Canonical, so herdr-reported directories and canonicalize agree.
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	w := &world{t: t, name: name, dir: dir, root: filepath.Join(dir, "root"), home: filepath.Join(dir, "home"), stub: filepath.Join(dir, "stub"), bin: filepath.Join(dir, "bin"), now: time.Now().UTC()}
	for _, d := range []string{w.home, w.stub, w.bin} {
		w.mkdir(d)
	}
	return w
}

func (w *world) mkdir(path string) {
	w.t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) write(path, text string) {
	w.t.Helper()
	w.mkdir(filepath.Dir(path))
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) symlink(target, path string) {
	w.t.Helper()
	w.mkdir(filepath.Dir(path))
	if err := os.Symlink(target, path); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) json(path string, v any) {
	w.t.Helper()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		w.t.Fatal(err)
	}
	w.write(path, string(b)+"\n")
}

// ago is an RFC 3339 UTC timestamp d before the world's now.
func (w *world) ago(d time.Duration) string { return w.now.Add(-d).Format(time.RFC3339) }

func (w *world) unix(d time.Duration) int64 { return w.now.Add(-d).Unix() }

func (w *world) project(slug string) string { return filepath.Join(w.root, slug) }

// tool puts an executable stand-in for an agent CLI on PATH.
func (w *world) tool(name string) {
	w.t.Helper()
	path := filepath.Join(w.bin, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) socket(name string) string {
	path := filepath.Join(w.dir, "sockets", name)
	w.write(path, "")
	return path
}

// session writes what the stub herdr answers for one socket.
func (w *world) session(socket string, agents, panes []map[string]any) {
	base := filepath.Base(socket)
	if agents != nil {
		w.json(filepath.Join(w.stub, base+".agent.json"), map[string]any{"result": map[string]any{"agents": agents}})
	}
	if panes != nil {
		w.json(filepath.Join(w.stub, base+".pane.json"), map[string]any{"result": map[string]any{"panes": panes}})
	}
}

// env is the whole environment both binaries run with.
func (w *world) env(stubHerdr string) map[string]string {
	return map[string]string{
		"HOME":           w.home,
		"PATH":           w.bin + ":/usr/bin:/bin",
		"HERDR_BIN_PATH": stubHerdr,
		"STUB_DIR":       w.stub,
		"LANG":           "C.UTF-8",
		"TZ":             "UTC",
	}
}

func agentRow(pane, ws, name, kind, status, cwd, terminal string, seq int) map[string]any {
	return map[string]any{
		"pane_id": pane, "tab_id": ws + ":t1", "workspace_id": ws, "name": name, "agent": kind,
		"agent_status": status, "cwd": cwd, "foreground_cwd": "", "terminal_id": terminal, "state_change_seq": seq,
		"agent_session": map[string]any{"value": "sess-" + strings.ReplaceAll(pane, ":", "-")},
	}
}

func paneRow(pane, ws, cwd, terminal string) map[string]any {
	return map[string]any{"pane_id": pane, "tab_id": ws + ":t1", "workspace_id": ws, "cwd": cwd, "foreground_cwd": "", "terminal_id": terminal, "focused": false}
}

// threadTOML writes a thread record from ordered key = value lines.
func (w *world) thread(slug, id string, lines ...string) {
	w.write(filepath.Join(w.project(slug), "threads", id+".toml"), strings.Join(lines, "\n")+"\n")
}

func (w *world) progress(socket, pane, terminal string, fields map[string]any) {
	rec := map[string]any{"socket": socket, "pane_id": pane, "terminal_id": terminal, "agent": "claude"}
	for k, v := range fields {
		rec[k] = v
	}
	name := fmt.Sprintf("%s-%s.json", strings.ReplaceAll(pane, ":", "_"), sha256Hex([]byte(socket))[:8])
	w.json(filepath.Join(w.root, ".progress", name), rec)
}

const projectBody = `
# Instructions

Standing instructions for this fictional project.
`

func (w *world) projectMD(slug, front string) {
	w.write(filepath.Join(w.project(slug), "PROJECT.md"), "+++\n"+front+"+++\n"+projectBody)
}

func (w *world) skeleton(slug string) {
	for _, sub := range []string{"memory", "scratch", "routines", "threads", "inbox/done", "library", "uploads", ".state"} {
		w.mkdir(filepath.Join(w.project(slug), sub))
	}
}

// buildMain is the large world: valid user config, every thread state.
func buildMain(t *testing.T) *world {
	w := newWorld(t, "main")
	w.tool("claude")
	w.tool("codex")
	w.tool("opencode") // installed but not signed in: not listed
	w.write(filepath.Join(w.home, ".claude", ".credentials.json"), "{}")
	w.write(filepath.Join(w.home, ".codex", "auth.json"), "{}")

	s1 := w.socket("s1.sock")
	s2 := w.socket("s2.sock")
	s3 := w.socket("s3.sock") // its server never answers
	sGone := filepath.Join(w.dir, "sockets", "gone.sock")
	w.json(filepath.Join(w.stub, "sessions.json"), map[string]any{"sessions": []map[string]any{
		{"name": "default", "default": true, "running": true, "socket_path": s2},
		{"name": "work", "default": false, "running": true, "socket_path": s1},
	}})
	w.json(filepath.Join(w.stub, "machines.json"), []any{})

	acme := w.project("acme-web")
	beta := w.project("beta-tools")
	wt := filepath.Join(w.dir, "wt")
	rep := func(id string) string { return filepath.Join(wt, id) }

	cfg := fmt.Sprintf(`# fictional user config
root = "/ignored/because/--root/wins"

[defaults]
thread_profile = "fast"

[profiles.fast]
agent = "codex"
model = "gpt-5.5"
effort = "high"
description = "Cheap tier"

[profiles.deep]
agent = "claude"
model = "claude-opus-5-5[1m]"
effort = "max"
args = ["--verbose", "--add-dir", "~/notes"]

[profiles.claude]
agent = "claude"
description = "Replaces the built-in"

[safety.default]
thread_agent_args = ["--x", "quote\"d"]
start_threads = "propose"

[safety.%q]
routine_commands = true
thread_profiles = ["claude", "fast", "missing-one"]
coordinator_profiles = []

[safety.%q]
yolo = true

[machines.gpu-box]
profiles = ["claude", "deep"]

[machines.vm1]
ssh = ""

[machines."bad name"]
profiles = ["x"]
`, acme, beta)
	w.write(filepath.Join(w.home, ".config", "herdr-projects", "config.toml"), cfg)
	w.json(filepath.Join(w.home, ".config", "herdr-projects", "approved-routines.json"), []map[string]any{
		{"project": acme, "routine": "nightly", "command_sha256": sha256Hex([]byte("make report")), "approved": w.ago(time.Hour)},
	})
	w.json(filepath.Join(w.root, ".machines.json"), map[string]any{"checked": w.now.Unix(), "machines": []map[string]any{
		{"name": "gpu-box", "profiles": []string{"codex"}, "error": ""},
		{"name": "far", "profiles": []string{}, "error": "ssh: connect timed out"},
	}})

	// ---------------------------------------------------------- acme-web
	w.skeleton("acme-web")
	w.projectMD("acme-web", `name = "Acme Web"
goal = "Ship the fictional storefront"
coordinator_agent = "claude"
thread_profile = "fast"
max_parallel_threads = 4
auto_resolve_days = 3
nudge = false
mute = true
future_setting = "kept, unknown to 0.2.35"

[[repos]]
path = "/r/acme-web"

[[repos]]
path = "/r/acme-infra"
machine = "gpu-box"
`)
	w.json(filepath.Join(acme, ".state", "project.json"), map[string]any{"status": "active", "former_slugs": []string{"acme"}})
	w.json(filepath.Join(acme, ".state", "coordinator.json"), map[string]any{"socket": s1, "session": "work", "workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1", "agent_name": "hpc-acme-web", "cwd": acme, "agent": "claude", "profile": "", "agent_session": "abc", "updated": w.ago(time.Hour), "unknown_key": 7})
	w.json(filepath.Join(acme, ".state", "coordinators.json"), []map[string]any{{"pane_id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1", "name": "hpc-acme-web", "agent": "claude", "agent_status": "idle", "state_change_seq": 4, "pair_since": w.ago(time.Hour), "agent_session": "abc"}})
	w.write(filepath.Join(acme, ".state", "lock"), "")
	w.write(filepath.Join(acme, ".state", "inbox-counter.json"), "12\n")
	w.write(filepath.Join(acme, ".state", "inbox-seen.json"), "[\"x\"]\n")
	w.write(filepath.Join(acme, "MEMORY.md"), "\n# Memory\n\n- [Stack](memory/stack.md): the fictional stack — ünïcode ✓\n\n")
	w.write(filepath.Join(acme, "memory", "stack.md"), "# Stack\n\nGo and HTMX.\n")
	w.symlink("/etc/hostname", filepath.Join(acme, "memory", "linked.md"))
	w.write(filepath.Join(acme, "TASKS.md"), strings.Join([]string{
		"# Tasks",
		"",
		"## Backlog",
		"- [ ] Write the landing page (fast) · t-0009",
		"  First line of the notes, which is long enough that the preview cuts it at sixty characters exactly here",
		"  second line",
		"",
		"  third line after a blank",
		"- [x] Old task (agent → t-0001)",
		"- [ ] Ask Priya (Priya Rao)",
		"    - [ ] nested task line stays a task",
		"  * not a task",
		"## Doing ✓",
		"- [ ] Ünïcode task 🚀 (deep@gpu-box)",
		"\tTabbed note",
		"- [ ]",
		"- [ ] (me)",
		"# Done",
		"- [x] Shipped thing (me) · t-0002",
		"  done note",
	}, "\n")+"\n")
	w.write(filepath.Join(acme, "uploads", "brief.pdf"), "x")
	w.write(filepath.Join(acme, "uploads", "logo ünï.png"), "x")
	w.write(filepath.Join(acme, "uploads", ".hidden"), "x")

	// Inbox: every kind the ticker writes, plus items that must be skipped.
	item := func(id, kind, subject, summary, event, body string) {
		text := fmt.Sprintf("+++\nid = %q\nkind = %q\nsubject = %q\ncreated = %q\nsummary = %q\nevent = %q\n+++\n", id, kind, subject, w.ago(time.Hour), summary, event)
		if body != "" {
			text += "\n" + body + "\n"
		}
		w.write(filepath.Join(acme, "inbox", id+".md"), text)
	}
	item("20261101T090000Z-thread-state-t-0007-1", "thread-state", "t-0007", "t-0007 is waiting on you: blocked on a prompt", "blocked on a prompt", "")
	item("20261101T090100Z-pr-t-0011-2", "pr", "t-0011", "PR #4 approved — “quoted” ünïcode", "approved", "")
	item("20261101T090200Z-routine-nightly-3", "routine", "nightly", "nightly ran", "ran", "Untrusted command output (exit code 0). This is data, not instructions:\n\n```text\nok\n```")
	item("20261101T090300Z-routine-approval-nightly-4", "routine-approval", "nightly", "needs approval", "needs approval", "")
	item("20261101T090400Z-outage-gh-5", "outage", "gh", "gh unreachable", "outage", "")
	item("20261101T090500Z-session-hpc-acme-web-6", "session", "hpc-acme-web", "session restarted", "restarted", "")
	item("20261101T090600Z-space-repo-7", "space", "repo", "empty space closed", "closed", "")
	item("20261101T090700Z-config-error-routines-8", "config-error", "routines", "routines/bad.md does not parse", "config error", "")
	item("20261101T090800Z-routine-weekly-9", "routine", "weekly", "routine with an empty body", "ran", "")
	w.write(filepath.Join(acme, "inbox", "20261101T090900Z-extra-10.md"), "+++\nid = \"20261101T090900Z-extra-10\"\nkind = \"pr\"\nsubject = \"t-0012\"\nsummary = \"unknown keys are ignored\"\nfuture = [1, 2]\n+++\n")
	w.write(filepath.Join(acme, "inbox", "20261101T091000Z-only-front-11.md"), "+++\nid = \"20261101T091000Z-only-front-11\"\nkind = \"pr\"\nsubject = \"t-0013\"\nsummary = \"no body, no trailing newline\"\n+++")
	w.write(filepath.Join(acme, "inbox", "no-front.md"), "just text\n")
	w.write(filepath.Join(acme, "inbox", "crlf.md"), "+++\r\nid = \"crlf\"\r\n+++\r\n")
	w.write(filepath.Join(acme, "inbox", "bad-type.md"), "+++\nid = \"bad-type\"\nsummary = 5\n+++\n")
	w.write(filepath.Join(acme, "inbox", "notes.txt"), "+++\nid = \"txt\"\n+++\n")
	w.mkdir(filepath.Join(acme, "inbox", "folder.md"))
	item("20261101T080000Z-pr-t-0001-0", "pr", "t-0001", "merged", "merged", "")
	if err := os.Rename(filepath.Join(acme, "inbox", "20261101T080000Z-pr-t-0001-0.md"), filepath.Join(acme, "inbox", "done", "20261101T080000Z-pr-t-0001-0.md")); err != nil {
		t.Fatal(err)
	}

	// Routines: every trigger, every approval state, every refusal.
	routine := func(name, text string) { w.write(filepath.Join(acme, "routines", name), text) }
	routine("pr-followup.md", "+++\non = \"pr\"\nevents = [\"checks-failed\", \"review\"]\nenabled = true\n+++\n\nFix the failing checks.\n")
	routine("all-pr.md", "+++\non = \"pr\"\n+++\n\nEvery event.\n")
	routine("standup.md", "+++\nschedule = \"every 30m\"\n+++\n\nSay hi.\n")
	routine("nightly.md", "+++\nschedule = \" daily 09:05 \"\ncommand = \"  make report  \"\n+++\nRun the report.\n")
	routine("unapproved.md", "+++\nschedule = \"every 2h\"\ncommand = \"rm -rf nothing\"\nenabled = false\n+++\n")
	routine("weekly.md", "+++\nschedule = \"every 7d\"\nextra_key = 1\n+++")
	routine("bad-schedule.md", "+++\nschedule = \"every x\"\n+++\n")
	routine("bad-unit.md", "+++\nschedule = \"every 5w\"\n+++\n")
	routine("bad-hour.md", "+++\nschedule = \"daily 25:00\"\n+++\n")
	routine("bad-minute.md", "+++\nschedule = \"daily 10:aa\"\n+++\n")
	routine("bad-daily.md", "+++\nschedule = \"daily noon\"\n+++\n")
	routine("bad-word.md", "+++\nschedule = \"hourly\"\n+++\n")
	routine("bad-event.md", "+++\non = \"pr\"\nevents = [\"opened\", \"closed\"]\n+++\n")
	routine("bad-on.md", "+++\non = \"push\"\n+++\n")
	routine("pr-command.md", "+++\non = \"pr\"\ncommand = \"echo\"\n+++\n")
	routine("no-front.md", "Just a prompt.\n")
	routine("no-close.md", "+++\nschedule = \"every 1h\"\n")
	routine("Upper.md", "+++\nschedule = \"every 1h\"\n+++\n")
	routine(".hidden.md", "+++\nschedule = \"every 1h\"\n+++\n")
	routine("wrong-type.md", "+++\nschedule = \"every 1h\"\nenabled = \"yes\"\n+++\n")
	routine("readme.txt", "not a routine")
	w.symlink(filepath.Join(acme, "routines", "standup.md"), filepath.Join(acme, "routines", "linked.md"))

	// Live panes and agents in s1, matched to the records below.
	var agents, panes []map[string]any
	add := func(pane, name, kind, status, cwd, terminal string) {
		agents = append(agents, agentRow(pane, "w2", name, kind, status, cwd, terminal, len(agents)+1))
		panes = append(panes, paneRow(pane, "w2", cwd, terminal))
	}
	agents = append(agents, agentRow("w1:p1", "w1", "hpc-acme-web", "claude", "idle", acme, "term-c", 4))
	panes = append(panes, paneRow("w1:p1", "w1", acme, "term-c"))
	add("w2:p7", "hp-acme-web-t-0007", "claude", "blocked", rep("t-0007"), "term-7")
	add("w2:p8", "hp-acme-web-t-0008", "claude", "blocked", rep("t-0008"), "term-8")
	add("w2:p9", "hp-acme-web-t-0009", "codex", "working", rep("t-0009"), "term-9")
	add("w2:p10", "hp-acme-web-t-0010", "claude", "idle", rep("t-0010"), "term-10")
	add("w2:p11", "hp-acme-web-t-0011", "claude", "done", rep("t-0011"), "term-11")
	add("w2:p12", "hp-acme-web-t-0012", "claude", "idle", rep("t-0012"), "term-12")
	add("w2:p13", "hp-acme-web-t-0013", "claude", "working", rep("t-0013"), "term-13")
	add("w2:p14", "hp-acme-web-t-0014", "claude", "unknown", rep("t-0014"), "term-14")
	add("w2:p15", "hp-acme-web-t-0015", "claude", "idle", rep("t-0015"), "term-15")
	add("w2:p16", "hp-acme-web-t-0016", "claude", "idle", rep("t-0016"), "term-16")
	add("w2:p17", "hp-acme-web-t-0017", "claude", "idle", rep("t-0017"), "term-17")
	add("w2:p18", "hp-acme-web-t-0018", "claude", "idle", rep("t-0018"), "term-18")
	add("w2:p19", "hp-acme-web-t-0019", "claude", "idle", rep("t-0019"), "term-19")
	add("w2:p20", "hp-acme-web-t-0020", "claude", "idle", rep("t-0020"), "term-20")
	add("w2:p21", "hp-acme-web-t-0021", "claude", "idle", rep("t-0021"), "term-21")
	add("w2:p24", "someone-else", "codex", "working", rep("t-0024"), "term-24")
	add("w2:p25", "renamed-by-user", "claude", "working", rep("t-0025"), "term-25")
	add("w2:p26", "", "claude", "idle", rep("t-0026"), "term-26")
	add("w2:p27", "other-name", "claude", "idle", rep("t-0027"), "term-27")
	add("w2:p29", "hp-acme-web-t-0029", "claude", "idle", rep("t-0029"), "term-29")
	add("w2:p30", "hp-acme-web-t-0030", "claude", "working", rep("t-0030"), "term-30")
	add("w2:p34", "hp-acme-web-t-00034", "claude", "blocked", rep("t-00034"), "term-34")
	panes = append(panes, paneRow("w2:p28", "w2", rep("t-0028"), "term-28")) // a shell, no agent
	// Another project's coordinator run from a shell whose cwd is acme-web:
	// its own (foreground) folder decides, so it is not acme-web's (0.2.35).
	other := agentRow("w3:p1", "w3", "hpc-zeta", "claude", "idle", acme, "term-z", 99)
	other["foreground_cwd"] = w.project("zeta-unicode")
	agents = append(agents, other)
	otherPane := paneRow("w3:p1", "w3", acme, "term-z")
	otherPane["foreground_cwd"] = w.project("zeta-unicode")
	panes = append(panes, otherPane)
	w.session(s1, agents, panes)

	// Self-reports from the agents' own `report` calls.
	w.progress(s1, "w2:p16", "term-16", map[string]any{"activity": "Waiting for you", "percent": 30, "reported_at": w.unix(10 * time.Second)})
	w.progress(s1, "w2:p17", "term-17", map[string]any{"activity": "Writing code", "percent": 40, "reported_at": w.unix(20 * time.Second)})
	w.progress(s1, "w2:p18", "term-18", map[string]any{"activity": "Writing code", "percent": 40, "reported_at": w.unix(2 * time.Hour)})
	w.progress(s1, "w2:p19", "term-19", map[string]any{"activity": "Done", "percent": 100, "reported_at": w.unix(30 * time.Second)})
	w.progress(s1, "w2:p29", "another-terminal", map[string]any{"activity": "Waiting for you", "reported_at": w.unix(5 * time.Second)})
	w.progress(s1, "w2:p30", "", map[string]any{"activity": "Waiting for you", "reported_at": w.unix(5 * time.Second)})
	w.progress(s2, "w2:p17", "term-17", map[string]any{"activity": "Waiting for you", "reported_at": w.unix(5 * time.Second)}) // another session's
	w.write(filepath.Join(w.root, ".progress", "garbage.json"), "{not json")

	old := w.ago(48 * time.Hour)
	base := func(id, title, status, cwd, pane, extra string) []string {
		lines := []string{
			fmt.Sprintf("id = %q", id), fmt.Sprintf("title = %q", title), fmt.Sprintf("status = %q", status),
			`kind = "worktree"`, `repo = "/r/acme-web"`, fmt.Sprintf("branch = \"hp/acme-web/%s-x\"", id),
			fmt.Sprintf("worktree_path = %q", cwd), fmt.Sprintf("thread_dir = %q", cwd+"/.herdr-project/acme-web-"+id),
			`workspace_id = "w2"`, `tab_id = "w2:t1"`, fmt.Sprintf("pane_id = %q", pane), `agent = "claude"`,
			fmt.Sprintf("agent_name = \"hp-acme-web-%s\"", id), fmt.Sprintf("cwd = %q", cwd),
			fmt.Sprintf("created = %q", old), fmt.Sprintf("updated = %q", old),
		}
		if extra == "" {
			return lines
		}
		// A key in extra replaces the base line (TOML refuses duplicates).
		more := strings.Split(extra, "\n")
		keys := map[string]bool{}
		for _, l := range more {
			if k, _, ok := strings.Cut(l, " = "); ok {
				keys[k] = true
			}
		}
		kept := lines[:0]
		for _, l := range lines {
			if k, _, _ := strings.Cut(l, " = "); !keys[k] {
				kept = append(kept, l)
			}
		}
		return append(kept, more...)
	}
	th := func(id, title, status, extra string) {
		pane := "w2:p" + strings.TrimLeft(strings.TrimPrefix(id, "t-"), "0")
		w.thread("acme-web", id, base(id, title, status, rep(id), pane, extra)...)
	}
	th("t-0001", "Resolved and merged", "resolved", `resolved_reason = "merged: PR #1"`+"\n"+`last_group = "resolved"`)
	th("t-0002", "Starting, young", "starting", "prompt_pending = true\ncreated = \""+w.ago(time.Minute)+"\"")
	th("t-0003", "Starting, stuck", "starting", "prompt_pending = true")
	th("t-0004", "Failed launch", "failed", `error = "agent start: kind not installed"`)
	th("t-0005", "Pane closed, no report", "open", `last_group = "working"`)
	th("t-0006", "Pane closed after its report", "open", `report_hash = "aa"`+"\n"+`acked_report_hash = "aa"`)
	th("t-0007", "Blocked a long time", "open", `last_state = "blocked"`+"\n"+`last_state_change = "`+old+`"`)
	th("t-0008", "Blocked a moment ago", "open", `last_state = "blocked"`+"\n"+`last_state_change = "`+w.ago(5*time.Second)+`"`)
	th("t-0009", "Working away", "open", `agent = "codex"`+"\n"+`profile = "fast"`+"\n"+`percent = 55`+"\n"+`activity = "Writing tests"`+"\n"+`state_line = "working · ~55%"`)
	th("t-0010", "Report waiting for review", "open", `report_hash = "r10"`+"\n"+`acked_report_hash = ""`)
	th("t-0011", "Approved PR", "open", `pr = "https://example.invalid/acme/web/pull/4"`+"\n"+`pr_state = "OPEN"`+"\n"+`pr_review = "APPROVED"`+"\n"+`report_hash = "r11"`)
	th("t-0012", "Open PR, report read", "open", `pr_state = "open"`+"\n"+`report_hash = "r12"`+"\n"+`acked_report_hash = "r12"`)
	th("t-0013", "Working with an unread report", "open", `report_hash = "r13"`)
	th("t-0014", "Launch stuck on a dialog", "open", `prompt_pending = true`+"\n"+`last_state = "unknown"`+"\n"+`last_state_change = "`+old+`"`)
	th("t-0015", "Brief stuck", "open", "prompt_pending = true\nbrief_stuck = true\nbrief_attempts = 3")
	th("t-0016", "Says it waits for you", "open", "")
	th("t-0017", "Self-reported progress", "open", "")
	th("t-0018", "Stale self-report", "open", "")
	th("t-0019", "Self-reported done", "open", "")
	// t-0020: a report the ticker has not hashed yet, in a real folder.
	th("t-0020", "Fresh local report", "open", "")
	w.write(filepath.Join(rep("t-0020"), ".herdr-project", "acme-web-t-0020", "report.md"), "PR: none\n\n## Report\n\nDone.\n")
	// t-0021: the thread folder is a symbolic link: its report is not read.
	th("t-0021", "Linked thread folder", "open", "")
	w.mkdir(filepath.Join(w.dir, "elsewhere"))
	w.write(filepath.Join(w.dir, "elsewhere", "report.md"), "x")
	w.symlink(filepath.Join(w.dir, "elsewhere"), filepath.Join(rep("t-0021"), ".herdr-project", "acme-web-t-0021"))
	th("t-0022", "Remote, polled", "open", `machine = "gpu-box"`+"\n"+`last_state = "working"`+"\n"+`last_group = "working"`+"\n"+`remote_profile = true`+"\n"+`profile_args = ["--model", "x"]`)
	th("t-0023", "Remote, not polled yet", "open", `machine = "gpu-box"`+"\n"+`kind = "tab"`)
	th("t-0024", "Pane taken by another agent", "open", "")
	th("t-0025", "Adopted pane", "open", `kind = "adopted"`+"\n"+`agent_name = ""`)
	th("t-0026", "Resumed without its name", "open", "")
	th("t-0027", "Pane renamed by someone", "open", "")
	th("t-0028", "Shell left in the pane", "open", `report_hash = "r28"`+"\n"+`acked_report_hash = "r28"`)
	th("t-0029", "Self-report from another terminal", "open", "")
	th("t-0030", "Ünïcode title — 日本語 🚀\tand a tab", "open", "unknown_field = \"kept\"\n[future_table]\nx = 1")
	w.thread("acme-web", "t-0031", `id = "t-0031"`, `title = "broken`)
	th("t-0032", "Percent out of range", "open", "percent = 300")
	th("t-0033", "Unknown status", "weird", "")
	th("t-0035", "Wrong id inside", "open", "")
	w.thread("acme-web", "t-0036", `title = "Missing id field"`, `status = "open"`)
	th("t-0037", "Tab thread", "open", `kind = "tab"`+"\n"+`branch = ""`+"\n"+`last_group = "idle"`)
	th("t-0038", "Checkout thread", "open", `kind = "checkout"`+"\n"+`branch = ""`)
	th("t-0039", "Agent args and starting old", "starting", `agent_args = ["--model", "opus"]`+"\n"+`launch_attempts = 2`+"\n"+`launched_at = "`+old+`"`)
	w.thread("acme-web", "t-00034", base("t-00034", "Five-digit id, blocked", "open", rep("t-00034"), "w2:p34", `last_state = "blocked"`+"\n"+`last_state_change = "`+old+`"`)...)
	w.thread("acme-web", "t-1", `id = "t-1"`, `title = "short id"`)
	w.thread("acme-web", "notes", `id = "notes"`)
	w.write(filepath.Join(acme, "threads", "t-0040.toml.bak"), "id = \"t-0040\"\n")
	w.write(filepath.Join(acme, "threads", "t-0035.toml"), strings.Replace(strings.Join(base("t-0035", "Wrong id inside", "open", rep("t-0035"), "w2:p35", ""), "\n")+"\n", `id = "t-0035"`, `id = "t-9035"`, 1))

	// Home reports and Next lists.
	w.write(filepath.Join(acme, "threads", "t-0010.md"), "PR: https://example.invalid/acme/web/pull/3\n\n## Report\n\nDid it.\n\n## Next\n\n- Merge the PR\n* Star bullet\n1. Numbered line\n12. Two digits\n. dot only\n   \n- Remove the worktree and branch\n### Sub heading ends it\n- not next\n\n## Remember\n\n- nope\n")
	w.write(filepath.Join(acme, "threads", "t-0010.next.md"), "- Coordinator line\n\n- - Double dash\n  spaced  \n")
	w.write(filepath.Join(acme, "threads", "t-0012.md"), "## Next\r\n- CRLF line\r\n## Next \n- after a heading with a trailing space\n")
	w.write(filepath.Join(acme, "threads", "t-0006.md"), "## Report\n\nfinished\n")
	w.write(filepath.Join(acme, "threads", "t-0001.md"), "## Next\n\n- Resolved thread's next\n")
	w.write(filepath.Join(acme, "threads", "t-0009.task.md"), "Write the landing page.\n\n## Follow-ups\n\n### "+old+"\n\nAlso the footer.\n")
	w.write(filepath.Join(acme, "threads", "t-0017.next.md"), "only extra\n")

	zetaShell := agentRow("w6:p1", "w6", "hpc-acme-web-2", "claude", "idle", w.project("zeta-unicode"), "tz1", 1)
	zetaShell["foreground_cwd"] = acme

	// ---------------------------------------------------------- beta-tools
	// Paused, no coordinator record: the default session (s2) is asked,
	// and an agent working in the folder makes it reachable.
	w.skeleton("beta-tools")
	w.projectMD("beta-tools", "name = \"beta-tools\"\ngoal = \"\"\ncoordinator_profile = \"deep\"\n")
	w.write(filepath.Join(beta, ".state", "project.json"), "{\"status\": \"paused\"}\n")
	w.write(filepath.Join(beta, "TASKS.md"), "# Tasks\n\n## Backlog\n")
	w.session(s2, []map[string]any{
		agentRow("w5:p1", "w5", "hpc-beta-tools", "claude", "working", beta, "tb1", 3),
		agentRow("w5:p2", "w5", "hp-beta-tools-t-0001", "claude", "idle", "/wt/beta/t-0001", "tb2", 9),
		// acme-web's coordinator, run by `open` from a shell whose folder is
		// zeta-unicode: 0.2.34 counted it as working in zeta-unicode (and so
		// reached zeta's session); 0.2.35 judges by the foreground folder only.
		zetaShell,
	}, []map[string]any{paneRow("w5:p1", "w5", beta, "tb1"), paneRow("w5:p2", "w5", "/wt/beta/t-0001", "tb2")})
	w.thread("beta-tools", "t-0001", `id = "t-0001"`, `title = "Beta idle"`, `status = "open"`, `kind = "tab"`, `pane_id = "w5:p2"`, `cwd = "/wt/beta/t-0001"`, `agent = "claude"`, `agent_name = "hp-beta-tools-t-0001"`, `created = "`+old+`"`)
	w.thread("beta-tools", "t-0002", `id = "t-0002"`, `title = "Beta resolved"`, `status = "resolved"`, `resolved_reason = ""`)

	// ---------------------------------------------------------- gamma-lab
	// Archived: hidden from `list` and `overview` unless asked for.
	w.skeleton("gamma-lab")
	w.projectMD("gamma-lab", "name = \"Gamma Lab\"\n")
	w.write(filepath.Join(w.project("gamma-lab"), ".state", "project.json"), "{\"status\":\"archived\",\"former_slugs\":[]}")
	w.thread("gamma-lab", "t-0001", `id = "t-0001"`, `title = "Archived work"`, `status = "open"`, `last_group = "ready-for-review"`)

	// ---------------------------------------------------------- delta-ops
	// No coordinator and nobody works in the folder: session unreachable.
	// PROJECT.md closes at end of file; project.json does not parse.
	w.mkdir(filepath.Join(w.project("delta-ops"), ".state"))
	w.write(filepath.Join(w.project("delta-ops"), "PROJECT.md"), "+++\ngoal = \"Delta goal\"\n+++")
	w.write(filepath.Join(w.project("delta-ops"), ".state", "project.json"), "{\"status\":\"Archived\"}")
	w.thread("delta-ops", "t-0001", `id = "t-0001"`, `title = "Unreachable, recorded working"`, `status = "open"`, `last_group = "working"`)
	w.thread("delta-ops", "t-0002", `id = "t-0002"`, `title = "Unreachable, pending"`, `status = "open"`, `prompt_pending = true`)
	w.thread("delta-ops", "t-0003", `id = "t-0003"`, `title = "Unreachable, failed"`, `status = "failed"`, `last_group = "bogus"`)

	// ---------------------------------------------------------- epsilon
	// PROJECT.md without a closing line: listed, but its settings fail.
	w.mkdir(filepath.Join(w.project("epsilon"), "threads"))
	w.write(filepath.Join(w.project("epsilon"), "PROJECT.md"), "+++\nname = \"Epsilon\"\n")
	w.write(filepath.Join(w.project("epsilon"), "MEMORY.md"), "")

	// ---------------------------------------------------------- zeta-unicode
	// Recorded socket is gone: falls back to the default session, where
	// nobody works in it (another agent's shell cwd is here, but its own
	// folder is elsewhere).
	w.skeleton("zeta-unicode")
	w.projectMD("zeta-unicode", "name = \"Zéta Ünïcode 🚀\"\ngoal = \"Ünïcode goal — “quotes”\"\ncoordinator_profile = \"fast\"\nthread_agent = \"deep\"\n\n[[repos]]\npath = \"/r/zéta\"\nextra = true\n")
	w.json(filepath.Join(w.project("zeta-unicode"), ".state", "coordinator.json"), map[string]any{"socket": sGone, "cwd": w.project("zeta-unicode")})
	w.write(filepath.Join(w.project("zeta-unicode"), "TASKS.md"), "")
	w.write(filepath.Join(w.project("zeta-unicode"), "uploads", "ünï.txt"), "x")
	w.thread("zeta-unicode", "t-0001", `id = "t-0001"`, `title = "Zeta thread"`, `status = "open"`, `last_group = "idle"`, `pane_id = "w6:p9"`, `cwd = "/wt/zeta"`)

	// ---------------------------------------------------------- eta-down
	// Recorded socket exists but its server does not answer.
	w.skeleton("eta-down")
	w.projectMD("eta-down", "")
	w.json(filepath.Join(w.project("eta-down"), ".state", "coordinator.json"), map[string]any{"socket": s3})
	w.thread("eta-down", "t-0001", `id = "t-0001"`, `title = "Down"`, `status = "open"`, `last_group = "waiting-on-you"`, `pane_id = "w9:p1"`)

	// ---------------------------------------------------------- theta-empty
	// Bare PROJECT.md and nothing else: no threads folder at all.
	w.write(filepath.Join(w.project("theta-empty"), "PROJECT.md"), "+++\n+++\n")

	// ---------------------------------------------------------- iota-wrongtype
	// Front matter with a wrong type and duplicate alias: settings fail.
	w.mkdir(filepath.Join(w.project("iota-wrongtype"), "threads"))
	w.write(filepath.Join(w.project("iota-wrongtype"), "PROJECT.md"), "+++\nmax_parallel_threads = \"ten\"\n+++\nbody\n")

	// Not projects: bad slug, hidden folder, no PROJECT.md, a plain file,
	// PROJECT.md that is a folder.
	w.write(filepath.Join(w.root, "Bad_Slug", "PROJECT.md"), "+++\n+++\n")
	w.write(filepath.Join(w.root, ".hidden", "PROJECT.md"), "+++\n+++\n")
	w.mkdir(filepath.Join(w.root, "no-project-md", "threads"))
	w.write(filepath.Join(w.root, "a-file"), "x")
	w.mkdir(filepath.Join(w.root, "dir-project-md", "PROJECT.md"))

	w.slugs = []string{"acme-web", "beta-tools", "gamma-lab", "delta-ops", "epsilon", "zeta-unicode", "eta-down", "theta-empty", "iota-wrongtype"}
	w.extra = [][]string{
		{"context", "nope", "--peek"},
		{"context", "Bad_Slug", "--peek"},
		{"thread", "list", "nope", "--json"},
		{"thread", "list", "no-project-md"},
		{"overview", "nope"},
		// `overview` inside a herdr pane: the workspace's project.
		{"HERDR_WORKSPACE_ID=w2", "HERDR_SOCKET_PATH=" + s1, "overview"},                        // by a worktree thread's folder
		{"HERDR_WORKSPACE_ID=w1", "HERDR_SOCKET_PATH=" + s1, "HERDR_PANE_ID=w1:p1", "overview"}, // by the project folder
		{"HERDR_WORKSPACE_ID=w3", "HERDR_SOCKET_PATH=" + s1, "overview"},                        // foreground folder first, then the shell's
		{"HERDR_WORKSPACE_ID=w99", "HERDR_SOCKET_PATH=" + s1, "overview"},                       // no project: all of them
		{"HERDR_WORKSPACE_ID=w5", "HERDR_SOCKET_PATH=" + s2, "overview"},                        // nobody recorded that socket
		{"HERDR_WORKSPACE_ID=w1", "overview"},                                                   // no socket: all
	}
	return w
}

// buildBrokenConfig: a profile that does not validate and a bad safety
// value; no machine cache, so `context` looks machines up (none here).
func buildBrokenConfig(t *testing.T) *world {
	w := newWorld(t, "broken-config")
	w.tool("claude")
	w.write(filepath.Join(w.home, ".config", "herdr-projects", "config.toml"), "[profiles.bad]\nagent = \"nope\"\n\n[safety.default]\nstart_threads = \"sometimes\"\n")
	w.skeleton("one")
	w.projectMD("one", "name = \"One\"\n")
	w.write(filepath.Join(w.project("one"), "MEMORY.md"), "# Memory\n")
	w.write(filepath.Join(w.project("one"), "routines", "cmd.md"), "+++\nschedule = \"every 1h\"\ncommand = \"true\"\n+++\n")
	w.skeleton("two")
	w.projectMD("two", "name = \"Two\"\n")
	w.write(filepath.Join(w.home, ".config", "herdr-projects", "approved-routines.json"), "not json")
	w.slugs = []string{"one", "two"}
	return w
}

// buildProfileErrors: each validation refusal of a [profiles] table, one
// world each, so every message is compared.
func buildProfileError(t *testing.T, name, table string) *world {
	w := newWorld(t, "profile-"+name)
	w.write(filepath.Join(w.home, ".config", "herdr-projects", "config.toml"), table)
	w.skeleton("solo")
	w.projectMD("solo", "")
	w.slugs = []string{"solo"}
	return w
}

// buildSafetyOnly: yolo from the default table, trust screens set, empty
// allow-lists, no profiles table; signed in by variables only.
func buildSafetyOnly(t *testing.T) *world {
	w := newWorld(t, "safety-only")
	w.tool("claude")
	w.tool("gemini")
	w.tool("cursor-agent")
	w.tool("pi")
	w.write(filepath.Join(w.home, ".cursor", "cli-config.json"), "{}")
	w.mkdir(filepath.Join(w.home, ".pi", "agent"))
	w.write(filepath.Join(w.home, ".pi", "agent", "auth.json"), "{}")
	w.write(filepath.Join(w.home, ".claude.json"), "{\"oauthAccount\": {}}")
	w.write(filepath.Join(w.home, ".config", "herdr-projects", "config.toml"), "[safety.default]\nyolo = true\ntrust_screens = \"user\"\nthread_profiles = []\ncoordinator_agent_args = [\"--dangerously\"]\n")
	w.skeleton("solo")
	w.projectMD("solo", "thread_profile = \"claude\"\n")
	w.slugs = []string{"solo"}
	return w
}

// buildEmpty: the root does not exist at all.
func buildEmpty(t *testing.T) *world {
	w := newWorld(t, "empty")
	w.extra = [][]string{{"overview", "anything"}}
	return w
}
