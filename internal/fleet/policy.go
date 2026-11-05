package fleet

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/pelletier/go-toml/v2"
)

// Policy is fleet.toml (version 1): the priority flag (displayed; the
// scheduler does not enforce it yet), each project's mode for bulk actions,
// the limits and the kill switch.
type Policy struct {
	Path     string          `json:"path"`
	Found    bool            `json:"found"`
	Error    string          `json:"error,omitempty"`
	Priority map[string]bool `json:"-"`
	Projects []string        `json:"priority"` // slugs flagged priority, sorted
	// Modes holds the projects not in ModeFull, by slug.
	Modes   map[string]string `json:"modes"`
	Limits  Limits            `json:"limits"`
	Enabled bool              `json:"enabled"` // false: previews only
}

// Project modes for bulk actions.
const (
	ModeFull     = "full"      // every action
	ModeReadOnly = "read-only" // reads and tier 0 only
	ModeOff      = "off"       // no bulk action at all
)

// Mode is slug's mode (full unless fleet.toml says otherwise).
func (p Policy) Mode(slug string) string {
	if m := p.Modes[slug]; m != "" {
		return m
	}
	return ModeFull
}

// Limits are fleet.toml's [limits], with the user's accepted defaults.
type Limits struct {
	BatchWithoutConfirm      int `json:"batch_without_confirm" toml:"batch_without_confirm"`
	BatchMax                 int `json:"batch_max" toml:"batch_max"`
	ActionsPerMinute         int `json:"actions_per_minute" toml:"actions_per_minute"`
	BroadcastCooldownMinutes int `json:"broadcast_cooldown_minutes" toml:"broadcast_cooldown_minutes"`
}

// DefaultLimits: 5 targets without confirmation, 30 at most per batch, 10
// actions a minute fleet-wide, 10 minutes between broadcasts to one
// coordinator.
var DefaultLimits = Limits{BatchWithoutConfirm: 5, BatchMax: 30, ActionsPerMinute: 10, BroadcastCooldownMinutes: 10}

// DefaultPath is $XDG_CONFIG_HOME/herdr-projects/fleet.toml, next to
// routing.toml.
func DefaultPath(getenv func(string) string, home string) string {
	base := getenv("XDG_CONFIG_HOME")
	if base == "" || !filepath.IsAbs(base) {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "herdr-projects", "fleet.toml")
}

type fileV1 struct {
	Version  int                     `toml:"version"`
	Enabled  *bool                   `toml:"enabled"`
	Limits   map[string]any          `toml:"limits"`
	Projects map[string]projectPrefs `toml:"projects"`
}

type projectPrefs struct {
	// Priority is the user's exclusive on/off flag; "high" (the plan's
	// draft spelling) reads as on, "normal" and "low" as off.
	Priority any `toml:"priority"`
	// Mode is full, read-only or off; master is the plan's draft name.
	Mode   string `toml:"mode"`
	Master string `toml:"master"`
}

func emptyPolicy(path string) Policy {
	return Policy{Path: path, Priority: map[string]bool{}, Projects: []string{}, Modes: map[string]string{}, Limits: DefaultLimits, Enabled: true}
}

