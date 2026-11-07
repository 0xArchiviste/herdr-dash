// E2E: the live stream is incremental. Measured on a live install first
// (see the PR): ~4 full snapshots a minute of ~1.27 MB each (975+ threads,
// ~80% of them resolved), nearly every one re-sent for a single thread's
// last_activity.
//
// Ways this could fail, written before the change:
//  1. The stream still sends the whole state on every change, or a delta
//     carries threads and projects that did not change.
//  2. A delta's version does not follow the one before it (base), so a
//     client cannot tell it missed one; or a client that missed one keeps
//     applying deltas to stale state instead of resyncing.
//  3. Something is sent while nothing changed.
//  4. Resolved threads still ride the live snapshot; or, left out, they
//     are lost for the views that need them (Resolved filter, "Any time",
//     search, the Threads tab's Done group, a resolved thread's panel).
//  5. A thread that becomes resolved, is added or is removed is not
//     reflected (the graph, the Needs-you strip and the counts keep it).
//  6. The project order changes and hub colours / the picker do not follow.
//  7. Applying a delta rebuilds the Needs-you strip and the graph from
//     scratch, or reheats a settled graph for a non-structural change.
//  8. /api/state (the API the Go side and tests use) loses resolved threads.
//
// Artifact: e2e/artifacts/stream.json (bytes and events per phase) and
// stream-*.png.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
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

// Rewrite a project's thread list (and touch a thread file so the collector
// re-lists it on its next thread tick).
function editThreads(f, slug, fn) {
  const p = join(f.stubDir, `thread-list-${slug}.json`);
  const rows = JSON.parse(readFileSync(p, "utf8"));
  const next = fn(rows) || rows;
  writeFileSync(p, JSON.stringify(next));
  writeFileSync(join(f.root, slug, "threads", "t-0001.md"), "changed " + Date.now() + "\n");
}

function start(f) {
  return freePort().then((port) => ({
    port,
    base: `http://127.0.0.1:${port}`,
    server: startServer(port, f.log, ["--root", f.root], { STUB_PANES: f.panesFile, HERDR_DASH_HERDR_PROJECTS: join(f.stubDir, "herdr-projects") }),
  }));
}

// A raw SSE reader: every event with its name, size and parsed data.
function sse(url, headers = {}) {
  const ctl = new AbortController();
  const events = [];
  let bytes = 0;
  const done = (async () => {
    const r = await fetch(url, { headers, signal: ctl.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      bytes += s.length;
      buf += s;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const blk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(blk)?.[1];
        const data = /^data: (.*)$/m.exec(blk)?.[1];
        if (ev) events.push({ ev, size: data.length, data: JSON.parse(data), at: Date.now() });
      }
    }
  })().catch(() => {});
  return { events, bytes: () => bytes, close: () => { ctl.abort(); return done; }, of: (name) => events.filter((e) => e.ev === name) };
}

