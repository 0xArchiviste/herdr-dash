// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	startingTimeoutSecs = 300
	blockedDebounceSecs = 30
	notReadySecs        = 60
	activityTTLSecs     = 300
	progressWaiting     = "Waiting for you"
)

// Thread is threads/<id>.toml. An empty string means unset. Fields are in
// the Rust struct's order; Extra keeps keys 0.2.35 does not know.
type Thread struct {
	ID, Title, Status, Error                                   string
	PromptPending                                              bool
	LaunchAttempts                                             uint32
	LaunchedAt                                                 string
	BriefAttempts                                              uint32
	BriefClaimed, BriefSeen, BriefSeenAt                       string
	BriefStuck                                                 bool
	Kind, Repo, Origin, Branch, Base, Machine                  string
	WorktreePath, ThreadDir, WorkspaceID, RepoWorkspace, TabID string
	PaneID, Agent, Profile                                     string
	AgentArgs                                                  []string
	RemoteProfile                                              bool
	ProfileArgs                                                []string
	AgentName, Cwd, Created, Updated, LastState                string
	LastStateChange, LastGroup, ReportHash, LastReportChange   string
	LastReviewItemHash, AckedReportHash, PR, PRState, PRReview string
	ResolvedReason, StateLine                                  string
	KeptWorktree                                               bool
	Activity                                                   string
	Percent                                                    *int64
	Extra                                                      map[string]any
	Raw                                                        string // the file as read
}

func (t *Thread) IsRemote() bool { return t.Machine != "" }

// ValidateThreadID: `t-` and at least four ASCII digits.
func ValidateThreadID(id string) error {
	digits, _ := strings.CutPrefix(id, "t-")
	if !strings.HasPrefix(id, "t-") {
		digits = ""
	}
	ok := len(digits) >= 4
	for _, c := range digits {
		if c < '0' || c > '9' {
			ok = false
		}
	}
	if !ok {
		return fmt.Errorf("`%s` is not a thread id (expected the form t-0001)", id)
	}
	return nil
}

func parseThread(text string) (*Thread, error) {
	m, err := decodeTOML(text)
	if err != nil {
		return nil, err
	}
	o := newObj(m)
	u32 := func(k string) uint32 { return uint32(o.integer(k, 0, 1<<32-1, 0)) }
	t := &Thread{
		ID: o.str("id", ""), Title: o.str("title", ""), Status: o.str("status", "starting"), Error: o.str("error", ""),
		PromptPending: o.boolean("prompt_pending", false), LaunchAttempts: u32("launch_attempts"),
		LaunchedAt: o.str("launched_at", ""), BriefAttempts: u32("brief_attempts"),
		BriefClaimed: o.str("brief_claimed", ""), BriefSeen: o.str("brief_seen", ""), BriefSeenAt: o.str("brief_seen_at", ""),
		BriefStuck: o.boolean("brief_stuck", false), Kind: o.str("kind", "worktree"), Repo: o.str("repo", ""),
		Origin: o.str("origin", ""), Branch: o.str("branch", ""), Base: o.str("base", ""), Machine: o.str("machine", ""),
		WorktreePath: o.str("worktree_path", ""), ThreadDir: o.str("thread_dir", ""), WorkspaceID: o.str("workspace_id", ""),
		RepoWorkspace: o.str("repo_workspace", ""), TabID: o.str("tab_id", ""), PaneID: o.str("pane_id", ""),
		Agent: o.str("agent", ""), Profile: o.str("profile", ""), AgentArgs: o.strings("agent_args"),
		RemoteProfile: o.boolean("remote_profile", false), ProfileArgs: o.strings("profile_args"),
		AgentName: o.str("agent_name", ""), Cwd: o.str("cwd", ""), Created: o.str("created", ""), Updated: o.str("updated", ""),
		LastState: o.str("last_state", ""), LastStateChange: o.str("last_state_change", ""), LastGroup: o.str("last_group", ""),
		ReportHash: o.str("report_hash", ""), LastReportChange: o.str("last_report_change", ""),
		LastReviewItemHash: o.str("last_review_item_hash", ""), AckedReportHash: o.str("acked_report_hash", ""),
		PR: o.str("pr", ""), PRState: o.str("pr_state", ""), PRReview: o.str("pr_review", ""),
		ResolvedReason: o.str("resolved_reason", ""), StateLine: o.str("state_line", ""),
		KeptWorktree: o.boolean("kept_worktree", false), Activity: o.str("activity", ""),
		Percent: o.optInt("percent", 0, 255),
	}
	switch t.Status {
	case "starting", "open", "failed", "resolved":
	default:
		o.fail("unknown variant `%s`, expected one of `starting`, `open`, `failed`, `resolved`", t.Status)
	}
	switch t.Kind {
	case "worktree", "tab", "checkout", "adopted":
	default:
		o.fail("unknown variant `%s`, expected one of `worktree`, `tab`, `checkout`, `adopted`", t.Kind)
	}
	if o.err != nil {
		return nil, o.err
	}
	t.Extra = o.extra()
	t.Raw = text
	return t, nil
}

