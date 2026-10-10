// E2E: run the real herdr-dash binary against a fixture herdr-projects root
// with stubbed herdr-projects / herdr / gh, then drive the page in headless
// Chromium. Artifacts (screenshots + API snapshot) land in e2e/artifacts/.
//
// Ways this could fail, written before the server existed:
//  1. A project whose `thread list` errors drops every other project.
//  2. herdr-projects groups are mis-mapped to dashboard states/colors.
//  3. The live pane status (blocked) is ignored, so blocked looks like waiting.
//  4. "Needs you" misses waiting/blocked/review/landing threads, or includes
//     working/idle/resolved ones.
//  5. Transcript mtimes are never found, so last activity is just `updated`.
//  6. A thread with a branch but no recorded PR never gets its gh PR link.
//  7. Report/task markdown is rendered unsanitized (script tags, javascript:).
//  8. The screen snippet is injected as HTML.
//  9. The server runs a mutating command (send-keys, prompt, focus, ...).
// 10. The SSE stream never emits, so the page never goes live.
// 11. The page renders no nodes, clicking a Needs-you item does not open the
//     panel, or filters/search do not filter.
// 12. The layout breaks on a phone-sized viewport.
//
// Interactive actions (chat + triage), written before the write API existed:
// 13. A write runs a command outside the allow-list, or a raw `herdr agent
//     prompt/send-keys` instead of herdr-projects.
// 14. Prompt text reaches a shell or argv instead of stdin, so `$(...)`,
//     backticks or `;` are interpreted.
// 15. A malformed slug/id/key/line (path tricks, flags like `--root`, shell
//     metacharacters, ctrl+c, newlines in typed text) reaches herdr-projects.
// 16. Mutations accept GET, a non-JSON body (form CSRF) or a foreign Origin.
// 17. agent_blocked / prompt_unconfirmed refusals are swallowed, or the page
//     resends an unconfirmed prompt by itself.
// 18. Resolve runs without an explicit confirmation.
// 19. Writes are not rate limited.
// 20. The strip is not grouped by severity, acked threads are not
//     filterable, optimistic updates do not revert on error, errors are not
//     shown.
// 21. Quick-reply buttons do not appear for a blocked pane, or the screen
//     stream never delivers.
//
// Coordinator panel, written before it existed:
// 22. Clicking a project hub does not open a panel (or opens a thread's).
// 23. The coordinator pane is guessed: a stale `.state/coordinators.json`
//     entry, or the recorded pane now running in another folder, is shown
//     (and read) as the live coordinator instead of "no live pane".
// 24. A blocked coordinator, or one herdr-projects marks "needs you", is
//     missing from the Needs-you strip; or an idle one is in it.
// 25. The coordinator's progress line (`progress --pane`), settings, safety
//     summary or inbox count (open items only) are missing or wrong.
// 26. TASKS.md / MEMORY.md are rendered unsanitized.
// 27. The coordinator screen is read while no coordinator panel is open, or
//     its stream keeps polling after the panel closes.
// 28. A coordinator prompt refusal is swallowed, the text reaches argv, or
//     the screen does not refresh fast after a send.
// 29. Offering key presses to a coordinator: herdr-projects has no command
//     for that, so nothing but `coordinator prompt` may be sent.
// 30. An open thread in the coordinator panel does not open its own panel.
// 31. The coordinator panel breaks on a phone-sized viewport.
//
// Reports and the live screen, written before the change:
// 32. The live screen misses the newest lines: a pane scrolled up in herdr
//     (`--source visible`), a read from the top, a trimmed tail, or a box
//     that does not stay pinned to the bottom (or yanks a reader who
//     scrolled up back down).
// 33. The coordinator panel lacks the project's thread reports newest
//     first, each collapsed, with title, id, time and a way to the thread.
// 34. The thread panel's report is still open by default, or above the chat
//     and Next.
//
// Dockable panel, written before the change:
// 35. The panel cannot be docked left or bottom, or the choice is lost on
//     reload.
// 36. The panel still overlays the graph: the graph area does not shrink
//     when it opens or moves, nor grow back when it closes, or nodes are
//     left outside the remaining area.
// 37. The splitter does not resize the panel, ignores its limits, or the
//     size is not kept per position.
// 38. The panel covers the Needs-you strip or the filters.
// 39. The bottom dock wastes its width: chat and details are not side by
//     side on a wide screen.
// 40. Phones lose the bottom sheet, or show a dock control, whatever dock
//     was chosen on desktop.
//
// Longer scrollback, written before the change:
// 41. Lines vanish once they scroll out of the live tail, or merging a new
//     tail into the buffer duplicates or reorders lines.
// 42. A full-screen TUI redraw garbles the buffer (history mixed with the
//     frame) instead of replacing it.
// 43. Scrolling to the top does not load earlier lines, the reader's place
//     jumps when they are prepended, or loading goes on past the cap or
//     keeps polling once nothing more is to be had.
// 44. History reads are unbounded (any ?lines=), uncached, or run in
//     parallel for one pane; or a pane that may not be read is read.
// 45. An update yanks a scrolled-up reader down, or there is no "new
//     output" button to jump back to the newest line.
// 46. The box stays short instead of using the panel's height in side and
//     bottom docks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const td = join(repo, "testdata");
const stub = join(td, "stub");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-e2e-"));
const stubLog = join(tmp, "calls.log");
const redrawFlag = join(tmp, "redraw");
writeFileSync(stubLog, "");

// git does not keep mtimes: set the transcript times the test asserts on.
const claudeTranscript = join(td, "claude/-proj/11111111-1111-1111-1111-111111111111.jsonl");
const codexTranscript = join(td, "codex/2026/10/10/rollout-2026-10-10T07-00-00-22222222-2222-2222-2222-222222222222.jsonl");
const claudeTime = new Date(Date.now() - 30_000);
const codexTime = new Date("2026-10-05T10:00:00Z");
utimesSync(claudeTranscript, claudeTime, claudeTime);
utimesSync(codexTranscript, codexTime, codexTime);
// Report mtimes order the coordinator's report list (33).
const reportNew = new Date("2026-10-04T10:00:00Z"), reportOld = new Date("2026-10-02T10:00:00Z");
utimesSync(join(td, "root/alpha/threads/t-0002.md"), reportNew, reportNew);
utimesSync(join(td, "root/alpha/threads/t-0003.md"), reportOld, reportOld);

let server, base, browser, rootDir;

