// E2E for the window tray and window docks: any number of windows fit the
// tray (wrapped rows, "+N" and a list of all), tray buttons reorder by drag,
// the tray itself moves to another edge or corner; windows dock right, left
// or bottom (drag onto the edge, the dock button or Alt+Shift+D), as tabs or
// a resizable split, reorder, drag out to float, move between docks, and all
// of it survives a reload. Phones show docked windows as tabs of one sheet.
// Artifacts land in e2e/artifacts/dock-*.
//
// Ways this could fail, written before the feature existed:
//  D1. With 6-10 windows some tray buttons are cut off or scrolled out of
//      sight with no "+N" or list to reach them, or the tray runs under the
//      header, the voice button or off the screen.
//  D2. Dragging a tray button does not reorder it, the order is lost, or the
//      drag also fires a click (restoring or minimising a window).
//  D3. The tray cannot be moved, lands half off-screen, or its place is lost.
//  D4. Docking (drag onto an edge, dock button) fails, or past ~4 windows the
//      dock runs out of room: tabs cut off or hidden.
//  D5. Tabs do not reorder, the split stack cannot be resized, or a resize
//      squeezes a pane to nothing.
//  D6. A docked window cannot be dragged out to float again or into another
//      dock; or it is lost (closed, duplicated) on the way.
//  D7. A reload loses the docks, the order, the tray place or open windows.
//  D8. Keys do not dock, float or switch tabs, or the ? help omits them.
//  D9. On a phone docked windows spill off the screen or are unreachable.
// D10. A drag forces a layout read on every pointer move (thrash).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-dock-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");

let url, srv, browser, ctx, keys;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog);
  keys = await waitFor(async () => { const s = await (await fetch(url + "/api/state")).json(); return s.threads.length >= 10 && s.threads.map((t) => t.key).slice(0, 10); });
  browser = await chromium.launch();
  // One context: localStorage carries over between pages, as across reloads.
  ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
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
const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; });
const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
async function drag(page, from, to, steps = 8) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
const layout = (page) => page.evaluate(() => window.HDWin.layout());
const trayIds = (page) => page.locator("#win-tray .wt-item").evaluateAll((l) => l.map((e) => e.dataset.win));
const tabIds = (page, side) => page.locator(`.wdock[data-side="${side}"] .wd-tab`).evaluateAll((l) => l.map((e) => e.dataset.win));
// visible: on screen and the top element at its centre is itself (or inside it).
const reachable = (loc) => loc.evaluate((e) => {
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height || r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) return false;
  if (getComputedStyle(e).visibility === "hidden") return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (e === hit || e.contains(hit));
});

