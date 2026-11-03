// Smoke test of the Linux desktop build (bin/herdr-dash-desktop) in a real
// WebKitGTK window. Run through `make desktop-smoke`, which provides an X
// display (xvfb-run) and a private D-Bus session (single instance).
// Artifacts: e2e/artifacts/desktop-linux.png, e2e/artifacts/desktop.json.
//
// Ways this could fail, written before the app existed:
//  D1. The embedded server does not come up, or binds the service's fixed
//      port (8791) and collides with a running herdr-dash.
//  D2. The window never shows the dashboard: it stays on the splash, the
//      webview refuses the loopback URL, or the page loads without its
//      event stream.
//  D3. The voice model is not warm after startup: the sidecar only starts on
//      the first voice session, so first use still waits.
//  D4. A second launch opens a second window and a second server and model
//      instead of focusing the first.
//  D5. Closing the app leaves the embedded server or the model sidecar running.
//  D6. Connect mode starts its own server instead of using the given Dash,
//      or does not warm that Dash's model; auto mode picks the wrong one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo, td, stub, here, artifacts, freePort, startServer, waitFor } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const bin = join(repo, "bin/herdr-dash-desktop");
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-desktop-"));
const out = {};
const procs = [];
after(() => {
  for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
  writeFileSync(join(artifacts, "desktop.json"), JSON.stringify(out, null, 2) + "\n");
});

const fixtureFlags = [
  "--root", join(td, "root"),
  "--herdr", join(stub, "herdr"),
  "--gh", join(stub, "gh"),
  "--claude-dir", join(td, "claude"),
  "--codex-dir", join(td, "codex"),
  "--poll", "1s",
  "--session-profiles", join(td, "session-profiles.toml"),
  "--opencode-db", join(td, "opencode.db"),
  "--opencode-config", join(td, "opencode-config"),
];

function sttEnv(log) {
  return {
    HERDR_DASH_STT: "local",
    HERDR_DASH_STT_SERVER_CMD: `node ${join(here, "stubs", "stt-sidecar.mjs")}`,
    HERDR_DASH_STT_IDLE: "1s",
    STT_LOG: log,
  };
}

// launch runs the desktop app and collects its log.
function launch(args, env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(CLOUDFLARE_|HERDR_DASH_)/.test(k)) delete base[k];
  const p = spawn(bin, args, {
    env: { ...base, HERDR_DASH_HERDR_PROJECTS: join(stub, "herdr-projects"), HERDR_DASH_USAGE: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.log = "";
  p.stdout.on("data", (d) => { p.log += d; });
  p.stderr.on("data", (d) => { p.log += d; process.stderr.write(d); });
  p.exited = new Promise((r) => p.on("exit", (code, sig) => r({ code, sig })));
  procs.push(p);
  return p;
}

// Each test ends its apps: a leftover would hold the single-instance lock.
const stopAll = async () => {
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) { p.kill("SIGKILL"); await p.exited; }
};

const logLines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean);
const portOpen = async (url) => { try { await fetch(url + "/api/config"); return true; } catch { return false; } };

