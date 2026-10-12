.PHONY: build vet test e2e check install demo screenshots clean stt-install

build:
	go build -o bin/herdr-dash .

vet:
	go vet ./...
	node --check static/app.js
	node --check static/search.js
	node --check static/scrollback.js
	node --check static/usage.js
	node --check static/voice.js
	node --check static/prompts.js

test:
	go test ./...

e2e/node_modules: e2e/package.json
	cd e2e && npm install --no-audit --no-fund
	touch e2e/node_modules

e2e: build e2e/node_modules
	cd e2e && npm test

# Local gate (AGENTS.md): vet + parser tests + E2E against fixtures with stubbed herdr/gh.
check: vet test e2e

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

# Local voice engine: the sherpa-onnx streaming server (Apache-2.0) on PATH.
# Model weights are fetched on first use into ~/.local/share/herdr-dash/stt/
# (NVIDIA Open Model License; the fetch prints the notice). CPU only.
stt-install:
	set -e; \
	url=$$(curl -s https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/latest | grep -o 'https://[^"]*sherpa-onnx-v[^"]*linux-x64-shared.tar.bz2' | head -1); \
	curl -sL "$$url" | tar xj -C /tmp; \
	install -m 755 /tmp/sherpa-onnx-*-linux-x64-shared/bin/sherpa-onnx-online-websocket-server $(HOME)/.local/bin/; \
	install -m 644 /tmp/sherpa-onnx-*-linux-x64-shared/lib/libonnxruntime.so* $(HOME)/.local/lib/ 2>/dev/null || true; \
	echo 'sherpa-onnx installed. Enable with HERDR_DASH_STT=local; the model downloads on first use.'

clean:
	rm -rf bin e2e/artifacts
