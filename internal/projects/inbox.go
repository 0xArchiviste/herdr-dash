// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"path/filepath"
	"sort"
	"strings"
)

// InboxItem is inbox/<id>.md: `+++` TOML front matter, and a body only for
// `routine` items.
type InboxItem struct {
	ID, Kind, Subject, Created, Summary, Event string
	Body                                       string
	Extra                                      map[string]any
	File                                       string
}

func parseInboxItem(text string) (*InboxItem, bool) {
	front, body, started, closed := splitFrontMatter(text)
	if !started || !closed {
		return nil, false
	}
	m, err := decodeTOML(front)
	if err != nil {
		return nil, false
	}
	o := newObj(m)
	it := &InboxItem{ID: o.str("id", ""), Kind: o.str("kind", ""), Subject: o.str("subject", ""), Created: o.str("created", ""), Summary: o.str("summary", ""), Event: o.str("event", "")}
	o.take("body") // serde(skip): never read from the front matter
	if o.err != nil {
		return nil, false
	}
	it.Extra = o.extra()
	it.Body = strings.Trim(body, "\n")
	return it, true
}

// Unhandled is every item in inbox/ (not inbox/done/), oldest first.
func (p *Project) Unhandled() []InboxItem {
	dir := filepath.Join(p.Dir(), "inbox")
	names, err := dirNames(dir)
	if err != nil {
		return nil
	}
	var items []InboxItem
	for _, n := range names {
		if !strings.HasSuffix(n, ".md") {
			continue
		}
		text, err := readText(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		if it, ok := parseInboxItem(text); ok {
			it.File = n
			items = append(items, *it)
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}

// Seen is .state/inbox-seen.json: ids `context` has shown.
func (p *Project) Seen() []string {
	v, err := readJSON(filepath.Join(p.stateDir(), "inbox-seen.json"))
	if err != nil {
		return nil
	}
	arr, _ := v.([]any)
	var out []string
	for _, e := range arr {
		s, ok := e.(string)
		if !ok {
			return nil
		}
		out = append(out, s)
	}
	return out
}
