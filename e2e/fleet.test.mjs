// E2E: the Master window (stage 1a, read-only): a fleet table with one row
// per project and a ranked Attention list, on a generated fake fleet of 30
// fictional projects (fleet-fixtures.mjs). The real herdr-dash binary runs
// against it with stubbed herdr-projects / herdr and a fake /proc.
// Artifacts: e2e/artifacts/fleet-*.png and fleet.json.
//
// Ways it could fail, written before it existed:
//  M1. Rows are missing or doubled (30 projects, 30 rows), or a row's facts
//      are wrong: coordinator chip, threads per stage, needs-you count,
//      unacked reports, failed or stuck launches, priority, CPU and RAM of
//      its agents, last activity.
//  M2. A chip says its state by colour alone, or "missing" and "exited"
//      coordinators read the same.
//  M3. The Attention list is unranked, or ranks a review pile above a
//      blocked coordinator, ignores the priority flag, flags a paused or
//      archived project for having no coordinator, or misses repeated launch
//      failures ("agent name already used").
//  M4. Sorting by a column or filtering by state or text shows the wrong
//      rows, or a filter that hides everything says nothing.
//  M5. The project focus is ignored: rows or attention items from projects
//      outside it, or the table does not follow a focus change.
//  M6. Clicking a row (or an attention item) does not open that project's
//      coordinator window; clicking a checkbox opens it.
//  M7. Multi-select: shift-click does not select a range, select-all takes
//      rows hidden by a filter, the copied summary lacks a selected project
//      or includes one not selected.
//  M8. Phone: a table that scrolls sideways instead of cards.
//  M9. The window costs CLI calls: /api/fleet or the open window runs
//      herdr-projects, herdr or gh, or the page polls /api/fleet on a timer
//      instead of following the snapshot and system frames.
// M10. The window is not a windows.js window: no dock, no resize, not
//      reopened after a reload.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, startServer, freePort, waitFor } from "./helpers.mjs";
import { FakeProc, PAGE } from "./fakeproc.mjs";
import { fleet, NAMES, SPEC, ATTENTION } from "./fleet-fixtures.mjs";

mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
let f, fp, server, url, browser, ticker;

function start(port, extra = [], log = f.log) {
  return startServer(port, log, ["--root", f.root, "--herdr", join(f.stubDir, "herdr"), "--proc", f.proc, "--fleet-config", f.fleetToml, ...extra],
    { HERDR_DASH_HERDR_PROJECTS: join(f.stubDir, "herdr-projects"), STUB_PANES: f.panesFile });
}
const getFleet = async (u = url) => (await fetch(u + "/api/fleet")).json();
const rowOf = (fl, slug) => fl.rows.find((r) => r.slug === slug);

before(async () => {
  f = fleet();
  fp = new FakeProc(f.proc);
  for (const [pid, comm, o] of f.procs) fp.add(pid, comm, o);
  fp.write();
  ticker = setInterval(() => fp.advance(), 250);
  const port = await freePort();
  server = start(port);
  url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).projects.length === 30 && (await getFleet()).rows.length === 30, 20_000);
  // CPU shares need two samples: a stream subscriber starts them.
  const ac = new AbortController();
  fetch(url + "/api/events", { signal: ac.signal }).then((r) => r.body.getReader().read()).catch(() => {});
  await waitFor(async () => rowOf(await getFleet(), "delta-forge")?.cpu > 0, 15_000);
  ac.abort();
  browser = await chromium.launch();
});

after(async () => {
  clearInterval(ticker);
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "fleet.json"), JSON.stringify(out, null, 2));
  rmSync(f.tmp, { recursive: true, force: true });
});

async function openPage(opts = {}, q = "") {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/" + q);
  await page.waitForFunction(() => window.hd?.state().projects.length === 30);
  return page;
}
async function openMaster(page) {
  await page.click("#master-open");
  await page.waitForSelector('.hwin[data-win="master"] #fl-table tbody tr[data-slug]');
  return page.locator('.hwin[data-win="master"]');
}
const shownSlugs = (page) => page.$$eval('.hwin[data-win="master"] #fl-table tbody tr[data-slug], .hwin[data-win="master"] .fl-card[data-slug]', (rs) => rs.filter((r) => r.offsetParent).map((r) => r.dataset.slug));

