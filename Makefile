.PHONY: build vet test e2e check install clean

build:
	go build -o bin/herdr-dash .

vet:
	go vet ./...
	node --check static/app.js

e2e/node_modules: e2e/package.json
	cd e2e && npm install --no-audit --no-fund
	touch e2e/node_modules

e2e: build e2e/node_modules
	cd e2e && npm test

# Local gate (AGENTS.md): vet + E2E against fixtures with stubbed herdr/gh.
check: vet e2e

# Build and (re)start the systemd --user service.
install: build
	mkdir -p $(HOME)/.local/bin $(HOME)/.config/systemd/user
	install -m 755 bin/herdr-dash $(HOME)/.local/bin/herdr-dash
	cp deploy/herdr-dash.service $(HOME)/.config/systemd/user/herdr-dash.service
	systemctl --user daemon-reload
	systemctl --user enable herdr-dash.service
	systemctl --user restart herdr-dash.service

clean:
	rm -rf bin e2e/artifacts
