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
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
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
writeFileSync(stubLog, "");

// git does not keep mtimes: set the transcript times the test asserts on.
const claudeTranscript = join(td, "claude/-proj/11111111-1111-1111-1111-111111111111.jsonl");
const codexTranscript = join(td, "codex/2026/10/10/rollout-2026-10-10T07-00-00-22222222-2222-2222-2222-222222222222.jsonl");
const claudeTime = new Date(Date.now() - 30_000);
const codexTime = new Date("2026-10-05T10:00:00Z");
utimesSync(claudeTranscript, claudeTime, claudeTime);
utimesSync(codexTranscript, codexTime, codexTime);

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
    env: { ...process.env, STUB_LOG: stubLog, HERDR_DASH_ADDR: `127.0.0.1:${port}`, HERDR_DASH_HERDR_PROJECTS: join(stub, "herdr-projects") },
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
const since = (m) => logLines().slice(m).filter((l) => !/ (list|pane read|pr list)( |$)/.test(l));

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
  // Acked alpha/t-0007 is hidden by default.
  assert.equal(await page.locator("#needs .chip").count(), 6);
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
  assert.deepEqual(groups, [["blocked", "1"], ["waiting", "1"], ["review", "3"], ["landing", "1"]]);
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

  // Coordinator box.
  m = mark();
  await page.fill("#coord-input", "what is next?");
  await page.click("#coord-send");
  await waitFor(() => since(m).includes(`${hp} coordinator prompt alpha --text-file -`), 4000);
  await page.waitForSelector("#p-coord .msg.ok");

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
    /^herdr pane read \S+ --source visible --lines \d+$/,
    /^gh pr list --repo \S+ --state all --limit \d+ --json number,url,state,headRefName$/,
    // Writes, through herdr-projects only:
    /^herdr-projects --root \S+ thread prompt [a-z]+ t-\d{4} --text-file -$/,
    /^herdr-projects --root \S+ thread keys [a-z]+ t-\d{4}( (enter|esc|up|down|left|right|tab|space|backspace|y|n|\d))+( --text=.*)?$/,
    /^herdr-projects --root \S+ thread (ack|resolve) [a-z]+ t-\d{4}$/,
    /^herdr-projects --root \S+ thread next [a-z]+ t-\d{4} --line \d+$/,
    /^herdr-projects --root \S+ coordinator prompt [a-z]+ --text-file -$/,
    /^stdin: /,
  ];
  const calls = logLines();
  assert.ok(calls.length > 3);
  for (const c of calls) assert.ok(allowed.some((re) => re.test(c)), `unexpected command: ${c}`);
  assert.ok(!calls.some((c) => /^herdr (agent|pane send)/.test(c)), "no raw herdr writes");
  writeFileSync(join(artifacts, "calls.log"), calls.join("\n") + "\n");
});
