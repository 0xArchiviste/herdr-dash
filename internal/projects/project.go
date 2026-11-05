// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

const maxSlug = 40

// ValidateSlug: `[a-z0-9][a-z0-9-]*`, at most 40 bytes.
func ValidateSlug(slug string) error {
	ok := slug != "" && len(slug) <= maxSlug
	for i, c := range slug {
		lowerOrDigit := c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
		if !(lowerOrDigit || i > 0 && c == '-') {
			ok = false
			break
		}
	}
	if !ok {
		return fmt.Errorf("`%s` is not a valid slug (lower-case letters, digits and hyphens, at most %d characters)", slug, maxSlug)
	}
	return nil
}

// Humanize: words split on '-' and '_', each with its first letter upper-cased.
func Humanize(slug string) string {
	var words []string
	for _, w := range strings.FieldsFunc(slug, func(r rune) bool { return r == '-' || r == '_' }) {
		r := []rune(w)
		words = append(words, string(unicode.ToUpper(r[0]))+string(r[1:]))
	}
	return strings.Join(words, " ")
}

// DisplayName is `name` as given unless empty or slug-like, else humanized.
func DisplayName(name, slug string) string {
	name = rustTrim(name)
	base := name
	if base == "" {
		base = slug
	}
	for _, c := range base {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return base
		}
	}
	return Humanize(base)
}

// Repo is one `[[repos]]` entry.
type Repo struct {
	Path    string
	Machine *string
	Extra   map[string]any
}

// Settings is PROJECT.md's front matter.
type Settings struct {
	Name, Goal                        string
	CoordinatorProfile, ThreadProfile string
	MaxParallelThreads                uint32
	AutoResolveDays                   uint32
	Nudge, Mute                       bool
	Repos                             []Repo
	Extra                             map[string]any // keys 0.2.35 does not know
}

func defaultSettings() Settings {
	return Settings{CoordinatorProfile: "claude", ThreadProfile: "claude", MaxParallelThreads: 10, AutoResolveDays: 7, Nudge: true, Repos: []Repo{}}
}

func parseSettings(front string) (Settings, error) {
	s := defaultSettings()
	m, err := decodeTOML(front)
	if err != nil {
		return s, err
	}
	o := newObj(m)
	s.Name = o.str("name", s.Name)
	s.Goal = o.str("goal", s.Goal)
	v, ok := o.alias("coordinator_profile", "coordinator_agent")
	s.CoordinatorProfile = o.asStr("coordinator_profile", v, ok, s.CoordinatorProfile)
	v, ok = o.alias("thread_profile", "thread_agent")
	s.ThreadProfile = o.asStr("thread_profile", v, ok, s.ThreadProfile)
	s.MaxParallelThreads = uint32(o.integer("max_parallel_threads", 0, 1<<32-1, int64(s.MaxParallelThreads)))
	s.AutoResolveDays = uint32(o.integer("auto_resolve_days", 0, 1<<32-1, int64(s.AutoResolveDays)))
	s.Nudge = o.boolean("nudge", s.Nudge)
	s.Mute = o.boolean("mute", s.Mute)
	if rv, ok := o.take("repos"); ok {
		arr, isArr := rv.([]any)
		if !isArr {
			o.fail("invalid type for `repos`: %s, expected a sequence", kindOf(rv))
		}
		for _, e := range arr {
			t, isMap := e.(map[string]any)
			if !isMap {
				o.fail("invalid type in `repos`: %s, expected struct Repo", kindOf(e))
				break
			}
			ro := newObj(t)
			pv, has := ro.take("path")
			if !has {
				o.fail("missing field `path`")
				break
			}
			r := Repo{Path: ro.asStr("path", pv, true, "")}
			if mv, has := ro.take("machine"); has {
				m := ro.asStr("machine", mv, true, "")
				r.Machine = &m
			}
			r.Extra = ro.extra()
			if ro.err != nil {
				o.adopt(ro)
				break
			}
			s.Repos = append(s.Repos, r)
		}
	}
	s.Extra = o.extra()
	return s, o.sourceErr(front)
}

// ParseProjectMD splits PROJECT.md into settings and the instructions body.
func ParseProjectMD(text string) (Settings, string, error) {
	front, body, started, closed := splitFrontMatter(text)
	if !started {
		return defaultSettings(), "", errors.New("PROJECT.md must start with a `+++` line")
	}
	if !closed {
		return defaultSettings(), "", errors.New("PROJECT.md front matter has no closing `+++` line")
	}
	s, err := parseSettings(front)
	if err != nil {
		return s, "", fmt.Errorf("PROJECT.md front matter does not parse: %w", err)
	}
	return s, strings.TrimLeft(body, "\n"), nil
}

// Status of a project (.state/project.json).
type Status string

const (
	Active   Status = "active"
	Paused   Status = "paused"
	Archived Status = "archived"
)

// ProjectState is .state/project.json.
type ProjectState struct {
	Status      Status
	FormerSlugs []string
	Extra       map[string]any
}

// Coordinator is .state/coordinator.json.
type Coordinator struct {
	Socket, Session, WorkspaceID, TabID, PaneID, AgentName, Cwd, Agent, Profile, AgentSession, Updated string
	Extra                                                                                              map[string]any
}

// LivePane is one entry of .state/coordinators.json.
type LivePane struct {
	PaneID, TabID, WorkspaceID, Name, Agent, AgentStatus string
	StateChangeSeq                                       uint64
	PairSince, AgentSession                              string
	Extra                                                map[string]any
}

// Project is one folder under the root.
type Project struct {
	Root, Slug string
}

