// E2E: focus chips (and other project names) navigate the map. The real
// herdr-dash binary runs against the fixture root with stubbed
// herdr-projects / herdr / gh; headless Chromium clicks, hovers and types.
// Artifacts land in e2e/artifacts/focus-nav-*.
//
// Ways chip navigation could fail, written before it existed:
//  N1. Clicking a chip does nothing to the view, or leaves some of that
//      project's nodes off screen, or zooms so far out it is no help.
//  N2. The project is not highlighted once there, or another one is.
//  N3. Navigation reheats the force layout: nodes move, not just the view.
//  N4. The × no longer removes the chip, or removing also navigates.
//  N5. A second click on the same chip does not open the coordinator.
//  N6. Hover does not dim the other projects, or it moves the view, or the
//      dimming sticks after the pointer leaves.
//  N7. Keyboard: chips not focusable, Enter does not go, Delete/Backspace do
//      not remove, arrows do not move between chips, or the ? help omits it.
//  N8. Fit all leaves a focused project out of view.
//  N9. With reduced motion the view still animates.
// N10. On a phone a tap does not go (or zooms a map that is off screen),
//      or a long-press does not remove (or also navigates / opens the panel).
// N11. The picker, the Needs-you strip and the System strip agent rows give
//      no way to reach or light up a project.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-focusnav-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");
let server, base, browser, st;
const log = [];

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = startServer(port, stubLog);
  st = await waitFor(async () => {
    const s = await (await fetch(base + "/api/state")).json();
    return s.threads?.length ? s : null;
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "focus-nav-steps.json"), JSON.stringify(log, null, 2));
  rmSync(tmp, { recursive: true, force: true });
});

const slugs = () => st.projects.map((p) => p.slug);
const nameOf = (s) => st.projects.find((p) => p.slug === s).name;
const ofProject = (key, slug) => key === "hub:" + slug || key.startsWith(slug + "/");
const view = (page) => page.evaluate(() => document.querySelector("#graph > g").getAttribute("transform") || "");
const positions = (page) => page.locator("#graph g.node:not(.leaving)").evaluateAll((ns) => Object.fromEntries(ns.map((n) => [n.dataset.key, n.getAttribute("transform")])));
const chips = (page) => page.locator("#focus-chips .fchip").evaluateAll((cs) => cs.map((c) => c.dataset.slug));
const lit = (page) => page.locator("#graph g.node.lit").evaluateAll((ns) => ns.map((n) => n.dataset.key));
const pulsing = (page) => page.locator("#graph g.node.pulse").evaluateAll((ns) => ns.map((n) => n.dataset.key));
const coreOpacity = (page, key) => page.locator(`#graph g.node[data-key="${key}"] circle.core`).evaluate((c) => +getComputedStyle(c).opacity);

// Wait until the layout and the view stop moving.
async function settle(page, what = "settled") {
  let prev = "";
  await waitFor(async () => {
    const now = JSON.stringify([await positions(page), await view(page)]);
    const same = now === prev;
    prev = now;
    if (!same) await page.waitForTimeout(250);
    return same;
  }, 15000).catch(() => assert.fail(what + ": graph never settled"));
}

// Where a project's nodes sit on screen, relative to the map.
async function placement(page, slug) {
  return page.evaluate((s) => {
    const svg = document.querySelector("#graph").getBoundingClientRect();
    const own = [...document.querySelectorAll("#graph g.node:not(.leaving)")].filter((n) => n.dataset.key === "hub:" + s || n.dataset.key.startsWith(s + "/"));
    const rs = own.map((n) => n.querySelector("circle.core").getBoundingClientRect());
    const box = { l: Math.min(...rs.map((r) => r.left)), r: Math.max(...rs.map((r) => r.right)), t: Math.min(...rs.map((r) => r.top)), b: Math.max(...rs.map((r) => r.bottom)) };
    const inside = rs.every((r) => r.left >= svg.left - 1 && r.right <= svg.right + 1 && r.top >= svg.top - 1 && r.bottom <= svg.bottom + 1);
    return { n: own.length, inside, cover: Math.max((box.r - box.l) / svg.width, (box.b - box.t) / svg.height) };
  }, slug);
}
async function expectInView(page, slug, step) {
  const p = await placement(page, slug);
  log.push({ step, slug, ...p, view: await view(page) });
  assert.ok(p.n > 1, `${step}: ${slug} has nodes on the map`);
  assert.ok(p.inside, `${step}: every ${slug} node in view ${JSON.stringify(p)}`);
  return p;
}
const keysOf = async (page, slug) => Object.keys(await positions(page)).filter((k) => ofProject(k, slug)).sort();

