// E2E for resizing floating windows: from all four edges and corners (mouse,
// pen, touch), within a minimum (the title bar stays usable) and the
// viewport; content (screen, chat, Threads tab, prompt card) fills the new
// size; double-click on the title bar maximises and restores; Alt+Shift+arrows
// resize the focused window; the size survives a reload and an undock; phones
// get no handles. Artifacts land in e2e/artifacts/resize-*.
//
// Ways this could fail, written before the feature existed:
//  R1. An edge or corner does not resize, resizes the wrong way, or moves the
//      opposite edge; a handle has the wrong cursor.
//  R2. Handles are thick enough to steal title-bar drags or the content's
//      scrollbar.
//  R3. A window shrinks until its title bar or buttons are unusable, or grows
//      past the viewport; a shrinking viewport leaves it off screen.
//  R4. The screen, chat, Threads tab or prompt card keep their old size and
//      leave dead space, or spill out of the window.
//  R5. Double-click does not maximise, or restore loses the old place.
//  R6. Keys do not resize, or the ? help does not list them.
//  R7. A reload or a dock/undock loses the size.
//  R8. A phone shows handles or lets a sheet be resized.
//  R9. A resize reads the layout on every pointer move (thrash).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-resize-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
mkdirSync(screens);
writeFileSync(stubLog, "");
// alpha/t-0002 waits on a permission: its prompt window opens by itself.
writeFileSync(join(screens, "w1B_p1"), readFileSync(join(td, "prompts", "claude-bash-wrapped.txt"), "utf8"));

const W = 1280, H = 800;
let url, srv, browser, ctx, key;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, [], { STUB_SCREENS: screens });
  key = await waitFor(async () => { const s = await (await fetch(url + "/api/state")).json(); return s.threads.find((t) => t.key === "alpha/t-0001")?.key; });
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: W, height: H } });
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
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
async function drag(page, from, to, steps = 8) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
const handle = (win, dir) => win.locator(`.hw-rs[data-dir="${dir}"]`);
// A point on a handle: its middle, nudged to the outside of the window.
async function grab(win, dir) {
  const r = await rect(handle(win, dir));
  return [r.x + r.w / 2, r.y + r.h / 2];
}
async function threadWin(page, k = key) {
  await page.evaluate((k) => window.HDThreadWin.open(k), k);
  const win = page.locator(`.hwin[data-win="thread:${k}"]`);
  await win.waitFor();
  return win;
}
// Puts a window at a known place and size, away from the edges.
const place = (page, id, x, y, sw = 480, sh = 360) => page.evaluate(([id, x, y, sw, sh]) => {
  const w = window.HDWin.get(id); Object.assign(w, { x, y, w: sw, h: sh, max: false }); window.HDWin.restore(id);
}, [id, x, y, sw, sh]);

