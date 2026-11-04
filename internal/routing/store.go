package routing

// Store reads and writes routing.toml. A write is: process mutex, a
// cross-process lock on routing.toml.lock, re-read and compare the content
// hash with the revision the editor started from, apply a typed patch to the
// decoded document (so fields this version does not edit survive), validate
// the whole result, then temp file + fsync + rename + directory fsync, mode
// 0600. A symlinked file is never replaced and a directory others can write
// is never trusted. Comments are not kept when Dash saves (the file header
// says so); hand edits between loads are detected as conflicts.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/pelletier/go-toml/v2"
)

const (
	NoRevision  = "none" // the revision of a missing file
	maxFile     = 1 << 20
	maxOps      = 64
	lockTimeout = 5 * time.Second
	header      = "# herdr agent routing policy (herdr-dash reads it; see its README).\n# Hand edits are fine. herdr-dash rewrites this file when you save in its\n# Routing panel, and comments are not kept then.\n\n"
)

var (
	ErrConflict = errors.New("routing.toml changed since it was loaded")
	ErrUnsafe   = errors.New("unsafe routing.toml location")
)

// DefaultPath is $XDG_CONFIG_HOME/herdr-projects/routing.toml, else
// ~/.config/herdr-projects/routing.toml. A relative XDG_CONFIG_HOME is
// ignored, as the XDG spec says.
func DefaultPath(getenv func(string) string, home string) string {
	base := getenv("XDG_CONFIG_HOME")
	if base == "" || !filepath.IsAbs(base) {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "herdr-projects", "routing.toml")
}

type Store struct {
	Path string
	mu   sync.Mutex
}

func NewStore(path string) *Store { return &Store{Path: path} }

// Snapshot is the file as last read. Policy is nil when the file is
// missing, invalid or unreadable (Err).
type Snapshot struct {
	Exists   bool
	Revision string
	Raw      []byte
	Policy   *Policy
	Warnings []FieldError
	Errors   FieldErrors
	Err      error
	// WriteBlock says why a save would be refused before trying ("" if none).
	WriteBlock string
}

func revision(b []byte) string {
	h := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(h[:])[:16]
}

func (s *Store) Load() Snapshot {
	snap, _ := s.load()
	return snap
}

// load reads the file; the bool reports a symlinked file.
func (s *Store) load() (Snapshot, bool) {
	snap := Snapshot{Revision: NoRevision}
	if err := checkDir(filepath.Dir(s.Path), false); err != nil {
		snap.Err = err
		return snap, false
	}
	fi, err := os.Lstat(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return snap, false
	}
	if err != nil {
		snap.Err = fmt.Errorf("routing.toml: %w", err)
		return snap, false
	}
	link := fi.Mode()&os.ModeSymlink != 0
	if link {
		snap.WriteBlock = "routing.toml is a symlink: herdr-dash will not replace it. Edit the target by hand, or replace the link with a file."
		if fi, err = os.Stat(s.Path); err != nil {
			snap.Err = fmt.Errorf("%w: routing.toml is a dangling symlink", ErrUnsafe)
			return snap, link
		}
	}
	if !fi.Mode().IsRegular() || !ownedByMe(fi) {
		snap.Err = fmt.Errorf("%w: routing.toml is not a regular file owned by this user", ErrUnsafe)
		return snap, link
	}
	f, err := os.Open(s.Path)
	if err != nil {
		snap.Err = fmt.Errorf("routing.toml: %w", err)
		return snap, link
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		snap.Err = fmt.Errorf("routing.toml: %w", err)
		return snap, link
	}
	snap.Exists, snap.Raw, snap.Revision = true, b, revision(b)
	if len(b) > maxFile {
		snap.Errors = FieldErrors{{"(file)", "larger than 1 MiB"}}
		return snap, link
	}
	snap.Policy, snap.Warnings, snap.Errors = Parse(b)
	return snap, link
}