function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function startServer(port, extra = []) {
  // Listen address and herdr-projects path come from env here, the rest
  // from flags: both ways of configuring must work.
  return spawn(join(repo, "bin/herdr-dash"), [
    "--root", join(td, "root"),
    "--herdr", join(stub, "herdr"),
    "--gh", join(stub, "gh"),
    "--claude-dir", join(td, "claude"),
    "--codex-dir", join(td, "codex"),
    "--poll", "1s",
    ...extra,
  ], {
    env: { ...process.env, STUB_LOG: stubLog, STUB_T0: String(Math.floor(Date.now() / 1000)), STUB_REDRAW: redrawFlag, HERDR_DASH_ADDR: `127.0.0.1:${port}`, HERDR_DASH_HERDR_PROJECTS: join(stub, "herdr-projects"), HERDR_DASH_MEMEX: join(stub, "memex") },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function post(path, body, { headers = {}, url = base } = {}) {
  const r = await fetch(url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// Lines the stubs logged since mark().
const logLines = () => readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
const mark = () => logLines().length;
const since = (m) => logLines().slice(m).filter((l) => !/ (list|pane read|pr list|progress --pane|safety show)( |$)/.test(l));

async function getJSON(path) {
  const r = await fetch(base + path);
  assert.equal(r.status, 200, `${path} -> ${r.status}`);
  return r.json();
}

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw last ?? new Error("timed out");
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  rootDir = join(td, "root");
  server = startServer(port, ["--write-burst", "100"]);
  await waitFor(async () => {
    const s = await getJSON("/api/state");
    return s.threads.length > 0 && s.prs_checked;
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

const byKey = (s) => Object.fromEntries(s.threads.map((t) => [t.key, t]));

test("API state maps groups, live status, activity and PRs", async () => {
  const s = await getJSON("/api/state");
  writeFileSync(join(artifacts, "state.json"), JSON.stringify(s, null, 2));

  // 1: gamma fails, alpha and beta survive, the error is surfaced.
  assert.deepEqual(s.projects.map((p) => p.slug), ["alpha", "beta", "gamma"]);
  assert.equal(s.projects[0].name, "Alpha Project");
  assert.equal(s.projects[0].goal, "Ship the alpha thing");
  assert.ok(s.projects[2].error, "gamma error surfaced");
  assert.equal(s.threads.length, 10);

  const t = byKey(s);
  // 2 + 3
  assert.equal(t["alpha/t-0001"].state, "working");
  assert.equal(t["alpha/t-0002"].state, "blocked");
  assert.equal(t["alpha/t-0003"].state, "review");
  assert.equal(t["alpha/t-0004"].state, "resolved");
  assert.equal(t["alpha/t-0005"].state, "idle");
  assert.equal(t["beta/t-0001"].state, "landing");
  assert.equal(t["beta/t-0002"].state, "waiting");
  assert.equal(t["alpha/t-0001"].live_status, "working");

  // 4
  const needs = s.threads.filter((x) => x.needs_you).map((x) => x.key).sort();
  assert.deepEqual(needs, ["alpha/t-0002", "alpha/t-0003", "alpha/t-0006", "alpha/t-0007", "beta/t-0001", "beta/t-0002", "beta/t-0003"]);
  // 20: acked = the current report hash was acknowledged.
  assert.equal(t["alpha/t-0007"].acked, true);
  assert.equal(t["alpha/t-0003"].acked, false);

  // 5: claude transcript is newer than `updated`; codex found by session id.
  const a1 = Date.parse(t["alpha/t-0001"].last_activity);
  assert.ok(Math.abs(a1 - claudeTime.getTime()) < 2000, `claude mtime used: ${t["alpha/t-0001"].last_activity}`);
  assert.equal(Date.parse(t["alpha/t-0003"].last_activity), codexTime.getTime());
  assert.equal(t["alpha/t-0005"].last_activity, "2026-10-02T12:00:00Z");

  // 6: recorded PR kept; missing one filled from gh by branch.
  assert.equal(t["alpha/t-0003"].pr, "https://github.com/acme/alpha/pull/7");
  assert.equal(t["alpha/t-0006"].pr, "https://github.com/acme/alpha/pull/9");
  assert.equal(t["alpha/t-0006"].pr_state, "OPEN");
});

test("thread detail renders sanitized markdown, snippet and jump commands", async () => {
  const d = await getJSON("/api/thread/alpha/t-0002");
  writeFileSync(join(artifacts, "thread-alpha-t-0002.json"), JSON.stringify(d, null, 2));
  // 7
  assert.match(d.report_html, /<h2[^>]*>Report<\/h2>/);
  assert.doesNotMatch(d.report_html, /<script/i);
  assert.doesNotMatch(d.report_html, /javascript:/i);
  // 8: snippet is plain text; the page must set it as textContent.
  assert.match(d.screen, /screen of w1B:p1/);
  assert.deepEqual(d.next, ["Approve the prompt"]);
  assert.ok(d.jump.some((j) => j.command === "herdr agent focus w1B:p1"));

  const d1 = await getJSON("/api/thread/alpha/t-0001");
  assert.match(d1.task_html, /<strong>widget<\/strong>/);

  const r = await fetch(base + "/api/thread/alpha/t-9999");
  assert.equal(r.status, 404);
  const bad = await fetch(base + "/api/thread/..%2f..%2fetc/passwd");
  assert.notEqual(bad.status, 200);
});

test("SSE stream emits state", async () => {
  // 10
  const ctrl = new AbortController();
  const r = await fetch(base + "/api/events", { signal: ctrl.signal });
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const reader = r.body.getReader();
  let buf = "";
  while (!buf.includes("\n\n")) buf += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  assert.match(buf, /^event: state\ndata: \{/);
});

test("page renders graph, needs-you strip, panel and filters", async () => {
  // 11
  const m0 = mark();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  // Let the force layout settle a little for the screenshot.
  await page.waitForTimeout(2500);
  assert.equal(await page.locator("svg g.node.thread").count(), 10);
  assert.equal(await page.locator("svg g.node.hub").count(), 3);
  // Acked alpha/t-0007 is hidden by default; alpha's and beta's
  // coordinators need you too.
  assert.equal(await page.locator("#needs .chip").count(), 8);
  await page.screenshot({ path: join(artifacts, "dashboard.png") });

  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#panel.open");
  await page.waitForSelector("#panel .screen:not(:empty)");
  assert.equal(await page.locator("#panel h2.title").innerText(), "Needs approval");
  assert.match(await page.locator("#panel .screen").innerText(), /<b>bold\?<\/b>/);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator("svg g.node.thread.selected").count(), 1);
  await page.screenshot({ path: join(artifacts, "panel.png") });

  await page.keyboard.press("Escape");
  await page.selectOption("#f-state", "working");
  assert.equal(await page.locator("svg g.node.thread").count(), 1);
  await page.selectOption("#f-state", "");
  await page.fill("#f-search", "widget");
  await waitFor(async () => (await page.locator("svg g.node.thread").count()) === 2, 3000);
  await page.fill("#f-search", "");
  await page.selectOption("#f-project", "beta");
  await waitFor(async () => (await page.locator("svg g.node.thread").count()) === 3, 3000);
  assert.deepEqual(errors, []);
  await page.close();
  // Browsing (including opening a blocked thread's chat) writes nothing.
  assert.deepEqual(since(m0), []);
});

test("phone viewport", async () => {
  // 12
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.waitForTimeout(2000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "no horizontal scroll");
  await page.screenshot({ path: join(artifacts, "phone.png") });
  await page.locator("#needs .chip").first().tap();
  await page.waitForSelector("#panel.open");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(artifacts, "phone-panel.png") });
  await page.close();
});

test("write API runs exactly the allow-listed herdr-projects commands", async () => {
  // 13, 14, 17, 18
  const R = rootDir;
  const hp = `herdr-projects --root ${R}`;
  let m = mark();
  const evil = "ship it $(touch /tmp/hd-pwn) `id`; rm -rf ~ && echo 'x' \"y\"";
  let r = await post("/api/thread/alpha/t-0001/prompt", { text: evil });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(since(m), [`${hp} thread prompt alpha t-0001 --text-file -`, `stdin: ${evil}`]);

  m = mark();
  r = await post("/api/thread/alpha/t-0002/prompt", { text: "go on" });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "agent_blocked");
  assert.match(r.json.error, /^agent_blocked: t-0002 is waiting on a prompt/, "only the command's own message, no paths");
  assert.equal(since(m).length, 2);

  m = mark();
  r = await post("/api/thread/beta/t-0002/prompt", { text: "answer" });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "prompt_unconfirmed");
  await new Promise((res) => setTimeout(res, 1500));
  assert.deepEqual(since(m), [`${hp} thread prompt beta t-0002 --text-file -`, "stdin: answer"], "not resent");

  const cases = [
    ["/api/thread/alpha/t-0002/keys", { keys: ["2", "enter"] }, `${hp} thread keys alpha t-0002 2 enter`],
    ["/api/thread/alpha/t-0002/keys", { keys: ["enter"], text: "-- other answer; $(x)" }, `${hp} thread keys alpha t-0002 enter --text=-- other answer; $(x)`],
    ["/api/thread/alpha/t-0002/keys", { keys: ["esc", "up", "down", "tab"] }, `${hp} thread keys alpha t-0002 esc up down tab`],
    ["/api/thread/alpha/t-0003/ack", {}, `${hp} thread ack alpha t-0003`],
    ["/api/thread/alpha/t-0003/next", { line: 1 }, `${hp} thread next alpha t-0003 --line 1`],
    ["/api/thread/alpha/t-0006/resolve", { confirm: "alpha/t-0006" }, `${hp} thread resolve alpha t-0006`],
  ];
  for (const [path, body, want] of cases) {
    m = mark();
    r = await post(path, body);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.json)}`);
    assert.deepEqual(since(m), [want]);
  }

  m = mark();
  r = await post("/api/project/alpha/coordinator", { text: "status?\nand more" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(since(m), [`${hp} coordinator prompt alpha --text-file -`, "stdin: status?\\nand more"]);

  m = mark();
  r = await post("/api/ack", { threads: ["alpha/t-0003", "alpha/t-0006", "beta/t-0001"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x) => [x.key, x.ok]), [["alpha/t-0003", true], ["alpha/t-0006", true], ["beta/t-0001", false]]);
  assert.match(r.json.results[2].error, /stub refuses/);
  assert.deepEqual(since(m), [`${hp} thread ack alpha t-0003`, `${hp} thread ack alpha t-0006`, `${hp} thread ack beta t-0001`]);
});

test("write API rejects injection, bad input, GET, CSRF", async () => {
  // 15, 16, 18
  const m = mark();
  const bad = [
    ["/api/thread/alpha%3Bid/t-0001/ack", {}, 400],
    ["/api/thread/..%2f..%2fetc/t-0001/ack", {}, 400],
    ["/api/thread/alpha/t-0001%20--root%20%2F/ack", {}, 400],
    ["/api/thread/-alpha/t-0001/ack", {}, 400],
    ["/api/thread/alpha/t-0999/ack", {}, 404],
    ["/api/thread/alpha/t-0002/keys", { keys: ["enter;ls"] }, 400],
    ["/api/thread/alpha/t-0002/keys", { keys: ["--root"] }, 400],
    ["/api/thread/alpha/t-0002/keys", { keys: ["ctrl+c"] }, 400],
    ["/api/thread/alpha/t-0002/keys", { keys: [] }, 400],
    ["/api/thread/alpha/t-0002/keys", { keys: ["enter"], text: "a\nrm -rf ~" }, 400],
    ["/api/thread/alpha/t-0002/keys", { keys: ["enter"], text: "a\u001b[2J" }, 400],
    ["/api/thread/alpha/t-0002/keys", { keys: Array(20).fill("up") }, 400],
    ["/api/thread/alpha/t-0001/prompt", { text: "   " }, 400],
    ["/api/thread/alpha/t-0001/prompt", { text: "x".repeat(20000) }, 400],
    ["/api/thread/alpha/t-0001/prompt", "not json", 400],
    ["/api/thread/alpha/t-0003/next", { line: 0 }, 400],
    ["/api/thread/alpha/t-0003/next", { line: "1; rm" }, 400],
    ["/api/thread/alpha/t-0006/resolve", {}, 400],
    ["/api/thread/alpha/t-0006/resolve", { confirm: "alpha/t-0003" }, 400],
    ["/api/thread/alpha/t-0001/rm", {}, 404],
    ["/api/project/al%20pha/coordinator", { text: "x" }, 400],
    ["/api/ack", { threads: ["alpha/t-0003", "alpha/t-0003 --root /"] }, 400],
    ["/api/ack", { threads: [] }, 400],
  ];
  for (const [path, body, want] of bad) {
    const r = await post(path, body);
    assert.equal(r.status, want, `${path} ${JSON.stringify(body).slice(0, 80)} -> ${r.status}`);
  }
  let r = await fetch(base + "/api/thread/alpha/t-0003/ack");
  assert.equal(r.status, 405, "GET mutation");
  r = await fetch(base + "/api/thread/alpha/t-0003/ack", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(r.status, 415, "form-able content type");
  r = await post("/api/thread/alpha/t-0003/ack", {}, { headers: { Origin: "http://evil.example" } });
  assert.equal(r.status, 403, "foreign origin");
  assert.deepEqual(since(m), [], "nothing reached herdr-projects");
});

test("screen stream delivers the pane screen and live status", async () => {
  // 21
  const ctrl = new AbortController();
  const r = await fetch(base + "/api/thread/alpha/t-0002/screen", { signal: ctrl.signal });
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const reader = r.body.getReader();
  let buf = "";
  while (!buf.includes("\n\n")) buf += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  const m = buf.match(/^event: screen\ndata: (.*)\n/);
  assert.ok(m, buf);
  const d = JSON.parse(m[1]);
  assert.match(d.screen, /screen of w1B:p1/);
  assert.match(d.screen, /LAST LINE of w1B:p1\n?$/, "32: newest line, even when the pane is scrolled up");
  assert.equal(d.live_status, "blocked");
});

test("page: chat, quick replies, triage strip, bulk ack, toasts", async () => {
  // 17, 18, 20, 21
  const R = rootDir;
  const hp = `herdr-projects --root ${R}`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.waitForSelector("#needs .chip");

  // Grouped by severity with counts.
  const groups = await page.locator("#needs .group").evaluateAll((gs) => gs.map((g) => [g.dataset.state, g.querySelector(".group-head .n").textContent]));
  assert.deepEqual(groups, [["blocked", "2"], ["waiting", "2"], ["review", "3"], ["landing", "1"]]);
  // Acked filter: show all reveals alpha/t-0007, "acked/snoozed" shows only it.
  await page.selectOption("#needs-filter", "all");
  await page.waitForSelector('#needs .chip[data-key="alpha/t-0007"]');
  await page.selectOption("#needs-filter", "parked");
  assert.deepEqual(await page.locator("#needs .chip").evaluateAll((cs) => cs.map((c) => c.dataset.key)), ["alpha/t-0007"]);
  await page.selectOption("#needs-filter", "active");
  // Collapse review.
  await page.locator('#needs .group[data-state="review"] .group-head').click();
  assert.equal(await page.locator('#needs .group[data-state="review"] .chip').count(), 0);
  await page.locator('#needs .group[data-state="review"] .group-head').click();
  assert.equal(await page.locator('#needs .group[data-state="review"] .chip').count(), 3);

  // Blocked thread: quick replies, typed answer goes through `thread keys`.
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#p-chat .screen:not(:empty)");
  await page.waitForSelector('#p-chat .quick button[data-key="1"]');
  let m = mark();
  await page.locator('#p-chat .quick button[data-key="1"]').click();
  await waitFor(() => since(m).includes(`${hp} thread keys alpha t-0002 1`), 4000);
  m = mark();
  await page.fill("#chat-input", "use the second option");
  await page.click("#chat-send");
  await waitFor(() => since(m).includes(`${hp} thread keys alpha t-0002 enter --text=use the second option`), 4000);
  await page.screenshot({ path: join(artifacts, "chat-blocked.png") });

  // The thread panel links to its project's coordinator panel.
  await page.click("#open-coord");
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Alpha Project", 3000);
  await page.keyboard.press("Escape");

  // Working thread: follow-up prompt via stdin.
  await page.selectOption("#f-state", "");
  await page.evaluate(() => document.querySelector('svg g.node[data-key="alpha/t-0001"]').dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForSelector("#panel.open #chat-input");
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Widget pipeline", 3000);
  assert.equal(await page.locator("#p-chat .quick").isVisible(), false, "no quick replies when not blocked");
  m = mark();
  await page.fill("#chat-input", "please also update the docs");
  await page.keyboard.press("Control+Enter");
  await waitFor(() => since(m).includes("stdin: please also update the docs"), 4000);
  await page.waitForSelector("#chat-log .msg.ok");

  // prompt_unconfirmed is shown with a manual Enter button and never resent.
  await page.locator('#needs .chip[data-key="beta/t-0002"]').click();
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Question for you", 3000);
  m = mark();
  await page.fill("#chat-input", "yes do it");
  await page.click("#chat-send");
  await page.waitForSelector("#chat-log .msg.warn");
  assert.match(await page.locator("#chat-log .msg.warn").innerText(), /not confirmed/i);
  await page.waitForTimeout(1200);
  assert.equal(since(m).filter((l) => l.includes("thread prompt")).length, 1);
  m = mark();
  await page.click("#chat-log .submit-enter");
  await waitFor(() => since(m).includes(`${hp} thread keys beta t-0002 enter`), 4000);

  // Next line + Ack from the panel (optimistic: chip leaves the strip).
  await page.locator('#needs .chip[data-key="alpha/t-0003"]').click();
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Widget shipped", 3000);
  await page.waitForSelector("#p-next li button.send");
  m = mark();
  await page.locator("#p-next li button.send").first().click();
  await waitFor(() => since(m).includes(`${hp} thread next alpha t-0003 --line 1`), 4000);
  m = mark();
  await page.click('#p-actions button[data-act="ack"]');
  await waitFor(async () => (await page.locator('#needs .chip[data-key="alpha/t-0003"]').count()) === 0, 2000);
  await waitFor(() => since(m).includes(`${hp} thread ack alpha t-0003`), 4000);

  // Resolve needs the dialog: cancel runs nothing, confirm runs it.
  await page.locator('#needs .chip[data-key="alpha/t-0006"]').click();
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Docs refresh", 3000);
  m = mark();
  await page.click('#p-actions button[data-act="resolve"]');
  await page.waitForSelector("#dlg[open]");
  assert.match(await page.locator("#dlg-msg").innerText(), /worktree/);
  await page.screenshot({ path: join(artifacts, "resolve-confirm.png") });
  await page.click("#dlg-cancel");
  await page.waitForTimeout(300);
  assert.deepEqual(since(m), []);
  await page.click('#p-actions button[data-act="resolve"]');
  await page.click("#dlg-ok");
  await waitFor(() => since(m).includes(`${hp} thread resolve alpha t-0006`), 4000);
  await waitFor(async () => (await page.locator('#needs .chip[data-key="alpha/t-0006"]').count()) === 0, 2000);
  await page.keyboard.press("Escape");

  // Multi-select + bulk ack; the refused one reverts and shows a toast.
  await page.click("#select-mode");
  await page.locator('#needs .chip[data-key="beta/t-0001"]').click();
  assert.equal(await page.locator("#panel.open").count(), 0, "select mode does not open the panel");
  await page.locator('#needs .chip[data-key="hub:beta"]').click();
  assert.match(await page.locator("#bulk-ack").innerText(), /\(1\)/, "a coordinator cannot be picked for ack");
  await page.locator('#needs .chip[data-key="beta/t-0002"]').click();
  assert.match(await page.locator("#bulk-ack").innerText(), /2/);
  m = mark();
  await page.click("#bulk-ack");
  await waitFor(() => since(m).includes(`${hp} thread ack beta t-0001`) && since(m).includes(`${hp} thread ack beta t-0002`), 4000);
  await page.waitForSelector("#toasts .toast.err");
  assert.match(await page.locator("#toasts .toast.err").first().innerText(), /beta\/t-0001/);
  await waitFor(async () => (await page.locator('#needs .chip[data-key="beta/t-0001"]').count()) === 1, 3000);
  await page.screenshot({ path: join(artifacts, "triage.png") });
  await page.click("#select-mode");

  // Ack all ready-for-review, scoped to a project, behind a confirm.
  await page.selectOption("#needs-filter", "all");
  m = mark();
  await page.click("#ack-all");
  await page.waitForSelector("#dlg[open]");
  await page.selectOption("#ack-all-project", "beta");
  assert.match(await page.locator("#dlg-msg").innerText(), /\b1\b/);
  await page.click("#dlg-ok");
  // Only beta's unacked review thread: not alpha's, not landing/waiting ones.
  await waitFor(() => since(m).length > 0, 4000);
  await page.waitForTimeout(500);
  assert.deepEqual(since(m), [`${hp} thread ack beta t-0003`]);

  assert.deepEqual(errors, []);
  await page.close();
});

test("phone: chat panel fits", async () => {
  // 12, 21
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(base + "/");
  await page.waitForSelector('#needs .chip[data-key="alpha/t-0002"]');
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').tap();
  await page.waitForSelector('#p-chat .quick button[data-key="1"]');
  await page.locator("#p-chat").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  await page.screenshot({ path: join(artifacts, "phone-chat.png") });
  await page.close();
});

test("API: coordinators come from herdr-projects' records, checked against live panes", async () => {
  // 23, 24, 25
  const s = await getJSON("/api/state");
  const p = Object.fromEntries(s.projects.map((x) => [x.slug, x]));
  const a = p.alpha.coordinator, b = p.beta.coordinator, g = p.gamma.coordinator;
  assert.equal(a.pane_id, "w1Z:p1");
  assert.equal(a.tab_id, "w1Z:t1");
  assert.equal(a.agent, "claude");
  assert.equal(a.live_status, "done");
  assert.equal(a.state, "waiting", "herdr-projects says needs you");
  assert.equal(a.needs_you, true);
  assert.equal(a.activity, "needs you · ~35%");
  assert.equal(a.last_activity, "2026-10-03T09:00:00Z");
  // beta: no ticker list, the open record's pane runs in the project folder.
  assert.equal(b.pane_id, "w2Z:p1");
  assert.equal(b.state, "blocked");
  assert.equal(b.needs_you, true);
  // gamma: stale entry (pane gone) and a record whose pane runs elsewhere.
  assert.equal(g.pane_id, "");
  assert.equal(g.state, "none");
  assert.equal(g.needs_you, false);
  assert.equal(p.gamma.status, "paused");
  assert.equal(p.alpha.inbox, 2, "open inbox items only, not done/");
  assert.equal(p.beta.inbox, 0);
});

test("API: coordinator detail renders files, settings, progress and jump commands", async () => {
  // 25, 26
  const d = await getJSON("/api/project/alpha");
  writeFileSync(join(artifacts, "project-alpha.json"), JSON.stringify(d, null, 2));
  assert.match(d.tasks_html, /<strong>widget<\/strong>/);
  assert.doesNotMatch(d.tasks_html, /<script/i);
  assert.doesNotMatch(d.tasks_html, /javascript:/i);
  assert.match(d.memory_html, /Release flow/);
  assert.equal(d.goal, "Ship the alpha thing");
  assert.equal(d.settings.thread_profile, "codex-high");
  assert.equal(d.settings.coordinator_profile, "claude");
  assert.equal(d.settings.max_parallel_threads, "4");
  assert.equal(d.settings.repos, "1");
  assert.equal(d.safety, "yolo on · start threads auto (yolo) · trust screens coordinator (follows yolo)");
  assert.equal(d.progress.activity, "Waiting for you");
  assert.equal(d.progress.percent, 35);
  assert.equal(d.progress.reported_at, "2026-10-04T08:00:00Z");
  assert.match(d.screen, /screen of w1Z:p1/);
  assert.deepEqual(d.jump.map((j) => j.command), [
    "herdr agent focus w1Z:p1",
    "herdr tab focus w1Z:t1",
    `${join(stub, "herdr-projects")} open alpha`,
  ]);

  // 33: newest report first, sanitized.
  assert.deepEqual(d.reports.map((r) => [r.id, r.title, r.time]), [
    ["t-0002", "Needs approval", "2026-10-04T10:00:00Z"],
    ["t-0003", "Widget shipped", "2026-10-02T10:00:00Z"],
  ]);
  assert.equal(d.reports[0].state, "blocked");
  assert.doesNotMatch(d.reports[0].html, /<script|javascript:/i);

  const g = await getJSON("/api/project/gamma");
  assert.equal(g.screen, "");
  assert.equal(g.progress, null);
  assert.equal(g.safety, "", "safety show failing leaves it blank");
  assert.deepEqual(g.jump.map((j) => j.label), ["Open the project coordinator"]);

  assert.equal((await fetch(base + "/api/project/nope")).status, 404);
  assert.equal((await fetch(base + "/api/project/-x")).status, 400);
});

test("coordinator screen stream: live pane, and none for an unidentified one", async () => {
  // 23, 27
  const first = async (path) => {
    const ctrl = new AbortController();
    const r = await fetch(base + path, { signal: ctrl.signal });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const reader = r.body.getReader();
    let buf = "";
    while (!buf.includes("\n\n")) buf += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    return JSON.parse(buf.match(/^event: screen\ndata: (.*)\n/)[1]);
  };
  const a = await first("/api/project/alpha/screen");
  assert.match(a.screen, /screen of w1Z:p1/);
  assert.equal(a.live_status, "done");
  assert.equal(a.pane_alive, true);
  const g = await first("/api/project/gamma/screen");
  assert.deepEqual(g, { screen: "", live_status: "", pane_alive: false });
  assert.equal((await fetch(base + "/api/project/nope/screen")).status, 404);
});

test("page: hub opens the coordinator panel with chat, threads, tasks and memory", async () => {
  // 22, 24, 26, 27, 28, 29, 30
  const hp = `herdr-projects --root ${rootDir}`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.hub");

  // 24: coordinators in the strip, in their severity group.
  await page.waitForSelector('#needs .group[data-state="blocked"] .chip.coord[data-key="hub:beta"]');
  await page.waitForSelector('#needs .group[data-state="waiting"] .chip.coord[data-key="hub:alpha"]');
  assert.equal(await page.locator('#needs .chip[data-key="hub:gamma"]').count(), 0);

  // 22: clicking the hub opens its panel (and does not filter the graph).
  await page.evaluate(() => document.querySelector('svg g.node[data-key="hub:alpha"]').dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForSelector("#panel.open");
  assert.equal(await page.locator("#panel h2.title").innerText(), "Alpha Project");
  assert.equal(await page.locator("svg g.node.thread").count(), 10, "no filter applied");
  assert.equal(await page.locator("svg g.node.hub.selected").count(), 1);
  await page.waitForSelector("#p-chat .screen:not(:empty)");
  assert.match(await page.locator("#p-chat .screen").innerText(), /screen of w1Z:p1/);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  const head = await page.locator("#p-head").innerText();
  assert.match(head, /Waiting on you/);
  await waitFor(async () => /Waiting for you/.test(await page.locator("#p-head").innerText()), 3000);
  const meta = await page.locator("#p-meta").innerText();
  for (const want of [/alpha/, /Ship the alpha thing/, /active/, /claude · pane w1Z:p1/, /done/, /codex-high/, /\b4\b/, /yolo on/, /Inbox\s+2/]) assert.match(meta, want);
  // Viewer's local time, like the thread panel.
  const local = await page.evaluate(() => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date("2026-10-03T09:00:00Z")));
  assert.ok(meta.includes(local), `${local} in ${meta}`);
  await page.waitForSelector("#p-tasks strong");
  assert.equal(await page.locator("#p-tasks script").count(), 0);
  assert.equal(await page.locator("#p-memory").evaluate((d) => d.tagName === "DETAILS" && !d.open), true, "memory collapsed");
  assert.match(await page.locator("#p-memory").innerText(), /memory index/i);
  assert.match(await page.locator("#p-jump").innerText(), /herdr agent focus w1Z:p1/);
  // 29: send only, no key buttons.
  assert.equal(await page.locator("#p-chat .quick").count(), 0);
  assert.match(await page.locator("#p-chat .note").innerText(), /only send/i);
  // Open threads: 6 not resolved.
  assert.equal(await page.locator("#p-threads li").count(), 6);
  await page.screenshot({ path: join(artifacts, "coordinator.png") });

  // 28: send through stdin; then the screen stream reads fast.
  let m = mark();
  const evil = "status? $(id) `x`; ok";
  await page.fill("#coord-input", evil);
  await page.keyboard.press("Control+Enter");
  // The stub logs the command, then its stdin: wait for both lines.
  await waitFor(() => since(m).includes(`stdin: ${evil}`), 4000);
  assert.deepEqual(since(m), [`${hp} coordinator prompt alpha --text-file -`, `stdin: ${evil}`]);
  await page.waitForSelector("#chat-log .msg.ok");
  assert.equal(await page.locator("#coord-input").inputValue(), "");
  const reads = () => logLines().filter((l) => l === "herdr pane read w1Z:p1 --source recent --lines 60").length;
  const r0 = reads();
  await page.waitForTimeout(2500);
  assert.ok(reads() - r0 >= 2, `fast refresh after send: ${reads() - r0} reads in 2.5s`);

  // 33: thread reports, newest first, collapsed, click-through.
  assert.deepEqual(await page.locator("#p-reports details").evaluateAll((ds) => ds.map((d) => [d.dataset.key, d.open])), [["alpha/t-0002", false], ["alpha/t-0003", false]]);
  const sum = await page.locator("#p-reports details").first().locator("summary").innerText();
  assert.match(sum, /Needs approval/);
  assert.match(sum, /t-0002/);
  await page.locator("#p-reports details").nth(1).locator("summary").click();
  await page.waitForSelector("#p-reports details[open] li code");
  await page.locator("#p-reports details").nth(1).locator("button.open-thread").click();
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Widget shipped", 3000);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector('svg g.node[data-key="hub:alpha"]').dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Alpha Project", 3000);

  // 30: an open thread opens its panel.
  await page.locator('#p-threads li[data-key="alpha/t-0002"] button').click();
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Needs approval", 3000);

  // 28: beta is blocked: the refusal is shown with the note, nothing resent.
  await page.locator('#needs .chip[data-key="hub:beta"]').click();
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Beta", 3000);
  await page.waitForSelector("#p-chat .note.warn");
  m = mark();
  await page.fill("#coord-input", "hello");
  await page.click("#coord-send");
  await page.waitForSelector("#chat-log .msg.err");
  assert.match(await page.locator("#chat-log .msg.err").innerText(), /can take a prompt/);
  await page.waitForTimeout(800);
  assert.equal(since(m).filter((l) => l.includes("coordinator prompt")).length, 1);
  assert.equal(await page.locator("#coord-input").inputValue(), "hello", "kept for a retry");

  // 23: gamma has no identifiable pane.
  await page.selectOption("#f-project", "");
  await page.evaluate(() => document.querySelector('svg g.node[data-key="hub:gamma"]').dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Gamma (broken)", 3000);
  await page.waitForSelector("#p-chat .no-pane");
  assert.match(await page.locator("#p-chat").innerText(), /no live pane/i);
  assert.match(await page.locator("#p-meta").innerText(), /paused/);
  assert.equal(await page.locator("#p-head").innerText(), "No live pane", "no stray text when there is no activity");

  // 27: closed panel, no coordinator screen reads.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const c0 = reads();
  await page.waitForTimeout(4000);
  assert.equal(reads(), c0, "no coordinator screen reads while closed");

  assert.deepEqual(errors, []);
  await page.close();
});

test("live screens show the newest line and stay pinned to the bottom", async () => {
  // 32, 34
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + "/");
  await page.waitForSelector('#needs .chip[data-key="alpha/t-0002"]');
  const box = () => page.locator("#p-chat .screen").evaluate((s) => {
    const r = s.getBoundingClientRect();
    return { last: s.textContent.split("\n").pop(), pinned: s.scrollTop + s.clientHeight >= s.scrollHeight - 2, top: s.scrollTop, n: +s.dataset.n, inView: r.bottom <= innerHeight + 1 };
  });
  for (const [open, pane] of [["alpha/t-0002", "w1B:p1"], ["hub:alpha", "w1Z:p1"]]) {
    await page.locator(`#needs .chip[data-key="${open}"]`).click();
    await page.waitForSelector("#p-chat .screen:not(:empty)");
    let b = await box();
    assert.equal(b.last, `LAST LINE of ${pane}`);
    assert.equal(b.pinned, true, `${open}: pinned to the newest line`);
    // New output keeps it pinned.
    await waitFor(async () => (await box()).n > b.n, 5000);
    assert.equal((await box()).pinned, true, `${open}: still pinned after an update`);
    // A reader who scrolled up is left there (not to the very top, which
    // loads earlier lines)...
    await page.locator("#p-chat .screen").evaluate((s) => (s.scrollTop = Math.floor((s.scrollHeight - s.clientHeight) / 2)));
    b = await box();
    await waitFor(async () => (await box()).n > b.n, 5000);
    assert.equal((await box()).top, b.top, `${open}: not yanked down`);
    // ...until they scroll back to the bottom.
    await page.locator("#p-chat .screen").evaluate((s) => (s.scrollTop = s.scrollHeight));
    b = await box();
    await waitFor(async () => (await box()).n > b.n, 5000);
    assert.equal((await box()).pinned, true);
    await page.locator("#p-chat .screen").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, `screen-bottom-${open.replace(/[:/]/g, "-")}.png`) });
  }

  // 34: the thread report sits collapsed below the chat and Next.
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#p-report-box summary .preview:not(:empty)");
  const order = await page.evaluate(() => {
    const ids = ["p-chat", "p-next", "p-report-box"].map((id) => document.getElementById(id));
    return ids.every((e, i) => i === 0 || (ids[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  assert.equal(order, true, "chat, then Next, then the report");
  assert.equal(await page.locator("#p-report-box").evaluate((d) => d.tagName === "DETAILS" && !d.open), true);
  assert.match(await page.locator("#p-report-box summary .preview").innerText(), /Blocked on a permission prompt/);
  await page.locator("#p-report-box summary").click();
  assert.match(await page.locator("#p-report").innerText(), /Blocked on a permission prompt/);
  await page.close();
});

test("scrollback: live tails merge into a long buffer, earlier lines load on scroll up, capped", async () => {
  // 41-46
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem("hd-dock", JSON.stringify({ pos: "right", bottom: 600 })));
  await page.goto(base + "/");
  await page.waitForSelector('#needs .chip[data-key="alpha/t-0002"]');
  const scr = () => page.locator("#p-chat .screen");
  const box = () => scr().evaluate((s) => {
    const lh = parseFloat(getComputedStyle(s).lineHeight), pad = parseFloat(getComputedStyle(s).paddingTop);
    return {
      lines: s.textContent.split("\n"), n: +s.dataset.n, top: s.scrollTop, h: s.clientHeight,
      pinned: s.scrollTop + s.clientHeight >= s.scrollHeight - 2,
      // Index of the line at the top edge of the box.
      at: Math.round((s.scrollTop - pad) / lh),
    };
  });
  const nums = (ls) => ls.map((l) => l.match(/^scrollback line (\d+)$/)).filter(Boolean).map((m) => +m[1]);
  const contiguous = (ns) => ns.length > 0 && ns.every((n, i) => i === 0 || n === ns[i - 1] + 1);
  const clean = (ls, pane) => {
    // One copy of the tail region, newest line last: nothing garbled.
    assert.ok(contiguous(nums(ls)), "history lines contiguous, no duplicates");
    assert.equal(ls.filter((l) => /^clock /.test(l)).length, 1, "one clock line");
    assert.equal(ls.filter((l) => l === `screen of ${pane}`).length, 1);
    assert.equal(ls.at(-1), `LAST LINE of ${pane}`);
  };
  const historyReads = (pane) => logLines().filter((l) => l.startsWith(`herdr pane read ${pane} `))
    .map((l) => +l.match(/--lines (\d+)/)[1]).filter((n) => n > 60);

  const h0 = historyReads("w1B:p1").length;
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#p-chat .screen:not(:empty)");
  let b = await box();
  const first = nums(b.lines);
  clean(b.lines, "w1B:p1");
  assert.ok(first.length <= 60, "the live stream stays small");
  assert.equal(historyReads("w1B:p1").length, h0, "no history read before scrolling up");

  // 41: three updates later the buffer holds more than one live tail, and
  // the lines that scrolled out of it are still there, once.
  await waitFor(async () => (await box()).n >= b.n + 3, 15000);
  b = await box();
  clean(b.lines, "w1B:p1");
  assert.equal(nums(b.lines)[0], first[0], "older lines kept");
  assert.ok(nums(b.lines).length > first.length, "buffer grew past the live tail");

  // 46: the box uses the side dock's height, not a fixed 340px.
  assert.ok(b.h >= 450, `tall box in the side dock (${b.h}px)`);

  // 45: scrolled up a bit, updates do not move the reader; a jump button
  // appears and takes them to the newest line.
  await scr().evaluate((s) => (s.scrollTop = Math.floor((s.scrollHeight - s.clientHeight) / 2)));
  b = await box();
  await page.waitForSelector("#p-chat .new-output:not([hidden])", { timeout: 8000 });
  assert.equal((await box()).top, b.top, "not yanked down");
  await page.locator("#p-chat .new-output").click();
  await waitFor(async () => (await box()).pinned, 3000);
  assert.equal(await page.locator("#p-chat .new-output").isHidden(), true);

  // 43: at the top, earlier lines are fetched and prepended, and the line
  // the reader was looking at stays put.
  b = await box();
  const topLine = b.lines[0];
  await scr().evaluate((s) => (s.scrollTop = 0));
  await waitFor(async () => nums((await box()).lines)[0] < nums(b.lines)[0], 8000);
  b = await box();
  clean(b.lines, "w1B:p1");
  assert.ok(Math.abs(b.lines.indexOf(topLine) - b.at) <= 1, `kept place: ${topLine} at ${b.lines.indexOf(topLine)}, top shows ${b.at}`);
  assert.equal(historyReads("w1B:p1")[h0], 200, "first load asks for 200 lines");
  await page.locator("#p-chat .screen").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "scrollback-loaded.png") });

  // ...and again, until the cap.
  for (let i = 0; i < 12; i++) {
    const before = nums((await box()).lines)[0];
    await scr().evaluate((s) => (s.scrollTop = 0));
    if (/last 2000 lines|Start of history/.test(await page.locator("#p-chat .screen-top").innerText())) break;
    await waitFor(async () => nums((await box()).lines)[0] < before ||
      /last 2000 lines/.test(await page.locator("#p-chat .screen-top").innerText()), 8000);
  }
  assert.match(await page.locator("#p-chat .screen-top").innerText(), /last 2000 lines/);
  b = await box();
  clean(b.lines, "w1B:p1");
  assert.ok(b.lines.length <= 2000, `capped buffer (${b.lines.length})`);
  assert.ok(nums(b.lines).length > 1500, "about 2000 lines of history");
  const reads = historyReads("w1B:p1").slice(h0);
  assert.equal(Math.max(...reads), 2000, "never asks past the cap");
  assert.deepEqual(reads, [...reads].sort((x, y) => x - y), "each load asks for more");
  // Sitting at the top with nothing more to load: no more history reads.
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(historyReads("w1B:p1").length, h0 + reads.length, "no polling for history");
  await page.screenshot({ path: join(artifacts, "scrollback-capped.png") });

  // 42: a full-screen redraw replaces the buffer; back to normal, the
  // history is clean again.
  await scr().evaluate((s) => (s.scrollTop = s.scrollHeight));
  writeFileSync(redrawFlag, "");
  try {
    await waitFor(async () => (await box()).lines.some((l) => /^full-screen frame/.test(l)), 8000);
    b = await box();
    assert.deepEqual(nums(b.lines), [], "no history mixed into the frame");
    assert.equal(b.lines.filter((l) => l === "full-screen frame row 1").length, 1);
    assert.match(b.lines.at(-1), /^frame clock /);
  } finally {
    rmSync(redrawFlag, { force: true });
  }
  await waitFor(async () => (await box()).lines.at(-1) === "LAST LINE of w1B:p1", 8000);
  clean((await box()).lines, "w1B:p1");

  // 46: bottom dock, the box fills the chat column's height.
  await page.locator("#dock-bottom").click();
  await page.waitForTimeout(400);
  const fit = await page.evaluate(() => {
    const p = document.getElementById("panel").getBoundingClientRect(), s = document.querySelector("#p-chat .screen").getBoundingClientRect();
    return { ph: p.height, sh: s.height, inside: s.bottom <= p.bottom + 1 };
  });
  assert.ok(fit.inside, "box inside the bottom panel");
  assert.ok(fit.sh >= fit.ph - 210, `box uses the bottom panel's height (${fit.sh} of ${fit.ph})`);
  await page.screenshot({ path: join(artifacts, "scrollback-dock-bottom.png") });
  await page.close();
});

