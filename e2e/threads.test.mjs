// E2E: the Threads view, a structured, colour-coded picture of how each
// project's threads progress, in the coordinator panel, the coordinator
// window, the thread side panel and the phone sheet. The real herdr-dash
// binary runs against a copy of the fixtures with stubbed herdr-projects /
// herdr / gh; the copy adds inbox items of every kind and a queued thread.
// Artifacts: e2e/artifacts/threads-*.png and threads.json.
//
// Ways it could fail, written before it existed:
//  T1. Threads land in the wrong stage, or a stage is missing: blocked and
//      waiting not under Needs you, PR-open threads not under review, a
//      queued (launching) thread shown as idle or working, resolved threads
//      mixed in with open ones instead of a collapsed Done group.
//  T2. State is told by colour alone: chips without a text label.
//  T3. The summary strip miscounts a stage, shows no overall progress, or
//      does not name what is blocked on the user.
//  T4. The timeline shows the whole log at once (the "slop" this replaces),
//      or not newest first, or loses events: inbox items in inbox/ and in
//      inbox/done/, the thread's start, and progress changes seen between
//      thread lists.
//  T5. Unread markers: everything is "new" on a first visit, or a new event
//      does not mark its thread, or reading it (expanding) does not clear
//      the marker, or the read state is lost on reload.
//  T6. The stage filter or search hides the wrong cards, has no way back,
//      or shows nothing without saying why.
//  T7. The report button does not open the rendered report in a window, or
//      renders raw HTML from the report (script, javascript: links).
//  T8. The view is only in one place: missing from the coordinator window,
//      the thread side panel (its own timeline) or the phone sheet, or the
//      phone layout scrolls sideways.
//  T9. It costs CLI calls: the timeline endpoint runs a command, or the page
//      polls it every tick instead of refetching when the snapshot's
//      events_sig changes.
// T10. Live updates rebuild the cards while the user reads, collapsing an
//      expanded timeline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { td, stub, artifacts, startServer, freePort, waitFor } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-threads-"));
const root = join(tmp, "root"), stubDir = join(tmp, "stub"), log = join(tmp, "calls");
let server, base, browser;
const out = {};

const item = (dir, name, kind, subject, created, event, summary) =>
  writeFileSync(join(dir, name), `+++\nid = "${name.slice(0, -3)}"\nkind = "${kind}"\nsubject = "${subject}"\ncreated = "${created}"\nsummary = '${summary}'\nevent = "${event}"\n+++\n`);