test("API: 30 rows with each project's facts (M1)", async () => {
  const fl = await getFleet();
  assert.equal(fl.rows.length, 30);
  assert.deepEqual([...fl.rows.map((r) => r.slug)].sort(), [...NAMES].sort());
  const chip = (s) => rowOf(fl, s).coordinator.state;
  assert.equal(chip("aurora-ledger"), "blocked");
  assert.equal(chip("birch-notes"), "waiting");
  assert.equal(chip("delta-forge"), "working");
  assert.equal(chip("cobalt-relay"), "idle");
  assert.equal(chip("ember-cache"), "missing");
  assert.equal(chip("fjord-sync"), "exited");
  const d = rowOf(fl, "delta-forge");
  assert.deepEqual(d.stages, { working: 2, waiting: 0, blocked: 1, review: 0, landing: 0, idle: 0, launching: 0 });
  assert.equal(d.needs_you, 1);
  const b = rowOf(fl, "birch-notes");
  assert.equal(b.needs_you, 2);
  const iris = rowOf(fl, "iris-index");
  assert.equal(iris.unacked, 24, "acked reports are not counted");
  assert.equal(iris.inbox, 3);
  assert.ok(iris.oldest_unacked, "the oldest unacked report's time");
  const m = rowOf(fl, "maple-auth");
  assert.equal(m.unacked, 2, "review and landing reports not acked");
  const c = rowOf(fl, "cobalt-relay");
  assert.equal(c.launches.failed, 2);
  assert.deepEqual(c.launches.errors, ["agent name already used"]);
  assert.equal(c.stages.launching, 2, "failed launches are in the launch stage, not idle");
  assert.equal(rowOf(fl, "harbor-ui").launches.stuck, 1);
  assert.equal(rowOf(fl, "garnet-api").priority, true);
  assert.equal(rowOf(fl, "birch-notes").priority, false);
  assert.equal(rowOf(fl, "kestrel-ml").status, "paused");
  assert.equal(rowOf(fl, "lumen-docs").status, "archived");
  // CPU and RAM: delta-forge has a coordinator (5%, 300 MB) and two working
  // threads (25%, 500 MB each) in the fake /proc.
  const rss = (b) => Math.round(b / PAGE) * PAGE;
  assert.equal(d.rss, rss(300e6) + 2 * rss(500e6));
  assert.ok(Math.abs(d.cpu - 55) < 12, `cpu ${d.cpu}`);
  assert.equal(d.agents, 3);
  assert.equal(rowOf(fl, "fjord-sync").rss, 0, "an exited coordinator has no process");
  // Last activity: the newest of the coordinator and the threads.
  const ageMin = (s) => (Date.now() - Date.parse(s)) / 60000;
  assert.ok(Math.abs(ageMin(rowOf(fl, "maple-auth").last_activity) - 2) < 2, rowOf(fl, "maple-auth").last_activity);
  assert.equal(rowOf(fl, "lumen-docs").last_activity, "");
  out.api = { rows: fl.rows.length, delta: d, attention: fl.attention.map((a) => `${a.slug}:${a.kind}`) };
});

test("API: Attention is ranked (M3)", async () => {
  const fl = await getFleet();
  const got = fl.attention.map((a) => [a.slug, a.kind]);
  assert.deepEqual(got, ATTENTION, JSON.stringify(got));
  assert.ok(!fl.attention.some((a) => ["kestrel-ml", "lumen-docs"].includes(a.slug)), "paused/archived without a coordinator are not flagged");
  const cobalt = fl.attention.find((a) => a.slug === "cobalt-relay");
  assert.match(cobalt.text, /2 launches failed/);
  assert.match(cobalt.text, /agent name already used/);
  assert.equal(fl.attention[0].key, "hub:aurora-ledger");
  // Rows come in triage order: the attention ones first.
  assert.deepEqual(fl.rows.slice(0, 3).map((r) => r.slug), ["aurora-ledger", "birch-notes", "delta-forge"]);
});

