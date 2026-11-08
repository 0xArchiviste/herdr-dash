package main

// Panes whose agent exited. herdr keeps the pane: it lists it with no agent
// and the shell the agent ran in is back at its prompt. Dash then offers a
// command line for that shell, raw keys, and the way back: herdr-projects
// `thread restart` (same profile, a fresh session) or `open` (a coordinator,
// resuming its recorded session when the harness can).
//
// Writes go to herdr directly (`pane send-text`): herdr-projects has no
// command for typing into a shell. Text and keys reach only a pane Dash
// identified as one of a project's own (a thread's recorded pane, the
// verified coordinator pane), and only after herdr confirmed, right then,
// that no agent runs there, unless the user switched to keys mode.
//
// An agent killed mid-run leaves its terminal modes behind (kitty keyboard
// protocol, application cursor keys), so herdr's key encoder would send
// bash Ctrl+C or the arrows as escape codes it cannot read. Keys for a dead
// pane are therefore sent as the plain bytes a shell expects.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxTermText  = 4000
	maxTermSeq   = 64
	bracketOpen  = "\x1b[200~"
	bracketClose = "\x1b[201~"
)

// termKeys are the keys a terminal write may press, as the bytes a shell at
// its prompt reads (normal cursor-key mode). herdrKeyNames are those herdr's
// own encoder knows, used for a pane whose agent is alive.
var termKeys = func() map[string]string {
	m := map[string]string{
		"enter": "\r", "tab": "\t", "shift+tab": "\x1b[Z", "esc": "\x1b", "backspace": "\x7f", "space": " ",
		"up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
		"home": "\x1b[H", "end": "\x1b[F", "pageup": "\x1b[5~", "pagedown": "\x1b[6~", "delete": "\x1b[3~",
	}
	for c := 'a'; c <= 'z'; c++ {
		m["ctrl+"+string(c)] = string(rune(c - 'a' + 1))
	}
	return m
}()

var herdrKeyNames = func() map[string]bool {
	m := map[string]bool{"enter": true, "tab": true, "shift+tab": true, "esc": true, "backspace": true, "space": true,
		"up": true, "down": true, "right": true, "left": true}
	for c := 'a'; c <= 'z'; c++ {
		m["ctrl+"+string(c)] = true
	}
	return m
}()

// shells are the programs that, in the foreground, read a pasted command
// line with bracketed paste (bash 5.1+, zsh 5.1+, fish 3).
var shells = map[string]bool{"bash": true, "zsh": true, "fish": true, "sh": true, "dash": true, "ksh": true, "mksh": true}

// procInfo is what runs in a pane right now: its foreground programs and
// whether the shell itself is in the foreground.
type procInfo struct {
	Shell      bool   // the shell is the foreground process group
	Foreground string // the foreground programs' names, "bash" or "vim"
	ShellName  string // the foreground's name when Shell
}

