package routing

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"
)

// The model catalog is what the Routing window offers to pick from: per
// harness, the reasoning (effort) levels it accepts and the models it is
// known to run, each with the context-window sizes it offers. Built-in
// models are only the ones whose sizes are public; models named by a
// herdr-projects profile or a harness's own config join them, and anything
// else can still be entered by hand ("Other…"). Effort and context are
// stored and previewed in stage 1; applying them at launch belongs to the
// herdr-projects launch hook.

// HarnessEfforts are the effort levels each harness accepts, low to high,
// when the harness does not say for itself; Codex lists each model's own
// levels in its models_cache.json, and those replace this list in the
// catalog. opencode has no effort setting.
var HarnessEfforts = map[string][]string{
	"claude":   {"low", "medium", "high", "xhigh", "max"},
	"codex":    {"minimal", "low", "medium", "high", "xhigh"},
	"opencode": {},
}

// KnownEfforts are every level a harness has been seen to accept, low to
// high: what a policy file may name before the catalog says which model
// takes which (a saved choice is checked per model by CheckModelEffort).
var KnownEfforts = map[string][]string{
	"claude":   {"low", "medium", "high", "xhigh", "max"},
	"codex":    {"minimal", "low", "medium", "high", "xhigh", "max", "ultra"},
	"opencode": {},
}

// SortEfforts orders levels low to high, unknown ones last as given.
func SortEfforts(provider string, levels []string) []string {
	known := KnownEfforts[provider]
	out := slices.Clone(levels)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := slices.Index(known, out[i]), slices.Index(known, out[j])
		if a < 0 {
			a = len(known)
		}
		if b < 0 {
			b = len(known)
		}
		return a < b
	})
	return slices.Compact(out)
}

const (
	MinContext = 1_000
	MaxContext = 10_000_000
)

