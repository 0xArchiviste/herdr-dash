.PHONY: build vet test e2e check install demo screenshots clean stt-install stt-fetch stt-check desktop-linux desktop-windows desktop-darwin desktop-smoke install-desktop

build:
	go build -o bin/herdr-dash .

vet:
	go vet ./...
	GOOS=windows go vet -tags desktop,production .
	node --check static/app.js
	node --check static/search.js
	node --check static/scrollback.js
	node --check static/usage.js
	node --check static/voice.js
	node --check static/voice-stream.js
	python3 -c "import ast, pathlib; ast.parse(pathlib.Path('voice/local_server.py').read_text())"
	node --check static/prompts.js
	node --check static/windows.js
	node --check static/threadwin.js

test:
	go test ./...

e2e/node_modules: e2e/package.json
	cd e2e && npm install --no-audit --no-fund
	touch e2e/node_modules

e2e: build e2e/node_modules
	cd e2e && npm test

# Local gate (AGENTS.md): vet + parser tests + E2E against fixtures with stubbed herdr/gh,
# then the desktop build in a virtual X display.
check: vet test e2e desktop-smoke

# Desktop app (Wails v2, see docs/desktop.md). The plain build above stays the
# server alone; the desktop build adds a native window to the same code.
DESKTOP_TAGS = desktop,production
DESKTOP_LDFLAGS = -s -w

# Linux: needs cgo with GTK 3 and WebKitGTK 4.1 headers (libgtk-3-dev, libwebkit2gtk-4.1-dev).
desktop-linux:
	CGO_ENABLED=1 go build -tags $(DESKTOP_TAGS),webkit2_41 -trimpath -ldflags "$(DESKTOP_LDFLAGS)" -o bin/herdr-dash-desktop .

# Windows: pure Go (WebView2), cross-compiles from any OS. The resource file
# adds the icon, DPI awareness and common controls manifest.
desktop-windows:
	go run github.com/tc-hib/go-winres@v0.3.3 make --in deploy/desktop/windows/winres.json --out rsrc --arch amd64
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -tags $(DESKTOP_TAGS) -trimpath -ldflags "$(DESKTOP_LDFLAGS) -H windowsgui" -o bin/herdr-dash-desktop.exe .
	rm -f rsrc_windows_amd64.syso

# macOS: run on a Mac with Xcode command line tools; builds an ad-hoc signed
# bin/Herdr Dash.app for the host architecture (see docs/desktop.md for
# Developer ID signing and notarisation).
DARWIN_APP = bin/Herdr Dash.app
desktop-darwin:
	CGO_ENABLED=1 go build -tags $(DESKTOP_TAGS) -trimpath -ldflags "$(DESKTOP_LDFLAGS)" -o bin/herdr-dash-desktop-darwin .
	rm -rf "$(DARWIN_APP)"
	mkdir -p "$(DARWIN_APP)/Contents/MacOS" "$(DARWIN_APP)/Contents/Resources"
	cp deploy/desktop/darwin/Info.plist "$(DARWIN_APP)/Contents/Info.plist"
	cp bin/herdr-dash-desktop-darwin "$(DARWIN_APP)/Contents/MacOS/herdr-dash-desktop"
	codesign --force --sign - "$(DARWIN_APP)"

# Smoke test of the Linux desktop build in Xvfb with a private D-Bus session.
desktop-smoke: desktop-linux build e2e/node_modules
	cd e2e && xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- node --test --test-concurrency=1 desktop.test.mjs

# Install the Linux desktop app for this user (binary, launcher, icon).
install-desktop: desktop-linux
	mkdir -p $(HOME)/.local/bin $(HOME)/.local/share/applications $(HOME)/.local/share/icons/hicolor/256x256/apps
	install -m 755 bin/herdr-dash-desktop $(HOME)/.local/bin/herdr-dash-desktop
	install -m 644 deploy/desktop/linux/herdr-dash.desktop $(HOME)/.local/share/applications/herdr-dash.desktop
	install -m 644 deploy/desktop/icon.png $(HOME)/.local/share/icons/hicolor/256x256/apps/herdr-dash.png

# Try it on fictional data: http://127.0.0.1:8792 (DEMO_ADDR to change).
DEMO_ADDR ?= 127.0.0.1:8792
demo: build
	demo/run.sh $(DEMO_ADDR)

# Retake docs/screenshots/ from the demo (needs ffmpeg for the WebP).
screenshots: build e2e/node_modules
	demo/screenshots.sh

# Build and (re)start the systemd --user service.
install: build
	mkdir -p $(HOME)/.local/bin $(HOME)/.config/systemd/user
	install -m 755 bin/herdr-dash $(HOME)/.local/bin/herdr-dash
	cp deploy/herdr-dash.service $(HOME)/.config/systemd/user/herdr-dash.service
	systemctl --user daemon-reload
	systemctl --user enable herdr-dash.service
	systemctl --user restart herdr-dash.service

# Pinned CPU runtime; NVIDIA Parakeet TDT v3 weights remain outside the repo.
stt-install:
	./voice/install.sh

stt-fetch: build
	bin/herdr-dash --stt-fetch

# Supply HERDR_DASH_STT_FIXTURE with a mono WAV of the sentence in this test.
stt-check: build e2e/node_modules
	node --test e2e/voice-real.test.mjs

clean:
	rm -rf bin e2e/artifacts
