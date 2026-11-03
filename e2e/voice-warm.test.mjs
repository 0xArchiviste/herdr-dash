// E2E for the voice warm-up API the desktop app calls at startup
// (GET /api/voice/local, POST /api/voice/warm). The sidecar is the stub;
// the model download is served by a local fake that never matches the
// pinned checksum. Artifact: e2e/artifacts/voice-warm.json.
//
// Ways this could fail, written before the feature existed:
//  W1. Status lies: it says ready before the sidecar accepts connections,
//      or reports anything but "off" when the local engine is disabled.
//  W2. Warm does not start the sidecar without a voice session, so the
//      first use still waits for the model to load.
//  W3. Repeated warms (the app's heartbeat) spawn a second model process.
//  W4. A voice session after warm starts another sidecar instead of reusing
//      the warm one, or the hold leaks and the sidecar never stops once the
//      warms stop.
//  W5. A missing model downloads silently: no byte progress, no total, no
//      licence notice while it downloads.
//  W6. A failed download (bad checksum) reports ready, falls back to a cloud
//      engine, or leaves files that later count as an installed model.
//  W7. Warm is reachable cross-site (a foreign page could load a 900 MB model).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifacts, freePort, startServer, waitFor, here, post } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-voice-warm-"));
const stubLog = join(tmp, "sidecar.log");
writeFileSync(stubLog, "");
const lines = () => readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
const out = {};

let plain, warm, dl, plainURL, warmURL, dlURL, modelSrv, modelHits = 0;
const sttDir = join(tmp, "stt");

before(async () => {
  // A fake model archive: 3 MB sent slowly with a Content-Length, wrong bytes.
  const total = 3 << 20;
  modelSrv = http.createServer((req, res) => {
    modelHits++;
    res.writeHead(200, { "Content-Length": total, "Content-Type": "application/octet-stream" });
    let sent = 0;
    const chunk = Buffer.alloc(64 << 10, 7);
    const iv = setInterval(() => {
      if (sent >= total) { clearInterval(iv); res.end(); return; }
      res.write(chunk);
      sent += chunk.length;
    }, 40);
    req.on("close", () => clearInterval(iv));
  });
  await new Promise((r) => modelSrv.listen(0, "127.0.0.1", r));
  const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
  plainURL = `http://127.0.0.1:${p1}`;
  warmURL = `http://127.0.0.1:${p2}`;
  dlURL = `http://127.0.0.1:${p3}`;
  plain = startServer(p1, "");
  warm = startServer(p2, "", [], {
    HERDR_DASH_STT: "local",
    HERDR_DASH_STT_SERVER_CMD: `node ${join(here, "stubs", "stt-sidecar.mjs")}`,
    HERDR_DASH_STT_IDLE: "1s",
    HERDR_DASH_STT_WARM_HOLD: "3s",
    STT_LOG: stubLog,
  });
  dl = startServer(p3, "", [], {
    HERDR_DASH_STT: "local",
    HERDR_DASH_STT_DIR: sttDir,
    HERDR_DASH_STT_MODEL_URL: `http://127.0.0.1:${modelSrv.address().port}/model.tar.bz2`,
    HERDR_DASH_STT_PYTHON: "/nonexistent/python",
  });
  for (const u of [plainURL, warmURL, dlURL]) await waitFor(async () => (await fetch(u + "/api/config")).ok);
});

after(async () => {
  plain?.kill();
  warm?.kill();
  dl?.kill();
  modelSrv?.close();
  writeFileSync(join(artifacts, "voice-warm.json"), JSON.stringify(out, null, 2) + "\n");
});

const status = async (u) => (await fetch(u + "/api/voice/local")).json();

test("status is off when the local engine is disabled, and warm is refused", async () => {
  // W1
  const s = await status(plainURL);
  assert.equal(s.state, "off");
  const r = await post(plainURL, "/api/voice/warm", {});
  assert.equal(r.status, 501);
  assert.match(r.json.error, /not enabled/);
});

