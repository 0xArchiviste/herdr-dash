// E2E for the System strip: machine CPU/RAM/swap/load, per-agent CPU and
// RSS mapped to projects and threads, active agents per project against
// max_parallel_threads, and the herdr-projects launch queue. Runs the real
// binary against a fake /proc tree (--proc) written to a temp dir, so every
// number is known; the stubs and root are copies with extra queued threads.
//
// Ways this could fail, written before the feature existed:
//  S1. /proc is read while no tab is open (no stream subscriber), or on a
//      timer of its own instead of the collector's pane tick.
//  S2. A sample identical to the last one is sent again (only changes go out).
//  S3. Machine CPU is not a delta between two samples (a since-boot average),
//      per-core values are missing, or RAM "used" ignores MemAvailable.
//  S4. Agent processes are mis-attributed: a pane's children not summed into
//      its thread, a coordinator pane shown as unknown, another Dash
//      instance's helpers counted as this Dash, or processes without a pane
//      (or with an unreadable environ) listed at all.
//  S5. The Dash service and the voice sidecar have no rows of their own.
//  S6. Rows are not heaviest first; a process that exits keeps its row.
//  S7. Warning/critical colours do not follow 80% / 95%.
//  S8. On WSL the numbers are not labelled as the WSL VM's.
//  S9. Active agents miscounted (working / idle / waiting on you), per project
//      counts lack max_parallel_threads, or a project over its limit is not
//      flagged.
// S10. Queue: a thread accepted but not launched (starting, waiting for the
//      ticker, launch retries, failed) is missing, out of order, or lacks
//      position, project, profile, wait time; a launched thread stays listed.
// S11. Clicking a process or queue row does not open that thread.
// S12. Without /proc (macOS, Windows, --proc off) the page breaks instead of
//      saying the system view is unavailable.
// S13. The strip overflows the header on a phone.
//
// Artifacts: e2e/artifacts/system-*.png and system.json.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { td, stub, artifacts, startServer, freePort, waitFor } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GiB = 1024 ** 3, PAGE = 4096;
const out = {};

// A fake /proc: counters advance with real time at the configured rates, so
// the server's deltas see the CPU share each core or process is set to.
class FakeProc {
  constructor(dir) {
    this.dir = dir;
    this.cores = [0.97, 0.5, 0.1, 0.02]; // busy share per core
    this.cpu = this.cores.map(() => ({ user: 1000, system: 500, idle: 100000 }));
    this.mem = { total: 16 * GiB, avail: 3 * GiB }; // 81% used: warning
    this.swap = { total: 4 * GiB, free: 4 * GiB - 0.2 * GiB };
    this.load = "3.10 2.05 1.50 4/321 9999";
    this.osrelease = "6.6.0-microsoft-standard-WSL2";
    this.procs = new Map();
    this.last = Date.now();
    this.frozen = false;
    mkdirSync(join(dir, "sys/kernel"), { recursive: true });
  }
  add(pid, comm, { ppid = 1, cpu = 0, rss = 0, env = null, unreadable = false } = {}) {
    this.procs.set(pid, { comm, ppid, share: cpu, ticks: 5000, rss, env, unreadable });
  }
  remove(pid) {
    this.procs.delete(pid);
    rmSync(join(this.dir, String(pid)), { recursive: true, force: true });
  }
  advance() {
    const now = Date.now();
    const t = this.frozen ? 0 : ((now - this.last) / 1000) * 100; // USER_HZ
    this.last = now;
    this.cpu.forEach((c, i) => { c.user += this.cores[i] * t; c.idle += (1 - this.cores[i]) * t; });
    for (const p of this.procs.values()) p.ticks += p.share * t;
    this.write();
  }
  write() {
    const line = (n, c) => `${n} ${Math.round(c.user)} 0 ${Math.round(c.system)} ${Math.round(c.idle)} 0 0 0 0 0 0`;
    const tot = this.cpu.reduce((a, c) => ({ user: a.user + c.user, system: a.system + c.system, idle: a.idle + c.idle }), { user: 0, system: 0, idle: 0 });
    this.put("stat", [line("cpu ", tot), ...this.cpu.map((c, i) => line(`cpu${i}`, c)), "intr 0", "ctxt 0", "btime 0", ""].join("\n"));
    const kb = (b) => Math.round(b / 1024);
    this.put("meminfo", `MemTotal: ${kb(this.mem.total)} kB\nMemFree: 1000 kB\nMemAvailable: ${kb(this.mem.avail)} kB\nBuffers: 0 kB\nSwapTotal: ${kb(this.swap.total)} kB\nSwapFree: ${kb(this.swap.free)} kB\n`);
    this.put("loadavg", this.load + "\n");
    this.put("sys/kernel/osrelease", this.osrelease + "\n");
    for (const [pid, p] of this.procs) {
      const d = join(this.dir, String(pid));
      mkdirSync(d, { recursive: true });
      // Fields after comm: state ppid pgrp session tty tpgid flags minflt
      // cminflt majflt cmajflt utime stime cutime cstime prio nice threads
      // itreal starttime vsize rss ...
      const u = Math.round(p.ticks * 0.8), s = Math.round(p.ticks * 0.2);
      this.put(`${pid}/stat`, `${pid} (${p.comm}) S ${p.ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 ${u} ${s} 0 0 20 0 1 0 ${1000 + pid} 1000000 ${Math.round(p.rss / PAGE)} 0 0 0\n`);
      const envPath = join(d, "environ");
      if (p.unreadable) { try { chmodSync(envPath, 0o600); } catch {} }
      if (p.env) this.put(`${pid}/environ`, Object.entries({ PATH: "/usr/bin", ...p.env }).map(([k, v]) => `${k}=${v}\0`).join(""));
      else this.put(`${pid}/environ`, "PATH=/usr/bin\0");
      if (p.unreadable) chmodSync(envPath, 0o000);
    }
  }
  put(rel, text) {
    const p = join(this.dir, rel);
    writeFileSync(p + ".tmp", text);
    renameSync(p + ".tmp", p); // whole files, as /proc reads are
  }
}

