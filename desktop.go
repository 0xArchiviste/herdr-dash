//go:build desktop

// The desktop app: the same dashboard in a native window (Wails v2 on the
// system webview: WebKitGTK, WebView2, WKWebView). It either embeds the
// server on a random loopback port or connects to a running Dash, and warms
// the local voice model at startup so the first voice use is instant.
// Build with `make desktop-linux`, `make desktop-windows` or
// `make desktop-darwin`; the plain `go build` is the server alone.
package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	goruntime "runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed desktop/splash
var splashFS embed.FS

const (
	desktopTitle  = "Herdr Dash"
	desktopProbe  = "http://127.0.0.1:8791" // where the service listens by default (WSL forwards it to Windows)
	warmEvery     = time.Minute
	desktopAppID  = "io.github.0xarchiviste.herdr-dash"
	connectRetry  = 3 * time.Second
	statusTimeout = 2 * time.Second
)

// DesktopApp is bound to the splash page (window.go.main.DesktopApp).
type DesktopApp struct {
	opts      *serverOpts
	connect   string // "auto", "embed" or a Dash URL
	probe     string
	addrSet   bool // --addr given: embed there instead of a random port
	warmVoice bool
	checkMic  bool

	ctx    context.Context // Wails context
	cancel context.CancelFunc
	served chan struct{} // closed when the embedded server stopped
	client *http.Client

	mu        sync.Mutex
	url       string // the dashboard, once reachable
	message   string
	voice     sttStatus
	voiceSaid string // the last voice state logged
	loaded    sync.Once
}

// SplashStatus is what the splash page shows while the app starts.
type SplashStatus struct {
	URL     string    `json:"url"`
	Message string    `json:"message"`
	Voice   sttStatus `json:"voice"`
}

// Status is called by the splash page until a URL is known.
func (a *DesktopApp) Status() SplashStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	return SplashStatus{URL: a.url, Message: a.message, Voice: a.voice}
}

func (a *DesktopApp) say(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	a.mu.Lock()
	a.message = msg
	a.mu.Unlock()
	log.Printf("desktop: %s", msg)
}

func main() {
	o := defineServerFlags()
	a := &DesktopApp{opts: o, served: make(chan struct{}), client: &http.Client{Timeout: statusTimeout}}
	flag.StringVar(&a.connect, "connect", env("HERDR_DASH_CONNECT", "auto"), "desktop: \"auto\" (use the Dash at --probe if it answers, else embed one), \"embed\", or a Dash URL to show, $HERDR_DASH_CONNECT")
	flag.StringVar(&a.probe, "probe", desktopProbe, "desktop: the Dash that auto mode tries first")
	hidden := flag.Bool("hidden", false, "desktop: start with the window hidden")
	noWarm := flag.Bool("no-voice-warm", false, "desktop: do not load the local voice model at startup")
	flag.BoolVar(&a.checkMic, "check-mic", false, "desktop: once the dashboard loads, ask for the microphone and log the result (embedded mode)")
	flag.Parse()
	a.warmVoice = !*noWarm
	flag.Visit(func(f *flag.Flag) { a.addrSet = a.addrSet || f.Name == "addr" })
	if o.sttFetch {
		if err := o.fetchSTT(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := o.finish(); err != nil {
		log.Fatal(err)
	}
	if a.connect != "auto" && a.connect != "embed" {
		u, err := url.Parse(a.connect)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			log.Fatalf("--connect %q: want auto, embed or an http(s) URL", a.connect)
		}
		a.connect = strings.TrimRight(a.connect, "/")
	}
	a.probe = strings.TrimRight(a.probe, "/")
	a.message = "Starting…"

	splash, _ := fs.Sub(splashFS, "desktop/splash")
	err := wails.Run(&options.App{
		Title:              desktopTitle,
		Width:              1280,
		Height:             800,
		MinWidth:           420,
		MinHeight:          360,
		StartHidden:        *hidden,
		BackgroundColour:   &options.RGBA{R: 0x15, G: 0x15, B: 0x15, A: 255},
		AssetServer:        &assetserver.Options{Assets: splash},
		Menu:               a.menu(),
		Bind:               []any{a},
		OnStartup:          a.startup,
		OnShutdown:         a.shutdown,
		LogLevel:           logger.WARNING,
		LogLevelProduction: logger.ERROR,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: desktopAppID,
			OnSecondInstanceLaunch: func(options.SecondInstanceData) {
				log.Printf("desktop: second instance started; showing this window instead")
				if a.ctx != nil {
					wruntime.WindowUnminimise(a.ctx)
					wruntime.WindowShow(a.ctx)
				}
			},
		},
		Linux: &linux.Options{ProgramName: "herdr-dash", WebviewGpuPolicy: linux.WebviewGpuPolicyOnDemand},
		Mac: &mac.Options{About: &mac.AboutInfo{Title: desktopTitle, Message: "Progress across herdr projects and threads."}},
	})
	if err != nil {
		log.Fatal(err)
	}
}