test("history API: capped, cached, one read per pane at a time, refuses unreadable panes", async () => {
  // 44
  const reads = (pane) => logLines().filter((l) => l.startsWith(`herdr pane read ${pane} `) && !/--lines ([1-5]?\d|60)$/.test(l));
  const r0 = reads("w1Z:p1").length;
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => getJSON("/api/project/alpha/history?lines=1000")));
  for (const d of all) {
    assert.equal(d.lines, 1000);
    assert.match(d.screen, /LAST LINE of w1Z:p1$/);
    assert.equal(d.screen.split("\n").length, 1000);
  }
  assert.equal(reads("w1Z:p1").length - r0, 1, "five concurrent requests, one read");
  // A smaller request right after is served from that read.
  const small = await getJSON("/api/project/alpha/history?lines=200");
  assert.equal(small.screen.split("\n").length, 200);
  assert.equal(reads("w1Z:p1").length - r0, 1, "smaller request served from the cache");

  const big = await getJSON("/api/thread/alpha/t-0002/history?lines=999999");
  assert.equal(big.lines, 2000, "capped");
  assert.ok(!logLines().some((l) => /--lines (\d{5,}|[3-9]\d{3}|2\d{3})/.test(l) && !/--lines 2000$/.test(l)), "no read past 2000");
  for (const q of ["lines=abc", "lines=-5", "lines=1e9", "lines=10%20--raw"]) {
    assert.equal((await fetch(base + "/api/thread/alpha/t-0002/history?" + q)).status, 400, q);
  }
  // Unreadable: a pane-less coordinator, a thread with no live pane.
  assert.equal((await getJSON("/api/project/gamma/history?lines=200")).screen, "");
  const s = await getJSON("/api/state");
  const dead = s.threads.find((t) => !t.pane_alive || t.state === "resolved");
  const m = mark();
  const d = await getJSON(`/api/thread/${dead.project}/${dead.id}/history?lines=200`);
  assert.equal(d.screen, "");
  assert.ok(!logLines().slice(m).some((l) => /pane read/.test(l) && dead.pane_id && l.includes(dead.pane_id)), "dead pane not read");
  assert.equal((await fetch(base + "/api/project/nope/history?lines=200")).status, 404);
  assert.equal((await fetch(base + "/api/thread/alpha/t-9999/history?lines=200")).status, 404);
});

