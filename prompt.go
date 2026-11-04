package main

// Prompt cards: a blocked pane's screen parsed into the prompt it shows (a
// permission request, a question menu, a trust dialog, a y/n confirmation)
// with, for each option, the keys that pick it. Layouts come from real
// Claude Code, Codex and opencode screens (testdata/prompts/). Anything else
// parses to nil and the page falls back to its generic keys.

import (
	"crypto/sha1"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

type PromptOption struct {
	Label   string   `json:"label"`
	Detail  string   `json:"detail,omitempty"`
	Keys    []string `json:"keys"`              // pick it (no text); empty: not answerable by keys
	Text    string   `json:"text,omitempty"`    // "required" or "optional": the option takes typed text
	Always  bool     `json:"always,omitempty"`  // a lasting grant: don't ask again, trust, auto mode
	Current bool     `json:"current,omitempty"` // highlighted
	Checked *bool    `json:"checked,omitempty"` // multi-select: toggled by Keys
	Submit  bool     `json:"submit,omitempty"`  // multi-select: sends the checked set
	Draft   string   `json:"draft,omitempty"`   // text already typed into its field in the pane
	Preview string   `json:"preview,omitempty"` // the preview the pane shows beside it (highlighted row only)
	// TextKeys open its text field (then the text is typed, then TextThen
	// is pressed); nil: text cannot be typed from here right now.
	TextKeys []string `json:"text_keys,omitempty"`
	TextThen []string `json:"-"`
}

// PromptTab is one of the question tabs Claude draws above a menu.
type PromptTab struct {
	Label   string `json:"label"`
	Done    bool   `json:"done,omitempty"`
	Current bool   `json:"current,omitempty"`
}

type Prompt struct {
	Kind      string         `json:"kind"`    // permission, question, plan, trust, confirm
	Harness   string         `json:"harness"` // claude, codex, opencode, other
	Title     string         `json:"title,omitempty"`
	Question  string         `json:"question,omitempty"`
	Subject   string         `json:"subject,omitempty"` // command, file, URL, folder
	Desc      string         `json:"desc,omitempty"`
	Detail    string         `json:"detail,omitempty"` // diff, plan or longer text
	Multi     bool           `json:"multi,omitempty"`
	Notes     bool           `json:"notes,omitempty"`   // options take notes ("n"), not answers
	Focused   bool           `json:"focused,omitempty"` // a text field in the pane has the keyboard
	Tabs      []PromptTab    `json:"tabs,omitempty"`
	Cancel    []string       `json:"cancel,omitempty"` // Esc: cancel or deny, as the pane says
	Prev      []string       `json:"prev,omitempty"`   // previous / next question tab
	Next      []string       `json:"next,omitempty"`
	Options   []PromptOption `json:"options"`
	Summary   string         `json:"summary"`
	Sig       string         `json:"sig"` // same prompt, same sig (highlight, checks and typed text aside)
	sigLabels []string       // per option: what the sig takes of it (typed text left out)
}

// pline is one screen line: its raw text (with escapes) and its plain text,
// with an opencode box bar ("┃") taken off the front.
type pline struct {
	raw, text string
	plain     string // text with any bar still on
	bar       bool   // drawn inside a bar ("│", "┃"): joins only with its kind
	width     int    // columns of the last screen line in it (before the bar came off)
}

var (
	oscRe      = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
	optRe      = regexp.MustCompile(`^(\s*)(?:([❯›>▸])\s*)?(\d{1,2})\.\s+(\S.*?)\s*$`)
	cursorRe   = regexp.MustCompile(`^(\s*)❯ (\S.*?)\s*$`)
	sepRe      = regexp.MustCompile(`^\s*[─━]{8,}\s*$`)
	dashRe     = regexp.MustCompile(`^\s*[╌┄]{8,}\s*$`)
	emptyBoxRe = regexp.MustCompile(`^\s*[❯>›]\s*$`)
	hintRe     = regexp.MustCompile(`\s+\((esc|[a-z])\)$`)
	boxRe      = regexp.MustCompile(`^\[([ ✔✓xX×])\]\s*`)
	ynRe       = regexp.MustCompile(`^(.*?)\s*[\[(]\s*[yY](?:es)?\s*/\s*[nN]o?\s*[\])]\s*:?\s*$`)
	alwaysRe   = regexp.MustCompile(`(?i)don['’]?t ask again|always|allow all|for this session|auto mode|accept edits|auto-approve|in the future|(from|for) this project|allow this host|trust`)
	textRe     = regexp.MustCompile(`(?i)^type something|^type your own answer|^other\b`)
	tellRe     = regexp.MustCompile(`(?i)tell \w+ what to do differently`)
	planRe     = regexp.MustCompile(`(?i)written up a plan|ready to execute`)
	planTellRe = regexp.MustCompile(`^Tell \w+ what to change$`)
	amendHelp  = regexp.MustCompile(`^and tell \w+ what to do (next|differently)$`)
	tabRe      = regexp.MustCompile(`([☐☒✔])\s+([^☐☒✔←→]+)`)
	permQRe    = regexp.MustCompile(`(?i)^(do you want|would you like|allow\b)`)
	diffRe     = regexp.MustCompile(`^\s*\d+\s*[-+] `)
	tabsRe     = regexp.MustCompile(`[☐☒✔]`)
	pathRe     = regexp.MustCompile(`^\s*([~/][^\s]*)\s*$`)
	codexFile  = regexp.MustCompile(`^\s*(\S+) \(\+\d+ -\d+\)\s*$`)
)

var trustPhrases = []string{
	"Quick safety check: Is this a project you created or one you trust",
	"Do you trust the files in this folder?", "Yes, I trust this folder",
	"Trust this folder?", "Do you trust the contents of this directory?", "Trust all and continue",
	"Your trust decision will be saved", "Do you trust this folder?",
}

func plainLine(s string) string {
	s = oscRe.ReplaceAllString(s, "")
	s = ansiRe.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\u00a0", " ") // herdr draws Claude's empty input box as "❯" + NBSP
	return strings.TrimRight(s, " \t")
}

func barless(s string) string {
	t := strings.TrimLeft(s, " ")
	// opencode's box bar, and the bar Claude draws beside a long question.
	if strings.HasPrefix(t, "┃") || strings.HasPrefix(t, "╹") || strings.HasPrefix(t, "│ ") {
		t = strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(t, "┃"), "╹"), "│")
		return strings.TrimPrefix(t, " ")
	}
	return s
}

