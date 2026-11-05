// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// Kinds are the 24 agent kinds `herdr agent start` accepts, in herdr's order.
var Kinds = []string{
	"pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid",
	"amp", "grok", "hermes", "kilo", "qodercli", "qwen", "letta", "maki", "muse",
}

func isKind(k string) bool { return slices.Contains(Kinds, k) }

// ProfileEntry is one [profiles.NAME] table.
type ProfileEntry struct {
	Agent, Model, Effort string
	Args                 []string
	Description          string
}

// Profile is a named launch setup; Builtin for a bare kind no table replaces.
type Profile struct {
	Name    string
	Entry   ProfileEntry
	Builtin bool
}

func builtinProfile(kind string) Profile {
	return Profile{Name: kind, Entry: ProfileEntry{Agent: kind, Args: []string{}}, Builtin: true}
}

// Summary: `codex · model gpt-5.5 · effort high — Cheap tier`.
func (p Profile) Summary() string {
	e := p.Entry
	model := "default model"
	if e.Model != "" {
		model = "model " + e.Model
	}
	parts := []string{e.Agent, model}
	if e.Effort != "" {
		parts = append(parts, "effort "+e.Effort)
	}
	if len(e.Args) > 0 {
		parts = append(parts, "args: "+strings.Join(e.Args, " "))
	}
	line := strings.Join(parts, " · ")
	if e.Description != "" {
		line += " — " + e.Description
	}
	return line
}

// ProfileConfig is the profile part of config.toml.
type ProfileConfig struct {
	Profiles map[string]ProfileEntry
	Defaults struct{ ThreadProfile, CoordinatorProfile *string }
}

func (c ProfileConfig) names() []string {
	names := make([]string, 0, len(c.Profiles))
	for n := range c.Profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Get is the user's table, else the built-in of that kind.
func (c ProfileConfig) Get(name string) (Profile, bool) {
	if e, ok := c.Profiles[name]; ok {
		return Profile{Name: name, Entry: e}, true
	}
	if isKind(name) {
		return builtinProfile(name), true
	}
	return Profile{}, false
}

// Listed is the user's profiles, then the detected built-ins they do not replace.
func (c ProfileConfig) Listed(detected []string) []Profile {
	var out []Profile
	for _, n := range c.names() {
		p, _ := c.Get(n)
		out = append(out, p)
	}
	for _, k := range detected {
		if _, replaced := c.Profiles[k]; !replaced {
			out = append(out, builtinProfile(k))
		}
	}
	return out
}

func validateProfileName(name string) error {
	ok := name != "" && len(name) <= 40 && !strings.HasPrefix(name, "-") && !strings.HasPrefix(name, ".")
	for _, c := range name {
		if !(c < 0x80 && (isASCIIAlnum(c) || strings.ContainsRune("._-", c))) {
			ok = false
		}
	}
	if !ok {
		return fmt.Errorf("`%s` is not a profile name: use letters, digits, `.`, `_` and `-` (at most 40)", name)
	}
	return nil
}

func effortValues(agent string) []string {
	switch agent {
	case "claude":
		return []string{"low", "medium", "high", "xhigh", "max"}
	case "codex":
		return []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	case "copilot":
		return []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}
	case "omp":
		return []string{"off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"}
	case "pi":
		return []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}
	}
	return nil
}

func isModelName(v string) bool {
	if v == "" || len(v) > 128 || strings.HasPrefix(v, "-") {
		return false
	}
	for _, c := range v {
		if !(c < 0x80 && (isASCIIAlnum(c) || strings.ContainsRune("._-/:@+[]", c))) {
			return false
		}
	}
	return true
}

func checkTypedArgs(agent, model, effort string) error {
	if model != "" && !isModelName(model) {
		return fmt.Errorf("`%s` does not look like a model name", model)
	}
	if effort != "" {
		values := effortValues(agent)
		if values == nil {
			return fmt.Errorf("herdr-projects knows no reasoning-effort flag for %s; leave effort empty and put the flag in the profile's args", agent)
		}
		if !slices.Contains(values, effort) {
			return fmt.Errorf("effort `%s` is not one of %s for %s", effort, strings.Join(values, ", "), agent)
		}
	}
	return nil
}

