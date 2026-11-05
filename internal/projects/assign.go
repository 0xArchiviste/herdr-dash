// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"fmt"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

const machineCacheSeconds = 3600

// Machine is another machine and the profiles it lists.
type Machine struct {
	Name     string
	Profiles []string
	Error    string
}

type configMachine struct {
	ssh      string
	profiles []string
}

// configuredMachines is [machines.*] in config.toml; empty when it fails.
func configuredMachines(configDir string) map[string]configMachine {
	out := map[string]configMachine{}
	text, err := readText(filepath.Join(configDir, "config.toml"))
	if err != nil {
		return out
	}
	m, err := decodeTOML(text)
	if err != nil {
		return out
	}
	o := newObj(m)
	mt, _ := o.table("machines")
	if o.err != nil {
		return map[string]configMachine{}
	}
	for name, v := range mt {
		t, ok := v.(map[string]any)
		if !ok {
			return map[string]configMachine{}
		}
		mo := newObj(t)
		cm := configMachine{ssh: mo.str("ssh", ""), profiles: mo.strings("profiles")}
		if mo.err != nil {
			return map[string]configMachine{}
		}
		out[name] = cm
	}
	return out
}

// cachedMachines reads <root>/.machines.json: the machines and whether the
// cache is younger than an hour.
func cachedMachines(root string, now time.Time) ([]Machine, bool) {
	m, err := readJSONObj(filepath.Join(root, ".machines.json"))
	if err != nil || required(m, "checked", "machines") != nil {
		return nil, false
	}
	o := newObj(m)
	checked := o.u64("checked")
	arr, ok := m["machines"].([]any)
	if o.err != nil || !ok {
		return nil, false
	}
	var out []Machine
	for _, e := range arr {
		em, ok := e.(map[string]any)
		if !ok || required(em, "name", "profiles") != nil {
			return nil, false
		}
		mo := newObj(em)
		mc := Machine{Name: mo.str("name", ""), Profiles: mo.strings("profiles"), Error: mo.str("error", "")}
		if mo.err != nil {
			return nil, false
		}
		out = append(out, mc)
	}
	n := uint64(max(now.Unix(), 0))
	fresh := n < checked || n-checked < machineCacheSeconds
	return out, fresh
}

// remoteMachines is the Rust `assign::remote` without its side effects:
// a fresh cache is used as is. A stale or missing cache is looked up again
// in Rust (ssh to each machine, then the cache is rewritten); the read
// model never writes or reaches other machines, so it lists the machines
// herdr and config.toml know and marks those it would have had to reach.
func (r *Reader) remoteMachines() []Machine {
	if cached, fresh := cachedMachines(r.Root, r.now()); fresh {
		return cached
	}
	targets := map[string]string{}
	for name, e := range configuredMachines(r.ConfigDir) {
		if e.ssh != "" {
			targets[name] = e.ssh
		}
	}
	for _, m := range r.herdr.MachineList() {
		name := m.Label
		if name == "" {
			name = m.ID
		}
		if _, known := targets[name]; m.Target != "" || !known {
			targets[name] = m.Target
		}
	}
	names := make([]string, 0, len(targets))
	for n := range targets {
		names = append(names, n)
	}
	sort.Strings(names)
	out := []Machine{}
	for _, n := range names {
		if targets[n] == "" {
			out = append(out, Machine{Name: n, Profiles: []string{}, Error: "no SSH target"})
		} else {
			out = append(out, Machine{Name: n, Profiles: []string{}, Error: "not looked up by the read model"})
		}
	}
	return out
}

func isMachineName(name string) bool {
	if name == "" || strings.HasPrefix(name, "-") {
		return false
	}
	for _, c := range name {
		if !(c < 0x80 && (isASCIIAlnum(c) || strings.ContainsRune("._-", c))) {
			return false
		}
	}
	return true
}

func mergeMachines(fetched []Machine, configured map[string]configMachine) []Machine {
	byName := map[string]*Machine{}
	for _, m := range fetched {
		m := m
		byName[m.Name] = &m
	}
	names := make([]string, 0, len(configured))
	for n := range configured {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		m, ok := byName[n]
		if !ok {
			m = &Machine{Name: n, Profiles: []string{}}
			byName[n] = m
		}
		for _, p := range configured[n].profiles {
			if !slices.Contains(m.Profiles, p) {
				m.Profiles = append(m.Profiles, p)
			}
		}
		if m.Error == "no SSH target" || len(m.Profiles) > 0 {
			m.Error = ""
		}
	}
	keys := make([]string, 0, len(byName))
	for n := range byName {
		keys = append(keys, n)
	}
	sort.Strings(keys)
	var out []Machine
	for _, n := range keys {
		if isMachineName(n) {
			out = append(out, *byName[n])
		}
	}
	return out
}

// assignableLine is `claude, codex-fast, @m1: claude|pi, @box (not reached...)`.
func assignableLine(local []string, machines []Machine) string {
	parts := slices.Clone(local)
	for _, m := range machines {
		switch {
		case len(m.Profiles) > 0:
			parts = append(parts, fmt.Sprintf("@%s: %s", m.Name, strings.Join(m.Profiles, "|")))
		case m.Error == "":
			parts = append(parts, "@"+m.Name)
		default:
			parts = append(parts, fmt.Sprintf("@%s (not reached, profiles unknown)", m.Name))
		}
	}
	if len(parts) == 0 {
		return "(none; only me)"
	}
	return strings.Join(parts, ", ")
}

// assignableContextLine is the `Assignable:` line of `context`.
func (r *Reader) assignableContextLine(p *Project) string {
	cfg, err := LoadProfiles(r.ConfigDir)
	if err == nil {
		var safety Safety
		safety, err = LoadSafety(r.ConfigDir, p.CanonicalDir())
		if err == nil {
			var settings Settings
			settings, _, err = p.ReadProjectMD()
			if err == nil {
				var local []string
				for _, pr := range Usable(cfg, safety.ThreadProfiles, r.detected(), settings.ThreadProfile) {
					local = append(local, pr.Name)
				}
				machines := mergeMachines(r.remoteMachines(), configuredMachines(r.ConfigDir))
				return "Assignable (agent owners; profile@machine only as listed): " + assignableLine(local, machines) + "\n"
			}
		}
	}
	return "config-error: assignable: " + err.Error() + "\n"
}