test("tray: ten windows all reachable, reorder by drag, tray moves to a corner", async () => {
  const page = await open();
  await page.evaluate((ks) => ks.forEach((k) => window.HDThreadWin.open(k)), keys);
  const ids = keys.map((k) => "thread:" + k);
  await waitFor(async () => (await page.locator(".hwin").count()) === 10, 4000);
  // D1: every window has a tray button that is visible, or is counted in +N
  // and listed in the menu.
  const items = page.locator("#win-tray .wt-item");
  assert.equal(await items.count(), 10);
  let shown = 0;
  for (let i = 0; i < 10; i++) if (await reachable(items.nth(i))) shown++;
  const more = page.locator("#win-tray .wt-more");
  assert.ok(await reachable(more), "+N / list button reachable");
  const hidden = 10 - shown;
  assert.ok(shown >= 4, `at least four buttons show (${shown})`);
  assert.equal((await more.innerText()).trim(), hidden ? `+${hidden}` : "≡");
  const tray = await rect(page.locator("#win-tray"));
  const head = await rect(page.locator("header#top"));
  const fab = await rect(page.locator("#voice-fab"));
  assert.ok(tray.x >= 0 && tray.r <= 1024 && tray.b <= 700, `tray on screen ${JSON.stringify(tray)}`);
  assert.ok(tray.y >= head.b, "tray clear of the header");
  assert.ok(tray.x >= fab.r || tray.b <= fab.y, "tray clear of the voice button");
  await page.screenshot({ path: join(artifacts, "dock-tray-10.png") });
  // The list holds all ten; a hidden one opens from it.
  await more.click();
  const menu = page.locator("#wt-menu .wt-menu-item");
  assert.equal(await menu.count(), 10);
  const last = ids[9];
  await page.locator(`#wt-menu .wt-menu-item[data-win="${last}"]`).click();
  assert.equal(await page.evaluate(() => window.HDWin.active()?.id), last);
  assert.ok(await page.locator("#wt-menu").isHidden(), "menu closes");

  // D2: drag the first button after the third; nothing is restored or minimised.
  const before = await trayIds(page);
  const act = await page.evaluate(() => window.HDWin.active()?.id);
  const mins = await page.locator(".hwin.min").count();
  const b0 = await rect(items.nth(0)), b2 = await rect(items.nth(2));
  await drag(page, center(b0), [b2.r - 4, b2.y + b2.h / 2]);
  const after1 = await trayIds(page);
  assert.deepEqual(after1, [before[1], before[2], before[0], ...before.slice(3)]);
  assert.deepEqual((await layout(page)).order.slice(0, 3), after1.slice(0, 3));
  assert.equal(await page.evaluate(() => window.HDWin.active()?.id), act, "drag did not click");
  assert.equal(await page.locator(".hwin.min").count(), mins);

  // D3: the grip moves the tray to the top-right corner, fully on screen.
  const grip = await rect(page.locator("#win-tray .wt-grip"));
  await drag(page, center(grip), [1000, 120]);
  assert.equal(await page.locator("#win-tray").getAttribute("data-pos"), "tr");
  const moved = await rect(page.locator("#win-tray"));
  assert.ok(moved.r <= 1024 && moved.r > 900 && moved.y >= 0 && moved.y < 200, `top right ${JSON.stringify(moved)}`);
  // And to the left edge: a vertical column.
  const grip2 = await rect(page.locator("#win-tray .wt-grip"));
  await drag(page, center(grip2), [10, 400]);
  assert.equal(await page.locator("#win-tray").getAttribute("data-pos"), "l");
  const col = await rect(page.locator("#win-tray"));
  assert.ok(col.h > col.w && col.x >= 0 && col.b <= 700, `left column ${JSON.stringify(col)}`);
  shown = 0;
  for (let i = 0; i < 10; i++) if (await reachable(items.nth(i))) shown++;
  const more2 = (await more.innerText()).trim();
  assert.equal(more2, shown < 10 ? `+${10 - shown}` : "≡");
  await page.screenshot({ path: join(artifacts, "dock-tray-left.png") });
  // Back to the bottom-left for the next tests.
  const grip3 = await rect(page.locator("#win-tray .wt-grip"));
  await drag(page, center(grip3), [300, 690]);
  assert.equal(await page.locator("#win-tray").getAttribute("data-pos"), "bl");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("dock: six windows docked right as tabs, reorder, split, move, undock, keys", async () => {
  const page = await open();
  await page.setViewportSize({ width: 1440, height: 900 });
  // The windows from the last test came back after the reload (D7).
  await waitFor(async () => (await page.locator(".hwin").count()) === 10, 6000);
  const ids = keys.map((k) => "thread:" + k);
  const win = (id) => page.locator(`.hwin[data-win="${id}"]`);
  // D4: drag the first window's title bar onto the right edge.
  await page.evaluate((id) => window.HDWin.restore(id), ids[0]);
  const bar = await rect(win(ids[0]).locator(".hw-title"));
  const grid = await rect(page.locator("#dockgrid"));
  // D10: count layout reads while the drag moves.
  await page.evaluate(() => {
    window.__reads = 0;
    const g = (window.__gbcr = Element.prototype.getBoundingClientRect);
    // Only the window layer's reads count (the graph lays itself out too).
    Element.prototype.getBoundingClientRect = function () { if (/windows\.js/.test(new Error().stack)) window.__reads++; return g.call(this); };
  });
  await page.mouse.move(bar.x + 20, bar.y + bar.h / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + 40, bar.y + bar.h / 2, { steps: 2 });
  // Pointer moves arrive with the next frame: let the drag start first.
  const startReads = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__reads)))));
  await page.mouse.move(grid.r - 10, grid.y + 200, { steps: 30 });
  const moveReads = (await page.evaluate(() => window.__reads)) - startReads;
  assert.ok(moveReads <= 2, `no layout reads per move (${moveReads} over 30 moves)`);
  assert.ok(await page.locator("#dock-hint").isVisible(), "drop hint shows");
  await page.screenshot({ path: join(artifacts, "dock-drag-hint.png") });
  await page.mouse.up();
  await page.evaluate(() => { Element.prototype.getBoundingClientRect = window.__gbcr; });
  await waitFor(async () => (await tabIds(page, "right")).length === 1, 2000);
  assert.ok(await page.locator(`.wdock[data-side="right"] .hwin[data-win="${ids[0]}"]`).isVisible());
  // Five more with the dock button: it docks where the last one went.
  for (const id of ids.slice(1, 6)) {
    await page.evaluate((id) => window.HDWin.restore(id), id);
    await win(id).locator(".hw-dock").click();
  }
  assert.deepEqual(await tabIds(page, "right"), ids.slice(0, 6));
  // The four still floating step aside (they float above the docks).
  await page.evaluate((rest) => rest.forEach((id) => window.HDWin.minimise(id)), ids.slice(6));
  const dockR = await rect(page.locator('.wdock[data-side="right"]'));
  assert.ok(dockR.r <= 1440 + 1 && dockR.w >= 220, `right dock ${JSON.stringify(dockR)}`);
  for (const id of ids.slice(0, 6)) assert.ok(await reachable(page.locator(`.wd-tab[data-win="${id}"]`)), `tab ${id} reachable`);
  // One pane shows at a time; a tab click switches.
  assert.equal(await page.locator('.wdock[data-side="right"] .hwin:visible').count(), 1);
  await page.locator(`.wd-tab[data-win="${ids[2]}"]`).click();
  assert.ok(await win(ids[2]).isVisible());
  assert.equal(await page.locator('.wdock[data-side="right"] .hwin:visible').count(), 1);
  // The graph still has room beside the dock.
  const stage = await rect(page.locator("#stage"));
  assert.ok(stage.w > 200 && stage.r <= dockR.x + 1, "graph beside the dock");
  await page.screenshot({ path: join(artifacts, "dock-right-6-tabs.png") });

  // D5: drag the first tab after the fourth.
  let t0 = await rect(page.locator(`.wd-tab[data-win="${ids[0]}"]`));
  let t3 = await rect(page.locator(`.wd-tab[data-win="${ids[3]}"]`));
  await drag(page, center(t0), [t3.r - 3, t3.y + t3.h / 2]);
  const reordered = [ids[1], ids[2], ids[3], ids[0], ids[4], ids[5]];
  assert.deepEqual(await tabIds(page, "right"), reordered);
  // Split: every pane shows, stacked, and a gutter resizes two of them.
  await page.locator('.wdock[data-side="right"] .wd-mode').click();
  assert.equal(await page.locator('.wdock[data-side="right"]').getAttribute("data-mode"), "split");
  assert.equal(await page.locator('.wdock[data-side="right"] .hwin:visible').count(), 6);
  const p0 = await rect(win(reordered[0])), p1 = await rect(win(reordered[1]));
  assert.ok(p1.y >= p0.b - 1, "stacked");
  const gut = await rect(page.locator('.wdock[data-side="right"] .wd-gut').first());
  await drag(page, center(gut), [gut.x + gut.w / 2, gut.y + 30]);
  const q0 = await rect(win(reordered[0])), q1 = await rect(win(reordered[1]));
  assert.ok(Math.abs(q0.h - p0.h - 30) <= 3 && Math.abs(p1.h - q1.h - 30) <= 3, `resized ${p0.h}->${q0.h}, ${p1.h}->${q1.h}`);
  // A big drag stops short of squeezing the neighbour to nothing.
  const gut2 = await rect(page.locator('.wdock[data-side="right"] .wd-gut').first());
  await drag(page, center(gut2), [gut2.x + gut2.w / 2, gut2.y + 900]);
  assert.ok((await rect(win(reordered[1]))).h >= 40, "neighbour keeps a minimum");
  // Reorder split panes by their title bars: the first one after the second.
  const pb = await rect(win(reordered[0]).locator(".hw-title"));
  const pn = await rect(win(reordered[1]));
  await drag(page, [pb.x + 30, pb.y + pb.h / 2], [pn.x + 60, pn.b - 5]);
  assert.deepEqual((await tabIds(page, "right")).slice(0, 2), [reordered[1], reordered[0]]);
  await page.screenshot({ path: join(artifacts, "dock-right-split.png") });
  await page.locator('.wdock[data-side="right"] .wd-mode').click();

  // D6: a tab dragged onto the bottom edge lands in a bottom dock...
  const moving = reordered[5];
  const tm = await rect(page.locator(`.wd-tab[data-win="${moving}"]`));
  const g2 = await rect(page.locator("#dockgrid"));
  await drag(page, center(tm), [g2.x + g2.w / 3, g2.b - 8], 20);
  assert.deepEqual(await tabIds(page, "bottom"), [moving]);
  assert.ok(!(await tabIds(page, "right")).includes(moving));
  assert.equal(await page.locator(`.hwin[data-win="${moving}"]`).count(), 1, "not duplicated");
  // ...and a tab dragged into the middle of the graph floats again.
  const floating = reordered[4];
  const tf = await rect(page.locator(`.wd-tab[data-win="${floating}"]`));
  const st = await rect(page.locator("#stage"));
  await drag(page, center(tf), [st.x + st.w / 2, st.y + st.h / 3], 20);
  assert.ok(!(await tabIds(page, "right")).includes(floating));
  assert.equal(await win(floating).evaluate((e) => e.parentElement.id), "win-layer");
  const fr = await rect(win(floating));
  assert.ok(Math.abs(fr.y - (st.y + st.h / 3)) < 40, "floats where it was dropped");

  // D8: Alt+Shift+D on the floating window docks it right, then left,
  // bottom, and floats it again; Alt+] / Alt+[ step through the tabs.
  await win(floating).locator(".hw-title").click();
  await page.keyboard.press("Alt+Shift+KeyD");
  assert.ok((await tabIds(page, "right")).includes(floating), "docked right");
  await page.keyboard.press("Alt+Shift+KeyD");
  assert.deepEqual(await tabIds(page, "left"), [floating]);
  await page.keyboard.press("Alt+Shift+KeyD");
  assert.ok((await tabIds(page, "bottom")).includes(floating));
  await page.keyboard.press("Alt+Shift+KeyD");
  assert.equal(await win(floating).evaluate((e) => e.parentElement.id), "win-layer");
  await page.locator(`.wd-tab[data-win="${reordered[0]}"]`).click();
  const activeTab = (side) => page.locator(`.wdock[data-side="${side}"] .wd-tab.active`).getAttribute("data-win");
  const right = await tabIds(page, "right");
  const i0 = right.indexOf(await activeTab("right"));
  await page.keyboard.press("Alt+BracketRight");
  assert.equal(await activeTab("right"), right[(i0 + 1) % right.length]);
  await page.keyboard.press("Alt+BracketLeft");
  await page.keyboard.press("Alt+BracketLeft");
  assert.equal(await activeTab("right"), right[(i0 + right.length - 1) % right.length]);
  await page.locator("body").click({ position: { x: 400, y: 20 } });
  await page.keyboard.press("?");
  const help = await page.locator("#voice-help").innerText();
  assert.match(help, /Alt\+Shift\+D/);
  assert.match(help, /Alt\+\]/);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(artifacts, "dock-two-docks.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reload keeps the docks, the order, the tray and the open windows", async () => {
  // D7
  const page = await open();
  await waitFor(async () => (await page.locator(".hwin").count()) === 10, 6000);
  const before = await layout(page);
  const tabsR = await tabIds(page, "right"), tabsB = await tabIds(page, "bottom");
  const tray = await trayIds(page);
  const act = await page.locator('.wdock[data-side="right"] .wd-tab.active').getAttribute("data-win");
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await waitFor(async () => (await page.locator(".hwin").count()) === 10, 6000);
  await waitFor(async () => (await tabIds(page, "right")).length === tabsR.length, 3000);
  assert.deepEqual(await tabIds(page, "right"), tabsR);
  assert.deepEqual(await tabIds(page, "bottom"), tabsB);
  assert.deepEqual(await trayIds(page), tray);
  assert.equal(await page.locator('.wdock[data-side="right"] .wd-tab.active').getAttribute("data-win"), act);
  assert.equal(await page.locator("#win-tray").getAttribute("data-pos"), "bl");
  assert.deepEqual(await layout(page), before);
  // Each docked window is still a live thread window, not an empty shell.
  assert.ok(await page.locator(`.hwin[data-win="${act}"] .screen`).isVisible());
  await page.screenshot({ path: join(artifacts, "dock-after-reload.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("phone: docked windows are tabs of one full-width sheet", async () => {
  // D9: same saved layout, phone viewport.
  const state = await ctx.storageState();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state });
  const page = await open(phone);
  await waitFor(async () => (await page.locator(".hwin").count()) === 10, 6000);
  const L = await layout(page);
  const docked = [...L.docks.right.ids, ...L.docks.left.ids, ...L.docks.bottom.ids];
  const sheet = page.locator('.wdock[data-side="sheet"]');
  assert.equal(await page.locator('.wdock[data-side="right"]:visible, .wdock[data-side="left"]:visible, .wdock[data-side="bottom"]:visible').count(), 0);
  // The tray reaches every window; a docked one brings the sheet forward.
  await page.locator("#win-tray .wt-more").tap();
  assert.equal(await page.locator("#wt-menu .wt-menu-item").count(), 10);
  await page.screenshot({ path: join(artifacts, "dock-phone-list.png") });
  await page.locator(`#wt-menu .wt-menu-item[data-win="${docked[1]}"]`).tap();
  await waitFor(() => sheet.isVisible(), 3000);
  assert.deepEqual(await tabIds(page, "sheet"), docked);
  // One sheet at a time: the floating ones step behind it.
  assert.equal(await page.locator("#win-layer > .hwin:visible").count(), 0);
  const s = await rect(sheet);
  assert.equal(Math.round(s.x), 0);
  assert.equal(Math.round(s.w), 390);
  assert.ok(s.b <= 844 + 1);
  assert.equal(await page.locator('.wdock[data-side="sheet"] .hwin:visible').count(), 1);
  assert.ok(await page.locator(`.wdock[data-side="sheet"] .hwin[data-win="${docked[1]}"]`).isVisible());
  for (const id of docked) assert.ok(await reachable(page.locator(`.wd-tab[data-win="${id}"]`)), `tab ${id} reachable`);
  const over = await page.evaluate(() => [...document.querySelectorAll('.wdock[data-side="sheet"] *, #win-tray *')]
    .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().right > innerWidth + 1).length);
  assert.equal(over, 0, "nothing wider than the screen");
  await page.screenshot({ path: join(artifacts, "dock-phone.png") });
  // Another tab switches the sheet.
  await page.locator(`.wd-tab[data-win="${docked[0]}"]`).tap();
  assert.ok(await page.locator(`.wdock[data-side="sheet"] .hwin[data-win="${docked[0]}"]`).isVisible());
  assert.deepEqual(page.errors, []);
  await phone.close();
});