var profileKeys = []string{"agent", "model", "effort", "args", "description"}

// LoadProfiles reads config.toml's profiles; no file is an empty config.
func LoadProfiles(configDir string) (ProfileConfig, error) {
	cfg := ProfileConfig{Profiles: map[string]ProfileEntry{}}
	file := filepath.Join(configDir, "config.toml")
	text, err := readText(file)
	if err != nil {
		return cfg, nil
	}
	m, err := decodeTOML(text)
	if err != nil {
		return cfg, fmt.Errorf("%s does not parse: %w", file, err)
	}
	o := newObj(m)
	if pt, ok := o.table("profiles"); ok {
		for name, v := range pt {
			t, isMap := v.(map[string]any)
			if !isMap {
				o.fail("invalid type: %s, expected struct Entry", kindOf(v))
				break
			}
			eo := newObj(t)
			e := ProfileEntry{Agent: eo.str("agent", ""), Model: eo.str("model", ""), Effort: eo.str("effort", ""), Args: eo.strings("args"), Description: eo.str("description", "")}
			eo.denyUnknown(profileKeys...)
			if eo.err != nil {
				o.adopt(eo)
				break
			}
			cfg.Profiles[name] = e
		}
	}
	if dt, ok := o.table("defaults"); ok {
		do := newObj(dt)
		if v, has := do.take("thread_profile"); has {
			s := do.asStr("thread_profile", v, true, "")
			cfg.Defaults.ThreadProfile = &s
		}
		if v, has := do.take("coordinator_profile"); has {
			s := do.asStr("coordinator_profile", v, true, "")
			cfg.Defaults.CoordinatorProfile = &s
		}
		do.denyUnknown("thread_profile", "coordinator_profile")
		if do.err != nil {
			o.adopt(do)
		}
	}
	if o.err != nil {
		return ProfileConfig{Profiles: map[string]ProfileEntry{}}, fmt.Errorf("%s does not parse: %w", file, o.sourceErr(text))
	}
	for _, name := range cfg.names() {
		e := cfg.Profiles[name]
		var verr error
		if err := validateProfileName(name); err != nil {
			verr = err
		} else if !isKind(e.Agent) {
			verr = fmt.Errorf("agent `%s` is not a Herdr agent kind (%s)", e.Agent, strings.Join(Kinds, ", "))
		} else {
			verr = checkTypedArgs(e.Agent, e.Model, e.Effort)
		}
		if verr != nil {
			return ProfileConfig{Profiles: map[string]ProfileEntry{}}, fmt.Errorf("%s: [profiles.%s]: %w", file, name, verr)
		}
	}
	return cfg, nil
}

// Safety is the effective [safety] settings of one project.
type Safety struct {
	StartThreads                          string
	CoordinatorAgentArgs, ThreadAgentArgs []string
	RoutineCommands, Yolo                 bool
	TrustScreens                          string
	ThreadProfiles, CoordinatorProfiles   []string // nil: every profile
}

type safetyLayer struct {
	startThreads, trustScreens                                       *string
	coordArgs, threadArgs, threadProfiles, coordProfiles             []string
	hasCoordArgs, hasThreadArgs, hasThreadProfiles, hasCoordProfiles bool
	routineCommands, yolo                                            *bool
}

func readLayer(m map[string]any, src string) (safetyLayer, error) {
	var l safetyLayer
	o := newObj(m)
	optStr := func(k string) *string {
		if v, ok := o.take(k); ok {
			s := o.asStr(k, v, true, "")
			return &s
		}
		return nil
	}
	optBool := func(k string) *bool {
		if _, ok := o.m[k]; ok {
			b := o.boolean(k, false)
			return &b
		}
		o.used[k] = true
		return nil
	}
	optList := func(k string) ([]string, bool) {
		if _, ok := o.m[k]; ok {
			return o.strings(k), true
		}
		o.used[k] = true
		return nil, false
	}
	l.startThreads = optStr("start_threads")
	l.coordArgs, l.hasCoordArgs = optList("coordinator_agent_args")
	l.threadArgs, l.hasThreadArgs = optList("thread_agent_args")
	l.routineCommands = optBool("routine_commands")
	l.yolo = optBool("yolo")
	l.trustScreens = optStr("trust_screens")
	l.threadProfiles, l.hasThreadProfiles = optList("thread_profiles")
	l.coordProfiles, l.hasCoordProfiles = optList("coordinator_profiles")
	return l, o.sourceErr(src)
}

