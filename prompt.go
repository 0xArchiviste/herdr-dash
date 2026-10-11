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
	Keys    []string `json:"keys"`              // pick it; empty: not answerable by keys
	Text    string   `json:"text,omitempty"`    // "required" or "optional": typed after Keys, then Enter
	Always  bool     `json:"always,omitempty"`  // a lasting grant: don't ask again, trust, auto mode
	Current bool     `json:"current,omitempty"` // highlighted
	Checked *bool    `json:"checked,omitempty"` // multi-select: toggled by Keys
	Submit  bool     `json:"submit,omitempty"`  // multi-select: sends the checked set
}

type Prompt struct {
	Kind     string         `json:"kind"`    // permission, question, trust, confirm
	Harness  string         `json:"harness"` // claude, codex, opencode, other
	Title    string         `json:"title,omitempty"`
	Question string         `json:"question,omitempty"`
	Subject  string         `json:"subject,omitempty"` // command, file, URL, folder
	Desc     string         `json:"desc,omitempty"`
	Detail   string         `json:"detail,omitempty"` // diff or longer text, shown as code
	Multi    bool           `json:"multi,omitempty"`
	Options  []PromptOption `json:"options"`
	Summary  string         `json:"summary"`
	Sig      string         `json:"sig"` // same prompt, same sig (highlight and checks aside)
}

// pline is one screen line: its raw text (with escapes) and its plain text,
// with an opencode box bar ("┃") taken off the front.
type pline struct{ raw, text string }

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
	alwaysRe   = regexp.MustCompile(`(?i)don'?t ask again|always|allow all|for this session|auto mode|accept edits|auto-approve|in the future|(from|for) this project|allow this host|trust`)
	textRe     = regexp.MustCompile(`(?i)^type something|^type your own answer|^other\b`)
	tellRe     = regexp.MustCompile(`(?i)tell \w+ what to do differently`)
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
	if strings.HasPrefix(t, "┃") || strings.HasPrefix(t, "╹") {
		t = strings.TrimPrefix(strings.TrimPrefix(t, "┃"), "╹")
		return strings.TrimPrefix(t, " ")
	}
	return s
}

// ParsePrompt reads the prompt at the bottom of screen (plain or ANSI text),
// or nil. agent is herdr's agent name for the pane, when known.
func ParsePrompt(screen, agent string) *Prompt {
	var ls []pline
	for _, r := range strings.Split(screen, "\n") {
		ls = append(ls, pline{raw: r, text: barless(plainLine(r))})
	}
	for len(ls) > 0 && strings.TrimSpace(ls[len(ls)-1].text) == "" {
		ls = ls[:len(ls)-1]
	}
	if len(ls) == 0 {
		return nil
	}
	if len(ls) > 45 {
		ls = ls[len(ls)-45:]
	}
	var p *Prompt
	for _, f := range []func([]pline) *Prompt{buttonPrompt, numberedPrompt, cursorPrompt, ynPrompt} {
		if p = f(ls); p != nil {
			break
		}
	}
	if p == nil || len(p.Options) < 2 && p.Kind != "confirm" {
		return nil
	}
	p.Harness = harness(agent, ls)
	finish(p)
	return p
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
	num    int
	cursor bool
	line   int
	submit bool
}

func numberedPrompt(ls []pline) *Prompt {
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
	var rows []row
	var multi bool
	for i := start; i <= last; i++ {
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
			label = hintRe.ReplaceAllString(label, "")
			if a, b, ok := strings.Cut(label, " · "); ok {
				label, o.Detail = a, b
			}
			o.Label = label
			rows = append(rows, row{opt: o, num: n, cursor: m[2] != "", line: i})
			continue
		}
		if strings.TrimSpace(t) == "Submit" {
			rows = append(rows, row{submit: true, cursor: strings.HasPrefix(strings.TrimSpace(t), "❯"), line: i})
			continue
		}
		if sepRe.MatchString(t) || len(rows) == 0 || rows[len(rows)-1].opt == nil {
			continue
		}
		o := rows[len(rows)-1].opt
		o.Detail = strings.TrimSpace(strings.TrimSpace(o.Detail + "\n" + strings.TrimSpace(t)))
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
	p := &Prompt{Multi: multi}
	header(p, ls, start)
	cur := -1
	for i, r := range rows {
		if r.cursor {
			cur = i
		}
	}
	for i, r := range rows {
		if r.submit {
			if !multi || cur < 0 || i < cur || i-cur+1 > maxKeys {
				continue
			}
			keys := append(repeat("down", i-cur), "enter")
			p.Options = append(p.Options, PromptOption{Label: "Submit", Keys: keys, Submit: true})
			continue
		}
		o := *r.opt
		if strings.EqualFold(o.Label, "Chat about this") {
			continue
		}
		o.Current = r.cursor
		o.Keys = []string{strconv.Itoa(r.num)}
		if r.num > 9 {
			o.Keys = nil
		}
		switch {
		case textRe.MatchString(o.Label):
			if multi { // typing into a multi-select row is left to the chat box
				continue
			}
			o.Text = "required"
		case tellRe.MatchString(o.Label):
			o.Text = "optional"
		}
		p.Options = append(p.Options, o)
	}
	return p
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
	p.Question = strings.TrimSpace(body[qi])
	above, after := body[:qi], body[qi+1:]
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
			p.Detail = strings.TrimSpace(strings.Join(above, "\n"))
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
	var labels []string
	for _, tok := range regexp.MustCompile(`\s{2,}`).Split(strings.TrimSpace(ls[bi].text), -1) {
		if buttonHint.MatchString(tok) {
			break
		}
		labels = append(labels, tok)
	}
	if len(labels) < 2 {
		return nil
	}
	bgs := make([]string, len(labels))
	for i, l := range labels {
		bgs[i] = bgAt(ls[bi].raw, l)
	}
	cur := -1
	if h := regexp.MustCompile(`⇆|ctrl\+f`).FindString(ls[bi].text); h != "" {
		cur = uniqueIdx(bgs, bgAt(ls[bi].raw, h))
	}
	p := &Prompt{Kind: "permission"}
	// The box above: "△ Permission required" or "△ Always allow", a title
	// line, the subject and any diff.
	var body []string
	for i := bi - 1; i >= 0 && i >= bi-30; i-- {
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
	default:
		p.Summary = "Question: " + p.Question
	}
	p.Summary = clip(p.Summary, 90)
	h := sha1.New()
	h.Write([]byte(p.Kind + "\x00" + p.Title + "\x00" + p.Question + "\x00" + p.Subject + "\x00" + p.Detail))
	for _, o := range p.Options {
		h.Write([]byte("\x00" + o.Label))
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