before(async () => {
  cpSync(join(td, "root"), root, { recursive: true });
  cpSync(stub, stubDir, { recursive: true });
  writeFileSync(log, "");
  // A queued thread: accepted, no pane yet, its brief not delivered.
  const list = JSON.parse(readFileSync(join(stubDir, "thread-list-alpha.json"), "utf8"));
  list.push({ ...list[4], id: "t-0008", title: "Index the zephyr archive", status: "open", group: "Working", group_token: "working", pane_id: "", tab_id: "", workspace_id: "",
    prompt_pending: true, launch_attempts: 0, percent: 0, activity: "", created: "2026-10-02T11:00:00Z", updated: "2026-10-02T11:00:00Z", last_state_change: "2026-10-02T11:00:00Z" });
  writeFileSync(join(stubDir, "thread-list-alpha.json"), JSON.stringify(list));
  const done = join(root, "alpha", "inbox", "done");
  mkdirSync(done, { recursive: true });
  item(done, "20261001T130000Z-thread-state-t-0003-10.md", "thread-state", "t-0003", "2026-10-01T13:00:00Z", "new report", 't-0003 "Widget shipped" has a new report: first draft');
  item(done, "20261001T140000Z-pr-t-0003-11.md", "pr", "t-0003", "2026-10-01T14:00:00Z", "PR opened", 't-0003 "Widget shipped": pull request state OPEN; 0 comment(s)');
  item(done, "20261001T150000Z-pr-t-0003-12.md", "pr", "t-0003", "2026-10-01T15:00:00Z", "PR checks failing", 't-0003 "Widget shipped": checks failing on lint');
  item(done, "20261001T160000Z-pr-t-0003-13.md", "pr", "t-0003", "2026-10-01T16:00:00Z", "PR updated", 't-0003 "Widget shipped": pull request state OPEN; 2 comment(s)');
  item(done, "20261001T170000Z-pr-t-0004-14.md", "pr", "t-0004", "2026-10-01T17:00:00Z", "PR merged", 't-0004 "Old cleanup": pull request state MERGED');
  item(done, "20261001T170100Z-thread-state-t-0004-15.md", "thread-state", "t-0004", "2026-10-01T17:01:00Z", "resolved", 't-0004 "Old cleanup": resolved (merged)');
  item(done, "20261001T180000Z-thread-state-t-0005-16.md", "thread-state", "t-0005", "2026-10-01T18:00:00Z", "idle", 't-0005 "Parked idea" is now Idle');
  item(done, "20261001T190000Z-thread-state-t-0001-17.md", "thread-state", "t-0001", "2026-10-01T19:00:00Z", "prompted its thread", 't-0001 "Widget pipeline": sent a follow-up');
  item(done, "20261001T200000Z-thread-state-t-0002-18.md", "thread-state", "t-0002", "2026-10-01T20:00:00Z", "waiting on you", 't-0002 "Needs approval" is waiting on you');
  item(done, "20261001T210000Z-thread-state-t-0099-19.md", "thread-state", "t-0099", "2026-10-01T21:00:00Z", "idle", "not a thread of alpha");
  writeFileSync(join(done, "garbage.md"), "no front matter\n");
  const port = await freePort();
  server = startServer(port, log, ["--root", root], { HERDR_DASH_HERDR_PROJECTS: join(stubDir, "herdr-projects") });
  base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await (await fetch(base + "/api/state")).json()).threads.some((t) => t.key === "alpha/t-0008"), 15_000);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "threads.json"), JSON.stringify(out, null, 2));
  rmSync(tmp, { recursive: true, force: true });
});

async function openHub(page, slug = "alpha") {
  await page.goto(base);
  await page.waitForFunction(() => window.hd?.state().threads.length > 0);
  await page.evaluate((s) => window.hd.select("hub:" + s), slug);
  await page.waitForSelector("#panel.open .tv .tv-card");
}
const cardStage = (page) => page.$$eval("#panel .tv .tv-card", (cs) => Object.fromEntries(cs.map((c) => [c.dataset.id, c.closest(".tv-stage").dataset.stage])));

test("timeline endpoint: every inbox item, newest first, no command run (T4, T9)", async () => {
  const mark = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  let tl;
  for (let i = 0; i < 5; i++) tl = await (await fetch(base + "/api/project/alpha/timeline")).json();
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).slice(mark).filter((l) => !/^herdr pane (list|read)/.test(l));
  assert.deepEqual(calls.filter((l) => !/ (list|thread list alpha --json|thread list beta --json|thread list gamma --json|pr list|progress --pane)( |$)/.test(l)), [], "timeline ran a command");
  const t3 = tl.threads["t-0003"].map((e) => e.type);
  // The newest is the fixture's own inbox/ item (no event field: its kind says PR).
  assert.deepEqual(t3, ["pr-updated", "pr-updated", "pr-failing", "pr-opened", "report", "started"]);
  assert.equal(tl.threads["t-0003"][1].text, "pull request state OPEN; 2 comment(s)", "title prefix stripped");
  // Fixture items in inbox/ (YAML-ish front matter) count too.
  assert.ok(tl.threads["t-0002"].some((e) => e.type === "other" || e.type === "blocked"), JSON.stringify(tl.threads["t-0002"]));
  assert.ok(tl.threads["t-0004"].some((e) => e.type === "pr-merged"));
  assert.equal(tl.threads["t-0099"], undefined, "an item of another thread leaked in");
  assert.equal((await fetch(base + "/api/project/nope/timeline")).status, 404);
  assert.equal((await fetch(base + "/api/project/..%2Fx/timeline")).status, 400);
  out.endpoint = { t3 };
});