// startup runs once the single-instance check passed and the window exists.
func (a *DesktopApp) startup(ctx context.Context) {
	a.ctx = ctx
	var appCtx context.Context
	appCtx, a.cancel = context.WithCancel(context.Background())
	// SIGTERM and Ctrl-C close the app like Quit, so the server and the
	// model sidecar stop with it.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		wruntime.Quit(ctx)
	}()
	go a.boot(appCtx)
}

func (a *DesktopApp) shutdown(context.Context) {
	if a.cancel != nil {
		a.cancel()
	}
	select {
	case <-a.served:
	case <-time.After(5 * time.Second):
	}
}

// boot finds or starts the Dash, shows it, then keeps the voice model warm.
func (a *DesktopApp) boot(ctx context.Context) {
	dash := ""
	switch a.connect {
	case "embed":
	case "auto":
		if a.isDash(a.probe) {
			dash = a.probe
		} else if goruntime.GOOS == "windows" {
			// herdr runs in WSL: start its Dash service there and use it.
			a.say("No Dash at %s; starting the herdr-dash service in WSL…", a.probe)
			if err := startWSLService(); err != nil {
				a.say("Could not start the WSL service (%v). Start it in WSL with: systemctl --user start herdr-dash", err)
			}
			dash = a.waitDash(ctx, a.probe)
		}
	default:
		dash = a.waitDash(ctx, a.connect)
	}
	if ctx.Err() != nil {
		return
	}
	if dash == "" {
		u, err := a.embed(ctx)
		if err != nil {
			a.say("Embedded server failed: %v", err)
			close(a.served)
			return
		}
		dash = u
		a.say("embedded server on %s", dash)
	} else {
		close(a.served)
		a.say("connected to %s", dash)
	}
	enableMic(dash + "/")
	a.mu.Lock()
	a.url = dash
	a.mu.Unlock()
	if a.warmVoice {
		a.keepVoiceWarm(ctx, dash)
	}
}

// waitDash retries until the Dash at u answers.
func (a *DesktopApp) waitDash(ctx context.Context, u string) string {
	for first := true; ; first = false {
		if a.isDash(u) {
			return u
		}
		if first {
			a.say("Waiting for the Dash at %s…", u)
		}
		select {
		case <-ctx.Done():
			return ""
		case <-time.After(connectRetry):
		}
	}
}

// isDash tells whether a herdr-dash answers at u.
func (a *DesktopApp) isDash(u string) bool {
	resp, err := a.client.Get(u + "/api/config")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var c struct {
		Voice *json.RawMessage `json:"voice"`
	}
	return resp.StatusCode == http.StatusOK && json.NewDecoder(resp.Body).Decode(&c) == nil && c.Voice != nil
}

// embed starts the server in this process on a loopback port.
func (a *DesktopApp) embed(ctx context.Context) (string, error) {
	addr := "127.0.0.1:0"
	if a.addrSet {
		addr = a.opts.addr
	}
	d, err := newDashServer(ctx, a.opts, a.watchPage)
	if err != nil {
		return "", err
	}
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}
	go func() {
		defer close(a.served)
		if err := d.serve(ctx, l); err != nil {
			log.Printf("desktop: server: %v", err)
		}
	}()
	return "http://" + l.Addr().String(), nil
}

// watchPage logs when the window's page opens its event stream (the
// webviews add "wails.io" to the user agent), and takes the microphone
// self-check's answer.
func (a *DesktopApp) watchPage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fromWindow := strings.Contains(r.UserAgent(), "wails.io")
		if fromWindow && r.URL.Path == "/__desktop/mic" {
			log.Printf("desktop: microphone check: %.80q", r.URL.Query().Get("result"))
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if fromWindow && r.URL.Path == "/api/events" {
			a.loaded.Do(func() {
				log.Printf("desktop: dashboard loaded in the window")
				if a.checkMic {
					go func() {
						time.Sleep(500 * time.Millisecond)
						wruntime.WindowExecJS(a.ctx, micCheckJS)
					}()
				}
			})
		}
		next.ServeHTTP(w, r)
	})
}

const micCheckJS = `(async () => {
  let r;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    r = "granted";
  } catch (e) { r = (navigator.mediaDevices ? "" : "no mediaDevices: ") + e.name; }
  fetch("/__desktop/mic?result=" + encodeURIComponent(r));
})();`

