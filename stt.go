package main

// Local speech-to-text: engine `local` (HERDR_DASH_STT=local). A sidecar
// manager starts the model server (sherpa-onnx Python adapter with
// NVIDIA Parakeet TDT 0.6B v3 (int8, utterance buffering))
// on the first voice session and kills it after about two idle minutes, so
// idle cost is zero. Sessions are proxied: the page sends 16 kHz mono float32
// over its WebSocket, the manager relays it to the sidecar and translates the
// sidecar's partial and final results back as small JSON messages.
//
// There is no fallback: when local is selected but cannot run, the error is
// reported to the page instead of quietly switching engines.
//
// Every model process runs under systemd-run with MemoryMax=2G and
// CPUQuota=200% when a user systemd is available (WSL froze under load
// before). Model weights are fetched at first use into
// ~/.local/share/herdr-dash/stt/ and are never committed to the repo.

import (
	"archive/tar"
	"compress/bzip2"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	sttStreamPath    = "/api/voice/stream"
	sttIdleDefault   = 2 * time.Minute
	sttStartTimeout  = 30 * time.Second
	sttModelURL      = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2"
	sttModelSHA256   = "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf"
	sttModelDir      = "parakeet-tdt-0.6b-v3-int8-5793d0fd"
	sttLicenceNotice = "NVIDIA Parakeet TDT 0.6B v3 weights, ONNX conversion by k2-fsa: CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/); runtime sherpa-onnx, Apache-2.0. No weights are stored in the herdr-dash repository."
)

//go:embed voice/local_server.py
var localSTTServer string

// STTConfig holds the local-engine settings, read from the environment only.
type STTConfig struct {
	Engine  string        // HERDR_DASH_STT: "local" enables the local engine
	Dir     string        // HERDR_DASH_STT_DIR, default ~/.local/share/herdr-dash/stt
	Idle    time.Duration // HERDR_DASH_STT_IDLE, default 2m
	Cmd     string        // HERDR_DASH_STT_SERVER_CMD, replaces the sidecar command (tests)
	Threads int           // HERDR_DASH_STT_THREADS: work threads for the decoder
}

func sttConfigFromEnv() STTConfig {
	home, _ := os.UserHomeDir()
	cfg := STTConfig{
		Engine:  env("HERDR_DASH_STT", ""),
		Dir:     env("HERDR_DASH_STT_DIR", filepath.Join(home, ".local", "share", "herdr-dash", "stt")),
		Cmd:     env("HERDR_DASH_STT_SERVER_CMD", ""),
		Threads: 2,
	}
	if s := env("HERDR_DASH_STT_IDLE", ""); s != "" {
		if d, err := time.ParseDuration(s); err == nil && d > 0 {
			cfg.Idle = d
		}
	}
	if s := env("HERDR_DASH_STT_THREADS", ""); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n >= 1 && n <= 8 {
			cfg.Threads = n
		}
	}
	return cfg
}

func (c STTConfig) Local() bool { return c.Engine == "local" }

// STT manages the local speech-to-text sidecar.
type STT struct {
	cfg     STTConfig
	startMu sync.Mutex // serialize startup, acquisition and idle shutdown
	mu      sync.Mutex
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	port    int
	n       int // active streams
	timer   *time.Timer
	started time.Time
}

func NewSTT(cfg STTConfig) *STT { return &STT{cfg: cfg} }

// sidecarArgs builds the sidecar command line. The env override (tests,
// custom installs) replaces it whole.
func (s *STT) sidecarArgs(port int) ([]string, error) {
	if s.cfg.Cmd != "" {
		return append(strings.Fields(s.cfg.Cmd), "--port="+strconv.Itoa(port)), nil
	}
	home, _ := os.UserHomeDir()
	bin := env("HERDR_DASH_STT_PYTHON", filepath.Join(home, ".local", "share", "herdr-dash", "stt-runtime", "bin", "python"))
	if _, err := exec.LookPath(bin); err != nil {
		return nil, fail(http.StatusNotImplemented, "local engine: Python runtime missing (run make stt-install)")
	}
	args := []string{bin, "-c", localSTTServer, "--model-dir=" + filepath.Join(s.cfg.Dir, sttModelDir),
		"--threads=" + strconv.Itoa(s.cfg.Threads), "--port=" + strconv.Itoa(port)}
	if bin, err := exec.LookPath("systemd-run"); err == nil && systemdRunWorks(bin) {
		return append([]string{"systemd-run", "--user", "--scope", "-q", "--unit=herdr-dash-stt-" + strconv.Itoa(os.Getpid()) + "-" + strconv.Itoa(port),
			"-p", "MemoryMax=2G", "-p", "CPUQuota=200%"}, args...), nil
	}
	return args, nil
}

// systemdRunWorks checks that a user systemd is reachable; without one the
// scope would fail to start.
func systemdRunWorks(bin string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "systemctl", "--user", "show-environment").Run() == nil
}

