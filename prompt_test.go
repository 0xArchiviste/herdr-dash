package main

// The prompt parser in isolation, against screens taken from real Claude
// Code, Codex and opencode panes (testdata/prompts/, sanitized).
//
// Ways it could fail, written before the parser:
//  1. A permission prompt is not recognized, or its kind, harness, title,
//     question or subject (command, file, URL) is wrong or empty.
//  2. An option's label keeps screen noise: the cursor, the number, a
//     "[ ]" box, a shortcut hint like "(y)" or "(esc)".
//  3. The keys for an option are wrong: a digit for a menu without digits,
//     arrows counted from the wrong highlighted row, an arrow menu answered
//     without knowing where the highlight is, or more keys than allowed.
//  4. The highlighted option is missed (cursor glyph, or only a background
//     colour in opencode).
//  5. "Always allow" / "don't ask again" options are not flagged, or a plain
//     "Yes" is.
//  6. Options that take text ("Type something", "tell Claude what to do
//     differently") are not flagged, so the card offers no text field.
//  7. Multi-select: checked states lost, a digit is treated as a final
//     answer, or there is no way to submit.
//  8. Description lines under an option become options, or the meta "Chat
//     about this" row is offered as an answer.
//  9. A screen that only quotes a numbered list in the transcript (idle
//     agent, empty input box) is reported as a prompt.
// 10. The signature changes when nothing but the highlight moved, or stays
//     the same for a different prompt.
// 11. The one-line summary for the strip is missing or unbounded.
// 12. A screen at a real pane width splits a command, path or option label
//     over lines: the parts are kept apart, glued without a space where a
//     word was split, or a label's second line becomes its description.

import (
	"os"
	"strings"
	"testing"
)

type wantOpt struct {
	label  string
	detail string // "": not checked
	keys   string // space-joined; "" = not answerable by keys
	always bool
	text   string
	cur    bool
	check  string // "", "on", "off"
	submit bool
}

