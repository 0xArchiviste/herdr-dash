// E2E for the two modes of a pane window: View (the default, made for a
// browser: nothing reaches the pane but an explicit send, local scrolling over
// everything loaded, live output that never moves a reader who scrolled up)
// and Raw (a terminal: every key goes to the pane, the view follows it).
// The stub herdr serves the screens the test writes (STUB_SCREENS) and, like
// herdr 0.9.3, reads back at most 1000 lines (STUB_READ_MAX).
// Artifacts: e2e/artifacts/panemode-*.png and panemode.json.
//
// Ways this could fail, written before the feature existed:
//  M1. View mode sends something to the pane on a wheel, click, arrow, Tab,
//      Enter or letter typed over the screen (anything but the input box).
//  M2. Loading earlier output stops early, loses the reader's place, or says
//      "start of the pane's history" when herdr's read limit cut it short.
//  M3. Output arriving while the reader is scrolled up moves them (a burst
//      bigger than one live read replaces the buffer and yanks the view), or
//      the rows that arrived are not counted on the jump button.
//  M4. End or the jump button does not reach the newest row; the counter
//      does not reset.
//  M5. The input box needs Ctrl+Enter, sends on Shift+Enter, or forgets its
//      history.
//  M6. Raw mode drops arrows, Tab or Ctrl keys, or sends them out of order.
//  M7. Raw mode starts on a working agent without asking, or a cancelled
//      question still switches it on.
//  M8. Esc-Esc does not leave raw mode, sends Esc to the pane on the way out,
//      or a single Esc closes the window instead of reaching the pane.
//  M9. The mode is shared by every window, not kept per window, or lost on a
//      reload; a reload puts a working agent back in raw mode unasked.
// M10. A key reaches a pane other than the one the window showed.
// M11. On a phone the toggle or the jump button is off screen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-panemode-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
mkdirSync(screens);
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const hp = "herdr-projects --root " + join(td, "root");
const f = (pane) => join(screens, pane.replace(":", "_"));
const rows = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `row ${a + i} of the transcript`).join("\n") + "\n";
// alpha/t-0003 (w1C:p1): a live agent that is done, with a long transcript.
// alpha/t-0001 (w1A:p1): a live agent at work.
writeFileSync(f("w1C:p1"), rows(1, 1500));
writeFileSync(f("w1A:p1"), rows(1, 80) + "✻ Working… (esc to interrupt)\n");
writeFileSync(join(screens, "alpha_t-0003.pane"), "w1C_p1");
writeFileSync(join(screens, "alpha_t-0001.pane"), "w1A_p1");
const out = {};

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, ["--write-burst", "200", "--write-per-min", "600"], { STUB_SCREENS: screens, STUB_READ_MAX: "1000" });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  writeFileSync(join(artifacts, "panemode.json"), JSON.stringify(out, null, 2) + "\n");
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const sent = (m) => log.since(m).filter((l) => / pane send-(text|keys) /.test(l));
async function open(viewport = { width: 1440, height: 900 }, ctx) {
  const page = await (ctx || browser).newPage({ viewport });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
async function win(page, key) {
  await page.evaluate((k) => window.HDThreadWin.open(k), key);
  const w = page.locator(`.hwin[data-win="thread:${key}"]`);
  await w.locator(".screen .tl").first().waitFor({ timeout: 10_000 });
  return w;
}
// The screen box's state: rows, the row at its top edge, scroll position.
const box = (w) => w.locator(".screen").evaluate((pre) => {
  const r = pre.getBoundingClientRect();
  let top = null;
  for (const t of pre.querySelectorAll(".tl")) { const b = t.getBoundingClientRect(); if (b.bottom > r.top + 2) { top = t.textContent; break; } }
  const n = (s) => +(/row (\d+)/.exec(s || "")?.[1] || 0);
  const nums = [...pre.querySelectorAll(".tl")].map((t) => n(t.textContent)).filter(Boolean);
  return { count: nums.length, first: nums[0], last: nums[nums.length - 1], top: n(top), gaps: nums.some((v, i) => i && v !== nums[i - 1] + 1),
    pinned: pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8, scrollTop: pre.scrollTop };
});
const mode = (w) => w.evaluate((e) => e.dataset.mode);

test("view mode is the default and forwards nothing but the input box", async () => {
  // M1
  const page = await open();
  const w = await win(page, "alpha/t-0003");
  assert.equal(await mode(w), "view");
  assert.equal(await w.locator('.tw-mode [data-mode="view"]').getAttribute("aria-pressed"), "true");
  assert.equal(await w.locator(".tw-raw-badge").isVisible(), false);
  const m = log.mark();
  const pre = w.locator(".screen");
  await pre.hover();
  await page.mouse.wheel(0, -400);
  await page.mouse.wheel(0, 400);
  await pre.click();
  for (const k of ["a", "b", "ArrowUp", "ArrowDown", "Tab", "Enter", "PageUp", "Control+c", "End"]) await page.keyboard.press(k);
  await page.waitForTimeout(800);
  assert.deepEqual(sent(m), []);
  assert.ok(log.since(m).every((l) => !/thread (prompt|keys)/.test(l)), log.since(m).join("\n"));
  // No keys mode pad in a window: Raw mode replaces it.
  assert.equal(await w.locator(".ht-mode").count(), 0);
  // Text selection is the browser's own.
  const sel = await pre.evaluate((e) => { const r = document.createRange(); r.selectNodeContents(e.querySelector(".tl")); getSelection().removeAllRanges(); getSelection().addRange(r); return getSelection().toString(); });
  assert.match(sel, /row \d+ of the transcript/);
  await w.screenshot({ path: join(artifacts, "panemode-view.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("load earlier goes back to herdr's read limit and says so", async () => {
  // M2
  const page = await open();
  const w = await win(page, "alpha/t-0003");
  const pre = w.locator(".screen");
  let b = await box(w);
  assert.equal(b.last, 1500);
  assert.ok(b.count <= 60, "the live read is short: " + b.count);
  for (let i = 0; i < 6 && (await box(w)).first > 501; i++) {
    await pre.evaluate((e) => { e.scrollTop = 0; });
    const before = await box(w);
    await pre.evaluate((e) => e.dispatchEvent(new Event("scroll")));
    await waitFor(async () => (await box(w)).first < before.first, 10_000);
    // The row the reader was looking at stays in view.
    const after = await box(w);
    assert.ok(Math.abs(after.top - before.top) <= 2, `kept place: ${before.top} -> ${after.top}`);
  }
  b = await box(w);
  assert.equal(b.first, 501, "herdr reads back 1000 lines");
  assert.equal(b.gaps, false);
  const note = await w.locator(".screen-top").innerText();
  out.loadEarlierNote = note;
  assert.doesNotMatch(note, /Start of the pane/);
  assert.match(note, /1000/);
  await page.close();
});

test("output never moves a reader scrolled up; the counter and End jump to it", async () => {
  // M3, M4
  writeFileSync(f("w1C:p1"), rows(1, 1500));
  const page = await open();
  const w = await win(page, "alpha/t-0003");
  const pre = w.locator(".screen");
  await waitFor(async () => (await box(w)).last === 1500);
  await pre.evaluate((e) => { e.scrollTop = Math.floor((e.scrollHeight - e.clientHeight) / 2); });
  await page.waitForTimeout(300);
  const at = await box(w);
  assert.equal(at.pinned, false);
  // A few new rows: appended, counted, not followed.
  appendFileSync(f("w1C:p1"), rows(1501, 1505));
  const jump = w.locator(".new-output");
  await waitFor(async () => /5 new/.test(await jump.innerText()), 8000);
  assert.match(await jump.innerText(), /Jump to latest \(5 new\)/);
  let b = await box(w);
  assert.equal(b.top, at.top, "not yanked by a small update");
  // A burst bigger than one live read: still no yank, nothing lost between.
  appendFileSync(f("w1C:p1"), rows(1506, 1805));
  await waitFor(async () => /305 new/.test(await jump.innerText()), 10_000);
  b = await box(w);
  assert.equal(b.top, at.top, "not yanked by a burst");
  assert.equal(b.gaps, false, "rows between the reads were fetched");
  assert.ok(b.first <= at.top, "older rows kept");
  out.burst = { top: b.top, first: b.first, last: b.last, label: await jump.innerText() };
  await w.screenshot({ path: join(artifacts, "panemode-jump.png") });
  // End jumps to the newest row and the counter goes.
  await pre.focus();
  await page.keyboard.press("End");
  await waitFor(async () => (await box(w)).pinned, 3000);
  assert.equal((await box(w)).last, 1805);
  assert.equal(await jump.isHidden(), true);
  // Pinned at the bottom, new output is followed.
  appendFileSync(f("w1C:p1"), rows(1806, 1810));
  await waitFor(async () => (await box(w)).last === 1810, 8000);
  assert.equal((await box(w)).pinned, true);
  assert.equal(await jump.isHidden(), true);
  // The button too.
  await pre.evaluate((e) => { e.scrollTop = 0; });
  appendFileSync(f("w1C:p1"), rows(1811, 1812));
  await jump.waitFor({ state: "visible", timeout: 8000 });
  await jump.click();
  await waitFor(async () => (await box(w)).pinned && (await box(w)).last === 1812, 3000);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("the input box sends on Enter, Shift+Enter adds a line, Up recalls", async () => {
  // M5
  const page = await open();
  const w = await win(page, "alpha/t-0003");
  const input = w.locator(".tw-input");
  let m = log.mark();
  await input.fill("first line");
  await input.press("Shift+Enter");
  await input.pressSequentially("second");
  assert.equal(await input.inputValue(), "first line\nsecond");
  assert.deepEqual(log.since(m).filter((l) => / thread prompt /.test(l)), []);
  await input.press("Enter");
  await waitFor(() => log.since(m).some((l) => l.startsWith(`${hp} thread prompt alpha t-0003`)), 4000);
  await waitFor(async () => (await input.inputValue()) === "", 4000);
  m = log.mark();
  await input.fill("check the logs");
  await input.press("Enter");
  await waitFor(() => log.since(m).some((l) => l.startsWith(`${hp} thread prompt alpha t-0003`)), 4000);
  await waitFor(async () => (await input.inputValue()) === "", 4000);
  await input.press("ArrowUp");
  assert.equal(await input.inputValue(), "check the logs");
  await input.press("ArrowUp");
  assert.equal(await input.inputValue(), "first line\nsecond");
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  assert.equal(await input.inputValue(), "");
  assert.deepEqual(sent(m), [], "a prompt goes through herdr-projects, not raw keys");
  await page.close();
});

test("raw mode forwards every key in order; Esc-Esc leaves it", async () => {
  // M6, M8, M10
  const page = await open();
  const w = await win(page, "alpha/t-0003");
  await w.locator('.tw-mode [data-mode="raw"]').click();
  assert.equal(await mode(w), "raw", "a done agent needs no question");
  assert.equal(await page.locator("#dlg[open]").count(), 0);
  assert.equal(await w.locator(".tw-raw-badge").isVisible(), true);
  assert.match(await w.locator(".tw-raw-hint").innerText(), /wheel/i);
  assert.ok(await w.evaluate((e) => e.classList.contains("raw")));
  let m = log.mark();
  await w.locator(".screen").click();
  await page.keyboard.type("hi");
  for (const k of ["ArrowUp", "Tab", "Shift+Tab", "Control+c", "Enter", "Backspace"]) await page.keyboard.press(k);
  await waitFor(() => sent(m).length >= 7, 4000);
  await page.waitForTimeout(400);
  assert.deepEqual(sent(m), ["herdr pane send-text w1C:p1 hi", "herdr pane send-keys w1C:p1 up", "herdr pane send-keys w1C:p1 tab", "herdr pane send-keys w1C:p1 shift+tab",
    "herdr pane send-keys w1C:p1 ctrl+c", "herdr pane send-keys w1C:p1 enter", "herdr pane send-keys w1C:p1 backspace"]);
  // Ctrl+F is the pane's in raw mode, not find.
  assert.equal(await w.locator(".screen-find").isVisible(), false);
  await w.screenshot({ path: join(artifacts, "panemode-raw.png") });
  // One Esc reaches the pane; the window stays.
  m = log.mark();
  await page.keyboard.press("Escape");
  await waitFor(() => sent(m).length === 1, 4000);
  assert.deepEqual(sent(m), ["herdr pane send-keys w1C:p1 esc"]);
  assert.equal(await w.isVisible(), true);
  assert.equal(await mode(w), "raw");
  // Two quick ones leave raw mode and send nothing.
  m = log.mark();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitFor(async () => (await mode(w)) === "view", 2000);
  await page.waitForTimeout(700);
  assert.deepEqual(sent(m), []);
  assert.equal(await w.isVisible(), true);
  // Back in view mode keys go nowhere again.
  await page.keyboard.type("x");
  await page.waitForTimeout(400);
  assert.deepEqual(sent(m), []);
  // A key for another pane than the window showed is refused.
  const r = await post(url, "/api/thread/alpha/t-0003/term", { mode: "keys", pane: "w1A:p1", seq: [{ text: "x" }] });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.deepEqual(sent(m), []);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("raw mode on a working agent asks first", async () => {
  // M7
  const page = await open();
  const w = await win(page, "alpha/t-0001");
  await w.locator('.tw-mode [data-mode="raw"]').click();
  await page.waitForSelector("#dlg[open]");
  assert.match(await page.locator("#dlg-msg").innerText(), /working/i);
  await page.locator("#dlg-cancel").first().click();
  await waitFor(async () => (await page.locator("#dlg[open]").count()) === 0);
  assert.equal(await mode(w), "view", "cancelled");
  // The shortcut asks the same question.
  await w.locator(".screen").click();
  await page.keyboard.press("Alt+Shift+KeyR");
  await page.waitForSelector("#dlg[open]");
  await page.locator("#dlg-ok").click();
  await waitFor(async () => (await mode(w)) === "raw");
  const m = log.mark();
  await w.locator(".screen").click();
  await page.keyboard.press("Control+c");
  await waitFor(() => sent(m).length === 1, 4000);
  assert.deepEqual(sent(m), ["herdr pane send-keys w1A:p1 ctrl+c"]);
  await page.keyboard.press("Alt+Shift+KeyR");
  await waitFor(async () => (await mode(w)) === "view");
  await page.close();
});

test("the mode is kept per window across a reload", async () => {
  // M9
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page = await open(undefined, ctx);
  const a = await win(page, "alpha/t-0003");
  const b = await win(page, "alpha/t-0001");
  const front = (k) => page.evaluate((id) => window.HDWin.restore(id), "thread:" + k);
  await front("alpha/t-0003");
  await a.locator('.tw-mode [data-mode="raw"]').click();
  await waitFor(async () => (await mode(a)) === "raw");
  assert.equal(await mode(b), "view");
  // t-0001 too, with consent: a reload must ask again before typing into it.
  await front("alpha/t-0001");
  await b.locator('.tw-mode [data-mode="raw"]').click();
  await page.locator("#dlg-ok").click();
  await waitFor(async () => (await mode(b)) === "raw");
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  const a2 = page.locator('.hwin[data-win="thread:alpha/t-0003"]');
  const b2 = page.locator('.hwin[data-win="thread:alpha/t-0001"]');
  await waitFor(async () => (await a2.count()) && (await mode(a2)) === "raw", 10_000);
  await page.waitForSelector("#dlg[open]", { timeout: 10_000 });
  assert.match(await page.locator("#dlg-msg").innerText(), /working/i);
  await page.locator("#dlg-cancel").first().click();
  await waitFor(async () => (await mode(b2)) === "view");
  await page.close();
  await ctx.close();
});

test("help lists the mode keys", async () => {
  const page = await open();
  await page.keyboard.press("?");
  const help = page.locator("#voice-help");
  await help.waitFor();
  const t = await help.innerText();
  assert.match(t, /Alt\+Shift\+R/);
  assert.match(t, /Esc Esc/);
  assert.match(t, /End/);
  await page.close();
});

test("phone: the toggle, the badge and the jump button fit", async () => {
  // M11
  writeFileSync(f("w1C:p1"), rows(1, 1500));
  const page = await open({ width: 390, height: 844 });
  const w = await win(page, "alpha/t-0003");
  const inView = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1; });
  const toggle = w.locator(".tw-mode");
  await toggle.scrollIntoViewIfNeeded();
  assert.ok(await inView(toggle), "toggle on screen");
  await w.locator(".screen").evaluate((e) => { e.scrollTop = 0; });
  appendFileSync(f("w1C:p1"), rows(1501, 1503));
  const jump = w.locator(".new-output");
  await jump.waitFor({ state: "visible", timeout: 8000 });
  assert.ok(await inView(jump), "jump button on screen");
  await page.screenshot({ path: join(artifacts, "panemode-phone-view.png") });
  await w.locator('.tw-mode [data-mode="raw"]').click();
  await waitFor(async () => (await mode(w)) === "raw");
  assert.ok(await inView(w.locator(".tw-raw-badge")), "badge on screen");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "no sideways page scroll");
  await page.screenshot({ path: join(artifacts, "panemode-phone-raw.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});