test("stages, chips with labels, summary strip (T1, T2, T3)", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openHub(page);
  const stages = await cardStage(page);
  assert.equal(stages["t-0002"], "needs");
  assert.equal(stages["t-0003"], "review");
  assert.equal(stages["t-0007"], "review");
  assert.equal(stages["t-0001"], "working");
  assert.equal(stages["t-0008"], "queued");
  assert.equal(stages["t-0005"], "idle");
  assert.equal(stages["t-0004"], "done");
  const order = await page.$$eval("#panel .tv .tv-stage", (s) => s.map((x) => x.dataset.stage));
  assert.deepEqual(order, ["needs", "review", "working", "queued", "idle", "done"]);
  // Done is a collapsed group.
  assert.equal(await page.$eval('#panel .tv .tv-stage[data-stage="done"]', (d) => d.open), false);
  // Every chip has a text label.
  const chips = await page.$$eval("#panel .tv .tv-card .tv-chip", (cs) => cs.map((c) => c.textContent.trim()));
  assert.ok(chips.length >= 8 && chips.every((t) => t.length > 2), JSON.stringify(chips));
  // Summary strip: a count per stage, overall progress, what is blocked on you.
  const counts = await page.$$eval("#panel .tv .tv-sum .tv-count", (b) => Object.fromEntries(b.map((x) => [x.dataset.stage, +x.querySelector(".n").textContent])));
  assert.deepEqual(counts, { needs: 1, review: 3, working: 1, queued: 1, idle: 1, done: 1 });
  assert.match(await page.textContent("#panel .tv .tv-overall"), /\d+%/);
  const blocked = await page.$$eval("#panel .tv .tv-blocked button", (b) => b.map((x) => x.dataset.id));
  assert.deepEqual(blocked, ["t-0002"]);
  // Progress bar from the reported percent, activity beside it.
  assert.equal(await page.$eval('#panel .tv-card[data-id="t-0001"] .tv-bar i', (i) => i.style.width), "40%");
  assert.match(await page.textContent('#panel .tv-card[data-id="t-0001"]'), /Testing changes/);
  // No stray text nodes ("null") among the cards.
  assert.deepEqual(await page.$$eval("#panel .tv-card", (cs) => cs.flatMap((c) => [...c.childNodes].filter((n) => n.nodeType === 3).map((n) => c.dataset.id + ":" + JSON.stringify(n.textContent)))), []);
  await page.screenshot({ path: join(artifacts, "threads-coordinator.png") });
  await page.evaluate(() => document.querySelector("#panel .tv-stage[data-stage=review]").scrollIntoView());
  await page.screenshot({ path: join(artifacts, "threads-view.png") });
  out.counts = counts;
  await page.close();
});