// ParsePrompt reads the prompt at the bottom of screen (plain or ANSI text),
// or nil. agent is herdr's agent name for the pane, when known.
func ParsePrompt(screen, agent string) *Prompt {
	var ls []pline
	for _, r := range strings.Split(screen, "\n") {
		plain := plainLine(r)
		text := barless(plain)
		ls = append(ls, pline{raw: r, text: text, plain: plain, bar: text != plain && strings.TrimSpace(plain) != strings.TrimSpace(text), width: utf8.RuneCountInString(plain)})
	}
	for len(ls) > 0 && strings.TrimSpace(ls[len(ls)-1].text) == "" {
		ls = ls[:len(ls)-1]
	}
	if len(ls) == 0 {
		return nil
	}
	if len(ls) > planLines { // a plan runs long
		ls = ls[len(ls)-planLines:]
	}
	pv := splitPreview(ls)
	if pv != nil {
		ls = pv.ls
	}
	ls = unwrap(ls)
	var p *Prompt
	numbered := func(ls []pline) *Prompt { return numberedPrompt(ls, pv) }
	for _, f := range []func([]pline) *Prompt{buttonPrompt, numbered, cursorPrompt, ynPrompt} {
		if p = f(ls); p != nil {
			break
		}
	}
	if p == nil || len(p.Options) < 2 && p.Kind != "confirm" {
		return nil
	}
	p.Harness = harness(agent, ls)
	if p.Harness == "codex" && p.Kind == "trust" {
		arrowKeys(p)
	}
	finish(p)
	return p
}

// arrowKeys replaces digit keys with arrows from the highlighted option,
// then Enter (no keys without a visible highlight). Codex's trust screen
// ignores the digit of the row already highlighted.
func arrowKeys(p *Prompt) {
	cur := -1
	for i, o := range p.Options {
		if o.Current {
			cur = i
		}
	}
	for i := range p.Options {
		p.Options[i].Keys = nil
		if cur >= 0 {
			p.Options[i].Keys = arrows(i-cur, "up", "down")
		}
	}
}

// unwrap joins the lines an agent wrapped to fit the pane back into one:
// a line continues the one above when the first word of it would not have
// fit there. A word split mid-way (the line above reaches the edge and the
// halves are too long for any line) joins without a space. Menu rows, rules and blank lines never join.
func unwrap(ls []pline) []pline {
	w := 0
	for _, l := range ls {
		if sepRe.MatchString(l.text) || dashRe.MatchString(l.text) {
			w = max(w, l.width)
		}
	}
	if w == 0 {
		for _, l := range ls {
			w = max(w, l.width)
		}
	}
	if w < 40 {
		return ls
	}
	edge := w - 2 // the agents keep a column or two free on the right
	brk := func(t string) bool {
		s := strings.TrimSpace(t)
		return s == "" || sepRe.MatchString(t) || dashRe.MatchString(t) || optRe.MatchString(t) || cursorRe.MatchString(t) ||
			strings.HasPrefix(s, "$ ") || strings.TrimSpace(t) == "Submit"
	}
	out := make([]pline, 0, len(ls))
	for _, l := range ls {
		if n := len(out); n > 0 && !brk(l.text) {
			prev := &out[n-1]
			pt := strings.TrimSpace(prev.text)
			word := []rune(strings.Fields(l.text)[0])
			full := prev.width >= edge
			// A word too long for any line is broken where the line ends: only
			// a full line above can be its first part.
			long := len(word) >= w-indent(l.text)-2
			if pt != "" && !sepRe.MatchString(prev.text) && !dashRe.MatchString(prev.text) && prev.bar == l.bar &&
				indent(l.text) >= indent(prev.text) && prev.width+1+len(word) > edge && (!long || full) {
				// Split mid-word: the two halves are one token too long for a line.
				pw := strings.Fields(prev.text)
				join := " "
				if full && len([]rune(pw[len(pw)-1]))+len(word) > w-indent(l.text)-2 {
					join = ""
				}
				prev.text = strings.TrimRight(prev.text, " ") + join + strings.TrimSpace(l.text)
				prev.width = l.width
				continue
			}
		}
		out = append(out, l)
	}
	return out
}

