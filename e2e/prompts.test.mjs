// E2E for prompt cards: a blocked pane's permission prompt or question menu
// shown as a card with one button per option, answered with the exact keys,
// from the panel, from the Needs-you strip and by voice; coordinators too.
// The stub herdr serves real (sanitized) harness screens from
// testdata/prompts/ for chosen panes. Artifacts land in e2e/artifacts/prompt-*.
//
// Ways this could fail, written before the feature existed:
//  P1. A blocked pane's prompt is not in the state (or is, for a pane that
//      is not blocked), or panes that are not blocked are read for it.
//  P2. The card is missing, unlabeled (digits instead of option text), shows
//      the command or diff as HTML, or does not mark lasting grants.
//  P3. A click sends other keys than the option's, keys chosen by the page
//      are trusted, or anything but `herdr-projects thread keys` runs.
//  P4. A prompt that changed (or went away) since the page drew it is
//      answered anyway.
//  P5. The page never says whether the prompt cleared, or says it did when
//      the pane still shows it.
//  P6. An option that takes text has no field, sends the text before the
//      option is picked, or a required text may be empty.
//  P7. Multi-select toggles are taken as answers, or there is no submit.
//  P8. The strip shows no summary, or its popover cannot answer without the
//      panel.
//  P9. Coordinator: keys reach a pane that is not the identified
//      coordinator, a coordinator that is not blocked, a trust screen, or go
//      through anything but `herdr pane send-keys` after `herdr pane get`.
// P10. Notifications fire without opt-in, for prompts already there when the
//      page loaded, or twice for one prompt.
// P11. Voice "allow" / "option four" answer the wrong prompt or option, or
//      "always allow" needs no confirmation.
// P12. The card breaks the phone layout.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-prompts-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
mkdirSync(screens);
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const fixture = (f) => readFileSync(join(td, "prompts", f), "utf8");
// Show a screen in a pane (":" as "_"), or the stub's default screen.
const show = (pane, f) => writeFileSync(join(screens, pane.replace(":", "_")), f ? fixture(f) : "● Done.\n\n❯ \n");
const hp = "herdr-projects --root " + join(td, "root");

// alpha/t-0002 runs in w1B:p1 (claude, blocked); beta's coordinator is
// w2Z:p1 (codex, blocked); alpha's coordinator w1Z:p1 is done.
show("w1B:p1", "claude-bash.txt");
show("w2Z:p1", "codex-command.txt");

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, ["--write-burst", "100", "--write-per-min", "600"], { STUB_SCREENS: screens });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const state = async () => (await fetch(url + "/api/state")).json();
const promptOf = async (key) => {
  const s = await state();
  if (key.startsWith("hub:")) return s.projects.find((p) => p.slug === key.slice(4)).coordinator.prompt;
  return s.threads.find((t) => t.key === key).prompt;
};
async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
async function openPanel(page, key) {
  await page.evaluate((k) => window.hd.select(k), key);
  await page.waitForSelector("#prompt-card:not([hidden]) .pc-opt");
}
const status = (page, sel = "#prompt-card") => page.locator(`${sel} .pc-status`).innerText();

test("state: blocked panes carry their parsed prompt, others none; only blocked panes are parsed", async () => {
  // P1
  const p = await waitFor(() => promptOf("alpha/t-0002"));
  assert.equal(p.kind, "permission");
  assert.equal(p.harness, "claude");
  assert.equal(p.summary, "Permission: Bash ls -la /etc/hostname && wc -l notes.txt");
  assert.deepEqual(p.options.map((o) => o.label), ["Yes", "Yes, allow reading from /etc from this project", "Yes, and switch to auto mode", "No"]);
  const co = await waitFor(() => promptOf("hub:beta"));
  assert.equal(co.harness, "codex");
  assert.equal(co.subject, "printf 'hi\\n' > out.txt");
  const s = await state();
  for (const t of s.threads.filter((t) => t.key !== "alpha/t-0002")) assert.equal(t.prompt, undefined, t.key);
  assert.equal(s.projects.find((p) => p.slug === "alpha").coordinator.prompt, undefined);
  // With no panel open, only the blocked panes are read.
  const read = new Set(log.lines().filter((l) => l.startsWith("herdr pane read")).map((l) => l.split(" ")[3]));
  assert.deepEqual([...read].sort(), ["w1B:p1", "w2Z:p1"]);
});

