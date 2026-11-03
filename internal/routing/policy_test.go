package routing

// Policy fixtures, written before the policy code. Ways the policy layer
// could fail:
//
//	P1. A missing file, or a file with routing disabled, is treated as
//	    "route": it must mean legacy behaviour (PROJECT.md thread_profile).
//	P2. Precedence is wrong: a thread list does not beat the project, a
//	    project list does not beat global, or lists are concatenated
//	    instead of the first defining scope replacing the whole list.
//	P3. A scope without a list for one mode hides another scope's list for
//	    that mode (inheritance is per mode, not per scope).
//	P4. enabled does not inherit independently: a project with enabled =
//	    true under global false is not routed, or a project that says false
//	    is routed because global says true.
//	P5. Invalid files half-load: an unknown version, bad syntax, unknown
//	    keys, wrong types, unsupported providers (RefuseLess and other
//	    metered providers), empty or duplicate profiles, empty lists, bad
//	    project or thread keys, or enabled at thread scope are accepted, or
//	    rejected without a field path saying where.
//	P6. Reserved fields for later stages (caps) are rejected or dropped
//	    instead of being accepted, kept and reported as not enforced.
//	P7. Candidate order is not preserved exactly as written.

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fixture(t *testing.T, name string) *Policy {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	p, _, errs := Parse(b)
	if len(errs) > 0 {
		t.Fatalf("%s: unexpected errors: %v", name, errs)
	}
	return p
}

func profiles(cs []Candidate) []string {
	var out []string
	for _, c := range cs {
		out = append(out, c.Provider+"/"+c.Profile)
	}
	return out
}

func TestPrecedenceLayers(t *testing.T) {
	p := fixture(t, "layered.toml")
	cases := []struct {
		name, project, thread, mode string
		enabled                     bool
		enabledFrom                 string
		list                        []string
		listFrom                    string
	}{
		// P2: thread beats project beats global.
		{"thread list wins", "alpha", "t-0002", "coding", true, "project", []string{"opencode/opencode"}, "thread"},
		{"project list wins", "alpha", "", "coding", true, "project", []string{"codex/codex", "claude/claude"}, "project"},
		{"project list for another thread", "alpha", "t-0009", "coding", true, "project", []string{"codex/codex", "claude/claude"}, "project"},
		// P3: per-mode inheritance.
		{"thread without this mode inherits project", "alpha", "t-0002", "planning", true, "project", []string{"codex/astra"}, "global"},
		{"thread planning override", "alpha", "t-0003", "planning", true, "project", []string{"claude/claude"}, "thread"},
		{"project without this mode inherits global", "alpha", "", "crawl", true, "project", []string{"opencode/opencode"}, "global"},
		// P4: enabled inherits independently.
		{"project inherits global disabled", "beta", "", "coding", false, "global", []string{"claude/claude", "codex/codex"}, "global"},
		{"project disables", "gamma", "", "planning", false, "project", []string{"claude/claude"}, "project"},
		{"unknown project inherits global", "delta", "", "coding", false, "global", []string{"claude/claude", "codex/codex"}, "global"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := p.Effective(c.project, c.thread, c.mode)
			if e.Enabled != c.enabled || e.EnabledFrom != c.enabledFrom {
				t.Errorf("enabled = %v from %q, want %v from %q", e.Enabled, e.EnabledFrom, c.enabled, c.enabledFrom)
			}
			if got := profiles(e.Candidates); !reflect.DeepEqual(got, c.list) || e.ListFrom != c.listFrom {
				t.Errorf("list = %v from %q, want %v from %q", got, e.ListFrom, c.list, c.listFrom)
			}
		})
	}
}