test("stream: live snapshot on connect, then small versioned deltas", async () => {
  const f = fixture("dash-stream-");
  const { base, server } = await start(f);
  let s;
  try {
    await waitFor(async () => (await (await fetch(base + "/api/state")).json()).threads.length > 0);
    // 8. /api/state keeps every thread, resolved ones included, and a version.
    const full = await (await fetch(base + "/api/state")).json();
    assert.ok(full.threads.some((t) => t.key === "alpha/t-0004" && t.state === "resolved"), "/api/state lost the resolved thread");
    assert.equal(typeof full.version, "number");

    s = sse(base + "/api/events");
    await waitFor(() => s.of("state").length === 1);
    const snap = s.of("state")[0].data;
    // 4. Resolved threads stay out of the live snapshot; counts keep them.
    assert.ok(!snap.threads.some((t) => t.state === "resolved"), "a resolved thread rode the live snapshot");
    assert.equal(snap.threads.length, full.threads.filter((t) => t.state !== "resolved").length);
    assert.equal(snap.projects.find((p) => p.slug === "alpha").resolved, 1);
    assert.equal(typeof snap.version, "number");
    out.snapshotBytes = s.of("state")[0].size;
    out.fullStateBytes = JSON.stringify(full).length;

    // 1/2. One thread renamed: one delta, carrying that thread only.
    editThreads(f, "alpha", (rows) => { rows.find((r) => r.id === "t-0005").title = "Renamed by a delta"; });
    await waitFor(() => s.of("delta").length >= 1, 10_000);
    const d1 = s.of("delta")[0].data;
    assert.equal(d1.base, snap.version, "first delta does not follow the snapshot");
    assert.equal(d1.version, snap.version + 1);
    assert.deepEqual((d1.threads || []).map((t) => t.key), ["alpha/t-0005"]);
    assert.equal(d1.threads[0].title, "Renamed by a delta");
    assert.ok(!d1.projects?.length || d1.projects.every((p) => p.slug === "alpha"), "a delta carried an unchanged project");
    assert.equal(s.of("state").length, 1, "a full snapshot was sent again");
    out.renameDeltaBytes = s.of("delta")[0].size;
    assert.ok(out.renameDeltaBytes < 4000, `delta of ${out.renameDeltaBytes} bytes for one renamed thread`);

    // 5. A thread added, one removed, one resolved: in order, keyed.
    let n = s.of("delta").length;
    editThreads(f, "alpha", (rows) => {
      const add = { ...rows.find((r) => r.id === "t-0005"), id: "t-0099", title: "Brand new", pane_id: "" };
      Object.assign(rows.find((r) => r.id === "t-0003"), { status: "resolved", group: "Resolved", group_token: "resolved" });
      return rows.filter((r) => r.id !== "t-0006").concat(add);
    });
    const ds = () => s.of("delta").slice(n).map((e) => e.data);
    const seenThreads = () => ds().flatMap((d) => d.threads || []);
    const removed = () => ds().flatMap((d) => d.threads_removed || []);
    await waitFor(() => seenThreads().some((t) => t.key === "alpha/t-0003" && t.state === "resolved"), 10_000).catch(() => {});
    assert.ok(seenThreads().some((t) => t.key === "alpha/t-0099"), "added thread missing");
    assert.ok(seenThreads().some((t) => t.key === "alpha/t-0003" && t.state === "resolved"), "resolved transition missing: " + JSON.stringify(seenThreads().map((t) => [t.key, t.state])));
    assert.deepEqual(removed(), ["alpha/t-0006"]);
    for (let i = 0; i < s.of("delta").length; i++) {
      const d = s.of("delta")[i].data;
      assert.equal(d.base, i ? s.of("delta")[i - 1].data.version : snap.version, "version chain broken");
    }

    // On-demand resolved: everything, or one project's.
    const res = await (await fetch(base + "/api/threads?state=resolved")).json();
    assert.deepEqual(res.threads.map((t) => t.key).sort(), ["alpha/t-0003", "alpha/t-0004"]);
    assert.ok(res.version >= s.of("delta").at(-1).data.version);
    const resBeta = await (await fetch(base + "/api/threads?state=resolved&project=beta")).json();
    assert.deepEqual(resBeta.threads, []);
    assert.equal((await fetch(base + "/api/threads?state=open")).status, 400);
    assert.equal((await fetch(base + "/api/threads?state=resolved&project=../x")).status, 400);

    // A fresh connection gets a fresh snapshot at the current version.
    const s2 = sse(base + "/api/events", { "Accept-Encoding": "gzip" });
    await waitFor(() => s2.of("state").length === 1);
    assert.equal(s2.of("state")[0].data.version, s.of("delta").at(-1).data.version);
    assert.ok(!s2.of("state")[0].data.threads.some((t) => t.key === "alpha/t-0003"));
    await s2.close();
  } finally {
    await s?.close();
    server.kill();
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("stream: nothing is sent while nothing changes", async () => {
  const f = fixture("dash-stream-idle-");
  const { base, server } = await start(f);
  let s;
  try {
    await waitFor(async () => (await (await fetch(base + "/api/state")).json()).threads.length > 0);
    await sleep(3_000); // the first PR check and timelines settle
    s = sse(base + "/api/events");
    await waitFor(() => s.of("state").length === 1);
    const at = s.bytes();
    // --poll 1s: eight pane ticks and two thread ticks, nothing changed.
    await sleep(8_000);
    out.idle = { deltas: s.of("delta").length, states: s.of("state").length - 1, bytesAfterSnapshot: s.bytes() - at, systemEvents: s.of("system").length };
    assert.equal(s.of("delta").length, 0, "deltas while idle: " + JSON.stringify(s.of("delta").map((e) => e.data)));
    assert.equal(s.of("state").length, 1);
  } finally {
    await s?.close();
    server.kill();
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

// Page helpers: count stream connections and resolved fetches.
async function openPage(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const hits = { events: 0, resolved: [] };
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/events")) hits.events++;
    if (u.includes("/api/threads?")) hits.resolved.push(u.slice(u.indexOf("/api/threads")));
  });
  await page.addInitScript(() => localStorage.clear());
  await page.goto(base);
  await page.waitForSelector('#graph g.node[data-key="alpha/t-0001"]');
  return { page, hits };
}
const nodeKeys = (page) => page.$$eval("#graph g.node:not(.leaving)", (gs) => gs.map((g) => g.dataset.key).sort());

test("page: resolved threads load on demand; every view follows deltas", async () => {
  const f = fixture("dash-stream-ui-");
  const { base, server } = await start(f);
  const browser = await chromium.launch();
  try {
    await waitFor(async () => (await (await fetch(base + "/api/state")).json()).threads.length > 0);
    const { page, hits } = await openPage(browser, base);

    // Default: open threads only on the graph; no resolved fetch yet; the
    // legend still counts the resolved one (from the project counts).
    assert.ok(!(await nodeKeys(page)).includes("alpha/t-0004"), "resolved node drawn by default");
    assert.deepEqual(hits.resolved, []);
    assert.match(await page.locator("#legend").innerText(), /Resolved\s*1/);

    // Resolved filter: fetched once, then drawn.
    await page.selectOption("#f-state", "resolved");
    await page.waitForSelector('#graph g.node[data-key="alpha/t-0004"]');
    assert.deepEqual(hits.resolved, ["/api/threads?state=resolved"]);
    await page.screenshot({ path: join(artifacts, "stream-resolved-filter.png") });
    await page.selectOption("#f-state", "");
    await waitFor(async () => !(await nodeKeys(page)).includes("alpha/t-0004"));

    // "Any time" shows them too (no second fetch); the default hides again.
    await page.selectOption("#f-window", "all");
    await page.waitForSelector('#graph g.node[data-key="alpha/t-0004"]');
    await page.selectOption("#f-window", "");
    await waitFor(async () => !(await nodeKeys(page)).includes("alpha/t-0004"));
    // Title search finds a resolved thread.
    await page.fill("#f-search", "Old cleanup");
    await page.waitForSelector('#graph g.node[data-key="alpha/t-0004"]');
    await page.fill("#f-search", "");
    assert.equal(hits.resolved.length, 1, "resolved threads fetched again: " + hits.resolved.join(", "));
    await page.close();

    // A fresh page: the Threads tab's Done group loads that project's resolved threads.
    const p2 = await openPage(browser, base);
    await p2.page.evaluate(() => window.hd.select("hub:alpha"));
    await p2.page.waitForSelector('#p-tv .tv-card[data-stage="done"]', { state: "attached" });
    assert.deepEqual(p2.hits.resolved, ["/api/threads?state=resolved&project=alpha"]);
    // A resolved thread's own panel, opened directly, has its title.
    await p2.page.evaluate(() => window.hd.select("alpha/t-0004"));
    await waitFor(() => p2.page.locator("#panel h2.title").innerText().then((t) => t === "Old cleanup"), 5_000);
    await p2.page.close();

    // Deltas reach every view. A fresh page, then: a thread starts waiting
    // (Needs-you strip, legend, graph colour), one resolves (gone from the
    // graph, strip and System strip), one is added (graph), and the project
    // order flips (hub colours, picker).
    const p3 = await openPage(browser, base);
    const page3 = p3.page;
    await page3.waitForSelector('#needs .chip[data-key="alpha/t-0003"]');
    editThreads(f, "alpha", (rows) => {
      const t5 = rows.find((r) => r.id === "t-0005");
      Object.assign(t5, { group: "Waiting on you", group_token: "waiting-on-you", title: "Now waiting" });
      Object.assign(rows.find((r) => r.id === "t-0003"), { status: "resolved", group: "Resolved", group_token: "resolved" });
      rows.push({ ...rows.find((r) => r.id === "t-0001"), id: "t-0042", title: "Added live", pane_id: "" });
    });
    await page3.waitForSelector('#needs .chip[data-key="alpha/t-0005"]', { timeout: 10_000 });
    await page3.waitForSelector('#graph g.node[data-key="alpha/t-0042"]');
    await waitFor(async () => !(await nodeKeys(page3)).includes("alpha/t-0003"));
    assert.equal(await page3.locator('#needs .chip[data-key="alpha/t-0003"]').count(), 0);
    assert.match(await page3.locator("#legend").innerText(), /Resolved\s*2/);
    assert.equal(await page3.evaluate(() => window.hd.state().threads.find((t) => t.key === "alpha/t-0005").title), "Now waiting");
    // The Threads tab, Master window and System strip read the same state.
    await page3.evaluate(() => window.hd.select("hub:alpha"));
    await page3.waitForSelector('#p-tv .tv-card[data-stage="done"]', { state: "attached" });
    await waitFor(() => page3.locator('#p-tv .tv-card[data-stage="done"]').count().then((n) => n === 2), 5_000);
    await page3.screenshot({ path: join(artifacts, "stream-after-deltas.png") });
    await page3.close();
  } finally {
    await browser.close();
    server.kill();
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("page: a version gap resyncs; deltas patch in place without reheating", async () => {
  const f = fixture("dash-stream-gap-");
  const { base, server } = await start(f);
  const browser = await chromium.launch();
  try {
    await waitFor(async () => (await (await fetch(base + "/api/state")).json()).threads.length > 0);
    const { page, hits } = await openPage(browser, base);
    await page.waitForSelector('#needs .chip[data-key="alpha/t-0003"]');

    // 7. Let the graph settle, mark DOM nodes, then a non-structural delta.
    const positions = () => page.$$eval("#graph g.node", (gs) => gs.map((g) => g.getAttribute("transform")).join("|"));
    let prev = "";
    await waitFor(async () => { const p = await positions(); const same = p === prev; prev = p; return same; }, 20_000);
    await sleep(300);
    const settled = await positions();
    await page.evaluate(() => {
      document.querySelector('#needs .chip[data-key="alpha/t-0003"]').__mark = 1;
      document.querySelector('#graph g.node[data-key="alpha/t-0001"]').__mark = 1;
      window.__renders = 0;
      const r = window.dash.render;
      window.dash.render = () => { window.__renders++; r(); };
    });
    const v0 = await page.evaluate(() => window.hd.version());
    editThreads(f, "alpha", (rows) => { rows.find((r) => r.id === "t-0001").activity = "Compiling the widget"; });
    await waitFor(() => page.evaluate((v) => window.hd.version() > v, v0), 10_000);
    await waitFor(() => page.evaluate(() => window.hd.state().threads.find((t) => t.key === "alpha/t-0001").activity === "Compiling the widget"));
    await sleep(800);
    assert.equal(await positions(), settled, "an activity change reheated the settled graph");
    assert.equal(await page.evaluate(() => document.querySelector('#needs .chip[data-key="alpha/t-0003"]').__mark), 1, "the Needs-you strip was rebuilt for an unrelated change");
    assert.equal(await page.evaluate(() => document.querySelector('#graph g.node[data-key="alpha/t-0001"]').__mark), 1, "the changed node was recreated");

    // 2. A delta whose base is not the page's version: the page reconnects
    // and gets a fresh snapshot, instead of patching stale state.
    const before = hits.events;
    const v1 = await page.evaluate(() => window.hd.version());
    await page.evaluate((v) => window.hd.streamEvent("delta", { base: v + 5, version: v + 6, threads: [{ key: "alpha/t-0001", project: "alpha", id: "t-0001", title: "BOGUS", state: "working" }] }), v1);
    await waitFor(() => hits.events > before, 5_000);
    await waitFor(() => page.evaluate(() => window.hd.state().threads.find((t) => t.key === "alpha/t-0001").title !== "BOGUS"));
    assert.equal(await page.evaluate(() => window.hd.version()), v1, "resynced to the server's version");
    assert.notEqual(await page.evaluate(() => window.hd.state().threads.find((t) => t.key === "alpha/t-0001").title), "BOGUS");
    // An old delta (already applied) is ignored, not a gap.
    const evs = hits.events;
    await page.evaluate((v) => window.hd.streamEvent("delta", { base: v - 1, version: v, threads: [] }), v1);
    await sleep(500);
    assert.equal(hits.events, evs);
    await page.screenshot({ path: join(artifacts, "stream-resynced.png") });
  } finally {
    await browser.close();
    server.kill();
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "stream.json"), JSON.stringify(out, null, 2) + "\n");
    rmSync(f.tmp, { recursive: true, force: true });
  }
});
