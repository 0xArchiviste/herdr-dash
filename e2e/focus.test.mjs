// E2E: focus on several projects at once. The real herdr-dash binary runs
// against the fixture root with stubbed herdr-projects / herdr / gh / memex;
// headless Chromium drives the project picker, focus chips and graph.
// Artifacts land in e2e/artifacts/focus-*.
//
// Ways multi-project focus could fail, written before it existed:
//  F1. Only one project can be focused: ticking a second replaces the first.
//  F2. Deselecting does not apply live: the graph, the Needs-you strip or
//      content search results still show a project taken out of focus.
//  F3. Deselecting the last project leaves an empty dashboard instead of
//      showing everything again.
//  F4. All / None / Only this do something else: All does not tick every
//      project, None leaves some ticked, Only this keeps others.
//  F5. Ctrl/Cmd+click or Shift+click on a hub opens a panel or a window
//      instead of toggling the project's focus.
//  F6. The focus is lost on reload, or not in the URL (?focus=a,b), or a
//      bookmarked URL loses to an older stored focus.
//  F7. The focus is not shown clearly: no chip per focused project, or a
//      chip's × does not remove it.
//  F8. No keyboard way in: no shortcut to open the picker, no type-to-filter
//      in it, the shortcut missing from the ? help, or it fires while typing.
//  F9. Fade mode hides instead of fading, or reheats the graph layout.
// F10. On a phone the picker is a cramped popover off screen instead of a
//      bottom sheet, or the page scrolls sideways.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, stub, waitFor } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-focus-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");
let server, base, browser, st;
const log = [];

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = startServer(port, stubLog, [], { HERDR_DASH_MEMEX: join(stub, "memex") });
  st = await waitFor(async () => {
    const s = await (await fetch(base + "/api/state")).json();
    return s.threads?.length ? s : null;
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "focus-steps.json"), JSON.stringify(log, null, 2));
  rmSync(tmp, { recursive: true, force: true });
});

const slugs = () => st.projects.map((p) => p.slug);
// The map shows open threads by default (resolved ones on demand: stream.test.mjs).
const threadsOf = (ps) => st.threads.filter((t) => ps.includes(t.project) && t.state !== "resolved").length;
const hubs = (page) => page.locator("svg g.node.hub:not(.leaving)").evaluateAll((ns) => ns.map((n) => n.dataset.key.slice(4)).sort());
const nThreads = (page) => page.locator("svg g.node.thread:not(.leaving)").count();
const needProjects = (page) => page.locator("#needs .chip").evaluateAll((cs) => [...new Set(cs.map((c) => c.dataset.key.replace(/^hub:/, "").split("/")[0]))].sort());
const chips = (page) => page.locator("#focus-chips .fchip").evaluateAll((cs) => cs.map((c) => c.dataset.slug).sort());
const urlFocus = (page) => new URL(page.url()).searchParams.get("focus");
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("hd-filters") || "{}").projects || []);
const ticked = (page) => page.locator('#proj-picker .prow[aria-checked="true"]').evaluateAll((rs) => rs.map((r) => r.dataset.slug).sort());

// The focused set shows everywhere it should, live.
async function expectFocus(page, want, step) {
  const shown = want.length ? want : slugs();
  await waitFor(async () => JSON.stringify(await hubs(page)) === JSON.stringify([...shown].sort()), 4000)
    .catch(async () => assert.deepEqual(await hubs(page), [...shown].sort(), step + ": hubs"));
  await waitFor(async () => (await nThreads(page)) === threadsOf(shown), 4000)
    .catch(async () => assert.equal(await nThreads(page), threadsOf(shown), step + ": threads"));
  for (const p of await needProjects(page)) assert.ok(shown.includes(p), `${step}: Needs-you shows ${p}`);
  assert.deepEqual(await chips(page), want.length < slugs().length ? [...want].sort() : [], step + ": chips");
  assert.equal(urlFocus(page), want.length ? slugs().filter((s) => want.includes(s)).join(",") : null, step + ": URL");
  assert.deepEqual([...(await stored(page))].sort(), [...want].sort(), step + ": stored");
  log.push({ step, focus: want, hubs: await hubs(page), threads: await nThreads(page), url: page.url().replace(base, "") });
}

async function openPicker(page) {
  if (await page.locator("#proj-picker").isHidden()) await page.click("#f-project");
  await page.waitForSelector("#proj-picker:not([hidden])");
}