test("answer API: server-side keys, sig check, text rules, refusals", async () => {
  // P3, P4, P6
  const p = await promptOf("alpha/t-0002");
  let m = log.mark();
  let r = await post(url, "/api/thread/alpha/t-0002/answer", { sig: "0000000000000000", option: 0 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /prompt_changed/);
  for (const [body, code] of [
    [{ sig: p.sig, option: 9 }, 400],
    [{ sig: p.sig, option: -1 }, 400],
    [{ option: 0 }, 400],
    [{ sig: p.sig, option: 0, text: "hello" }, 400], // "Yes" takes no text
  ]) assert.equal((await post(url, "/api/thread/alpha/t-0002/answer", body)).status, code, JSON.stringify(body));
  assert.equal((await post(url, "/api/thread/alpha/t-0002/answer", { sig: p.sig, option: 0 }, { Origin: "http://evil.example" })).status, 403);
  assert.deepEqual(log.since(m), [], "nothing sent");
  // Keys come from the server's parse: extra fields are ignored.
  r = await post(url, "/api/thread/alpha/t-0002/answer", { sig: p.sig, option: 3, keys: ["esc"] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 4`]);

  // A text option: pick it, then type and press Enter, in that order.
  show("w1B:p1", "claude-fetch.txt");
  const f = await waitFor(async () => { const x = await promptOf("alpha/t-0002"); return x?.title === "Fetch" && x; });
  m = log.mark();
  r = await post(url, "/api/thread/alpha/t-0002/answer", { sig: f.sig, option: 2, text: "use curl instead" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 3`, `${hp} thread keys alpha t-0002 enter --text=use curl instead`]);
  // A required text may not be empty; control characters are refused.
  show("w1B:p1", "claude-other.txt");
  const o = await waitFor(async () => { const x = await promptOf("alpha/t-0002"); return x?.question === "Which color?" && x; });
  m = log.mark();
  assert.equal((await post(url, "/api/thread/alpha/t-0002/answer", { sig: o.sig, option: 2 })).status, 400);
  assert.equal((await post(url, "/api/thread/alpha/t-0002/answer", { sig: o.sig, option: 2, text: "a\nb" })).status, 400);
  assert.deepEqual(log.since(m), []);
  // A pane with no prompt any more.
  show("w1B:p1", null);
  m = log.mark();
  r = await post(url, "/api/thread/alpha/t-0002/answer", { sig: o.sig, option: 0 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /prompt_gone/);
  assert.deepEqual(log.since(m), []);
  show("w1B:p1", "claude-bash.txt");
});

test("panel card: labelled options, exact keys, cleared / not cleared", async () => {
  // P2, P3, P5
  show("w1B:p1", "claude-bash.txt");
  const page = await open();
  await openPanel(page, "alpha/t-0002");
  const card = page.locator("#prompt-card");
  assert.match(await card.locator(".pc-kind").innerText(), /permission/i);
  assert.equal(await card.locator(".pc-q").innerText(), "Do you want to proceed?");
  assert.equal(await card.locator(".pc-subject").innerText(), "ls -la /etc/hostname && wc -l notes.txt");
  assert.deepEqual(await card.locator(".pc-opt .lbl").allInnerTexts(), ["Yes", "Yes, allow reading from /etc from this project", "Yes, and switch to auto mode", "No"]);
  assert.deepEqual(await card.locator(".pc-opt").evaluateAll((bs) => bs.map((b) => b.classList.contains("always"))), [false, true, true, false]);
  assert.equal(await card.locator(".pc-opt.current .lbl").innerText(), "Yes");
  // The card sits above the screen.
  const [cy, sy] = await page.evaluate(() => [document.querySelector("#prompt-card").getBoundingClientRect().top, document.querySelector("#p-chat .screen").getBoundingClientRect().top]);
  assert.ok(cy < sy, "card above the screen");
  await page.screenshot({ path: join(artifacts, "prompt-card.png") });

  // Answer "Yes": the pane clears, the card says so and goes away.
  let m = log.mark();
  await card.locator(".pc-opt", { hasText: /^1\s*Yes$/ }).click();
  await waitFor(() => log.since(m).includes(`${hp} thread keys alpha t-0002 1`), 4000);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 1`]);
  await waitFor(async () => /checking/i.test(await status(page)), 3000);
  show("w1B:p1", null);
  await waitFor(async () => /cleared/i.test(await status(page)), 6000);
  await waitFor(async () => !(await card.isVisible()), 6000);

  // A prompt that stays after the answer: the card says so.
  show("w1B:p1", "claude-edit.txt");
  await page.waitForSelector("#prompt-card:not([hidden]) .pc-opt");
  assert.match(await card.locator(".pc-detail").innerText(), /\+hello world/);
  assert.equal(await card.locator(".pc-detail .add").count(), 1, "diff lines coloured");
  m = log.mark();
  await card.locator(".pc-opt").nth(2).click();
  await waitFor(() => log.since(m).includes(`${hp} thread keys alpha t-0002 3`), 4000);
  await waitFor(async () => /still/i.test(await status(page)), 12000);
  assert.ok(await card.isVisible());
  await page.screenshot({ path: join(artifacts, "prompt-card-still.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("panel card: text options and multi-select", async () => {
  // P6, P7
  show("w1B:p1", "claude-question.txt");
  const page = await open();
  await openPanel(page, "alpha/t-0002");
  const card = page.locator("#prompt-card");
  await waitFor(async () => /question/i.test(await card.locator(".pc-kind").innerText()), 6000);
  assert.equal(await card.locator(".pc-opt", { hasText: "Postgres" }).locator(".desc").innerText(), "Full-featured relational database server.");
  // "Type something." is a field, not a bare button.
  const field = card.locator(".pc-text input");
  assert.equal(await field.count(), 1);
  let m = log.mark();
  await field.fill("CockroachDB");
  await card.locator(".pc-text button").click();
  await waitFor(() => log.since(m).length >= 2, 4000);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 4`, `${hp} thread keys alpha t-0002 enter --text=CockroachDB`]);

  // Multi-select: a click toggles (and waits for the tick), Submit submits.
  show("w1B:p1", "claude-multiselect.txt");
  await waitFor(async () => (await card.locator(".pc-q").innerText()) === "Which features do you want to enable?", 6000);
  assert.deepEqual(await card.locator(".pc-opt[aria-pressed]").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-pressed"))), ["true", "false", "true"]);
  m = log.mark();
  await card.locator(".pc-opt", { hasText: "Metrics" }).click();
  await waitFor(() => log.since(m).includes(`${hp} thread keys alpha t-0002 2`), 4000);
  writeFileSync(join(screens, "w1B_p1"), fixture("claude-multiselect.txt").replace("[ ] Metrics", "[✔] Metrics"));
  await waitFor(async () => (await card.locator(".pc-opt", { hasText: "Metrics" }).getAttribute("aria-pressed")) === "true", 6000);
  assert.doesNotMatch(await status(page), /still/i);
  m = log.mark();
  await card.locator(".pc-opt.submit").click();
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 down down down down enter`]);
  await page.screenshot({ path: join(artifacts, "prompt-card-multi.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("strip: summary on the chip, answered from a popover without the panel", async () => {
  // P8
  show("w1B:p1", "claude-bash.txt");
  const page = await open();
  const chip = page.locator('#needs .chip[data-key="alpha/t-0002"]');
  await waitFor(async () => /Permission: Bash ls -la/.test(await chip.innerText()), 6000);
  await page.locator('#needs .chip-answer[data-key="alpha/t-0002"]').click();
  const pop = page.locator("#prompt-pop");
  await pop.locator(".pc-opt").first().waitFor();
  assert.equal(await page.locator("#panel.open").count(), 0, "panel stays closed");
  await page.screenshot({ path: join(artifacts, "prompt-popover.png") });
  const m = log.mark();
  await pop.locator(".pc-opt", { hasText: /^1\s*Yes$/ }).click();
  await waitFor(() => log.since(m).includes(`${hp} thread keys alpha t-0002 1`), 4000);
  show("w1B:p1", null);
  await waitFor(async () => /cleared/i.test(await status(page, "#prompt-pop")), 8000);
  // The graph's tooltip names the prompt too.
  show("w1B:p1", "claude-bash.txt");
  await waitFor(async () => (await promptOf("alpha/t-0002"))?.title === "Bash command");
  await page.evaluate(() => document.querySelector('svg g.node[data-key="alpha/t-0002"]').dispatchEvent(new MouseEvent("mouseenter", { clientX: 300, clientY: 300 })));
  await waitFor(async () => /Permission: Bash/.test(await page.locator("#tip").innerText()), 4000);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("coordinator: card answered with herdr pane send-keys on the verified pane only", async () => {
  // P9
  show("w2Z:p1", "codex-command.txt");
  const page = await open();
  await openPanel(page, "hub:beta");
  const card = page.locator("#prompt-card");
  assert.match(await card.locator(".pc-subject").innerText(), /printf/);
  let m = log.mark();
  await card.locator(".pc-opt").first().click();
  await waitFor(() => log.since(m).some((l) => l.startsWith("herdr pane send-keys")), 4000);
  assert.deepEqual(log.since(m), ["herdr pane get w2Z:p1", "herdr pane send-keys w2Z:p1 1"]);
  show("w2Z:p1", null);
  await waitFor(async () => /cleared/i.test(await status(page)), 8000);
  await page.screenshot({ path: join(artifacts, "prompt-coordinator.png") });
  await page.close();

  // A text option on a coordinator: keys, then send-text and Enter.
  show("w2Z:p1", "codex-command.txt");
  const p = await waitFor(() => promptOf("hub:beta"));
  m = log.mark();
  let r = await post(url, "/api/project/beta/answer", { sig: p.sig, option: 2, text: "run it in a temp dir" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(log.since(m), ["herdr pane get w2Z:p1", "herdr pane send-keys w2Z:p1 3", "herdr pane send-text w2Z:p1 run it in a temp dir", "herdr pane send-keys w2Z:p1 enter"]);
  // Raw keys for a blocked coordinator, allow-listed.
  m = log.mark();
  assert.equal((await post(url, "/api/project/beta/keys", { keys: ["down", "enter"] })).status, 200);
  assert.equal((await post(url, "/api/project/beta/keys", { keys: ["ctrl+c"] })).status, 400);
  assert.equal((await post(url, "/api/project/beta/keys", { keys: ["enter;ls"] })).status, 400);
  assert.deepEqual(log.since(m), ["herdr pane get w2Z:p1", "herdr pane send-keys w2Z:p1 down enter"]);
  // Not blocked (alpha's coordinator is done), or blocked no more: refused.
  m = log.mark();
  r = await post(url, "/api/project/alpha/keys", { keys: ["enter"] });
  assert.equal(r.status, 409);
  writeFileSync(join(screens, "w2Z_p1.status"), "working");
  r = await post(url, "/api/project/beta/answer", { sig: p.sig, option: 0 });
  assert.equal(r.status, 409);
  rmSync(join(screens, "w2Z_p1.status"));
  // No coordinator pane at all (gamma), unknown project.
  assert.equal((await post(url, "/api/project/gamma/keys", { keys: ["enter"] })).status, 409);
  assert.equal((await post(url, "/api/project/nope/keys", { keys: ["enter"] })).status, 404);
  assert.ok(!log.since(m).some((l) => /send-(keys|text)/.test(l)), "nothing pressed");
  // A trust screen is the user's to answer in the pane.
  show("w2Z:p1", "codex-trust.txt");
  const t = await waitFor(async () => { const x = await promptOf("hub:beta"); return x?.kind === "trust" && x; });
  m = log.mark();
  assert.equal((await post(url, "/api/project/beta/answer", { sig: t.sig, option: 0 })).status, 403);
  assert.ok(!log.since(m).some((l) => /send-(keys|text)/.test(l)));
  show("w2Z:p1", "codex-command.txt");
});

test("notifications: opt-in, only new prompts, once each", async () => {
  // P10
  show("w1B:p1", "claude-bash.txt");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.__notes = [];
    window.Notification = class { constructor(title, o) { window.__notes.push([title, o && o.body]); } static requestPermission() { return Promise.resolve("granted"); } };
    window.Notification.permission = "granted";
  });
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.waitForTimeout(2500);
  assert.deepEqual(await page.evaluate(() => window.__notes), [], "off by default");
  await page.locator("#voice-gear, #voice-settings-btn, [data-voice-settings]").first().click();
  await page.locator("#vs-notify").check();
  await page.waitForTimeout(2500);
  assert.deepEqual(await page.evaluate(() => window.__notes), [], "not for prompts already there");
  show("w1B:p1", "claude-fetch.txt");
  await waitFor(async () => (await page.evaluate(() => window.__notes)).length === 1, 8000);
  await page.waitForTimeout(2500);
  const notes = await page.evaluate(() => window.__notes);
  assert.equal(notes.length, 1, "once");
  assert.match(notes[0][0], /Permission: Fetch https:\/\/example\.com\//);
  await page.close();
  show("w1B:p1", "claude-bash.txt");
});

// A scripted SpeechRecognition, as in voice.test.mjs.
function mockSpeech() {
  const instances = [];
  class MockRec extends EventTarget {
    constructor() { super(); this.continuous = false; this.interimResults = false; this.lang = ""; this._on = false; instances.push(this); }
    start() { this._on = true; setTimeout(() => this._fire("start"), 0); }
    stop() { if (!this._on) return; this._on = false; setTimeout(() => this._fire("end"), 0); }
    abort() { this.stop(); }
    _fire(type, props = {}) { const e = new Event(type); Object.assign(e, props); this.dispatchEvent(e); this["on" + type]?.(e); }
  }
  window.SpeechRecognition = MockRec;
  window.webkitSpeechRecognition = MockRec;
  window.__speech = {
    say(text) {
      const r = [...instances].reverse().find((i) => i._on);
      if (!r) throw new Error("nobody is listening");
      const res = [{ transcript: text, confidence: 0.9 }];
      res.isFinal = true;
      r._results ??= [];
      r._results.push(res);
      r._fire("result", { resultIndex: r._results.length - 1, results: [...r._results] });
      if (!r.continuous) r.stop();
    },
  };
}

test("voice: allow / option N answer the open prompt; always allow asks first", async () => {
  // P11
  show("w1B:p1", "claude-bash.txt");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(mockSpeech);
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  await openPanel(page, "alpha/t-0002");
  await waitFor(async () => (await page.locator("#prompt-card .pc-subject").innerText()).startsWith("ls -la"), 6000);
  await page.keyboard.press("Alt+KeyV");
  await page.waitForSelector("#voice-fab.listening");
  const say = (t) => page.evaluate((x) => window.__speech.say(x), t);
  let m = log.mark();
  await say("allow");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 1`]);
  // The answer cleared nothing (same screen): wait for the card to settle.
  await waitFor(async () => /still/i.test(await status(page)), 12000);
  m = log.mark();
  await say("option four");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 4`]);
  await waitFor(async () => /still/i.test(await status(page)), 12000);
  // "Always allow" is a lasting grant: confirm first.
  m = log.mark();
  await say("always allow");
  await page.waitForSelector("#voice-hud .confirm");
  assert.deepEqual(log.since(m), []);
  await say("no");
  await page.waitForTimeout(500);
  assert.deepEqual(log.since(m), []);
  await say("always allow");
  await page.waitForSelector("#voice-hud .confirm");
  await say("yes");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 2`]);
  await page.close();
});

