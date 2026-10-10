// E2E for voice: dictation into chat boxes and voice navigation, against the
// real herdr-dash binary with stubbed herdr-projects and a fake Cloudflare
// Workers AI. The browser's SpeechRecognition is mocked (no microphone in
// headless Chromium); the server-transcription path uses Chromium's fake
// audio device. Artifacts land in e2e/artifacts/voice-*.
//
// Ways this could fail, written before the feature existed:
//  V1. The Cloudflare token reaches the browser (config, page, responses).
//  V2. Without CLOUDFLARE_* the intent/transcribe endpoints half-work, hang
//      or crash instead of being cleanly disabled (and the page still calls
//      them, or hides voice that the browser could do alone).
//  V3. The intent call has the wrong shape: model not in the URL, not the
//      choose-among-options request, the answer not read from
//      {result:{answers}}, or a choice outside the offered candidates is
//      acted on.
//  V4. The intent call is slow (no ~1.5s timeout), uncached, or not rate
//      limited; or accepts junk (huge utterances, too many candidates,
//      cross-origin, non-JSON).
//  V5. Dictation auto-sends, or writes into the box without showing the
//      live interim transcript and a recording indicator.
//  V6. Voice nav misses commands: open project, open thread N in project,
//      state filters, next/previous needs-you, search, close, focus chat,
//      dock, help, stop.
//  V7. A state-changing command (ack, resolve, send) runs without a
//      confirmation, or runs after "no", or a click on Yes does nothing.
//  V8. Utterances the grammar cannot resolve are not sent to the model, or
//      ones it can are (needless calls).
//  V9. Keybinds fire while typing in an input ("?" in a textarea opens
//      help), are not configurable, or do not persist.
// V10. On a phone the voice button is missing or overflows the layout.
// V11. Without Web Speech, server transcription does not record, post and
//      act on the text.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, here } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-voice-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const TOKEN = "test-token-not-real-0123456789";
const ACCOUNT = "acc0123456789abcdef";

// ---------------------------------------------------------------- fake Workers AI
const cf = { calls: [], intents: { "take me to the beta thing": "open:hub:beta", "gibberish words here": "none", "make it go away": "close" }, text: "open alpha project" };
const cfServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const call = { url: req.url, auth: req.headers.authorization, body: null };
    try { call.body = JSON.parse(body); } catch {}
    cf.calls.push(call);
    const send = (o, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401);
    if (req.url === `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`) {
      const u = call.body?.state?.utterance || "";
      if (u.includes("slowly")) await new Promise((r) => setTimeout(r, 3000));
      const opts = Object.keys(call.body?.questions?.action?.criteria || {});
      let choice = cf.intents[u] || "none";
      if (u === "pick something not offered") choice = "resolve:alpha/t-0001";
      const probabilities = Object.fromEntries(opts.map((o) => [o, o === choice ? 0.9 : 0.1 / Math.max(1, opts.length - 1)]));
      return send({ result: { model: "clef-flash", answers: { action: { type: "choice", choice, probabilities, confidence: 0.85 } }, usage: { input_tokens: 100, output_tokens: 0 } }, success: true, errors: [], messages: [] });
    }
    if (req.url === `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/openai/whisper-large-v3-turbo`) {
      return send({ result: { text: " " + cf.text + " " }, success: true, errors: [], messages: [] });
    }
    send({ success: false, errors: [{ message: "no route " + req.url }] }, 404);
  });
});

let plain, plainURL, ai, aiURL, browser;
const intentCalls = () => cf.calls.filter((c) => c.url.endsWith("/clef-flash"));

