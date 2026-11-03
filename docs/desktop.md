# Desktop app

`herdr-dash-desktop` shows the same dashboard in a native window and loads the
local voice model when it starts, so the first voice command does not wait.
It is the server code plus a [Wails v2](https://wails.io) shell on the
system webview: WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS.
The web dashboard and the `herdr-dash` service are unchanged. The plain
`go build` still produces only the server.

## Modes

| `--connect` | What the app does |
| --- | --- |
| `auto` (default) | Uses the Dash at `--probe` (default `http://127.0.0.1:8791`, the service's address) when one answers; otherwise it embeds a server on a random loopback port. On Windows it does not embed. It runs `wsl.exe -e systemctl --user start herdr-dash.service` and waits for the service. |
| `embed` | Always runs the server inside the app on loopback. `--addr` picks the port. Every server flag (`--root`, `--herdr`, …) and `HERDR_DASH_*` variable applies. |
| a URL | Shows that Dash, e.g. a tailnet HTTPS address. |

**Windows with herdr in WSL.** herdr, its projects and the voice sidecar
live in WSL, so the server must run there too. WSL2 forwards loopback ports to
Windows (`localhostForwarding`, on by default), so the Windows app reaches the
WSL service at `http://127.0.0.1:8791`. Browsers and webviews treat loopback
as a secure origin, so the microphone works without HTTPS.

Other flags: `--hidden` starts without showing the window; `--no-voice-warm`
skips the voice warm-up; `--check-mic` logs whether the webview may open the
microphone (embedded mode only).

The window has a menu (Dashboard: Reload, Open in browser, Quit; Voice: Load
the model now, Model status and licence). Only one instance runs: a second
launch brings the first window forward and exits. Wails v2 has no tray icon.

## Voice at startup

Once the dashboard is reachable, the app calls `POST /api/voice/warm` on it
and repeats the call every minute while it runs. A warm call downloads and
verifies the model if it is missing, then starts the sidecar. The sidecar
stays loaded for `HERDR_DASH_STT_WARM_HOLD` (default 3m) after the last warm
call, and then the usual idle stop applies. Closing the app frees the model
within about four minutes, or at once in embedded mode. The sidecar keeps its
limits: `MemoryMax=2G` and `CPUQuota=200%` under systemd. There is no cloud
fallback.

`GET /api/voice/local` reports the state: `off`, `missing`, `idle`,
`downloading` (with `bytes`/`total`), `starting`, `ready` or `error`. The
window title shows download progress. The licence notice (CC-BY-4.0 weights,
Apache-2.0 runtime) is logged when a download starts, and the Voice menu
shows it.

The server needs the local engine set up as before: `make stt-install`,
then `HERDR_DASH_STT=local`. See [local-voice.md](local-voice.md). In connect
mode that applies to the Dash the app connects to.

## Microphone permission

- **Linux (WebKitGTK):** media streams are off by default and Wails grants
  nothing, so the app turns them on. It allows audio-only requests from the
  dashboard's own origin and denies all other requests. Capture goes through
  GStreamer (PulseAudio/PipeWire source plugins).
- **Windows (WebView2):** Wails grants webview permissions, and Windows'
  microphone privacy setting still applies.
- **macOS (WKWebView):** the bundle's `Info.plist` carries
  `NSMicrophoneUsageDescription`. macOS asks once, and the webview may ask
  per session.

## Building

```sh
make desktop-linux    # bin/herdr-dash-desktop (cgo; libgtk-3-dev, libwebkit2gtk-4.1-dev)
make desktop-windows  # bin/herdr-dash-desktop.exe (pure Go, cross-compiles; WebView2 runtime on the target)
make desktop-darwin   # on a Mac: bin/Herdr Dash.app, ad-hoc signed
make desktop-smoke    # Linux build in Xvfb: dashboard loads, voice ready, one instance, clean exit
make install-desktop  # Linux: binary, .desktop launcher and icon under ~/.local
```

`make check` includes `desktop-smoke`. It needs `xvfb-run`,
`dbus-run-session` and `ffmpeg` (for the screenshot artifact).

**macOS** cannot be cross-built from Linux: Wails needs cgo against the macOS
SDK. For distribution beyond your own machine, sign with a Developer ID
(`codesign --options runtime --sign "Developer ID Application: …"`), then
notarise (`xcrun notarytool submit … --wait`, `xcrun stapler staple`). On
macOS the voice sidecar runs without systemd limits. Install the Python
runtime with `voice/install.sh`.

**Windows** needs the WebView2 runtime, which Windows 10 and 11 normally
include. The executable is unsigned, so SmartScreen may warn on first
launch.
