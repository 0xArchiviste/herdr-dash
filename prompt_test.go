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

import (
	"os"
	"strings"
	"testing"
)

type wantOpt struct {
	label  string
	keys   string // space-joined; "" = not answerable by keys
	always bool
	text   string
	cur    bool
	check  string // "", "on", "off"
	submit bool
}

func TestParsePrompt(t *testing.T) {
	cases := []struct {
		file, agent                        string
		kind, harness, title, q, subject string
		multi                              bool
		summary                            string
		detail                             string // substring of Detail
		opts                               []wantOpt
	}{
		{file: "claude-bash.txt", agent: "claude", kind: "permission", harness: "claude", title: "Bash command",
			q: "Do you want to proceed?", subject: "ls -la /etc/hostname && wc -l notes.txt",
			summary: "Permission: Bash ls -la /etc/hostname && wc -l notes.txt",
			opts: []wantOpt{{label: "Yes", keys: "1", cur: true}, {label: "Yes, allow reading from /etc from this project", keys: "2", always: true},
				{label: "Yes, and switch to auto mode", keys: "3", always: true}, {label: "No", keys: "4"}}},
		{file: "claude-edit.txt", agent: "claude", kind: "permission", harness: "claude", title: "Edit file",
			q: "Do you want to make this edit to notes.txt?", subject: "notes.txt", detail: "1 +hello world",
			summary: "Permission: Edit notes.txt",
			opts: []wantOpt{{label: "Yes", keys: "1", cur: true}, {label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", keys: "2", always: true}, {label: "No", keys: "3"}}},
		{file: "claude-fetch.txt", agent: "claude", kind: "permission", harness: "claude", title: "Fetch",
			q: "Do you want to allow Claude to fetch this content?", subject: "https://example.com/",
			summary: "Permission: Fetch https://example.com/",
			opts: []wantOpt{{label: "Yes", keys: "1", cur: true}, {label: "Yes, and don't ask again for example.com", keys: "2", always: true},
				{label: "No, and tell Claude what to do differently", keys: "3", text: "optional"}}},
		{file: "claude-question.txt", agent: "claude", kind: "question", harness: "claude",
			q: "Which database should we use?", summary: "Question: Which database should we use?",
			opts: []wantOpt{{label: "Postgres", keys: "1", cur: true}, {label: "SQLite", keys: "2"}, {label: "MySQL", keys: "3"}, {label: "Type something.", keys: "4", text: "required"}}},
		{file: "claude-other.txt", agent: "claude", kind: "question", harness: "claude", q: "Which color?",
			opts: []wantOpt{{label: "Red", keys: "1"}, {label: "Blue", keys: "2"}, {label: "Type something.", keys: "3", text: "required", cur: true}}},
		{file: "claude-multiselect.txt", agent: "claude", kind: "question", harness: "claude", multi: true,
			q: "Which features do you want to enable?",
			opts: []wantOpt{{label: "Logging", keys: "1", cur: true, check: "on"}, {label: "Metrics", keys: "2", check: "off"}, {label: "Tracing", keys: "3", check: "on"},
				{label: "Submit", keys: "down down down down enter", submit: true}}},
		{file: "claude-review.txt", agent: "claude", kind: "question", harness: "claude", q: "Ready to submit your answers?", detail: "→ Logging, Tracing",
			opts: []wantOpt{{label: "Submit answers", keys: "1", cur: true}, {label: "Cancel", keys: "2"}}},
		{file: "claude-trust.txt", agent: "claude", kind: "trust", harness: "claude", subject: "/home/dev/code/demo-app",
			summary: "Trust folder: /home/dev/code/demo-app",
			opts: []wantOpt{{label: "No, exit", keys: "enter", cur: true}, {label: "Yes, I trust this folder", keys: "down enter", always: true}}},
		{file: "codex-trust.txt", agent: "codex", kind: "trust", harness: "codex", subject: "/home/dev/code/demo-app",
			opts: []wantOpt{{label: "Trust and continue", keys: "1", cur: true, always: true}, {label: "Back to Agent Command Center", keys: "2"}}},
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
			opts: []wantOpt{{label: "Allow once", keys: "enter", cur: true}, {label: "Allow always", keys: "right enter", always: true}, {label: "Reject", keys: "right right enter"}}},
		{file: "opencode-edit.ansi", agent: "opencode", kind: "permission", harness: "opencode", title: "Edit", subject: "notes.txt", detail: "1 + hello world",
			opts: []wantOpt{{label: "Allow once", keys: "enter", cur: true}, {label: "Allow always", keys: "right enter", always: true}, {label: "Reject", keys: "right right enter"}}},
		{file: "opencode-always.ansi", agent: "opencode", kind: "permission", harness: "opencode", title: "Always allow", subject: "wc *",
			q: "This will allow the following patterns until OpenCode is restarted",
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
			if c.summary != "" {
				eq("summary", p.Summary, c.summary)
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