test("timeline collapsed to the latest event, expands newest first (T4, T10)", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openHub(page);
  const card = page.locator('#panel .tv-card[data-id="t-0003"]');
  await card.locator(".tv-latest").waitFor();
  assert.match(await card.locator(".tv-latest").textContent(), /PR update/);
  assert.equal(await card.locator(".tv-events li").count(), 0, "full log shown before expanding");
  await card.locator(".tv-expand").click();
  await page.waitForSelector('#panel .tv-card[data-id="t-0003"] .tv-events li');
  const types = await card.locator(".tv-events li").evaluateAll((l) => l.map((x) => x.dataset.type));
  assert.deepEqual(types, ["pr-updated", "pr-updated", "pr-failing", "pr-opened", "report", "started"]);
  const ats = await card.locator(".tv-events li").evaluateAll((l) => l.map((x) => Date.parse(x.dataset.at)));
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a));
  // Each event has an icon and a text label, not colour alone.
  const labels = await card.locator(".tv-events li").evaluateAll((l) => l.map((x) => [x.querySelector(".tv-ico")?.textContent.trim(), x.querySelector(".tv-ev-label")?.textContent.trim()]));
  assert.ok(labels.every(([i, l]) => i && l), JSON.stringify(labels));
  assert.equal(await card.locator(".tv-expand").getAttribute("aria-expanded"), "true");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "threads-expanded.png") });
  // A live update (new progress) keeps the expanded timeline open.
  const list = JSON.parse(readFileSync(join(stubDir, "thread-list-alpha.json"), "utf8"));
  list.find((t) => t.id === "t-0003").activity = "Addressing review";
  writeFileSync(join(stubDir, "thread-list-alpha.json"), JSON.stringify(list));
  const now = new Date();
  utimesSync(join(root, "alpha", "threads"), now, now);
  await page.waitForFunction(() => document.querySelector('#panel .tv-card[data-id="t-0003"]')?.textContent.includes("Addressing review"), null, { timeout: 15_000 });
  assert.equal(await card.locator(".tv-expand").getAttribute("aria-expanded"), "true", "a live update collapsed the timeline");
  await page.waitForSelector('#panel .tv-card[data-id="t-0003"] .tv-events li[data-type="progress"]', { timeout: 15_000 });
  out.expanded = types;
  await page.close();
});

test("unread markers: quiet first visit, marked by a new event, cleared by reading, kept on reload (T5, T9)", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const tlReqs = [];
  page.on("request", (r) => { if (r.url().includes("/timeline")) tlReqs.push(Date.now()); });
  await openHub(page);
  assert.equal(await page.locator("#panel .tv-card.unread").count(), 0, "first visit marks everything new");
  // Idle: the page does not poll the timeline every tick.
  const n0 = tlReqs.length;
  await sleep(7000);
  out.idleTimelineFetches = tlReqs.length - n0;
  assert.ok(tlReqs.length - n0 <= 1, `timeline fetched ${tlReqs.length - n0} times in 7s idle`);
  // A new event for t-0001.
  item(join(root, "alpha", "inbox", "done"), "20261002T120000Z-thread-state-t-0001-30.md", "thread-state", "t-0001", new Date().toISOString().slice(0, 19) + "Z", "new report", 't-0001 "Widget pipeline" has a new report: halfway');
  await page.waitForSelector('#panel .tv-card[data-id="t-0001"].unread', { timeout: 15_000 });
  assert.match(await page.textContent('#panel .tv-card[data-id="t-0001"] .tv-unread'), /1 new/);
  assert.match(await page.textContent("#panel .tv .tv-sum"), /1 new/);
  await page.locator('#panel .tv-card[data-id="t-0001"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "threads-unread.png") });
  await page.locator('#panel .tv-card[data-id="t-0001"] .tv-expand').click();
  await page.waitForSelector('#panel .tv-card[data-id="t-0001"]:not(.unread)');
  await page.reload();
  await page.waitForFunction(() => window.hd?.state().threads.length > 0);
  await page.evaluate(() => window.hd.select("hub:alpha"));
  await page.waitForSelector('#panel .tv-card[data-id="t-0001"]');
  await sleep(500);
  assert.equal(await page.locator('#panel .tv-card[data-id="t-0001"].unread').count(), 0, "read state lost on reload");
  await ctx.close();
});

