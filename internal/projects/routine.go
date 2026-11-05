// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// Routine is routines/<name>.md.
type Routine struct {
	Name string
	// Every is the interval in seconds of `every <N>m|h|d`; Daily is
	// `daily HH:MM`; PREvents is set for `on = "pr"`.
	Every        int64
	DailyH       int
	DailyM       int
	IsDaily      bool
	PREvents     []string
	ScheduleText string
	Command      string
	Enabled      bool
	Prompt       string
	Extra        map[string]any
}

func (r Routine) CommandHash() string { return sha256Hex([]byte(r.Command)) }

// BrokenRoutine is a routine file that could not be used.
type BrokenRoutine struct{ File, Hash, Error string }

var prEvents = []string{"opened", "checks-failed", "review", "merged"}

func parseSchedule(text string, r *Routine) error {
	text = rustTrim(text)
	if rest, ok := strings.CutPrefix(text, "every "); ok {
		rest = rustTrim(rest)
		cut := max(len(rest)-1, 0)
		digits, unit := rest[:cut], rest[cut:]
		n, err := strconv.ParseInt(digits, 10, 64)
		if err != nil || n <= 0 {
			return fmt.Errorf("bad schedule `%s`", text)
		}
		var secs int64
		switch unit {
		case "m":
			secs = 60
		case "h":
			secs = 3600
		case "d":
			secs = 86400
		default:
			return fmt.Errorf("bad schedule `%s`: use `every <N>m`, `<N>h` or `<N>d`", text)
		}
		r.Every = n * secs
		return nil
	}
	if rest, ok := strings.CutPrefix(text, "daily "); ok {
		h, m, found := strings.Cut(rustTrim(rest), ":")
		if !found {
			return fmt.Errorf("bad schedule `%s`", text)
		}
		hh, err := strconv.ParseInt(h, 10, 8)
		if err != nil {
			return errors.New("bad hour")
		}
		mm, err := strconv.ParseInt(m, 10, 8)
		if err != nil {
			return errors.New("bad minute")
		}
		if hh < 0 || hh >= 24 || mm < 0 || mm >= 60 {
			return fmt.Errorf("bad schedule `%s`: the time must be 00:00 to 23:59", text)
		}
		r.IsDaily, r.DailyH, r.DailyM = true, int(hh), int(mm)
		return nil
	}
	return fmt.Errorf("bad schedule `%s`: use `every <N>m|h|d` or `daily HH:MM`", text)
}

// ParseRoutine parses one routine file named name.md.
func ParseRoutine(name, text string) (Routine, error) {
	if err := ValidateSlug(name); err != nil {
		return Routine{}, fmt.Errorf("a routine's file name must follow the slug rule: %w", err)
	}
	front, body, started, closed := splitFrontMatter(text)
	if !started {
		return Routine{}, errors.New("a routine must start with a `+++` line")
	}
	if !closed {
		return Routine{}, errors.New("no closing `+++` line")
	}
	m, err := decodeTOML(front)
	if err == nil {
		r := Routine{Name: name}
		o := newObj(m)
		schedule := o.str("schedule", "")
		command := o.str("command", "")
		r.Enabled = o.boolean("enabled", true)
		on := o.str("on", "")
		events := o.strings("events")
		if o.err != nil {
			return Routine{}, fmt.Errorf("front matter does not parse: %w", o.sourceErr(front))
		}
		r.Extra = o.extra()
		switch on {
		case "":
			if err := parseSchedule(schedule, &r); err != nil {
				return Routine{}, err
			}
			r.ScheduleText = rustTrim(schedule)
		case "pr":
			if rustTrim(command) != "" {
				return Routine{}, errors.New("a `pr` routine prompts the thread; it has no `command`")
			}
			for _, e := range events {
				if !slices.Contains(prEvents, e) {
					return Routine{}, fmt.Errorf("unknown pr event `%s`; use %s", e, strings.Join(prEvents, ", "))
				}
			}
			if len(events) == 0 {
				events = slices.Clone(prEvents)
			}
			r.PREvents = events
			r.ScheduleText = "on pr: " + strings.Join(events, ", ")
		default:
			return Routine{}, fmt.Errorf("`on = \"%s\"` is not a trigger; use `on = \"pr\"` or a `schedule`", on)
		}
		r.Command = rustTrim(command)
		r.Prompt = rustTrim(body)
		return r, nil
	}
	return Routine{}, fmt.Errorf("front matter does not parse: %w", err)
}

// Routines loads routines/*.md (regular files, not dotted), by file name.
func (p *Project) Routines() ([]Routine, []BrokenRoutine) {
	dir := filepath.Join(p.Dir(), "routines")
	names, err := dirNames(dir)
	if err != nil {
		return nil, nil
	}
	var files []string
	for _, n := range names {
		if strings.HasSuffix(n, ".md") && !strings.HasPrefix(n, ".") {
			files = append(files, n)
		}
	}
	sort.Strings(files)
	var routines []Routine
	var broken []BrokenRoutine
	for _, f := range files {
		path := filepath.Join(dir, f)
		if !isRegular(path) {
			continue
		}
		text, err := readText(path)
		if err != nil {
			continue
		}
		r, err := ParseRoutine(trimEndMatches(f, ".md"), text)
		if err != nil {
			broken = append(broken, BrokenRoutine{File: "routines/" + f, Hash: sha256Hex([]byte(text)), Error: err.Error()})
			continue
		}
		routines = append(routines, r)
	}
	return routines, broken
}

func trimEndMatches(s, suffix string) string {
	for suffix != "" && strings.HasSuffix(s, suffix) {
		s = s[:len(s)-len(suffix)]
	}
	return s
}

// Approval is one entry of approved-routines.json.
type Approval struct{ Project, Routine, CommandSHA256, Approved string }

// Approvals reads <config>/approved-routines.json; empty when missing or bad.
func Approvals(configDir string) []Approval {
	v, err := readJSON(filepath.Join(configDir, "approved-routines.json"))
	if err != nil {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []Approval
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok || required(m, "project", "routine", "command_sha256", "approved") != nil {
			return nil
		}
		o := newObj(m)
		a := Approval{o.str("project", ""), o.str("routine", ""), o.str("command_sha256", ""), o.str("approved", "")}
		if o.err != nil {
			return nil
		}
		out = append(out, a)
	}
	return out
}

// IsApproved: an approval for this canonical project folder, this name and
// the command's current hash.
func IsApproved(configDir string, p *Project, r Routine) bool {
	dir, hash := p.CanonicalDir(), r.CommandHash()
	for _, a := range Approvals(configDir) {
		if a.Project == dir && a.Routine == r.Name && a.CommandSHA256 == hash {
			return true
		}
	}
	return false
}