test("select two, deselect one, None/All, Only this, graph clicks", async () => {
  assert.ok(slugs().length >= 3, "fixture has three projects");
  const [a, b, c] = slugs();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await expectFocus(page, [], "start");

  // F8: P opens the picker with the filter focused; typing narrows it.
  await page.keyboard.press("p");
  await page.waitForSelector("#proj-picker:not([hidden])");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "pp-filter");
  await page.keyboard.type(b.slice(0, 3));
  assert.deepEqual(await page.locator("#proj-picker .prow:visible").evaluateAll((rs) => rs.map((r) => r.dataset.slug)), [b]);
  // Enter ticks the only (or first) match.
  await page.keyboard.press("Enter");
  await expectFocus(page, [b], "Enter ticks the filtered project");
  await page.fill("#pp-filter", "");

  // F1: a second project adds to the focus.
  await page.click(`#proj-picker .prow[data-slug="${a}"]`);
  await expectFocus(page, [a, b], "select two");
  assert.deepEqual(await ticked(page), [a, b].sort());
  await page.screenshot({ path: join(artifacts, "focus-two.png") });

  // F2: deselect one in the picker.
  await page.click(`#proj-picker .prow[data-slug="${b}"]`);
  await expectFocus(page, [a], "deselect one");

  // F3: deselecting the last returns to everything.
  await page.click(`#proj-picker .prow[data-slug="${a}"]`);
  await expectFocus(page, [], "deselect last");

  // F4: All ticks every project; then unticking one hides only it.
  await page.click("#pp-all");
  assert.deepEqual(await ticked(page), slugs().sort());
  await expectFocus(page, slugs(), "All");
  await page.click(`#proj-picker .prow[data-slug="${c}"]`);
  await expectFocus(page, [a, b], "All, then untick one");
  await page.click("#pp-none");
  assert.deepEqual(await ticked(page), []);
  await expectFocus(page, [], "None");
  await page.click(`#proj-picker .prow[data-slug="${a}"]`);
  await page.click(`#proj-picker .prow[data-slug="${b}"]`);
  await page.click(`#proj-picker .prow[data-slug="${c}"] .ponly`);
  await expectFocus(page, [c], "Only this");

  // Escape closes the picker.
  await page.keyboard.press("Escape");
  await page.waitForSelector("#proj-picker", { state: "hidden" });

  // F5: Ctrl+click and Shift+click on hubs toggle focus, open no panel.
  const hubClick = (slug, mods) => page.evaluate(([s, m]) => document.querySelector(`svg g.node[data-key="hub:${s}"]`).dispatchEvent(new MouseEvent("click", { bubbles: true, ...m })), [slug, mods]);
  await openPicker(page);
  await page.click(`#proj-picker .prow[data-slug="${a}"] .ponly`);
  await page.keyboard.press("Escape");
  // Fade mode keeps unfocused hubs on screen, so they can be clicked.
  await page.click("#f-project");
  await page.check("#pp-fade");
  await page.keyboard.press("Escape");
  await waitFor(async () => (await page.locator("svg g.node.hub.faded").count()) === 2, 3000);
  // F9: faded, not hidden; Needs-you still only the focus.
  assert.equal(await page.locator("svg g.node.hub").count(), 3);
  assert.equal(await nThreads(page), threadsOf(slugs()));
  assert.equal(await page.locator("svg g.node.thread.faded").count(), threadsOf(slugs()) - threadsOf([a]));
  for (const p of await needProjects(page)) assert.equal(p, a, "fade mode: Needs-you only the focus");
  await page.screenshot({ path: join(artifacts, "focus-fade.png") });
  await hubClick(b, { ctrlKey: true });
  await waitFor(async () => (await page.locator("svg g.node.hub.faded").count()) === 1, 3000);
  assert.deepEqual([...(await stored(page))].sort(), [a, b].sort(), "Ctrl+click adds");
  await hubClick(a, { shiftKey: true });
  await waitFor(async () => (await page.locator("svg g.node.hub.faded").count()) === 2, 3000);
  assert.deepEqual(await stored(page), [b], "Shift+click removes");
  await hubClick(c, { metaKey: true });
  await waitFor(async () => (await stored(page)).length === 2, 3000);
  assert.equal(await page.locator("#panel.open").count(), 0, "no panel opened");
  assert.equal(await page.locator(".hwin").count(), 0, "no window opened");
  await page.click("#f-project");
  await page.uncheck("#pp-fade");
  await page.keyboard.press("Escape");
  await expectFocus(page, [b, c], "graph clicks");

  // F7: the × on a chip removes that project.
  await page.click(`#focus-chips .fchip[data-slug="${b}"] .fx`);
  await expectFocus(page, [c], "chip ×");
  await page.screenshot({ path: join(artifacts, "focus-chip.png") });
  assert.deepEqual(errors, []);
  await page.close();
});

