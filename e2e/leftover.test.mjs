// E2E: resolved threads whose agents still run ("leftovers"), and agent
// panes of a project that match no thread at all ("orphans"): detection,
// where they show (Threads view, graph, System strip, Master window), and
// the explicit, per-pane clean-up with its refusals and audit lines. The
// real herdr-dash binary runs against a copy of the fixtures with stubbed
// herdr-projects / herdr and a fake /proc. Every name is made up.
// Artifacts: e2e/artifacts/leftover-*.png and leftover.json.
//
// Ways it could fail, written before it existed:
//  L1. Detection misses a leftover: a live pane named by the resolved
//      thread's record, a pane titled "t-NNNN · …" with the project's hp
//      tokens, or a pane whose cwd is under the thread's (deleted) worktree.
//  L2. Detection claims a pane that is not the thread's: herdr reused the
//      pane id for an unrelated pane (other cwd, no tokens), or an open
//      thread's or the coordinator's pane is called an orphan.
//  L3. Detection costs herdr calls: anything beyond the collector's own
//      pane list per tick (a pane get, a process-info) while nobody acts.
//  L4. The live stream drops leftovers with the other resolved threads, so
//      the graph's default "Open threads" window hides them.
//  L5. The Threads view has no "Resolved · still running" group between
//      Idle and Review, a card has no badge or RSS, or the thread stays in
//      the folded Done group; orphans are not shown at all.
//  L6. The graph shows a leftover like any resolved node (no ring).
//  L7. The System strip calls a leftover pane a thread or a bare pane
//      instead of "leftover"; the Master window has no Attention item
//      "N leftover agents · X GB".
//  L8. Close runs without a confirmation, or the confirmation does not name
//      the thread, pane, agent, cwd and RSS.
//  L9. Close does not refuse when the agent is working, the pane changed
//      since the dialog (other agent or cwd), the thread is not resolved
//      (or the pane is not a leftover), or herdr would close a whole
//      worktree group (confirmation_required).
// L10. Close all: no typed count, the count is not checked by the server,
//      a pane is missing from the list, or one refusal stops the others.
// L11. A close (done or refused) leaves no audit line.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { td, stub, artifacts, startServer, freePort, waitFor, post } from "./helpers.mjs";
import { FakeProc, GiB } from "./fakeproc.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-leftover-"));
const root = join(tmp, "root"), stubDir = join(tmp, "stub"), log = join(tmp, "calls"), proc = join(tmp, "proc"), audit = join(tmp, "audit.jsonl");
const panesFile = join(tmp, "panes.json");
let server, base, browser, fp, ticker;
const out = {};

// The live panes: the fixture's own, then the leftovers and decoys.
const extra = [
  // t-0004 (resolved): its recorded pane is alive, cwd in its worktree.
  { agent: "claude", agent_status: "idle", cwd: "/fixture/wt/alpha-t-0004", pane_id: "w1D:p1", tab_id: "w1D:t1", workspace_id: "w1D" },
  // t-0011 (resolved): another pane, in its deleted worktree.
  { agent: "opencode", agent_status: "idle", cwd: "/fixture/wt/alpha-t-0011/src (deleted)", pane_id: "w4B:p1", tab_id: "w4B:t1", workspace_id: "w4B" },
  // t-0012 (resolved): titled after it, with alpha's hp tokens; working.
  { agent: "codex", agent_status: "working", cwd: "/elsewhere/build", display_agent: "t-0012 · Prune stale branches", pane_id: "w4D:p1", tab_id: "w4D:t1", workspace_id: "w4D", tokens: { hp_project: "alpha", hp_rank: "4" } },
  // An orphan: alpha's tokens, an agent, no thread of alpha's.
  { agent: "claude", agent_status: "idle", cwd: "/fixture/scratch", display_agent: "Scratch helper", pane_id: "w4E:p1", tab_id: "w4E:t1", workspace_id: "w4E", tokens: { hp_project: "alpha" } },
  // t-0013's recorded pane id, reused by herdr for something unrelated.
  { agent: "claude", agent_status: "idle", cwd: "/home/someone/unrelated", pane_id: "w4F:p1", tab_id: "w4F:t1", workspace_id: "w4F" },
];
const resolvedRow = (base, o) => ({ ...base, status: "resolved", group: "Resolved", group_token: "resolved", last_state: "done", resolved_reason: "merged", pr: "", pr_state: "", next: [], report_hash: "", acked_report_hash: "", activity: "", percent: 100, prompt_pending: false, launch_attempts: 0, ...o });