// LoadProject validates the slug and requires PROJECT.md to be a file.
func LoadProject(root, slug string) (*Project, error) {
	if err := ValidateSlug(slug); err != nil {
		return nil, err
	}
	p := &Project{Root: root, Slug: slug}
	if !isFile(p.projectMD()) {
		return nil, fmt.Errorf("no project `%s` in %s", slug, root)
	}
	return p, nil
}

func (p *Project) Dir() string       { return filepath.Join(p.Root, p.Slug) }
func (p *Project) projectMD() string { return filepath.Join(p.Dir(), "PROJECT.md") }
func (p *Project) stateDir() string  { return filepath.Join(p.Dir(), ".state") }

// CanonicalDir is the folder with symlinks resolved.
func (p *Project) CanonicalDir() string {
	if real, err := filepath.EvalSymlinks(p.Dir()); err == nil {
		if abs, err := filepath.Abs(real); err == nil {
			return abs
		}
	}
	return p.Dir()
}

// ReadProjectMD reads and parses PROJECT.md.
func (p *Project) ReadProjectMD() (Settings, string, error) {
	text, err := readText(p.projectMD())
	if err != nil {
		return defaultSettings(), "", fmt.Errorf("could not read %s: %w", p.projectMD(), err)
	}
	return ParseProjectMD(text)
}

// State reads .state/project.json; anything unreadable is the default.
func (p *Project) State() ProjectState {
	st := ProjectState{Status: Active, FormerSlugs: []string{}}
	m, err := readJSONObj(filepath.Join(p.stateDir(), "project.json"))
	if err != nil {
		return st
	}
	o := newObj(m)
	status := Status(o.str("status", string(Active)))
	switch status {
	case Active, Paused, Archived:
	default:
		o.fail("unknown variant `%s`", status)
	}
	former := o.strings("former_slugs")
	if o.err != nil {
		return st
	}
	return ProjectState{Status: status, FormerSlugs: former, Extra: o.extra()}
}

func (p *Project) Status() Status { return p.State().Status }

// Coordinator reads .state/coordinator.json; nil when missing or bad.
func (p *Project) Coordinator() *Coordinator {
	m, err := readJSONObj(filepath.Join(p.stateDir(), "coordinator.json"))
	if err != nil {
		return nil
	}
	o := newObj(m)
	c := &Coordinator{
		Socket: o.str("socket", ""), Session: o.str("session", ""), WorkspaceID: o.str("workspace_id", ""),
		TabID: o.str("tab_id", ""), PaneID: o.str("pane_id", ""), AgentName: o.str("agent_name", ""),
		Cwd: o.str("cwd", ""), Agent: o.str("agent", ""), Profile: o.str("profile", ""),
		AgentSession: o.str("agent_session", ""), Updated: o.str("updated", ""),
	}
	if o.err != nil {
		return nil
	}
	c.Extra = o.extra()
	return c
}

// LiveCoordinators reads .state/coordinators.json; empty when missing or bad.
func (p *Project) LiveCoordinators() []LivePane {
	v, err := readJSON(filepath.Join(p.stateDir(), "coordinators.json"))
	if err != nil {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []LivePane
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok {
			return nil
		}
		o := newObj(m)
		lp := LivePane{
			PaneID: o.str("pane_id", ""), TabID: o.str("tab_id", ""), WorkspaceID: o.str("workspace_id", ""),
			Name: o.str("name", ""), Agent: o.str("agent", ""), AgentStatus: o.str("agent_status", ""),
			StateChangeSeq: o.u64("state_change_seq"), PairSince: o.str("pair_since", ""), AgentSession: o.str("agent_session", ""),
		}
		if o.err != nil {
			return nil
		}
		lp.Extra = o.extra()
		out = append(out, lp)
	}
	return out
}

// readJSON is the Rust read_json: the file as one JSON value.
func readJSON(path string) (any, error) {
	text, err := readText(path)
	if err != nil {
		return nil, err
	}
	return decodeJSON([]byte(text))
}

func readJSONObj(path string) (map[string]any, error) {
	v, err := readJSON(path)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid type: %s, expected a map", kindOf(v))
	}
	return m, nil
}

// ListSlugs: folders with a PROJECT.md file and a valid slug, not dotted, sorted.
func ListSlugs(root string) []string {
	names, err := dirNames(root)
	if err != nil {
		return nil
	}
	var slugs []string
	for _, n := range names {
		if strings.HasPrefix(n, ".") || ValidateSlug(n) != nil {
			continue
		}
		if isFile(filepath.Join(root, n, "PROJECT.md")) {
			slugs = append(slugs, n)
		}
	}
	sort.Strings(slugs)
	return slugs
}

// Memory is MEMORY.md and the regular .md files under memory/, sorted by
// name, as the brief inlines them. Symbolic links are skipped.
type Memory struct {
	Index string
	Files []MemoryFile
}

type MemoryFile struct{ Name, Text string }

func (p *Project) Memory() Memory {
	idx, _ := readText(filepath.Join(p.Dir(), "MEMORY.md"))
	m := Memory{Index: idx}
	names, _ := dirNames(filepath.Join(p.Dir(), "memory"))
	sort.Strings(names)
	for _, n := range names {
		if !strings.HasSuffix(n, ".md") || strings.HasPrefix(n, ".") {
			continue
		}
		path := filepath.Join(p.Dir(), "memory", n)
		if !isRegular(path) {
			continue
		}
		if text, err := readText(path); err == nil {
			m.Files = append(m.Files, MemoryFile{n, text})
		}
	}
	return m
}
