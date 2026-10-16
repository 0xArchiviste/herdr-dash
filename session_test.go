package main

// Failure cases: stale model/effort/window after a turn switch; cumulative
// usage mistaken for capacity; malformed/truncated records; synthetic Claude
// responses; provider guessed from a model name; missing session data.
import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSessionEvents(t *testing.T) {
	tests := []struct {
		agent, events, model, effort, provider string
		window                                 int64
	}{
		{"codex", `{"type":"session_meta","payload":{"model_provider":"gateway"}}
{"type":"turn_context","payload":{"model":"one","effort":"high"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":200000,"total_token_usage":{"total_tokens":900000}}}}
{"type":"turn_context","payload":{"model":"two","effort":"low"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":475000}}}
{broken`, "two", "low", "gateway", 475000},
		{"codex", `{"type":"turn_context","payload":{"model":"one","effort":"high"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":200000}}}
{"type":"turn_context","payload":{"model":"two"}}`, "two", "", "", 0},
		{"claude", `{"type":"assistant","message":{"model":"claude-example","usage":{"input_tokens":20,"output_tokens":800000}}}
{"type":"assistant","message":{"model":"<synthetic>"}}`, "claude-example", "", "", 0},
		{"claude", `{"type":"assistant","effort":"high","perTurnEffort":"max","message":{"model":"claude-live"}}
{"type":"assistant","effort":"low","message":{"model":"<synthetic>"}}`, "claude-live", "max", "", 0},
		{"claude", `{"type":"assistant","effort":"high","message":{"model":"claude-live"}}
{"type":"assistant","message":{"model":"claude-new"}}`, "claude-new", "", "", 0},
		{"codex", `{"type":"event_msg","payload":{"type":"token_count","info":null}}`, "", "", "", 0},
	}
	for _, tt := range tests {
		t.Run(tt.agent+tt.model, func(t *testing.T) {
			got := parseSessionEvents(strings.NewReader(tt.events), tt.agent)
			if got.Model.Value != tt.model || got.Effort.Value != tt.effort || got.Provider.Value != tt.provider || got.ContextWindow.Tokens != tt.window {
				t.Fatalf("unexpected details: %+v", got)
			}
		})
	}
}

func TestConfiguredSessionFallbacks(t *testing.T) {
	dir := t.TempDir()
	profiles := filepath.Join(dir, "profiles.toml")
	os.WriteFile(profiles, []byte("[profiles.pinned]\nagent='codex'\nmodel='pinned'\n[defaults]\nthread_profile='pinned'\n"), 0600)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("model='default-model'\nmodel_provider='local'\nmodel_reasoning_effort='high'\nmodel_context_window=100000\n"), 0600)
	c := NewCollector(Config{SessionProfiles: profiles, CodexDir: filepath.Join(dir, "sessions")})
	d := c.sessionDetails(Pane{}, "codex", "pinned")
	if d.Model.Value != "pinned" || d.Model.Source != "profile" || d.Provider.Value != "local" || d.Effort.Value != "high" || d.ContextWindow.Tokens != 0 {
		t.Fatalf("fallback mixed incompatible model settings: %+v", d)
	}
	d = c.sessionDetails(Pane{}, "codex", "")
	if d.Model.Value != "default-model" || d.Model.Source != "config" || d.ContextWindow.Tokens != 100000 {
		t.Fatalf("missing config fallback: %+v", d)
	}
	if c.projectProfile("missing", "thread") != "pinned" {
		t.Fatal("global default profile was lost")
	}
}