function writePanes(rows) {
  writeFileSync(panesFile, '{"id":"cli:pane:list","result":{"panes":[\n' + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]}}\n");
}
function setPane(id, patch) {
  const doc = JSON.parse(readFileSync(panesFile, "utf8"));
  writePanes(doc.result.panes.map((p) => (p.pane_id === id ? { ...p, ...patch } : p)));
}
const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const state = async () => (await fetch(base + "/api/state")).json();
const thr = (s, id) => s.threads.find((t) => t.key === "alpha/" + id);
const auditLines = () => { try { return readFileSync(audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

before(async () => {
  cpSync(join(td, "root"), root, { recursive: true });
  cpSync(stub, stubDir, { recursive: true });
  writeFileSync(log, "");
  const own = JSON.parse(readFileSync(join(stub, "panes.json"), "utf8")).result.panes;
  writePanes([...own, ...extra]);
  const list = JSON.parse(readFileSync(join(stubDir, "thread-list-alpha.json"), "utf8"));
  const t4 = list.find((t) => t.id === "t-0004");
  list.push(
    resolvedRow(t4, { id: "t-0011", title: "Harvest the orchard feed", pane_id: "w4A:p1", tab_id: "w4A:t1", workspace_id: "w4A", agent: "opencode", agent_name: "hp-alpha-t-0011", branch: "hp/alpha/t-0011-harvest", cwd: "/fixture/wt/alpha-t-0011", worktree_path: "/fixture/wt/alpha-t-0011", thread_dir: "/fixture/wt/alpha-t-0011/.herdr-project/alpha-t-0011" }),
    resolvedRow(t4, { id: "t-0012", title: "Prune stale branches", pane_id: "w4C:p1", tab_id: "w4C:t1", workspace_id: "w4C", agent: "codex", agent_name: "hp-alpha-t-0012", branch: "hp/alpha/t-0012-prune", cwd: "/fixture/wt/alpha-t-0012", worktree_path: "", thread_dir: "/fixture/wt/alpha-t-0012/.herdr-project/alpha-t-0012" }),
    resolvedRow(t4, { id: "t-0013", title: "Reused pane id", pane_id: "w4F:p1", tab_id: "w4F:t1", workspace_id: "w4F", agent_name: "hp-alpha-t-0013", branch: "hp/alpha/t-0013-reused", cwd: "/fixture/wt/alpha-t-0013", worktree_path: "", thread_dir: "" }),
    resolvedRow(t4, { id: "t-0014", title: "Quietly done", pane_id: "w4G:p1", tab_id: "w4G:t1", workspace_id: "w4G", agent_name: "hp-alpha-t-0014", branch: "hp/alpha/t-0014-quiet", cwd: "/fixture/wt/alpha-t-0014", worktree_path: "", thread_dir: "" }),
  );
  writeFileSync(join(stubDir, "thread-list-alpha.json"), JSON.stringify(list, null, 1));
  // Agent processes, by pane: 1 + 2 + 0.5 + 0.5 GiB of leftovers.
  fp = new FakeProc(proc);
  fp.add(5001, "claude", { cpu: 0.01, rss: 1 * GiB, env: { HERDR_PANE_ID: "w1D:p1" } });
  fp.add(5002, "opencode", { cpu: 0.01, rss: 2 * GiB, env: { HERDR_PANE_ID: "w4B:p1" } });
  fp.add(5003, "codex", { cpu: 0.3, rss: 0.5 * GiB, env: { HERDR_PANE_ID: "w4D:p1" } });
  fp.add(5004, "claude", { cpu: 0.01, rss: 0.5 * GiB, env: { HERDR_PANE_ID: "w4E:p1" } });
  fp.add(5005, "claude", { cpu: 0.2, rss: 0.3 * GiB, env: { HERDR_PANE_ID: "w1A:p1" } });
  fp.write();
  ticker = setInterval(() => fp.advance(), 250);
  const port = await freePort();
  server = startServer(port, log, ["--root", root, "--herdr", join(stubDir, "herdr"), "--proc", proc, "--fleet-audit", audit, "--write-burst", "100", "--write-per-min", "600"],
    { HERDR_DASH_HERDR_PROJECTS: join(stubDir, "herdr-projects"), STUB_PANES: panesFile });
  base = `http://127.0.0.1:${port}`;
  await waitFor(async () => thr(await state(), "t-0011")?.state === "leftover", 15_000);
  browser = await chromium.launch();
});

after(async () => {
  clearInterval(ticker);
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "leftover.json"), JSON.stringify(out, null, 2));
  rmSync(tmp, { recursive: true, force: true });
});

async function openPage(q = "") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(base + "/" + q);
  await page.waitForFunction(() => window.hd?.state().threads.some((t) => t.state === "leftover"));
  return page;
}
async function openHub(page) {
  await page.evaluate(() => window.hd.select("hub:alpha"));
  await page.waitForSelector('#panel.open .tv .tv-stage[data-stage="leftover"] .tv-card');
}