// Parse reads fleet.toml's bytes.
func Parse(path string, b []byte) Policy {
	p := emptyPolicy(path)
	p.Found = true
	var f fileV1
	// A file that does not parse turns bulk actions off: its read-only and
	// off projects would otherwise read as full.
	if err := toml.Unmarshal(b, &f); err != nil {
		p.Error = "fleet.toml: " + err.Error() + " (bulk actions are off until it parses)"
		p.Enabled = false
		return p
	}
	if f.Version != 0 && f.Version != 1 {
		p.Error = fmt.Sprintf("fleet.toml: version %d is not supported (1 is; bulk actions are off)", f.Version)
		p.Enabled = false
		return p
	}
	if f.Enabled != nil {
		p.Enabled = *f.Enabled
	}
	for k, v := range f.Limits {
		n, ok := v.(int64)
		if !ok || n < 1 || n > 100000 {
			p.Error = fmt.Sprintf("fleet.toml: limits.%s is not a positive number", k)
			continue
		}
		switch k {
		case "batch_without_confirm":
			p.Limits.BatchWithoutConfirm = int(n)
		case "batch_max":
			p.Limits.BatchMax = int(n)
		case "actions_per_minute":
			p.Limits.ActionsPerMinute = int(n)
		case "broadcast_cooldown_minutes":
			p.Limits.BroadcastCooldownMinutes = int(n)
		}
	}
	for slug, pr := range f.Projects {
		mode := pr.Mode
		if mode == "" {
			mode = pr.Master
		}
		switch mode {
		case "", ModeFull:
		case ModeReadOnly, ModeOff:
			p.Modes[slug] = mode
		default:
			// An unknown mode protects the project rather than opening it.
			p.Modes[slug] = ModeReadOnly
			p.Error = fmt.Sprintf("fleet.toml: projects.%s.mode = %q is not full, read-only or off (read as read-only)", slug, mode)
		}
		on := false
		switch v := pr.Priority.(type) {
		case nil:
		case bool:
			on = v
		case string:
			switch v {
			case "high", "on", "true":
				on = true
			case "normal", "low", "off", "false", "":
			default:
				p.Error = fmt.Sprintf("fleet.toml: projects.%s.priority = %q is not true or false", slug, v)
			}
		default:
			p.Error = fmt.Sprintf("fleet.toml: projects.%s.priority is not true or false", slug)
		}
		if on {
			p.Priority[slug] = true
			p.Projects = append(p.Projects, slug)
		}
	}
	sort.Strings(p.Projects)
	return p
}

// PolicyFile caches fleet.toml, re-reading it only when its size or mtime
// changes, so a request costs one stat.
type PolicyFile struct {
	Path string
	mu   sync.Mutex
	key  string
	pol  Policy
}

func (f *PolicyFile) Load() Policy {
	f.mu.Lock()
	defer f.mu.Unlock()
	none := emptyPolicy(f.Path)
	if f.Path == "" || f.Path == "off" {
		return none
	}
	st, err := os.Stat(f.Path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			none.Error = "fleet.toml: " + err.Error()
			none.Enabled = false
		}
		f.key = ""
		return none
	}
	key := fmt.Sprintf("%d.%d", st.Size(), st.ModTime().UnixNano())
	if key == f.key {
		return f.pol
	}
	b, err := os.ReadFile(f.Path)
	if err != nil {
		none.Error = "fleet.toml: " + err.Error()
		none.Enabled = false
		return none
	}
	f.key, f.pol = key, Parse(f.Path, b)
	return f.pol
}

// SetPriority writes projects.<slug>.priority into fleet.toml (creating the
// file), keeping every other key. Comments are not kept: the file is
// re-encoded. The write is atomic (a temp file renamed over it).
func (f *PolicyFile) SetPriority(slug string, on bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Path == "" || f.Path == "off" {
		return errors.New("no fleet.toml (--fleet-config off)")
	}
	m := map[string]any{}
	b, err := os.ReadFile(f.Path)
	switch {
	case err == nil:
		if err := toml.Unmarshal(b, &m); err != nil {
			return fmt.Errorf("fleet.toml does not parse: %w", err)
		}
	case errors.Is(err, fs.ErrNotExist):
		m["version"] = 1
	default:
		return err
	}
	ps, _ := m["projects"].(map[string]any)
	if ps == nil {
		ps = map[string]any{}
		m["projects"] = ps
	}
	p, _ := ps[slug].(map[string]any)
	if p == nil {
		p = map[string]any{}
		ps[slug] = p
	}
	p["priority"] = on
	out, err := toml.Marshal(m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(f.Path), ".fleet.toml.*.tmp")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), f.Path); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	f.key = "" // re-read on the next Load
	return nil
}
