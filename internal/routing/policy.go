// Package routing is Dash's agent routing policy, stage 1: the policy schema
// (version 1), an atomic config store and a pure decision engine that
// previews which candidate a new thread would get and why. Nothing here
// launches, stops or changes an agent; herdr-projects stays the only thing
// that does.
//
// The policy lives in routing.toml (see DefaultPath). Three scopes, searched
// thread → project → global: for each mode the first scope with a list
// supplies the whole ordered list (lists never merge); enabled inherits on
// its own, project → global → false. A missing file, or routing disabled,
// means legacy behaviour: PROJECT.md thread_profile.
package routing

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// Version is the policy schema this package reads and writes.
const Version = 1

const (
	DefaultMaxAgeSeconds  = 900
	DefaultAvoidAtPercent = 90.0
	maxCandidates         = 16
)

// Mode is one kind of work a thread is started for.
type Mode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// Modes are fixed; what each one prefers is the policy.
var Modes = []Mode{{"planning", "Planning"}, {"coding", "Coding"}, {"crawl", "Crawl + summary"}}

// Provider is an agent family whose usage Dash can read.
type Provider struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Agent string `json:"agent"` // the herdr-projects profile agent it runs as
}

// Providers lists the candidates' allowed providers. Metered providers
// (RefuseLess, other per-token APIs) are not routable: there is no spend
// authorisation or trustworthy meter for them yet.
var Providers = []Provider{{"claude", "Claude", "claude"}, {"codex", "Codex", "codex"}, {"opencode", "opencode", "opencode"}}

func IsMode(id string) bool {
	for _, m := range Modes {
		if m.ID == id {
			return true
		}
	}
	return false
}