test("phone: the card and the popover fit", async () => {
  // P12
  show("w1B:p1", "claude-edit.txt");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.evaluate(() => window.hd.select("alpha/t-0002"));
  await page.waitForSelector("#prompt-card:not([hidden]) .pc-opt");
  const over = await page.evaluate(() => [...document.querySelectorAll("#prompt-card, #prompt-card *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
  assert.equal(over, 0, "nothing wider than the screen");
  await page.locator("#prompt-card").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "prompt-phone.png") });
  await page.close();
});

test("only allow-listed commands ran; coordinator keys only on its pane", () => {
  // P3, P9
  const allowed = [
    /^herdr-projects --root \S+ (list|thread list \S+ --json|progress --pane \S+|safety show \S+)$/,
    /^herdr pane list$/,
    /^herdr pane read \S+ --source recent --lines \d+( --format ansi)?$/,
    /^gh pr list /,
    /^herdr-projects --root \S+ thread keys [a-z]+ t-\d{4}( (enter|esc|up|down|left|right|tab|space|backspace|y|n|\d))+( --text=.*)?$/,
    /^herdr pane get w2Z:p1$/,
    /^herdr pane get w1Z:p1$/,
    /^herdr pane send-keys w2Z:p1( (enter|esc|up|down|left|right|tab|space|backspace|y|n|\d))+$/,
    /^herdr pane send-text w2Z:p1 .+$/,
  ];
  const calls = log.lines();
  for (const c of calls) assert.ok(allowed.some((re) => re.test(c)), `unexpected command: ${c}`);
  assert.ok(!calls.some((c) => /^herdr agent/.test(c)), "no herdr agent writes");
  writeFileSync(join(artifacts, "prompt-calls.log"), calls.join("\n") + "\n");
});
