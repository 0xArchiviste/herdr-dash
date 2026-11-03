package routing

// Decision engine cases with a fake clock, written before the engine. Ways
// the preview could fail:
//
//	D1. Unknown usage (source off, unavailable, no windows, no timestamp)
//	    counts as free capacity instead of skipping to the next candidate.
//	D2. Stale usage counts as current: observed longer ago than
//	    max_age_seconds, past its valid_until, flagged stale, or with a
//	    window whose reset has passed (a reset is not proof of zero use).
//	D3. A window at or over avoid_at_percent is not skipped (exhausted).
//	D4. A candidate skipped earlier is not chosen again once its usage
//	    recovers (fresh and under the limit).
//	D5. When nothing qualifies the preview still names a model instead of
//	    queueing; or a skipped candidate has no reason.
//	D6. A missing, disabled or invalid policy is routed instead of legacy
//	    (PROJECT.md thread_profile) or invalid.
//	D7. opencode: a metered provider (an OpenRouter balance) or a model other
//	    than the self-hosted default is used; or the self-hosted default is
//	    refused because it has no quota meter.
//	D8. A profile herdr-projects does not define, or one whose agent is not
//	    the candidate's provider, is chosen.
//	D9. A model-scoped Claude window blocks or frees the wrong model.
//	D10. An observation timestamped in the future is believed.
//	D11. The engine is not pure: it reads the real clock, or mutates input.

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

func at(d time.Duration) *time.Time { x := t0.Add(d); return &x }

func codingPolicy(t *testing.T) *Policy {
	t.Helper()
	p, _, errs := Parse([]byte(`version = 1
[usage]
max_age_seconds = 600
avoid_at_percent = 90
[global]
enabled = true
[[global.modes.coding]]
provider = "claude"
profile = "claude"
model = "claude-opus-5-5"
[[global.modes.coding]]
provider = "codex"
profile = "codex"
[[global.modes.coding]]
provider = "opencode"
profile = "opencode"
`))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	return p
}

func fresh(provider string, used ...float64) Signal {
	s := Signal{Provider: provider, Status: "ok", AsOf: at(-time.Minute), ValidUntil: at(4 * time.Minute), CheckedAt: t0}
	labels := []string{"5h", "Week"}
	for i, u := range used {
		s.Windows = append(s.Windows, Window{Label: labels[i%2], UsedPercent: u, ResetsAt: at(time.Hour)})
	}
	return s
}

func selfHosted() Signal {
	return Signal{Provider: "opencode", Status: "unavailable", Reason: "gpu-box has no balance API", Model: "gpu-box/qwen", CheckedAt: t0}
}

func input(p *Policy, sig ...Signal) Input {
	in := Input{Policy: p, Revision: "sha256:test", Project: "alpha", Mode: "coding", LegacyProfile: "codex-high", Now: t0, Signals: map[string]Signal{}}
	for _, s := range sig {
		in.Signals[s.Provider] = s
	}
	return in
}

func check(t *testing.T, d Decision, outcome, selected string, codes ...string) {
	t.Helper()
	if d.Outcome != outcome {
		t.Errorf("outcome = %q, want %q (%s)", d.Outcome, outcome, d.Reason)
	}
	got := ""
	if d.Selected != nil {
		got = d.Selected.Profile
	}
	if got != selected {
		t.Errorf("selected = %q, want %q", got, selected)
	}
	for i, code := range codes {
		if i >= len(d.Candidates) {
			t.Errorf("candidate %d missing", i)
			continue
		}
		c := d.Candidates[i]
		if c.Code != code {
			t.Errorf("candidate %d (%s) code = %q, want %q (%s)", i, c.Profile, c.Code, code, c.Reason)
		}
		if c.Reason == "" {
			t.Errorf("candidate %d (%s) has no reason", i, c.Profile)
		}
	}
	if d.Reason == "" {
		t.Errorf("decision has no reason")
	}
}

func TestFreshUsageSelectsFirst(t *testing.T) {
	d := Decide(input(codingPolicy(t), fresh("claude", 40, 20), fresh("codex", 10), selfHosted()))
	check(t, d, "select", "claude", "ok", "ok", "ok")
	if d.ListFrom != "global" || d.Revision != "sha256:test" {
		t.Errorf("provenance: %+v", d)
	}
	if d.Candidates[0].Status != "selected" || d.Candidates[1].Status != "standby" {
		t.Errorf("statuses: %+v", d.Candidates)
	}
}

