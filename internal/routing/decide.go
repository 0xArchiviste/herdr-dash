package routing

import (
	"fmt"
	"strings"
	"time"
)

// futureTolerance is how far ahead of the clock an observation may claim to be.
const futureTolerance = 2 * time.Minute

// Window is one usage window of a provider (a 5-hour session, a week, or a
// week scoped to one model: "Week · Fable").
type Window struct {
	Label       string     `json:"label"`
	UsedPercent float64    `json:"used_percent"`
	ResetsAt    *time.Time `json:"resets_at,omitempty"`
	ResetPassed bool       `json:"reset_passed,omitempty"`
}

// Signal is one provider's usage as Dash last read it. Status is ok,
// unavailable or disabled. For opencode, Model is the configured default
// model and Metered says its provider bills per token.
type Signal struct {
	Provider   string     `json:"provider"`
	Status     string     `json:"status"`
	Reason     string     `json:"reason,omitempty"`
	Plan       string     `json:"plan,omitempty"`
	Model      string     `json:"model,omitempty"`
	AsOf       *time.Time `json:"as_of,omitempty"`
	ValidUntil *time.Time `json:"valid_until,omitempty"`
	CheckedAt  time.Time  `json:"checked_at"`
	Stale      bool       `json:"stale,omitempty"`
	Metered    bool       `json:"metered,omitempty"`
	Windows    []Window   `json:"windows"`
}

// Profile is a herdr-projects profile as its config defines it.
type Profile struct {
	Name        string `json:"name"`
	Agent       string `json:"agent"`
	Model       string `json:"model,omitempty"`
	Effort      string `json:"effort,omitempty"`
	Description string `json:"description,omitempty"`
	Label       string `json:"label,omitempty"` // a readable name for the picker
}

// Input is everything one preview depends on; Decide reads nothing else.
type Input struct {
	Policy        *Policy // nil: no routing.toml
	Revision      string
	Invalid       FieldErrors // routing.toml exists but is invalid
	Project       string
	Thread        string // "" for a new thread
	Mode          string
	LegacyProfile string // PROJECT.md thread_profile, what legacy launches use
	Signals       map[string]Signal
	Profiles      map[string]Profile
	ProfilesKnown bool // Profiles was read; otherwise profiles are not checked
	Now           time.Time
}

// Verdict is what the engine made of one candidate.
type Verdict struct {
	Candidate
	Status      string     `json:"status"` // selected, would_select, standby, skipped
	Code        string     `json:"code"`   // ok, or why it cannot be used
	Reason      string     `json:"reason"`
	AsOf        *time.Time `json:"as_of,omitempty"`
	UsedPercent *float64   `json:"used_percent,omitempty"` // worst applicable window
}

// Decision answers "which candidate would a new <mode> thread in <project>
// get, and why". Outcome: select, queue (nothing qualifies), legacy
// (routing off or no list: PROJECT.md thread_profile) or invalid.
type Decision struct {
	Project       string       `json:"project"`
	Thread        string       `json:"thread,omitempty"`
	Mode          string       `json:"mode"`
	Outcome       string       `json:"outcome"`
	Reason        string       `json:"reason"`
	Selected      *Candidate   `json:"selected"`
	WouldSelect   *Candidate   `json:"would_select,omitempty"`
	LegacyProfile string       `json:"legacy_profile"`
	Enabled       bool         `json:"enabled"`
	EnabledFrom   string       `json:"enabled_from"`
	ListFrom      string       `json:"list_from"`
	Revision      string       `json:"revision"`
	Candidates    []Verdict    `json:"candidates"`
	Invalid       []FieldError `json:"invalid,omitempty"`
	EvaluatedAt   time.Time    `json:"evaluated_at"`
}

