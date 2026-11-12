// E2E: filter the dashboard by agent harness (and model or profile). The
// real binary runs against agent-fixtures.mjs: claude, codex, opencode and
// grok threads and coordinators, one thread whose live agent differs from
// the recorded one, and a fake /proc for CPU and RAM. Artifacts land in
// e2e/artifacts/agents-*.
//
// Ways the Agent filter could fail, written before it existed:
//  A1. Options are a fixed list instead of the harnesses actually seen, lack
//      per-model sub-options, or their counts of active threads and
//      coordinators are wrong (resolved threads counted, coordinators left out).
//  A2. The recorded profile wins over the agent observed in the pane, or a
//      disagreement between them is not marked.
//  A3. Selecting several does not union them; deselecting the last leaves an
//      empty dashboard instead of everything; All/None misbehave.
//  A4. A view ignores it: graph, Needs-you strip, Threads tab, Master window
//      (rows and counts), System strip agents, Memory map, or search.
//  A5. It does not AND with the project focus.
//  A6. The Landscape table's counts, CPU or RAM are wrong, or clicking a row
//      does not apply that filter.
//  A7. The selection is lost on reload, missing from the URL (?agent=a,b), or
//      a bookmarked URL loses to an older stored one.
//  A8. No chips with ×, no keyboard shortcut, or the shortcut is missing from
//      the ? help.
//  A9. On a phone the picker is not a bottom sheet, or the page scrolls sideways.
// A10. It costs new per-tick CLI calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor } from "./helpers.mjs";
import { FakeProc, GiB } from "./fakeproc.mjs";
import { fixture, LANDSCAPE, BY_AGENT, COORDS } from "./agent-fixtures.mjs";

mkdirSync(artifacts, { recursive: true });
const out = { steps: [] };
let f, fp, server, base, browser, ticker;

before(async () => {
  f = fixture();
  fp = new FakeProc(f.proc);
  fp.write();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = startServer(port, f.log, ["--root", f.root, "--herdr", join(f.stubDir, "herdr"), "--session-profiles", f.profiles, "--proc", f.proc],
    { HERDR_DASH_HERDR_PROJECTS: join(f.stubDir, "herdr-projects") });
  await waitFor(async () => {
    const s = await (await fetch(base + "/api/state")).json();
    return s.threads.some((t) => t.key === "beta/t-0204") && s.projects.find((p) => p.slug === "beta")?.coordinator?.agent === "codex";
  });
  // CPU and RAM per pane: claude's opus thread is heavy, the others light.
  fp.add(101, "claude", { cpu: 1.0, rss: 2 * GiB, env: { HERDR_PANE_ID: "wA1:p1" } });
  fp.add(102, "codex", { cpu: 0.2, rss: 0.5 * GiB, env: { HERDR_PANE_ID: "wA2:p1" } });
  fp.add(103, "claude", { cpu: 0.4, rss: 1 * GiB, env: { HERDR_PANE_ID: "wA3:p1" } });
  fp.add(201, "opencode", { cpu: 0.1, rss: 0.25 * GiB, env: { HERDR_PANE_ID: "wB1:p1" } });
  fp.add(202, "opencode", { cpu: 0.3, rss: 0.75 * GiB, env: { HERDR_PANE_ID: "wB2:p1" } });
  fp.add(203, "claude", { cpu: 0.05, rss: 0.5 * GiB, env: { HERDR_PANE_ID: "wB3:p1" } });
  fp.add(204, "grok", { cpu: 0.05, rss: 0.25 * GiB, env: { HERDR_PANE_ID: "wB4:p1" } });
  fp.add(301, "claude", { cpu: 0.5, rss: 1 * GiB, env: { HERDR_PANE_ID: "w1Z:p1" } });
  fp.add(302, "codex", { cpu: 0.1, rss: 0.5 * GiB, env: { HERDR_PANE_ID: "w2Z:p1" } });
  fp.write();
  ticker = setInterval(() => fp.advance(), 50);
  browser = await chromium.launch();
});

after(async () => {
  clearInterval(ticker);
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "agents.json"), JSON.stringify(out, null, 2) + "\n");
  rmSync(f.tmp, { recursive: true, force: true });
});

