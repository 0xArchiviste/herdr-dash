// E2E for the Memory map: a zoomable treemap of what holds memory, machine
// → project → thread or coordinator → agent process → its children, plus
// a "Not herdr" bucket for every process outside a herdr pane. Runs the real
// binary against a fake /proc (smaps_rollup, cwd links, cgroup files, PSI)
// and a fake cgroup tree, so every byte is known.
//
// Ways this could fail, written before the feature existed:
//  M1. /proc is walked in detail (every process, smaps_rollup) while no
//      Memory map is open, or keeps going after it closes; smaps_rollup is
//      read more often than --pss-every.
//  M2. The hierarchy is wrong: a pane's child processes are not under their
//      parent, a thread's processes land in another thread or project, the
//      coordinator, a leftover or an orphan pane is not under its project,
//      Dash and the voice sidecar are not in a group of their own.
//  M3. Areas do not follow memory: sibling tiles' areas are not in the ratio
//      of their bytes, or a tile's bytes are not the sum of its processes.
//  M4. Colours do not follow the state (working, waiting, review, leftover,
//      orphan, coordinator, Dash) or differ from the graph's.
//  M5. Processes outside herdr panes are dropped, or not grouped by name in
//      "Not herdr"; kernel threads (no memory) are listed.
//  M6. Zoom: a click does not zoom, the breadcrumb does not lead back, Esc
//      does not zoom out (or closes the window while zoomed).
//  M7. The tooltip lacks RSS, PSS, CPU, process count, age, state or cwd.
//  M8. A double-click on a thread or coordinator tile does not open its
//      window.
//  M9. "Close leftover…" closes without the confirmation, runs anything but
//      the leftover close (PR #42), or shows on tiles that are not leftovers.
// M10. Machine totals miss used, available, cache, swap, PSI, or the herdr
//      server's cgroup current against MemoryHigh / MemoryMax.
// M11. PSS is claimed where it was not read: the area metric is not named,
//      a process without smaps_rollup is dropped instead of using RSS.
// M12. History: no sparkline per project; a thread that grew is missing
//      from the top growers.
// M13. The graph's "size by memory" does not resize nodes by memory, or
//      stays on after it is turned off.
// M14. Treemap and graph are not linked: a tile click does not mark the
//      graph node, a graph selection does not mark the tile.
// M15. The stream sends whole frames each time instead of deltas, or sends
//      deltas when nothing changed.
// M16. Phone: a treemap too small to use instead of a sorted list with bars.
// M17. Entry points: no Memory button in the filter bar; the System strip's
//      RAM figure does not open it.
//
// Artifacts: e2e/artifacts/memory-*.png and memory.json.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { td, stub, artifacts, startServer, freePort, waitFor } from "./helpers.mjs";
import { FakeProc, GiB, PAGE } from "./fakeproc.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MiB = 1024 ** 2;
const pg = (b) => Math.round(b / PAGE) * PAGE; // RSS as /proc reports it, in pages
const kib = (b) => Math.round(b / 1024) * 1024; // PSS as smaps_rollup reports it
const out = {};

const tmp = mkdtempSync(join(tmpdir(), "dash-mem-"));
const root = join(tmp, "root"), stubDir = join(tmp, "stub"), log = join(tmp, "calls"), proc = join(tmp, "proc"), cg = join(tmp, "cgroup");
const panesFile = join(tmp, "panes.json"), audit = join(tmp, "audit.jsonl");
const CG = "/user.slice/user-1000.slice/user@1000.service/app.slice/herdr-server.service";
const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);

// The fixture's panes, plus a leftover (resolved alpha/t-0004's pane, alive
// in its worktree) and an orphan agent pane with alpha's tokens.
function writePanes() {
  const own = JSON.parse(readFileSync(join(stub, "panes.json"), "utf8")).result.panes;
  const extra = [
    { agent: "claude", agent_status: "idle", cwd: "/fixture/wt/alpha-t-0004", pane_id: "w1D:p1", tab_id: "w1D:t1", workspace_id: "w1D" },
    { agent: "claude", agent_status: "idle", cwd: "/fixture/scratch", display_agent: "Scratch helper", pane_id: "w4E:p1", tab_id: "w4E:t1", workspace_id: "w4E", tokens: { hp_project: "alpha" } },
  ];
  writeFileSync(panesFile, '{"id":"cli:pane:list","result":{"panes":[\n' + [...own, ...extra].map((r) => JSON.stringify(r)).join(",\n") + "\n]}}\n");
}
function writeCgroup(current) {
  const d = join(cg, CG);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "memory.current"), `${current}\n`);
  writeFileSync(join(d, "memory.high"), `${60 * GiB}\n`);
  writeFileSync(join(d, "memory.max"), `${62 * GiB}\n`);
  writeFileSync(join(d, "memory.peak"), `${58 * GiB}\n`);
  writeFileSync(join(d, "memory.events"), "low 0\nhigh 12\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n");
}