test("phone: coordinator panel fits", async () => {
  // 31
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(base + "/");
  await page.waitForSelector('#needs .chip[data-key="hub:alpha"]');
  await page.locator('#needs .chip[data-key="hub:alpha"]').tap();
  await page.waitForSelector("#panel.open #p-chat .screen:not(:empty)");
  await page.waitForTimeout(400);
  const box = await page.locator("#panel").boundingBox();
  assert.ok(box.width <= 390 && box.y > 100, "bottom sheet like the thread panel");
  await page.screenshot({ path: join(artifacts, "phone-coordinator.png") });
  await page.locator("#p-threads").scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || document.querySelector("#panel").scrollWidth > document.querySelector("#panel").clientWidth);
  assert.equal(overflow, false);
  await page.screenshot({ path: join(artifacts, "phone-coordinator-threads.png") });
  await page.close();
});

// Boxes of the stage (graph area) and the panel, after the panel's transition.
async function dockBoxes(page) {
  await page.waitForTimeout(450);
  return page.evaluate(() => {
    const b = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
    return { stage: b("#stage"), panel: b("#panel"), needs: b("#needs-wrap"), filters: b("#filters") };
  });
}
// Every node, and every project name, lies inside the stage once the graph
// has re-fit.
async function nodesInStage(page) {
  return waitFor(() => page.evaluate(() => {
    const s = document.querySelector("#stage").getBoundingClientRect();
    const ns = [...document.querySelectorAll("svg g.node .core, svg text.name")].map((c) => c.getBoundingClientRect());
    return ns.length > 0 && ns.every((n) => n.left >= s.left - 1 && n.right <= s.right + 1 && n.top >= s.top - 1 && n.bottom <= s.bottom + 1);
  }), 4000);
}
const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;

