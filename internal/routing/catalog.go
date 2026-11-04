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

// HarnessEfforts are the effort levels each harness accepts, low to high.
// opencode has no effort setting.
var HarnessEfforts = map[string][]string{
	"claude":   {"low", "medium", "high", "xhigh", "max"},
	"codex":    {"minimal", "low", "medium", "high", "xhigh"},
	"opencode": {},
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
	Source   string  `json:"source"`   // built-in, profile, config
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

// Catalog builds the picker's catalog from the built-in models, the
// profiles' models and models a harness config names (extra, per
// provider; opencode ids are provider/model).
func Catalog(profiles map[string]Profile, extra map[string][]Model) []Harness {
	var out []Harness
	for _, p := range Providers {
		h := Harness{ID: p.ID, Label: p.Label, Efforts: HarnessEfforts[p.ID], Models: []Model{}}
		seen := map[string]int{}
		add := func(m Model) {
			if m.ID == "" || !ModelRe.MatchString(m.ID) {
				return
			}
			if i, ok := seen[m.ID]; ok {
				if len(h.Models[i].Contexts) == 0 {
					h.Models[i].Contexts = m.Contexts
				}
				return
			}
			if m.Label == "" {
				m.Label = ModelLabel(p.ID, m.ID)
			}
			if m.Contexts == nil {
				m.Contexts = []int64{}
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
// for: "gpt-6-mini" → "GPT 6 mini"; opencode's "box/qwen3" → "qwen3 via
// opencode (box)". It never invents facts: it only reformats the id.
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
		} else if i == 0 {
			rs := []rune(w)
			rs[0] = unicode.ToUpper(rs[0])
			words[i] = string(rs)
		}
	}
	label := strings.Join(words, " ")
	if provider == "opencode" {
		label += " via opencode"
		if sub != "" {
			label += " (" + sub + ")"
		}
	}
	return label
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

// CheckEffort says why effort is not a level provider accepts ("" if it is).
func CheckEffort(provider, effort string) string {
	levels, ok := HarnessEfforts[provider]
	if !ok {
		return ""
	}
	if len(levels) == 0 {
		return fmt.Sprintf("%s has no reasoning (effort) setting; remove effort", provider)
	}
	if slices.Contains(levels, effort) {
		return ""
	}
	return fmt.Sprintf("%s supports %s", provider, strings.Join(levels, ", "))
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