// Every process, by pid: [comm, ppid, rss, pss, pane, cwd]. PSS is below RSS
// (shared pages split); 704 has no smaps_rollup (another user's), so RSS.
const P = {
  100: ["bash", 1, 8 * MiB, 4 * MiB, "w1A:p1", "/fixture/wt/alpha-t-0001"],
  101: ["claude", 100, 1 * GiB, 0.75 * GiB, "w1A:p1", "/fixture/wt/alpha-t-0001"],
  102: ["node", 101, 0.5 * GiB, 0.375 * GiB, "w1A:p1", "/fixture/wt/alpha-t-0001"],
  103: ["gopls", 102, 0.25 * GiB, 0.25 * GiB, "w1A:p1", "/fixture/wt/alpha-t-0001"],
  201: ["claude", 1, 0.25 * GiB, 0.1875 * GiB, "w1B:p1", "/fixture/wt/alpha-t-0002"],
  211: ["codex", 1, 0.5 * GiB, 0.375 * GiB, "w1C:p1", "/fixture/wt/alpha-t-0003"],
  301: ["claude", 1, 0.625 * GiB, 0.5 * GiB, "w1Z:p1", "/projects/alpha"],
  401: ["claude", 1, 0.5 * GiB, 0.375 * GiB, "w2A:p1", "/fixture/wt/beta-t-0001"],
  501: ["claude", 1, 1 * GiB, 0.875 * GiB, "w1D:p1", "/fixture/wt/alpha-t-0004"],
  511: ["claude", 1, 0.5 * GiB, 0.5 * GiB, "w4E:p1", "/fixture/scratch"],
  701: ["sshd", 1, 32 * MiB, 16 * MiB, null, "/"],
  702: ["sshd", 701, 24 * MiB, 12 * MiB, null, "/"],
  703: ["postgres", 1, 2 * GiB, 1.5 * GiB, null, "/var/lib/postgresql"],
  704: ["secretive", 1, 64 * MiB, null, null, null],
  705: ["kworker/0:1", 2, 0, null, null, null],
};
const valueOf = (pid) => (P[pid][3] == null ? pg(P[pid][2]) : kib(P[pid][3]));

let server, url, browser, fp, ticker;
before(async () => {
  mkdirSync(artifacts, { recursive: true });
  cpSync(join(td, "root"), root, { recursive: true });
  cpSync(stub, stubDir, { recursive: true });
  writeFileSync(log, "");
  writePanes();
  writeCgroup(40 * GiB);
  fp = new FakeProc(proc);
  fp.write();
  const port = await freePort();
  server = startServer(port, log, ["--root", root, "--herdr", join(stubDir, "herdr"), "--proc", proc, "--cgroup", cg,
    "--pss-every", "3s", "--mem-history-every", "1s", "--fleet-audit", audit, "--write-burst", "100", "--write-per-min", "600"],
  { HERDR_DASH_HERDR_PROJECTS: join(stubDir, "herdr-projects"), STUB_PANES: panesFile });
  url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.find((t) => t.key === "alpha/t-0004")?.state === "leftover", 15_000);
  const me = server.pid;
  for (const [pid, [comm, ppid, rss, pss, pane, cwd]] of Object.entries(P)) {
    fp.add(+pid, comm, { ppid, rss, pss, cwd, cpu: pid === "101" ? 0.5 : 0.01, env: pane ? { HERDR_PANE_ID: pane } : null, cgroup: pane ? CG : "/init.scope", age: pid === "101" ? 5400 : null });
  }
  fp.add(me, "herdr-dash", { cpu: 0.01, rss: 40 * MiB, pss: 30 * MiB });
  fp.add(601, "python3", { ppid: me, cpu: 0.02, rss: 0.875 * GiB, pss: 0.75 * GiB, env: { HERDR_DASH_ROLE: `voice:${me}` } });
  fp.write();
  ticker = setInterval(() => fp.advance(), 100);
  browser = await chromium.launch();
});