func TestCandidateDetailsKept(t *testing.T) {
	p := fixture(t, "layered.toml")
	// P7: order and every field as written.
	got := p.Global.Modes["coding"]
	want := []Candidate{{Provider: "claude", Profile: "claude", Model: "claude-opus-5-5"}, {Provider: "codex", Profile: "codex"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("global coding = %+v, want %+v", got, want)
	}
	if p.Usage.MaxAgeSeconds != 900 || p.Usage.AvoidAtPercent != 90 {
		t.Fatalf("usage settings = %+v", p.Usage)
	}
}

func TestMissingAndDisabledAreLegacy(t *testing.T) {
	// P1: a nil policy is a missing file.
	var none *Policy
	e := none.Effective("alpha", "", "coding")
	if e.Enabled || len(e.Candidates) != 0 || e.EnabledFrom != "missing" {
		t.Fatalf("missing file: %+v", e)
	}
	p := fixture(t, "disabled.toml")
	e = p.Effective("alpha", "", "coding")
	if e.Enabled || e.EnabledFrom != "global" {
		t.Fatalf("disabled file: %+v", e)
	}
	// Enabled defaults to false when nobody says.
	p, _, errs := Parse([]byte("version = 1\n"))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	if e := p.Effective("alpha", "", "coding"); e.Enabled || e.EnabledFrom != "default" {
		t.Fatalf("empty file: %+v", e)
	}
	if p.Usage.MaxAgeSeconds != DefaultMaxAgeSeconds || p.Usage.AvoidAtPercent != DefaultAvoidAtPercent {
		t.Fatalf("defaults not applied: %+v", p.Usage)
	}
}

func TestInvalidFiles(t *testing.T) {
	cases := []struct {
		file   string
		fields []string // every one must be reported, with its path
	}{
		{"bad-version.toml", []string{"version"}},
		{"no-version.toml", []string{"version"}},
		{"bad-syntax.toml", []string{"(file)"}},
		{"bad-fields.toml", []string{
			"colour",
			"usage.max_age_seconds",
			"usage.avoid_at_percent",
			"global.enabled",
			"global.modes.coding[0].provider",
			"global.modes.coding[1].profile",
			"global.modes.coding[2].temperature",
			"global.modes.coding[3].profile", // duplicate of [2]
			"global.modes.summary",
			`projects."Not A Slug"`,
			"projects.alpha.threads.t-0002.enabled",
			"projects.alpha.threads.thread-two",
		}},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			b, err := os.ReadFile(filepath.Join("testdata", c.file))
			if err != nil {
				t.Fatal(err)
			}
			p, _, errs := Parse(b)
			if p != nil {
				t.Errorf("an invalid file must not yield a policy")
			}
			got := map[string]string{}
			for _, e := range errs {
				got[e.Field] = e.Message
				if e.Message == "" {
					t.Errorf("%s: empty message", e.Field)
				}
			}
			for _, f := range c.fields {
				if _, ok := got[f]; !ok {
					t.Errorf("no error for %s; got %v", f, errs)
				}
			}
		})
	}
	// The RefuseLess rejection says why, not only "unsupported".
	b, _ := os.ReadFile("testdata/bad-fields.toml")
	_, _, errs := Parse(b)
	for _, e := range errs {
		if e.Field == "global.modes.coding[0].provider" && !strings.Contains(e.Message, "metered") {
			t.Errorf("provider message does not explain metered refusal: %q", e.Message)
		}
	}
}

func TestReservedCapsKept(t *testing.T) {
	b, err := os.ReadFile("testdata/reserved-caps.toml")
	if err != nil {
		t.Fatal(err)
	}
	p, warns, errs := Parse(b)
	if len(errs) > 0 || p == nil {
		t.Fatalf("caps must be accepted: %v", errs)
	}
	want := map[string]bool{"caps": true, "global.caps": true, "projects.alpha.caps": true}
	for _, w := range warns {
		delete(want, w.Field)
		if !strings.Contains(w.Message, "not enforced") {
			t.Errorf("%s: %q", w.Field, w.Message)
		}
	}
	if len(want) > 0 {
		t.Errorf("no warning for %v; got %v", want, warns)
	}
}