// fetchModel downloads the chosen model when it is missing.
func (s *STT) fetchModel(ctx context.Context) error {
	if s.modelPresent() {
		return nil
	}
	if err := os.MkdirAll(s.cfg.Dir, 0o755); err != nil {
		return err
	}
	log.Printf("local engine: fetching model into %s; %s", s.cfg.Dir, sttLicenceNotice)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sttModelURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fail(http.StatusBadGateway, "local engine: model fetch failed: %s", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fail(http.StatusBadGateway, "local engine: model fetch failed: HTTP %d", resp.StatusCode)
	}
	// Stage the complete, verified archive before publishing any model files.
	stage, err := os.MkdirTemp(s.cfg.Dir, ".parakeet-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	archive, err := os.CreateTemp(s.cfg.Dir, ".download-")
	if err != nil {
		return err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	hash := sha256.New()
	if _, err = io.Copy(io.MultiWriter(archive, hash), io.LimitReader(resp.Body, 600<<20)); err != nil {
		return err
	}
	if fmt.Sprintf("%x", hash.Sum(nil)) != sttModelSHA256 {
		return fmt.Errorf("Parakeet model checksum mismatch; download rejected")
	}
	if _, err = archive.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err = untarBz2(archive, stage); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(stage, "SHA256"), []byte(sttModelSHA256), 0644); err != nil {
		return err
	}
	dest := filepath.Join(s.cfg.Dir, sttModelDir)
	// A previous incomplete installation is never considered usable.
	if err = os.RemoveAll(dest); err != nil {
		return err
	}
	return os.Rename(stage, dest)
}

func (s *STT) modelPresent() bool {
	dir := filepath.Join(s.cfg.Dir, sttModelDir)
	marker, err := os.ReadFile(filepath.Join(dir, "SHA256"))
	if err != nil || string(marker) != sttModelSHA256 {
		return false
	}
	for _, f := range []string{"tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"} {
		if info, err := os.Stat(filepath.Join(dir, f)); err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return false
		}
	}
	return true
}

// untarBz2 extracts the model files of the release tar.bz2 archive.
func untarBz2(r io.Reader, dir string) error {
	want := map[string]bool{"tokens.txt": true, "encoder.int8.onnx": true, "decoder.int8.onnx": true, "joiner.int8.onnx": true}
	tr := tar.NewReader(bzip2.NewReader(r))
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.FileInfo().IsDir() || !want[filepath.Base(hdr.Name)] {
			continue
		}
		out, err := os.Create(filepath.Join(dir, filepath.Base(hdr.Name)))
		if err != nil {
			return err
		}
		_, err = io.Copy(out, tr)
		out.Close()
		if err != nil {
			return err
		}
		delete(want, filepath.Base(hdr.Name))
	}
	if len(want) > 0 {
		return fmt.Errorf("model archive is missing %v", keysOf(want))
	}
	return nil
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// start brings the sidecar up and waits for it to accept connections.
func (s *STT) start(ctx context.Context) error {
	s.mu.Lock()
	if s.cmd != nil {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	if s.cfg.Cmd == "" && !s.modelPresent() {
		fetchCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		ferr := s.fetchModel(fetchCtx)
		cancel()
		if ferr != nil || !s.modelPresent() {
			if ferr == nil {
				ferr = fail(http.StatusServiceUnavailable, "local engine: model not installed (run make stt-fetch)")
			}
			return ferr
		}
	}
	port, err := freePort()
	if err != nil {
		return err
	}
	argv, err := s.sidecarArgs(port)
	if err != nil {
		return err
	}
	cctx, contextCancel := context.WithCancel(context.Background())
	cancel := func() {
		// Killing only the systemd-run client would orphan its scoped model.
		if argv[0] == "systemd-run" {
			for _, arg := range argv {
				if strings.HasPrefix(arg, "--unit=") {
					stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Second)
					exec.CommandContext(stopCtx, "systemctl", "--user", "stop", strings.TrimPrefix(arg, "--unit=")+".scope").Run()
					stopCancel()
				}
			}
		}
		contextCancel()
	}
	s.mu.Lock()
	s.port = port
	s.mu.Unlock()
	cmd := exec.CommandContext(cctx, argv[0], argv[1:]...)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		cancel()
		return fail(http.StatusBadGateway, "local engine: %s", err)
	}
	s.mu.Lock()
	s.cmd, s.cancel, s.started = cmd, cancel, time.Now()
	s.mu.Unlock()
	go func() {
		err := cmd.Wait()
		s.mu.Lock()
		if s.cmd == cmd {
			s.cmd = nil
		}
		s.mu.Unlock()
		if err != nil && ctx.Err() == nil {
			log.Printf("local engine: sidecar exited: %v", err)
		}
	}()
	deadline := time.Now().Add(sttStartTimeout)
	for {
		if ctx.Err() != nil {
			cancel()
			return ctx.Err()
		}
		s.mu.Lock()
		alive := s.cmd == cmd
		s.mu.Unlock()
		if !alive {
			return fail(http.StatusBadGateway, "local engine exited during startup; check server log")
		}
		if time.Now().After(deadline) {
			cancel()
			return fail(http.StatusBadGateway, "local engine did not start within %s", sttStartTimeout)
		}
		c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 250*time.Millisecond)
		if err == nil {
			c.Close()
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// stopSidecar kills the sidecar process.
func (s *STT) stopSidecar(why string) {
	s.mu.Lock()
	cmd, started, cancel := s.cmd, s.started, s.cancel
	s.cmd = nil
	s.mu.Unlock()
	if cmd == nil {
		return
	}
	log.Printf("local engine: stopping sidecar (%s) after %s", why, time.Since(started).Round(time.Second))
	cancel()
}

func (s *STT) acquire(ctx context.Context) error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	if err := s.start(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	s.n++
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.mu.Unlock()
	return nil
}

func (s *STT) release() {
	s.mu.Lock()
	s.n--
	if s.n > 0 {
		s.mu.Unlock()
		return
	}
	idle := s.cfg.Idle
	if idle <= 0 {
		idle = sttIdleDefault
	}
	s.timer = time.AfterFunc(idle, func() {
		s.startMu.Lock()
		defer s.startMu.Unlock()
		if s.count() == 0 {
			s.stopSidecar("idle")
		}
	})
	s.mu.Unlock()
}

func (s *STT) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.n
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1 << 20,
	WriteBufferSize: 1 << 20,
	CheckOrigin: func(r *http.Request) bool {
		o := r.Header.Get("Origin")
		if o == "" {
			return true
		}
		u, err := url.Parse(o)
		return err == nil && u.Host == r.Host
	},
}

