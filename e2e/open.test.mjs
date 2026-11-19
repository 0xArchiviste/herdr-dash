// E2E: how a thread opens. "Open" on a Threads card opens the thread's own
// floating window (or brings it back to the front, near the card); a split
// menu beside it opens it in a window, the docked panel, or a detached
// browser window (/thread/<slug>/<id>) that streams on its own; the choice
// can become the default (the menu or ⚙), and every place that opens a
// thread follows that default. Ctrl/Cmd- or middle-click pops out.
// The real herdr-dash binary runs on a copy of the fixtures with stubbed
// herdr-projects / herdr / gh / memex. Artifacts: e2e/artifacts/open-*.png,
// open.json.
//
// Ways it could fail, written before it existed:
//  O1. Open still opens the panel, opens a second window for a thread that
//      already has one, or leaves it minimised or behind other windows.
//  O2. The window opens far from the card (the last cascade spot), or under
//      the panel.
//  O3. The menu cannot be reached or left by keyboard, an item does
//      something else than it says, or the menu stays open after a choice.
//  O4. The default is lost on reload, or the menu and ⚙ disagree about it.
//  O5. The pop-out page shows the whole dashboard (graph, strip, panel), a
//      window you can lose instead of the full page, no live screen, no
//      input box or View/Raw; or it is frozen at load (no deltas).
//  O6. The pop-out page writes its layout over the main tab's (the thread
//      window reopened in the main tab on its next load).
//  O7. A thread resolved while popped out leaves a live-looking page with
//      an input box, or the page never closes.
//  O8. Ctrl/Cmd-click or middle-click opens a window in the page (or the
//      browser's own new tab of the page) instead of the pop-out.
//  O9. Some places ignore the default: the graph, the Needs-you strip, the
//      coordinator panel's report list, Blocked-on-you, the Master window,
//      search results; or the graph changes without a default being set.
// O10. Phones: a window is not a sheet, or pop-out asks for a popup window
//      instead of a new tab.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { td, stub, artifacts, startServer, freePort, waitFor } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-open-"));
const root = join(tmp, "root"), stubDir = join(tmp, "stub"), log = join(tmp, "calls"), screens = join(tmp, "screens");
const listFile = join(stubDir, "thread-list-alpha.json");
const KEY = "alpha/t-0002";
let server, url, browser;
const out = {};