func provider(id string) (Provider, bool) {
	for _, p := range Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

var (
	SlugRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,80}$`)
	ThreadRe  = regexp.MustCompile(`^t-[0-9]{1,6}$`)
	ProfileRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

// Candidate is one entry of a mode's ordered list.
type Candidate struct {
	Provider string `json:"provider"`
	Profile  string `json:"profile"`
	Model    string `json:"model,omitempty"`
	// Effort and Context are stored and previewed; herdr-projects applies
	// them once its launch hook asks Dash. Empty/0: the profile's own.
	Effort  string `json:"effort,omitempty"`
	Context int64  `json:"context,omitempty"`
}

// Scope is the policy at one level. Enabled is nil when the level does not
// say; Modes holds only the modes this level overrides.
type Scope struct {
	Enabled *bool                  `json:"enabled"`
	Modes   map[string][]Candidate `json:"modes"`
}

type ProjectScope struct {
	Scope
	Threads map[string]*Scope `json:"threads"`
}

type UsageSettings struct {
	MaxAgeSeconds  int     `json:"max_age_seconds"`
	AvoidAtPercent float64 `json:"avoid_at_percent"`
}

type Policy struct {
	Version  int                      `json:"version"`
	Usage    UsageSettings            `json:"usage"`
	Global   Scope                    `json:"global"`
	Projects map[string]*ProjectScope `json:"projects"`
}

// FieldError names a field by its TOML path (e.g. global.modes.coding[1].profile).
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

type FieldErrors []FieldError

func (e FieldErrors) Error() string {
	var parts []string
	for _, f := range e {
		parts = append(parts, f.Field+": "+f.Message)
	}
	return strings.Join(parts, "; ")
}

// Effective is the policy that applies to one launch.
type Effective struct {
	Enabled     bool        `json:"enabled"`
	EnabledFrom string      `json:"enabled_from"` // project, global, default, missing
	Candidates  []Candidate `json:"candidates"`
	ListFrom    string      `json:"list_from"` // thread, project, global, none
}

// Effective resolves project/thread/mode. A nil policy is a missing file.
func (p *Policy) Effective(project, thread, mode string) Effective {
	if p == nil {
		return Effective{EnabledFrom: "missing", ListFrom: "none"}
	}
	e := Effective{EnabledFrom: "default", ListFrom: "none"}
	ps := p.Projects[project]
	switch {
	case ps != nil && ps.Enabled != nil:
		e.Enabled, e.EnabledFrom = *ps.Enabled, "project"
	case p.Global.Enabled != nil:
		e.Enabled, e.EnabledFrom = *p.Global.Enabled, "global"
	}
	if ps != nil && thread != "" {
		if ts := ps.Threads[thread]; ts != nil && len(ts.Modes[mode]) > 0 {
			e.Candidates, e.ListFrom = ts.Modes[mode], "thread"
			return e
		}
	}
	if ps != nil && len(ps.Modes[mode]) > 0 {
		e.Candidates, e.ListFrom = ps.Modes[mode], "project"
		return e
	}
	if l := p.Global.Modes[mode]; len(l) > 0 {
		e.Candidates, e.ListFrom = l, "global"
	}
	return e
}

// Parse reads a routing.toml. It returns a policy only when there are no
// errors; warnings name accepted fields that do nothing yet.
func Parse(b []byte) (*Policy, []FieldError, FieldErrors) {
	var m map[string]any
	if err := toml.Unmarshal(b, &m); err != nil {
		return nil, nil, FieldErrors{{"(file)", "not valid TOML: " + tomlErr(err)}}
	}
	return FromMap(m)
}

func tomlErr(err error) string {
	if de, ok := err.(*toml.DecodeError); ok {
		row, col := de.Position()
		return fmt.Sprintf("line %d, column %d: %s", row, col, de.Error())
	}
	return err.Error()
}

// FromMap validates a decoded document (also a patched one, see Store).
func FromMap(m map[string]any) (*Policy, []FieldError, FieldErrors) {
	v := &validator{}
	p := v.policy(m)
	if len(v.errs) > 0 {
		return nil, v.warns, v.errs
	}
	return p, v.warns, nil
}

type validator struct {
	errs  FieldErrors
	warns []FieldError
}

func (v *validator) err(field, format string, a ...any) {
	v.errs = append(v.errs, FieldError{field, fmt.Sprintf(format, a...)})
}

// key quotes a TOML key that is not bare, so paths read as written.
func key(k string) string {
	if regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(k) {
		return k
	}
	return strconv.Quote(k)
}

func join(parent, k string) string {
	if parent == "" {
		return key(k)
	}
	return parent + "." + key(k)
}

func sortedKeys(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func (v *validator) table(field string, x any) (map[string]any, bool) {
	t, ok := x.(map[string]any)
	if !ok {
		v.err(field, "must be a table")
	}
	return t, ok
}

func (v *validator) reserved(field string) {
	v.warns = append(v.warns, FieldError{field, "caps are reserved for a later version: kept, not enforced"})
}

func (v *validator) policy(m map[string]any) *Policy {
	p := &Policy{Version: Version, Usage: UsageSettings{DefaultMaxAgeSeconds, DefaultAvoidAtPercent}, Projects: map[string]*ProjectScope{}}
	ver, ok := m["version"]
	switch n, isInt := ver.(int64); {
	case !ok:
		v.err("version", "missing; add version = %d at the top", Version)
		return p
	case !isInt || n != Version:
		v.err("version", "unsupported version %v; this Dash reads version %d and will not edit other versions", ver, Version)
		return p
	}
	for _, k := range sortedKeys(m) {
		f := join("", k)
		switch k {
		case "version":
		case "caps":
			v.reserved(f)
		case "usage":
			if t, ok := v.table(f, m[k]); ok {
				v.usage(f, t, &p.Usage)
			}
		case "global":
			if t, ok := v.table(f, m[k]); ok {
				p.Global = v.scope(f, t, "global")
			}
		case "projects":
			t, ok := v.table(f, m[k])
			if !ok {
				continue
			}
			for _, slug := range sortedKeys(t) {
				pf := join(f, slug)
				if !SlugRe.MatchString(slug) {
					v.err(pf, "not a herdr project slug (lowercase letters, digits, . _ -)")
					continue
				}
				if pt, ok := v.table(pf, t[slug]); ok {
					p.Projects[slug] = v.project(pf, pt)
				}
			}
		default:
			v.err(f, "unknown field; version %d has version, usage, global, projects (and reserved caps)", Version)
		}
	}
	return p
}

func number(x any) (float64, bool) {
	switch n := x.(type) {
	case int64:
		return float64(n), true
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	}
	return 0, false
}

func (v *validator) usage(field string, t map[string]any, u *UsageSettings) {
	for _, k := range sortedKeys(t) {
		f := join(field, k)
		switch k {
		case "max_age_seconds":
			n, ok := t[k].(int64)
			if !ok || n < 30 || n > 86400 {
				v.err(f, "must be a whole number of seconds from 30 to 86400")
				continue
			}
			u.MaxAgeSeconds = int(n)
		case "avoid_at_percent":
			n, ok := number(t[k])
			if !ok || n <= 0 || n > 100 {
				v.err(f, "must be a number above 0 and at most 100")
				continue
			}
			u.AvoidAtPercent = n
		default:
			v.err(f, "unknown field; usage has max_age_seconds and avoid_at_percent")
		}
	}
}

// scope validates a global, project or thread level.
func (v *validator) scope(field string, t map[string]any, level string) Scope {
	s := Scope{Modes: map[string][]Candidate{}}
	for _, k := range sortedKeys(t) {
		f := join(field, k)
		switch {
		case k == "enabled" && level != "thread":
			b, ok := t[k].(bool)
			if !ok {
				v.err(f, "must be true or false")
				continue
			}
			s.Enabled = &b
		case k == "enabled":
			v.err(f, "enabled is set per project or globally, not per thread")
		case k == "caps":
			v.reserved(f)
		case k == "modes":
			mt, ok := v.table(f, t[k])
			if !ok {
				continue
			}
			for _, mode := range sortedKeys(mt) {
				mf := join(f, mode)
				if !IsMode(mode) {
					v.err(mf, "unknown mode; modes are planning, coding, crawl")
					continue
				}
				if l, ok := v.candidates(mf, mt[mode]); ok {
					s.Modes[mode] = l
				}
			}
		case k == "threads" && level == "project":
			// handled by project
		default:
			v.err(f, "unknown field; a %s scope has %s", level, map[string]string{
				"global": "enabled, modes", "project": "enabled, modes, threads", "thread": "modes"}[level])
		}
	}
	return s
}

func (v *validator) project(field string, t map[string]any) *ProjectScope {
	ps := &ProjectScope{Scope: v.scope(field, t, "project"), Threads: map[string]*Scope{}}
	x, ok := t["threads"]
	if !ok {
		return ps
	}
	f := join(field, "threads")
	tt, ok := v.table(f, x)
	if !ok {
		return ps
	}
	for _, id := range sortedKeys(tt) {
		tf := join(f, id)
		if !ThreadRe.MatchString(id) {
			v.err(tf, "not a thread id (t-0001)")
			continue
		}
		if st, ok := v.table(tf, tt[id]); ok {
			s := v.scope(tf, st, "thread")
			ps.Threads[id] = &s
		}
	}
	return ps
}

func (v *validator) candidates(field string, x any) ([]Candidate, bool) {
	arr, ok := x.([]any)
	if !ok {
		v.err(field, "must be a list of candidates ([[%s]] tables)", field)
		return nil, false
	}
	if len(arr) == 0 {
		v.err(field, "empty list; remove it to inherit from the scope above")
		return nil, false
	}
	if len(arr) > maxCandidates {
		v.err(field, "at most %d candidates", maxCandidates)
		return nil, false
	}
	n := len(v.errs)
	seen := map[string]bool{}
	var out []Candidate
	for i, el := range arr {
		f := fmt.Sprintf("%s[%d]", field, i)
		t, ok := v.table(f, el)
		if !ok {
			continue
		}
		var c Candidate
		for _, k := range sortedKeys(t) {
			kf := join(f, k)
			if k == "context" {
				n, ok := t[k].(int64)
				if !ok || n < MinContext || n > MaxContext {
					v.err(kf, "must be a whole number of tokens from %d to %d", MinContext, MaxContext)
					continue
				}
				c.Context = n
				continue
			}
			s, isStr := t[k].(string)
			switch k {
			case "provider", "profile", "model", "effort":
				if !isStr {
					v.err(kf, "must be a string")
					continue
				}
			default:
				v.err(kf, "unknown field; a candidate has provider, profile, model, effort, context")
				continue
			}
			switch k {
			case "provider":
				if _, ok := provider(s); !ok {
					v.err(kf, "unsupported provider %q: use claude, codex or opencode; metered per-token providers (RefuseLess and the like) are not routable", s)
					continue
				}
				c.Provider = s
			case "profile":
				if !ProfileRe.MatchString(s) {
					v.err(kf, "must be a herdr-projects profile name (letters, digits, . _ -)")
					continue
				}
				c.Profile = s
			case "model":
				if !ModelRe.MatchString(s) {
					v.err(kf, "must be a model id of at most 128 characters, without spaces")
					continue
				}
				c.Model = s
			case "effort":
				c.Effort = s
			}
		}
		if c.Effort != "" && c.Provider != "" {
			if msg := CheckEffort(c.Provider, c.Effort); msg != "" {
				v.err(join(f, "effort"), "%s", msg)
				c.Effort = ""
			}
		}
		if _, ok := t["provider"]; !ok {
			v.err(join(f, "provider"), "missing")
		}
		if _, ok := t["profile"]; !ok {
			v.err(join(f, "profile"), "missing")
		}
		if c.Profile != "" {
			k := c.Profile + "|" + c.Model
			if seen[k] {
				what := fmt.Sprintf("profile %q", c.Profile)
				if c.Model != "" {
					what += fmt.Sprintf(" with model %q", c.Model)
				}
				v.err(join(f, "profile"), "%s is already in this list", what)
			}
			seen[k] = true
		}
		out = append(out, c)
	}
	return out, len(v.errs) == n
}