const ALL = Object.values(BY_AGENT).flat().sort();
const threadsFor = (agents, projects = null) => agents.flatMap((a) => BY_AGENT[a] || []).filter((k) => !projects || projects.includes(k.split("/")[0])).sort();
const graphThreads = (page) => page.locator("svg g.node.thread:not(.leaving):not(.faded)").evaluateAll((ns) => ns.map((n) => n.dataset.key).sort());
const graphHubs = (page) => page.locator("svg g.node.hub:not(.leaving):not(.faded)").evaluateAll((ns) => ns.map((n) => n.dataset.key.slice(4)).sort());
const needKeys = (page) => page.locator("#needs .chip").evaluateAll((cs) => cs.map((c) => c.dataset.key).sort());
const chips = (page) => page.locator("#agent-chips .achip").evaluateAll((cs) => cs.map((c) => c.dataset.key).sort());
const urlAgents = (page) => new URL(page.url()).searchParams.get("agent");
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("hd-agents") || "[]"));
const ticked = (page) => page.locator('#agent-picker .arow[aria-checked="true"]').evaluateAll((rs) => rs.map((r) => r.dataset.key).sort());

async function openPicker(page) {
  if (await page.locator("#agent-picker").isHidden()) await page.click("#f-agent");
  await page.waitForSelector("#agent-picker:not([hidden])");
}
async function closePicker(page) {
  if (await page.locator("#agent-picker").isVisible()) await page.keyboard.press("Escape");
  await page.waitForSelector("#agent-picker", { state: "hidden" });
}

// The selected agents (harness keys) show everywhere they should, live.
async function expectAgents(page, want, step, projects = null) {
  const shown = threadsFor(want.length ? want : Object.keys(BY_AGENT), projects);
  await waitFor(async () => JSON.stringify(await graphThreads(page)) === JSON.stringify(shown), 4000)
    .catch(async () => assert.deepEqual(await graphThreads(page), shown, step + ": graph threads"));
  // Hubs: projects with a matching open thread or coordinator.
  const hubs = new Set(shown.map((k) => k.split("/")[0]));
  for (const a of want.length ? want : []) for (const p of COORDS[a] || []) if (!projects || projects.includes(p)) hubs.add(p);
  if (want.length) assert.deepEqual(await graphHubs(page), [...hubs].sort(), step + ": hubs");
  // Needs you: only matching threads and coordinators.
  for (const k of await needKeys(page)) {
    if (k.startsWith("hub:")) {
      const slug = k.slice(4);
      assert.ok(!want.length || want.some((a) => (COORDS[a] || []).includes(slug)), `${step}: Needs-you shows ${k}`);
    } else assert.ok(shown.includes(k), `${step}: Needs-you shows ${k}`);
  }
  assert.deepEqual(await chips(page), [...want].sort(), step + ": chips");
  assert.equal(urlAgents(page), want.length ? [...want].sort().join(",") : null, step + ": URL");
  assert.deepEqual([...(await stored(page))].sort(), [...want].sort(), step + ": stored");
  out.steps.push({ step, agents: want, graph: await graphThreads(page), needs: await needKeys(page), url: page.url().replace(base, "") });
}