// checkDir refuses a config directory that is not a directory owned by this
// user, or that others can write (group write only with the user's own
// group, as with a 0002 umask and per-user groups). create makes it (0700) first.
func checkDir(dir string, create bool) error {
	if create {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("routing config directory: %w", err)
		}
	}
	real, err := filepath.EvalSymlinks(dir)
	if errors.Is(err, os.ErrNotExist) && !create {
		return nil
	}
	if err != nil {
		return fmt.Errorf("routing config directory: %w", err)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return fmt.Errorf("routing config directory: %w", err)
	}
	if !fi.IsDir() || !ownedByMe(fi) || !privateDir(fi) {
		return fmt.Errorf("%w: its directory must be owned by this user and not writable by others", ErrUnsafe)
	}
	return nil
}

// ScopeRef names a scope: empty is global, Project alone a project.
type ScopeRef struct {
	Project string `json:"project,omitempty"`
	Thread  string `json:"thread,omitempty"`
}

// Op is one typed change. set_mode replaces a mode's list at a scope,
// reset_mode removes it (the scope inherits again), set_enabled sets or
// (Enabled nil) removes enabled at the global or a project scope.
type Op struct {
	Op         string      `json:"op"`
	Scope      ScopeRef    `json:"scope"`
	Mode       string      `json:"mode,omitempty"`
	Candidates []Candidate `json:"candidates,omitempty"`
	Enabled    *bool       `json:"enabled,omitempty"`
}