// LoadSafety merges the project's own [safety."<canonical dir>"] table over
// [safety.default] over the built-in defaults. Yolo forces start_threads
// to "auto". canonicalDir "" reads only the default table.
func LoadSafety(configDir, canonicalDir string) (Safety, error) {
	file := filepath.Join(configDir, "config.toml")
	var def, own safetyLayer
	if text, err := readText(file); err == nil {
		m, err := decodeTOML(text)
		if err != nil {
			return Safety{}, fmt.Errorf("%s does not parse: %w", file, err)
		}
		o := newObj(m)
		st, _ := o.table("safety")
		if o.err != nil {
			return Safety{}, fmt.Errorf("%s does not parse: %w", file, o.sourceErr(text))
		}
		// Every table under [safety] must be a valid layer, as serde reads
		// the whole map before picking two.
		layers := map[string]safetyLayer{}
		keys := make([]string, 0, len(st))
		for k := range st {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			t, isMap := st[k].(map[string]any)
			if !isMap {
				return Safety{}, fmt.Errorf("%s does not parse: invalid type: %s, expected struct SafetyLayer", file, kindOf(st[k]))
			}
			l, err := readLayer(t, text)
			if err != nil {
				return Safety{}, fmt.Errorf("%s does not parse: %w", file, err)
			}
			layers[k] = l
		}
		def = layers["default"]
		if canonicalDir != "" {
			own = layers[canonicalDir]
		}
		for _, l := range []safetyLayer{def, own} {
			if l.startThreads != nil && *l.startThreads != "propose" && *l.startThreads != "auto" {
				return Safety{}, fmt.Errorf("%s: start_threads must be \"propose\" or \"auto\", not %s", file, rustDebug(*l.startThreads))
			}
			if l.trustScreens != nil && *l.trustScreens != "coordinator" && *l.trustScreens != "user" {
				return Safety{}, fmt.Errorf("%s: trust_screens must be \"coordinator\" or \"user\", not %s", file, rustDebug(*l.trustScreens))
			}
		}
	}
	pickB := func(a, b *bool, d bool) bool {
		if a != nil {
			return *a
		}
		if b != nil {
			return *b
		}
		return d
	}
	pickS := func(a, b *string, d string) string {
		if a != nil {
			return *a
		}
		if b != nil {
			return *b
		}
		return d
	}
	pickL := func(a []string, ha bool, b []string, hb bool) ([]string, bool) {
		if ha {
			return a, true
		}
		return b, hb
	}
	yolo := pickB(own.yolo, def.yolo, false)
	s := Safety{Yolo: yolo, RoutineCommands: pickB(own.routineCommands, def.routineCommands, false)}
	if yolo {
		s.StartThreads = "auto"
	} else {
		s.StartThreads = pickS(own.startThreads, def.startThreads, "propose")
	}
	trustDefault := "user"
	if yolo {
		trustDefault = "coordinator"
	}
	s.TrustScreens = pickS(own.trustScreens, def.trustScreens, trustDefault)
	s.CoordinatorAgentArgs, _ = pickL(own.coordArgs, own.hasCoordArgs, def.coordArgs, def.hasCoordArgs)
	s.ThreadAgentArgs, _ = pickL(own.threadArgs, own.hasThreadArgs, def.threadArgs, def.hasThreadArgs)
	if s.CoordinatorAgentArgs == nil {
		s.CoordinatorAgentArgs = []string{}
	}
	if s.ThreadAgentArgs == nil {
		s.ThreadAgentArgs = []string{}
	}
	var has bool
	if s.ThreadProfiles, has = pickL(own.threadProfiles, own.hasThreadProfiles, def.threadProfiles, def.hasThreadProfiles); has && s.ThreadProfiles == nil {
		s.ThreadProfiles = []string{}
	}
	if s.CoordinatorProfiles, has = pickL(own.coordProfiles, own.hasCoordProfiles, def.coordProfiles, def.hasCoordProfiles); has && s.CoordinatorProfiles == nil {
		s.CoordinatorProfiles = []string{}
	}
	return s, nil
}

