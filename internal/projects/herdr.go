// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const callTimeout = 10 * time.Second

// Agent is one row of `herdr agent list`.
type Agent struct {
	PaneID, TabID, WorkspaceID, Name, Agent, AgentStatus, Cwd, ForegroundCwd, TerminalID string
	StateChangeSeq                                                                       uint64
	SessionID                                                                            string
	InteractiveReady                                                                     bool
}

// OwnDir is the folder the pane's agent works in: its foreground
// process's when herdr reports one, else the shell's (0.2.35, #97).
func OwnDir(cwd, foreground string) string {
	if foreground == "" {
		return cwd
	}
	return foreground
}

func (a Agent) worksIn(dir string) bool { return dir != "" && OwnDir(a.Cwd, a.ForegroundCwd) == dir }

// Pane is one row of `herdr pane list`.
type Pane struct {
	PaneID, TabID, WorkspaceID, Cwd, ForegroundCwd, TerminalID string
	Focused                                                    bool
}

// Session is one row of `herdr session list --json`.
type Session struct {
	Name, SocketPath string
	Default, Running bool
}

// SavedMachine is one row of `herdr machine list --json`.
type SavedMachine struct{ ID, Label, Target string }

// Herdr is the read half of the herdr CLI the views need. Each method
// answers for one session socket.
type Herdr interface {
	AgentList(socket string) ([]Agent, error)
	PaneList(socket string) ([]Pane, error)
	SessionList() ([]Session, error)
	MachineList() []SavedMachine
}

// CLI calls the herdr binary as the Rust code does: HERDR_SOCKET_PATH set
// to the session's socket and HERDR_SESSION removed, 10 s per call.
type CLI struct {
	Bin string
	Env Env
}

func (c CLI) run(socket string, args ...string) ([]byte, []byte, error, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.Bin, args...)
	set := map[string]string{"HERDR_SESSION": ""}
	if socket != "" {
		set["HERDR_SOCKET_PATH"] = socket
	}
	cmd.Env = c.Env.environ(set)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return out.Bytes(), errb.Bytes(), err, ctx.Err() != nil
}

// call returns the `result` object of herdr's JSON reply.
func (c CLI) call(socket string, args ...string) (map[string]any, error) {
	stdout, stderr, err, timedOut := c.run(socket, args...)
	if timedOut {
		return nil, fmt.Errorf("`herdr %s` timed out", strings.Join(args, " "))
	}
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return nil, err
	}
	for _, text := range [][]byte{stdout, stderr} {
		reply, perr := decodeJSONObj(bytes.TrimSpace(text))
		if perr != nil {
			continue
		}
		if e, ok := reply["error"]; ok {
			em, _ := e.(map[string]any)
			msg, _ := em["message"].(string)
			code, _ := em["code"].(string)
			return nil, fmt.Errorf("herdr: %s (%s)", msg, code)
		}
		if err == nil {
			r, _ := reply["result"].(map[string]any)
			return r, nil
		}
		break
	}
	return nil, fmt.Errorf("`herdr %s` failed", strings.Join(args, " "))
}

func (c CLI) AgentList(socket string) ([]Agent, error) {
	r, err := c.call(socket, "agent", "list")
	if err != nil {
		return nil, err
	}
	return parseAgents(r["agents"])
}

func (c CLI) PaneList(socket string) ([]Pane, error) {
	r, err := c.call(socket, "pane", "list")
	if err != nil {
		return nil, err
	}
	return parsePanes(r["panes"])
}

func (c CLI) SessionList() ([]Session, error) {
	stdout, _, err, _ := c.run("", "session", "list", "--json")
	if err != nil {
		return nil, fmt.Errorf("`%s session list` failed: %w", c.Bin, err)
	}
	m, err := decodeJSONObj(stdout)
	if err != nil {
		return nil, errors.New("`herdr session list --json` output changed")
	}
	arr, ok := m["sessions"].([]any)
	if !ok {
		return nil, errors.New("`herdr session list --json` output changed")
	}
	var out []Session
	for _, e := range arr {
		em, ok := e.(map[string]any)
		if !ok {
			return nil, errors.New("`herdr session list --json` output changed")
		}
		o := newObj(em)
		_, hasName := em["name"]
		_, hasSock := em["socket_path"]
		s := Session{Name: o.str("name", ""), Default: o.boolean("default", false), Running: o.boolean("running", false), SocketPath: o.str("socket_path", "")}
		if o.err != nil || !hasName || !hasSock {
			return nil, errors.New("`herdr session list --json` output changed")
		}
		out = append(out, s)
	}
	return out, nil
}

