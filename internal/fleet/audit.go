package fleet

// The fleet audit log: append-only JSONL, one line per project per action
// (and one per refused apply), at <root>/.fleet/audit.jsonl, inside the
// herdr-projects root next to the ticker's files (a dot-folder, so no
// project lists it). Lines older than 90 days are dropped by a rewrite at
// most once an hour; nothing else ever rewrites the file.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Keep is how long audit lines are kept.
const Keep = 90 * 24 * time.Hour

// AuditLine is one line of the log.
type AuditLine struct {
	TS       string   `json:"ts"`
	Actor    string   `json:"actor"`
	Batch    string   `json:"batch,omitempty"`
	Op       string   `json:"op"`
	Target   string   `json:"target,omitempty"`
	Args     []string `json:"args,omitempty"`
	Command  string   `json:"command,omitempty"`
	Text     string   `json:"text,omitempty"`
	Preview  string   `json:"preview,omitempty"` // the plan's hash
	Confirm  string   `json:"confirm,omitempty"` // the confirmation token
	Result   string   `json:"result"`            // ok failed refused queued not-attempted
	Reason   string   `json:"reason,omitempty"`
	Output   string   `json:"output,omitempty"`
	Error    string   `json:"error,omitempty"`
	Previous string   `json:"previous,omitempty"`
	Undo     *Undo    `json:"undo,omitempty"`
	UndoOf   string   `json:"undo_of,omitempty"`
}

// Audit is the log file.
type Audit struct {
	Path    string
	mu      sync.Mutex
	rotated time.Time
}

// DefaultAuditPath is <root>/.fleet/audit.jsonl.
func DefaultAuditPath(root string) string { return filepath.Join(root, ".fleet", "audit.jsonl") }

const maxField = 2000

func clip(s string) string {
	if len(s) > maxField {
		return s[:maxField] + "…"
	}
	return s
}

// Append writes lines, rotating first when the last rotation is an hour old.
func (a *Audit) Append(now time.Time, lines ...AuditLine) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if now.Sub(a.rotated) > time.Hour {
		a.rotateLocked(now)
	}
	if err := os.MkdirAll(filepath.Dir(a.Path), 0o700); err != nil {
		return err
	}
	var buf bytes.Buffer
	for _, l := range lines {
		if l.TS == "" {
			l.TS = now.UTC().Format(time.RFC3339)
		}
		l.Output, l.Error = clip(l.Output), clip(l.Error)
		b, err := json.Marshal(l)
		if err != nil {
			return err
		}
		buf.Write(b)
		buf.WriteByte('\n')
	}
	f, err := os.OpenFile(a.Path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(buf.Bytes())
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// Rotate drops lines older than Keep.
func (a *Audit) Rotate(now time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rotateLocked(now)
}

func (a *Audit) rotateLocked(now time.Time) {
	a.rotated = now
	b, err := os.ReadFile(a.Path)
	if err != nil {
		return
	}
	var keep bytes.Buffer
	dropped := 0
	for _, line := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var l struct{ TS string }
		if json.Unmarshal(line, &l) == nil {
			if t, err := time.Parse(time.RFC3339, l.TS); err == nil && now.Sub(t) > Keep {
				dropped++
				continue
			}
		}
		keep.Write(line)
		keep.WriteByte('\n')
	}
	if dropped == 0 {
		return
	}
	tmp := a.Path + ".tmp"
	if err := os.WriteFile(tmp, keep.Bytes(), 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, a.Path); err != nil {
		os.Remove(tmp)
	}
}

// Read returns every line, oldest first; unreadable lines are skipped.
func (a *Audit) Read() ([]AuditLine, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f, err := os.Open(a.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []AuditLine
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		var l AuditLine
		if json.Unmarshal(sc.Bytes(), &l) == nil {
			out = append(out, l)
		}
	}
	return out, sc.Err()
}

// UndoOf is the audit of batch as an UndoSource.
func UndoOf(lines []AuditLine, batch string) *UndoSource {
	u := &UndoSource{Batch: batch, Unknown: true}
	for _, l := range lines {
		if l.Batch == batch && l.Op != "apply" {
			u.Unknown = false
			u.Lines = append(u.Lines, l)
		}
		if l.UndoOf == batch && l.Result == "ok" {
			u.Undone = true
		}
	}
	return u
}