// Apply saves ops if the file is still at revision expected. Errors:
// ErrConflict (wrapped), FieldErrors (nothing written), ErrUnsafe, or I/O.
func (s *Store) Apply(expected string, ops []Op) (Snapshot, error) {
	if len(ops) == 0 || len(ops) > maxOps {
		return Snapshot{}, FieldErrors{{"ops", fmt.Sprintf("send 1 to %d changes", maxOps)}}
	}
	if errs := checkOps(ops); len(errs) > 0 {
		return Snapshot{}, errs
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Dir(s.Path)
	if err := checkDir(dir, true); err != nil {
		return Snapshot{}, err
	}
	unlock, err := lockFile(s.Path+".lock", lockTimeout)
	if err != nil {
		return Snapshot{}, err
	}
	defer unlock()

	cur, link := s.load()
	switch {
	case cur.Err != nil:
		return cur, cur.Err
	case link:
		return cur, fmt.Errorf("%w: %s", ErrUnsafe, cur.WriteBlock)
	case cur.Revision != expected:
		return cur, fmt.Errorf("%w (now %s, edit started from %s)", ErrConflict, cur.Revision, expected)
	}
	m := map[string]any{"version": int64(Version)}
	if cur.Exists {
		m = nil
		if err := toml.Unmarshal(cur.Raw, &m); err != nil || m == nil {
			return cur, cur.Errors
		}
		if v, ok := m["version"].(int64); !ok || v != Version {
			return cur, cur.Errors
		}
	}
	for i, op := range ops {
		if err := apply(m, op); err != nil {
			return cur, FieldErrors{{fmt.Sprintf("ops[%d]", i), err.Error()}}
		}
	}
	prune(m)
	if _, _, errs := FromMap(m); len(errs) > 0 {
		return cur, errs
	}
	body, err := toml.Marshal(m)
	if err != nil {
		return cur, fmt.Errorf("encode routing.toml: %w", err)
	}
	b := append([]byte(header), body...)
	if err := writeAtomic(s.Path, b); err != nil {
		return cur, err
	}
	next, _ := s.load()
	return next, next.Err
}

func checkOps(ops []Op) FieldErrors {
	var errs FieldErrors
	for i, op := range ops {
		f := fmt.Sprintf("ops[%d]", i)
		bad := func(field, msg string) { errs = append(errs, FieldError{f + "." + field, msg}) }
		sc := op.Scope
		switch {
		case sc.Project != "" && !SlugRe.MatchString(sc.Project):
			bad("scope.project", "not a herdr project slug")
		case sc.Thread != "" && sc.Project == "":
			bad("scope.thread", "a thread scope needs its project")
		case sc.Thread != "" && !ThreadRe.MatchString(sc.Thread):
			bad("scope.thread", "not a thread id (t-0001)")
		}
		switch op.Op {
		case "set_mode", "reset_mode":
			if !IsMode(op.Mode) {
				bad("mode", "unknown mode; modes are planning, coding, crawl")
			}
			if op.Op == "reset_mode" && len(op.Candidates) > 0 {
				bad("candidates", "reset_mode takes no candidates")
			}
		case "set_enabled":
			if sc.Thread != "" {
				bad("scope.thread", "enabled is set per project or globally, not per thread")
			}
		default:
			bad("op", "unknown op; use set_mode, reset_mode or set_enabled")
		}
	}
	return errs
}

// sub returns t[k] as a table, making it when create is set.
func sub(t map[string]any, k string, create bool) (map[string]any, error) {
	switch x := t[k].(type) {
	case map[string]any:
		return x, nil
	case nil:
		if !create {
			return nil, nil
		}
		n := map[string]any{}
		t[k] = n
		return n, nil
	default:
		return nil, fmt.Errorf("%s is not a table in routing.toml", k)
	}
}

func scopeTable(m map[string]any, sc ScopeRef, create bool) (map[string]any, error) {
	if sc.Project == "" {
		return sub(m, "global", create)
	}
	path := []string{"projects", sc.Project}
	if sc.Thread != "" {
		path = append(path, "threads", sc.Thread)
	}
	t := m
	for _, k := range path {
		var err error
		if t, err = sub(t, k, create); err != nil || t == nil {
			return nil, err
		}
	}
	return t, nil
}

func apply(m map[string]any, op Op) error {
	create := op.Op == "set_mode" || (op.Op == "set_enabled" && op.Enabled != nil)
	t, err := scopeTable(m, op.Scope, create)
	if err != nil || t == nil {
		return err
	}
	switch op.Op {
	case "set_mode":
		modes, err := sub(t, "modes", true)
		if err != nil {
			return err
		}
		list := make([]any, 0, len(op.Candidates))
		for _, c := range op.Candidates {
			e := map[string]any{"provider": c.Provider, "profile": c.Profile}
			if c.Model != "" {
				e["model"] = c.Model
			}
			if c.Effort != "" {
				e["effort"] = c.Effort
			}
			if c.Context != 0 {
				e["context"] = c.Context
			}
			list = append(list, e)
		}
		modes[op.Mode] = list
	case "reset_mode":
		modes, err := sub(t, "modes", false)
		if err != nil || modes == nil {
			return err
		}
		delete(modes, op.Mode)
	case "set_enabled":
		if op.Enabled == nil {
			delete(t, "enabled")
		} else {
			t["enabled"] = *op.Enabled
		}
	}
	return nil
}

// prune drops the tables a reset left empty, so inheritance reads clearly.
func prune(m map[string]any) {
	dropEmpty := func(t map[string]any, k string) {
		if x, ok := t[k].(map[string]any); ok && len(x) == 0 {
			delete(t, k)
		}
	}
	if g, ok := m["global"].(map[string]any); ok {
		dropEmpty(g, "modes")
	}
	dropEmpty(m, "global")
	ps, ok := m["projects"].(map[string]any)
	if !ok {
		return
	}
	for slug, x := range ps {
		p, ok := x.(map[string]any)
		if !ok {
			continue
		}
		if ts, ok := p["threads"].(map[string]any); ok {
			for id, y := range ts {
				if th, ok := y.(map[string]any); ok {
					dropEmpty(th, "modes")
					dropEmpty(ts, id)
				}
			}
			dropEmpty(p, "threads")
		}
		dropEmpty(p, "modes")
		dropEmpty(ps, slug)
	}
	dropEmpty(m, "projects")
}

func writeAtomic(path string, b []byte) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".routing.toml.*.tmp")
	if err != nil {
		return fmt.Errorf("save routing.toml: %w", err)
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(tmp)
		}
	}()
	if err := f.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		return fmt.Errorf("save routing.toml: %w", err)
	}
	if _, err := io.Copy(f, bytes.NewReader(b)); err != nil {
		return fmt.Errorf("save routing.toml: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("save routing.toml: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("save routing.toml: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("save routing.toml: %w", err)
	}
	ok = true
	syncDir(dir)
	return nil
}