test("reload keeps the focus; a URL focus wins over the stored one", async () => {
  const [a, b, c] = slugs();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.click("#f-project");
  await page.click(`#proj-picker .prow[data-slug="${a}"]`);
  await page.click(`#proj-picker .prow[data-slug="${c}"]`);
  await page.keyboard.press("Escape");
  await expectFocus(page, [a, c], "before reload");
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await expectFocus(page, [a, c], "after reload");
  // Bookmarked URL.
  await page.goto(base + `/?focus=${b}`);
  await page.waitForSelector("svg g.node.thread");
  await expectFocus(page, [b], "URL focus");
  // Unknown slugs in a URL are ignored, not an empty dashboard.
  await page.goto(base + "/?focus=nope");
  await page.waitForSelector("svg g.node.thread");
  assert.deepEqual(await hubs(page), slugs().sort(), "unknown slug shows everything");
  await ctx.close();
});

test("content search results respect the focus", async () => {
  const [a, b] = slugs();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + `/?focus=${b}`);
  await page.waitForSelector("svg g.node.thread");
  await page.click("#search-mode");
  await page.fill("#f-search", "zephyr");
  await page.waitForSelector("#search-results .hit");
  await page.waitForTimeout(400);
  const keys = await page.locator("#search-results .hit").evaluateAll((hs) => hs.map((h) => h.dataset.key));
  assert.ok(keys.length > 0);
  for (const k of keys) assert.equal(k.replace(/^hub:/, "").split("/")[0], b, "only the focused project: " + k);
  // Adding a project to the focus brings its results back, live, without
  // searching again. (Escape in a search field would clear it.)
  const reqs = [];
  page.on("request", (r) => { if (r.url().includes("/api/search")) reqs.push(r.url()); });
  await page.click("#f-project");
  await page.click(`#proj-picker .prow[data-slug="${a}"]`);
  await page.keyboard.press("Escape");
  await page.locator("#f-search").focus();
  await page.waitForSelector(`#search-results:not([hidden]) .hit[data-key^="${a}/"]`, { timeout: 3000 });
  assert.ok(await page.locator(`svg g.node.hit[data-key^="${a}/"]`).count(), "graph highlights follow the focus");
  assert.deepEqual(reqs, [], "no new search request");
  await page.screenshot({ path: join(artifacts, "focus-search.png") });
  await page.evaluate(() => localStorage.clear());
  await page.close();
});

test("help lists the picker key; P does nothing while typing", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.focus("#f-search");
  await page.keyboard.press("p");
  assert.ok(await page.locator("#proj-picker").isHidden(), "typing p in search does not open the picker");
  await page.fill("#f-search", "");
  await page.locator("#f-search").blur();
  await page.keyboard.press("?");
  await page.waitForSelector("#voice-help:not([hidden])");
  assert.match(await page.locator("#voice-help").innerText(), /\bP\b[\s\S]*project/i);
  await page.close();
});

test("phone: the picker is a bottom sheet", async () => {
  const [a, b] = slugs();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.tap("#f-project");
  await page.waitForSelector("#proj-picker:not([hidden])");
  await page.waitForTimeout(400);
  const box = await page.locator("#proj-picker").boundingBox();
  assert.ok(box.width >= 380, "full width: " + box.width);
  assert.ok(Math.abs(box.y + box.height - 844) <= 2, "sits on the bottom edge: " + JSON.stringify(box));
  await page.tap(`#proj-picker .prow[data-slug="${a}"]`);
  await page.tap(`#proj-picker .prow[data-slug="${b}"]`);
  for (const r of await page.locator("#proj-picker .prow").all()) assert.ok((await r.boundingBox()).height >= 40, "touch-size rows");
  await page.screenshot({ path: join(artifacts, "focus-phone-sheet.png") });
  await page.tap("#pp-done");
  await page.waitForSelector("#proj-picker", { state: "hidden" });
  await expectFocus(page, [a, b], "phone");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no sideways scroll");
  await page.screenshot({ path: join(artifacts, "focus-phone.png") });
  await ctx.close();
});
