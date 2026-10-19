// E2E for the local voice engine (HERDR_DASH_STT=local, the required
// Parakeet TDT v3 via sherpa-onnx). The browser talks to /api/voice/stream; the
// sidecar is stubbed. Artifacts land in e2e/artifacts/voice-local-*.
//
// Ways this could fail, written before the feature existed:
//  L1. The endpoint answers when it must not (engine off, non-local pages,
//      cross-origin) or the upgrade leaks without the engine enabled.
//  L2. Audio does not reach the model: the proxy drops binary frames, mangles
//      them, or never marks the end of input ("Done").
//  L3. Partial and final transcripts do not reach the page in the protocol
//      the page expects ({interim}/{final}/{eof}), or a final is lost when
//      the page stops the session before the sidecar finished.
//  L4. The sidecar never stops: no idle kill, or a second session while it
//      runs spawns a second model (memory doubles).
//  L5. No fallback: when the engine is selected but the sidecar cannot
//      start, the page quietly switches to Web Speech or the cloud instead
//      of showing the error.
//  L7. Endpoint and EOF repeat the same segment and insert dictation twice.
//  L8. Dictation ignores the cursor/selection or sends the chat automatically.
//  L9. Audio continues after Done, late results insert after session cleanup,
//      or a microphone granted after cancellation keeps recording.
//  L6. The page streams audio at the wrong sample rate or format for the
//      sidecar (not 16 kHz float32 mono).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { artifacts, freePort, startServer, waitFor, here } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-voice-local-"));
const stubLog = join(tmp, "sidecar.log");
writeFileSync(stubLog, "");
const stubScript = join(here, "stubs", "stt-sidecar.mjs");

let plain, local, plainURL, localURL, browser;