func harness(agent string, ls []pline) string {
	switch agent {
	case "claude", "codex", "opencode":
		return agent
	}
	all := ""
	for _, l := range ls {
		all += l.text + "\n"
	}
	switch {
	case strings.Contains(all, "Claude"), strings.Contains(all, "Esc to cancel"):
		return "claude"
	case strings.Contains(all, "Codex"):
		return "codex"
	case strings.Contains(all, "⇆ select"), strings.Contains(all, "OpenCode"):
		return "opencode"
	}
	return "other"
}

// below reports whether the lines after i are only a footer: a few short
// lines, no empty input box (an idle agent's prompt).
func footerOnly(ls []pline, i int) bool {
	n := 0
	for _, l := range ls[i+1:] {
		t := strings.TrimSpace(l.text)
		if t == "" || sepRe.MatchString(l.text) {
			continue
		}
		if emptyBoxRe.MatchString(l.text) {
			return false
		}
		n++
	}
	return n <= 3
}

// ---------------------------------------------------------------- numbered menus

type row struct {
	opt    *PromptOption
	raw    string // the label as drawn, box and hints aside
	more   []string
	num    int
	cursor bool
	line   int
	submit bool
}

func numberedPrompt(ls []pline, pv *preview) *Prompt {
	last := -1
	for i := len(ls) - 1; i >= 0 && i >= len(ls)-12; i-- {
		if m := optRe.FindStringSubmatch(ls[i].text); m != nil {
			last = i
			break
		}
	}
	if last < 0 || !footerOnly(ls, last) {
		return nil
	}
	// Walk up to the menu's first row: options, their indented descriptions,
	// a "Submit" row and separators between rows.
	start := last
	for i := last - 1; i >= 0; i-- {
		t := ls[i].text
		if strings.TrimSpace(t) == "" {
			break
		}
		if optRe.MatchString(t) {
			start = i
			continue
		}
		if sepRe.MatchString(t) || strings.TrimSpace(t) == "Submit" || indent(t) > indent(ls[start].text) {
			continue
		}
		break
	}
	// The last row's own lines under it: a description, or the second line
	// of text typed into it.
	end := last
	for end+1 < len(ls) && strings.TrimSpace(ls[end+1].text) != "" && indent(ls[end+1].text) > indent(ls[last].text) {
		end++
	}
	var rows []row
	var multi bool
	for i := start; i <= end; i++ {
		t := ls[i].text
		if m := optRe.FindStringSubmatch(t); m != nil {
			n, _ := strconv.Atoi(m[3])
			label := m[4]
			o := &PromptOption{}
			if b := boxRe.FindStringSubmatch(label); b != nil {
				multi = true
				on := b[1] != " "
				o.Checked = &on
				label = label[len(b[0]):]
			}
			raw := label
			label = hintRe.ReplaceAllString(label, "")
			if a, b, ok := strings.Cut(label, " · "); ok {
				label, o.Detail = a, b
			}
			o.Label = label
			rows = append(rows, row{opt: o, raw: raw, num: n, cursor: m[2] != "", line: i})
			continue
		}
		if strings.TrimSpace(t) == "Submit" {
			rows = append(rows, row{submit: true, cursor: strings.HasPrefix(strings.TrimSpace(t), "❯"), line: i})
			continue
		}
		if sepRe.MatchString(t) || len(rows) == 0 || rows[len(rows)-1].opt == nil {
			continue
		}
		r := &rows[len(rows)-1]
		r.more = append(r.more, strings.TrimSpace(t))
		r.opt.Detail = strings.TrimSpace(strings.TrimSpace(r.opt.Detail + "\n" + strings.TrimSpace(t)))
	}
	// The numbers count up from 1: anything else is not a menu.
	want := 1
	for _, r := range rows {
		if r.opt == nil {
			continue
		}
		if r.num != want {
			return nil
		}
		want++
	}
	if !anyCursor(rows) {
		markBg(ls, rows)
	}
	p := &Prompt{Multi: multi, Notes: pv != nil}
	header(p, ls, start)
	if p.Kind == "question" && planRe.MatchString(p.Question) {
		p.Kind, p.Title = "plan", "Plan"
		p.Detail = planText(ls, start)
	}
	if p.Kind == "question" {
		p.Tabs = tabsAbove(ls, start)
	}
	menuKeys(p, rows, footerText(ls, end), pv)
	return p
}