// ---------------------------------------------------------------- detection

func executable(kind string) string {
	switch kind {
	case "cursor":
		return "cursor-agent"
	case "kiro":
		return "kiro-cli"
	}
	return kind
}

func onPath(env Env, name string) bool {
	path, _ := env.Var("PATH")
	for _, dir := range strings.Split(path, ":") {
		if dir == "" {
			continue
		}
		info, err := os.Stat(filepath.Join(dir, name))
		if err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return true
		}
	}
	return false
}

func signedIn(env Env, kind string) bool {
	home := env.Home
	anyVar := func(names ...string) bool {
		for _, n := range names {
			if _, ok := env.Var(n); ok {
				return true
			}
		}
		return false
	}
	anyFile := func(paths ...string) bool {
		for _, p := range paths {
			if isFile(p) {
				return true
			}
		}
		return false
	}
	fileHas := func(path, needle string) bool {
		t, err := readText(path)
		return err == nil && strings.Contains(t, needle)
	}
	dirOf := func(v, fallback string) string {
		if d, ok := env.Var(v); ok {
			return d
		}
		return filepath.Join(home, fallback)
	}
	switch kind {
	case "claude":
		cfg := dirOf("CLAUDE_CONFIG_DIR", ".claude")
		return anyVar("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX") ||
			anyFile(filepath.Join(cfg, ".credentials.json")) ||
			fileHas(filepath.Join(home, ".claude.json"), `"oauthAccount"`) || fileHas(filepath.Join(cfg, ".claude.json"), `"oauthAccount"`)
	case "codex":
		return anyVar("OPENAI_API_KEY", "CODEX_ACCESS_TOKEN") || anyFile(filepath.Join(dirOf("CODEX_HOME", ".codex"), "auth.json"))
	case "gemini":
		return anyVar("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI") || anyFile(filepath.Join(home, ".gemini/oauth_creds.json"))
	case "copilot":
		return anyVar("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN") || isDir(dirOf("COPILOT_HOME", ".copilot"))
	case "opencode":
		data := dirOf("XDG_DATA_HOME", ".local/share")
		return anyFile(filepath.Join(data, "opencode/auth.json")) || anyVar("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
	case "cursor":
		return anyVar("CURSOR_API_KEY") || isFile(filepath.Join(home, ".cursor/cli-config.json"))
	case "pi":
		return anyFile(filepath.Join(dirOf("PI_CODING_AGENT_DIR", ".pi/agent"), "auth.json")) || anyVar("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY")
	case "omp":
		return anyFile(filepath.Join(home, ".omp/agent/agent.db"), filepath.Join(home, ".omp/agent/.env"), filepath.Join(home, ".omp/.env")) || anyVar("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY")
	}
	return true
}

// Detect is the kinds whose CLI is on PATH and looks signed in, in order.
func Detect(env Env) []string {
	var out []string
	for _, k := range Kinds {
		if onPath(env, executable(k)) && signedIn(env, k) {
			out = append(out, k)
		}
	}
	return out
}

// Usable is the profiles to offer a role: the listed ones it may use, the
// allow-list's own names, and its default when allowed but not listed.
func Usable(cfg ProfileConfig, allowed []string, detected []string, def string) []Profile {
	ok := func(name string) bool { return allowed == nil || slices.Contains(allowed, name) }
	var out []Profile
	has := func(name string) bool {
		return slices.ContainsFunc(out, func(p Profile) bool { return p.Name == name })
	}
	for _, p := range cfg.Listed(detected) {
		if ok(p.Name) {
			out = append(out, p)
		}
	}
	for _, name := range allowed {
		if !has(name) {
			if p, found := cfg.Get(name); found {
				out = append(out, p)
			}
		}
	}
	if ok(def) && !has(def) {
		if p, found := cfg.Get(def); found {
			out = append([]Profile{p}, out...)
		}
	}
	return out
}
