package routing

// Config store, written before the store. Ways it could fail:
//
//	S1. A missing file is an error, or a save invents routing (enabled) the
//	    user never asked for.
//	S2. A save loses data: comments aside, a reserved or untouched field
//	    (caps, another scope's lists) disappears.
//	S3. Last writer wins: a stale expected revision, or an external edit
//	    between load and save, is overwritten instead of a conflict.
//	S4. Two writers with the same revision both succeed (no lock).
//	S5. An invalid result, an unsupported version on disk, or a bad op
//	    (unknown mode, thread without project, enabled on a thread) is
//	    written anyway, or half written.
//	S6. The file is not 0600, the new directory not private, or a temp file
//	    is left behind after a failure.
//	S7. A symlinked file is replaced (breaking a dotfile link or writing
//	    through to another target), or a group/world-writable directory is
//	    trusted.
//	S8. Reset to inherited leaves an empty list or empty tables behind.
//	S9. XDG_CONFIG_HOME is ignored, or a relative one is trusted.

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "herdr-projects")
	return NewStore(filepath.Join(dir, "routing.toml")), dir
}

func cand(provider, profile string) Candidate { return Candidate{Provider: provider, Profile: profile} }

func setMode(project, thread, mode string, cs ...Candidate) Op {
	return Op{Op: "set_mode", Scope: ScopeRef{Project: project, Thread: thread}, Mode: mode, Candidates: cs}
}

func noTemps(t *testing.T, dir string) {
	t.Helper()
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if n := e.Name(); n != "routing.toml" && n != "routing.toml.lock" {
			t.Errorf("left behind: %s", n)
		}
	}
}

func TestStoreMissingThenCreate(t *testing.T) {
	s, dir := newStore(t)
	snap := s.Load()
	if snap.Exists || snap.Revision != NoRevision || snap.Policy != nil || snap.Err != nil {
		t.Fatalf("missing file: %+v", snap)
	}
	snap, err := s.Apply(NoRevision, []Op{setMode("", "", "coding", cand("claude", "claude"), cand("codex", "codex"))})
	if err != nil {
		t.Fatal(err)
	}
	if !snap.Exists || snap.Revision == NoRevision || snap.Policy == nil {
		t.Fatalf("after save: %+v", snap)
	}
	// S1: saving a list does not switch routing on.
	if e := snap.Policy.Effective("alpha", "", "coding"); e.Enabled {
		t.Fatal("save enabled routing")
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(s.Path)
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("file mode %v", fi.Mode().Perm())
		}
		di, _ := os.Stat(dir)
		if di.Mode().Perm() != 0o700 {
			t.Errorf("dir mode %v", di.Mode().Perm())
		}
	}
	b, _ := os.ReadFile(s.Path)
	if !strings.Contains(string(b), "version = 1") {
		t.Errorf("no version line:\n%s", b)
	}
	again := s.Load()
	if again.Revision != snap.Revision {
		t.Errorf("load revision %s != save revision %s", again.Revision, snap.Revision)
	}
	noTemps(t, dir)
}

func TestStoreKeepsOtherFields(t *testing.T) {
	s, dir := newStore(t)
	os.MkdirAll(dir, 0o700)
	orig := `version = 1
[caps]
max_active = 2
[global]
enabled = true
[global.caps]
claude = 2
[[global.modes.planning]]
provider = "codex"
profile = "astra"
[projects.beta.caps]
max_active = 1
`
	os.WriteFile(s.Path, []byte(orig), 0o600)
	rev := s.Load().Revision
	snap, err := s.Apply(rev, []Op{setMode("alpha", "", "coding", cand("codex", "codex"))})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(s.Path)
	for _, want := range []string{"max_active = 2", "claude = 2", "astra", "[projects.beta.caps]", "enabled = true"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("lost %q:\n%s", want, b)
		}
	}
	if got := profiles(snap.Policy.Effective("alpha", "", "coding").Candidates); len(got) != 1 || got[0] != "codex/codex" {
		t.Errorf("alpha coding = %v", got)
	}
}