before(async () => {
  const p1 = await freePort(), p2 = await freePort();
  plainURL = `http://127.0.0.1:${p1}`;
  localURL = `http://127.0.0.1:${p2}`;
  plain = startServer(p1, "");
  local = startServer(p2, "", ["--write-burst", "100"], {
    HERDR_DASH_STT: "local",
    HERDR_DASH_STT_SERVER_CMD: `node ${stubScript}`,
    HERDR_DASH_STT_IDLE: "60s",
    STT_REPLY: "open alpha project",
    STT_LOG: stubLog,
  });
  await waitFor(async () => (await (await fetch(localURL + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
});

after(async () => {
  await browser?.close();
  plain?.kill();
  local?.kill();
});

const lines = () => readFileSync(stubLog, "utf8").split("\n").filter(Boolean);

test("config exposes the local engine only when enabled", async () => {
  // L1
  for (const [url, want] of [[plainURL, false], [localURL, true]]) {
    const r = await fetch(url + "/api/config");
    const c = await r.json();
    assert.equal(c.voice.local, want, "voice.local on " + url);
    assert.equal(typeof c.voice.local, "boolean");
  }
});

test("stream endpoint refuses sessions when the engine is off", async () => {
  // L1
  const status = await new Promise((res, rej) => {
    http.request({ host: "127.0.0.1", port: new URL(plainURL).port, path: "/api/voice/stream", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": 13, "Sec-WebSocket-Key": "x3JJHMbDL1EzLkh9GBhXDw==" } }, res)
      .on("error", rej).end();
  });
  assert.equal(status.statusCode, 501, "engine off is refused cleanly, not upgraded");
  status.resume();
});

test("sidecar sees the audio and answers; page shows partials and finals", async () => {
  // L2, L3, L6
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(localURL + "/");
  await page.waitForSelector("#voice-fab");
  const mark = lines().length;
  await page.click("#voice-fab");
  await page.waitForSelector("#voice-fab.listening");
  await waitFor(async () => lines().slice(mark).some((l) => l.startsWith("connected")), 8000);
  // The worklet streams the fake device's audio to the stub sidecar, binary
  // and untouched: stopping the session sends "Done", and the stub logs how
  // many seconds of audio it saw.
  await waitFor(async () => lines().slice(mark).some((l) => /^samples=1\.[2-9]/.test(l) || /^samples=[2-9]/.test(l)), 15000);
  await page.click("#voice-fab");
  await waitFor(async () => lines().some((l) => /^done samples=[1-9]/.test(l)), 8000);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, "voice-local-nav.png") });
  await page.close();
});

test("second session reuses the running sidecar; idle shutdown stops it", async () => {
  // L4
  const mark = lines().length;
  await page_sessions();
  await page_sessions();
  const window = lines().slice(mark);
  assert.ok(window.filter((l) => l.startsWith("connected")).length >= 2, "both sessions connected");
  assert.ok(window.filter((l) => /^done samples=[1-9]/.test(l)).length >= 2, "both sessions streamed audio");
  assert.equal(window.filter((l) => l.startsWith("listening")).length, 0, "no second sidecar was spawned between the sessions");
});
// Idle shutdown itself is covered by TestSTTIdleShutdown (Go unit test).

test("dictation with the local engine writes the final transcript", async () => {
  // L3
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.addInitScript(() => { localStorage.setItem("hd-voice", JSON.stringify({ engine: "local", dictMode: "toggle" })); });
  await page.goto(localURL + "/");
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#chat-input");
  await page.waitForSelector('.mic[data-for="chat-input"]');
  const mic = page.locator('.mic[data-for="chat-input"]');
  await page.fill("#chat-input", "Before selected after");
  await page.locator("#chat-input").evaluate((box) => box.setSelectionRange(7, 15));
  const mark = lines().length;
  await mic.click();
  await waitFor(async () => (await mic.getAttribute("aria-pressed")) === "true", 8000);
  try {
    await waitFor(async () => lines().slice(mark).some((l) => /^samples=1\.[2-9]/.test(l) || /^samples=[2-9]/.test(l)), 15000);
  } catch (e) {
    console.error("DICTATION LOG WINDOW:\n" + lines().slice(mark).join("\n"));
    throw e;
  }
  await waitFor(async () => (await page.locator('.voice-interim[data-for="chat-input"]').innerText()) === "open alpha project", 8000);
  assert.equal(await page.inputValue("#chat-input"), "Before selected after");
  await page.screenshot({ path: join(artifacts, "voice-local-dictation-partial.png") });
  // Stopping finalises: the page sends "Done" and the sidecar's final
  // transcript lands in the box.
  await mic.click();
  await waitFor(async () => (await page.inputValue("#chat-input")) === "Before open alpha project after", 8000);
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue("#chat-input"), "Before open alpha project after", "one insertion for a repeated final segment");
  assert.ok(!lines().slice(mark).includes("audio-after-done"));
  await page.screenshot({ path: join(artifacts, "voice-local-dictation-final.png") });
  await page.close();
});

test("no fallback: a dead sidecar surfaces the error, the engine stays local", async () => {
  // L5
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.addInitScript(() => {
    localStorage.setItem("hd-voice", JSON.stringify({ engine: "local", dictMode: "toggle" }));
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  await page.goto(localURL + "/");
  await page.waitForSelector('#voice-fab:not([disabled])');
  const badPort = await freePort();
  const broken = startServer(badPort, "", [], {
    HERDR_DASH_STT: "local", HERDR_DASH_STT_SERVER_CMD: "nonexistent-parakeet-server",
  });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${badPort}/api/config`)).ok);
    await page.goto(`http://127.0.0.1:${badPort}/`);
    await page.waitForSelector('#voice-fab:not([disabled])');
    await page.click("#voice-fab");
    await waitFor(async () => (await page.locator("body").innerText()).includes("Local voice engine:"), 8000);
    assert.equal(await page.locator("#voice-fab").getAttribute("aria-pressed"), "false");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("hd-voice")).engine), "local");
    await page.screenshot({ path: join(artifacts, "voice-local-error.png") });
  } finally { broken.kill(); }
  await page.close();
});

async function hud(page) {
  return (await page.locator("#voice-hud").innerText()) || "";
}