// keepVoiceWarm loads the voice model at startup and keeps it loaded while
// the app runs; the window title shows download progress.
func (a *DesktopApp) keepVoiceWarm(ctx context.Context, dash string) {
	var cfg struct {
		Voice struct {
			Local bool `json:"local"`
		} `json:"voice"`
	}
	if resp, err := a.client.Get(dash + "/api/config"); err == nil {
		json.NewDecoder(resp.Body).Decode(&cfg)
		resp.Body.Close()
	}
	if !cfg.Voice.Local {
		log.Printf("desktop: the Dash has no local voice engine (HERDR_DASH_STT=local); nothing to warm")
		return
	}
	lastWarm := time.Time{}
	for ctx.Err() == nil {
		if time.Since(lastWarm) >= warmEvery {
			a.warm(dash)
			lastWarm = time.Now()
		}
		st := a.voiceStatus(dash)
		wait := time.Second
		if st.State == "ready" || st.State == "error" {
			wait = 15 * time.Second
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
}

func (a *DesktopApp) warm(dash string) {
	resp, err := a.client.Post(dash+"/api/voice/warm", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		log.Printf("desktop: voice warm-up: %v", err)
		return
	}
	resp.Body.Close()
}

// voiceStatus reads the model state and shows it in the title.
func (a *DesktopApp) voiceStatus(dash string) sttStatus {
	var st sttStatus
	resp, err := a.client.Get(dash + "/api/voice/local")
	if err != nil {
		return st
	}
	json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	title := desktopTitle
	switch st.State {
	case "downloading":
		pct := ""
		if st.Total > 0 {
			pct = fmt.Sprintf(" %d%%", st.Bytes*100/st.Total)
		}
		title += " · downloading voice model" + pct + " (CC-BY-4.0, see Voice menu)"
	case "starting", "missing", "idle":
		title += " · loading voice model"
	case "error":
		title += " · voice model error (see Voice menu)"
	}
	a.mu.Lock()
	a.voice = st
	said := a.voiceSaid
	a.voiceSaid = st.State
	a.mu.Unlock()
	wruntime.WindowSetTitle(a.ctx, title)
	if said != st.State {
		switch st.State {
		case "ready":
			log.Printf("desktop: voice model ready (%s)", st.Model)
		case "downloading":
			log.Printf("desktop: downloading the voice model; %s", st.Licence)
		case "error":
			log.Printf("desktop: voice model error: %s", st.Error)
		}
	}
	return st
}

func (a *DesktopApp) dashURL() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.url
}

func (a *DesktopApp) menu() *menu.Menu {
	m := menu.NewMenu()
	if goruntime.GOOS == "darwin" {
		m.Append(menu.AppMenu())
		m.Append(menu.EditMenu())
	}
	dash := m.AddSubmenu("Dashboard")
	dash.AddText("Reload", keys.CmdOrCtrl("r"), func(*menu.CallbackData) { wruntime.WindowExecJS(a.ctx, "location.reload()") })
	dash.AddText("Open in browser", keys.CmdOrCtrl("b"), func(*menu.CallbackData) {
		if u := a.dashURL(); u != "" {
			wruntime.BrowserOpenURL(a.ctx, u)
		}
	})
	dash.AddSeparator()
	dash.AddText("Quit", keys.CmdOrCtrl("q"), func(*menu.CallbackData) { wruntime.Quit(a.ctx) })
	voice := m.AddSubmenu("Voice")
	voice.AddText("Load the model now", nil, func(*menu.CallbackData) {
		if u := a.dashURL(); u != "" {
			go a.warm(u)
		}
	})
	voice.AddText("Model status and licence…", nil, func(*menu.CallbackData) {
		go a.showVoiceStatus()
	})
	return m
}

func (a *DesktopApp) showVoiceStatus() {
	u := a.dashURL()
	if u == "" {
		return
	}
	st := a.voiceStatus(u)
	msg := "State: " + st.State
	switch {
	case st.State == "off":
		msg = "The local voice engine is off on this Dash (set HERDR_DASH_STT=local)."
	case st.State == "downloading" && st.Total > 0:
		msg += fmt.Sprintf(" (%d of %d MB)", st.Bytes>>20, st.Total>>20)
	case st.Error != "":
		msg += "\n" + st.Error
	}
	if st.Model != "" {
		msg += "\n\nModel: " + st.Model + "\n" + st.Licence
	}
	wruntime.MessageDialog(a.ctx, wruntime.MessageDialogOptions{Type: wruntime.InfoDialog, Title: "Voice model", Message: msg})
}

var errNotWindows = errors.New("only on Windows")