// footerText is the text under a menu's last row, wrapped lines joined.
func footerText(ls []pline, last int) string {
	var parts []string
	for _, l := range ls[last+1:] {
		if t := strings.TrimSpace(l.text); t != "" && !sepRe.MatchString(l.text) && !optRe.MatchString(l.text) {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, " ")
}

// menuKeys turns the rows of a numbered menu into options with the keys
// that pick them, and finds where text goes. Claude Code (2.1, seen live):
//   - a question's "Type something" row takes text; its digit opens the
//     field (single select). In a multi-select the digit only ticks it:
//     the highlight must be moved there, and typing ticks it (Enter would
//     untick it again). A row with typed text shows that text as its label.
//   - permission prompts with "Tab to amend": Tab on the highlighted Yes or
//     No row opens a field ("Yes, and tell Claude what to do next").
//   - plan approval: the "Tell Claude what to change" row is a field.
//   - previews: arrows move, Enter picks, "n" opens notes for the row.
//   - while a field has the keyboard, digits, Tab, Esc and left/right go
//     into the text: only up/down (and Enter) still drive the menu.
func menuKeys(p *Prompt, rows []row, footer string, pv *preview) {
	vim := strings.Contains(footer, "ctrl+g to edit in Vim")
	tabAmend := strings.Contains(footer, "Tab to amend")
	claudePerm := p.Kind == "permission" && strings.HasPrefix(footer, "Esc to cancel")
	cur, first, lastOpt := -1, -1, -1
	for i, r := range rows {
		if r.cursor {
			cur = i
		}
		if r.opt != nil && !strings.EqualFold(r.opt.Label, "Chat about this") {
			if first < 0 {
				first = i
			}
			lastOpt = i
		}
	}
	typed := func(r row, skip func(string) bool) string {
		lines := []string{r.raw}
		for _, m := range r.more {
			if !skip(m) {
				lines = append(lines, m)
			}
		}
		return strings.TrimSpace(strings.Join(lines, "\n"))
	}
	never := func(string) bool { return false }
	// The row that takes text, and whether its field has the keyboard.
	ti, focused, draft := -1, false, ""
	textMode := "" // other, plan, amend
	amend := map[int]bool{}
	switch {
	case pv != nil:
		focused = vim
		draft = pv.notes
	case p.Kind == "plan":
		for i, r := range rows {
			if r.opt != nil && (planTellRe.MatchString(r.opt.Label) || slicesHas(r.more, "shift+tab to approve with this feedback")) {
				ti, textMode = i, "plan"
			}
		}
		if ti >= 0 && ti == cur {
			focused = true
			if !planTellRe.MatchString(rows[ti].opt.Label) {
				draft = typed(rows[ti], func(m string) bool { return strings.HasPrefix(m, "shift+tab to approve") })
			}
		}
	case p.Kind == "question":
		for i, r := range rows {
			if r.opt != nil && textRe.MatchString(r.opt.Label) {
				ti, textMode = i, "other"
			}
		}
		if ti < 0 && vim && cur >= 0 && rows[cur].opt != nil {
			ti, textMode = cur, "other" // its placeholder is replaced by what was typed
		}
		if ti >= 0 && ti == cur && vim {
			focused = true
			if !textRe.MatchString(rows[ti].opt.Label) {
				draft = typed(rows[ti], never)
			}
		}
	case claudePerm:
		textMode = "amend"
		on := func(i int, word string) bool {
			return i == cur && !tabAmend && strings.HasPrefix(rows[i].opt.Label, word+", ")
		}
		if cur >= 0 && (cur == first && on(first, "Yes") || cur == lastOpt && on(lastOpt, "No")) {
			ti, focused = cur, true
			_, rest, _ := strings.Cut(typed(rows[cur], never), ", ")
			if !amendHelp.MatchString(rest) {
				draft = rest
			}
		}
		if tabAmend || focused {
			if first >= 0 && (rows[first].opt.Label == "Yes" || first == ti) {
				amend[first] = true
			}
			if lastOpt > first && (rows[lastOpt].opt.Label == "No" || lastOpt == ti) {
				amend[lastOpt] = true
			}
		}
	}
	p.Focused = focused
	if !focused && strings.Contains(strings.ToLower(footer), "esc to cancel") {
		p.Cancel = []string{"esc"}
	}
	if p.Kind == "question" && !focused && len(p.Tabs) > 1 {
		for i, t := range p.Tabs {
			if t.Current && i > 0 {
				p.Prev = []string{"left"}
			}
			if t.Current && i < len(p.Tabs)-1 {
				p.Next = []string{"right"}
			}
		}
	}
	for i, r := range rows {
		d := i - cur
		if r.submit {
			if !p.Multi || cur < 0 || i < cur || i-cur+1 > maxKeys {
				continue
			}
			p.Options = append(p.Options, PromptOption{Label: "Submit", Keys: append(repeat("down", i-cur), "enter"), Submit: true})
			p.sigLabels = append(p.sigLabels, "Submit")
			continue
		}
		o := *r.opt
		if strings.EqualFold(o.Label, "Chat about this") {
			continue
		}
		o.Current = r.cursor
		sigLabel := o.Label
		isText := i == ti || amend[i] || pv != nil
		if isText {
			o.Text = "required"
			switch {
			case pv != nil || textMode == "amend":
				o.Text = "optional"
			case textMode == "other":
				o.Label = "Type something"
				if !p.Multi {
					o.Label += "."
				}
				if textRe.MatchString(r.opt.Label) {
					o.Label = r.opt.Label
				}
			case textMode == "plan":
				o.Label = "Tell Claude what to change"
			}
			if textMode == "amend" {
				o.Label, _, _ = strings.Cut(o.Label, ",")
			}
			if pv == nil {
				o.Detail = ""
				sigLabel = "\x01text"
			}
			if i == cur {
				o.Draft = draft
			}
		} else if tellRe.MatchString(o.Label) {
			o.Text = "optional"
		}
		if pv != nil && i == cur {
			o.Preview = pv.box
		}
		// The keys that pick it (with what is typed, if anything).
		switch {
		case focused && i == cur:
			if o.Draft != "" || textMode == "amend" && pv == nil {
				o.Keys = []string{"enter"}
			}
		case cur < 0 && (focused || pv != nil):
		case focused && pv != nil:
		case focused && p.Multi:
			if mv := moves(d); mv != nil && len(mv) < maxKeys {
				o.Keys = append(mv, "space")
			}
		case focused || pv != nil:
			o.Keys = arrows(d, "up", "down")
		default:
			o.Keys = []string{strconv.Itoa(r.num)}
			if r.num > 9 {
				o.Keys = nil
			}
		}
		// The keys that open its field.
		if o.Text != "" {
			o.TextThen = []string{"enter"}
			switch {
			case focused && i == cur:
				if o.Draft == "" {
					o.TextKeys = []string{}
				}
			case focused, cur < 0 && (pv != nil || amend[i] || p.Multi):
			case pv != nil:
				o.TextKeys = withKey(moves(d), "n")
			case amend[i]:
				o.TextKeys = withKey(moves(d), "tab")
			case p.Multi:
				if d != 0 {
					o.TextKeys = moves(d)
				}
				o.TextThen = nil
			default:
				o.TextKeys = append([]string{}, o.Keys...)
				if len(o.Keys) == 0 {
					o.TextKeys = nil
				}
			}
		}
		p.Options = append(p.Options, o)
		p.sigLabels = append(p.sigLabels, sigLabel)
	}
}

// moves is the arrow presses from the highlight to a row d rows away.
func moves(d int) []string {
	k := "down"
	if d < 0 {
		k, d = "up", -d
	}
	if d >= maxKeys {
		return nil
	}
	return repeat(k, d)
}

func withKey(ks []string, k string) []string {
	if ks == nil {
		return nil
	}
	return append(ks, k)
}

func slicesHas(v []string, s string) bool {
	for _, x := range v {
		if x == s {
			return true
		}
	}
	return false
}

// tabsAbove reads Claude's question tabs ("←  ☒ Color  ☐ Extras  ✔ Submit  →")
// over a menu; the current one is drawn on a background of its own.
func tabsAbove(ls []pline, start int) []PromptTab {
	for i := start - 1; i >= 0 && i >= start-12; i-- {
		t := ls[i].text
		if sepRe.MatchString(t) {
			break
		}
		ms := tabRe.FindAllStringSubmatch(t, -1)
		if len(ms) == 0 || strings.TrimSpace(tabRe.ReplaceAllString(strings.NewReplacer("←", "", "→", "").Replace(t), "")) != "" {
			continue
		}
		tabs := make([]PromptTab, len(ms))
		cur := -1
		for j, m := range ms {
			tabs[j] = PromptTab{Label: strings.TrimSpace(m[2]), Done: m[1] != "☐"}
			if bg := bgAt(ls[i].raw, m[1]+" "+tabs[j].Label); bg != "" && bg != "?" {
				if cur >= 0 {
					cur = -2
				} else if cur == -1 {
					cur = j
				}
			}
		}
		if cur >= 0 {
			tabs[cur].Current = true
		}
		return tabs
	}
	return nil
}

// planText is the plan Claude shows above its approval menu: the lines
// between "Here is Claude's plan:" and the rule over the question.
func planText(ls []pline, start int) string {
	top := -1
	for i := start - 1; i >= 0; i-- {
		if strings.Contains(ls[i].text, "Here is Claude's plan:") {
			top = i
			break
		}
	}
	if top < 0 {
		return ""
	}
	var out []string
	cut := -1
	for _, l := range ls[top+1 : start] {
		if sepRe.MatchString(l.text) {
			break
		}
		if dashRe.MatchString(l.text) {
			continue
		}
		if s := strings.TrimSpace(l.text); s != "" {
			if n := indent(l.text); cut < 0 || n < cut {
				cut = n
			}
		}
		out = append(out, l.text)
	}
	for i, o := range out {
		out[i] = strings.TrimRight(o[min(cut, indent(o)):], " ")
	}
	text := strings.Join(out, "\n")
	for strings.Contains(text, "\n\n\n") {
		text = strings.ReplaceAll(text, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(text)
}

// ---------------------------------------------------------------- previews

// preview is a question menu whose options sit beside a preview box
// (AskUserQuestion with previews): the options column, the box of the
// highlighted option and its notes.
type preview struct {
	ls    []pline
	box   string
	notes string // what was typed as notes, if anything
}

func splitPreview(ls []pline) *preview {
	at, col := -1, -1
	for i := len(ls) - 1; i >= 0 && i >= len(ls)-30; i-- {
		t := ls[i].plain
		if !optRe.MatchString(t) {
			continue
		}
		if c := strings.Index(t, "┌"); c > 0 && strings.HasSuffix(t[:c], "   ") {
			at, col = i, utf8.RuneCountInString(t[:c])
			break
		}
	}
	if at < 0 {
		return nil
	}
	pv := &preview{}
	var box []string
	inBox, done := false, false
	for i, l := range ls {
		r := []rune(l.plain)
		if i > at && sepRe.MatchString(l.plain) {
			done = true // the box and its notes end above the menu's rule
		}
		if i < at || done || len(r) <= col {
			if i >= at && !done && strings.TrimSpace(l.text) == "" {
				continue // emptied by the split: the column beside the box
			}
			pv.ls = append(pv.ls, l)
			continue
		}
		left, right := strings.TrimRight(string(r[:col]), " "), strings.TrimSpace(string(r[col:]))
		switch {
		case strings.HasPrefix(right, "┌"):
			inBox = true
		case strings.HasPrefix(right, "└"):
			inBox = false
		case inBox:
			right = strings.TrimSuffix(strings.TrimPrefix(right, "│"), "│")
			box = append(box, strings.TrimRight(strings.TrimPrefix(right, " "), " "))
		case strings.HasPrefix(right, "Notes:"):
			if n := strings.TrimSpace(strings.TrimPrefix(right, "Notes:")); n != "press n to add notes" {
				pv.notes = n
			}
		case right != "" && pv.notes != "":
			pv.notes += "\n" + right
		}
		if strings.TrimSpace(left) == "" {
			continue
		}
		l.text = left
		pv.ls = append(pv.ls, l)
	}
	pv.box = strings.Join(box, "\n")
	return pv
}

func anyCursor(rows []row) bool {
	for _, r := range rows {
		if r.cursor {
			return true
		}
	}
	return false
}

// markBg finds a highlight drawn only as a background colour (opencode): the
// one row whose label starts on a background no other row has.
func markBg(ls []pline, rows []row) {
	bgs := make([]string, len(rows))
	for i, r := range rows {
		if r.opt != nil {
			bgs[i] = bgAt(ls[r.line].raw, strconv.Itoa(r.num)+".")
		}
	}
	base := ""
	for i := rows[0].line - 1; i >= 0; i-- {
		if t := strings.TrimSpace(ls[i].text); t != "" {
			base = bgAt(ls[i].raw, strings.Fields(t)[0])
			break
		}
	}
	for i, r := range rows {
		if r.opt == nil {
			bgs[i] = base
		}
	}
	if i := uniqueIdx(bgs, base); i >= 0 {
		rows[i].cursor = true
	}
}

// uniqueIdx is the one index whose value differs from base (or, with no
// base, from every other value), else -1.
func uniqueIdx(v []string, base string) int {
	if len(v) < 2 {
		return -1
	}
	if base != "" && base != "?" {
		found := -1
		for i, s := range v {
			if s != base {
				if found >= 0 {
					return -1
				}
				found = i
			}
		}
		return found
	}
	count := map[string]int{}
	for _, s := range v {
		count[s]++
	}
	found := -1
	for i, s := range v {
		if count[s] == 1 {
			if found >= 0 {
				return -1
			}
			found = i
		}
	}
	return found
}

var sgrRe = regexp.MustCompile(`\x1b\[([0-9;]*)m`)

// bgAt is the background colour (SGR parameters) in effect where needle
// starts in the raw line, or "" when the line has no escapes.
func bgAt(raw, needle string) string {
	bg := ""
	pos := 0
	for _, m := range sgrRe.FindAllStringSubmatchIndex(raw, -1) {
		if strings.Contains(raw[pos:m[0]], needle) {
			return bg
		}
		params := raw[m[2]:m[3]]
		if params == "" || params == "0" || strings.HasSuffix(params, ";49") || params == "49" {
			bg = ""
		}
		if i := strings.Index(params, "48;"); i >= 0 {
			bg = params[i:]
		}
		pos = m[1]
	}
	if strings.Contains(raw[pos:], needle) && strings.Contains(raw, "\x1b[") {
		return bg
	}
	return "?"
}

func indent(s string) int { return len(s) - len(strings.TrimLeft(s, " ")) }

func repeat(k string, n int) []string {
	out := make([]string, 0, n)
	for range n {
		out = append(out, k)
	}
	return out
}

// header fills title, question, subject and detail from the lines above the
// menu at start, up to a full-width separator or the transcript.
func header(p *Prompt, ls []pline, start int) {
	top := max(0, start-24)
	for i := start - 1; i >= top; i-- {
		t := ls[i].text
		if sepRe.MatchString(t) {
			top = i + 1
			break
		}
		if s := strings.TrimSpace(t); strings.HasPrefix(s, "• ") || strings.HasPrefix(s, "● ") || strings.HasPrefix(s, "⎿") {
			top = i + 1
			break
		}
	}
	var body []string
	for _, l := range ls[top:start] {
		body = append(body, l.text)
	}
	all := strings.Join(body, "\n")
	for _, ph := range trustPhrases {
		if strings.Contains(all, ph) {
			p.Kind = "trust"
		}
	}
	if p.Kind == "trust" {
		p.Question = "Trust this folder?"
		for _, b := range body {
			if m := pathRe.FindStringSubmatch(b); m != nil {
				p.Subject = m[1]
				break
			}
		}
		return
	}
	// The question: the last line ending in "?" (Claude asks right above
	// the menu, Codex above its command), else the last text line.
	qi := -1
	for i := len(body) - 1; i >= 0; i-- {
		if strings.HasSuffix(strings.TrimSpace(body[i]), "?") {
			qi = i
			break
		}
	}
	if qi < 0 {
		for i := len(body) - 1; i >= 0; i-- {
			if s := strings.TrimSpace(body[i]); s != "" && !dashRe.MatchString(body[i]) {
				qi = i
				break
			}
		}
	}
	if qi < 0 {
		p.Kind = "question"
		return
	}
	// A long question wraps: take the lines of its paragraph above it.
	q0 := qi
	for q0 > 0 {
		prev := strings.TrimSpace(body[q0-1])
		if prev == "" || dashRe.MatchString(body[q0-1]) || tabsRe.MatchString(prev) || strings.ContainsAny(prev[len(prev)-1:], ".?!:)") {
			break
		}
		q0--
	}
	p.Question = strings.Join(strings.Fields(strings.Join(body[q0:qi+1], " ")), " ")
	above, after := body[:q0], body[qi+1:]
	if permQRe.MatchString(p.Question) {
		p.Kind = "permission"
	} else {
		p.Kind = "question"
	}
	// Claude: title line, an optional tip, a description, then the subject
	// between dashed rules. Its question tabs are not a title.
	var texts []string
	var boxed []string
	inBox := false
	for _, b := range above {
		switch {
		case dashRe.MatchString(b):
			inBox = !inBox
		case inBox:
			boxed = append(boxed, strings.TrimSpace(b))
		case strings.TrimSpace(b) == "" || strings.HasPrefix(strings.TrimSpace(b), "Tip:"):
		case tabsRe.MatchString(b) && p.Kind == "question":
		default:
			texts = append(texts, strings.TrimSpace(b))
		}
	}
	if p.Kind == "permission" && len(texts) > 0 {
		p.Title = texts[0]
		texts = texts[1:]
	}
	switch {
	case p.Title == "Fetch":
		for _, b := range boxed {
			if u, ok := strings.CutPrefix(b, "url: "); ok {
				p.Subject = u
			}
		}
		p.Desc = strings.Join(texts, "\n")
		p.Detail = strings.Join(boxed, "\n")
	case strings.HasSuffix(p.Title, " file") && len(texts) > 0:
		p.Subject = texts[0]
		p.Desc = strings.Join(texts[1:], "\n")
		p.Detail = strings.Join(boxed, "\n")
	case len(boxed) > 0:
		p.Subject = strings.Join(boxed, "\n")
		p.Desc = strings.Join(texts, "\n")
	default:
		if p.Kind == "question" {
			var keep []string
			for _, b := range above {
				if !tabsRe.MatchString(b) {
					keep = append(keep, b)
				}
			}
			p.Detail = strings.TrimSpace(strings.Join(keep, "\n"))
		} else {
			p.Desc = strings.Join(texts, "\n")
		}
	}
	// Codex: the command ("$ ...") or the edited file and its diff come
	// after the question.
	var rest []string
	for _, b := range after {
		s := strings.TrimSpace(b)
		switch {
		case s == "":
		case strings.HasPrefix(s, "Reason: "):
			p.Desc = strings.TrimPrefix(s, "Reason: ")
		case strings.HasPrefix(s, "$ ") && p.Subject == "":
			p.Subject = strings.TrimPrefix(s, "$ ")
		case codexFile.MatchString(b) && p.Subject == "":
			p.Subject = codexFile.FindStringSubmatch(b)[1]
		default:
			rest = append(rest, s)
		}
	}
	if len(rest) > 0 {
		p.Detail = strings.TrimSpace(p.Detail + "\n" + strings.Join(rest, "\n"))
	}
	if p.Kind == "permission" && p.Title == "" {
		q := strings.ToLower(p.Question)
		switch {
		case strings.Contains(q, "run the following command"):
			p.Title = "Run command"
		case strings.Contains(q, "make the following edits"):
			p.Title = "Edit files"
		case strings.Contains(q, "grant these permissions"):
			p.Title = "Permissions"
		case strings.Contains(q, "send input"):
			p.Title = "Terminal input"
		}
	}
}

// ---------------------------------------------------------------- cursor menus without numbers

// cursorPrompt reads a Claude menu drawn as "❯ choice" rows with no digits
// (its trust dialog): arrows from the highlighted row, then Enter.
func cursorPrompt(ls []pline) *Prompt {
	ci := -1
	for i := len(ls) - 1; i >= 0 && i >= len(ls)-8; i-- {
		if cursorRe.MatchString(ls[i].text) && !optRe.MatchString(ls[i].text) {
			ci = i
			break
		}
	}
	if ci < 0 {
		return nil
	}
	col := indent(ls[ci].text) + 2
	item := func(i int) bool {
		t := ls[i].text
		return strings.TrimSpace(t) != "" && indent(t) == col && !optRe.MatchString(t)
	}
	start, end := ci, ci
	for start > 0 && item(start-1) {
		start--
	}
	for end+1 < len(ls) && item(end+1) {
		end++
	}
	if end == start || !footerOnly(ls, end) {
		return nil
	}
	p := &Prompt{}
	header(p, ls, start)
	if p.Kind != "trust" && p.Kind != "permission" && p.Kind != "question" {
		p.Kind = "question"
	}
	cur := ci - start
	for i := start; i <= end; i++ {
		label := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(ls[i].text), "❯"))
		o := PromptOption{Label: label, Current: i == ci, Keys: arrows(i-start-cur, "up", "down")}
		p.Options = append(p.Options, o)
	}
	return p
}

func arrows(d int, back, fwd string) []string {
	k := fwd
	if d < 0 {
		k, d = back, -d
	}
	if d+1 > maxKeys {
		return nil
	}
	return append(repeat(k, d), "enter")
}

// ---------------------------------------------------------------- opencode button rows

var buttonHint = regexp.MustCompile(`ctrl\+|⇆|enter `)

// buttonPrompt reads opencode's permission bar: buttons on one line, picked
// with left/right and Enter; the highlight is only a background colour.
func buttonPrompt(ls []pline) *Prompt {
	bi := -1
	for i := len(ls) - 1; i >= 0 && i >= len(ls)-4; i-- {
		if strings.Contains(ls[i].text, "⇆ select") && strings.Contains(ls[i].text, "enter confirm") {
			bi = i
			break
		}
	}
	if bi < 0 {
		return nil
	}
	buttons := func(i int) []string {
		var labels []string
		for _, tok := range regexp.MustCompile(`\s{2,}`).Split(strings.TrimSpace(ls[i].text), -1) {
			if buttonHint.MatchString(tok) {
				break
			}
			if tok != "" {
				labels = append(labels, tok)
			}
		}
		return labels
	}
	// The buttons sit on the hint row, or (newer opencode) on their own row
	// a blank line or two above it.
	li, labels := bi, buttons(bi)
	for i := bi - 1; len(labels) == 0 && i >= 0 && i >= bi-3; i-- {
		if strings.TrimSpace(ls[i].text) == "" {
			continue
		}
		li, labels = i, buttons(i)
		if len(labels) < 2 {
			return nil
		}
	}
	if len(labels) < 2 {
		return nil
	}
	bgs := make([]string, len(labels))
	for i, l := range labels {
		bgs[i] = bgAt(ls[li].raw, l)
	}
	cur := -1
	if h := regexp.MustCompile(`⇆|ctrl\+f`).FindString(ls[bi].text); h != "" {
		cur = uniqueIdx(bgs, bgAt(ls[bi].raw, h))
	}
	p := &Prompt{Kind: "permission"}
	// The box above: "△ Permission required" or "△ Always allow", a title
	// line, the subject and any diff.
	var body []string
	for i := li - 1; i >= 0 && i >= li-30; i-- {
		t := strings.TrimSpace(ls[i].text)
		if strings.HasPrefix(t, "△ ") {
			body = append([]string{t}, body...)
			break
		}
		body = append([]string{ls[i].text}, body...)
	}
	if len(body) == 0 || !strings.HasPrefix(body[0], "△ ") {
		return nil
	}
	head := strings.TrimPrefix(body[0], "△ ")
	var rest, diff []string
	for _, b := range body[1:] {
		s := strings.TrimSpace(b)
		if s == "" {
			continue
		}
		rest = append(rest, s)
	}
	if head != "Permission required" {
		p.Title = head
		for _, s := range rest {
			if v, ok := strings.CutPrefix(s, "- "); ok && p.Subject == "" {
				p.Subject = v
			} else if p.Question == "" {
				p.Question = s
			}
		}
	} else {
		for i, s := range rest {
			switch {
			case i == 0 && strings.HasPrefix(s, "# "):
				p.Title = strings.TrimPrefix(s, "# ")
			case i == 0 && strings.HasPrefix(s, "→ "):
				verb, obj, _ := strings.Cut(strings.TrimPrefix(s, "→ "), " ")
				p.Title, p.Subject = verb, obj
			case strings.HasPrefix(s, "$ ") && p.Subject == "":
				p.Subject = strings.TrimPrefix(s, "$ ")
			case diffRe.MatchString(s):
				diff = append(diff, s)
			default:
				if p.Desc == "" {
					p.Desc = s
				}
			}
		}
	}
	p.Detail = strings.Join(diff, "\n")
	for i, l := range labels {
		o := PromptOption{Label: l, Current: i == cur}
		if cur >= 0 {
			o.Keys = arrows(i-cur, "left", "right")
		}
		if l == "Confirm" && strings.Contains(head, "Always") {
			o.Always = true
		}
		p.Options = append(p.Options, o)
	}
	return p
}

// ---------------------------------------------------------------- y/n

func ynPrompt(ls []pline) *Prompt {
	t := strings.TrimSpace(ls[len(ls)-1].text)
	m := ynRe.FindStringSubmatch(t)
	if m == nil {
		return nil
	}
	q := strings.TrimSpace(m[1])
	if q == "" {
		q = t
	}
	return &Prompt{Kind: "confirm", Question: q, Options: []PromptOption{
		{Label: "Yes", Keys: []string{"y", "enter"}},
		{Label: "No", Keys: []string{"n", "enter"}},
	}}
}

// ---------------------------------------------------------------- finish

func finish(p *Prompt) {
	for i := range p.Options {
		o := &p.Options[i]
		if o.Keys == nil {
			o.Keys = []string{}
		}
		if p.Kind == "trust" {
			o.Always = strings.Contains(strings.ToLower(o.Label), "trust")
		} else if !o.Always && !o.Submit && alwaysRe.MatchString(o.Label) {
			o.Always = true
		}
	}
	short := p.Title
	switch short {
	case "Bash command", "Shell command":
		short = strings.Fields(short)[0]
	case "Edit file", "Create file", "Write file", "Read file":
		short = strings.Fields(short)[0]
	}
	subj := strings.SplitN(p.Subject, "\n", 2)[0]
	switch p.Kind {
	case "permission":
		p.Summary = "Permission: " + strings.TrimSpace(short+" "+subj)
		if short == "" && subj == "" {
			p.Summary = "Permission: " + p.Question
		}
	case "trust":
		p.Summary = "Trust folder: " + subj
	case "confirm":
		p.Summary = "Confirm: " + p.Question
	case "plan":
		first, _, _ := strings.Cut(p.Detail, "\n")
		p.Summary = "Plan: " + strings.TrimPrefix(first, "Plan: ")
		if first == "" {
			p.Summary = "Plan: " + p.Question
		}
	default:
		p.Summary = "Question: " + p.Question
	}
	p.Summary = clip(p.Summary, 90)
	h := sha1.New()
	h.Write([]byte(p.Kind + "\x00" + p.Title + "\x00" + p.Question + "\x00" + p.Subject + "\x00" + p.Detail))
	for i, o := range p.Options {
		l := o.Label
		if i < len(p.sigLabels) {
			l = p.sigLabels[i]
		}
		h.Write([]byte("\x00" + l))
	}
	p.Sig = hex.EncodeToString(h.Sum(nil))[:16]
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}