test("detection: by pane id, by title, by deleted cwd; orphans; no false match (L1, L2)", async () => {
  const s = await state();
  const t4 = thr(s, "t-0004"), t11 = thr(s, "t-0011"), t12 = thr(s, "t-0012");
  assert.equal(t4.state, "leftover");
  assert.deepEqual(t4.leftover.map((l) => [l.pane, l.match, l.agent, l.status]), [["w1D:p1", "pane", "claude", "idle"]]);
  assert.equal(t11.state, "leftover");
  assert.deepEqual(t11.leftover.map((l) => [l.pane, l.match, !!l.deleted]), [["w4B:p1", "cwd", true]]);
  assert.equal(t11.leftover[0].cwd, "/fixture/wt/alpha-t-0011/src (deleted)");
  assert.equal(t12.state, "leftover");
  assert.deepEqual(t12.leftover.map((l) => [l.pane, l.match, l.status]), [["w4D:p1", "title", "working"]]);
  assert.equal(thr(s, "t-0013").state, "resolved", "a reused pane id with an unrelated cwd is not the thread's");
  assert.equal(thr(s, "t-0014").state, "resolved");
  for (const t of [t4, t11, t12]) assert.equal(t.needs_you, false);
  const alpha = s.projects.find((p) => p.slug === "alpha");
  assert.deepEqual(alpha.orphans.map((o) => [o.pane, o.agent]), [["w4E:p1", "claude"]], "only the untracked agent pane is an orphan, not the coordinator's or an open thread's");
  assert.equal(alpha.leftovers, 4);
  assert.equal(s.projects.find((p) => p.slug === "beta").leftovers ?? 0, 0);
  out.detection = { t4: t4.leftover, t11: t11.leftover, t12: t12.leftover, orphans: alpha.orphans };
});

test("no extra herdr calls while nobody acts (L3)", async () => {
  const m = calls().length;
  await new Promise((r) => setTimeout(r, 3500));
  const extra = calls().slice(m).filter((l) => l.startsWith("herdr ") && !/^herdr pane (list|read|layout)( |$)/.test(l));
  assert.deepEqual(extra, [], "detection ran herdr commands");
});