test("resize from every edge and corner, with the right cursors, thin handles", async () => {
  const page = await open();
  const win = await threadWin(page);
  const id = "thread:" + key;
  const CUR = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
  const D = 40;
  const out = { n: [0, -D], s: [0, D], e: [D, 0], w: [-D, 0], ne: [D, -D], nw: [-D, -D], se: [D, D], sw: [-D, D] };
  for (const dir of Object.keys(CUR)) {
    await place(page, id, 300, 200);
    const r0 = await rect(win);
    // R1: the cursor names the direction.
    assert.equal(await handle(win, dir).evaluate((e) => getComputedStyle(e).cursor), CUR[dir], dir);
    // R2: edges are thin, and mostly outside the window.
    const hr = await rect(handle(win, dir));
    if (dir.length === 1) assert.ok((dir === "n" || dir === "s" ? hr.h : hr.w) <= 8, `${dir} handle thin: ${JSON.stringify(hr)}`);
    const [dx, dy] = out[dir];
    const p = await grab(win, dir);
    await drag(page, p, [p[0] + dx, p[1] + dy]);
    const r1 = await rect(win);
    const exp = {
      x: dir.includes("w") ? r0.x - D : r0.x, r: dir.includes("e") ? r0.r + D : r0.r,
      y: dir.includes("n") ? r0.y - D : r0.y, b: dir.includes("s") ? r0.b + D : r0.b,
    };
    for (const k of ["x", "r", "y", "b"]) assert.ok(near(r1[k], exp[k]), `${dir}: ${k} ${r1[k]} expected ${exp[k]} (${JSON.stringify(r0)} -> ${JSON.stringify(r1)})`);
  }
  // R2: the title bar still drags the window (no handle in the way) and
  // the content's right scrollbar is not covered by the east handle.
  const r0 = await rect(win);
  const bar = await rect(win.locator(".hw-bar"));
  await drag(page, [bar.x + 60, bar.y + 10], [bar.x + 160, bar.y + 70]);
  const r1 = await rect(win);
  assert.ok(near(r1.x, r0.x + 100) && near(r1.y, r0.y + 60) && near(r1.w, r0.w) && near(r1.h, r0.h), `title drag moves only ${JSON.stringify([r0, r1])}`);
  const inside = await win.evaluate((w) => { const r = w.getBoundingClientRect(); const e = w.querySelector('.hw-rs[data-dir="e"]').getBoundingClientRect(); return r.right - e.left; });
  assert.ok(inside <= 4, `east handle covers ${inside}px inside`);
  // Touch and pen resize too (pointer events, any pointer type).
  await place(page, id, 300, 200);
  const t0 = await rect(win);
  const sp = await grab(win, "se");
  await page.evaluate(async ([x, y, id]) => {
    const h = document.querySelector(`.hwin[data-win="${id}"] .hw-rs[data-dir="se"]`);
    const ev = (type, x, y, t) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: t, isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 });
    for (const t of ["touch", "pen"]) {
      h.dispatchEvent(ev("pointerdown", x, y, t));
      for (let i = 1; i <= 5; i++) { dispatchEvent(ev("pointermove", x + i * 6, y + i * 4, t)); await new Promise((r) => requestAnimationFrame(r)); }
      dispatchEvent(ev("pointerup", x + 30, y + 20, t));
      x += 30; y += 20;
    }
  }, [...sp, id]);
  const t1 = await rect(win);
  assert.ok(near(t1.w, t0.w + 60, 3) && near(t1.h, t0.h + 40, 3), `touch+pen resize ${JSON.stringify([t0, t1])}`);
  await page.screenshot({ path: join(artifacts, "resize-edges.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("minimum keeps the title bar usable, maximum is the viewport, a smaller viewport keeps it on screen", async () => {
  const c = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await open(c);
  const win = await threadWin(page);
  const id = "thread:" + key;
  await place(page, id, 300, 200);
  // R3: drag the south-east corner far up and left.
  let p = await grab(win, "se");
  await drag(page, p, [0, 0]);
  const small = await rect(win);
  assert.ok(small.w >= 200 && small.h >= 100, `min size ${JSON.stringify(small)}`);
  for (const b of [".hw-dock", ".hw-min", ".hw-close"]) {
    const r = await rect(win.locator(b));
    assert.ok(r.w >= 20 && r.x >= small.x && r.r <= small.r + 1, `${b} usable ${JSON.stringify(r)}`);
  }
  const title = await rect(win.locator(".hw-title"));
  assert.ok(title.w >= 40, `title shows ${title.w}`);
  // Far down and right: stops at the viewport.
  p = await grab(win, "se");
  await drag(page, p, [W + 300, H + 300]);
  let big = await rect(win);
  assert.ok(big.r <= W + 1 && big.b <= H + 1, `max is the viewport ${JSON.stringify(big)}`);
  p = await grab(win, "nw");
  await drag(page, p, [-300, -300]);
  big = await rect(win);
  assert.ok(near(big.x, 0) && near(big.y, 0) && near(big.w, W) && near(big.h, H), `full viewport ${JSON.stringify(big)}`);
  // The viewport shrinks: the window fits it.
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(100);
  const fit = await rect(win);
  assert.ok(fit.x >= 0 && fit.y >= 0 && fit.r <= 901 && fit.b <= 601, `fits the smaller viewport ${JSON.stringify(fit)}`);
  await page.screenshot({ path: join(artifacts, "resize-shrunk-viewport.png") });
  assert.deepEqual(page.errors, []);
  await c.close();
});

test("content fills the new size: screen, chat, Threads tab and the prompt card", async () => {
  const c = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await open(c);
  // A coordinator window: screen and chat, then its Threads tab.
  const win = await threadWin(page, "hub:alpha");
  const id = "thread:hub:alpha";
  await page.waitForSelector(`.hwin[data-win="${id}"] .screen:not(:empty)`);
  await place(page, id, 200, 60);
  const s0 = await rect(win.locator(".screen"));
  const p = await grab(win, "se");
  await drag(page, p, [p[0] + 200, p[1] + 250]);
  const body = await rect(win.locator(".hw-body"));
  const s1 = await rect(win.locator(".screen"));
  assert.ok(s1.h >= s0.h + 150, `screen grows with the window ${s0.h} -> ${s1.h}`);
  assert.ok(s1.w >= s0.w + 180, `screen widens ${s0.w} -> ${s1.w}`);
  const chat = await rect(win.locator(".chat-row"));
  assert.ok(chat.w >= body.w - 30, `chat fills the width ${chat.w} of ${body.w}`);
  // No dead space: the last thing shown ends at the body's bottom.
  const gap = await win.locator(".hw-body").evaluate((b) => {
    const r = b.getBoundingClientRect();
    const kids = [...b.querySelectorAll(".tw-pane:not([hidden]) > *, .hw-body > *:not(.tw-pane)")].filter((k) => k.getClientRects().length);
    return r.bottom - Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
  });
  assert.ok(gap <= 24, `no dead space below the chat (${gap}px)`);
  assert.ok(await win.locator(".hw-body").evaluate((b) => b.scrollHeight <= b.clientHeight + 1), "nothing spills");
  await page.screenshot({ path: join(artifacts, "resize-content.png") });
  // The Threads tab fills the window too.
  await win.locator('.tw-tab[data-tab="threads"]').click();
  await win.locator(".tv").waitFor();
  const pane = await rect(win.locator('.tw-pane[data-pane="threads"]'));
  const b2 = await rect(win.locator(".hw-body"));
  assert.ok(b2.b - pane.b <= 16, `Threads tab fills the window ${JSON.stringify([pane, b2])}`);
  await page.screenshot({ path: join(artifacts, "resize-threads-tab.png") });
  // The prompt window: its card widens with the window.
  const pw = page.locator('.hwin[data-win="prompt:alpha/t-0002"]');
  await pw.waitFor();
  await page.evaluate(() => window.HDWin.restore("prompt:alpha/t-0002"));
  await place(page, "prompt:alpha/t-0002", 100, 80);
  const c0 = await rect(pw.locator(".pcard"));
  const pp = await grab(pw, "e");
  await drag(page, pp, [pp[0] + 220, pp[1]]);
  const c1 = await rect(pw.locator(".pcard"));
  assert.ok(c1.w >= c0.w + 200, `prompt card widens ${c0.w} -> ${c1.w}`);
  await page.screenshot({ path: join(artifacts, "resize-prompt.png") });
  assert.deepEqual(page.errors, []);
  await c.close();
});

test("double-click on the title bar maximises and restores; Alt+Shift+arrows resize; help lists them", async () => {
  const c = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await open(c);
  const win = await threadWin(page);
  const id = "thread:" + key;
  // A window never resized maximises too, and goes back to its natural size.
  // (The prompt window that opened by itself steps aside.)
  await page.locator('.hwin[data-win="prompt:alpha/t-0002"]').waitFor();
  await page.evaluate(() => window.HDWin.minimise("prompt:alpha/t-0002"));
  const n0 = await rect(win);
  let t = await rect(win.locator(".hw-title"));
  await page.mouse.dblclick(t.x + 20, t.y + t.h / 2);
  const n1 = await rect(win);
  assert.ok(near(n1.x, 0) && near(n1.y, 0) && near(n1.w, W) && near(n1.h, H), `natural window maximised ${JSON.stringify(n1)}`);
  t = await rect(win.locator(".hw-title"));
  await page.mouse.dblclick(t.x + 20, t.y + t.h / 2);
  const n2 = await rect(win);
  for (const k of ["x", "y", "w", "h"]) assert.ok(near(n2[k], n0[k]), `natural size back ${k}: ${JSON.stringify([n0, n2])}`);
  await place(page, id, 320, 180);
  const r0 = await rect(win);
  const title = await rect(win.locator(".hw-title"));
  await page.mouse.dblclick(title.x + 20, title.y + title.h / 2);
  const m = await rect(win);
  assert.ok(near(m.x, 0) && near(m.y, 0) && near(m.w, W) && near(m.h, H), `maximised ${JSON.stringify(m)}`);
  await page.screenshot({ path: join(artifacts, "resize-maximised.png") });
  const t2 = await rect(win.locator(".hw-title"));
  await page.mouse.dblclick(t2.x + 20, t2.y + t2.h / 2);
  const r1 = await rect(win);
  for (const k of ["x", "y", "w", "h"]) assert.ok(near(r1[k], r0[k]), `restored ${k}: ${JSON.stringify([r0, r1])}`);
  // R6: keys resize the focused window (its bottom-right corner moves).
  await win.focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  const k1 = await rect(win);
  assert.ok(near(k1.x, r0.x) && near(k1.y, r0.y) && k1.w > r0.w + 30 && k1.h > r0.h + 15, `keys grow ${JSON.stringify([r0, k1])}`);
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await page.keyboard.press("Alt+Shift+ArrowUp");
  const k2 = await rect(win);
  assert.ok(k2.w < k1.w && k2.h < k1.h, `keys shrink ${JSON.stringify([k1, k2])}`);
  // The ? help lists the keys and the double-click.
  await win.locator(".hw-close").click();
  await page.keyboard.press("?");
  const help = await page.locator("#voice-help").innerText();
  assert.match(help, /Alt\+Shift\+Arrows/);
  assert.match(help, /[Dd]ouble-click/);
  assert.deepEqual(page.errors, []);
  await c.close();
});

test("the size survives a reload; undocking restores the floating size; no layout reads per move", async () => {
  const c = await browser.newContext({ viewport: { width: W, height: H } });
  let page = await open(c);
  let win = await threadWin(page);
  const id = "thread:" + key;
  await place(page, id, 260, 140);
  const p = await grab(win, "se");
  await drag(page, p, [p[0] + 150, p[1] + 120]);
  const r0 = await rect(win);
  // R7: reload.
  await page.close();
  page = await open(c);
  win = page.locator(`.hwin[data-win="${id}"]`);
  await win.waitFor();
  const r1 = await rect(win);
  for (const k of ["x", "y", "w", "h"]) assert.ok(near(r1[k], r0[k]), `reload kept ${k}: ${JSON.stringify([r0, r1])}`);
  // Dock: the dock sizes it; float again: the last floating size.
  await page.evaluate((id) => window.HDWin.dock(id, "right"), id);
  const d = await rect(win);
  assert.ok(!near(d.h, r0.h, 10), `docked takes the dock's size ${JSON.stringify(d)}`);
  await page.evaluate((id) => window.HDWin.float(id), id);
  const f = await rect(win);
  assert.ok(near(f.w, r0.w) && near(f.h, r0.h), `undock restores the size ${JSON.stringify([r0, f])}`);
  // R9: a resize reads the layout only when it starts.
  await page.evaluate(() => {
    window.__reads = 0;
    const g = (window.__gbcr = Element.prototype.getBoundingClientRect);
    Element.prototype.getBoundingClientRect = function () { if (/windows\.js/.test(new Error().stack)) window.__reads++; return g.call(this); };
  });
  const q = await grab(win, "e");
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] - 10, q[1], { steps: 2 });
  const startReads = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__reads)))));
  await page.mouse.move(q[0] - 120, q[1], { steps: 30 });
  const moveReads = (await page.evaluate(() => window.__reads)) - startReads;
  await page.mouse.up();
  await page.evaluate(() => { Element.prototype.getBoundingClientRect = window.__gbcr; });
  assert.ok(moveReads <= 2, `no layout reads per move (${moveReads} over 30 moves)`);
  assert.deepEqual(page.errors, []);
  await c.close();
});

test("phone: windows stay sheets, with no handles", async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await open(c);
  // A size saved on a desktop does not reach the phone's sheet.
  await page.evaluate((id) => localStorage.setItem("hd-win-pos", JSON.stringify({ [id]: { x: 10, y: 10, w: 300, h: 200 } })), "thread:" + key);
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  const win = await threadWin(page);
  const r = await rect(win);
  assert.ok(near(r.x, 0) && near(r.w, 390), `a full-width sheet ${JSON.stringify(r)}`);
  assert.ok(r.h > 220, `sheet height is its own, not the saved one ${r.h}`);
  assert.equal(await win.locator(".hw-rs").evaluateAll((l) => l.filter((e) => e.getClientRects().length).length), 0, "no visible handles");
  const title = await rect(win.locator(".hw-title"));
  await page.mouse.dblclick(title.x + 20, title.y + title.h / 2);
  const r2 = await rect(win);
  assert.ok(near(r2.y, r.y) && near(r2.h, r.h), "double-click does not maximise a sheet");
  await page.screenshot({ path: join(artifacts, "resize-phone.png") });
  assert.deepEqual(page.errors, []);
  await c.close();
});