test("options, counts, mismatch, select one then several, deselect, All/None", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await expectAgents(page, [], "start");
  assert.match(await page.textContent("#f-agent"), /All agents/);

  // A8: A opens the picker (not while typing).
  await page.keyboard.press("a");
  await page.waitForSelector("#agent-picker:not([hidden])");

  // A1: the options seen, with sub-options per model and live counts.
  const rows = await page.locator("#agent-picker .arow").evaluateAll((rs) => rs.map((r) => ({ key: r.dataset.key, n: r.querySelector(".ac").textContent.trim() })));
  out.options = rows;
  assert.deepEqual(rows.map((r) => r.key).sort(), Object.keys(LANDSCAPE).sort(), "options are what runs");
  for (const r of rows) {
    const want = LANDSCAPE[r.key];
    assert.equal(r.n, String(want.threads + want.coords), `count of ${r.key}`);
  }
  // A2: observed agent first; the disagreement is marked on claude.
  const mis = page.locator('#agent-picker .arow[data-key="claude"] .amis');
  assert.equal(await mis.count(), 1, "claude row marks the mismatch");
  assert.match(await mis.getAttribute("title"), /recorded codex/i);
  assert.equal(await page.locator('#agent-picker .arow[data-key="codex"] .amis').count(), 0);

  // A3: one, then several, then deselect.
  await page.click('#agent-picker .arow[data-key="codex"]');
  await expectAgents(page, ["codex"], "codex only");
  assert.ok(!(await graphThreads(page)).includes("alpha/t-0103"), "the swapped thread is not codex any more");
  await page.click('#agent-picker .arow[data-key="opencode"]');
  await expectAgents(page, ["codex", "opencode"], "codex + opencode");
  assert.deepEqual(await ticked(page), ["codex", "opencode"]);
  await page.screenshot({ path: join(artifacts, "agents-two.png") });
  await page.click('#agent-picker .arow[data-key="codex"]');
  await expectAgents(page, ["opencode"], "deselect codex");
  await page.click('#agent-picker .arow[data-key="opencode"]');
  await expectAgents(page, [], "deselect last");

  // A sub-option: one model only.
  await page.click('#agent-picker .arow[data-key="opencode:glm53"]');
  await waitFor(async () => JSON.stringify(await graphThreads(page)) === JSON.stringify(["beta/t-0202"]), 4000);
  assert.match(await page.textContent("#f-agent"), /opencode · glm53/);
  await page.click('#agent-picker .arow[data-key="opencode:glm53"]');

  // Claude includes the swapped thread (observed claude).
  await page.click('#agent-picker .arow[data-key="claude"]');
  await expectAgents(page, ["claude"], "claude");
  assert.ok((await graphThreads(page)).includes("alpha/t-0103"));

  // All / None.
  await page.click("#ap-all");
  assert.deepEqual(await ticked(page), Object.keys(BY_AGENT).sort());
  await waitFor(async () => (await graphThreads(page)).length === ALL.length, 4000);
  await page.click("#ap-none");
  assert.deepEqual(await ticked(page), []);
  await expectAgents(page, [], "None");

  // Graph tooltip marks the mismatch too.
  await closePicker(page);
  // The layout may still be settling: hover by event, not by pointer.
  await page.evaluate(() => document.querySelector('svg g.node[data-key="alpha/t-0103"]').dispatchEvent(new MouseEvent("mouseenter", { clientX: 200, clientY: 200 })));
  await page.waitForSelector("#tip:not([hidden])");
  assert.match(await page.textContent("#tip"), /claude.*recorded codex/i);

  // A8: chip × removes; the shortcut is in the ? help.
  await openPicker(page);
  await page.click('#agent-picker .arow[data-key="grok"]');
  await page.click('#agent-picker .arow[data-key="codex"]');
  await closePicker(page);
  await expectAgents(page, ["codex", "grok"], "two chips");
  await page.click('#agent-chips .achip[data-key="grok"] .ax');
  await expectAgents(page, ["codex"], "chip ×");
  await page.screenshot({ path: join(artifacts, "agents-chip.png") });
  await page.keyboard.press("?");
  await page.waitForSelector("#voice-help:not([hidden])");
  assert.match(await page.textContent("#voice-help"), /Agent filter/);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await page.close();
});

test("landscape: counts, CPU and RAM, click applies", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + "/?agent=");
  await page.waitForSelector("svg g.node.thread");
  // CPU needs two System frames.
  await waitFor(() => page.evaluate(() => window.HDSystem?.frameNow?.()?.procs?.some((p) => p.cpu != null)), 8000);
  await openPicker(page);
  const land = () => page.locator("#ap-land tbody tr").evaluateAll((rs) => Object.fromEntries(rs.map((r) =>
    [r.dataset.key, Object.fromEntries([...r.querySelectorAll("td[data-col]")].map((c) => [c.dataset.col, c.textContent.trim()]))])));
  await waitFor(async () => /\d/.test((await land()).claude?.cpu || ""), 8000);
  const l = await land();
  out.landscape = l;
  for (const [k, w] of Object.entries(LANDSCAPE)) {
    assert.ok(l[k], `landscape row ${k}`);
    for (const c of ["working", "waiting", "idle", "projects"]) assert.equal(l[k][c], String(w[c] || "–").replace(/^0$/, "–"), `${k} ${c}`);
    assert.equal(l[k].coord, w.coords ? String(w.coords) : "–", `${k} coord`);
  }
  // RAM: claude = opus 2 + swapped 1 + sonnet 0.5 + coordinator 1 GiB.
  assert.equal(l.claude.ram, "4.5 GB");
  assert.equal(l["claude:opus-5-5"].ram, "3.0 GB");
  assert.equal(l.codex.ram, "1.0 GB");
  // CPU: claude ≈ 100 + 40 + 5 + 50 = 195% of a core.
  const cpu = +l.claude.cpu.replace("%", "");
  assert.ok(cpu > 150 && cpu < 240, `claude CPU ${l.claude.cpu}`);
  await page.screenshot({ path: join(artifacts, "agents-landscape.png") });
  // A6: clicking a row applies that filter.
  await page.click('#ap-land tbody tr[data-key="opencode"]');
  await expectAgents(page, ["opencode"], "landscape click");
  await page.close();
});