test("window: 30 rows, labelled chips, ranked attention (M1, M2, M3, M10)", async () => {
  const page = await openPage();
  const win = await openMaster(page);
  assert.equal((await shownSlugs(page)).length, 30);
  // Chips carry their label as text, not only a colour.
  const chips = await page.$$eval('.hwin[data-win="master"] #fl-table tbody tr[data-slug] .fl-chip', (cs) => Object.fromEntries(cs.map((c) => [c.closest("tr").dataset.slug, [c.dataset.state, c.textContent.trim()]])));
  assert.deepEqual(chips["aurora-ledger"].slice(0, 1), ["blocked"]);
  assert.match(chips["aurora-ledger"][1], /Blocked/);
  assert.match(chips["birch-notes"][1], /Waiting on you/);
  assert.match(chips["ember-cache"][1], /Missing/);
  assert.match(chips["fjord-sync"][1], /Exited/);
  assert.notEqual(chips["ember-cache"][1], chips["fjord-sync"][1]);
  const attn = await page.$$eval('.hwin[data-win="master"] #fl-attn li[data-slug]', (ls) => ls.map((l) => [l.dataset.slug, l.dataset.kind]));
  assert.deepEqual(attn, ATTENTION);
  // A priority badge with words.
  const prio = await page.textContent('.hwin[data-win="master"] #fl-table tr[data-slug="garnet-api"] .fl-prio');
  assert.match(prio, /Priority/);
  // Docked by its dock button, it stays docked over a reload.
  await win.locator(".hw-dock").click();
  await page.waitForSelector('.wdock .hwin[data-win="master"], .hwin.docked[data-win="master"]');
  await page.screenshot({ path: join(artifacts, "fleet-docked.png") });
  await page.reload();
  // A narrow dock shows cards, a wide one the table: either way, 30.
  await page.waitForFunction(() => [...document.querySelectorAll('.hwin.docked[data-win="master"] :is(#fl-table tbody tr, .fl-card)[data-slug]')].filter((r) => r.offsetParent).length === 30);
  // Float it again for the shots.
  await page.evaluate(() => HDWin.float("master"));
  await page.waitForSelector('.hwin[data-win="master"]:not(.docked)');
  await page.screenshot({ path: join(artifacts, "fleet-window.png") });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("sort and filter (M4)", async () => {
  const page = await openPage();
  await openMaster(page);
  const W = '.hwin[data-win="master"]';
  // Sort by name: alphabetical; again: reversed.
  await page.click(`${W} th button[data-sort="name"]`);
  let s = await shownSlugs(page);
  const names = Object.fromEntries((await getFleet()).rows.map((r) => [r.slug, r.name]));
  const byName = [...NAMES].sort((a, b) => names[a].localeCompare(names[b]));
  assert.deepEqual(s, byName);
  await page.click(`${W} th button[data-sort="name"]`);
  assert.deepEqual(await shownSlugs(page), [...byName].reverse());
  // Unacked reports, most first.
  await page.click(`${W} th button[data-sort="unacked"]`);
  s = await shownSlugs(page);
  assert.deepEqual(s.slice(0, 2), ["iris-index", "jade-queue"]);
  // Filter: coordinators missing or exited.
  await page.selectOption(`${W} #fl-filter`, "coord-down");
  assert.deepEqual((await shownSlugs(page)).sort(), ["ember-cache", "fjord-sync", "kestrel-ml", "lumen-docs"]);
  await page.selectOption(`${W} #fl-filter`, "needs-you");
  assert.deepEqual((await shownSlugs(page)).sort(), ["aurora-ledger", "birch-notes", "delta-forge", "garnet-api"]);
  await page.selectOption(`${W} #fl-filter`, "attention");
  assert.deepEqual((await shownSlugs(page)).sort(), [...new Set(ATTENTION.map(([x]) => x))].sort());
  await page.selectOption(`${W} #fl-filter`, "priority");
  assert.deepEqual(await shownSlugs(page), ["garnet-api"]);
  await page.selectOption(`${W} #fl-filter`, "");
  // Text filter on name or slug.
  await page.fill(`${W} #fl-q`, "relay");
  assert.deepEqual(await shownSlugs(page), ["cobalt-relay"]);
  await page.fill(`${W} #fl-q`, "no-such-project");
  assert.deepEqual(await shownSlugs(page), []);
  assert.match(await page.textContent(`${W} #fl-empty`), /No project matches/);
  await page.fill(`${W} #fl-q`, "");
  assert.equal((await shownSlugs(page)).length, 30);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("the project focus applies (M5)", async () => {
  const page = await openPage({}, "?focus=delta-forge,iris-index,tundra-maps");
  await openMaster(page);
  const W = '.hwin[data-win="master"]';
  assert.deepEqual((await shownSlugs(page)).sort(), ["delta-forge", "iris-index", "tundra-maps"]);
  const attn = await page.$$eval(`${W} #fl-attn li[data-slug]`, (ls) => ls.map((l) => l.dataset.slug));
  assert.deepEqual(attn, ["delta-forge", "iris-index"]);
  assert.match(await page.textContent(`${W} #fl-note`), /3 of 30/);
  // A focus change follows at once.
  await page.evaluate(() => window.hd.setFocus(["aurora-ledger"]));
  await page.waitForFunction(() => document.querySelectorAll('.hwin[data-win="master"] #fl-table tbody tr[data-slug]').length === 1);
  assert.deepEqual(await shownSlugs(page), ["aurora-ledger"]);
  await page.evaluate(() => window.hd.setFocus([]));
  await page.waitForFunction(() => document.querySelectorAll('.hwin[data-win="master"] #fl-table tbody tr[data-slug]').length === 30);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a row or an attention item opens the coordinator window (M6)", async () => {
  const page = await openPage();
  await openMaster(page);
  const W = '.hwin[data-win="master"]';
  // A checkbox selects, never opens.
  await page.click(`${W} #fl-table tr[data-slug="tundra-maps"] input.fl-sel`);
  await sleep(200);
  assert.equal(await page.evaluate(() => HDWin.has("thread:hub:tundra-maps")), false);
  await page.click(`${W} #fl-table tr[data-slug="tundra-maps"] .fl-name`);
  await page.waitForFunction(() => HDWin.has("thread:hub:tundra-maps"));
  await page.evaluate(() => HDWin.close("thread:hub:tundra-maps"));
  await page.click(`${W} #fl-attn li[data-slug="aurora-ledger"] button`);
  await page.waitForFunction(() => HDWin.has("thread:hub:aurora-ledger"));
  await page.evaluate(() => HDWin.close("thread:hub:aurora-ledger"));
  // Enter on a focused row opens it too.
  await page.focus(`${W} #fl-table tr[data-slug="umber-chat"]`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => HDWin.has("thread:hub:umber-chat"));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("multi-select and copy a summary (M7)", async () => {
  const page = await openPage({ permissions: ["clipboard-read", "clipboard-write"] });
  await openMaster(page);
  const W = '.hwin[data-win="master"]';
  await page.click(`${W} th button[data-sort="name"]`);
  // Shift-click selects the range between two rows.
  await page.click(`${W} #fl-table tr[data-slug="amber-wiki"] input.fl-sel`);
  await page.click(`${W} #fl-table tr[data-slug="cedar-sdk"] input.fl-sel`, { modifiers: ["Shift"] });
  const range = ["amber-wiki", "aurora-ledger", "basalt-etl", "birch-notes", "cedar-sdk"];
  const sel = () => page.$$eval(`${W} #fl-table tr[data-slug].sel`, (rs) => rs.map((r) => r.dataset.slug));
  assert.deepEqual(await sel(), range);
  assert.match(await page.textContent(`${W} #fl-count`), /5 selected/);
  // The selection bar copies and clears; the bulk actions (stage 1b,
  // fleet-actions.test.mjs) sit in their own toolbar, none of them tier 3.
  const acts = await page.$$eval(`${W} .fl-selbar button`, (bs) => bs.map((b) => b.id));
  assert.deepEqual(acts.sort(), ["fl-clear", "fl-copy"]);
  const bulk = await page.$$eval(`${W} .fl-actions button`, (bs) => bs.map((b) => b.dataset.op));
  assert.deepEqual(bulk.sort(), ["message", "nudge", "open", "pause", "priority", "resume", "set", "sweep"]);
  await page.click(`${W} #fl-copy`);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  for (const s of range) assert.ok(text.includes(s), `${s} in the summary`);
  assert.ok(!text.includes("dune-player"));
  assert.match(text, /Aurora Ledger.*coordinator blocked/i);
  out.summary = text;
  // Select all takes only the rows a filter shows.
  await page.click(`${W} #fl-clear`);
  await page.selectOption(`${W} #fl-filter`, "needs-you");
  await page.click(`${W} #fl-sel-all`);
  assert.deepEqual((await sel()).sort(), ["aurora-ledger", "birch-notes", "delta-forge", "garnet-api"]);
  await page.screenshot({ path: join(artifacts, "fleet-select.png") });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("phone: cards, no sideways scroll (M8)", async () => {
  const page = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.click("#master-open");
  await page.waitForSelector('.hwin[data-win="master"] .fl-card[data-slug]');
  const m = await page.evaluate(() => {
    const w = document.querySelector('.hwin[data-win="master"]');
    const b = w.querySelector(".hw-body");
    const cards = [...w.querySelectorAll(".fl-card[data-slug]")].filter((c) => c.offsetParent).length;
    return { right: w.getBoundingClientRect().right, vw: innerWidth, scroll: b.scrollWidth - b.clientWidth, cards, table: !!w.querySelector("#fl-table")?.offsetParent };
  });
  assert.equal(m.cards, 30, JSON.stringify(m));
  assert.equal(m.table, false, "the table is not shown on a phone");
  assert.ok(m.right <= m.vw + 1 && m.scroll <= 1, JSON.stringify(m));
  await page.screenshot({ path: join(artifacts, "fleet-phone.png") });
  // A card opens the coordinator too.
  await page.click('.hwin[data-win="master"] .fl-card[data-slug="birch-notes"] .fl-name');
  await page.waitForFunction(() => HDWin.has("thread:hub:birch-notes"));
  out.phone = m;
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("no extra CLI calls (M9)", async () => {
  // A second server that never polls on its own: every call after the
  // first tick would be the Master window's.
  const port = await freePort();
  const qlog = join(f.tmp, "quiet-calls");
  writeFileSync(qlog, "");
  const quiet = start(port, ["--poll", "1h", "--threads-every", "1h", "--gh-every", "1h", "--threads-max-age", "1h", "--quiet-every", "1h"], qlog);
  const u = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await getFleet(u)).rows.length === 30 && (await (await fetch(u + "/api/state")).json()).threads.length > 0, 20_000);
    await sleep(1500); // the first tick's prompt reads settle
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const fleetGets = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/fleet") fleetGets.push(Date.now()); });
    await page.goto(u + "/");
    await page.waitForFunction(() => window.hd?.state().projects.length === 30);
    await sleep(1500);
    const mark = readFileSync(qlog, "utf8").split("\n").filter(Boolean).length;
    await page.click("#master-open");
    await page.waitForSelector('.hwin[data-win="master"] #fl-table tbody tr[data-slug]');
    await page.click('.hwin[data-win="master"] th button[data-sort="name"]');
    await page.selectOption('.hwin[data-win="master"] #fl-filter', "attention");
    for (let i = 0; i < 10; i++) await getFleet(u);
    await sleep(6000);
    const lines = readFileSync(qlog, "utf8").split("\n").filter(Boolean).slice(mark);
    out.cli = { after: lines, fleetGets: fleetGets.length };
    assert.deepEqual(lines, [], "no CLI call from the Master window or /api/fleet");
    // No timer polling: with nothing changing, a handful of fetches at most
    // (open, plus system frames as CPU samples arrive), not one a second.
    assert.ok(fleetGets.length <= 4, `fetched /api/fleet ${fleetGets.length} times in 6 s`);
    await page.close();
  } finally {
    quiet.kill();
  }
});

test("the table follows the snapshot (live)", async () => {
  const page = await openPage();
  await openMaster(page);
  // tundra-maps' coordinator starts working.
  const panes = JSON.parse(readFileSync(f.panesFile, "utf8"));
  const ws = `f${String(NAMES.indexOf("tundra-maps")).padStart(2, "0")}`;
  const p = panes.result.panes.find((x) => x.pane_id === `${ws}:c1`);
  assert.equal(SPEC["tundra-maps"].coord[0], "idle");
  p.agent_status = "working";
  writeFileSync(f.panesFile, JSON.stringify(panes));
  await page.waitForFunction(() => document.querySelector('.hwin[data-win="master"] #fl-table tr[data-slug="tundra-maps"] .fl-chip')?.dataset.state === "working", null, { timeout: 15_000 });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