test("stage filter and search, with a way back (T6)", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openHub(page);
  const shown = () => page.$$eval("#panel .tv .tv-card", (cs) => cs.filter((c) => c.offsetParent !== null || c.closest("details:not([open])")).filter((c) => !c.hidden && !c.closest(".tv-stage").hidden).map((c) => c.dataset.id));
  await page.click('#panel .tv .tv-count[data-stage="working"]');
  assert.equal(await page.getAttribute('#panel .tv .tv-count[data-stage="working"]', "aria-pressed"), "true");
  assert.deepEqual(await shown(), ["t-0001"]);
  await page.click('#panel .tv .tv-count[data-stage="working"]');
  assert.ok((await shown()).length >= 8);
  await page.fill("#panel .tv .tv-search", "zephyr");
  assert.deepEqual(await shown(), ["t-0008"]);
  // Search reaches event text too.
  await page.fill("#panel .tv .tv-search", "checks failing");
  assert.deepEqual(await shown(), ["t-0003"]);
  await page.fill("#panel .tv .tv-search", "no such thing at all");
  assert.deepEqual(await shown(), []);
  assert.match(await page.textContent("#panel .tv .tv-empty"), /No threads match/);
  await page.click("#panel .tv .tv-empty button");
  assert.equal(await page.inputValue("#panel .tv .tv-search"), "");
  assert.ok((await shown()).length >= 8);
  await page.close();
});

test("report opens rendered in a window, sanitised (T7)", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openHub(page);
  await page.click('#panel .tv-card[data-id="t-0003"] .tv-report');
  const win = page.locator('.hwin[data-win="report:alpha/t-0003"]');
  await win.locator(".md h3").waitFor();
  assert.match(await win.locator(".md h3").textContent(), /Widget shipped/);
  assert.equal(await win.locator(".md a[href^='https://github.com/acme/alpha/pull/7']").count() >= 0, true);
  await page.click('#panel .tv-card[data-id="t-0002"] .tv-report');
  const w2 = page.locator('.hwin[data-win="report:alpha/t-0002"]');
  await w2.locator(".md").waitFor();
  await page.waitForFunction(() => document.querySelector('.hwin[data-win="report:alpha/t-0002"] .md')?.textContent.includes("Blocked on a permission prompt"));
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await w2.locator("script, a[href^='javascript']").count(), 0);
  // The PR link is a link.
  assert.equal(await page.getAttribute('#panel .tv-card[data-id="t-0003"] a.tv-pr', "href"), "https://github.com/acme/alpha/pull/7");
  await page.screenshot({ path: join(artifacts, "threads-report.png") });
  await page.close();
});

test("in the coordinator window and the thread side panel (T8)", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openHub(page);
  await page.click("#pop-out");
  const win = page.locator('.hwin[data-win="thread:hub:alpha"]');
  await win.waitFor();
  await win.locator('.tw-tab[data-tab="threads"]').click();
  await win.locator(".tv .tv-card").first().waitFor();
  assert.ok(await win.locator(".tv .tv-card").count() >= 8);
  await page.screenshot({ path: join(artifacts, "threads-window.png") });
  await win.locator(".hw-close").click();
  // The thread side panel: that thread's own timeline.
  await page.evaluate(() => window.hd.select("alpha/t-0003"));
  await page.waitForSelector('#panel .tv-thread .tv-events li[data-type="pr-failing"]');
  await page.close();
});

test("phone layout: sheet with the Threads view, no sideways scroll (T8)", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await openHub(page);
  await page.locator("#panel .tv").scrollIntoViewIfNeeded();
  const over = await page.evaluate(() => [...document.querySelectorAll("#panel .tv, #panel .tv *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && e.offsetParent).map((e) => e.className).slice(0, 5));
  assert.deepEqual(over, [], "elements past the right edge");
  assert.ok(await page.evaluate(() => document.querySelector("#panel").scrollWidth <= document.querySelector("#panel").clientWidth + 1));
  const box = await page.locator('#panel .tv-card[data-id="t-0003"] .tv-expand').boundingBox();
  assert.ok(box.height >= 32 && box.width >= 32, `expand target ${box.width}x${box.height}`);
  await page.screenshot({ path: join(artifacts, "threads-phone.png") });
  await page.locator('#panel .tv-card[data-id="t-0003"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "threads-phone-cards.png") });
  await ctx.close();
});