test("every view follows the filter; ANDs with the project focus", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + "/?agent=claude");
  await page.waitForSelector("svg g.node.thread");
  await expectAgents(page, ["claude"], "URL claude");

  // A5: focus beta only: claude AND beta.
  await page.evaluate(() => window.hd.setFocus(["beta"]));
  await expectAgents(page, ["claude"], "claude ∧ beta", ["beta"]);
  await page.evaluate(() => window.hd.setFocus([]));

  // Needs you: alpha's coordinator (claude) is there, beta's (codex) is not.
  await waitFor(async () => (await needKeys(page)).includes("hub:alpha"), 4000);
  assert.ok(!(await needKeys(page)).includes("hub:beta"));
  assert.ok(!(await needKeys(page)).includes("beta/t-0201"), "opencode waiting thread hidden");

  // Threads tab (coordinator panel of beta): only claude cards.
  await page.evaluate(() => window.hd.select("hub:beta"));
  await page.waitForSelector("#panel .tv .tv-card, #panel .tv [data-key]");
  const cards = () => page.locator("#panel .tv [data-key]").evaluateAll((cs) => [...new Set(cs.map((c) => c.dataset.key))].sort());
  await waitFor(async () => JSON.stringify(await cards()) === JSON.stringify(["beta/t-0203"]), 4000)
    .catch(async () => assert.deepEqual(await cards(), ["beta/t-0203"], "Threads tab"));
  assert.match(await page.textContent("#panel .tv-agentnote"), /claude/);
  await page.evaluate(() => window.hd.select(null));

  // System strip: agents count only claude's threads.
  await page.click("#sys");
  await page.waitForSelector("#sys-pop:not([hidden])");
  const procKeys = () => page.locator("#sys-pop [data-key]").evaluateAll((rs) => [...new Set(rs.map((r) => r.dataset.key))].filter((k) => k.includes("/") || k.startsWith("hub:")).sort());
  await waitFor(async () => (await procKeys()).length > 0, 6000);
  for (const k of await procKeys()) assert.ok([...BY_AGENT.claude, "hub:alpha"].includes(k), `System strip shows ${k}`);
  assert.match(await page.textContent("#sys-pop"), /Agent filter: claude/);
  await page.keyboard.press("Escape");

  // Master window: rows are projects running claude; counts are claude's.
  await page.evaluate(() => window.HDFleet.open());
  await page.waitForSelector("#fl-table tbody tr");
  const fleetRows = () => page.locator("#fl-table tbody tr").evaluateAll((rs) => rs.map((r) => r.dataset.slug).sort());
  await waitFor(async () => JSON.stringify(await fleetRows()) === JSON.stringify(["alpha", "beta"]), 4000);
  await page.evaluate(() => window.hd.setFocus([]));
  // alpha: claude has 2 working threads there (opus + swapped).
  assert.match(await page.textContent('#fl-table tr[data-slug="alpha"] .fl-c-threads'), /2 working/);
  assert.doesNotMatch(await page.textContent('#fl-table tr[data-slug="alpha"] .fl-c-threads'), /idle/, "codex idle thread not counted");
  assert.match(await page.textContent("#fl-note"), /agent/i);
  await page.screenshot({ path: join(artifacts, "agents-master.png") });
  // Switch to grok: only beta remains.
  await page.goto(base + "/?agent=grok");
  await page.waitForSelector("svg g.node.thread");
  await page.evaluate(() => window.HDFleet.open());
  await waitFor(async () => JSON.stringify(await fleetRows()) === JSON.stringify(["beta"]), 4000);
  await page.evaluate(() => document.querySelector(".hwin .hw-close, .hwin [aria-label='Close']")?.click());

  // Memory map: non-matching thread tiles are dimmed.
  await page.goto(base + "/?agent=codex");
  await page.waitForSelector("svg g.node.thread");
  await page.click("#mem-open");
  await page.waitForSelector(".mm-tile[data-key]");
  await waitFor(async () => (await page.locator('.mm-tile[data-key="alpha/t-0101"]').count()) > 0, 6000);
  const dim = (k) => page.locator(`.mm-tile[data-key="${k}"]`).first().evaluate((t) => t.classList.contains("agent-dim"));
  await waitFor(async () => (await dim("alpha/t-0101")) && !(await dim("alpha/t-0102")), 4000);
  assert.equal(await dim("hub:beta"), false, "codex coordinator stays lit");
  assert.equal(await dim("hub:alpha"), true, "claude coordinator dimmed");
  await page.screenshot({ path: join(artifacts, "agents-memory.png") });

  // Search (title): only matching threads, even when the text matches others.
  await page.goto(base + "/?agent=opencode");
  await page.waitForSelector("svg g.node.thread");
  await page.fill("#f-search", "o"); // matches every title with an o
  await waitFor(async () => JSON.stringify(await graphThreads(page)) === JSON.stringify(["beta/t-0201", "beta/t-0202"]), 4000)
    .catch(async () => assert.deepEqual(await graphThreads(page), ["beta/t-0201", "beta/t-0202"], "search"));
  await page.close();
});

