// E2E: what the dashboard costs the machine and the browser while nobody
// acts. Measured on a live install first (see the PR): ~90 herdr-projects
// runs a minute, CPU throttling, the snapshot lock held across a sqlite3
// run, an ~860 KB snapshot re-sent every poll and a force graph reheated
// by every update.
//
// Ways this could fail, written before the change:
//  1. `thread list <slug>` runs on every thread tick though nothing about
//     the project changed (same list line, same files under threads/ and
//     .state/, same panes).
//  2. Skipping unchanged projects hides a real change: a new or rewritten
//     file under threads/ or .state/, or a thread pane's live status.
//  3. A slow external read (the opencode sqlite3 query) runs with the
//     snapshot lock held, so /api/state and every stream stall behind it.
//  4. The event stream is not compressed for a client that accepts gzip, or
//     a compressed stream is buffered so events never arrive.
//  5. A hidden tab keeps its stream open, parsing and rendering every
//     snapshot; or a tab shown again misses what changed while hidden.
//  6. An update that changes no node (or a plain re-render) reheats the
//     settled force graph, so nodes keep moving and every frame redraws.
//
// Artifact: e2e/artifacts/perf.json (calls per minute, latencies, payloads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { td, stub, artifacts, startServer, freePort, waitFor } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};

function fixture(prefix) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const root = join(tmp, "root"), stubDir = join(tmp, "stub"), log = join(tmp, "calls");
  cpSync(join(td, "root"), root, { recursive: true });
  cpSync(stub, stubDir, { recursive: true });
  writeFileSync(log, "");
  const panesFile = join(tmp, "panes.json");
  writeFileSync(panesFile, readFileSync(join(stub, "panes.json")));
  return { tmp, root, stubDir, log, panesFile };
}
const calls = (log, re) => readFileSync(log, "utf8").split("\n").filter((l) => re.test(l)).length;