after(async () => {
  clearInterval(ticker);
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "memory.json"), JSON.stringify(out, null, 2) + "\n");
  rmSync(tmp, { recursive: true, force: true });
});

const stats = async () => (await fetch(url + "/api/system/stats")).json();

async function openPage(viewport = { width: 1440, height: 900 }, extra = {}) {
  const page = await browser.newPage({ viewport, ...extra });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.hd?.state().threads.some((t) => t.key === "alpha/t-0001"));
  return page;
}
const tile = (page, id) => page.locator(`.hwin[data-win="memory"] .mm-tile[data-id="${id}"]`);
async function openMemory(page) {
  await page.click("#mem-open");
  await page.waitForSelector('.hwin[data-win="memory"] .mm-tile[data-id="p:103"]', { timeout: 15_000 });
}
const area = async (loc) => { const b = await loc.boundingBox(); return b.width * b.height; };

// Reads `event: memory` / `event: memdelta` off the Memory map's stream.
function memEvents() {
  const evs = [], ac = new AbortController();
  (async () => {
    try {
      const r = await fetch(url + "/api/memory/events", { signal: ac.signal });
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = ev.match(/^event: (\w+)\ndata: (.*)$/s);
          if (m) evs.push({ type: m[1], data: JSON.parse(m[2]), bytes: m[2].length });
        }
      }
    } catch {}
  })();
  return { evs, stop: () => ac.abort() };
}

test("no detail sampling until the Memory map opens, none after it closes; PSS at most every --pss-every (M1)", async () => {
  const page = await openPage();
  await page.waitForFunction(() => /\d%/.test(document.querySelector('#sys [data-id="cpu"]')?.textContent || ""), null, { timeout: 10_000 });
  const s0 = await stats();
  await sleep(3000);
  const s1 = await stats();
  out.closed = { samples: s1.samples - s0.samples, mem_samples: s1.mem_samples - s0.mem_samples, pss_passes: s1.pss_passes - s0.pss_passes };
  assert.ok(s1.samples > s0.samples, "the System strip samples while the page is visible");
  assert.equal(s1.mem_samples, s0.mem_samples, "walked every process with no Memory map open (M1)");
  assert.equal(s1.pss_passes, s0.pss_passes, "read smaps_rollup with no Memory map open (M1)");

  await openMemory(page);
  const a = await stats();
  await sleep(7000);
  const b = await stats();
  out.open = { mem_samples: b.mem_samples - a.mem_samples, pss_passes: b.pss_passes - a.pss_passes };
  assert.ok(b.mem_samples - a.mem_samples >= 4, `detail samples while open: ${b.mem_samples - a.mem_samples}`);
  assert.ok(b.pss_passes - a.pss_passes >= 1 && b.pss_passes - a.pss_passes <= 3, `PSS passes in 7 s at --pss-every 3s: ${b.pss_passes - a.pss_passes}`);

  await page.locator('.hwin[data-win="memory"] .hw-close').click();
  await sleep(1500);
  const c = await stats();
  await sleep(3000);
  const d = await stats();
  assert.equal(d.mem_samples, c.mem_samples, "kept walking /proc after the Memory map closed (M1)");
  assert.ok(d.samples > c.samples, "the System strip still samples");

  // Hidden page: the Memory map's stream closes too.
  await openMemory(page);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(1500);
  const e = await stats();
  await sleep(3000);
  assert.equal((await stats()).mem_samples, e.mem_samples, "walked /proc for a hidden page (M1)");
  await page.close();
});