before(async () => {
  const cfPort = await freePort();
  await new Promise((r) => cfServer.listen(cfPort, "127.0.0.1", r));
  const p1 = await freePort(), p2 = await freePort();
  plainURL = `http://127.0.0.1:${p1}`;
  aiURL = `http://127.0.0.1:${p2}`;
  plain = startServer(p1, stubLog, ["--write-burst", "100"]);
  ai = startServer(p2, stubLog, ["--write-burst", "100"], {
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    HERDR_DASH_CF_API: `http://127.0.0.1:${cfPort}/client/v4`,
  });
  for (const u of [plainURL, aiURL]) await waitFor(async () => (await (await fetch(u + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  plain?.kill();
  ai?.kill();
  cfServer.close();
});

// A scripted SpeechRecognition: tests speak through window.__speech.say().
function mockSpeech() {
  const instances = [];
  class MockRec extends EventTarget {
    constructor() { super(); this.continuous = false; this.interimResults = false; this.lang = ""; this._on = false; instances.push(this); }
    start() {
      if (this._on) throw new DOMException("already started", "InvalidStateError");
      this._on = true;
      setTimeout(() => this._fire("start"), 0);
    }
    stop() { if (!this._on) return; this._on = false; setTimeout(() => this._fire("end"), 0); }
    abort() { this.stop(); }
    _fire(type, props = {}) { const e = new Event(type); Object.assign(e, props); this.dispatchEvent(e); this["on" + type]?.(e); }
  }
  window.SpeechRecognition = MockRec;
  window.webkitSpeechRecognition = MockRec;
  window.__speech = {
    listening: () => instances.filter((i) => i._on).length,
    say(text, final = true) {
      const r = [...instances].reverse().find((i) => i._on);
      if (!r) throw new Error("nobody is listening");
      // Like Chrome: a session's results accumulate; interim ones are
      // replaced in place until final.
      const res = [{ transcript: text, confidence: 0.9 }];
      res.isFinal = final;
      r._results ??= [];
      if (r._results.length && !r._results.at(-1).isFinal) r._results.pop();
      r._results.push(res);
      r._fire("result", { resultIndex: r._results.length - 1, results: [...r._results] });
      if (final && !r.continuous) r.stop();
    },
  };
}

async function open(url, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...opts });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(mockSpeech);
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.waitForSelector("#voice-fab");
  page.errors = errors;
  return page;
}
const say = (page, text, final = true) => page.evaluate(([t, f]) => window.__speech.say(t, f), [text, final]);
const title = (page) => page.locator("#panel h2.title").innerText();
const hud = (page) => page.locator("#voice-hud").innerText();

test("voice API is disabled cleanly without Cloudflare settings", async () => {
  // V1, V2
  const c = await (await fetch(plainURL + "/api/config")).json();
  assert.deepEqual(c.voice, { intent: false, transcribe: false });
  const r = await post(plainURL, "/api/voice/intent", { utterance: "open beta", candidates: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  assert.equal(r.status, 503);
  const t = await post(plainURL, "/api/voice/transcribe", { audio: "AAAA", mime: "audio/webm" });
  assert.equal(t.status, 503);
  const html = await (await fetch(plainURL + "/")).text();
  assert.match(html, /voice\.js/);
});

test("intent API: Workers AI shape, cache, validation, timeout; token stays server-side", async () => {
  // V1, V3, V4
  const c = await (await fetch(aiURL + "/api/config")).json();
  assert.deepEqual(c.voice, { intent: true, transcribe: true });
  assert.doesNotMatch(JSON.stringify(c), new RegExp(TOKEN));
  for (const f of ["/", "/voice.js", "/app.js"]) assert.doesNotMatch(await (await fetch(aiURL + f)).text(), new RegExp(TOKEN + "|" + ACCOUNT));

  const cands = [{ id: "open:hub:alpha", label: "Open project Alpha Project" }, { id: "open:hub:beta", label: "Open project Beta" }, { id: "close", label: "Close the panel" }];
  const n0 = intentCalls().length;
  const r = await post(aiURL, "/api/voice/intent", { utterance: "take me to the beta thing", candidates: cands });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.choice, "open:hub:beta");
  assert.ok(r.json.confidence > 0.5);
  assert.doesNotMatch(JSON.stringify(r.json), new RegExp(TOKEN));
  const call = intentCalls().at(-1);
  assert.equal(call.auth, `Bearer ${TOKEN}`);
  assert.equal(call.body.model, "clef-flash");
  assert.equal(call.body.state.utterance, "take me to the beta thing");
  assert.equal(call.body.questions.action.type, "choice");
  // Offered: exactly the candidates plus "none".
  assert.deepEqual(Object.keys(call.body.questions.action.criteria).sort(), ["close", "none", "open:hub:alpha", "open:hub:beta"]);
  // Cached: the same question is not asked twice.
  const again = await post(aiURL, "/api/voice/intent", { utterance: "Take me to the beta thing", candidates: cands });
  assert.equal(again.json.choice, "open:hub:beta");
  assert.equal(intentCalls().length, n0 + 1);
  // A choice outside the offered set is never passed on.
  const odd = await post(aiURL, "/api/voice/intent", { utterance: "pick something not offered", candidates: cands });
  assert.equal(odd.json.choice, "none");

  // Validation.
  const bad = [
    { utterance: "", candidates: cands },
    { utterance: "x".repeat(400), candidates: cands },
    { utterance: "hi\u0007", candidates: cands },
    { utterance: "hi", candidates: [cands[0]] },
    { utterance: "hi", candidates: Array.from({ length: 80 }, (_, i) => ({ id: "c" + i, label: "C" })) },
    { utterance: "hi", candidates: [{ id: "bad id; rm", label: "x" }, cands[1]] },
    { utterance: "hi", candidates: [{ id: "none", label: "x" }, cands[1]] },
  ];
  for (const b of bad) assert.equal((await post(aiURL, "/api/voice/intent", b)).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal((await post(aiURL, "/api/voice/intent", "utterance=hi", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await post(aiURL, "/api/voice/intent", { utterance: "open beta", candidates: cands }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(aiURL + "/api/voice/intent")).status, 405);

  // Timeout: a slow model answers within ~1.5s with an error, not a hang.
  const t0 = Date.now();
  const slow = await post(aiURL, "/api/voice/intent", { utterance: "go there slowly", candidates: cands });
  assert.equal(slow.status, 504);
  assert.ok(Date.now() - t0 < 2500, `timed out in ${Date.now() - t0}ms`);

  // Transcription: base64 audio in, text out; junk refused.
  const tr = await post(aiURL, "/api/voice/transcribe", { audio: Buffer.from("fake webm bytes").toString("base64"), mime: "audio/webm;codecs=opus" });
  assert.equal(tr.status, 200);
  assert.equal(tr.json.text, "open alpha project");
  const wcall = cf.calls.at(-1);
  assert.match(wcall.url, /whisper-large-v3-turbo$/);
  assert.equal(Buffer.from(wcall.body.audio, "base64").toString(), "fake webm bytes");
  assert.equal((await post(aiURL, "/api/voice/transcribe", { audio: "!!!not base64", mime: "audio/webm" })).status, 400);
  assert.equal((await post(aiURL, "/api/voice/transcribe", { audio: "", mime: "audio/webm" })).status, 400);
  assert.equal((await post(aiURL, "/api/voice/transcribe", { audio: "AAAA", mime: "text/html" })).status, 400);
  writeFileSync(join(artifacts, "voice-intent-call.json"), JSON.stringify({ ...call, auth: "Bearer <redacted>" }, null, 2));
});

test("dictation: mic in every chat box, live interim, never auto-sends", async () => {
  // V5
  const page = await open(plainURL);
  const m = log.mark();
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#chat-input");
  const mic = page.locator('.mic[data-for="chat-input"]');
  await mic.waitFor();
  await mic.click();
  await waitFor(async () => (await mic.getAttribute("aria-pressed")) === "true", 2000);
  assert.match(await mic.getAttribute("class"), /recording/);
  await say(page, "use the sec", false);
  await waitFor(async () => /use the sec/.test(await page.locator('.voice-interim[data-for="chat-input"]').innerText()), 2000);
  assert.equal(await page.inputValue("#chat-input"), "", "interim text is not committed");
  await page.screenshot({ path: join(artifacts, "voice-dictation.png") });
  await say(page, "use the second option");
  await waitFor(async () => (await page.inputValue("#chat-input")) === "use the second option", 2000);
  await mic.click();
  await waitFor(async () => (await mic.getAttribute("aria-pressed")) === "false", 2000);
  assert.equal(await page.locator('.voice-interim[data-for="chat-input"]').innerText(), "");
  // Keybind (default Alt+M) toggles dictation into the focused box; text appends.
  await page.focus("#chat-input");
  await page.keyboard.press("Alt+KeyM");
  await waitFor(async () => (await mic.getAttribute("aria-pressed")) === "true", 2000);
  await say(page, "please");
  await waitFor(async () => (await page.inputValue("#chat-input")) === "use the second option please", 2000);
  await page.keyboard.press("Alt+KeyM");
  await page.waitForTimeout(400);
  assert.deepEqual(log.since(m), [], "dictation never sends");

  // The coordinator box has one too.
  await page.click("#open-coord");
  await page.waitForSelector("#coord-input");
  await page.locator('.mic[data-for="coord-input"]').click();
  await say(page, "status please");
  await waitFor(async () => (await page.inputValue("#coord-input")) === "status please", 2000);
  assert.deepEqual(log.since(m), []);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("voice nav: grammar commands navigate, filter, search and focus", async () => {
  // V6, V8
  const page = await open(plainURL);
  const n0 = cf.calls.length;
  await page.keyboard.press("Alt+KeyV");
  await page.waitForSelector("#voice-fab.listening");
  await page.waitForSelector("#voice-hud:not([hidden])");

  await say(page, "open beta");
  await waitFor(async () => (await title(page)) === "Beta", 3000);
  await say(page, "show thread 2 in alpha project");
  await waitFor(async () => (await title(page)) === "Needs approval", 3000);
  await say(page, "open t-0003");
  await waitFor(async () => (await title(page)) === "Widget shipped", 3000);
  await say(page, "open widget pipeline");
  await waitFor(async () => (await title(page)) === "Widget pipeline", 3000);
  await say(page, "Show thread three of alpha");
  await waitFor(async () => (await title(page)) === "Widget shipped", 3000);

  await say(page, "close panel");
  await waitFor(async () => (await page.locator("#panel.open").count()) === 0, 2000);
  await say(page, "show blocked");
  await waitFor(async () => (await page.inputValue("#f-state")) === "blocked", 2000);
  await say(page, "show review");
  await waitFor(async () => (await page.inputValue("#f-state")) === "review", 2000);
  await say(page, "show waiting");
  await waitFor(async () => (await page.inputValue("#f-state")) === "waiting", 2000);
  await say(page, "show everything");
  await waitFor(async () => (await page.inputValue("#f-state")) === "", 2000);

  await say(page, "search widget");
  await waitFor(async () => (await page.inputValue("#f-search")) === "widget", 2000);
  await waitFor(async () => (await page.locator("svg g.node.thread").count()) === 2, 3000);
  await say(page, "clear search");
  await waitFor(async () => (await page.inputValue("#f-search")) === "", 2000);

  const order = await page.locator("#needs .chip").evaluateAll((cs) => cs.map((c) => c.dataset.key));
  await say(page, "next");
  await waitFor(async () => (await page.locator("svg g.node.selected").getAttribute("data-key")) === order[0], 3000);
  await say(page, "next one");
  await waitFor(async () => (await page.locator("svg g.node.selected").getAttribute("data-key")) === order[1], 3000);
  await say(page, "previous");
  await waitFor(async () => (await page.locator("svg g.node.selected").getAttribute("data-key")) === order[0], 3000);

  await say(page, "open widget pipeline");
  await waitFor(async () => (await title(page)) === "Widget pipeline", 3000);
  await say(page, "focus chat");
  await waitFor(() => page.evaluate(() => document.activeElement?.id === "chat-input"), 2000);
  await say(page, "dock left");
  await page.waitForSelector("body.dock-left");
  assert.equal(await page.getAttribute("#dock-left", "aria-pressed"), "true");
  await say(page, "move the panel to the bottom");
  await page.waitForSelector("body.dock-bottom");
  await say(page, "dock right");
  await page.waitForSelector("body.dock-right");

  await say(page, "help");
  await page.waitForSelector("#voice-help:not([hidden])");
  await page.screenshot({ path: join(artifacts, "voice-help.png") });
  await page.keyboard.press("Escape");
  await page.waitForSelector("#voice-help", { state: "hidden" });

  // Nothing the grammar resolved went to the model (none configured here
  // either), and an unknown phrase says so.
  await say(page, "gibberish words here");
  await waitFor(async () => /didn.t understand/i.test(await hud(page)), 2000);
  assert.equal(cf.calls.length, n0);
  await page.screenshot({ path: join(artifacts, "voice-nav.png") });

  await say(page, "stop listening");
  await waitFor(async () => (await page.locator("#voice-fab.listening").count()) === 0, 2000);
  assert.equal(await page.evaluate(() => window.__speech.listening()), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("voice nav: ack, resolve and send ask for confirmation first", async () => {
  // V7
  const page = await open(plainURL);
  const R = join(here, "..", "testdata", "root");
  const hp = `herdr-projects --root ${R}`;
  await page.keyboard.press("Alt+KeyV");
  await page.waitForSelector("#voice-fab.listening");

  await say(page, "open widget shipped");
  await waitFor(async () => (await title(page)) === "Widget shipped", 3000);
  let m = log.mark();
  await say(page, "ack this");
  await page.waitForSelector("#voice-hud .confirm");
  assert.match(await hud(page), /ack.*alpha\/t-0003/i);
  await page.screenshot({ path: join(artifacts, "voice-confirm.png") });
  await page.waitForTimeout(400);
  assert.deepEqual(log.since(m), [], "nothing before the answer");
  await say(page, "no");
  await page.waitForSelector("#voice-hud .confirm", { state: "detached" });
  await page.waitForTimeout(400);
  assert.deepEqual(log.since(m), [], "nothing after no");
  await say(page, "ack this");
  await page.waitForSelector("#voice-hud .confirm");
  await say(page, "yes");
  await waitFor(() => log.since(m).includes(`${hp} thread ack alpha t-0003`), 4000);

  // Resolve: a click on Yes confirms too (and no second dialog pops up).
  await say(page, "open docs refresh");
  await waitFor(async () => (await title(page)) === "Docs refresh", 3000);
  m = log.mark();
  await say(page, "resolve this");
  await page.waitForSelector("#voice-yes");
  assert.deepEqual(log.since(m), []);
  await page.click("#voice-yes");
  await waitFor(() => log.since(m).includes(`${hp} thread resolve alpha t-0006`), 4000);
  assert.equal(await page.locator("#dlg[open]").count(), 0);

  // Send: dictate, then "send" asks before sending the box's text.
  await say(page, "open widget pipeline");
  await waitFor(async () => (await title(page)) === "Widget pipeline", 3000);
  await page.fill("#chat-input", "please add tests");
  m = log.mark();
  await say(page, "send");
  await page.waitForSelector("#voice-hud .confirm");
  assert.match(await hud(page), /please add tests/);
  await page.click("#voice-no");
  await page.waitForTimeout(300);
  assert.deepEqual(log.since(m), []);
  assert.equal(await page.inputValue("#chat-input"), "please add tests");
  await say(page, "send it");
  await page.waitForSelector("#voice-hud .confirm");
  await say(page, "yes");
  await waitFor(() => log.since(m).includes("stdin: please add tests"), 4000);
  assert.deepEqual(log.since(m), [`${hp} thread prompt alpha t-0001 --text-file -`, "stdin: please add tests"]);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("voice nav: unresolved utterances go to the intent model via the backend", async () => {
  // V3, V8
  const page = await open(aiURL);
  await page.keyboard.press("Alt+KeyV");
  await page.waitForSelector("#voice-fab.listening");
  const n0 = intentCalls().length;
  await say(page, "open beta");
  await waitFor(async () => (await title(page)) === "Beta", 3000);
  assert.equal(intentCalls().length, n0, "the grammar handled it");
  await say(page, "make it go away");
  await waitFor(async () => (await page.locator("#panel.open").count()) === 0, 3000);
  assert.equal(intentCalls().length, n0 + 1);
  const offered = Object.keys(intentCalls().at(-1).body.questions.action.criteria);
  for (const id of ["open:hub:alpha", "open:hub:beta", "open:alpha/t-0002", "close", "filter:blocked", "none"]) assert.ok(offered.includes(id), "offered " + id);
  assert.ok(offered.length <= 64);
  await say(page, "take me to the beta thing");
  await waitFor(async () => (await title(page)) === "Beta", 3000);
  await say(page, "gibberish words here");
  await waitFor(async () => /didn.t understand/i.test(await hud(page)), 3000);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("keybinds: not while typing, help overlay, configurable and persisted", async () => {
  // V9
  const page = await open(plainURL);
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#chat-input");
  await page.focus("#chat-input");
  await page.keyboard.type("why? because");
  assert.equal(await page.inputValue("#chat-input"), "why? because");
  assert.equal(await page.locator("#voice-help:not([hidden])").count(), 0);
  await page.keyboard.press("Escape");
  await page.locator("#graph").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+Slash");
  await page.waitForSelector("#voice-help:not([hidden])");
  const help = await page.locator("#voice-help").innerText();
  for (const s of [/Alt\+V/, /Alt\+M/, /ack this/i, /dock/i, /search/i]) assert.match(help, s);
  await page.keyboard.press("Escape");

  // Rebind voice nav to Alt+K.
  await page.click("#voice-settings-btn");
  await page.waitForSelector("#voice-settings:not([hidden])");
  await page.screenshot({ path: join(artifacts, "voice-settings.png") });
  await page.click("#vs-nav-key");
  await page.keyboard.press("Alt+KeyK");
  assert.equal(await page.inputValue("#vs-nav-key"), "Alt+K");
  await page.selectOption("#vs-dict-mode", "hold");
  await page.click("#voice-settings-close");
  await page.reload();
  await page.waitForSelector("#voice-fab");
  await page.keyboard.press("Alt+KeyV");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#voice-fab.listening").count(), 0, "old bind is gone");
  await page.keyboard.press("Alt+KeyK");
  await page.waitForSelector("#voice-fab.listening");
  await page.keyboard.press("Alt+KeyK");
  await waitFor(async () => (await page.locator("#voice-fab.listening").count()) === 0, 2000);

  // Hold-to-talk dictation: down starts, up stops.
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#chat-input");
  await page.fill("#chat-input", "");
  await page.focus("#chat-input");
  await page.keyboard.down("Alt");
  await page.keyboard.down("KeyM");
  await waitFor(async () => (await page.locator('.mic[data-for="chat-input"]').getAttribute("aria-pressed")) === "true", 2000);
  await say(page, "held words", true);
  await page.keyboard.up("KeyM");
  await page.keyboard.up("Alt");
  await waitFor(async () => (await page.locator('.mic[data-for="chat-input"]').getAttribute("aria-pressed")) === "false", 2000);
  assert.equal(await page.inputValue("#chat-input"), "held words");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("phone: floating voice button and chat mic fit", async () => {
  // V10
  const page = await open(plainURL, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  const box = await page.locator("#voice-fab").boundingBox();
  assert.ok(box && box.width >= 44 && box.x + box.width <= 390 && box.y + box.height <= 844, JSON.stringify(box));
  await page.locator("#voice-fab").tap();
  await page.waitForSelector("#voice-fab.listening");
  await say(page, "open widget pipeline");
  await waitFor(async () => (await title(page)) === "Widget pipeline", 3000);
  await page.waitForSelector('.mic[data-for="chat-input"]');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: join(artifacts, "voice-phone.png") });
  await page.locator("#voice-fab").tap();
  await waitFor(async () => (await page.locator("#voice-fab.listening").count()) === 0, 2000);
  await page.close();
});

test("no Web Speech: server transcription records, posts and acts", async () => {
  // V11, V2
  const fb = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  try {
    const page = await fb.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
    // Without server transcription either, voice is unavailable and says why.
    await page.goto(plainURL + "/");
    await page.waitForSelector("#voice-fab");
    assert.equal(await page.locator("#voice-fab").isDisabled(), true);
    assert.match(await page.locator("#voice-fab").getAttribute("title"), /not available/i);

    await page.goto(aiURL + "/");
    await page.waitForSelector("#voice-fab:not([disabled])");
    const n0 = cf.calls.length;
    await page.click("#voice-fab");
    await page.waitForSelector("#voice-fab.listening");
    await page.waitForTimeout(1200);
    await page.click("#voice-fab"); // stop: the clip is sent for transcription
    await waitFor(async () => (await title(page)) === "Alpha Project", 8000);
    const w = cf.calls.slice(n0).find((c) => /whisper/.test(c.url));
    assert.ok(w && Buffer.from(w.body.audio, "base64").length > 100, "audio was posted");
    assert.match(await hud(page), /open alpha project/i);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await fb.close();
  }
});

test("intent API is rate limited", async () => {
  // V4 (last: it drains the bucket)
  const cands = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await post(aiURL, "/api/voice/intent", { utterance: "unique phrase " + i, candidates: cands })).status);
  assert.ok(codes.includes(429), codes.join(","));
  assert.equal(codes[0], 200);
  // No herdr-projects writes outside the allow-list happened in this file.
  const allowed = [/ list$/, / thread list \S+ --json$/, /^herdr pane (list|read)/, /^gh pr list/, / progress --pane /, / safety show /,
    / thread (ack|resolve) alpha t-000[36]$/, / thread prompt alpha t-0001 --text-file -$/, /^stdin: please add tests$/];
  for (const c of log.lines()) assert.ok(allowed.some((re) => re.test(c)), "unexpected: " + c);
  writeFileSync(join(artifacts, "voice-calls.log"), readFileSync(stubLog, "utf8"));
});