test("desktop: panel docks right, left and bottom; graph area follows; sizes persist", async () => {
  // 35-39
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.waitForTimeout(1500);
  const full = (await dockBoxes(page)).stage;
  assert.ok(near(full.w, 1440), "closed panel takes no room");
  assert.equal(await page.locator("#splitter").isVisible(), false);

  // Right is the default.
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#panel.open");
  assert.equal(await page.locator("#dock-right").getAttribute("aria-pressed"), "true");
  let b = await dockBoxes(page);
  assert.ok(near(b.panel.r, 1440) && near(b.panel.w, 480, 6), `right panel ${JSON.stringify(b.panel)}`);
  assert.ok(near(b.stage.w, 1440 - b.panel.w, 8) && b.stage.r <= b.panel.x + 1, "graph shrinks beside the panel");
  assert.ok(b.panel.y >= b.filters.b - 1, "needs strip and filters stay uncovered");
  await nodesInStage(page);
  await page.screenshot({ path: join(artifacts, "dock-right.png") });

  // Left.
  await page.locator("#dock-left").click();
  assert.equal(await page.locator("#dock-left").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#dock-right").getAttribute("aria-pressed"), "false");
  b = await dockBoxes(page);
  assert.ok(near(b.panel.x, 0) && near(b.panel.w, 480, 6), `left panel ${JSON.stringify(b.panel)}`);
  assert.ok(b.stage.x >= b.panel.r - 1 && near(b.stage.r, 1440), "graph to the right of the panel");
  await nodesInStage(page);
  await page.screenshot({ path: join(artifacts, "dock-left.png") });

  // Bottom: full width, ~40% high, chat beside the details.
  await page.locator("#dock-bottom").click();
  b = await dockBoxes(page);
  assert.ok(near(b.panel.x, 0) && near(b.panel.w, 1440) && near(b.panel.b, 900), `bottom panel ${JSON.stringify(b.panel)}`);
  assert.ok(near(b.panel.h, 360, 8), `default height ~40% of the viewport: ${b.panel.h}`);
  assert.ok(near(b.stage.w, 1440) && b.stage.b <= b.panel.y + 1 && b.stage.y >= b.filters.b - 1, "graph above the panel");
  await nodesInStage(page);
  const chat = await page.locator("#p-chat").boundingBox();
  const meta = await page.locator("#p-meta").boundingBox();
  assert.ok(chat.x >= meta.x + meta.width - 1 && chat.y < meta.y + meta.height, "chat in a column beside the details");
  await page.screenshot({ path: join(artifacts, "dock-bottom.png") });
  // The strip stays usable with the panel open.
  await page.locator('#needs .chip[data-key="hub:alpha"]').click();
  await waitFor(async () => (await page.locator("#panel h2.title").innerText()) === "Alpha Project", 3000);
  await page.screenshot({ path: join(artifacts, "dock-bottom-coordinator.png") });

  // Splitter: drag the bottom panel 100px taller.
  const drag = async (dx, dy) => {
    const s = await page.locator("#splitter").boundingBox();
    const x = s.x + s.width / 2, y = s.y + s.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up();
  };
  await drag(0, -100);
  b = await dockBoxes(page);
  assert.ok(near(b.panel.h, 460, 8), `dragged height ${b.panel.h}`);
  assert.ok(b.stage.b <= b.panel.y + 1);
  await nodesInStage(page);
  // Limits: cannot swallow the graph or vanish.
  await drag(0, -2000);
  b = await dockBoxes(page);
  assert.ok(b.stage.h >= 120 && b.panel.h <= 0.85 * 900, `max height ${b.panel.h}`);
  await drag(0, 2000);
  b = await dockBoxes(page);
  assert.ok(b.panel.h >= 150 && b.panel.h < 300, `min height ${b.panel.h}`);
  await drag(0, -300);
  const bottomH = (await dockBoxes(page)).panel.h;

  // Sizes are per position: right still has its default, then resize it.
  await page.locator("#dock-right").click();
  b = await dockBoxes(page);
  assert.ok(near(b.panel.w, 480, 6), `right keeps its own size ${b.panel.w}`);
  await drag(-120, 0);
  b = await dockBoxes(page);
  assert.ok(near(b.panel.w, 600, 8), `dragged width ${b.panel.w}`);
  assert.ok(near(b.stage.w, 1440 - b.panel.w, 8));
  await drag(2000, 0);
  b = await dockBoxes(page);
  assert.ok(b.panel.w >= 300, `min width ${b.panel.w}`);
  await drag(-3000, 0);
  b = await dockBoxes(page);
  assert.ok(b.stage.w >= 240, `max width leaves graph room: ${b.stage.w}`);
  await drag(1000, 0); // back to something sane
  const rightW = (await dockBoxes(page)).panel.w;

  // Esc closes and the graph takes the room back.
  await page.keyboard.press("Escape");
  b = await dockBoxes(page);
  assert.equal(await page.locator("#panel.open").count(), 0);
  assert.ok(near(b.stage.w, 1440) && near(b.stage.b, 900), "graph regains the space");
  assert.equal(await page.locator("#splitter").isVisible(), false);
  await nodesInStage(page);

  // Persistence: dock and per-position sizes survive a reload.
  await page.locator("#dock-bottom").evaluate((e) => e.click()); // control works while closed too
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await page.waitForSelector("#panel.open");
  assert.equal(await page.locator("#dock-bottom").getAttribute("aria-pressed"), "true");
  b = await dockBoxes(page);
  assert.ok(near(b.panel.h, bottomH, 3) && near(b.panel.w, 1440), `bottom persisted ${b.panel.h} vs ${bottomH}`);
  await page.locator("#dock-right").click();
  b = await dockBoxes(page);
  assert.ok(near(b.panel.w, rightW, 3), `right persisted ${b.panel.w} vs ${rightW}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("phone: bottom sheet and no dock control, whatever the saved dock", async () => {
  // 40
  for (const pos of ["left", "bottom"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.addInitScript((p) => localStorage.setItem("hd-dock", JSON.stringify({ pos: p, left: 700, bottom: 600 })), pos);
    await page.goto(base + "/");
    await page.waitForSelector("svg g.node.thread");
    await page.locator('#needs .chip[data-key="alpha/t-0002"]').tap();
    await page.waitForSelector("#panel.open");
    const b = await dockBoxes(page);
    assert.ok(b.panel.w <= 390 && b.panel.y > 100 && near(b.panel.b, 844), `sheet (${pos}) ${JSON.stringify(b.panel)}`);
    assert.ok(near(b.stage.w, 390), "sheet overlays, graph keeps its width");
    assert.equal(await page.locator("#dock").isVisible(), false, "no dock control on phones");
    assert.equal(await page.locator("#splitter").isVisible(), false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({ path: join(artifacts, `phone-dock-${pos}.png`) });
    await page.close();
  }
});

test("writes are rate limited", async () => {
  // 19: a second instance with a tiny bucket.
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const s2 = startServer(port, ["--write-burst", "3", "--write-per-min", "6"]);
  try {
    await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await post("/api/thread/alpha/t-0003/ack", {}, { url })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429, 429]);
  } finally {
    s2.kill();
  }
});

test("only allow-listed commands were run", () => {
  // 9, 13
  const allowed = [
    /^herdr-projects --root \S+ list$/,
    /^herdr-projects --root \S+ thread list \S+ --json$/,
    /^herdr pane list$/,
    /^herdr pane read \S+ --source recent --lines \d+$/,
    /^gh pr list --repo \S+ --state all --limit \d+ --json number,url,state,headRefName$/,
    // Writes, through herdr-projects only:
    /^herdr-projects --root \S+ thread prompt [a-z]+ t-\d{4} --text-file -$/,
    /^herdr-projects --root \S+ thread keys [a-z]+ t-\d{4}( (enter|esc|up|down|left|right|tab|space|backspace|y|n|\d))+( --text=.*)?$/,
    /^herdr-projects --root \S+ thread (ack|resolve) [a-z]+ t-\d{4}$/,
    /^herdr-projects --root \S+ thread next [a-z]+ t-\d{4} --line \d+$/,
    /^herdr-projects --root \S+ coordinator prompt [a-z]+ --text-file -$/,
    /^herdr-projects --root \S+ progress --pane w\w+:p\w+$/,
    /^herdr-projects --root \S+ safety show [a-z]+$/,
    /^stdin: /,
  ];
  const calls = logLines();
  assert.ok(calls.length > 3);
  for (const c of calls) assert.ok(allowed.some((re) => re.test(c)), `unexpected command: ${c}`);
  assert.ok(!calls.some((c) => /^herdr (agent|pane send)/.test(c)), "no raw herdr writes");
  // 23: gamma's stale or foreign panes are never read as its coordinator.
  assert.ok(!calls.some((c) => / (w3Z|w3Y):p1/.test(c)), "no guessed coordinator pane");
  writeFileSync(join(artifacts, "calls.log"), calls.join("\n") + "\n");
});