test("reload keeps it; URL wins over storage; no new per-tick CLI calls", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await openPicker(page);
  await page.click('#agent-picker .arow[data-key="opencode"]');
  await page.click('#agent-picker .arow[data-key="grok"]');
  await closePicker(page);
  await expectAgents(page, ["grok", "opencode"], "before reload");
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await expectAgents(page, ["grok", "opencode"], "after reload");
  await page.goto(base + "/?agent=codex");
  await page.waitForSelector("svg g.node.thread");
  await expectAgents(page, ["codex"], "URL wins");
  // An agent nothing runs is kept but hides nothing.
  await page.goto(base + "/?agent=hermes");
  await page.waitForSelector("svg g.node.thread");
  await waitFor(async () => (await graphThreads(page)).length === ALL.length, 4000);

  // A10: the commands Dash runs per tick are the same with the filter on.
  const cmds = () => new Set(readFileSync(f.log, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 3).join(" ")));
  const before = cmds();
  await page.goto(base + "/?agent=claude,codex");
  await page.waitForSelector("svg g.node.thread");
  await new Promise((r) => setTimeout(r, 2500));
  const added = [...cmds()].filter((c) => !before.has(c));
  assert.deepEqual(added, [], "no new kinds of CLI calls");
  await ctx.close();
});

test("phone: the picker is a bottom sheet, no sideways scroll", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(base + "/?agent=");
  await page.waitForSelector("svg g.node.thread");
  await page.tap("#f-agent");
  await page.waitForSelector("#agent-picker:not([hidden])");
  await page.evaluate(() => Promise.all(document.querySelector("#agent-picker").getAnimations().map((a) => a.finished)));
  const r = await page.locator("#agent-picker").boundingBox();
  assert.ok(Math.abs(r.y + r.height - 844) < 2, "sheet sits on the bottom edge: " + JSON.stringify(r));
  assert.ok(r.width >= 389, "sheet is full width");
  await page.tap('#agent-picker .arow[data-key="claude"]');
  await waitFor(async () => JSON.stringify(await graphThreads(page)) === JSON.stringify(BY_AGENT.claude.slice().sort()), 4000);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal scroll");
  await page.screenshot({ path: join(artifacts, "agents-phone.png") });
  await page.tap("#ap-done");
  await page.waitForSelector("#agent-picker", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal scroll with chips");
  await ctx.close();
});
