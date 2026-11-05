// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"fmt"
	"path/filepath"
	"strings"
)

// ProgressRecord is one pane's self-report, <root>/.progress/<pane>-<hash>.json.
type ProgressRecord struct {
	Socket, PaneID, TerminalID, Agent, Activity string
	Percent                                     *int64
	ReportedAt, RemindedAt, SessionStartedAt    int64
	SessionID                                   string
	Extra                                       map[string]any
}

func (r *ProgressRecord) Waiting() bool { return r.ReportedAt > 0 && r.Activity == progressWaiting }
func (r *ProgressRecord) Done() bool {
	return r.ReportedAt > 0 && r.Percent != nil && *r.Percent == 100
}
func (r *ProgressRecord) Reported() bool { return r.ReportedAt > 0 }

// ProgressPath: pane ids repeat across sessions, so the socket's hash is in the name.
func ProgressPath(root, socket, pane string) string {
	return filepath.Join(root, ".progress", fmt.Sprintf("%s-%s.json", strings.ReplaceAll(pane, ":", "_"), sha256Hex([]byte(socket))[:8]))
}

// LoadProgress reads one record; nil when missing or bad.
func LoadProgress(root, socket, pane string) *ProgressRecord {
	m, err := readJSONObj(ProgressPath(root, socket, pane))
	if err != nil {
		return nil
	}
	o := newObj(m)
	const i64max = 1<<63 - 1
	r := &ProgressRecord{
		Socket: o.str("socket", ""), PaneID: o.str("pane_id", ""), TerminalID: o.str("terminal_id", ""),
		Agent: o.str("agent", ""), Activity: o.str("activity", ""), Percent: o.optInt("percent", 0, 255),
		ReportedAt: o.integer("reported_at", -i64max-1, i64max, 0), RemindedAt: o.integer("reminded_at", -i64max-1, i64max, 0),
		SessionStartedAt: o.integer("session_started_at", -i64max-1, i64max, 0), SessionID: o.str("session_id", ""),
	}
	if o.err != nil {
		return nil
	}
	r.Extra = o.extra()
	return r
}

// SelfReport is the pane's record when it has reported and its terminal
// (when both know one) is the pane's.
func SelfReport(root, socket, pane, terminal string) *ProgressRecord {
	r := LoadProgress(root, socket, pane)
	if r == nil {
		return nil
	}
	if terminal != "" && r.TerminalID != "" && r.TerminalID != terminal {
		return nil
	}
	if !r.Reported() {
		return nil
	}
	return r
}