test("warm is refused cross-site", async () => {
  // W7
  const r = await post(warmURL, "/api/voice/warm", {}, { Origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const r2 = await post(warmURL, "/api/voice/warm", {}, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(r2.status, 403);
  assert.equal(lines().filter((l) => l === "listening").length, 0, "no sidecar from refused warms");
});

test("warm starts the sidecar before any voice session and reports ready", async () => {
  // W1, W2
  const before = await status(warmURL);
  assert.equal(before.state, "idle", "cold: engine on, sidecar not running");
  const t0 = Date.now();
  const r = await post(warmURL, "/api/voice/warm", {});
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const ready = await waitFor(async () => { const s = await status(warmURL); return s.state === "ready" && s; }, 10000);
  out.warm_ready_ms = Date.now() - t0;
  assert.ok(lines().includes("listening"), "sidecar listening once ready");
  assert.equal(lines().filter((l) => l === "connected").length, 0, "no voice session was needed");
  assert.match(ready.licence, /CC-BY-4\.0/);
  assert.equal(ready.model, "nvidia/parakeet-tdt-0.6b-v3");
  out.ready = ready;
});

test("heartbeat warms reuse the sidecar; a voice session reuses it too", async () => {
  // W3, W4
  for (let i = 0; i < 3; i++) assert.equal((await post(warmURL, "/api/voice/warm", {})).status, 202);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lines().filter((l) => l === "listening").length, 1, "one sidecar for all warms");
  // A session connects to the running sidecar (the stub logs "connected").
  const ws = new WebSocket(warmURL.replace("http", "ws") + "/api/voice/stream");
  const first = await new Promise((res, rej) => { ws.onmessage = (e) => res(JSON.parse(e.data)); ws.onerror = rej; });
  assert.deepEqual(first, { ready: true });
  ws.close();
  await waitFor(async () => lines().includes("connected"), 5000);
  assert.equal(lines().filter((l) => l === "listening").length, 1, "session reused the warm sidecar");
});

test("the hold expires when warms stop, then the idle stop applies", async () => {
  // W4: hold 3s + idle 1s after the last warm.
  const t0 = Date.now();
  await waitFor(async () => lines().includes("stopped"), 12000);
  out.stop_after_last_warm_ms = Date.now() - t0;
  const s = await status(warmURL);
  assert.equal(s.state, "idle");
});

test("a missing model downloads with progress and licence; a bad checksum is an error, not ready", async () => {
  // W5, W6
  const r = await post(dlURL, "/api/voice/warm", {});
  assert.equal(r.status, 202);
  const prog = await waitFor(async () => { const s = await status(dlURL); return s.state === "downloading" && s.bytes > 0 && s; }, 10000);
  assert.equal(prog.total, 3 << 20, "total from Content-Length");
  assert.match(prog.licence, /CC-BY-4\.0/, "licence notice shown while downloading");
  out.progress = prog;
  const failed = await waitFor(async () => { const s = await status(dlURL); return s.state === "error" && s; }, 20000);
  assert.match(failed.error, /checksum/i);
  assert.notEqual(failed.state, "ready");
  out.download_error = failed;
  // Nothing half-installed remains that could pass as a model.
  const left = readdirSync(sttDir).filter((n) => !n.startsWith("."));
  assert.deepEqual(left, [], "no model dir after a rejected download");
  // No cloud fallback: the config still only offers the local engine.
  const cfg = await (await fetch(dlURL + "/api/config")).json();
  assert.equal(cfg.voice.transcribe, false);
  assert.equal(cfg.voice.local, true);
  // A second warm after the error retries instead of reporting stale ready.
  const hits = modelHits;
  assert.equal((await post(dlURL, "/api/voice/warm", {})).status, 202);
  await waitFor(async () => modelHits > hits, 5000);
});
