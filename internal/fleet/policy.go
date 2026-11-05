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

// Policy is what the Master window shows of fleet.toml (version 1). Stage
// 1a only reads it: the priority flag is displayed, nothing enforces it yet.
type Policy struct {
	Path     string          `json:"path"`
	Found    bool            `json:"found"`
	Error    string          `json:"error,omitempty"`
	Priority map[string]bool `json:"-"`
	Projects []string        `json:"priority"` // slugs flagged priority, sorted
}

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
	Version  int                    `toml:"version"`
	Projects map[string]projectPrefs `toml:"projects"`
}

type projectPrefs struct {
	// Priority is the user's exclusive on/off flag; "high" (the plan's
	// draft spelling) reads as on, "normal" and "low" as off.
	Priority any `toml:"priority"`
}

// Parse reads fleet.toml's bytes.
func Parse(path string, b []byte) Policy {
	p := Policy{Path: path, Found: true, Priority: map[string]bool{}, Projects: []string{}}
	var f fileV1
	if err := toml.Unmarshal(b, &f); err != nil {
		p.Error = "fleet.toml: " + err.Error()
		return p
	}
	if f.Version != 0 && f.Version != 1 {
		p.Error = fmt.Sprintf("fleet.toml: version %d is not supported (1 is)", f.Version)
		return p
	}
	for slug, pr := range f.Projects {
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
	none := Policy{Path: f.Path, Priority: map[string]bool{}, Projects: []string{}}
	if f.Path == "" || f.Path == "off" {
		return none
	}
	st, err := os.Stat(f.Path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			none.Error = "fleet.toml: " + err.Error()
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
		return none
	}
	f.key, f.pol = key, Parse(f.Path, b)
	return f.pol
}