// Decide is pure: same input, same decision; no clock, files or network.
func Decide(in Input) Decision {
	d := Decision{Project: in.Project, Thread: in.Thread, Mode: in.Mode, LegacyProfile: in.LegacyProfile,
		Revision: in.Revision, EvaluatedAt: in.Now, Candidates: []Verdict{}}
	legacy := "the project's default profile"
	if in.LegacyProfile != "" {
		legacy = "PROJECT.md thread_profile " + in.LegacyProfile
	}
	if len(in.Invalid) > 0 {
		d.Outcome, d.EnabledFrom, d.ListFrom = "invalid", "invalid", "none"
		d.Invalid = in.Invalid
		d.Reason = "routing.toml is invalid (" + in.Invalid.Error() + "); routed launches would be blocked until it is fixed"
		return d
	}
	eff := in.Policy.Effective(in.Project, in.Thread, in.Mode)
	d.Enabled, d.EnabledFrom, d.ListFrom = eff.Enabled, eff.EnabledFrom, eff.ListFrom
	usage := UsageSettings{DefaultMaxAgeSeconds, DefaultAvoidAtPercent}
	if in.Policy != nil {
		usage = in.Policy.Usage
	}
	first := -1
	for _, c := range eff.Candidates {
		v := in.verdict(c, usage)
		if v.Code == "ok" && first < 0 {
			first = len(d.Candidates)
		}
		d.Candidates = append(d.Candidates, v)
	}
	for i := range d.Candidates {
		switch v := &d.Candidates[i]; {
		case v.Code != "ok":
			v.Status = "skipped"
		case i == first && eff.Enabled:
			v.Status = "selected"
		case i == first:
			v.Status = "would_select"
		default:
			v.Status = "standby"
		}
	}
	pick := func() *Candidate { c := d.Candidates[first].Candidate; return &c }
	switch {
	case eff.EnabledFrom == "missing":
		d.Outcome, d.Reason = "legacy", "no routing.toml: new threads use "+legacy
	case !eff.Enabled:
		d.Outcome = "legacy"
		d.Reason = fmt.Sprintf("routing is off (%s): new threads use %s", map[string]string{
			"project": "enabled = false for this project", "global": "enabled = false globally", "default": "not enabled anywhere"}[eff.EnabledFrom], legacy)
		if first >= 0 {
			d.WouldSelect = pick()
		}
	case len(eff.Candidates) == 0:
		d.Outcome, d.Reason = "legacy", "no "+in.Mode+" list at any scope: new threads use "+legacy
	case first >= 0:
		d.Outcome, d.Selected = "select", pick()
		d.Reason = fmt.Sprintf("%s (%s list): %s", d.Selected.Profile, eff.ListFrom, d.Candidates[first].Reason)
		if first > 0 {
			d.Reason = fmt.Sprintf("%d earlier candidate(s) skipped; %s", first, d.Reason)
		}
	default:
		d.Outcome = "queue"
		d.Reason = fmt.Sprintf("no candidate in the %s list qualifies: a new thread would wait until one does", eff.ListFrom)
	}
	return d
}

