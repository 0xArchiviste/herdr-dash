package main

// Session details are observations, never a model-name capacity lookup. Unknown
// values carry a reason; configured values retain their different provenance.
import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

type SessionValue struct {
	Value  string `json:"value"`
	Source string `json:"source"`
	Reason string `json:"reason,omitempty"`
}
type SessionWindow struct {
	Tokens int64  `json:"tokens"`
	Source string `json:"source"`
	Reason string `json:"reason,omitempty"`
}
type SessionDetails struct {
	Profile       string        `json:"profile,omitempty"`
	Provider      SessionValue  `json:"provider"`
	Model         SessionValue  `json:"model"`
	Effort        SessionValue  `json:"effort"`
	ContextWindow SessionWindow `json:"context_window"`
}

func observed(v string) SessionValue { return SessionValue{Value: v, Source: "session"} }

// parseSessionEvents accepts complete JSONL records, skipping malformed records
// and synthetic assistant messages. A model switch invalidates old capacity.
func parseSessionEvents(r io.Reader, agent string) SessionDetails {
	var d SessionDetails
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var e struct {
			Type          string          `json:"type"`
			Effort        json.RawMessage `json:"effort"`
			PerTurnEffort json.RawMessage `json:"perTurnEffort"`
			Payload       struct {
				Type     string `json:"type"`
				Model    string `json:"model"`
				Provider string `json:"model_provider"`
				Effort   string `json:"effort"`
				Info     *struct {
					Window int64 `json:"model_context_window"`
				} `json:"info"`
			} `json:"payload"`
			Message struct {
				Model string `json:"model"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &e) != nil {
			continue
		}
		if agent == "codex" {
			switch e.Type {
			case "session_meta":
				if e.Payload.Provider != "" {
					d.Provider = observed(e.Payload.Provider)
				}
			case "turn_context":
				if e.Payload.Model != "" {
					if d.Model.Value != e.Payload.Model {
						d.ContextWindow = SessionWindow{}
					}
					d.Model = observed(e.Payload.Model)
					d.Effort = SessionValue{}
					if e.Payload.Effort != "" {
						d.Effort = observed(e.Payload.Effort)
					}
				}
			case "event_msg":
				if e.Payload.Type == "token_count" && e.Payload.Info != nil && e.Payload.Info.Window > 0 {
					d.ContextWindow = SessionWindow{Tokens: e.Payload.Info.Window, Source: "session"}
				}
			}
		} else if agent == "claude" && e.Type == "assistant" && e.Message.Model != "" && !strings.HasPrefix(e.Message.Model, "<") {
			d.Model = observed(e.Message.Model)
			d.Effort = SessionValue{}
			var effort string
			json.Unmarshal(e.PerTurnEffort, &effort)
			if effort == "" {
				json.Unmarshal(e.Effort, &effort)
			}
			if effort != "" {
				d.Effort = observed(effort)
			}
		}
	}
	return d
}

type sessionCacheEntry struct {
	size     int64
	modified time.Time
	details  SessionDetails
}

func (c *Collector) sessionDetails(p Pane, agent, profile string) SessionDetails {
	var d SessionDetails
	if p.Agent != "" {
		agent = p.Agent
	}
	if p.AgentSession != nil && p.AgentSession.Agent == agent && p.session() != "" && !strings.ContainsAny(p.session(), "/\\*?[") {
		if agent == "opencode" {
			d = c.opencodeSession(p.session())
		} else {
			c.lastTranscript(p)
			path := c.transcript[p.session()].path
			if st, err := os.Stat(path); err == nil {
				hit, ok := c.sessionCache[path]
				if !ok || hit.size != st.Size() || !hit.modified.Equal(st.ModTime()) {
					if f, err := os.Open(path); err == nil {
						// Bounded reads keep large transcripts off the polling hot path. Read
						// metadata at the beginning and recent turns at the end. Drop a partial line.
						var r io.Reader = f
						if st.Size() > 4*1024*1024 {
							head := parseSessionEvents(io.LimitReader(f, 64*1024), agent)
							f.Seek(-4*1024*1024, io.SeekEnd)
							br := bufio.NewReader(f)
							br.ReadString('\n')
							r = br
							d = parseSessionEvents(r, agent)
							if d.Provider.Value == "" {
								d.Provider = head.Provider
							}
						} else {
							d = parseSessionEvents(r, agent)
						}
						f.Close()
						hit = sessionCacheEntry{st.Size(), st.ModTime(), d}
						c.sessionCache[path] = hit
					}
				}
				d = hit.details
			}
		}
	}
	d.Profile = profile
	// Only the selected, matching herdr-projects profile is a valid fallback.
	var cfg struct {
		Profiles map[string]struct{ Agent, Model, Effort string }
	}
	if b, err := os.ReadFile(c.cfg.SessionProfiles); err == nil && toml.Unmarshal(b, &cfg) == nil {
		if pr, ok := cfg.Profiles[profile]; ok && (agent == "" || pr.Agent == agent) {
			if agent == "" {
				agent = pr.Agent
			}
			if d.Model.Value == "" && pr.Model != "" {
				d.Model = SessionValue{Value: pr.Model, Source: "profile"}
			}
			if d.Effort.Value == "" && pr.Effort != "" {
				d.Effort = SessionValue{Value: pr.Effort, Source: "profile"}
			}
			if pr.Agent == "opencode" {
				provider, model, ok := strings.Cut(pr.Model, "/")
				if ok && d.Model.Source == "profile" {
					d.Model.Value = model
					d.Provider = SessionValue{Value: provider, Source: "profile"}
				}
			}
		}
	}
	c.configuredSession(&d, agent)
	for _, v := range []*SessionValue{&d.Provider, &d.Model, &d.Effort} {
		if v.Value == "" {
			v.Source = "unknown"
			v.Reason = "Not reported by this session or its selected profile"
		}
	}
	if d.ContextWindow.Tokens == 0 {
		d.ContextWindow.Source = "unknown"
		d.ContextWindow.Reason = "Session does not report context-window capacity; token usage is not capacity"
	}
	return d
}

// SQLite CLI is optional. Read only the selected session's latest user and
// assistant metadata; never expose message text, credentials, or local paths.
func (c *Collector) opencodeSession(id string) SessionDetails {
	key := "opencode:" + id
	hit := c.sessionCache[key]
	if time.Since(hit.modified) < 5*time.Second {
		return hit.details
	}
	var d SessionDetails
	if c.cfg.OpencodeDB != "" {
		query := `SELECT json_object('role',json_extract(data,'$.role'),'model',json_extract(data,'$.model'),'modelID',json_extract(data,'$.modelID'),'providerID',json_extract(data,'$.providerID'),'variant',json_extract(data,'$.variant')) FROM message WHERE session_id='` + strings.ReplaceAll(id, "'", "''") + `' AND json_extract(data,'$.role') IN ('user','assistant') ORDER BY time_created DESC LIMIT 8;`
		out, err := run(context.Background(), time.Second, "sqlite3", "-readonly", c.cfg.OpencodeDB, query)
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				var m struct {
					Role, ModelID, ProviderID, Variant string
					Model                              struct{ ModelID, ProviderID string }
				}
				if json.Unmarshal([]byte(line), &m) != nil {
					continue
				}
				if m.Role == "user" {
					m.ModelID, m.ProviderID = m.Model.ModelID, m.Model.ProviderID
				}
				if d.Model.Value == "" && m.ModelID != "" {
					d.Model = observed(m.ModelID)
					if m.ProviderID != "" {
						d.Provider = observed(m.ProviderID)
					}
				}
				if m.Role == "user" {
					if m.ModelID == d.Model.Value && m.ProviderID == d.Provider.Value && m.Variant != "" {
						d.Effort = SessionValue{Value: m.Variant, Source: "session_variant"}
					}
					break
				}
			}
		}
	}
	c.sessionCache[key] = sessionCacheEntry{modified: time.Now(), details: d}
	return d
}