test("hierarchy, areas, colours, Not herdr, metric and totals (M2–M5, M10, M11)", async () => {
  const page = await openPage();
  await openMemory(page);
  const win = page.locator('.hwin[data-win="memory"]');
  // Wait for a PSS pass to land.
  await page.waitForFunction(() => document.querySelector('.hwin[data-win="memory"] .mm-metric')?.dataset.metric === "pss", null, { timeout: 10_000 });

  // M2: nesting, by the DOM's own containment.
  const inside = (child, parent) => page.evaluate(([c, p]) => {
    const a = document.querySelector(`.mm-tile[data-id="${c}"]`), b = document.querySelector(`.mm-tile[data-id="${p}"]`);
    return !!a && !!b && a.dataset.parent === p;
  }, [child, parent]);
  for (const [c, p] of [["proj:alpha", "machine"], ["th:alpha/t-0001", "proj:alpha"], ["p:100", "th:alpha/t-0001"], ["p:101", "p:100"],
    ["p:102", "p:101"], ["p:103", "p:102"], ["th:alpha/t-0002", "proj:alpha"], ["hub:alpha", "proj:alpha"], ["lo:w1D:p1", "proj:alpha"],
    ["lo:w4E:p1", "proj:alpha"], ["th:beta/t-0001", "proj:beta"], ["dash", "herdr-dash"], ["voice", "herdr-dash"], ["nh", "machine"],
    ["nh:sshd", "nh"], ["p:701", "nh:sshd"], ["p:702", "nh:sshd"], ["nh:postgres", "nh"], ["nh:secretive", "nh"]]) {
    assert.ok(await inside(c, p), `${c} should sit in ${p} (M2/M5)`);
  }
  assert.equal(await page.locator('.mm-tile[data-id="p:705"]').count(), 0, "a kernel thread with no memory is listed (M5)");
  assert.equal(await page.locator('.mm-tile[data-id="nh:kworker/0:1"]').count(), 0);

  // M3: bytes are sums; sibling areas follow bytes.
  const bytes = async (id) => Number(await tile(page, id).getAttribute("data-bytes"));
  const t1 = [100, 101, 102, 103].reduce((s, p) => s + valueOf(p), 0);
  assert.equal(await bytes("th:alpha/t-0001"), t1, "t-0001 is the sum of its four processes' PSS");
  assert.equal(await bytes("nh:secretive"), valueOf(704), "no smaps_rollup: RSS (M11)");
  const alpha = await bytes("proj:alpha"), beta = await bytes("proj:beta");
  const ratio = (await area(tile(page, "proj:alpha"))) / (await area(tile(page, "proj:beta")));
  out.areas = { alpha, beta, areaRatio: ratio, byteRatio: alpha / beta };
  assert.ok(Math.abs(ratio / (alpha / beta) - 1) < 0.15, `alpha/beta areas ${ratio.toFixed(2)} vs bytes ${(alpha / beta).toFixed(2)} (M3)`);
  const r2 = (await area(tile(page, "th:alpha/t-0001"))) / (await area(tile(page, "hub:alpha")));
  assert.ok(Math.abs(r2 / (t1 / valueOf(301)) - 1) < 0.2, `t-0001/coordinator areas ${r2.toFixed(2)} vs bytes ${(t1 / valueOf(301)).toFixed(2)} (M3)`);

  // M4: states and colours, the graph's.
  const want = { "th:alpha/t-0001": ["working", "rgb(152, 188, 55)"], "th:alpha/t-0002": ["blocked", "rgb(239, 47, 39)"],
    "th:alpha/t-0003": ["review", "rgb(104, 168, 228)"], "hub:alpha": ["coordinator", "rgb(255, 135, 0)"], "lo:w1D:p1": ["leftover", "rgb(154, 127, 196)"],
    "lo:w4E:p1": ["orphan", "rgb(255, 92, 143)"], "dash": ["dash", "rgb(10, 174, 179)"], "voice": ["dash", "rgb(10, 174, 179)"], "th:beta/t-0001": ["landing", "rgb(43, 228, 208)"],
    "nh:postgres": ["other", null] };
  const colours = {};
  for (const [id, [state, rgb]] of Object.entries(want)) {
    assert.equal(await tile(page, id).getAttribute("data-state"), state, `${id} state (M4)`);
    const c = await tile(page, id).evaluate((e) => getComputedStyle(e.querySelector(":scope > .mm-head") || e).backgroundColor);
    colours[id] = c;
    if (rgb) assert.equal(c, rgb, `${id} colour (M4)`);
  }
  out.colours = colours;
  // A leaf process takes its owner's colour.
  assert.equal(await tile(page, "p:103").evaluate((e) => getComputedStyle(e).backgroundColor), "rgb(152, 188, 55)");

  // M11: the metric is named, with the shared-memory caveat.
  const metric = await win.locator(".mm-metric").innerText();
  assert.match(metric, /PSS/);
  assert.match(await win.locator(".mm-note").innerText(), /shared/i);
  // RSS on demand: the tile follows.
  await win.locator('.mm-metric button[data-m="rss"]').click();
  await waitFor(async () => (await bytes("th:alpha/t-0001")) === [100, 101, 102, 103].reduce((s, p) => s + pg(P[p][2]), 0));
  await win.locator('.mm-metric button[data-m="pss"]').click();
  await waitFor(async () => (await bytes("th:alpha/t-0001")) === t1);

  // M10: totals, PSI, the herdr server's cgroup.
  const tot = win.locator(".mm-totals");
  const t = async (k) => (await tot.locator(`[data-k="${k}"]`).innerText()).replace(/\s+/g, " ");
  assert.match(await t("used"), /13\.0 GiB/);
  assert.match(await t("available"), /3\.0 GiB/);
  assert.match(await t("cache"), /2\.5 GiB/);
  assert.match(await t("swap"), /0\.2 GiB/);
  assert.match(await t("psi"), /12\.5%/);
  assert.match(await t("psi"), /3\.3%|3\.2%/);
  const cgt = await t("cgroup");
  out.cgroup = cgt;
  assert.match(cgt, /herdr-server\.service/);
  assert.match(cgt, /40\.0 GiB/);
  assert.match(cgt, /60\.0 GiB/);
  assert.match(cgt, /62\.0 GiB/);
  assert.match(cgt, /oom.?kill 1/i);
  assert.equal(await tot.locator('[data-k="cgroup"]').getAttribute("data-level"), "ok");
  writeCgroup(55 * GiB); // past 85% of MemoryMax (critical; 75% warns)
  await waitFor(async () => (await tot.locator('[data-k="cgroup"]').getAttribute("data-level")) === "crit", 8000);
  writeCgroup(50 * GiB);
  await waitFor(async () => (await tot.locator('[data-k="cgroup"]').getAttribute("data-level")) === "warn", 8000);
  await page.screenshot({ path: join(artifacts, "memory-map.png") });
  await win.screenshot({ path: join(artifacts, "memory-window.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("zoom, breadcrumb, Esc, tooltip, double-click, graph link (M6–M8, M14)", async () => {
  const page = await openPage();
  await openMemory(page);
  const win = page.locator('.hwin[data-win="memory"]');
  const crumbs = () => win.locator(".mm-crumbs button").evaluateAll((es) => es.map((e) => e.dataset.id));

  // M7: tooltip on a thread.
  await tile(page, "th:alpha/t-0001").locator(".mm-head").first().hover();
  const tip = page.locator("#mm-tip");
  await tip.waitFor({ state: "visible" });
  const tt = await tip.innerText();
  out.tooltip = tt;
  for (const re of [/RSS/, /PSS/, /CPU/, /4 processes/, /age/i, /Working/, /\/fixture\/wt\/alpha-t-0001/]) assert.match(tt, re, `tooltip lacks ${re} (M7)`);
  // A process: its own age (1 h 30 m).
  await tile(page, "s:101").hover();
  await waitFor(async () => /claude/.test(await tip.innerText()) && /1h 30m/.test(await tip.innerText()));

  // M14: clicking a tile marks its node on the graph.
  await tile(page, "th:alpha/t-0003").locator(".mm-head").first().click();
  await page.waitForSelector('#graph g.node.memhl[data-key="alpha/t-0003"]');

  // M6: click zooms into the project, then the thread; crumbs lead back; Esc steps out.
  await waitFor(async () => (await crumbs()).join() === "machine,proj:alpha"); // that click zoomed in too
  await win.locator('.mm-crumbs button[data-id="machine"]').click();
  await waitFor(async () => (await crumbs()).join() === "machine");
  await tile(page, "p:103").click({ position: { x: 4, y: 4 } });
  await waitFor(async () => (await crumbs()).join() === "machine,proj:alpha");
  const zoomed = await area(tile(page, "th:alpha/t-0001"));
  await tile(page, "p:103").click({ position: { x: 4, y: 4 } });
  await waitFor(async () => (await crumbs()).join() === "machine,proj:alpha,th:alpha/t-0001");
  assert.ok((await area(tile(page, "p:103"))) > 0);
  await page.screenshot({ path: join(artifacts, "memory-zoom.png") });
  await win.locator('.mm-crumbs button[data-id="proj:alpha"]').click();
  await waitFor(async () => (await crumbs()).join() === "machine,proj:alpha");
  assert.ok(Math.abs((await area(tile(page, "th:alpha/t-0001"))) - zoomed) < zoomed * 0.05);
  await win.focus();
  await page.keyboard.press("Escape");
  await waitFor(async () => (await crumbs()).join() === "machine");
  assert.equal(await win.count(), 1, "Esc while zoomed closed the window (M6)");

  // M14 the other way: selecting a node on the graph marks its tile.
  await page.evaluate(() => window.hd.select("alpha/t-0002"));
  await page.waitForSelector('.mm-tile.hl[data-id="th:alpha/t-0002"]');

  // M8: double-click opens the thread's window, and the coordinator's.
  await tile(page, "th:alpha/t-0001").locator(".mm-head").first().dblclick();
  await page.waitForSelector('.hwin[data-win="thread:alpha/t-0001"]');
  await page.locator('.hwin[data-win="thread:alpha/t-0001"] .hw-close').click();
  await tile(page, "hub:alpha").locator(".mm-head").first().dblclick();
  await page.waitForSelector('.hwin[data-win="thread:hub:alpha"]');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("Close leftover… only on leftover tiles, through the confirmation (M9)", async () => {
  const page = await openPage();
  await openMemory(page);
  const win = page.locator('.hwin[data-win="memory"]');
  assert.equal(await win.locator('.mm-tile[data-id="th:alpha/t-0001"] .mm-close').count(), 0);
  assert.equal(await win.locator('.mm-tile[data-id="hub:alpha"] .mm-close').count(), 0);
  assert.equal(await win.locator('.mm-tile[data-id="nh:postgres"] .mm-close').count(), 0);
  assert.equal(await win.locator(".mm-close").count(), 2, "one per leftover or orphan pane");
  // Zoom into alpha so the leftover tile has room for its header.
  await tile(page, "lo:w1D:p1").click({ position: { x: 4, y: 4 } });
  await waitFor(async () => (await win.locator(".mm-crumbs button").count()) === 2);
  const m = calls().length;
  await win.locator('.mm-tile[data-id="lo:w1D:p1"] .mm-close').click();
  await page.waitForSelector("#dlg[open]");
  const text = await page.locator("#dlg").innerText();
  for (const s of ["t-0004", "w1D:p1", "claude", "/fixture/wt/alpha-t-0004"]) assert.ok(text.includes(s), `dialog lacks ${s}`);
  await page.locator("#dlg").screenshot({ path: join(artifacts, "memory-close-confirm.png") });
  await page.click("#dlg-cancel");
  await sleep(300);
  assert.ok(!calls().slice(m).some((l) => l.includes("pane close")), "cancel closed the pane");
  await win.locator('.mm-tile[data-id="lo:w1D:p1"] .mm-close').click();
  await page.waitForSelector("#dlg[open]");
  await page.click("#dlg-ok");
  await waitFor(() => calls().slice(m).includes("herdr pane close w1D:p1"));
  assert.ok(calls().slice(m).includes("herdr pane get w1D:p1"), "the pane is re-checked before it closes");
  await waitFor(() => { try { return readFileSync(audit, "utf8").includes("close-leftover"); } catch { return false; } });
  const a = readFileSync(audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.op === "close-leftover");
  assert.equal(a.length, 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("deltas only, growers and project sparklines (M12, M15)", async () => {
  const st = memEvents();
  await waitFor(() => st.evs.some((e) => e.type === "memory"), 8000);
  const full = st.evs.find((e) => e.type === "memory");
  assert.ok(full.data.procs.length >= 15, "the first event is the whole frame");
  out.fullBytes = full.bytes;
  // Freeze: after at most one delta (CPU falls to 0), nothing more is sent.
  fp.frozen = true;
  await sleep(2500);
  const n = st.evs.length;
  await sleep(3000);
  assert.equal(st.evs.length, n, "sent a delta with nothing changed (M15)");
  // One process grows: the delta carries just it.
  P[102][2] += 0.5 * GiB; P[102][3] += 0.5 * GiB;
  fp.procs.get(102).rss = P[102][2]; fp.procs.get(102).pss = P[102][3];
  fp.write();
  const d = await waitFor(() => st.evs.slice(n).find((e) => e.type === "memdelta" && e.data.up?.some((p) => p.pid === 102)), 8000);
  out.delta = { bytes: d.bytes, up: d.data.up.map((p) => p.pid), gone: d.data.gone };
  assert.ok(d.data.up.length <= 2, `delta carries ${d.data.up.length} processes (M15)`);
  assert.ok(d.bytes < full.bytes / 4, "delta is not a whole frame");
  fp.frozen = false;
  st.stop();

  // M12: alpha/t-0001 grew by 0.5 GiB of RSS: first among growers.
  const page = await openPage();
  await openMemory(page);
  const win = page.locator('.hwin[data-win="memory"]');
  await win.locator(".mm-growers li").first().waitFor({ timeout: 10_000 });
  await waitFor(async () => (await win.locator(".mm-growers li").first().getAttribute("data-key")) === "alpha/t-0001", 10_000);
  const g = await win.locator(".mm-growers li").first().innerText();
  out.grower = g;
  assert.match(g, /\+512 MB|\+0\.5 GB/);
  await waitFor(async () => (await win.locator('.mm-proj[data-slug="alpha"] svg polyline').getAttribute("points") || "").split(" ").length >= 2);
  await win.locator(".mm-side").screenshot({ path: join(artifacts, "memory-history.png") });
  // Clicking a grower opens its thread on the map.
  await win.locator('.mm-growers li[data-key="alpha/t-0001"] button').click();
  await waitFor(() => page.evaluate(() => window.hd.selected() === "alpha/t-0001"));
  await page.close();
});

test("graph: size nodes by memory, then back (M13)", async () => {
  const page = await openPage();
  const r = (k) => page.locator(`#graph g.node[data-key="${k}"] circle.core`).evaluate((c) => Number(c.getAttribute("r")));
  await page.waitForSelector('#graph g.node[data-key="alpha/t-0001"]');
  await sleep(1200);
  const before = { t1: await r("alpha/t-0001"), t2: await r("alpha/t-0002") };
  await page.click("#size-mem");
  assert.equal(await page.locator("#size-mem").getAttribute("aria-pressed"), "true");
  // t-0001 holds ~2.25 GiB of RSS, t-0002 0.25 GiB.
  await waitFor(async () => (await r("alpha/t-0001")) > (await r("alpha/t-0002")) * 1.8, 6000);
  const on = { t1: await r("alpha/t-0001"), t2: await r("alpha/t-0002") };
  await page.screenshot({ path: join(artifacts, "memory-graph-size.png") });
  await page.click("#size-mem");
  await waitFor(async () => Math.abs((await r("alpha/t-0001")) - before.t1) < 0.6 && Math.abs((await r("alpha/t-0002")) - before.t2) < 0.6, 6000);
  out.radius = { before, on };
  await page.close();
});

test("entry points: RAM figure; phone: a sorted list with bars (M16, M17)", async () => {
  const page = await openPage();
  await page.waitForSelector('#sys [data-id="mem"]', { timeout: 10_000 });
  await page.click('#sys [data-id="mem"]');
  await page.waitForSelector('.hwin[data-win="memory"] .mm-tile[data-id="proj:alpha"]', { timeout: 10_000 });
  assert.ok(await page.locator("#sys-pop").isHidden(), "the RAM figure opens the Memory map, not the popover");
  await page.close();

  const phone = await openPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await phone.click("#mem-open");
  const list = phone.locator('.hwin[data-win="memory"] .mm-list');
  await list.locator(".mm-row").first().waitFor({ timeout: 15_000 });
  assert.equal(await phone.locator('.hwin[data-win="memory"] .mm-map .mm-tile').count(), 0, "no treemap on a phone");
  const rows = await list.locator(".mm-row").evaluateAll((es) => es.map((e) => ({ id: e.dataset.id, b: Number(e.dataset.bytes), w: parseFloat(e.querySelector(".mm-bar i").style.width) })));
  out.phoneRows = rows;
  assert.deepEqual(rows.map((x) => x.b), [...rows.map((x) => x.b)].sort((a, b) => b - a), "heaviest first");
  assert.equal(rows[0].w, 100);
  assert.ok(Math.abs(rows[1].w - (100 * rows[1].b) / rows[0].b) < 1, "bars in proportion");
  // Tapping a project lists its threads; the breadcrumb leads back.
  await list.locator('.mm-row[data-id="proj:alpha"]').click();
  await list.locator('.mm-row[data-id="th:alpha/t-0001"]').waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page overflows by ${overflow}px`);
  await phone.screenshot({ path: join(artifacts, "memory-phone.png") });
  await phone.locator('.hwin[data-win="memory"] .mm-crumbs button[data-id="machine"]').click();
  await list.locator('.mm-row[data-id="proj:alpha"]').waitFor();
  assert.deepEqual(phone.errors, []);
  await phone.close();
});