func TestParsePrompt(t *testing.T) {
	cases := []struct {
		file, agent                      string
		kind, harness, title, q, subject string
		desc                             string // "": not checked
		multi                            bool
		summary                          string
		detail                           string // substring of Detail
		opts                             []wantOpt
	}{
		{file: "claude-bash.txt", agent: "claude", kind: "permission", harness: "claude", title: "Bash command",
			q: "Do you want to proceed?", subject: "ls -la /etc/hostname && wc -l notes.txt",
			summary: "Permission: Bash ls -la /etc/hostname && wc -l notes.txt",
			opts: []wantOpt{{label: "Yes", keys: "1", cur: true, text: "optional"}, {label: "Yes, allow reading from /etc from this project", keys: "2", always: true},
				{label: "Yes, and switch to auto mode", keys: "3", always: true}, {label: "No", keys: "4", text: "optional"}}},
		{file: "claude-edit.txt", agent: "claude", kind: "permission", harness: "claude", title: "Edit file",
			q: "Do you want to make this edit to notes.txt?", subject: "notes.txt", detail: "1 +hello world",
			summary: "Permission: Edit notes.txt",
			opts:    []wantOpt{{label: "Yes", keys: "1", cur: true, text: "optional"}, {label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", keys: "2", always: true}, {label: "No", keys: "3", text: "optional"}}},
		{file: "claude-fetch.txt", agent: "claude", kind: "permission", harness: "claude", title: "Fetch",
			q: "Do you want to allow Claude to fetch this content?", subject: "https://example.com/",
			summary: "Permission: Fetch https://example.com/",
			opts: []wantOpt{{label: "Yes", keys: "1", cur: true}, {label: "Yes, and don't ask again for example.com", keys: "2", always: true},
				{label: "No, and tell Claude what to do differently", keys: "3", text: "optional"}}},
		{file: "claude-question.txt", agent: "claude", kind: "question", harness: "claude",
			q: "Which database should we use?", summary: "Question: Which database should we use?",
			opts: []wantOpt{{label: "Postgres", keys: "1", cur: true}, {label: "SQLite", keys: "2"}, {label: "MySQL", keys: "3"}, {label: "Type something.", keys: "4", text: "required"}}},
		{file: "claude-question-wrapped.txt", agent: "claude", kind: "question", harness: "claude",
			q:    "Self-test of herdr-dash prompt cards: this question will be answered automatically from the dashboard in ~10s (no need to answer). Which option?",
			opts: []wantOpt{{label: "Self-test A", keys: "1", cur: true}, {label: "Self-test B", keys: "2"}, {label: "Type something.", keys: "3", text: "required"}}},
		// The highlight sits on "Type something." and its field has focus: a
		// digit would be typed into it (seen live), so the others take arrows.
		{file: "claude-other.txt", agent: "claude", kind: "question", harness: "claude", q: "Which color?",
			opts: []wantOpt{{label: "Red", keys: "up up enter"}, {label: "Blue", keys: "up enter"}, {label: "Type something.", keys: "", text: "required", cur: true}}},
		{file: "claude-multiselect.txt", agent: "claude", kind: "question", harness: "claude", multi: true,
			q: "Which features do you want to enable?",
			opts: []wantOpt{{label: "Logging", keys: "1", cur: true, check: "on"}, {label: "Metrics", keys: "2", check: "off"}, {label: "Tracing", keys: "3", check: "on"},
				{label: "Type something", keys: "4", text: "required", check: "off"},
				{label: "Submit", keys: "down down down down enter", submit: true}}},
		{file: "claude-review.txt", agent: "claude", kind: "question", harness: "claude", q: "Ready to submit your answers?", detail: "→ Logging, Tracing",
			opts: []wantOpt{{label: "Submit answers", keys: "1", cur: true}, {label: "Cancel", keys: "2"}}},
		{file: "claude-trust.txt", agent: "claude", kind: "trust", harness: "claude", subject: "/home/dev/code/demo-app",
			summary: "Trust folder: /home/dev/code/demo-app",
			opts:    []wantOpt{{label: "No, exit", keys: "enter", cur: true}, {label: "Yes, I trust this folder", keys: "down enter", always: true}}},
		// Codex's trust screen ignores the digit of the highlighted row (seen
		// live): it is answered with arrows from the highlight, then Enter.
		{file: "codex-trust.txt", agent: "codex", kind: "trust", harness: "codex", subject: "/home/dev/code/demo-app",
			opts: []wantOpt{{label: "Trust and continue", keys: "enter", cur: true, always: true}, {label: "Back to Agent Command Center", keys: "down enter"}}},
		// 12. Screens at a real pane width (76 columns): the agent wraps long
		// commands, paths and option labels. A wrapped line is one line again
		// (a word split mid-way joins without a space), and a label's second
		// line is not its description.
		{file: "claude-bash-wrapped.txt", agent: "claude", kind: "permission", harness: "claude", title: "Bash command",
			q:       "Do you want to proceed?",
			subject: "/opt/demo-tools/plugins/report-kit-0123456789abcdef/target/release/report-kit --root /srv/demo-projects report --percent 10 --activity 'Running command'",
			desc:    "Report task progress\nThis command requires approval",
			opts: []wantOpt{{label: "Yes", keys: "1", cur: true, text: "optional"},
				{label: "Yes, and don’t ask again for: /opt/demo-tools/plugins/report-kit-0123456789abcdef/target/release/report-kit *", keys: "2", always: true},
				{label: "Yes, and switch to auto mode", detail: "auto mode handles these prompts for you", keys: "3", always: true}, {label: "No", keys: "4", text: "optional"}}},
		{file: "claude-edit-wrapped.txt", agent: "claude", kind: "permission", harness: "claude", title: "Edit file",
			q: "Do you want to make this edit to notes.txt?", subject: "notes.txt", detail: "2 +hello world",
			opts: []wantOpt{{label: "Yes", keys: "1", cur: true, text: "optional"},
				{label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", keys: "2", always: true}, {label: "No", keys: "3", text: "optional"}}},
		{file: "claude-trust-wrapped.txt", agent: "claude", kind: "trust", harness: "claude",
			subject: "/srv/demo-workspaces/agents/ws-0042/pane-scratch-0123456789abcdef0123456789abcdef/demo",
			opts:    []wantOpt{{label: "No, exit", keys: "enter", cur: true}, {label: "Yes, I trust this folder", keys: "down enter", always: true}}},
		{file: "codex-command-wrapped.txt", agent: "codex", kind: "permission", harness: "codex", title: "Run command",
			q: "Would you like to run the following command?", subject: "printf hi > out2.txt",
			desc: "Allow writing hi to out2.txt? The current sandbox only permits reading files.",
			opts: []wantOpt{{label: "Yes, proceed", keys: "1", cur: true},
				{label: "Yes, and don't ask again for commands that start with `printf hi > out2.txt`", keys: "2", always: true},
				{label: "No, and tell Codex what to do differently", keys: "3", text: "optional"}}},
		{file: "codex-trust-wrapped.txt", agent: "codex", kind: "trust", harness: "codex",
			subject: "/srv/demo-workspaces/agents/ws-0042/pane-scratch-0123456789abcdef0123456789abcdef/demo",
			opts:    []wantOpt{{label: "Trust and continue", keys: "enter", cur: true, always: true}, {label: "Back to Agent Command Center", keys: "down enter"}}},
		{file: "codex-command.txt", agent: "codex", kind: "permission", harness: "codex", title: "Run command",
			q: "Would you like to run the following command?", subject: "printf 'hi\\n' > out.txt",
			summary: "Permission: Run command printf 'hi\\n' > out.txt",
			opts: []wantOpt{{label: "Yes, just this once", keys: "1", cur: true}, {label: "Yes, and don't ask again for commands that start with `printf`", keys: "2", always: true},
				{label: "No, and tell Codex what to do differently", keys: "3", text: "optional"}}},
		{file: "codex-edit.txt", agent: "codex", kind: "permission", harness: "codex", title: "Edit files",
			q: "Would you like to make the following edits?", subject: "notes.txt", detail: "1 +hello world",
			opts: []wantOpt{{label: "Yes, proceed", keys: "1", cur: true}, {label: "Yes, and don't ask again for these files", keys: "2", always: true},
				{label: "No, and tell Codex what to do differently", keys: "3", text: "optional"}}},
		{file: "opencode-bash.ansi", agent: "opencode", kind: "permission", harness: "opencode", title: "Shell command", subject: "wc -l notes.txt",
			summary: "Permission: Shell wc -l notes.txt",
			opts:    []wantOpt{{label: "Allow once", keys: "enter", cur: true}, {label: "Allow always", keys: "right enter", always: true}, {label: "Reject", keys: "right right enter"}}},
		// A newer opencode draws the buttons on their own row above the key
		// hints (seen live).
		{file: "opencode-bash-split.ansi", agent: "opencode", kind: "permission", harness: "opencode", title: "Shell command", subject: "wc -l notes.txt",
			opts: []wantOpt{{label: "Allow once", keys: "enter", cur: true}, {label: "Allow always", keys: "right enter", always: true}, {label: "Reject", keys: "right right enter"}}},
		{file: "opencode-edit.ansi", agent: "opencode", kind: "permission", harness: "opencode", title: "Edit", subject: "notes.txt", detail: "1 + hello world",
			opts: []wantOpt{{label: "Allow once", keys: "enter", cur: true}, {label: "Allow always", keys: "right enter", always: true}, {label: "Reject", keys: "right right enter"}}},
		{file: "opencode-always.ansi", agent: "opencode", kind: "permission", harness: "opencode", title: "Always allow", subject: "wc *",
			q:    "This will allow the following patterns until OpenCode is restarted",
			opts: []wantOpt{{label: "Confirm", keys: "enter", cur: true, always: true}, {label: "Cancel", keys: "right enter"}}},
		{file: "opencode-question.ansi", agent: "opencode", kind: "question", harness: "opencode", q: "Which database would you like to use?",
			opts: []wantOpt{{label: "Postgres", keys: "1", cur: true}, {label: "SQLite", keys: "2"}, {label: "Type your own answer", keys: "3", text: "required"}}},
		{file: "confirm-yn.txt", agent: "", kind: "confirm", harness: "other", q: "Continue?", summary: "Confirm: Continue?",
			opts: []wantOpt{{label: "Yes", keys: "y enter"}, {label: "No", keys: "n enter"}}},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			b, err := os.ReadFile("testdata/prompts/" + c.file)
			if err != nil {
				t.Fatal(err)
			}
			p := ParsePrompt(string(b), c.agent)
			if p == nil {
				t.Fatal("no prompt parsed")
			}
			eq := func(what, got, want string) {
				t.Helper()
				if got != want {
					t.Errorf("%s = %q, want %q", what, got, want)
				}
			}
			eq("kind", p.Kind, c.kind)
			eq("harness", p.Harness, c.harness)
			if c.title != "" {
				eq("title", p.Title, c.title)
			}
			if c.q != "" {
				eq("question", p.Question, c.q)
			}
			if c.subject != "" {
				eq("subject", p.Subject, c.subject)
			}
			if c.desc != "" {
				eq("desc", p.Desc, c.desc)
			}
			if c.summary != "" {
				eq("summary", p.Summary, c.summary)
			}
			if c.kind == "question" && strings.ContainsAny(p.Detail, "☐☒") {
				t.Errorf("question tabs in detail %q", p.Detail)
			}
			if c.detail != "" && !strings.Contains(p.Detail, c.detail) {
				t.Errorf("detail %q lacks %q", p.Detail, c.detail)
			}
			if p.Multi != c.multi {
				t.Errorf("multi = %v", p.Multi)
			}
			if len(p.Summary) > 100 || p.Summary == "" {
				t.Errorf("summary %q", p.Summary)
			}
			if p.Sig == "" {
				t.Error("no sig")
			}
			if len(p.Options) != len(c.opts) {
				var ls []string
				for _, o := range p.Options {
					ls = append(ls, o.Label)
				}
				t.Fatalf("options %q, want %d", ls, len(c.opts))
			}
			for i, w := range c.opts {
				o := p.Options[i]
				eq("label", o.Label, w.label)
				eq(w.label+" keys", strings.Join(o.Keys, " "), w.keys)
				if len(o.Keys) > maxKeys {
					t.Errorf("%s: %d keys", w.label, len(o.Keys))
				}
				for _, k := range o.Keys {
					if !allowedKeys[k] {
						t.Errorf("%s: key %q not allowed", w.label, k)
					}
				}
				if o.Always != w.always {
					t.Errorf("%s: always = %v", w.label, o.Always)
				}
				eq(w.label+" text", o.Text, w.text)
				if w.detail != "" {
					eq(w.label+" detail", o.Detail, w.detail)
				}
				if o.Current != w.cur {
					t.Errorf("%s: current = %v", w.label, o.Current)
				}
				ck := ""
				if o.Checked != nil {
					ck = map[bool]string{true: "on", false: "off"}[*o.Checked]
				}
				eq(w.label+" checked", ck, w.check)
				if o.Submit != w.submit {
					t.Errorf("%s: submit = %v", w.label, o.Submit)
				}
			}
		})
	}
}

// 9: transcript text and idle screens are not prompts.
func TestParsePromptNone(t *testing.T) {
	b, _ := os.ReadFile("testdata/prompts/claude-idle.txt")
	for _, s := range []string{string(b), "", "just some output\n$ ", "  1. one\n  2. two\n\n❯ \n", "  1. one\n  2. two\n\x1b[0m❯\u00a0\x1b[0m\r\n"} {
		if p := ParsePrompt(s, "claude"); p != nil {
			t.Errorf("parsed a prompt from %q: %+v", s, p)
		}
	}
}

// 3, 4: an arrow menu whose highlight cannot be seen (opencode read as plain
// text) offers no keys rather than guessing.
func TestParsePromptUnknownHighlight(t *testing.T) {
	b, _ := os.ReadFile("testdata/prompts/opencode-bash.ansi")
	p := ParsePrompt(stripANSI(string(b)), "opencode")
	if p == nil || len(p.Options) != 3 {
		t.Fatalf("got %+v", p)
	}
	for _, o := range p.Options {
		if len(o.Keys) != 0 || o.Current {
			t.Errorf("%s: keys %v current %v without a visible highlight", o.Label, o.Keys, o.Current)
		}
	}
}

// 10: the signature ignores the highlight and the check marks, not the
// subject.
func TestPromptSig(t *testing.T) {
	b, _ := os.ReadFile("testdata/prompts/claude-bash.txt")
	s := string(b)
	a := ParsePrompt(s, "claude")
	moved := ParsePrompt(strings.Replace(strings.Replace(s, " ❯ 1. Yes", "   1. Yes", 1), "   4. No", " ❯ 4. No", 1), "claude")
	other := ParsePrompt(strings.ReplaceAll(s, "wc -l notes.txt", "wc -l other.txt"), "claude")
	if a == nil || moved == nil || other == nil {
		t.Fatal("parse failed")
	}
	if a.Sig != moved.Sig {
		t.Error("sig changed with the highlight")
	}
	if !moved.Options[3].Current {
		t.Error("moved highlight not seen")
	}
	if a.Sig == other.Sig {
		t.Error("sig same for another command")
	}
	m, _ := os.ReadFile("testdata/prompts/claude-multiselect.txt")
	m1 := ParsePrompt(string(m), "claude")
	m2 := ParsePrompt(strings.Replace(string(m), "[ ] Metrics", "[✔] Metrics", 1), "claude")
	if m1.Sig != m2.Sig {
		t.Error("sig changed with a check mark")
	}
}

// Claude Code's richer menus, taken live from a 76-column pane (Claude Code
// 2.1): question tabs, previews with notes, the free-text row of single and
// multi-select questions, "Tab to amend" on permission prompts, plan
// approval, and each of those with text already typed in the pane.
//
// More ways it could fail, written before the parser:
//  13. Text typed into a field the pane focuses is lost, read as an option
//     label or description, or changes the signature (the window would
//     think a new prompt is up).
//  14. With a field focused, an option is picked with a digit (typed into
//     the field instead, seen live) or the menu is cancelled or tabbed
//     (Esc and arrows act on the text).
//  15. A text option is reached with the wrong keys: a digit that picks
//     instead of opening the field, no Tab before amend text, an Enter
//     after multi-select text (it unticks the row, seen live).
//  16. A preview's box joins the option labels, the menu is not seen at all,
//     or the notes field is missing.
//  17. Question tabs are a title, or the current tab is lost.
//  18. A plan approval is a plain question with no plan, or its "tell Claude
//     what to change" row takes no text.
func TestParsePromptInteractive(t *testing.T) {
	type opt struct {
		label, keys, text, textKeys, draft, check string
		cur, always, submit                       bool
		preview                                   string // substring
	}
	cases := []struct {
		file, kind, title, q  string
		detail                string // substring
		tabs                  string // "label" with * current, + done
		cancel, prev, next    string
		focused, multi, notes bool
		sameSig               string // fixture with the same prompt, nothing typed
		opts                  []opt
	}{
		{file: "claude-ask-tabs.ansi", kind: "question", q: "Which color should the poster use?",
			tabs: "*Color Extras +Submit", cancel: "esc", next: "right",
			opts: []opt{{label: "Red", keys: "1", cur: true}, {label: "Blue", keys: "2"}, {label: "Green", keys: "3"},
				{label: "Type something.", keys: "4", text: "required", textKeys: "4"}}},
		{file: "claude-ask-other-typed.txt", kind: "question", q: "Which color should the poster use?", focused: true, sameSig: "claude-ask-tabs.ansi",
			tabs: "Color Extras +Submit",
			opts: []opt{{label: "Red", keys: "up up up enter"}, {label: "Blue", keys: "up up enter"}, {label: "Green", keys: "up enter"},
				{label: "Type something.", keys: "enter", text: "required", draft: "Teal \"#0aa\" — ünï ✓\nwith a 2nd line", cur: true}}},
		{file: "claude-ask-multi.txt", kind: "question", q: "Which extras do you want on the poster page?", multi: true,
			tabs: "+Color Extras +Submit", cancel: "esc",
			opts: []opt{{label: "Logo", keys: "1", check: "off", cur: true}, {label: "Footer", keys: "2", check: "off"}, {label: "Search", keys: "3", check: "off"},
				{label: "Type something", keys: "4", check: "off", text: "required", textKeys: "down down down"},
				{label: "Submit", keys: "down down down down enter", submit: true}}},
		{file: "claude-ask-multi-typed.txt", kind: "question", q: "Which extras do you want on the poster page?", multi: true, focused: true,
			sameSig: "claude-ask-multi.txt", tabs: "+Color +Extras +Submit",
			opts: []opt{{label: "Logo", keys: "up up up space", check: "on"}, {label: "Footer", keys: "up up space", check: "off"}, {label: "Search", keys: "up space", check: "on"},
				{label: "Type something", keys: "enter", check: "on", text: "required", draft: "Dark mode \"toggle\" ✓", cur: true},
				{label: "Submit", keys: "down enter", submit: true}}},
		{file: "claude-ask-preview.txt", kind: "question", q: "Which layout do you prefer for the page?", notes: true,
			tabs: "Layout", cancel: "esc",
			opts: []opt{{label: "Sidebar", keys: "enter", cur: true, text: "optional", textKeys: "n", preview: "│ Nav  │ Content   │"},
				{label: "Top bar", keys: "down enter", text: "optional", textKeys: "down n"}}},
		{file: "claude-ask-preview-notes.txt", kind: "question", q: "Which layout do you prefer for the page?", notes: true, focused: true,
			sameSig: "claude-ask-preview.txt", tabs: "Layout",
			opts: []opt{{label: "Sidebar", text: "optional"},
				{label: "Top bar", keys: "enter", cur: true, text: "optional", draft: "centered \"logo\" ✓", preview: "│ Nav  Nav  Nav    │"}}},
		{file: "claude-bash-amend.txt", kind: "permission", title: "Bash command", q: "Do you want to proceed?", cancel: "esc",
			opts: []opt{{label: "Yes", keys: "1", cur: true, text: "optional", textKeys: "tab"},
				{label: "Yes, and don’t ask again for: /home/dev/.config/demox/plugins/plugin/demo-reporters-0123456789ab/target/release/hemo-reporters *", keys: "2", always: true},
				{label: "Yes, and switch to auto mode", keys: "3", always: true},
				{label: "No", keys: "4", text: "optional", textKeys: "down down down tab"}}},
		{file: "claude-bash-amend-typed.txt", kind: "permission", title: "Bash command", q: "Do you want to proceed?", focused: true, sameSig: "claude-bash-amend.txt",
			opts: []opt{{label: "Yes", keys: "up up up enter", text: "optional"},
				{label: "Yes, and don’t ask again for: /home/dev/.config/demox/plugins/plugin/demo-reporters-0123456789ab/target/release/hemo-reporters *", keys: "up up enter", always: true},
				{label: "Yes, and switch to auto mode", keys: "up enter", always: true},
				{label: "No", keys: "enter", cur: true, text: "optional", draft: "skip \"this\" — café ✓\nsecond line"}}},
		{file: "claude-edit-amend.txt", kind: "permission", title: "Edit file", q: "Do you want to make this edit to notes.txt?", detail: "1 +hello world", focused: true,
			opts: []opt{{label: "Yes", keys: "enter", cur: true, text: "optional", textKeys: ""},
				{label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", keys: "down enter", always: true},
				{label: "No", keys: "down down enter", text: "optional"}}},
		{file: "claude-create.txt", kind: "permission", title: "Create file", q: "Do you want to create README.md?", detail: "2 A small demo of the poster page.", cancel: "esc",
			opts: []opt{{label: "Yes", keys: "1", cur: true, text: "optional", textKeys: "tab"},
				{label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", keys: "2", always: true},
				{label: "No", keys: "3", text: "optional", textKeys: "down down tab"}}},
		{file: "claude-plan.txt", kind: "plan", title: "Plan", q: "Claude has written up a plan and is ready to execute. Would you like to proceed?",
			detail: "Plan: add README.md\n\nContext\n\nThe repo has no README. Add a minimal one containing the line \"Poster demo\".",
			opts: []opt{{label: "Yes, and use auto mode", keys: "1", cur: true, always: true}, {label: "Yes, manually approve edits", keys: "2"},
				{label: "Tell Claude what to change", keys: "3", text: "required", textKeys: "3"}}},
		{file: "claude-plan-feedback.txt", kind: "plan", title: "Plan", focused: true, sameSig: "claude-plan.txt",
			detail: "- Put the single line Poster demo in it.",
			opts: []opt{{label: "Yes, and use auto mode", keys: "up up enter", always: true}, {label: "Yes, manually approve edits", keys: "up enter"},
				{label: "Tell Claude what to change", keys: "enter", cur: true, text: "required", draft: "Use \"Poster demo ✓\"\nand add a 2nd line"}}},
	}
	parse := func(f string) *Prompt {
		t.Helper()
		b, err := os.ReadFile("testdata/prompts/" + f)
		if err != nil {
			t.Fatal(err)
		}
		return ParsePrompt(string(b), "claude")
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			p := parse(c.file)
			if p == nil {
				t.Fatal("no prompt parsed")
			}
			eq := func(what, got, want string) {
				t.Helper()
				if got != want {
					t.Errorf("%s = %q, want %q", what, got, want)
				}
			}
			eq("kind", p.Kind, c.kind)
			eq("harness", p.Harness, "claude")
			if c.title != "" {
				eq("title", p.Title, c.title)
			}
			if c.q != "" {
				eq("question", p.Question, c.q)
			}
			if c.detail != "" && !strings.Contains(p.Detail, c.detail) {
				t.Errorf("detail %q lacks %q", p.Detail, c.detail)
			}
			var tabs []string
			for _, tb := range p.Tabs {
				s := tb.Label
				if tb.Done {
					s = "+" + s
				}
				if tb.Current {
					s = "*" + s
				}
				tabs = append(tabs, s)
			}
			eq("tabs", strings.Join(tabs, " "), c.tabs)
			eq("cancel", strings.Join(p.Cancel, " "), c.cancel)
			eq("prev", strings.Join(p.Prev, " "), c.prev)
			eq("next", strings.Join(p.Next, " "), c.next)
			if p.Focused != c.focused || p.Multi != c.multi || p.Notes != c.notes {
				t.Errorf("focused/multi/notes = %v/%v/%v", p.Focused, p.Multi, p.Notes)
			}
			if strings.ContainsAny(p.Question+p.Title, "☐☒✔┌│") {
				t.Errorf("screen furniture in %q / %q", p.Title, p.Question)
			}
			if c.sameSig != "" {
				if q := parse(c.sameSig); q == nil || q.Sig != p.Sig {
					t.Errorf("sig differs from %s: typing changed the prompt", c.sameSig)
				}
			}
			if len(p.Options) != len(c.opts) {
				var ls []string
				for _, o := range p.Options {
					ls = append(ls, o.Label)
				}
				t.Fatalf("options %q, want %d", ls, len(c.opts))
			}
			for i, w := range c.opts {
				o := p.Options[i]
				eq("label", o.Label, w.label)
				eq(w.label+" keys", strings.Join(o.Keys, " "), w.keys)
				eq(w.label+" text", o.Text, w.text)
				eq(w.label+" draft", o.Draft, w.draft)
				if w.text != "" && w.draft == "" && !(c.focused && !w.cur) {
					eq(w.label+" text keys", strings.Join(o.TextKeys, " "), w.textKeys)
					if o.TextKeys == nil {
						t.Errorf("%s: text cannot be reached", w.label)
					}
				} else if o.TextKeys != nil {
					t.Errorf("%s: text keys %q where typing is not possible", w.label, o.TextKeys)
				}
				for _, k := range append(append([]string{}, o.Keys...), o.TextKeys...) {
					if !allowedKeys[k] {
						t.Errorf("%s: key %q not allowed", w.label, k)
					}
				}
				if len(o.Keys) > maxKeys || len(o.TextKeys) > maxKeys {
					t.Errorf("%s: too many keys", w.label)
				}
				if c.focused {
					for _, k := range o.Keys {
						if len(k) == 1 || k == "space" && w.cur || k == "tab" || k == "esc" || k == "left" || k == "right" {
							t.Errorf("%s: %q would be typed into the focused field", w.label, k)
						}
					}
				}
				if o.Current != w.cur || o.Always != w.always || o.Submit != w.submit {
					t.Errorf("%s: current/always/submit = %v/%v/%v", w.label, o.Current, o.Always, o.Submit)
				}
				ck := ""
				if o.Checked != nil {
					ck = map[bool]string{true: "on", false: "off"}[*o.Checked]
				}
				eq(w.label+" checked", ck, w.check)
				if w.preview != "" && !strings.Contains(o.Preview, w.preview) {
					t.Errorf("%s: preview %q lacks %q", w.label, o.Preview, w.preview)
				}
				if w.preview == "" && o.Preview != "" {
					t.Errorf("%s: preview %q on a row the pane does not preview", w.label, o.Preview)
				}
				if strings.ContainsAny(o.Label, "┌│└") {
					t.Errorf("%s: preview box in the label", w.label)
				}
			}
		})
	}
}

// 13: the summary names a plan by its first line.
func TestPlanSummary(t *testing.T) {
	b, _ := os.ReadFile("testdata/prompts/claude-plan.txt")
	p := ParsePrompt(string(b), "claude")
	if p == nil || p.Summary != "Plan: add README.md" {
		t.Fatalf("got %+v", p)
	}
}
