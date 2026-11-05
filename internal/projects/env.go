// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Env is the environment a read runs in: the variables (an empty value
// counts as unset) and HOME. Nothing here reads the process environment
// except EnvFromProcess, so a read is reproducible.
type Env struct {
	vars map[string]string
	Home string
}

// NewEnv builds an Env from variables and extends PATH the way the Rust
// binary does first thing in main: the usual install folders are appended
// (never prepended), so agent detection sees the same CLIs.
func NewEnv(vars map[string]string) (Env, error) {
	v := make(map[string]string, len(vars)+1)
	for k, val := range vars {
		v[k] = val
	}
	home := v["HOME"]
	if home == "" {
		return Env{}, errors.New("HOME is not set")
	}
	dirs := filepath.SplitList(v["PATH"])
	for _, d := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", filepath.Join(home, ".local/bin"), filepath.Join(home, ".cargo/bin")} {
		if !slices.Contains(dirs, d) {
			dirs = append(dirs, d)
		}
	}
	v["PATH"] = strings.Join(dirs, string(os.PathListSeparator))
	return Env{vars: v, Home: home}, nil
}

// EnvFromProcess is NewEnv over this process's environment.
func EnvFromProcess() (Env, error) {
	vars := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			vars[k] = v
		}
	}
	return NewEnv(vars)
}

// Var is a variable's value; empty counts as unset.
func (e Env) Var(key string) (string, bool) {
	v := e.vars[key]
	return v, v != ""
}

// ConfigDir is the fixed user config folder, ~/.config/herdr-projects.
func (e Env) ConfigDir() string { return filepath.Join(e.Home, ".config", "herdr-projects") }

// HerdrBin is HERDR_BIN_PATH, else `herdr` on PATH.
func (e Env) HerdrBin() string {
	if v, ok := e.Var("HERDR_BIN_PATH"); ok {
		return v
	}
	return "herdr"
}

// environ is the variable list a child process gets, with changes applied
// (an empty value removes the variable).
func (e Env) environ(set map[string]string) []string {
	out := make([]string, 0, len(e.vars)+len(set))
	for k, v := range e.vars {
		if _, changed := set[k]; !changed {
			out = append(out, k+"="+v)
		}
	}
	for k, v := range set {
		if v != "" {
			out = append(out, k+"="+v)
		}
	}
	slices.Sort(out)
	return out
}

func (e Env) expandTilde(path string) string {
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		return filepath.Join(e.Home, rest)
	}
	if path == "~" {
		return e.Home
	}
	return path
}

// ResolveRoot is the projects root: flag, then HERDR_PROJECTS_ROOT, then
// `root` in config.toml, then ~/.herdr-projects.
func ResolveRoot(flag string, env Env) (string, error) {
	if flag != "" {
		return filepath.Abs(flag)
	}
	if v, ok := env.Var("HERDR_PROJECTS_ROOT"); ok {
		return filepath.Abs(env.expandTilde(v))
	}
	file := filepath.Join(env.ConfigDir(), "config.toml")
	if text, err := readText(file); err == nil {
		m, err := decodeTOML(text)
		if err != nil {
			return "", errors.New(file + " does not parse: " + err.Error())
		}
		o := newObj(m)
		root := o.str("root", "")
		if o.err != nil {
			return "", errors.New(file + " does not parse: " + o.err.Error())
		}
		if root != "" {
			return filepath.Abs(env.expandTilde(root))
		}
	}
	return filepath.Join(env.Home, ".herdr-projects"), nil
}

// quote is the Rust remote::quote: plain values as they are, anything else
// in single quotes.
func quote(value string) string {
	plain := value != "" && !strings.HasPrefix(value, "-")
	for _, c := range value {
		if !(c < 0x80 && (isASCIIAlnum(c) || strings.ContainsRune("/._-:@+,", c))) {
			plain = false
			break
		}
	}
	if plain {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func isASCIIAlnum(c rune) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

// CommandPrefix is `<binary> --root <root>`, the prefix every printed
// command starts with (the Rust binary uses its own canonical path).
func CommandPrefix(binary, root string) string {
	return quote(binary) + " --root " + quote(root)
}