before(async () => {
  cpSync(join(td, "root"), root, { recursive: true });
  cpSync(stub, stubDir, { recursive: true });
  mkdirSync(screens);
  writeFileSync(log, "");
  writeFileSync(join(screens, "w1A_p1"), "● Building the widget pipeline\n  step 3 of 7\n\n❯ \n");
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = startServer(port, log, ["--root", root, "--herdr", join(stubDir, "herdr"), "--memex-per-min", "600"],
    { HERDR_DASH_HERDR_PROJECTS: join(stubDir, "herdr-projects"), HERDR_DASH_MEMEX: join(stubDir, "memex"), STUB_SCREENS: screens });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0, 15_000);
  browser = await chromium.launch();
});
after(async () => {
  writeFileSync(join(artifacts, "open.json"), JSON.stringify(out, null, 2) + "\n");
  await browser?.close();
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

// A fresh browser context per page (its own localStorage), window.open
// recorded, and the default preset when given.
async function openPage({ pref, viewport = { width: 1440, height: 900 }, ...opts } = {}) {
  const ctx = await browser.newContext({ viewport, ...opts });
  await ctx.addInitScript((p) => {
    window.__opens = [];
    const o = window.open;
    window.open = function (...a) { window.__opens.push(a.map((x) => (x == null ? null : String(x)))); return o.apply(this, a); };
    if (p && !sessionStorage.getItem("pref-set")) { localStorage.setItem("hd-open-mode", p); sessionStorage.setItem("pref-set", "1"); }
  }, pref || null);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
const win = (page, key) => page.locator(`.hwin[data-win="thread:${key}"]`);
const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; });
const selected = (page) => page.evaluate(() => window.hd.selected());
const hasWin = (page, key) => page.evaluate((k) => HDWin.has("thread:" + k), key);
async function coordPanel(page) {
  await page.evaluate(() => window.hd.select("hub:alpha"));
  await page.waitForSelector(`#p-tv .tv-card[data-key="${KEY}"] .tv-open`);
}
const card = (page, key = KEY) => page.locator(`#p-tv .tv-card[data-key="${key}"]`);
function setThread(id, patch) {
  const list = JSON.parse(readFileSync(listFile, "utf8"));
  Object.assign(list.find((t) => t.id === id), patch);
  writeFileSync(listFile, JSON.stringify(list));
  // Touch a thread file so the collector lists again.
  writeFileSync(join(root, "alpha", "threads", "t-0001.md"), "changed " + Date.now() + "\n");
}

test("Open opens the thread's window near its card, and brings it back (O1, O2)", async () => {
  const page = await openPage();
  await coordPanel(page);
  await card(page).locator(".tv-open").click();
  await page.waitForSelector(`.hwin[data-win="thread:${KEY}"]:not(.min)`);
  assert.equal(await selected(page), "hub:alpha", "the panel stays on the coordinator");
  const c = await rect(card(page)), w = await rect(win(page, KEY));
  out.near = { card: c, win: w };
  assert.ok(Math.min(Math.abs(w.x - c.r), Math.abs(w.r - c.x)) <= 24, `beside the card: ${JSON.stringify(out.near)}`);
  assert.ok(w.y <= c.y + 2 && w.b > c.y, `level with the card's top, or as low as it fits: ${JSON.stringify(out.near)}`);
  assert.ok(w.b <= 900, "on screen");
  assert.ok(w.r <= c.x + 2 || w.x >= c.r - 2, "not over the card");
  await page.screenshot({ path: join(artifacts, "open-window.png") });

  // Minimised, then behind another window: Open restores it to the front.
  await win(page, KEY).locator(".hw-min").click();
  await page.waitForSelector(`.hwin[data-win="thread:${KEY}"].min`, { state: "attached" });
  await card(page).locator(".tv-report").click();
  await page.waitForSelector(`.hwin[data-win="report:${KEY}"]`);
  await card(page).locator(".tv-open").click();
  await page.waitForSelector(`.hwin[data-win="thread:${KEY}"].active:not(.min)`);
  assert.equal(await page.locator(`.hwin[data-win="thread:${KEY}"]`).count(), 1);
  assert.equal(await page.evaluate(() => HDWin.active().id), "thread:" + KEY);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("the Open menu: window, panel or a new browser window, by mouse and keys (O3)", async () => {
  const page = await openPage();
  await coordPanel(page);
  const more = card(page).locator(".ho-more");
  assert.match(await more.getAttribute("aria-label"), /t-0002/);
  await more.click();
  const menu = page.locator("#open-menu");
  await menu.waitFor();
  const items = await menu.locator('[role="menuitem"]').evaluateAll((es) => es.map((e) => [e.dataset.how, e.textContent]));
  out.menu = items;
  assert.deepEqual(items.map((i) => i[0]), ["window", "panel", "popout"]);
  assert.match(items[0][1], /Open in window/);
  assert.match(items[1][1], /Open in panel/);
  assert.match(items[2][1], /Pop out to a new browser window/);
  assert.equal(await menu.locator('[role="menuitemcheckbox"]').count(), 1, "make this the default");
  await page.screenshot({ path: join(artifacts, "open-menu.png") });
  // Keys: the first item has the focus, arrows move, Esc closes back to the button.
  assert.equal(await page.evaluate(() => document.activeElement.dataset.how), "window");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.how), "panel");
  await page.keyboard.press("Escape");
  assert.equal(await menu.isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("ho-more")), true);
  assert.equal(await selected(page), "hub:alpha", "Esc in the menu leaves the panel alone");

  // Panel, by keys.
  await more.click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await selected(page)) === KEY, 3000);
  assert.equal(await menu.isHidden(), true);
  assert.equal(await hasWin(page, KEY), false);

  // Window.
  await page.evaluate(() => window.hd.select("hub:alpha"));
  await card(page).locator(".ho-more").click();
  await menu.locator('[data-how="window"]').click();
  await page.waitForSelector(`.hwin[data-win="thread:${KEY}"]`);

  // A new browser window: a popup of the single-thread page.
  const [pop] = await Promise.all([page.waitForEvent("popup"), (async () => { await card(page).locator(".ho-more").click(); await menu.locator('[data-how="popout"]').click(); })()]);
  await pop.waitForLoadState();
  assert.equal(new URL(pop.url()).pathname, "/thread/alpha/t-0002");
  const opens = await page.evaluate(() => window.__opens);
  assert.equal(opens.length, 1);
  assert.match(opens[0][2] || "", /popup/, "a window, not a tab");
  await pop.waitForSelector(`.hwin.solo-win[data-win="thread:${KEY}"]`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("the default is kept, and the menu and ⚙ agree (O4)", async () => {
  const page = await openPage();
  await coordPanel(page);
  await card(page).locator(".ho-more").click();
  const menu = page.locator("#open-menu");
  const remember = menu.locator('[role="menuitemcheckbox"]');
  await remember.click();
  assert.equal(await remember.getAttribute("aria-checked"), "true");
  assert.equal(await menu.isVisible(), true, "ticking keeps the menu open");
  await menu.locator('[data-how="panel"]').click();
  await waitFor(async () => (await selected(page)) === KEY, 3000);
  assert.equal(await page.evaluate(() => localStorage.getItem("hd-open-mode")), "panel");

  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await coordPanel(page);
  assert.match(await card(page).locator(".tv-open").getAttribute("title"), /panel/i);
  await card(page).locator(".tv-open").click();
  await waitFor(async () => (await selected(page)) === KEY, 3000);
  assert.equal(await hasWin(page, KEY), false);
  await page.evaluate(() => window.hd.select("hub:alpha"));
  await card(page).locator(".ho-more").click();
  assert.match(await menu.locator('[data-how="panel"]').textContent(), /default/i);
  await page.keyboard.press("Escape");

  // ⚙ shows the same, and changes it.
  await page.click("#voice-settings-btn");
  const sel = page.locator("#vs-open-mode");
  assert.equal(await sel.inputValue(), "panel");
  await sel.selectOption("window");
  assert.equal(await page.evaluate(() => localStorage.getItem("hd-open-mode")), "window");
  await sel.selectOption("");
  assert.equal(await page.evaluate(() => localStorage.getItem("hd-open-mode")), null, "each place's own default again");
  await page.click("#voice-settings-close");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("Ctrl-click pops out; the page streams, keeps out of the main layout and closes when resolved (O5–O8)", async () => {
  const page = await openPage();
  await coordPanel(page);
  const open1 = card(page, "alpha/t-0001").locator(".tv-open");
  // Middle-click: a pop-out, never the browser's own tab of the page.
  const [pop0] = await Promise.all([page.waitForEvent("popup"), open1.click({ button: "middle" })]);
  await pop0.waitForLoadState();
  assert.equal(new URL(pop0.url()).pathname, "/thread/alpha/t-0001");
  await pop0.close();
  const [pop] = await Promise.all([page.waitForEvent("popup"), open1.click({ modifiers: ["ControlOrMeta"] })]);
  assert.equal(await hasWin(page, "alpha/t-0001"), false, "no window in the page");
  assert.equal(await page.evaluate(() => window.__opens.length), 2);
  pop.errors = [];
  pop.on("pageerror", (e) => pop.errors.push(e.message));
  await pop.setViewportSize({ width: 900, height: 700 });
  await pop.waitForSelector('body.solo .hwin.solo-win[data-win="thread:alpha/t-0001"]');
  const W = pop.locator('.hwin[data-win="thread:alpha/t-0001"]');
  // Full-size, alone on the page.
  await waitFor(async () => { const r = await rect(W); return r.x <= 0 && r.y <= 0 && r.w >= 898 && r.h >= 698; }, 3000);
  for (const s of ["#graph", "#needs-wrap", "#filters", "#top", "#panel", "#win-tray"]) assert.equal(await pop.locator(s).isVisible(), false, s + " hidden");
  // Live screen, input box, View/Raw.
  await waitFor(async () => /Building the widget pipeline/.test(await W.evaluate((w) => w.querySelector(".tw-pane, .hw-body").innerText)), 8000)
    .catch(async (e) => { console.log(await W.evaluate((w) => w.innerText)); throw e; });
  assert.equal(await W.locator(".tw-input").isVisible(), true);
  assert.equal(await W.locator('.tw-mode-btn[data-mode="view"]').getAttribute("aria-pressed"), "true");
  assert.equal(await W.locator('.tw-mode-btn[data-mode="raw"]').isEnabled(), true);
  assert.equal(await W.locator(".tw-panel").count() ? await W.locator(".tw-panel").isVisible() : false, false, "no panel to go to");
  assert.match(await pop.title(), /t-0001/);
  assert.match(await pop.title(), /Widget pipeline/);
  await pop.screenshot({ path: join(artifacts, "open-popout.png") });
  // Not in the main tab's layout.
  const layout = await page.evaluate(() => JSON.parse(localStorage.getItem("hd-win-layout") || "{}"));
  assert.ok(!(layout.open || []).includes("thread:alpha/t-0001"), "the pop-out kept its layout to itself");

  // Deltas reach it: a new title.
  setThread("t-0001", { title: "Widget pipeline v2" });
  await waitFor(async () => /Widget pipeline v2/.test(await pop.title()), 10_000);
  // Resolved: the page says so, takes the input away, and closes.
  const closed = new Promise((r) => pop.once("close", r));
  setThread("t-0001", { status: "resolved", group: "Resolved", group_token: "resolved" });
  await pop.waitForSelector(".solo-gone", { timeout: 10_000 });
  assert.match(await pop.locator(".solo-gone").innerText(), /resolved/i);
  assert.equal(await W.locator(".tw-input").count() ? await W.locator(".tw-input").isVisible() : false, false);
  await pop.screenshot({ path: join(artifacts, "open-popout-resolved.png") });
  assert.deepEqual(pop.errors, []);
  await Promise.race([closed, new Promise((_, j) => setTimeout(() => j(new Error("the pop-out did not close")), 8000))]);
  setThread("t-0001", { title: "Widget pipeline", status: "open", group: "Working", group_token: "working" });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a pop-out page opened directly shows the thread; an unknown thread says so (O5)", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url + "/thread/alpha/t-0003");
  await page.waitForSelector('body.solo .hwin.solo-win[data-win="thread:alpha/t-0003"]');
  await page.goto(url + "/coordinator/alpha");
  await page.waitForSelector('body.solo .hwin.solo-win[data-win="thread:hub:alpha"]');
  assert.match(await page.title(), /coordinator/i);
  await page.goto(url + "/thread/alpha/t-0999");
  await page.waitForSelector(".solo-gone", { timeout: 10_000 });
  assert.match(await page.locator(".solo-gone").innerText(), /t-0999/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("without a default, each place keeps its own way; the graph and strip stay on the panel (O9)", async () => {
  const page = await openPage();
  // Graph: the panel.
  await page.evaluate((k) => document.querySelector(`svg g.node[data-key="${k}"]`).dispatchEvent(new MouseEvent("click", { bubbles: true })), "alpha/t-0001");
  await waitFor(async () => (await selected(page)) === "alpha/t-0001", 3000);
  assert.equal(await hasWin(page, "alpha/t-0001"), false);
  // Needs-you strip: the panel.
  await page.locator(`#needs .chip[data-key="${KEY}"]`).click();
  await waitFor(async () => (await selected(page)) === KEY, 3000);
  assert.equal(await hasWin(page, KEY), false);
  // Master window rows: the coordinator's window.
  await page.click("#master-open");
  await page.click('.hwin[data-win="master"] #fl-table tr[data-slug="alpha"] .fl-name');
  await page.waitForFunction(() => HDWin.has("thread:hub:alpha"));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a window default: graph, strip, reports, search and the system list open windows (O9)", async () => {
  const page = await openPage({ pref: "window" });
  const noPanel = async () => assert.equal(await page.locator("#panel.open").count(), 0);
  await page.evaluate((k) => document.querySelector(`svg g.node[data-key="${k}"]`).dispatchEvent(new MouseEvent("click", { bubbles: true })), "alpha/t-0001");
  await page.waitForFunction(() => HDWin.has("thread:alpha/t-0001"));
  await noPanel();
  await page.locator(`#needs .chip[data-key="${KEY}"]`).click();
  await page.waitForFunction((k) => HDWin.has("thread:" + k), KEY);
  await noPanel();
  // A coordinator chip: its window too.
  await page.evaluate(() => { for (const id of HDWin.list()) HDWin.close(id); });
  // The coordinator panel's report list.
  await page.evaluate(() => window.hd.select("hub:alpha"));
  await page.waitForSelector("#p-reports button.open-thread", { state: "attached" });
  const rk = await page.locator("#p-reports details").first().getAttribute("data-key");
  await page.locator("#p-reports details").first().locator("summary").click();
  await page.locator("#p-reports details").first().locator("button.open-thread").click();
  await page.waitForFunction((k) => HDWin.has("thread:" + k), rk);
  assert.equal(await selected(page), "hub:alpha");
  // Content search results.
  await page.click("#search-mode");
  await page.locator("#f-search").pressSequentially("zephyr", { delay: 30 });
  await page.waitForSelector('#search-results .hit[data-key="alpha/t-0005"]');
  await page.locator('#search-results .hit[data-key="alpha/t-0005"]').first().click();
  await page.waitForFunction(() => HDWin.has("thread:alpha/t-0005"));
  assert.equal(await selected(page), "hub:alpha");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a panel default: Open, Blocked-on-you and the Master window open the panel (O9)", async () => {
  const page = await openPage({ pref: "panel" });
  await coordPanel(page);
  await page.locator(`#p-tv .tv-blocked button[data-id="t-0002"]`).click();
  await waitFor(async () => (await selected(page)) === KEY, 3000);
  assert.equal(await hasWin(page, KEY), false);
  await page.click("#master-open");
  await page.click('.hwin[data-win="master"] #fl-table tr[data-slug="beta"] .fl-name');
  await waitFor(async () => (await selected(page)) === "hub:beta", 3000);
  assert.equal(await hasWin(page, "hub:beta"), false);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a pop-out default: the strip pops out (O9)", async () => {
  const page = await openPage({ pref: "popout" });
  const [pop] = await Promise.all([page.waitForEvent("popup"), page.locator(`#needs .chip[data-key="${KEY}"]`).click()]);
  await pop.waitForLoadState();
  assert.equal(new URL(pop.url()).pathname, "/thread/alpha/t-0002");
  assert.equal(await selected(page), null);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("phones: a window is a sheet, a pop-out a new tab (O10)", async () => {
  const page = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await coordPanel(page);
  await card(page).locator(".tv-open").tap();
  await page.waitForSelector(`.hwin[data-win="thread:${KEY}"]`);
  const w = await rect(win(page, KEY));
  assert.ok(w.w >= 380, "a sheet, full width: " + JSON.stringify(w));
  await page.evaluate((k) => HDWin.close("thread:" + k), KEY);
  await card(page).locator(".ho-more").tap();
  const [pop] = await Promise.all([page.waitForEvent("popup"), page.locator('#open-menu [data-how="popout"]').tap()]);
  await pop.waitForLoadState();
  const opens = await page.evaluate(() => window.__opens);
  assert.equal(opens.length, 1);
  assert.doesNotMatch(opens[0][2] || "", /popup/, "a tab on a phone");
  await pop.waitForSelector(`.hwin.solo-win[data-win="thread:${KEY}"]`);
  const pw = await rect(pop.locator(`.hwin[data-win="thread:${KEY}"]`));
  assert.ok(pw.w >= 380 && pw.x <= 0, "full width: " + JSON.stringify(pw));
  await pop.screenshot({ path: join(artifacts, "open-popout-phone.png") });
  const sw = await pop.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(sw <= 391, "no sideways scroll: " + sw);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