// ModelRe is a model id: no spaces, at most 128 characters.
var ModelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`)

// Model is one model a harness can run.
type Model struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	Contexts []int64 `json:"contexts"` // offered sizes, smallest (the default) first; empty: unknown
	// Efforts are the levels this model takes, when the harness lists them
	// per model (Codex); absent: the harness's levels apply.
	Efforts []string `json:"efforts,omitempty"`
	Source  string   `json:"source"` // built-in, harness, config, profile
}

// Harness is one provider's entry in the catalog.
type Harness struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Efforts []string `json:"efforts"`
	Models  []Model  `json:"models"`
}

var builtinModels = map[string][]Model{
	"claude": {
		{ID: "claude-opus-5-5", Label: "Claude Opus 5.5", Contexts: []int64{200_000, 1_000_000}},
		{ID: "claude-sonnet-5-5", Label: "Claude Sonnet 5.5", Contexts: []int64{200_000, 1_000_000}},
		{ID: "claude-haiku-5-5", Label: "Claude Haiku 5.5", Contexts: []int64{200_000}},
		{ID: "claude-fable-5-1", Label: "Claude Fable 5.1", Contexts: []int64{200_000, 1_000_000}},
	},
}

// Catalog builds the picker's catalog from the built-in models, models a
// harness itself or its config names (extra, per provider, earlier entries
// winning; opencode ids are provider/model) and the profiles' models. One
// model named by several sources is one entry: the first source to state a
// label, sizes or levels gives them. efforts, per provider, replaces the
// harness's default levels (Codex's own list).
func Catalog(profiles map[string]Profile, extra map[string][]Model, efforts map[string][]string) []Harness {
	var out []Harness
	for _, p := range Providers {
		levels := HarnessEfforts[p.ID]
		if e, ok := efforts[p.ID]; ok && len(e) > 0 {
			levels = e
		}
		h := Harness{ID: p.ID, Label: p.Label, Efforts: slices.Clone(levels), Models: []Model{}}
		seen := map[string]int{}
		add := func(m Model) {
			if m.ID == "" || !ModelRe.MatchString(m.ID) {
				return
			}
			if i, ok := seen[m.ID]; ok {
				have := &h.Models[i]
				if have.Label == "" {
					have.Label = m.Label
				}
				if len(have.Contexts) == 0 && len(m.Contexts) > 0 {
					have.Contexts = m.Contexts
				}
				if len(have.Efforts) == 0 && len(m.Efforts) > 0 {
					have.Efforts = m.Efforts
				}
				return
			}
			seen[m.ID] = len(h.Models)
			h.Models = append(h.Models, m)
		}
		for _, m := range builtinModels[p.ID] {
			m.Source = "built-in"
			add(m)
		}
		for _, m := range extra[p.ID] {
			if m.Source == "" {
				m.Source = "config"
			}
			add(m)
		}
		names := make([]string, 0, len(profiles))
		for n := range profiles {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			if pr := profiles[n]; pr.Agent == p.Agent && pr.Model != "" {
				add(Model{ID: pr.Model, Source: "profile"})
			}
		}
		for i := range h.Models {
			m := &h.Models[i]
			if m.Label == "" {
				m.Label = ModelLabel(p.ID, m.ID)
			}
			if m.Contexts == nil {
				m.Contexts = []int64{}
			}
			if len(m.Efforts) == 0 {
				m.Efforts = nil
			}
		}
		out = append(out, h)
	}
	return out
}

// Find returns the catalog entry of model on provider.
func Find(cat []Harness, provider, model string) (Model, bool) {
	for _, h := range cat {
		if h.ID != provider {
			continue
		}
		for _, m := range h.Models {
			if m.ID == model {
				return m, true
			}
		}
	}
	return Model{}, false
}

var acronyms = map[string]string{"gpt": "GPT", "glm": "GLM", "llama": "Llama", "qwen": "Qwen", "o3": "o3", "o4": "o4"}

// ModelLabel is a readable name for a model id the catalog has no label
// for: "claude-fable-5-2" → "Claude Fable 5.2", "gpt-6.2-sol" →
// "GPT-6.2-Sol" (Codex's own style), "gpt-6-mini" → "GPT-6-Mini";
// opencode's "box/qwen3" → "Qwen3 via opencode (box)". It never invents
// facts: it only reformats the id.
func ModelLabel(provider, id string) string {
	if m, ok := Find([]Harness{{ID: provider, Models: builtinModels[provider]}}, provider, id); ok && m.Label != "" {
		return m.Label
	}
	sub := ""
	if provider == "opencode" {
		if a, b, ok := strings.Cut(id, "/"); ok {
			sub, id = a, b
		}
	}
	words := strings.FieldsFunc(id, func(r rune) bool { return r == '-' || r == '_' })
	for i, w := range words {
		if a, ok := acronyms[strings.ToLower(w)]; ok {
			words[i] = a
		} else if rs := []rune(w); len(rs) > 0 && unicode.IsLower(rs[0]) {
			rs[0] = unicode.ToUpper(rs[0])
			words[i] = string(rs)
		}
	}
	var label string
	if len(words) > 0 && words[0] == "GPT" {
		// GPT ids keep their hyphens, as Codex names them.
		label = strings.Join(words, "-")
	} else {
		// A run of short numbers is a version: 5 2 → 5.2.
		var parts []string
		for i, w := range words {
			if i > 0 && isShortNum(w) && isShortNum(words[i-1]) {
				parts[len(parts)-1] += "." + w
				continue
			}
			parts = append(parts, w)
		}
		label = strings.Join(parts, " ")
	}
	if provider == "opencode" {
		label += " via opencode"
		if sub != "" {
			label += " (" + sub + ")"
		}
	}
	return label
}

func isShortNum(w string) bool {
	if w == "" || len(w) > 2 {
		return false
	}
	for _, r := range w {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ContextLabel is 200k, 1M, 131k.
func ContextLabel(n int64) string {
	switch {
	case n >= 1_000_000 && n%1_000_000 == 0:
		return fmt.Sprintf("%dM", n/1_000_000)
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%dk", (n+500)/1_000)
	}
	return fmt.Sprint(n)
}

func contextsText(cs []int64) string {
	parts := make([]string, len(cs))
	for i, c := range cs {
		parts[i] = ContextLabel(c)
	}
	switch len(parts) {
	case 1:
		return parts[0]
	case 2:
		return parts[0] + " or " + parts[1]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " or " + parts[len(parts)-1]
}

// CheckEffort says why effort is not a level provider is known to accept
// ("" if it is). It is the check a policy file gets on its own; a save is
// checked per model by CheckModelEffort.
func CheckEffort(provider, effort string) string {
	levels, ok := KnownEfforts[provider]
	if !ok {
		return ""
	}
	return effortMsg(provider, levels, effort)
}

// CheckModelEffort says why effort is not a level model (on provider) takes:
// the model's own levels when the catalog lists them, else the harness's.
func CheckModelEffort(cat []Harness, provider, model, effort string) string {
	if m, ok := Find(cat, provider, model); ok && len(m.Efforts) > 0 {
		return effortMsg(m.Label, m.Efforts, effort)
	}
	for _, h := range cat {
		if h.ID == provider {
			return effortMsg(provider, h.Efforts, effort)
		}
	}
	return CheckEffort(provider, effort)
}

func effortMsg(who string, levels []string, effort string) string {
	if len(levels) == 0 {
		return fmt.Sprintf("%s has no reasoning (effort) setting; remove effort", who)
	}
	if slices.Contains(levels, effort) {
		return ""
	}
	return fmt.Sprintf("%s supports %s", who, strings.Join(levels, ", "))
}

// CheckContext says why context does not fit model on provider: a model
// the catalog sizes must use one of its sizes; an unknown model any size
// in range.
func CheckContext(cat []Harness, provider, model string, context int64) string {
	if context < MinContext || context > MaxContext {
		return fmt.Sprintf("must be a whole number of tokens from %d to %d", MinContext, MaxContext)
	}
	m, ok := Find(cat, provider, model)
	if !ok || len(m.Contexts) == 0 {
		return ""
	}
	if slices.Contains(m.Contexts, context) {
		return ""
	}
	return fmt.Sprintf("%s offers %s", m.Label, contextsText(m.Contexts))
}