const iso = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");
// Threads herdr-projects accepted but has not launched yet, in beta's list.
function queued() {
  const base = { group: "Working", group_token: "working", last_state: "", tab_id: "", workspace_id: "", agent: "claude", pr: "", pr_state: "",
    branch: "", origin: "", activity: "", percent: 0, kind: "worktree", updated: iso(5), last_report_change: "", next: [], note: "", state_line: "",
    machine: "", resolved_reason: "", report_hash: "", acked_report_hash: "", repo: "/fixture/repos/beta", cwd: "", prompt_pending: false,
    launch_attempts: 0, launched_at: "", brief_attempts: 0, brief_stuck: false, error: "" };
  return [
    { ...base, id: "t-0010", title: "Placing worktree", status: "starting", pane_id: "", created: iso(240), last_state_change: "", profile: "claude" },
    { ...base, id: "t-0011", title: "Waiting for the ticker", status: "open", pane_id: "w2C:p1", created: iso(200), last_state_change: iso(120), profile: "codex-high", agent: "codex", prompt_pending: true },
    { ...base, id: "t-0012", title: "Launch retrying", status: "open", pane_id: "w2D:p1", created: iso(90), last_state_change: iso(80), profile: "claude", prompt_pending: true, launch_attempts: 2, launched_at: iso(20) },
    { ...base, id: "t-0013", title: "Could not start", status: "failed", pane_id: "", created: iso(900), last_state_change: iso(800), profile: "opencode", agent: "opencode", group: "Idle", group_token: "idle", error: "worktree create failed: branch exists" },
  ];
}

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "dash-sys-"));
  const root = join(tmp, "root"), stubDir = join(tmp, "stub"), log = join(tmp, "calls"), proc = join(tmp, "proc");
  cpSync(join(td, "root"), root, { recursive: true });
  cpSync(stub, stubDir, { recursive: true });
  const beta = JSON.parse(readFileSync(join(stubDir, "thread-list-beta.json"), "utf8"));
  writeFileSync(join(stubDir, "thread-list-beta.json"), JSON.stringify([...beta, ...queued()]));
  writeFileSync(log, "");
  mkdirSync(proc);
  return { tmp, root, stubDir, log, proc };
}

function start(f, port, proc) {
  return startServer(port, f.log, ["--root", f.root, "--herdr", join(f.stubDir, "herdr"), "--proc", proc],
    { HERDR_DASH_HERDR_PROJECTS: join(f.stubDir, "herdr-projects") });
}

// Reads `event: system` frames off the event stream until stopped.
function systemFrames(url) {
  const frames = [], ac = new AbortController();
  (async () => {
    try {
      const r = await fetch(url + "/api/events", { signal: ac.signal });
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          if (ev.startsWith("event: system\n")) frames.push(JSON.parse(ev.slice(ev.indexOf("data: ") + 6)));
        }
      }
    } catch {}
  })();
  return { frames, stop: () => ac.abort() };
}
const stats = async (url) => (await fetch(url + "/api/system/stats")).json();