// Harness settings are fallbacks only. Their effective runtime may differ
// because of CLI flags, project settings, environment, or interactive changes.
func (c *Collector) configuredSession(d *SessionDetails, agent string) {
	var model, provider, effort string
	var window int64
	if agent == "codex" {
		var cfg struct {
			Model    string `toml:"model"`
			Provider string `toml:"model_provider"`
			Effort   string `toml:"model_reasoning_effort"`
			Window   int64  `toml:"model_context_window"`
		}
		if b, err := os.ReadFile(filepath.Join(filepath.Dir(c.cfg.CodexDir), "config.toml")); err == nil && toml.Unmarshal(b, &cfg) == nil {
			model, provider, effort, window = cfg.Model, cfg.Provider, cfg.Effort, cfg.Window
		}
	} else if agent == "claude" {
		var cfg struct {
			Model  string `json:"model"`
			Effort string `json:"effortLevel"`
		}
		if b, err := os.ReadFile(filepath.Join(filepath.Dir(c.cfg.ClaudeDir), "settings.json")); err == nil && json.Unmarshal(b, &cfg) == nil {
			model, effort = cfg.Model, cfg.Effort
		}
	}
	if agent == "opencode" {
		var cfg struct {
			Model     string `json:"model"`
			Providers map[string]struct {
				Models map[string]struct {
					Limit struct {
						Context int64 `json:"context"`
					} `json:"limit"`
				} `json:"models"`
			} `json:"provider"`
		}
		for _, name := range []string{"opencode.jsonc", "opencode.json", "config.json"} {
			b, err := os.ReadFile(filepath.Join(c.cfg.Usage.OpencodeConfig, name))
			if err != nil || json.Unmarshal(jsonc(b), &cfg) != nil {
				continue
			}
			if p, m, ok := strings.Cut(cfg.Model, "/"); ok {
				provider, model = p, m
			}
			if d.Model.Value == "" && model != "" {
				d.Model = SessionValue{Value: model, Source: "config"}
			}
			if d.Provider.Value == "" && provider != "" {
				d.Provider = SessionValue{Value: provider, Source: "config"}
			}
			if capacity := cfg.Providers[d.Provider.Value].Models[d.Model.Value].Limit.Context; capacity > 0 && d.ContextWindow.Tokens == 0 {
				d.ContextWindow = SessionWindow{Tokens: capacity, Source: "config"}
			}
			break
		}
	}
	set := func(v *SessionValue, value string) {
		if v.Value == "" && value != "" {
			*v = SessionValue{Value: value, Source: "config"}
		}
	}
	set(&d.Model, model)
	set(&d.Provider, provider)
	set(&d.Effort, effort)
	// A configured capacity applies only to the exact configured model and
	// provider, and must never be attributed to an observed runtime selection.
	if d.ContextWindow.Tokens == 0 && window > 0 && d.Model.Source == "config" && d.Model.Value == model && d.Provider.Source != "session" {
		d.ContextWindow = SessionWindow{Tokens: window, Source: "config"}
	}
}

func (c *Collector) projectProfile(slug, kind string) string {
	if p := readSettings(filepath.Join(c.cfg.Root, slug, "PROJECT.md"))[kind+"_profile"]; p != "" {
		return p
	}
	var cfg struct{ Defaults map[string]any }
	if b, err := os.ReadFile(c.cfg.SessionProfiles); err == nil && toml.Unmarshal(b, &cfg) == nil {
		profile, _ := cfg.Defaults[kind+"_profile"].(string)
		return profile
	}
	return ""
}