func (in Input) verdict(c Candidate, u UsageSettings) Verdict {
	v := Verdict{Candidate: c}
	no := func(code, format string, a ...any) Verdict {
		v.Code, v.Reason = code, fmt.Sprintf(format, a...)
		return v
	}
	prov, _ := provider(c.Provider)
	model := c.Model
	if in.ProfilesKnown {
		p, ok := in.Profiles[c.Profile]
		switch {
		case !ok && c.Profile != prov.ID:
			return no("profile_unknown", "herdr-projects has no profile %q", c.Profile)
		case ok && p.Agent != "" && p.Agent != prov.Agent:
			return no("provider_mismatch", "profile %q runs %s, not %s", c.Profile, p.Agent, prov.Label)
		case ok && model == "":
			model = p.Model
		}
	}
	s, ok := in.Signals[c.Provider]
	if !ok {
		return no("unknown", "no %s usage reading: unknown usage is skipped", prov.Label)
	}
	if s.Status == "disabled" {
		return no("unknown", "%s usage is not read here%s: unknown usage is skipped", prov.Label, paren(s.Reason))
	}
	maxAge := time.Duration(u.MaxAgeSeconds) * time.Second
	if c.Provider == "opencode" {
		switch {
		case s.Metered:
			return no("metered", "opencode's provider bills per token%s: paid fallback is not allowed", paren(s.Model))
		case s.Model == "":
			return no("unknown", "no opencode default model is configured%s", paren(s.Reason))
		case s.CheckedAt.IsZero() || in.Now.Sub(s.CheckedAt) > maxAge:
			return no("stale", "opencode config last read %s ago (limit %s)", ago(in.Now.Sub(s.CheckedAt)), ago(maxAge))
		case model != "" && model != s.Model:
			return no("model_mismatch", "runs %s; only the self-hosted default %s is allowed", model, s.Model)
		}
		v.Code = "ok"
		v.Reason = fmt.Sprintf("self-hosted default %s: no per-token cost, no quota meter (config read %s ago)", s.Model, ago(in.Now.Sub(s.CheckedAt)))
		return v
	}
	if s.Status != "ok" {
		return no("unknown", "%s usage unavailable%s: unknown usage is skipped", prov.Label, paren(s.Reason))
	}
	if s.AsOf == nil {
		return no("unknown", "%s usage has no observation time: unknown usage is skipped", prov.Label)
	}
	v.AsOf = s.AsOf
	age := in.Now.Sub(*s.AsOf)
	switch {
	case -age > futureTolerance:
		return no("future", "%s usage claims to be from %s in the future; not believed", prov.Label, ago(-age))
	case s.Stale:
		return no("stale", "%s usage is stale%s", prov.Label, paren(s.Reason))
	case s.ValidUntil != nil && !in.Now.Before(*s.ValidUntil):
		return no("stale", "%s usage expired %s ago (observed %s ago)", prov.Label, ago(in.Now.Sub(*s.ValidUntil)), ago(age))
	case age > maxAge:
		return no("stale", "%s usage observed %s ago (limit %s)", prov.Label, ago(age), ago(maxAge))
	}
	var parts []string
	worst := -1.0
	var worstW Window
	for _, w := range s.Windows {
		if !applies(w, model) {
			continue
		}
		if w.ResetPassed || (w.ResetsAt != nil && !in.Now.Before(*w.ResetsAt)) {
			return no("reset_passed", "%s %s window has reset since it was observed; new usage unknown", prov.Label, w.Label)
		}
		if w.UsedPercent > worst {
			worst, worstW = w.UsedPercent, w
		}
		parts = append(parts, fmt.Sprintf("%s %.0f%%", w.Label, w.UsedPercent))
	}
	if worst < 0 {
		return no("unknown", "%s usage has no windows for this model: unknown usage is skipped", prov.Label)
	}
	v.UsedPercent = &worst
	if worst >= u.AvoidAtPercent {
		return no("near_limit", "%s %s window at %.0f%% used (avoided from %.0f%%)", prov.Label, worstW.Label, worst, u.AvoidAtPercent)
	}
	v.Code = "ok"
	v.Reason = fmt.Sprintf("%s used: %s (observed %s ago)", prov.Label, strings.Join(parts, ", "), ago(age))
	return v
}

// applies says whether a window counts for model. "Week · Fable" counts
// only for Fable models; when the model is unknown every window counts.
func applies(w Window, model string) bool {
	_, scope, ok := strings.Cut(w.Label, " · ")
	if !ok || model == "" {
		return true
	}
	return strings.Contains(strings.ToLower(model), strings.ToLower(strings.TrimSpace(scope)))
}

func paren(s string) string {
	if s == "" {
		return ""
	}
	return " (" + s + ")"
}

func ago(d time.Duration) string {
	if d < 0 {
		d = -d
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