let browser, f, fp, server, url, ticker;
before(async () => {
  mkdirSync(artifacts, { recursive: true });
  f = fixture();
  fp = new FakeProc(f.proc);
  fp.write();
  const port = await freePort();
  server = start(f, port, f.proc);
  url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.some((t) => t.key === "beta/t-0011"));
  const me = server.pid;
  // alpha/t-0001 (pane w1A:p1): an agent and its MCP child, 120% + 30%.
  fp.add(101, "claude", { cpu: 1.2, rss: 900e6, env: { HERDR_PANE_ID: "w1A:p1" } });
  fp.add(102, "node", { ppid: 101, cpu: 0.3, rss: 200e6, env: { HERDR_PANE_ID: "w1A:p1" } });
  // alpha/t-0003 (w1C:p1): codex, light.
  fp.add(201, "codex", { cpu: 0.05, rss: 150e6, env: { HERDR_PANE_ID: "w1C:p1" } });
  // alpha's coordinator pane.
  fp.add(301, "claude", { cpu: 0.85, rss: 400e6, env: { HERDR_PANE_ID: "w1Z:p1" } });
  // This Dash (its own pid, then a child marked as Dash) and its voice sidecar.
  fp.add(me, "herdr-dash", { cpu: 0.01, rss: 40e6 });
  fp.add(401, "herdr", { ppid: me, cpu: 0.01, rss: 10e6, env: { HERDR_DASH_ROLE: `dash:${me}` } });
  fp.add(402, "python3", { ppid: me, cpu: 0.4, rss: 900e6, env: { HERDR_DASH_ROLE: `voice:${me}` } });
  // Another Dash run from a pane: its helper belongs to that pane, not to us.
  fp.add(403, "herdr", { cpu: 0.02, rss: 12e6, env: { HERDR_DASH_ROLE: "dash:99999", HERDR_PANE_ID: "w3Y:p1" } });
  // Not in any pane, and one whose environ cannot be read: never listed.
  fp.add(500, "sshd", { cpu: 0.6, rss: 30e6 });
  fp.add(600, "secret", { cpu: 0.6, rss: 30e6, env: { HERDR_PANE_ID: "w1A:p1" }, unreadable: true });
  fp.write();
  ticker = setInterval(() => fp.advance(), 50);
  browser = await chromium.launch();
});

after(async () => {
  clearInterval(ticker);
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "system.json"), JSON.stringify(out, null, 2) + "\n");
  rmSync(f.tmp, { recursive: true, force: true });
});

test("no viewer, no /proc reads; a stream samples on the pane tick and sends only changes", async () => {
  const s0 = await stats(url);
  await sleep(3000); // three pane ticks with nobody watching
  const s1 = await stats(url);
  out.samplesWithoutViewer = s1.samples - s0.samples;
  assert.equal(s1.samples, s0.samples, "sampled /proc with no viewer (S1)");

  const st = systemFrames(url);
  await waitFor(() => st.frames.some((fr) => fr.cpu && fr.procs.some((p) => p.cpu != null)), 8000);
  const a = await stats(url);
  await sleep(3200);
  const b = await stats(url);
  out.samplesPer3sWithViewer = b.samples - a.samples;
  assert.ok(b.samples - a.samples >= 2 && b.samples - a.samples <= 5, `~1 sample per 1s pane tick, got ${b.samples - a.samples}`);

  // Freeze every counter: after one frame showing 0% no more are sent (S2).
  fp.frozen = true;
  await sleep(2500);
  const n = st.frames.length, sa = (await stats(url)).samples;
  await sleep(3000);
  out.framesWhileFrozen = st.frames.length - n;
  out.samplesWhileFrozen = (await stats(url)).samples - sa;
  assert.equal(st.frames.length, n, "an unchanged sample was sent again (S2)");
  assert.ok(out.samplesWhileFrozen >= 2);
  fp.frozen = false;
  await waitFor(() => st.frames.length > n, 4000);
  st.stop();
  await sleep(1500);
  const c = await stats(url);
  await sleep(2500);
  assert.equal((await stats(url)).samples, c.samples, "kept sampling after the last viewer left (S1)");
});