func (c *Collector) processInfo(ctx context.Context, pane string) (procInfo, error) {
	out, err := run(ctx, 3*time.Second, c.cfg.Herdr, "pane", "process-info", "--pane", pane)
	if err != nil {
		return procInfo{}, err
	}
	var doc struct {
		Result struct {
			Info struct {
				PGID  int `json:"foreground_process_group_id"`
				Shell int `json:"shell_pid"`
				Procs []struct {
					Name string `json:"name"`
				} `json:"foreground_processes"`
			} `json:"process_info"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return procInfo{}, err
	}
	in := doc.Result.Info
	var names []string
	for _, p := range in.Procs {
		names = append(names, p.Name)
	}
	pi := procInfo{Foreground: strings.Join(names, ", ")}
	if in.Shell != 0 && in.PGID == in.Shell && len(names) > 0 {
		pi.ShellName = names[0]
		pi.Shell = shells[pi.ShellName]
	}
	return pi, nil
}

// paneNow asks herdr about pane right now (not the last poll).
func (a *Actions) paneNow(pane string) (Pane, error) {
	out, err := run(context.Background(), 5*time.Second, a.cfg.Herdr, "pane", "get", pane)
	var doc struct {
		Result struct {
			Pane Pane `json:"pane"`
		} `json:"result"`
	}
	if err == nil {
		err = json.Unmarshal(out, &doc)
	}
	if err == nil && doc.Result.Pane.PaneID != pane {
		err = fmt.Errorf("herdr answered for another pane")
	}
	if err != nil {
		return Pane{}, fail(http.StatusConflict, "cannot check pane %s: %v", pane, err)
	}
	return doc.Result.Pane, nil
}

type termItem struct {
	Text string `json:"text,omitempty"`
	Key  string `json:"key,omitempty"`
}

type termReq struct {
	Mode string     `json:"mode"` // line: a command line for the shell; keys: raw keys
	Text string     `json:"text"` // line: the command
	Keys []string   `json:"keys"` // line: control keys only (ctrl+c), no text
	Seq  []termItem `json:"seq"`  // keys: text and keys in order
	// The pane the page showed (its screen event's pane_id), if it knows:
	// a write for another pane is refused, so keys never follow a thread or
	// coordinator to a pane the user did not see.
	Pane string `json:"pane"`
}

// termTarget is a pane a terminal write may reach, and whose it is.
type termTarget struct {
	who  string // "alpha/t-0001" or "alpha coordinator", for the log
	pane string
}

func (a *Actions) threadTerm(r *http.Request, body []byte) (any, error) {
	_, _, t, err := a.thread(r)
	if err != nil {
		return nil, err
	}
	if t.Status == "resolved" {
		return nil, fail(http.StatusConflict, "%s is resolved", t.ID)
	}
	if _, alive := a.col.pane(t.PaneID); t.PaneID == "" || !alive {
		return nil, fail(http.StatusConflict, "%s has no pane", t.ID)
	}
	return a.term(termTarget{r.PathValue("slug") + "/" + t.ID, t.PaneID}, body)
}

func (a *Actions) coordTerm(r *http.Request, body []byte) (any, error) {
	slug := r.PathValue("slug")
	if !slugRe.MatchString(slug) {
		return nil, fail(http.StatusBadRequest, "bad project")
	}
	if !a.col.hasProject(slug) {
		return nil, fail(http.StatusNotFound, "no project %s", slug)
	}
	co, ok := a.col.coordPane(slug)
	if !ok {
		return nil, fail(http.StatusConflict, "no coordinator pane is identified for %s", slug)
	}
	return a.term(termTarget{slug + " coordinator", co.PaneID}, body)
}

// term checks a terminal write and sends it.
func (a *Actions) term(tg termTarget, body []byte) (any, error) {
	var req termReq
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	if req.Pane != "" && req.Pane != tg.pane {
		return nil, fail(http.StatusConflict, "the pane changed: %s now runs in %s, not %s; look again", tg.who, tg.pane, req.Pane)
	}
	var payload string // bytes for a dead pane
	var steps []termItem
	switch req.Mode {
	case "line":
		if len(req.Seq) > 0 || (req.Text == "") == (len(req.Keys) == 0) {
			return nil, fail(http.StatusBadRequest, "line: give text, or control keys")
		}
		if req.Text != "" {
			text, err := cleanText(req.Text, maxTermText, true)
			if err != nil {
				return nil, err
			}
			req.Text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
		}
		if len(req.Keys) > maxKeys {
			return nil, fail(http.StatusBadRequest, "give 1 to %d keys", maxKeys)
		}
		for _, k := range req.Keys {
			if !strings.HasPrefix(k, "ctrl+") || termKeys[k] == "" {
				return nil, fail(http.StatusBadRequest, "line: key %q is not a control key", k)
			}
			payload += termKeys[k]
		}
	case "keys":
		if len(req.Seq) == 0 || len(req.Seq) > maxTermSeq || req.Text != "" || len(req.Keys) > 0 {
			return nil, fail(http.StatusBadRequest, "keys: give 1 to %d items in seq", maxTermSeq)
		}
		n := 0
		for _, it := range req.Seq {
			switch {
			case (it.Text == "") == (it.Key == ""):
				return nil, fail(http.StatusBadRequest, "keys: each item is a text or a key")
			case it.Key != "" && termKeys[it.Key] == "":
				return nil, fail(http.StatusBadRequest, "key %q is not allowed", it.Key)
			case it.Text != "":
				if !utf8.ValidString(it.Text) || strings.ContainsFunc(it.Text, unicode.IsControl) {
					return nil, fail(http.StatusBadRequest, "text holds a control character")
				}
				n += len(it.Text)
				payload += it.Text
			default:
				payload += termKeys[it.Key]
			}
		}
		if n > maxKeysText {
			return nil, fail(http.StatusBadRequest, "text is longer than %d bytes", maxKeysText)
		}
		steps = req.Seq
	default:
		return nil, fail(http.StatusBadRequest, "mode: line or keys")
	}

	// herdr, right now: is an agent in the pane?
	pn, err := a.paneNow(tg.pane)
	if err != nil {
		return nil, err
	}
	alive := pn.Agent != ""
	if alive && req.Mode == "line" {
		return nil, httpErr{http.StatusConflict, fmt.Sprintf("agent_alive: %s runs in pane %s (%s); switch to keys mode to type into it", pn.Agent, tg.pane, pn.AgentStatus)}
	}
	if alive {
		if p := a.col.promptOf(tg.pane); p != nil && p.Kind == "trust" {
			return nil, fail(http.StatusForbidden, "trust screens are answered in the agent's own pane")
		}
		for _, it := range steps {
			if it.Key != "" && !herdrKeyNames[it.Key] {
				return nil, fail(http.StatusBadRequest, "key %q cannot be sent to a running agent", it.Key)
			}
		}
	}
	if req.Mode == "line" && req.Text != "" {
		pi, err := a.col.processInfo(context.Background(), tg.pane)
		if err != nil {
			return nil, fail(http.StatusConflict, "cannot see what runs in pane %s: %v", tg.pane, err)
		}
		if pi.Shell {
			// One paste: the shell takes it whole, newlines and all, and
			// runs it on the Enter after it.
			payload = bracketOpen + req.Text + bracketClose + "\r"
		} else {
			if strings.ContainsAny(req.Text, "\n\t") {
				return nil, fail(http.StatusBadRequest, "%s is in the foreground, not a shell: send one line at a time", pi.Foreground)
			}
			payload = req.Text + "\r"
		}
	}

	if !a.termBucket.take() {
		return nil, fail(http.StatusTooManyRequests, "too many writes; wait a moment")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	defer a.col.Burst(tg.pane)
	herdr := func(args ...string) error {
		_, err := runIn(context.Background(), 10*time.Second, "", a.cfg.Herdr, append([]string{"pane"}, args...)...)
		return err
	}
	if !alive {
		err = herdr("send-text", tg.pane, payload)
	} else {
		// A live agent reads keys in the modes it set: herdr's encoder knows them.
		for _, it := range steps {
			if it.Text != "" {
				err = herdr("send-text", tg.pane, it.Text)
			} else {
				err = herdr("send-keys", tg.pane, it.Key)
			}
			if err != nil {
				break
			}
		}
	}
	what := fmt.Sprintf("%q", payload)
	if alive {
		what = fmt.Sprintf("%+v (agent %s alive, keys mode)", steps, pn.Agent)
	}
	log.Printf("term %s: pane %s %s: sent %s", tg.who, tg.pane, req.Mode, what)
	if err != nil {
		return nil, err
	}
	a.kickSoon()
	return actionResult{OK: true}, nil
}

// threadRestart brings a thread's agent back with `thread restart`: the
// thread's own profile, in its pane when that is at a shell prompt. It is
// always a fresh session (herdr-projects does not resume threads), so the
// page confirms first and sends the thread's key.
func (a *Actions) threadRestart(r *http.Request, body []byte) (any, error) {
	slug, id, t, err := a.thread(r)
	if err != nil {
		return nil, err
	}
	var req struct{ Confirm string }
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	if req.Confirm != slug+"/"+id {
		return nil, fail(http.StatusBadRequest, "restart needs confirm: %q", slug+"/"+id)
	}
	if t.Status == "resolved" {
		return nil, fail(http.StatusConflict, "%s is resolved", id)
	}
	if pn, ok := a.col.pane(t.PaneID); ok && t.PaneID != "" {
		if now, err := a.paneNow(t.PaneID); err == nil {
			pn = now
		}
		if pn.Agent != "" {
			return nil, fail(http.StatusConflict, "%s's agent (%s) is running in pane %s", id, pn.Agent, t.PaneID)
		}
	}
	out, err := a.hp(3*time.Minute, "", "thread", "restart", slug, id)
	a.col.Burst(t.PaneID)
	if err != nil {
		return nil, err
	}
	a.kickSoon()
	return actionResult{OK: true, Output: out}, nil
}

// coordRestart brings a project's coordinator back with `open`, which
// reuses its pane at the shell prompt and resumes the recorded session when
// the harness supports it (herdr-projects starts fresh when it cannot).
func (a *Actions) coordRestart(r *http.Request, body []byte) (any, error) {
	slug := r.PathValue("slug")
	if !slugRe.MatchString(slug) {
		return nil, fail(http.StatusBadRequest, "bad project")
	}
	if !a.col.hasProject(slug) {
		return nil, fail(http.StatusNotFound, "no project %s", slug)
	}
	var req struct{ Confirm string }
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	if req.Confirm != slug {
		return nil, fail(http.StatusBadRequest, "restart needs confirm: %q", slug)
	}
	co, ok := a.col.coordPane(slug)
	if !ok {
		return nil, fail(http.StatusConflict, "no coordinator pane is identified for %s", slug)
	}
	pn, err := a.paneNow(co.PaneID)
	if err != nil {
		return nil, err
	}
	if pn.Agent != "" {
		return nil, fail(http.StatusConflict, "the %s coordinator (%s) is running in pane %s", slug, pn.Agent, co.PaneID)
	}
	out, err := a.hp(3*time.Minute, "", "open", slug)
	a.col.Burst(co.PaneID)
	if err != nil {
		return nil, err
	}
	a.kickSoon()
	return actionResult{OK: true, Output: out}, nil
}

// resumable says whether herdr-projects' `open` would resume a coordinator's
// recorded session: a harness with a documented resume command, a session
// id, and the profile it ran with still the project's coordinator profile
// (herdr-projects src/agents.rs resume_args, coordinator.rs open).
func resumable(rec coordRecord, profile string) bool {
	if rec.AgentSession == "" || strings.HasPrefix(rec.AgentSession, "-") {
		return false
	}
	switch rec.Agent {
	case "claude", "cursor", "grok", "devin", "droid", "qodercli", "qwen", "hermes", "codex", "omp", "copilot",
		"pi", "opencode", "kimi", "kilo", "agy", "letta", "mastracode":
	default:
		return false
	}
	ran := rec.Profile
	if ran == "" {
		ran = rec.Agent
	}
	return profile == "" || ran == profile
}
