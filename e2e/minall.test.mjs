// E2E for "Minimise all" / "Restore all": one button in the window tray (and
// its list) or Alt+Shift+M hides every floating window, every dock and the
// side panel so the graph gets the whole screen; the same again brings back
// exactly the layout before. New permission prompts still pop up meanwhile,
// the state survives a reload, and a phone keeps its tray. Artifacts land in
// e2e/artifacts/minall-*.
//
// Ways this could fail, written before the feature existed:
//  M1. A floating window, a dock, a docked tab or the side panel stays on
//      screen, or the graph does not grow into the room they left.
//  M2. Restore all loses something: a floating window's place, a dock's
//      tabs, their order, the active tab, the dock's size or mode, which
//      windows were minimised before, or the panel and what it showed.
//  M3. The button is missing from the tray or its list, does not say which
//      way it acts, or the tray disappears with nothing left to restore.
//  M4. Alt+Shift+M does nothing, or acts only one way; ? help omits it.
//  M5. A reload forgets that everything was minimised (windows and docks
//      come back), or forgets the layout to restore.
//  M6. A new permission prompt stays hidden while all is minimised.
//  M7. On a phone the sheet or the panel stays up, or the tray goes too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-minall-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
mkdirSync(screens);
writeFileSync(stubLog, "");