func (p *Project) threadsDir() string { return filepath.Join(p.Dir(), "threads") }

func (p *Project) RecordPath(id string) string     { return filepath.Join(p.threadsDir(), id+".toml") }
func (p *Project) TaskPath(id string) string       { return filepath.Join(p.threadsDir(), id+".task.md") }
func (p *Project) HomeReportPath(id string) string { return filepath.Join(p.threadsDir(), id+".md") }
func (p *Project) ExtraNextPath(id string) string {
	return filepath.Join(p.threadsDir(), id+".next.md")
}

// LoadThread reads one record.
func (p *Project) LoadThread(id string) (*Thread, error) {
	if err := ValidateThreadID(id); err != nil {
		return nil, err
	}
	path := p.RecordPath(id)
	text, err := readText(path)
	if err != nil {
		return nil, fmt.Errorf("no thread `%s` in `%s`: %w", id, p.Slug, err)
	}
	t, err := parseThread(text)
	if err != nil {
		return nil, fmt.Errorf("%s does not parse: %w", path, err)
	}
	return t, nil
}

// Threads lists every record that parses, sorted by its id field.
func (p *Project) Threads() []*Thread {
	names, err := dirNames(p.threadsDir())
	if err != nil {
		return nil
	}
	var out []*Thread
	for _, n := range names {
		id, ok := strings.CutSuffix(n, ".toml")
		if !ok {
			continue
		}
		if t, err := p.LoadThread(id); err == nil {
			out = append(out, t)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Task is the thread's task file (the task, then `## Follow-ups`).
func (p *Project) Task(id string) string {
	text, _ := readText(p.TaskPath(id))
	return text
}

// NextLines are a report's `## Next` lines, list markers removed.
func NextLines(report string) []string {
	lines := []string{}
	inside := false
	for _, line := range rustLines(report) {
		if strings.HasPrefix(line, "## ") {
			inside = rustTrim(line) == "## Next"
			continue
		}
		if !inside || strings.HasPrefix(line, "#") {
			if strings.HasPrefix(line, "#") {
				inside = false
			}
			continue
		}
		text := rustTrim(line)
		if rest, ok := strings.CutPrefix(text, "- "); ok {
			text = rest
		} else if rest, ok := strings.CutPrefix(text, "* "); ok {
			text = rest
		} else if n, rest, ok := strings.Cut(text, ". "); ok && allDigits(n) {
			text = rest
		}
		text = rustTrim(text)
		if text != "" {
			lines = append(lines, text)
		}
	}
	return lines
}

func allDigits(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// AllNext is the report's Next lines, then the coordinator's own.
func (p *Project) AllNext(id string) []string {
	report, _ := readText(p.HomeReportPath(id))
	lines := NextLines(report)
	extra, _ := readText(p.ExtraNextPath(id))
	for _, l := range rustLines(extra) {
		l = rustTrim(l)
		if l != "" {
			lines = append(lines, trimStartMatches(l, "- "))
		}
	}
	return lines
}

// ---------------------------------------------------------------- groups

// Group is where a thread sits in the overview.
type Group int

const (
	ReadyForReview Group = iota
	WaitingOnYou
	Working
	Landing
	Idle
	Resolved
)

var DisplayOrder = []Group{WaitingOnYou, ReadyForReview, Landing, Working, Idle, Resolved}

func (g Group) Rank() int {
	return map[Group]int{WaitingOnYou: 1, ReadyForReview: 2, Landing: 3, Working: 4, Idle: 5, Resolved: 6}[g]
}

func (g Group) Label() string {
	return [...]string{"Ready for review", "Waiting on you", "Working", "Landing", "Idle", "Resolved"}[g]
}

func (g Group) Token() string {
	return [...]string{"ready-for-review", "waiting-on-you", "working", "landing", "idle", "resolved"}[g]
}

func groupFromToken(token string) (Group, bool) {
	for g := ReadyForReview; g <= Resolved; g++ {
		if g.Token() == token {
			return g, true
		}
	}
	return 0, false
}

// Live is what herdr shows for a thread's pane right now.
type Live struct {
	PaneExists    bool
	AgentState    *string
	StateSecs     int64
	SelfReport    *ProgressRecord
	ReportAgeSecs int64
}

func (l Live) state() string {
	if l.AgentState == nil {
		return ""
	}
	return *l.AgentState
}

func (l Live) selfWaiting() bool {
	return l.SelfReport != nil && l.SelfReport.Waiting() && l.state() != "working"
}

func (l Live) selfWorking() bool {
	return l.SelfReport != nil && !l.SelfReport.Done() && !l.SelfReport.Waiting() && l.ReportAgeSecs < activityTTLSecs
}

// secondsSince parses an RFC 3339 timestamp; anything else is 0.
func secondsSince(ts string, now time.Time) int64 {
	t, err := parseTimestamp(ts)
	if err != nil {
		return 0
	}
	return now.Unix() - t.Unix()
}

func parseTimestamp(ts string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return t, nil
	}
	// jiff also takes a space or lower-case t and z.
	return time.Parse(time.RFC3339Nano, strings.ToUpper(strings.Replace(ts, " ", "T", 1)))
}

func readyState(s string) bool { return s == "idle" || s == "done" }

// GroupOf is thread::group: the first matching row wins.
func GroupOf(t *Thread, live Live, now time.Time) Group {
	state := live.AgentState
	hasReport := t.ReportHash != ""
	if t.Status == "resolved" {
		return Resolved
	}
	if t.Status == "starting" {
		if secondsSince(t.Created, now) < startingTimeoutSecs {
			return Working
		}
		return WaitingOnYou
	}
	stuck := t.PromptPending && (t.BriefStuck || (state != nil && !readyState(*state) && live.StateSecs >= notReadySecs))
	if t.Status == "failed" || (!live.PaneExists && !hasReport) || stuck {
		return WaitingOnYou
	}
	if (state != nil && *state == "blocked" && live.StateSecs >= blockedDebounceSecs) || live.selfWaiting() {
		return WaitingOnYou
	}
	prOpen := strings.EqualFold(t.PRState, "open")
	if prOpen && strings.EqualFold(t.PRReview, "approved") {
		return Landing
	}
	working := state != nil && *state == "working"
	newReport := hasReport && t.ReportHash != t.AckedReportHash
	if (newReport || (hasReport && prOpen)) && !t.PromptPending && !working {
		return ReadyForReview
	}
	if working || (state != nil && *state == "blocked") || t.PromptPending || live.selfWorking() {
		return Working
	}
	return Idle
}

func paneMatches(t *Thread, p Pane) bool { return p.PaneID == t.PaneID && p.Cwd == t.Cwd }

func agentMatches(t *Thread, a Agent) bool {
	ids := a.PaneID == t.PaneID && a.Cwd == t.Cwd
	if t.Kind == "adopted" {
		return ids
	}
	return ids && (t.Agent == "" || a.Agent == "" || a.Agent == t.Agent) && (a.Name == "" || a.Name == t.AgentName)
}

// LiveState computes Live from one agent list and one pane list.
func LiveState(t *Thread, agents []Agent, panes []Pane, now time.Time) Live {
	var agent *Agent
	for i := range agents {
		if agentMatches(t, agents[i]) {
			agent = &agents[i]
			break
		}
	}
	exists := agent != nil
	if !exists {
		for _, p := range panes {
			if paneMatches(t, p) {
				exists = true
				break
			}
		}
	}
	foreign := false
	if agent == nil && t.Kind != "adopted" {
		for _, a := range agents {
			if a.PaneID == t.PaneID {
				foreign = true
				break
			}
		}
	}
	l := Live{PaneExists: exists && !foreign}
	if agent != nil {
		s := agent.AgentStatus
		l.AgentState = &s
		if s == t.LastState {
			l.StateSecs = secondsSince(t.LastStateChange, now)
		}
	}
	return l
}

// LiveWithReport adds the agent's own report from <root>/.progress/.
func LiveWithReport(t *Thread, agents []Agent, panes []Pane, now time.Time, root, socket string) Live {
	l := LiveState(t, agents, panes, now)
	if t.IsRemote() || !l.PaneExists {
		return l
	}
	terminal := ""
	found := false
	for _, a := range agents {
		if agentMatches(t, a) {
			terminal, found = a.TerminalID, true
			break
		}
	}
	if !found {
		for _, p := range panes {
			if paneMatches(t, p) {
				terminal = p.TerminalID
				break
			}
		}
	}
	if rec := SelfReport(root, socket, t.PaneID, terminal); rec != nil {
		l.ReportAgeSecs = now.Unix() - rec.ReportedAt
		l.SelfReport = rec
	}
	return l
}

// LocalReportHash hashes report.md when it is a regular file in a real
// thread folder.
func LocalReportHash(t *Thread) (string, bool) {
	if t.ThreadDir == "" || !isRealDir(t.ThreadDir) {
		return "", false
	}
	report := filepath.Join(t.ThreadDir, "report.md")
	if !isRegular(report) {
		return "", false
	}
	b, err := readFileBytes(report)
	if err != nil {
		return "", false
	}
	return sha256Hex(b), true
}