// stream handles one page voice session: proxy audio to the sidecar and its
// results back as small JSON messages.
func (s *STT) stream(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Local() {
		jsonError(w, http.StatusNotImplemented, "local speech-to-text is not enabled (set HERDR_DASH_STT=local)")
		return
	}
	page, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer page.Close()
	page.SetReadLimit(1 << 20)
	if err := s.acquire(r.Context()); err != nil {
		log.Printf("local engine startup failed: %v", err)
		var he httpErr
		msg := "local speech-to-text unavailable"
		if errors.As(err, &he) {
			msg = he.msg
		}
		page.WriteMessage(websocket.TextMessage, []byte(`{"error":`+jsonString(msg)+`}`))
		return
	}
	defer s.release()

	c, _, err := websocket.DefaultDialer.Dial("ws://127.0.0.1:"+strconv.Itoa(s.port), nil)
	if err != nil {
		page.WriteMessage(websocket.TextMessage, []byte(`{"error":`+jsonString("local engine: connection to the model failed")+`}`))
		return
	}
	defer c.Close()
	if err := page.WriteJSON(map[string]bool{"ready": true}); err != nil {
		return
	}

	go func() { // page -> sidecar, until the page goes away
		for {
			mt, data, err := page.ReadMessage()
			if err != nil {
				c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
				return
			}
			if err := c.WriteMessage(mt, data); err != nil {
				return
			}
		}
	}()
	finals := map[int]bool{}
	for { // sidecar -> page
		mt, data, err := c.ReadMessage()
		if err != nil {
			page.WriteMessage(websocket.TextMessage, []byte(`{"error":`+jsonString("speech engine stopped")+`}`))
			return
		}
		if mt != websocket.TextMessage {
			continue
		}
		msg := string(data)
		if msg == "Done!" {
			page.WriteMessage(websocket.TextMessage, []byte(`{"eof":true}`))
			return
		}
		var res struct {
			Text    string `json:"text"`
			Segment int    `json:"segment"`
			IsFinal bool   `json:"is_final"`
			IsEOF   bool   `json:"is_eof"`
		}
		if err := json.Unmarshal(data, &res); err != nil {
			continue
		}
		final := res.IsFinal || res.IsEOF
		if final {
			if finals[res.Segment] {
				res.Text = ""
			} else {
				finals[res.Segment] = true
			}
		}
		out, _ := json.Marshal(map[string]any{
			"interim": !res.IsFinal && !res.IsEOF,
			"final":   res.IsFinal || res.IsEOF,
			"text":    res.Text,
			"eof":     res.IsEOF,
		})
		if err := page.WriteMessage(websocket.TextMessage, out); err != nil {
			return
		}
		if res.IsEOF {
			return
		}
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// jsonError answers an HTTP request that cannot be upgraded with a JSON error.
func jsonError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(actionResult{Error: msg})
}

// register wires the streaming endpoint.
func (s *STT) register(mux *http.ServeMux) {
	mux.HandleFunc("GET "+sttStreamPath, s.stream)
}
