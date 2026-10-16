package main

// The local-engine sidecar manager in isolation (the sidecar is the e2e stub,
// so no sherpa-onnx is needed).
//
// Ways it could fail, written before the test:
//  1. The idle timer is never scheduled, or it stops the sidecar while a
//     session is still active.
//  2. A session starting right after the timer fires is broken.
//  3. HERDR_DASH_STT parses to the wrong engine or idle duration.
import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestSTTConfigFromEnv(t *testing.T) {
	for _, c := range []struct {
		val   string
		local bool
	}{{"", false}, {"local", true}, {"off", false}, {"nonsense", false}} {
		t.Setenv("HERDR_DASH_STT", c.val)
		t.Setenv("HERDR_DASH_STT_IDLE", "")
		cfg := sttConfigFromEnv()
		if cfg.Local() != c.local {
			t.Errorf("HERDR_DASH_STT=%q: local %v", c.val, cfg.Local())
		}
	}
	t.Setenv("HERDR_DASH_STT", "local")
	t.Setenv("HERDR_DASH_STT_IDLE", "90s")
	if got := sttConfigFromEnv(); got.Idle != 90*time.Second {
		t.Errorf("idle %v, want 90s", got.Idle)
	}
}

func TestSTTIdleShutdown(t *testing.T) {
	s := NewSTT(STTConfig{Engine: "local", Idle: 100 * time.Millisecond, Cmd: "node e2e/stubs/stt-sidecar.mjs"})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.acquire(ctx); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	s.mu.Lock()
	first := s.cmd
	s.mu.Unlock()
	if first == nil {
		t.Fatal("no sidecar after acquire")
	}
	// A second session keeps the sidecar alive and resets the idle timer.
	time.Sleep(80 * time.Millisecond)
	if err := s.acquire(ctx); err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	s.release()
	s.release()
	time.Sleep(50 * time.Millisecond)
	s.mu.Lock()
	alive := s.cmd == first && s.n == 0
	s.mu.Unlock()
	if !alive {
		t.Fatal("sidecar stopped while sessions were still open")
	}
	// After the idle window with no sessions the sidecar must be gone.
	time.Sleep(400 * time.Millisecond)
	s.mu.Lock()
	alive = s.cmd == first
	s.mu.Unlock()
	if alive {
		t.Fatal("sidecar still running after the idle window")
	}
}

func TestSTTSidecarArgs(t *testing.T) {
	s := NewSTT(STTConfig{Engine: "local", Cmd: "node e2e/stubs/stt-sidecar.mjs", Threads: 3})
	argv, err := s.sidecarArgs(9999)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"node", "e2e/stubs/stt-sidecar.mjs", "--port=9999"}
	if len(argv) != len(want) || argv[2] != want[2] {
		t.Errorf("argv %v, want %v", argv, want)
	}
	// The real sidecar is wrapped in a systemd scope when one is reachable;
	// the flags the wrap adds are what keeps the decode within its budget.
	_, sherpaErr := exec.LookPath("sherpa-onnx-online-websocket-server")
	if systemdRunWorks("systemd-run") && sherpaErr == nil {
		s2 := NewSTT(STTConfig{Engine: "local", Dir: "/nonexistent", Threads: 2})
		argv2, err := s2.sidecarArgs(1)
		if err != nil {
			return // no sherpa binary on PATH: nothing to assert
		}
		if argv2[0] != "systemd-run" || argv2[1] != "--user" || argv2[2] != "--scope" {
			t.Errorf("systemd wrap missing: %v", argv2[:3])
		}
		if argv2[len(argv2)-1] != "--port=1" {
			t.Errorf("port arg lost in the wrap: %v", argv2)
		}
	}
}