func TestStoreConflicts(t *testing.T) {
	s, _ := newStore(t)
	first, err := s.Apply(NoRevision, []Op{setMode("", "", "coding", cand("claude", "claude"))})
	if err != nil {
		t.Fatal(err)
	}
	// S3: a stale revision.
	if _, err := s.Apply(NoRevision, []Op{setMode("", "", "coding", cand("codex", "codex"))}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision: %v", err)
	}
	// S3: an external editor wrote after our load.
	b, _ := os.ReadFile(s.Path)
	os.WriteFile(s.Path, append(b, []byte("\n# edited by hand\n")...), 0o600)
	if _, err := s.Apply(first.Revision, []Op{setMode("", "", "coding", cand("codex", "codex"))}); !errors.Is(err, ErrConflict) {
		t.Fatalf("external edit: %v", err)
	}
	if !strings.Contains(string(mustRead(t, s.Path)), "edited by hand") {
		t.Fatal("external edit overwritten")
	}
}

func TestStoreConcurrentWriters(t *testing.T) {
	s, _ := newStore(t)
	base, err := s.Apply(NoRevision, []Op{setMode("", "", "coding", cand("claude", "claude"))})
	if err != nil {
		t.Fatal(err)
	}
	// S4: separate stores stand in for separate processes (separate locks).
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok, conflicts := 0, 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			other := NewStore(s.Path)
			_, err := other.Apply(base.Revision, []Op{setMode("", "", "coding", cand("codex", "codex"), cand("claude", "claude"))})
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				ok++
			case errors.Is(err, ErrConflict):
				conflicts++
			default:
				t.Errorf("writer %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()
	if ok != 1 || conflicts != 7 {
		t.Fatalf("ok=%d conflicts=%d, want 1 and 7", ok, conflicts)
	}
}

func TestStoreRefusesInvalid(t *testing.T) {
	s, dir := newStore(t)
	base, _ := s.Apply(NoRevision, []Op{setMode("", "", "coding", cand("claude", "claude"))})
	before := mustRead(t, s.Path)
	bad := map[string][]Op{
		"metered provider":       {setMode("", "", "coding", cand("refuseless", "glm53"))},
		"empty list":             {setMode("", "", "coding")},
		"unknown mode":           {setMode("", "", "summary", cand("claude", "claude"))},
		"thread without project": {setMode("", "t-0002", "coding", cand("claude", "claude"))},
		"bad project":            {setMode("../etc", "", "coding", cand("claude", "claude"))},
		"enabled on thread":      {{Op: "set_enabled", Scope: ScopeRef{Project: "alpha", Thread: "t-0002"}, Enabled: ptr(true)}},
		"unknown op":             {{Op: "restart", Scope: ScopeRef{Project: "alpha"}}},
		"duplicate profile":      {setMode("", "", "coding", cand("claude", "claude"), cand("claude", "claude"))},
	}
	for name, ops := range bad {
		t.Run(name, func(t *testing.T) {
			_, err := s.Apply(base.Revision, ops)
			var fe FieldErrors
			if !errors.As(err, &fe) || len(fe) == 0 {
				t.Fatalf("want field errors, got %v", err)
			}
			if string(mustRead(t, s.Path)) != string(before) {
				t.Fatal("file changed")
			}
		})
	}
	noTemps(t, dir)

	// S5: a version this Dash does not know is never rewritten.
	os.WriteFile(s.Path, []byte("version = 2\n[future]\nthing = true\n"), 0o600)
	snap := s.Load()
	if snap.Policy != nil || len(snap.Errors) == 0 {
		t.Fatalf("version 2 loaded: %+v", snap)
	}
	if _, err := s.Apply(snap.Revision, []Op{setMode("", "", "coding", cand("claude", "claude"))}); err == nil {
		t.Fatal("version 2 file rewritten")
	}
	if !strings.Contains(string(mustRead(t, s.Path)), "future") {
		t.Fatal("version 2 file changed")
	}
}

func TestStoreResetPrunes(t *testing.T) {
	s, _ := newStore(t)
	snap, err := s.Apply(NoRevision, []Op{
		setMode("", "", "coding", cand("claude", "claude")),
		setMode("alpha", "", "coding", cand("codex", "codex")),
		setMode("alpha", "t-0002", "planning", cand("codex", "astra")),
		{Op: "set_enabled", Scope: ScopeRef{Project: "alpha"}, Enabled: ptr(true)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if e := snap.Policy.Effective("alpha", "t-0002", "planning"); e.ListFrom != "thread" || !e.Enabled {
		t.Fatalf("before reset: %+v", e)
	}
	snap, err = s.Apply(snap.Revision, []Op{
		{Op: "reset_mode", Scope: ScopeRef{Project: "alpha", Thread: "t-0002"}, Mode: "planning"},
		{Op: "reset_mode", Scope: ScopeRef{Project: "alpha"}, Mode: "coding"},
		{Op: "set_enabled", Scope: ScopeRef{Project: "alpha"}, Enabled: nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	if e := snap.Policy.Effective("alpha", "", "coding"); e.ListFrom != "global" || e.EnabledFrom != "default" {
		t.Fatalf("after reset: %+v", e)
	}
	if b := string(mustRead(t, s.Path)); strings.Contains(b, "projects") {
		t.Errorf("empty tables left:\n%s", b)
	}
}

func TestStoreUnsafePaths(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permissions")
	}
	s, dir := newStore(t)
	os.MkdirAll(dir, 0o700)
	target := filepath.Join(t.TempDir(), "elsewhere.toml")
	os.WriteFile(target, []byte("version = 1\n"), 0o600)
	os.Symlink(target, s.Path)
	rev := s.Load().Revision
	if _, err := s.Apply(rev, []Op{setMode("", "", "coding", cand("claude", "claude"))}); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("symlink: %v", err)
	}
	if fi, _ := os.Lstat(s.Path); fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symlink replaced")
	}
	if string(mustRead(t, target)) != "version = 1\n" {
		t.Fatal("wrote through the symlink")
	}

	s2, dir2 := newStore(t)
	os.MkdirAll(dir2, 0o700)
	os.Chmod(dir2, 0o777)
	if _, err := s2.Apply(NoRevision, []Op{setMode("", "", "coding", cand("claude", "claude"))}); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("world-writable dir: %v", err)
	}
	if snap := s2.Load(); snap.Err == nil || !errors.Is(snap.Err, ErrUnsafe) {
		t.Fatalf("world-writable dir must not be read: %+v", snap)
	}

	// A 0002 umask makes 0775 directories with the user's own group: fine.
	s3, dir3 := newStore(t)
	os.MkdirAll(dir3, 0o700)
	os.Chmod(dir3, 0o775)
	if _, err := s3.Apply(NoRevision, []Op{setMode("", "", "coding", cand("claude", "claude"))}); err != nil {
		t.Fatalf("own-group 0775 dir: %v", err)
	}
}

func TestDefaultPath(t *testing.T) {
	get := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if p := DefaultPath(get(map[string]string{"XDG_CONFIG_HOME": "/x/cfg"}), "/h"); p != filepath.Join("/x/cfg", "herdr-projects", "routing.toml") {
		t.Errorf("xdg: %s", p)
	}
	if p := DefaultPath(get(map[string]string{"XDG_CONFIG_HOME": "rel/cfg"}), "/h"); p != filepath.Join("/h", ".config", "herdr-projects", "routing.toml") {
		t.Errorf("relative xdg: %s", p)
	}
	if p := DefaultPath(get(nil), "/h"); p != filepath.Join("/h", ".config", "herdr-projects", "routing.toml") {
		t.Errorf("default: %s", p)
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func ptr[T any](v T) *T { return &v }