test("live stream: leftovers come with the open threads (L4)", async () => {
  const ac = new AbortController();
  const r = await fetch(base + "/api/events", { signal: ac.signal });
  const reader = r.body.getReader();
  let buf = "";
  while (!/event: state\ndata: .*\n/.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  const snap = JSON.parse(buf.match(/event: state\ndata: (.*)\n/)[1]);
  assert.equal(snap.resolved_omitted, true);
  const keys = snap.threads.map((t) => t.key);
  for (const id of ["t-0004", "t-0011", "t-0012"]) assert.ok(keys.includes("alpha/" + id), id + " missing from the live snapshot");
  assert.ok(!keys.includes("alpha/t-0014"), "plain resolved threads stay out");
});

test("Threads view: Resolved · still running group, badges, RSS, orphans (L5)", async () => {
  const page = await openPage();
  await openHub(page);
  const order = await page.$$eval("#panel .tv .tv-stage", (ss) => ss.map((s) => s.dataset.stage));
  assert.deepEqual(order.slice(order.indexOf("idle"), order.indexOf("idle") + 3), ["idle", "leftover", "review"]);
  const g = page.locator('#panel .tv-stage[data-stage="leftover"]');
  assert.match(await g.locator(".tv-sh-label").innerText(), /Resolved · still running/);
  const ids = await g.locator(".tv-card").evaluateAll((cs) => cs.map((c) => c.dataset.id || c.dataset.pane));
  assert.deepEqual([...ids].sort(), ["t-0004", "t-0011", "t-0012", "w4E:p1"].sort());
  const c4 = g.locator('.tv-card[data-id="t-0004"]');
  assert.match(await c4.locator(".tv-leftover-badge").innerText(), /agent still running/i);
  await page.waitForFunction(() => /1\.0 GB/.test(document.querySelector('#panel .tv-card[data-id="t-0004"] .tv-rss')?.textContent || ""));
  assert.match(await g.locator('.tv-card[data-id="t-0011"]').innerText(), /deleted/i);
  assert.match(await g.locator('.tv-card[data-pane="w4E:p1"]').innerText(), /orphan/i);
  // Not in Done.
  const done = await page.$$eval('#panel .tv-stage[data-stage="done"] .tv-card', (cs) => cs.map((c) => c.dataset.id));
  assert.ok(!done.includes("t-0004") && done.includes("t-0014"), JSON.stringify(done));
  await page.locator("#panel").screenshot({ path: join(artifacts, "leftover-threads.png") });
  await g.scrollIntoViewIfNeeded();
  await g.screenshot({ path: join(artifacts, "leftover-group.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("graph: a ring, and visible with the Open threads window (L6, L4)", async () => {
  const page = await openPage();
  await page.waitForSelector('g.node.thread.leftover[data-key="alpha/t-0004"] circle.leftover-ring');
  assert.equal(await page.$('g.node[data-key="alpha/t-0014"]'), null, "a plain resolved thread stays hidden");
  await page.screenshot({ path: join(artifacts, "leftover-graph.png") });
  await page.close();
});

test("System strip and Master window (L7)", async () => {
  const page = await openPage();
  await page.waitForFunction(() => window.HDSystem?.frameNow()?.procs?.some((p) => p.kind === "leftover"));
  await page.click('#sys .sysc[data-id="agents"]');
  const row = page.locator('#sys-pop .sproc[data-key="alpha/t-0004"]');
  await row.waitFor();
  assert.equal(await row.getAttribute("data-kind"), "leftover");
  assert.match(await row.innerText(), /leftover/i);
  assert.match(await page.locator('#sys-pop .sproc[data-key="pane:w4E:p1"]').innerText(), /leftover/i);
  await page.locator("#sys-pop").screenshot({ path: join(artifacts, "leftover-system.png") });
  await page.keyboard.press("Escape");
  const fl = await (await fetch(base + "/api/fleet")).json();
  const item = fl.attention.find((a) => a.slug === "alpha" && a.kind === "leftovers");
  assert.ok(item, JSON.stringify(fl.attention));
  assert.equal(item.text, "4 leftover agents · 4.0 GB");
  assert.equal(item.count, 4);
  assert.equal(fl.rows.find((r) => r.slug === "alpha").stages.idle, 1, "leftovers are not open idle threads");
  await page.click("#master-open");
  await page.waitForSelector('.hwin[data-win="master"] #fl-attn li[data-kind="leftovers"]');
  assert.match(await page.locator('.hwin[data-win="master"] #fl-attn li[data-kind="leftovers"]').innerText(), /4 leftover agents · 4\.0 GB/);
  // Stopping agents is never a bulk action.
  const ops = await (await fetch(base + "/api/fleet/ops")).json();
  assert.ok(!JSON.stringify(ops.ops).includes("leftover"));
  await page.close();
  out.fleetItem = item;
});

test("close one: confirmation names everything, then herdr pane close and an audit line (L8, L11)", async () => {
  const page = await openPage();
  await openHub(page);
  await page.waitForFunction(() => /GB/.test(document.querySelector('#panel .tv-card[data-id="t-0004"] .tv-rss')?.textContent || ""));
  const m = calls().length;
  await page.click('#panel .tv-card[data-id="t-0004"] .tv-close-leftover');
  await page.waitForSelector("#dlg[open]");
  const text = await page.locator("#dlg").innerText();
  for (const s of ["t-0004", "Old cleanup", "w1D:p1", "claude", "/fixture/wt/alpha-t-0004", "1.0 GB"]) assert.ok(text.includes(s), `dialog lacks ${s}: ${text}`);
  await page.locator("#dlg").screenshot({ path: join(artifacts, "leftover-confirm.png") });
  // Cancel runs nothing.
  await page.click("#dlg-cancel");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!calls().slice(m).some((l) => l.includes("pane close")), "cancel closed the pane");
  await page.click('#panel .tv-card[data-id="t-0004"] .tv-close-leftover');
  await page.waitForSelector("#dlg[open]");
  await page.click("#dlg-ok");
  await waitFor(() => calls().slice(m).includes("herdr pane close w1D:p1"));
  assert.ok(calls().slice(m).includes("herdr pane get w1D:p1"), "the pane is checked fresh before it closes");
  await waitFor(async () => thr(await state(), "t-0004").state === "resolved", 10_000);
  await page.waitForSelector('#panel .tv-stage[data-stage="done"] .tv-card[data-id="t-0004"]', { state: "attached" });
  const a = auditLines().filter((l) => l.op === "close-leftover");
  assert.equal(a.length, 1);
  assert.equal(a[0].result, "ok");
  assert.equal(a[0].target, "alpha");
  assert.deepEqual(a[0].args, ["t-0004", "w1D:p1"]);
  assert.equal(a[0].command, "herdr pane close w1D:p1");
  assert.match(a[0].text, /claude/);
  const api = await (await fetch(base + "/api/fleet/audit?op=close-leftover")).json();
  assert.equal(api.lines.length, 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("refusals: working, changed, not a leftover, worktree group (L9, L11)", async () => {
  const s = await state();
  const t12 = thr(s, "t-0012").leftover[0], t11 = thr(s, "t-0011").leftover[0];
  const body = (l, thread) => ({ panes: [{ pane: l.pane, thread, agent: l.agent, cwd: l.cwd, workspace: l.workspace }] });
  const m = calls().length;
  // Working.
  let r = await post(base, "/api/project/alpha/leftovers/close", body(t12, "t-0012"));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.results[0].code, "agent_working", JSON.stringify(r.json));
  // Through the page too: the dialog says why it may refuse, the toast says it did.
  const page = await openPage();
  await openHub(page);
  await page.click('#panel .tv-card[data-id="t-0012"] .tv-close-leftover');
  await page.waitForSelector("#dlg[open]");
  assert.match(await page.locator("#dlg").innerText(), /working/i);
  await page.click("#dlg-ok");
  await page.waitForSelector(".toast.err");
  assert.match(await page.locator(".toast.err").last().innerText(), /working/i);
  // Changed between the dialog and the click: another agent in the pane.
  setPane("w4B:p1", { agent: "claude" });
  r = await post(base, "/api/project/alpha/leftovers/close", body(t11, "t-0011"));
  assert.equal(r.json.results[0].code, "pane_changed", JSON.stringify(r.json));
  setPane("w4B:p1", { agent: "opencode", cwd: "/fixture/other" });
  r = await post(base, "/api/project/alpha/leftovers/close", body(t11, "t-0011"));
  assert.equal(r.json.results[0].code, "pane_changed", JSON.stringify(r.json));
  setPane("w4B:p1", { cwd: t11.cwd });
  // Its cwd moved away (no longer the thread's) and back: a poll that read
  // the moved cwd may still be landing, so wait past one, then for it again.
  await new Promise((r) => setTimeout(r, 1500));
  await waitFor(async () => thr(await state(), "t-0011").state === "leftover");
  // Not a leftover: an open thread's pane, or a thread that is not resolved.
  r = await post(base, "/api/project/alpha/leftovers/close", { panes: [{ pane: "w1A:p1", thread: "t-0001", agent: "claude", cwd: "/x", workspace: "w1A" }] });
  assert.equal(r.json.results[0].code, "not_leftover", JSON.stringify(r.json));
  // herdr would close a worktree group.
  writeFileSync(join(stubDir, "close-confirm-w4B_p1"), "");
  r = await post(base, "/api/project/alpha/leftovers/close", body(t11, "t-0011"));
  assert.equal(r.json.results[0].code, "worktree_group", JSON.stringify(r.json));
  rmSync(join(stubDir, "close-confirm-w4B_p1"));
  const closes = calls().slice(m).filter((l) => l.startsWith("herdr pane close"));
  assert.deepEqual(closes, ["herdr pane close w4B:p1"], "only the group case reached herdr's close (and herdr refused it)");
  const refused = auditLines().filter((l) => l.op === "close-leftover" && l.result === "refused");
  assert.deepEqual(refused.map((l) => l.reason.split(":")[0]), ["agent_working", "agent_working", "pane_changed", "pane_changed", "not_leftover", "worktree_group"]);
  // Bad input.
  assert.equal((await post(base, "/api/project/alpha/leftovers/close", { panes: [] })).status, 400);
  assert.equal((await post(base, "/api/project/..x/leftovers/close", body(t11, "t-0011"))).status, 400);
  await page.close();
  out.refused = refused;
});

test("close all: typed count, every pane listed, refusals do not stop the rest (L10, L11)", async () => {
  // Wait for the restored pane to be seen again.
  await waitFor(async () => thr(await state(), "t-0011").leftover?.[0]?.agent === "opencode" && thr(await state(), "t-0011").leftover[0].cwd.endsWith("(deleted)"));
  // The server checks the count against the project's leftovers of the moment.
  const s = await state();
  const all = [...["t-0011", "t-0012"].map((id) => ({ ...thr(s, id).leftover[0], thread: id })), ...s.projects.find((p) => p.slug === "alpha").orphans.map((o) => ({ ...o, thread: "" }))];
  const panes = all.map((l) => ({ pane: l.pane, thread: l.thread, agent: l.agent, cwd: l.cwd, workspace: l.workspace }));
  let r = await post(base, "/api/project/alpha/leftovers/close", { all: true, count: 2, panes });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "confirm_count", JSON.stringify(r.json));
  const page = await openPage();
  await openHub(page);
  const m = calls().length;
  await page.click('#panel .tv-stage[data-stage="leftover"] .tv-close-all');
  await page.waitForSelector("#dlg[open]");
  const text = await page.locator("#dlg").innerText();
  for (const p of ["w4B:p1", "w4D:p1", "w4E:p1", "t-0011", "t-0012", "orphan"]) assert.ok(text.includes(p), `dialog lacks ${p}: ${text}`);
  const ok = page.locator("#dlg-ok");
  assert.equal(await ok.isDisabled(), true, "OK before the count is typed");
  await page.fill("#leftover-count", "2");
  assert.equal(await ok.isDisabled(), true, "OK with a wrong count");
  await page.fill("#leftover-count", "3");
  assert.equal(await ok.isDisabled(), false);
  await page.locator("#dlg").screenshot({ path: join(artifacts, "leftover-close-all.png") });
  await ok.click();
  await waitFor(() => calls().slice(m).includes("herdr pane close w4E:p1") && calls().slice(m).includes("herdr pane close w4B:p1"));
  assert.ok(!calls().slice(m).includes("herdr pane close w4D:p1"), "the working agent was closed");
  await waitFor(async () => { const s = await state(); return thr(s, "t-0011").state === "resolved" && !(s.projects.find((p) => p.slug === "alpha").orphans || []).length; }, 10_000);
  const batch = auditLines().filter((l) => l.op === "close-leftover" && l.batch);
  assert.equal(batch.length, 3);
  assert.equal(new Set(batch.map((l) => l.batch)).size, 1);
  assert.deepEqual(batch.map((l) => [l.args[1], l.result]).sort(), [["w4B:p1", "ok"], ["w4D:p1", "refused"], ["w4E:p1", "ok"]]);
  assert.deepEqual(batch.find((l) => l.args[1] === "w4E:p1").args, ["orphan", "w4E:p1"]);
  await page.waitForSelector(".toast");
  await page.screenshot({ path: join(artifacts, "leftover-after.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
  out.batch = batch;
});