func TestStaleSkips(t *testing.T) {
	p := codingPolicy(t)
	old := fresh("claude", 10)
	old.AsOf, old.ValidUntil = at(-20*time.Minute), nil
	check(t, Decide(input(p, old, fresh("codex", 10))), "select", "codex", "stale", "ok")

	expired := fresh("claude", 10)
	expired.ValidUntil = at(-time.Second)
	check(t, Decide(input(p, expired, fresh("codex", 10))), "select", "codex", "stale")

	flagged := fresh("claude", 10)
	flagged.Stale = true
	check(t, Decide(input(p, flagged, fresh("codex", 10))), "select", "codex", "stale")

	rolled := fresh("claude", 10)
	rolled.Windows[0].ResetsAt = at(-time.Minute)
	check(t, Decide(input(p, rolled, fresh("codex", 10))), "select", "codex", "reset_passed")

	passed := fresh("claude", 0)
	passed.Windows[0].ResetPassed = true
	check(t, Decide(input(p, passed, fresh("codex", 10))), "select", "codex", "reset_passed")
}

func TestUnknownSkips(t *testing.T) {
	p := codingPolicy(t)
	cases := map[string]Signal{
		"usage_off":   {Provider: "claude", Status: "disabled", Reason: "turned off", CheckedAt: t0},
		"unavailable": {Provider: "claude", Status: "unavailable", Reason: "credentials rejected (HTTP 401)", CheckedAt: t0},
		"no_windows":  {Provider: "claude", Status: "ok", AsOf: at(-time.Minute), CheckedAt: t0},
		"no_time":     {Provider: "claude", Status: "ok", CheckedAt: t0, Windows: []Window{{Label: "5h", UsedPercent: 1}}},
	}
	for name, s := range cases {
		t.Run(name, func(t *testing.T) {
			check(t, Decide(input(p, s, fresh("codex", 10))), "select", "codex", "unknown", "ok")
		})
	}
	// No signal at all for a provider is unknown too.
	check(t, Decide(input(p, fresh("codex", 10))), "select", "codex", "unknown", "ok")
}

func TestExhaustedThenRecovered(t *testing.T) {
	p := codingPolicy(t)
	d := Decide(input(p, fresh("claude", 95, 50), fresh("codex", 10)))
	check(t, d, "select", "codex", "near_limit", "ok")
	if !strings.Contains(d.Candidates[0].Reason, "95%") {
		t.Errorf("reason does not name the usage: %q", d.Candidates[0].Reason)
	}
	// Exactly at the threshold counts as exhausted.
	check(t, Decide(input(p, fresh("claude", 90), fresh("codex", 10))), "select", "codex", "near_limit")

	// Recovered: later, a fresh low reading; the clock moved on too.
	in := input(p, fresh("claude", 30), fresh("codex", 10))
	later := 3 * time.Hour
	for k, s := range in.Signals {
		s.AsOf, s.ValidUntil, s.CheckedAt = at(later-time.Minute), at(later+4*time.Minute), t0.Add(later)
		for i := range s.Windows {
			s.Windows[i].ResetsAt = at(later + time.Hour)
		}
		in.Signals[k] = s
	}
	in.Now = t0.Add(later)
	check(t, Decide(in), "select", "claude", "ok")
}

func TestNothingQualifiesQueues(t *testing.T) {
	d := Decide(input(codingPolicy(t), fresh("claude", 99), Signal{Provider: "codex", Status: "disabled", CheckedAt: t0}, Signal{Provider: "opencode", Status: "disabled", CheckedAt: t0}))
	check(t, d, "queue", "", "near_limit", "unknown", "unknown")
	for _, c := range d.Candidates {
		if c.Status != "skipped" {
			t.Errorf("%s: status %q", c.Profile, c.Status)
		}
	}
}

func TestLegacyAndInvalid(t *testing.T) {
	d := Decide(input(nil, fresh("claude", 10)))
	check(t, d, "legacy", "")
	if d.LegacyProfile != "codex-high" || d.EnabledFrom != "missing" {
		t.Errorf("missing file: %+v", d)
	}

	p, _, _ := Parse([]byte("version = 1\n[global]\nenabled = false\n[[global.modes.coding]]\nprovider = \"claude\"\nprofile = \"claude\"\n"))
	d = Decide(input(p, fresh("claude", 10)))
	check(t, d, "legacy", "", "ok")
	// The preview still says what routing would pick once enabled.
	if d.WouldSelect == nil || d.WouldSelect.Profile != "claude" {
		t.Errorf("would select: %+v", d.WouldSelect)
	}

	// Enabled, but no list for this mode at any scope: legacy.
	p, _, _ = Parse([]byte("version = 1\n[global]\nenabled = true\n"))
	check(t, Decide(input(p)), "legacy", "")

	in := input(nil)
	in.Invalid = []FieldError{{Field: "version", Message: "unsupported"}}
	d = Decide(in)
	check(t, d, "invalid", "")
	if !strings.Contains(d.Reason, "version") {
		t.Errorf("invalid reason: %q", d.Reason)
	}
}