func (c CLI) MachineList() []SavedMachine {
	stdout, _, err, _ := c.run("", "machine", "list", "--json")
	if err != nil {
		return nil
	}
	v, err := decodeJSON(stdout)
	if err != nil {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []SavedMachine
	for _, e := range arr {
		em, ok := e.(map[string]any)
		if !ok {
			return nil
		}
		o := newObj(em)
		m := SavedMachine{ID: o.str("id", ""), Label: o.str("label", ""), Target: o.str("target", "")}
		if o.err != nil {
			return nil
		}
		out = append(out, m)
	}
	return out
}

// required fails like serde on a missing field without a default.
func required(m map[string]any, keys ...string) error {
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return fmt.Errorf("missing field `%s`", k)
		}
	}
	return nil
}

func parseAgents(v any) ([]Agent, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, errors.New("`herdr agent list` reply changed")
	}
	out := make([]Agent, 0, len(arr))
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok {
			return nil, errors.New("`herdr agent list` reply changed")
		}
		if err := required(m, "pane_id", "tab_id", "workspace_id"); err != nil {
			return nil, err
		}
		o := newObj(m)
		a := Agent{
			PaneID: o.str("pane_id", ""), TabID: o.str("tab_id", ""), WorkspaceID: o.str("workspace_id", ""),
			Name: o.str("name", ""), Agent: o.str("agent", ""), AgentStatus: o.str("agent_status", ""),
			Cwd: o.str("cwd", ""), ForegroundCwd: o.str("foreground_cwd", ""), TerminalID: o.str("terminal_id", ""),
			StateChangeSeq: o.u64("state_change_seq"), InteractiveReady: o.boolean("interactive_ready", false),
		}
		if sv, ok := o.take("agent_session"); ok && sv != nil {
			sm, isMap := sv.(map[string]any)
			if !isMap {
				return nil, errors.New("`herdr agent list` reply changed")
			}
			so := newObj(sm)
			a.SessionID = so.str("value", "")
			if so.err != nil {
				return nil, so.err
			}
		}
		if o.err != nil {
			return nil, o.err
		}
		out = append(out, a)
	}
	return out, nil
}

func parsePanes(v any) ([]Pane, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, errors.New("`herdr pane list` reply changed")
	}
	out := make([]Pane, 0, len(arr))
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok {
			return nil, errors.New("`herdr pane list` reply changed")
		}
		if err := required(m, "pane_id", "tab_id", "workspace_id"); err != nil {
			return nil, err
		}
		o := newObj(m)
		p := Pane{
			PaneID: o.str("pane_id", ""), TabID: o.str("tab_id", ""), WorkspaceID: o.str("workspace_id", ""),
			Cwd: o.str("cwd", ""), ForegroundCwd: o.str("foreground_cwd", ""), TerminalID: o.str("terminal_id", ""),
			Focused: o.boolean("focused", false),
		}
		if o.err != nil {
			return nil, o.err
		}
		out = append(out, p)
	}
	return out, nil
}

// cachedHerdr asks each session once per read: the Rust CLI re-asks per
// project, which is where most of `list`'s time goes.
type cachedHerdr struct {
	h        Herdr
	mu       sync.Mutex
	agents   map[string]agentsReply
	panes    map[string]panesReply
	sessions *sessionsReply
	machines []SavedMachine
	machOK   bool
}

type agentsReply struct {
	v   []Agent
	err error
}
type panesReply struct {
	v   []Pane
	err error
}
type sessionsReply struct {
	v   []Session
	err error
}

func newCached(h Herdr) *cachedHerdr {
	return &cachedHerdr{h: h, agents: map[string]agentsReply{}, panes: map[string]panesReply{}}
}

func (c *cachedHerdr) AgentList(socket string) ([]Agent, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, ok := c.agents[socket]
	if !ok {
		r.v, r.err = c.h.AgentList(socket)
		c.agents[socket] = r
	}
	return r.v, r.err
}

func (c *cachedHerdr) PaneList(socket string) ([]Pane, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, ok := c.panes[socket]
	if !ok {
		r.v, r.err = c.h.PaneList(socket)
		c.panes[socket] = r
	}
	return r.v, r.err
}

func (c *cachedHerdr) SessionList() ([]Session, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sessions == nil {
		v, err := c.h.SessionList()
		c.sessions = &sessionsReply{v, err}
	}
	return c.sessions.v, c.sessions.err
}

func (c *cachedHerdr) MachineList() []SavedMachine {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.machOK {
		c.machines, c.machOK = c.h.MachineList(), true
	}
	return c.machines
}

func readFileBytes(path string) ([]byte, error) { return os.ReadFile(path) }