// page_sessions drives one full nav session: press the mic, wait for the
// sidecar to see audio, then stop.
async function page_sessions() {
  const mark = lines().length;
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(localURL + "/");
  await page.click("#voice-fab");
  await page.waitForSelector("#voice-fab.listening");
  await waitFor(async () => lines().slice(mark).some((l) => l.startsWith("connected")), 8000);
  await waitFor(async () => lines().slice(mark).some((l) => /^samples=1\.[2-9]/.test(l) || /^samples=[2-9]/.test(l)), 15000);
  await page.click("#voice-fab");
  await waitFor(async () => !(await page.locator("#voice-fab.listening").count()), 8000);
  await waitFor(async () => lines().slice(mark).some((l) => /^done samples=[1-9]/.test(l)), 8000);
  await page.close();
}

test("cancelling while microphone permission is pending stops the eventual stream", async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args);
      window.delayedStream = stream;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return stream;
    };
  });
  await page.goto(localURL);
  await page.click("#voice-fab");
  await waitFor(async () => page.evaluate(() => !!window.delayedStream));
  await page.click("#voice-fab");
  await waitFor(async () => page.evaluate(() => window.delayedStream.getTracks().every((t) => t.readyState === "ended")));
  assert.equal(await page.locator("#voice-fab").getAttribute("aria-pressed"), "false");
  await page.close();
});

test("browser speech detection is toggleable and loads no external scripts", async () => {
  const page = await browser.newPage();
  const external = [];
  page.on("request", (r) => { if (!r.url().startsWith(localURL)) external.push(r.url()); });
  await page.goto(localURL);
  await page.click("#voice-settings-btn");
  const toggle = page.locator("#vs-vad");
  await toggle.check();
  await page.click("#voice-settings-close");
  await page.click("#voice-fab");
  await waitFor(async () => /speech detection/i.test(await page.locator("#voice-hud").innerText()));
  await page.click("#voice-fab");
  await page.click("#voice-settings-btn");
  await toggle.uncheck();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("hd-voice")).vad), false);
  assert.deepEqual(external, []);
  await page.screenshot({ path: join(artifacts, "voice-local-speech-detection.png") });
  await page.close();
});

test("coordinator dictation preserves existing text and inserts only once", async () => {
  const page = await browser.newPage();
  await page.goto(localURL);
  await page.locator('#needs .chip[data-key="hub:alpha"]').click();
  const input = page.locator("#coord-input"), mic = page.locator('.mic[data-for="coord-input"]');
  await input.fill("Existing");
  await input.evaluate((box) => box.setSelectionRange(box.value.length, box.value.length));
  await mic.click();
  await waitFor(async () => (await page.locator('.voice-interim[data-for="coord-input"]').innerText()) === "open alpha project");
  await mic.click();
  await waitFor(async () => await input.inputValue() === "Existing open alpha project");
  await page.waitForTimeout(200);
  assert.equal(await input.inputValue(), "Existing open alpha project");
  await page.screenshot({ path: join(artifacts, "voice-local-coordinator.png") });
  await page.close();
});

test("identical words in two distinct final segments are both inserted", async () => {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const server = startServer(port, "", [], { HERDR_DASH_STT: "local", HERDR_DASH_STT_SERVER_CMD: `node ${stubScript}`, STT_REPLY: "Again.", STT_REPEAT: "1" });
  const page = await browser.newPage();
  try {
    await waitFor(async () => (await fetch(url + "/api/config")).ok);
    await page.goto(url);
    await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
    const mic = page.locator('.mic[data-for="chat-input"]');
    await mic.click();
    await waitFor(async () => (await page.locator('.voice-interim[data-for="chat-input"]').innerText()) === "Again.");
    await mic.click();
    await waitFor(async () => await page.inputValue("#chat-input") === "Again. Again.");
    assert.equal(await page.inputValue("#chat-input"), "Again. Again.");
  } finally { await page.close(); server.kill(); }
});