func TestOpencode(t *testing.T) {
	p, _, errs := Parse([]byte(`version = 1
[global]
enabled = true
[[global.modes.crawl]]
provider = "opencode"
profile = "opencode"
[[global.modes.crawl]]
provider = "opencode"
profile = "glm53"
model = "refuseless/glm-5.3"
[[global.modes.crawl]]
provider = "codex"
profile = "codex"
`))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	in := input(p, selfHosted(), fresh("codex", 10))
	in.Mode = "crawl"
	d := Decide(in)
	check(t, d, "select", "opencode", "ok", "model_mismatch", "ok")
	if !strings.Contains(d.Candidates[0].Reason, "gpu-box/qwen") {
		t.Errorf("usage must stay visible: %q", d.Candidates[0].Reason)
	}

	metered := selfHosted()
	metered.Status, metered.Metered, metered.AsOf, metered.Reason = "ok", true, at(-time.Minute), ""
	in.Signals["opencode"] = metered
	check(t, Decide(in), "select", "codex", "metered", "metered", "ok")

	old := selfHosted()
	old.CheckedAt = t0.Add(-time.Hour)
	in.Signals["opencode"] = old
	check(t, Decide(in), "select", "codex", "stale")

	noModel := selfHosted()
	noModel.Model = ""
	in.Signals["opencode"] = noModel
	check(t, Decide(in), "select", "codex", "unknown")
}

func TestProfileCatalog(t *testing.T) {
	p, _, _ := Parse([]byte(`version = 1
[global]
enabled = true
[[global.modes.coding]]
provider = "claude"
profile = "gone"
[[global.modes.coding]]
provider = "claude"
profile = "astra"
[[global.modes.coding]]
provider = "claude"
profile = "claude"
`))
	in := input(p, fresh("claude", 10))
	in.ProfilesKnown = true
	in.Profiles = map[string]Profile{"astra": {Name: "astra", Agent: "codex", Model: "gpt-6-astra"}}
	// claude is built in: allowed though the config does not list it.
	check(t, Decide(in), "select", "claude", "profile_unknown", "provider_mismatch", "ok")
	// Without a readable catalog, profiles are not second-guessed.
	in.ProfilesKnown, in.Profiles = false, nil
	check(t, Decide(in), "select", "gone", "ok")
}

func TestModelScopedWindows(t *testing.T) {
	p, _, _ := Parse([]byte(`version = 1
[global]
enabled = true
[[global.modes.coding]]
provider = "claude"
profile = "fable"
model = "claude-fable-5-1"
[[global.modes.coding]]
provider = "claude"
profile = "claude"
model = "claude-opus-5-5"
[[global.modes.coding]]
provider = "claude"
profile = "any"
`))
	s := fresh("claude", 40, 30)
	s.Windows = append(s.Windows, Window{Label: "Week · Fable", UsedPercent: 96, ResetsAt: at(time.Hour)})
	in := input(p, s)
	d := Decide(in)
	check(t, d, "select", "claude", "near_limit", "ok")
	// A candidate whose model is unknown gets every window: conservative.
	in.Policy.Global.Modes["coding"] = in.Policy.Global.Modes["coding"][2:]
	check(t, Decide(in), "queue", "", "near_limit")
}

func TestFutureTimestamp(t *testing.T) {
	s := fresh("claude", 10)
	s.AsOf = at(10 * time.Minute)
	check(t, Decide(input(codingPolicy(t), s, fresh("codex", 10))), "select", "codex", "future")
}

func TestPure(t *testing.T) {
	in := input(codingPolicy(t), fresh("claude", 95), fresh("codex", 10), selfHosted())
	before := in.Signals["claude"]
	a, b := Decide(in), Decide(in)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("same input, different decisions")
	}
	if !reflect.DeepEqual(before, in.Signals["claude"]) {
		t.Fatal("input mutated")
	}
	if !a.EvaluatedAt.Equal(t0) {
		t.Fatalf("evaluated at %v, want the input clock", a.EvaluatedAt)
	}
}