let url, srv, browser, ctx, keys;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, [], { STUB_SCREENS: screens });
  keys = await waitFor(async () => { const s = await (await fetch(url + "/api/state")).json(); return s.threads.length >= 6 && s.threads.map((t) => t.key).filter((k) => k !== "alpha/t-0002").slice(0, 5); });
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
});
after(async () => {
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

async function open(c = ctx) {
  const page = await c.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
const layout = (page) => page.evaluate(() => { const L = window.HDWin.layout(); delete L.hidden; return L; });
const visibleWins = (page) => page.locator(".hwin").evaluateAll((l) => l.filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden").map((e) => e.dataset.win));
const visibleDocks = (page) => page.locator(".wdock").evaluateAll((l) => l.filter((e) => e.getClientRects().length).map((e) => e.dataset.side));
const panelOpen = (page) => page.locator("#panel").evaluate((e) => e.classList.contains("open"));
const allBtn = (page) => page.locator("#win-tray .wt-all");
// The graph's box once the panel's slide has settled.
async function graph(page) {
  let last = null;
  return waitFor(async () => { const r = await rect(page.locator("#graph")); const same = last && JSON.stringify(r) === JSON.stringify(last); last = r; return same && r; }, 4000);
}

let before_ = null; // the layout to come back to
test("minimise all hides windows, docks and the panel; restore all brings back the same layout", async () => {
  const page = await open();
  const ids = keys.slice(0, 4).map((k) => "thread:" + k);
  await page.evaluate((ks) => ks.slice(0, 4).forEach((k) => window.HDThreadWin.open(k)), keys);
  await page.evaluate(() => window.HDRouting.open());
  await waitFor(async () => (await page.locator(".hwin").count()) === 5, 4000);
  // Two tabs on the right (the first shown), one at the bottom, one thread
  // window and the routing window floating, one of them minimised before.
  await page.evaluate((ids) => {
    HDWin.dock(ids[0], "right"); HDWin.dock(ids[1], "right"); HDWin.dock(ids[2], "bottom");
    HDWin.restore(ids[0]);
    HDWin.minimise("routing");
  }, ids);
  await page.evaluate(() => window.hd.select(window.hd.state().threads.find((t) => t.key !== "alpha/t-0002" && !document.querySelector(`.hwin[data-win="thread:${t.key}"]`)).key));
  const sel = await page.evaluate(() => window.hd.selected());
  // M3: the tray offers it.
  assert.ok(await allBtn(page).isVisible());
  assert.match(await allBtn(page).innerText(), /Minimise all/i);
  before_ = await layout(page);
  const g0 = await graph(page);
  const float0 = await rect(page.locator(`.hwin[data-win="${ids[3]}"]`));
  const shown0 = (await visibleWins(page)).sort();
  assert.deepEqual(shown0, [ids[0], ids[2], ids[3]].sort());
  await page.screenshot({ path: join(artifacts, "minall-before.png") });

  await allBtn(page).click();
  // M1: nothing left on top of or beside the graph; the tray stays.
  await waitFor(async () => (await visibleWins(page)).length === 0, 3000);
  assert.deepEqual(await visibleDocks(page), []);
  assert.equal(await panelOpen(page), false);
  const g1 = await graph(page);
  assert.ok(g1.w > g0.w + 200 && g1.h > g0.h + 100, `graph grows ${JSON.stringify(g0)} -> ${JSON.stringify(g1)}`);
  // The work area fills all the room the docks shared.
  assert.deepEqual(await rect(page.locator("#work")), await rect(page.locator("#dockgrid")));
  assert.equal(g1.x + g1.w, 1280);
  assert.ok(await page.locator("#win-tray").isVisible(), "tray stays");
  assert.match(await allBtn(page).innerText(), /Restore all/i);
  await page.screenshot({ path: join(artifacts, "minall-hidden.png") });

  // M2: back as it was.
  await allBtn(page).click();
  await waitFor(async () => (await visibleWins(page)).length === 3, 3000);
  assert.deepEqual((await visibleWins(page)).sort(), shown0);
  assert.deepEqual(await layout(page), before_);
  assert.deepEqual(await rect(page.locator(`.hwin[data-win="${ids[3]}"]`)), float0);
  assert.equal(await page.locator('.wdock[data-side="right"] .wd-tab.active').getAttribute("data-win"), ids[0]);
  assert.equal(await panelOpen(page), true);
  assert.equal(await page.evaluate(() => window.hd.selected()), sel);
  assert.deepEqual(await graph(page), g0);
  assert.match(await allBtn(page).innerText(), /Minimise all/i);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("Alt+Shift+M toggles, the tray list offers it, ? help lists it, a reload keeps it", async () => {
  const page = await open();
  await waitFor(async () => (await page.locator(".hwin").count()) === 5, 6000);
  // M4
  await page.keyboard.press("Alt+Shift+M");
  await waitFor(async () => (await visibleWins(page)).length === 0, 3000);
  assert.deepEqual(await visibleDocks(page), []);
  // M5: a reload keeps everything minimised, and the layout to restore.
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await waitFor(async () => (await page.locator(".hwin").count()) === 5, 6000);
  assert.deepEqual(await visibleWins(page), []);
  assert.deepEqual(await visibleDocks(page), []);
  assert.match(await allBtn(page).innerText(), /Restore all/i);
  // M3: the list carries the same action.
  await page.locator("#win-tray .wt-more").click();
  const item = page.locator("#wt-menu .wt-menu-all");
  assert.match(await item.innerText(), /Restore all/i);
  await item.click();
  await waitFor(async () => (await visibleWins(page)).length === 3, 3000);
  assert.deepEqual(await layout(page), before_);
  await page.keyboard.press("Alt+Shift+M");
  await waitFor(async () => (await visibleWins(page)).length === 0, 3000);
  await page.keyboard.press("Alt+Shift+M");
  await waitFor(async () => (await visibleWins(page)).length === 3, 3000);
  assert.deepEqual(await layout(page), before_);
  // ? help
  await page.keyboard.press("Shift+?");
  await page.waitForSelector("#voice-help:not([hidden])");
  assert.match(await page.locator("#voice-help").innerText(), /Alt\+Shift\+M/);
  await page.keyboard.press("Escape");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("a new permission prompt still pops up while all is minimised", async () => {
  // M6
  const page = await open();
  await waitFor(async () => (await page.locator(".hwin").count()) === 5, 6000);
  await page.keyboard.press("Alt+Shift+M");
  await waitFor(async () => (await visibleWins(page)).length === 0, 3000);
  writeFileSync(join(screens, "w1B_p1"), readFileSync(join(td, "prompts", "claude-bash.txt"), "utf8"));
  const id = "prompt:alpha/t-0002";
  await waitFor(async () => (await visibleWins(page)).includes(id), 10000);
  assert.deepEqual(await visibleWins(page), [id]);
  assert.deepEqual(await visibleDocks(page), []);
  await page.screenshot({ path: join(artifacts, "minall-prompt.png") });
  // Restore all brings the rest back around it.
  await page.keyboard.press("Alt+Shift+M");
  await waitFor(async () => (await visibleWins(page)).length === 4, 3000);
  const L = await layout(page);
  assert.deepEqual(L.docks, before_.docks);
  rmSync(join(screens, "w1B_p1"));
  await page.evaluate((id) => HDWin.close(id), id);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("phone: minimise all closes the sheet and the panel, the tray stays", async () => {
  // M7
  const state = await ctx.storageState();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state });
  const page = await open(phone);
  await waitFor(async () => (await page.locator(".hwin").count()) === 5, 6000);
  await page.evaluate(() => { const L = HDWin.layout(); HDWin.restore(L.docks.right.ids[0]); });
  await waitFor(() => page.locator('.wdock[data-side="sheet"]').isVisible(), 3000);
  await page.evaluate(() => window.hd.select(window.hd.state().threads[0].key));
  assert.equal(await panelOpen(page), true);
  await allBtn(page).tap();
  await waitFor(async () => (await visibleWins(page)).length === 0, 3000);
  assert.deepEqual(await visibleDocks(page), []);
  assert.equal(await panelOpen(page), false);
  assert.ok(await page.locator("#win-tray").isVisible());
  const t = await rect(page.locator("#win-tray"));
  assert.ok(t.x >= 0 && t.x + t.w <= 390, `tray on screen ${JSON.stringify(t)}`);
  await page.screenshot({ path: join(artifacts, "minall-phone.png") });
  await allBtn(page).tap();
  await waitFor(() => page.locator('.wdock[data-side="sheet"]').isVisible(), 3000);
  assert.deepEqual(page.errors, []);
  await phone.close();
});