test("embedded mode: window shows the dashboard, voice is warm, one instance, clean exit", { after: stopAll }, async () => {
  assert.ok(process.env.DISPLAY, "needs an X display (run make desktop-smoke)");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const sttLog = join(tmp, "embed-stt.log");
  writeFileSync(sttLog, "");
  const t0 = Date.now();
  const app = launch(["--connect", "embed", "--check-mic", "--addr", `127.0.0.1:${port}`, ...fixtureFlags], sttEnv(sttLog));

  // D1
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0, 20000);
  out.server_up_ms = Date.now() - t0;
  assert.match(app.log, /desktop: embedded server on http:\/\/127\.0\.0\.1:/);

  // D2: the page in the window opened the event stream (logged by the app's
  // server when the request carries the webview's user agent).
  await waitFor(async () => /desktop: dashboard loaded in the window/.test(app.log), 30000);
  out.dashboard_loaded_ms = Date.now() - t0;

  // D3: ready without any voice session.
  const ready = await waitFor(async () => {
    const s = await (await fetch(url + "/api/voice/local")).json();
    return s.state === "ready" && s;
  }, 20000);
  out.voice_ready_ms = Date.now() - t0;
  out.voice = ready;
  assert.ok(logLines(sttLog).includes("listening"));
  assert.ok(!logLines(sttLog).includes("connected"), "warm needed no voice session");
  await waitFor(async () => /desktop: voice model ready/.test(app.log), 5000);

  // The webview may ask for the microphone: WebKitGTK media streams are on
  // and the request is not refused (Xvfb has no audio device, so "granted"
  // or a missing-device error are both fine; NotAllowedError is not).
  const mic = await waitFor(async () => app.log.match(/desktop: microphone check: "([^"]*)"/), 15000);
  out.mic_check = mic[1];
  assert.doesNotMatch(mic[1], /NotAllowed|no mediaDevices/);

  // Artifact: what the window shows (give the graph a moment to settle).
  await new Promise((r) => setTimeout(r, 2500));
  const png = join(artifacts, "desktop-linux.png");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", process.env.DESKTOP_SMOKE_SIZE || "1280x800", "-i", process.env.DISPLAY, "-frames:v", "1", png]);
  assert.ok(statSync(png).size > 20000, "screenshot has content");

  // Memory of the app with its webview processes (the model is the stub).
  const rss = (pid) => { try { return +readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]; } catch { return 0; } };
  const kids = execFileSync("ps", ["-o", "pid=", "--ppid", String(app.pid)]).toString().trim().split(/\s+/).filter(Boolean);
  out.rss_mib = { app: Math.round(rss(app.pid) / 1024), webview: Math.round(kids.reduce((n, k) => n + rss(k), 0) / 1024) };

  // D4: a second launch exits and the first one is told.
  const second = launch(["--connect", "embed", "--addr", `127.0.0.1:${await freePort()}`, ...fixtureFlags], sttEnv(sttLog));
  const res = await Promise.race([second.exited, new Promise((r) => setTimeout(() => r("still running"), 10000))]);
  assert.notEqual(res, "still running", "second instance must exit");
  await waitFor(async () => /desktop: second instance/.test(app.log), 5000);
  assert.equal(logLines(sttLog).filter((l) => l === "listening").length, 1, "no second model");

  // D5
  app.kill("SIGTERM");
  const ex = await Promise.race([app.exited, new Promise((r) => setTimeout(() => r("hung"), 10000))]);
  assert.notEqual(ex, "hung", "app exits on SIGTERM");
  await waitFor(async () => logLines(sttLog).includes("stopped"), 5000);
  assert.equal(await portOpen(url), false, "embedded server closed");
});

test("connect and auto modes use an existing Dash and warm its model", { after: stopAll }, async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const sttLog = join(tmp, "remote-stt.log");
  writeFileSync(sttLog, "");
  const srv = startServer(port, "", [], { ...sttEnv(sttLog), HERDR_DASH_STT_IDLE: "60s" });
  procs.push(srv);
  await waitFor(async () => (await fetch(url + "/api/config")).ok, 10000);

  // D6: auto probes the given URL first and connects when it is a Dash.
  for (const args of [["--connect", url], ["--connect", "auto", "--probe", url]]) {
    const app = launch(args);
    await waitFor(async () => new RegExp("desktop: connected to " + url.replace(/\./g, "\\.")).test(app.log), 15000);
    assert.doesNotMatch(app.log, /embedded server/);
    await waitFor(async () => (await (await fetch(url + "/api/voice/local")).json()).state === "ready", 15000);
    app.kill("SIGTERM");
    await app.exited;
  }
  assert.equal(logLines(sttLog).filter((l) => l === "listening").length, 1, "the Dash's own sidecar, warmed once");

  // Auto with nothing at the probe address embeds a server.
  const closed = `http://127.0.0.1:${await freePort()}`;
  const app = launch(["--connect", "auto", "--probe", closed, "--addr", `127.0.0.1:${await freePort()}`, ...fixtureFlags]);
  await waitFor(async () => /desktop: embedded server on/.test(app.log), 15000);
  app.kill("SIGTERM");
  await app.exited;
  srv.kill();
});