async function openAt(page, focus) {
  await page.goto(base + "/" + (focus ? "?focus=" + focus.join(",") : ""));
  await page.waitForSelector("#graph g.node.thread");
  await settle(page);
}

test("click a chip: go there, highlight, no reheat; again opens the coordinator; hover dims; Fit all; ×", async () => {
  const [a, b] = slugs();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openAt(page, [a, b]);
  assert.deepEqual(await chips(page), [a, b]);
  const start = await view(page);
  const before = await positions(page);

  // N1, N2, N3.
  await page.click(`#focus-chips .fchip[data-slug="${a}"] .fgo`);
  await waitFor(async () => (await view(page)) !== start, 3000);
  assert.deepEqual((await pulsing(page)).sort(), await keysOf(page, a), "the project's nodes pulse");
  await settle(page, "after go");
  const pa = await expectInView(page, a, "chip go a");
  assert.ok(pa.cover > 0.3, "zoomed to the project, not the whole map: " + pa.cover);
  assert.deepEqual(await positions(page), before, "only the view moved");
  assert.equal(await page.locator("#panel.open").count(), 0, "first click opens no panel");
  await page.screenshot({ path: join(artifacts, "focus-nav-go.png") });

  await page.click(`#focus-chips .fchip[data-slug="${b}"] .fgo`);
  await settle(page, "after go b");
  await expectInView(page, b, "chip go b");
  assert.ok((await placement(page, b)).cover > 0.3, "zoomed to b");

  // N5: a second click on the same chip opens its coordinator.
  await page.click(`#focus-chips .fchip[data-slug="${b}"] .fgo`);
  await page.waitForSelector("#panel.open");
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === nameOf(b), 3000);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#panel.open", { state: "detached" }).catch(() => {});

  // N6: hover lights the project and dims the others, view unmoved.
  await settle(page, "before hover");
  const v = await view(page);
  await page.hover(`#focus-chips .fchip[data-slug="${a}"] .fgo`);
  await waitFor(async () => (await lit(page)).length > 0, 2000);
  assert.deepEqual((await lit(page)).sort(), await keysOf(page, a), "hover lights the project");
  const other = (await keysOf(page, b))[0];
  await page.waitForTimeout(400);
  assert.ok((await coreOpacity(page, other)) < 0.5, "others dim");
  assert.equal(await coreOpacity(page, "hub:" + a), 1, "the project stays bright");
  assert.equal(await view(page), v, "hover does not move the view");
  await page.screenshot({ path: join(artifacts, "focus-nav-hover.png") });
  await page.mouse.move(700, 600);
  await waitFor(async () => (await lit(page)).length === 0, 2000);
  assert.equal(await page.locator("#graph.spotlit").count(), 0, "dimming ends with the hover");

  // N8: Fit all brings every focused project back into view.
  await page.click("#fit-focus");
  await settle(page, "after fit all");
  await expectInView(page, a, "fit all");
  await expectInView(page, b, "fit all");
  assert.deepEqual(await positions(page), before, "fit all reheats nothing");

  // N4: × still removes, and does not navigate.
  const v2 = await view(page);
  await page.click(`#focus-chips .fchip[data-slug="${a}"] .fx`);
  await waitFor(async () => JSON.stringify(await chips(page)) === JSON.stringify([b]), 3000);
  assert.equal(await page.locator("#panel.open").count(), 0);
  log.push({ step: "× removes", view: v2 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("keyboard: arrows move, Enter goes, Delete/Backspace remove; ? help lists it", async () => {
  const [a, b, c] = slugs();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await openAt(page, [a, b]);
  await page.focus(`#focus-chips .fchip[data-slug="${a}"] .fgo`);
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement.closest(".fchip")?.dataset.slug), b, "ArrowRight");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.evaluate(() => document.activeElement.closest(".fchip")?.dataset.slug), a, "ArrowLeft");
  const start = await view(page);
  await page.keyboard.press("Enter");
  await waitFor(async () => (await view(page)) !== start, 3000);
  await settle(page);
  await expectInView(page, a, "Enter");
  await page.keyboard.press("Delete");
  await waitFor(async () => JSON.stringify(await chips(page)) === JSON.stringify([b]), 3000).catch(async () => assert.deepEqual(await chips(page), [b], "Delete"));
  // Backspace from another row of two.
  await page.goto(base + `/?focus=${b},${c}`);
  await page.waitForSelector("#graph g.node.thread");
  await page.focus(`#focus-chips .fchip[data-slug="${c}"] .fgo`);
  await page.keyboard.press("Backspace");
  await waitFor(async () => JSON.stringify(await chips(page)) === JSON.stringify([b]), 3000);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("hd-filters")).projects), [b], "Backspace");
  assert.equal(await page.evaluate(() => document.activeElement.closest(".fchip")?.dataset.slug), b, "focus stays on the chips");

  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("?");
  await page.waitForSelector("#voice-help:not([hidden])");
  const help = await page.locator("#voice-help").innerText();
  assert.match(help, /chip/i, "help mentions the chips");
  assert.match(help, /Delete|Backspace/, "help names the remove keys");
  await page.close();
});