test("unchanged projects are not re-listed; changes still are", async () => {
  const f = fixture("dash-perf-");
  const port = await freePort();
  // --poll 1s: a thread tick every 3s.
  const server = startServer(port, f.log, ["--root", f.root], { STUB_PANES: f.panesFile, HERDR_DASH_HERDR_PROJECTS: join(f.stubDir, "herdr-projects") });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await (await fetch(base + "/api/state")).json()).threads.length > 0);
    const alpha = / thread list alpha /;
    const start = calls(f.log, alpha);
    await sleep(10_000); // three thread ticks, nothing changed
    const idle = calls(f.log, alpha) - start;
    out.idleThreadListsPer10s = idle;
    out.idleProjectListsPer10s = calls(f.log, /herdr-projects .* list$/);
    assert.equal(idle, 0, "alpha re-listed though nothing changed");

    // A thread file rewritten by herdr-projects: re-listed within a tick.
    let m = calls(f.log, alpha);
    writeFileSync(join(f.root, "alpha/threads/t-0002.md"), "# Report\n\nUpdated.\n");
    await waitFor(() => calls(f.log, alpha) > m, 8_000);

    // A thread pane's live status changes: re-listed too.
    m = calls(f.log, alpha);
    const panes = JSON.parse(readFileSync(f.panesFile, "utf8"));
    const p = panes.result.panes.find((p) => p.pane_id === "w1A:p1");
    p.agent_status = p.agent_status === "idle" ? "working" : "idle";
    writeFileSync(f.panesFile, JSON.stringify(panes));
    await waitFor(() => calls(f.log, alpha) > m, 8_000);

    // .state/ changes (the ticker's records) count as well.
    m = calls(f.log, alpha);
    mkdirSync(join(f.root, "alpha/.state"), { recursive: true });
    writeFileSync(join(f.root, "alpha/.state/ticker.json"), "{}");
    await waitFor(() => calls(f.log, alpha) > m, 8_000);
  } finally {
    server.kill();
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("a slow sqlite3 never holds up /api/state", async () => {
  const f = fixture("dash-perf-sql-");
  // An opencode pane, and a sqlite3 on PATH that hangs past its time limit.
  const panes = JSON.parse(readFileSync(f.panesFile, "utf8"));
  const oc = panes.result.panes.find((p) => p.pane_id === "w1A:p1");
  oc.agent = "opencode";
  oc.agent_session = { agent: "opencode", value: "ses_slow" };
  writeFileSync(f.panesFile, JSON.stringify(panes));
  const bin = join(f.tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sqlite3"), "#!/bin/sh\nsleep 5\n");
  chmodSync(join(bin, "sqlite3"), 0o755);
  writeFileSync(join(f.tmp, "opencode.db"), "");
  const port = await freePort();
  const server = startServer(port, f.log, ["--root", f.root, "--opencode-db", join(f.tmp, "opencode.db")], { STUB_PANES: f.panesFile, PATH: bin + ":" + process.env.PATH });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await (await fetch(base + "/api/state")).json()).threads.length > 0);
    let worst = 0;
    const end = Date.now() + 6_000;
    while (Date.now() < end) {
      const t = performance.now();
      await (await fetch(base + "/api/state")).arrayBuffer();
      worst = Math.max(worst, performance.now() - t);
      await sleep(50);
    }
    out.stateWorstMsWithSlowSqlite = Math.round(worst);
    assert.ok(worst < 400, `/api/state took ${Math.round(worst)} ms behind a slow sqlite3`);
  } finally {
    server.kill();
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("event stream is gzipped and still streams", async () => {
  const f = fixture("dash-perf-gz-");
  const port2 = await freePort();
  const server2 = startServer(port2, f.log, ["--root", f.root], { STUB_PANES: f.panesFile });
  try {
    const base = `http://127.0.0.1:${port2}`;
    await waitFor(async () => (await (await fetch(base + "/api/state")).json()).threads.length > 0);
    // fetch decodes gzip: the first event must arrive without the stream ending.
    const ctl = new AbortController();
    const r = await fetch(base + "/api/events", { headers: { "Accept-Encoding": "gzip" }, signal: ctl.signal });
    assert.equal(r.headers.get("content-encoding"), "gzip");
    const reader = r.body.getReader();
    let text = "";
    const t = setTimeout(() => ctl.abort(), 3_000);
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    clearTimeout(t);
    ctl.abort();
    assert.match(text, /^event: state\ndata: \{/);
    out.snapshotBytes = text.length;
  } finally {
    server2.kill();
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("hidden tab pauses the stream; the settled graph stays still", async () => {
  const f = fixture("dash-perf-ui-");
  const port = await freePort();
  const server = startServer(port, f.log, ["--root", f.root], { STUB_PANES: f.panesFile, HERDR_DASH_HERDR_PROJECTS: join(f.stubDir, "herdr-projects") });
  const browser = await chromium.launch();
  try {
    const base = `http://127.0.0.1:${port}`;
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      window.__events = 0;
      const ES = window.EventSource;
      window.EventSource = function (u, o) {
        const es = new ES(u, o);
        if (String(u).includes("/api/events")) es.addEventListener("state", () => window.__events++);
        return es;
      };
      window.EventSource.prototype = ES.prototype;
      window.__setHidden = (h) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        document.dispatchEvent(new Event("visibilitychange"));
      };
    });
    await page.goto(base);
    await page.waitForSelector('#graph g.node[data-key="alpha/t-0001"]');

    // 6. Wait until the layout settles, then re-render: nothing moves.
    const positions = () => page.$$eval("#graph g.node", (gs) => gs.map((g) => g.getAttribute("transform")).join("|"));
    let prev = "";
    await waitFor(async () => { const p = await positions(); const same = p === prev; prev = p; return same; }, 20_000);
    await sleep(300);
    const settled = await positions();
    await page.evaluate(() => window.dash.render());
    await sleep(1_000);
    assert.equal(await positions(), settled, "a re-render with no change moved the settled graph");

    // 5. Hidden: the stream closes and the page says so.
    await page.evaluate(() => window.__setHidden(true));
    await waitFor(() => page.$eval("#live", (e) => e.classList.contains("paused")), 3_000);
    const before = await page.evaluate(() => window.__events);
    // A change while hidden: a new title for alpha/t-0001.
    const tl = join(f.stubDir, "thread-list-alpha.json");
    const rows = JSON.parse(readFileSync(tl, "utf8"));
    rows.find((r) => r.id === "t-0001").title = "Renamed while hidden";
    writeFileSync(tl, JSON.stringify(rows));
    writeFileSync(join(f.root, "alpha/threads/t-0001.md"), "changed\n");
    await sleep(5_000);
    assert.equal(await page.evaluate(() => window.__events), before, "a hidden tab still received snapshots");

    // Shown again: reconnects and shows the change at once.
    await page.evaluate(() => window.__setHidden(false));
    await waitFor(() => page.$eval("#live", (e) => e.classList.contains("on")), 5_000);
    await waitFor(() => page.evaluate(() => window.dash.state().threads.find((t) => t.key === "alpha/t-0001")?.title === "Renamed while hidden"), 5_000);
    // A changed title reaches the graph's label without a reheat being needed.
    await waitFor(() => page.$eval('#graph text.label[data-key="alpha/t-0001"]', (e) => e.textContent.startsWith("Renamed while")), 3_000);
    await page.screenshot({ path: join(artifacts, "perf-shown-again.png") });
  } finally {
    await browser.close();
    server.kill();
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "perf.json"), JSON.stringify(out, null, 2) + "\n");
    rmSync(f.tmp, { recursive: true, force: true });
  }
});