test("machine, agents, queue: numbers, attribution, order, colours, clicks", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  const strip = page.locator("#sys");
  await waitFor(async () => /\d%/.test(await strip.locator('[data-id="cpu"]').innerText()), 10_000);

  // S3/S7: core shares 97/50/10/2 → total ~40%; RAM 13 of 16 GiB = 81% → warn.
  const fr = await waitFor(async () => {
    const j = await (await fetch(url + "/api/system")).json();
    return j.cpu && j.procs.find((p) => p.key === "alpha/t-0001")?.cpu != null ? j : null;
  });
  out.frame = { cpu: fr.cpu, mem: fr.mem, swap: fr.swap, load: fr.load, wsl: fr.wsl };
  assert.ok(Math.abs(fr.cpu.pct - 40) <= 4, `total CPU ${fr.cpu.pct}`);
  assert.equal(fr.cpu.cores.length, 4);
  assert.ok(Math.abs(fr.cpu.cores[0] - 97) <= 3 && Math.abs(fr.cpu.cores[3] - 2) <= 3, `cores ${fr.cpu.cores}`);
  assert.equal(fr.mem.total, 16 * GiB);
  assert.equal(fr.mem.used, 13 * GiB);
  assert.ok(Math.abs(fr.swap.used - 0.2 * GiB) < 1024 * 1024);
  assert.deepEqual(fr.load, [3.1, 2.05, 1.5]);
  assert.equal(fr.wsl, true);
  assert.equal(await strip.locator('[data-id="mem"]').getAttribute("data-level"), "warn");
  assert.equal(await strip.locator('[data-id="cpu"]').getAttribute("data-level"), "ok");
  assert.match(await strip.locator('[data-id="cpu"]').innerText(), /4\d%|3\d%/);

  // S4/S5/S6: rows and attribution.
  const rows = fr.procs;
  const by = (k) => rows.find((p) => p.key === k);
  const t1 = by("alpha/t-0001");
  assert.ok(t1 && t1.kind === "thread" && t1.project === "alpha" && t1.thread === "t-0001", "t-0001 row");
  assert.equal(t1.n, 2, "agent and child summed (unreadable environ excluded)");
  assert.ok(Math.abs(t1.cpu - 150) <= 20, `t-0001 CPU ${t1.cpu}`);
  assert.equal(t1.rss, Math.round(900e6 / PAGE) * PAGE + Math.round(200e6 / PAGE) * PAGE);
  assert.equal(by("hub:alpha")?.kind, "coordinator");
  assert.equal(by("alpha/t-0003")?.agent, "codex");
  assert.equal(by("dash")?.n, 2, "Dash itself and its helper");
  assert.equal(by("voice")?.kind, "voice");
  assert.equal(by("pane:w3Y:p1")?.n, 1, "another Dash's helper stays with its pane");
  assert.ok(!rows.some((p) => p.n > 0 && /sshd|secret/.test(p.top || "")), "processes without a pane are not listed");
  const cpus = rows.map((p) => p.cpu ?? 0);
  assert.deepEqual(cpus, [...cpus].sort((a, b) => b - a), "heaviest first");
  assert.equal(rows[0].key, "alpha/t-0001");

  // S9: alpha has 6 open threads with max_parallel_threads = 4.
  await strip.locator('[data-id="agents"]').click();
  const pop = page.locator("#sys-pop");
  await pop.waitFor({ state: "visible" });
  const alphaLimit = pop.locator('.sproj[data-slug="alpha"] .slimit');
  assert.equal((await alphaLimit.innerText()).trim(), "6/4");
  assert.equal(await alphaLimit.getAttribute("data-level"), "crit");
  assert.equal((await pop.locator('.sproj[data-slug="beta"] .slimit').innerText()).trim(), "6/10");
  const tot = await pop.locator(".sagent-tot").innerText();
  out.agentsTotal = tot;
  assert.match(tot, /1 working/);
  assert.match(tot, /waiting on you/);
  assert.equal(await strip.locator('[data-id="agents"]').getAttribute("data-level"), "crit");

  // S8: WSL label in the machine section, per-core sparklines.
  assert.match(await pop.locator(".swsl").innerText(), /WSL/);
  await waitFor(async () => (await pop.locator(".score polyline").count()) === 4);

  // S10: queue order and fields.
  const q = pop.locator(".squeue");
  const keys = await q.evaluateAll((els) => els.map((e) => e.dataset.key));
  out.queue = keys;
  assert.deepEqual(keys, ["beta/t-0010", "beta/t-0011", "beta/t-0012", "beta/t-0013"]);
  const r11 = pop.locator('.squeue[data-key="beta/t-0011"]');
  assert.equal((await r11.locator(".spos").innerText()).trim(), "2");
  assert.match(await r11.innerText(), /beta/);
  assert.match(await r11.innerText(), /codex-high/);
  assert.match(await r11.locator(".swait").innerText(), /^2m/);
  assert.match(await pop.locator('.squeue[data-key="beta/t-0012"] .sstage').innerText(), /attempt 2 of 3/);
  assert.match(await pop.locator('.squeue[data-key="beta/t-0013"]').innerText(), /failed/i);
  assert.equal(await strip.locator('[data-id="queue"]').innerText().then((s) => /3/.test(s)), true, "3 waiting (the failed one aside)");
  await page.screenshot({ path: join(artifacts, "system-strip.png"), clip: { x: 0, y: 0, width: 1440, height: 120 } });
  await page.screenshot({ path: join(artifacts, "system-details.png") });

  // S11: clicking a process row opens its thread; a queue row too.
  await pop.locator('.sproc[data-key="alpha/t-0001"]').click();
  await waitFor(() => page.evaluate(() => window.hd.selected() === "alpha/t-0001"));
  await strip.locator('[data-id="queue"]').click();
  await pop.locator('.squeue[data-key="beta/t-0012"]').click();
  await waitFor(() => page.evaluate(() => window.hd.selected() === "beta/t-0012"));

  // S7: CPU 97% on every core → critical; a process exits → its row goes (S6).
  fp.cores = [0.97, 0.97, 0.97, 0.97];
  fp.remove(201);
  await waitFor(async () => (await strip.locator('[data-id="cpu"]').getAttribute("data-level")) === "crit", 8000);
  await waitFor(async () => !(await (await fetch(url + "/api/system")).json()).procs.some((p) => p.key === "alpha/t-0003"), 8000);
  // A queued thread whose agent got its brief leaves the queue (S10).
  const list = JSON.parse(readFileSync(join(f.stubDir, "thread-list-beta.json"), "utf8"));
  Object.assign(list.find((t) => t.id === "t-0011"), { prompt_pending: false, launch_attempts: 1 });
  writeFileSync(join(f.stubDir, "thread-list-beta.json"), JSON.stringify(list));
  writeFileSync(join(f.root, "beta/threads/t-0011.toml"), "touched = true\n");
  await strip.locator('[data-id="queue"]').click();
  await waitFor(() => page.evaluate(() => !document.querySelector('#sys-pop .squeue[data-key="beta/t-0011"]') && !!document.querySelector('#sys-pop .squeue[data-key="beta/t-0012"]')), 10_000);
  assert.equal((await pop.locator('.squeue[data-key="beta/t-0012"] .spos').innerText()).trim(), "2");
  await page.screenshot({ path: join(artifacts, "system-critical.png") });
  fp.cores = [0.97, 0.5, 0.1, 0.02];

  // S13: phone width: no horizontal overflow.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto(url);
  await phone.locator('#sys [data-id="cpu"]').waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page overflows by ${overflow}px`);
  await phone.locator('#sys [data-id="cpu"]').click();
  await phone.locator("#sys-pop").waitFor({ state: "visible" });
  const box = await phone.locator("#sys-pop").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, "popover fits the phone");
  await phone.screenshot({ path: join(artifacts, "system-phone.png") });
  await phone.close();
  await page.close();
});

test("without /proc the strip says unavailable and the page still works", async () => {
  for (const proc of ["off", join(f.tmp, "no-such-proc")]) {
    const port = await freePort();
    const s = start(f, port, proc);
    try {
      const u = `http://127.0.0.1:${port}`;
      await waitFor(async () => (await (await fetch(u + "/api/state")).json()).threads.length > 0);
      const j = await (await fetch(u + "/api/system")).json();
      assert.equal(j.available, false);
      assert.ok(j.reason);
      const page = await browser.newPage();
      await page.goto(u);
      await waitFor(async () => (await page.locator('#sys [data-id="cpu"]').getAttribute("data-level")) === "na");
      // Agents and queue come from the thread list, so they still work (the
      // test before launched beta/t-0011: two wait, the failed one aside).
      await waitFor(async () => /\b2\b/.test(await page.locator('#sys [data-id="queue"]').innerText()));
      assert.ok(await page.locator("#graph g.node").count() > 0);
      await page.close();
    } finally {
      s.kill();
    }
  }
});