test("picker, Needs-you and System rows reach or light a project", async () => {
  const [a, b] = slugs();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openAt(page, [a]);
  // Picker: hovering a row lights its project; Go adds it if needed and goes.
  await page.click("#f-project");
  await page.waitForSelector("#proj-picker:not([hidden])");
  await page.hover(`#proj-picker .prow[data-slug="${a}"]`);
  await waitFor(async () => (await lit(page)).length > 0, 2000);
  assert.deepEqual((await lit(page)).sort(), await keysOf(page, a), "picker hover lights");
  await page.click(`#proj-picker .prow[data-slug="${b}"] .pgo`);
  await waitFor(async () => (await chips(page)).includes(b), 3000);
  await page.waitForSelector("#proj-picker", { state: "hidden" });
  await waitFor(async () => (await pulsing(page)).some((k) => ofProject(k, b)), 8000);
  await settle(page, "picker go");
  await expectInView(page, b, "picker go");

  // Needs-you: hovering a chip lights its project.
  const chip = page.locator("#needs .chip").first();
  const key = await chip.getAttribute("data-key");
  const slug = key.replace(/^hub:/, "").split("/")[0];
  await chip.hover();
  await waitFor(async () => (await lit(page)).length > 0, 2000);
  assert.deepEqual((await lit(page)).sort(), await keysOf(page, slug), "needs hover lights");
  await page.mouse.move(700, 880);

  // System strip: an agents row goes to its project.
  await page.click('#sys [data-id="agents"]');
  const row = page.locator(`#sys-pop .sproj[data-slug="${a}"] .spn`);
  await row.waitFor();
  assert.equal(await row.evaluate((e) => e.tagName), "BUTTON");
  const v = await view(page);
  await row.click();
  await waitFor(async () => (await view(page)) !== v, 3000);
  await settle(page, "system go");
  await expectInView(page, a, "system go");
  assert.ok(await page.locator("#sys-pop").isHidden(), "the popover closes");
  await page.close();
});

test("reduced motion: the view jumps", async () => {
  const [a, b] = slugs();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await openAt(page, [a, b]);
  await page.click(`#focus-chips .fchip[data-slug="${b}"] .fgo`);
  await page.waitForTimeout(80);
  const first = await view(page);
  await page.waitForTimeout(500);
  assert.equal(await view(page), first, "no animation after the jump");
  await expectInView(page, b, "reduced motion");
  const anim = await page.locator(`#graph g.node.pulse[data-key="hub:${b}"] circle.core`).evaluate((c) => getComputedStyle(c).animationName);
  assert.equal(anim, "none", "no pulse animation");
  await page.close();
});

test("phone: tap goes, long-press removes", async () => {
  const [a, b, c] = slugs();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await openAt(page, [a, b, c].slice(0, 2));
  const start = await view(page);
  await page.tap(`#focus-chips .fchip[data-slug="${b}"] .fgo`);
  await waitFor(async () => (await view(page)) !== start, 3000);
  await settle(page, "phone tap");
  await expectInView(page, b, "phone tap");
  const top = await page.locator("#stage").evaluate((e) => e.getBoundingClientRect().top);
  assert.ok(top < 844 - 200, "the map is on screen: " + top);
  assert.equal(await page.locator("#panel.open").count(), 0);
  await page.screenshot({ path: join(artifacts, "focus-nav-phone.png") });

  const v = await view(page);
  const go = page.locator(`#focus-chips .fchip[data-slug="${a}"] .fgo`);
  await go.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, button: 0 });
  await page.waitForTimeout(800);
  await go.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, button: 0 }, { timeout: 300 }).catch(() => {});
  await go.dispatchEvent("click", {}, { timeout: 300 }).catch(() => {});
  await waitFor(async () => JSON.stringify(await chips(page)) === JSON.stringify([b]), 3000);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("hd-filters")).projects), [b], "long-press removed a");
  assert.equal(await page.locator("#panel.open").count(), 0, "long-press opens nothing");
  log.push({ step: "phone long-press", view: v });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no sideways scroll");
  await ctx.close();
});
