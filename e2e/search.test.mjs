// E2E: content search. The real herdr-dash binary runs against the fixture
// root with stubbed herdr-projects / herdr / gh / memex; headless Chromium
// drives the search box. Artifacts land in e2e/artifacts/search-*.
//
// Ways content search could fail, written before it existed:
//  S1. A thread is not found by words only in its task, report or Next file;
//      the coordinator's TASKS.md / MEMORY.md / PROJECT.md do not lead to
//      the project hub.
//  S2. The file index goes stale: an edited file still matches its old text,
//      a new file is never found, a deleted one keeps matching.
//  S3. memex runs with the wrong argv: not lexical, not non-interactive, with
//      update checks, a query that reaches it as a flag or as query syntax,
//      or a maintenance command (index, update, daemon).
//  S4. memex runs while nobody searches (idle cost), or per keystroke: no
//      debounce, fewer than 3 characters, Enter does not run at once.
//  S5. Two memex processes overlap: a newer search does not cancel the
//      older one, or a closed request leaves its process running.
//  S6. A slow memex hangs the search: no ~2 s timeout, the process is not
//      killed, or the file hits are lost with it.
//  S7. The same query spawns memex again instead of using the cache; memex
//      is not rate limited.
//  S8. memex missing or off breaks search instead of disabling transcripts.
//  S9. Transcript hits are mis-mapped: a live pane's session, a resolved
//      thread's worktree (Claude folder name), a Codex rollout's cwd, a
//      coordinator's session or folder; a repo-only hit is not grouped under
//      its project; an unrelated hit is kept.
// S10. Results lack the thread/project, source, time or a highlighted
//      snippet; a snippet is inserted as HTML; clicking a result does not
//      open its panel; matching graph nodes are not highlighted.
// S11. The Title/Content toggle (button and keybind) is not persisted, or
//      title mode stops being an instant client-side filter.
// S12. Voice navigation has no `dash.search(text, {mode})` to call.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
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

const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-search-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");

let server, base, browser;
const servers = [];

function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

// memex comes from env here (HERDR_DASH_MEMEX), unless a test passes --memex.
function startServer(port, extra = [], env = {}) {
  const s = spawn(join(repo, "bin/herdr-dash"), [
    "--root", join(td, "root"),
    "--herdr", join(stub, "herdr"),
    "--gh", join(stub, "gh"),
    "--claude-dir", join(td, "claude"),
    "--codex-dir", join(td, "codex"),
    "--poll", "1s",
    ...extra,
  ], {
    env: { ...process.env, STUB_LOG: stubLog, HERDR_DASH_ADDR: `127.0.0.1:${port}`, HERDR_DASH_HERDR_PROJECTS: join(stub, "herdr-projects"), HERDR_DASH_MEMEX: join(stub, "memex"), ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  servers.push(s);
  return s;
}

const logLines = () => readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
const memexLines = () => logLines().filter((l) => l.startsWith("memex "));
const memexRuns = (word) => memexLines().filter((l) => l.startsWith("memex search ") && l.endsWith(" " + word)).length;

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

async function boot(port, extra, env) {
  const url = `http://127.0.0.1:${port}`;
  const s = startServer(port, extra, env);
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  return { url, s };
}

const search = async (q, url = base) => {
  const r = await fetch(url + "/api/search?q=" + encodeURIComponent(q));
  assert.equal(r.status, 200, `search ${q} -> ${r.status}`);
  return r.json();
};
const keysOf = (res) => [...new Set(res.hits.map((h) => h.key))].sort();
const hit = (res, key, source) => res.hits.find((h) => h.key === key && h.source === source);

before(async () => {
  // A roomy memex bucket: this file runs many distinct searches.
  ({ url: base, s: server } = await boot(await freePort(), ["--memex-per-min", "600"]));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill());
});

test("idle server never runs memex; short queries never search", async () => {
  // S4: a few poll cycles pass with no search.
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual(memexLines(), []);
  const r = await search("ze");
  assert.deepEqual(r.hits, []);
  assert.deepEqual(memexLines(), []);
});

test("API: files and transcripts map to threads and projects", async () => {
  const r = await search("zephyr");
  writeFileSync(join(artifacts, "search-zephyr.json"), JSON.stringify(r, null, 2));
  // S1: task, Next and report files; TASKS.md leads to the hub.
  assert.ok(hit(r, "alpha/t-0001", "task"), "task file");
  assert.ok(hit(r, "alpha/t-0005", "next"), "next file");
  assert.ok(hit(r, "beta/t-0001", "report"), "report file");
  assert.ok(hit(r, "hub:alpha", "tasks"), "TASKS.md");
  // S9: live session, resolved worktree, codex cwd, coordinator, memory.
  assert.ok(hit(r, "alpha/t-0001", "transcript"), "live pane session");
  assert.ok(hit(r, "alpha/t-0004", "transcript"), "resolved thread by Claude folder");
  assert.ok(hit(r, "beta/t-0002", "transcript"), "codex rollout cwd");
  assert.ok(hit(r, "hub:beta", "agent-memory"), "memory by cwd");
  const coord = r.hits.filter((h) => h.key === "hub:alpha" && h.source === "transcript");
  assert.ok(coord.some((h) => /coordinator planned/.test(h.snippet)), "coordinator session");
  const grouped = coord.find((h) => /repo session/.test(h.snippet));
  assert.ok(grouped && grouped.project_only, "repo-only hit grouped under its project");
  assert.ok(!r.hits.some((h) => /unrelated/.test(h.snippet)), "unrelated hit dropped");
  assert.equal(r.memex.status, "ok");
  assert.equal(r.memex.dropped, 1);
  // S10: every hit says where and when.
  for (const h of r.hits) {
    assert.ok(h.project && h.title && h.source && h.snippet, JSON.stringify(h));
    assert.ok(Date.parse(h.time) > 0, "time " + JSON.stringify(h));
    assert.match(h.snippet.toLowerCase(), /zephyr/);
  }
  assert.equal(hit(r, "alpha/t-0004", "transcript").title, "Old cleanup");
  assert.equal(hit(r, "beta/t-0002", "transcript").time, "2026-10-09T08:01:00Z");
  // No local paths leave the server.
  assert.doesNotMatch(JSON.stringify(r), /fixture|testdata|\/root\//);

  // A word only in a report (not a title) finds that thread alone.
  const c = await search("capacitor");
  assert.deepEqual(keysOf(c), ["alpha/t-0003"]);
  assert.equal(c.hits[0].source, "report");
});

test("API: memex argv is a lexical, non-interactive search with a sanitized query", async () => {
  await search('Flux:"capacitor" AND --root (x)');
  const runs = memexLines().filter((l) => l.startsWith("memex search "));
  assert.ok(runs.length >= 2);
  // S3
  for (const l of runs) {
    assert.match(l, /^memex search --non-interactive --no-update-check --content all --mode lexical --format jsonl --limit \d+ --top-n-per-session \d+ --fields \S+ -- [a-z0-9 ]+$/, l);
  }
  assert.ok(runs.at(-1).endsWith(" -- flux capacitor and root x"), runs.at(-1));
  assert.ok(!memexLines().some((l) => /^memex (index|update|daemon|web|mcp)/.test(l)));
});

test("API: file index follows edits, new and deleted files", async () => {
  // S2
  const f = join(td, "root/beta/threads/t-0003.next.md");
  try {
    writeFileSync(f, "- look at the nebula numbers\n");
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(hit(await search("nebula"), "beta/t-0003", "next"), "new file found");
    writeFileSync(f, "- look at the pulsar numbers\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(f, later, later);
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(hit(await search("pulsar"), "beta/t-0003", "next"), "edit found");
    assert.ok(!hit(await search("nebula"), "beta/t-0003", "next"), "old text gone");
  } finally {
    rmSync(f, { force: true });
  }
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(!hit(await search("pulsar"), "beta/t-0003", "next"), "deleted file gone");
});

test("API: results are cached per query", async () => {
  // S7
  const n = memexRuns("zephyr");
  assert.ok(n >= 1);
  const r = await search("zephyr");
  assert.equal(r.memex.status, "ok");
  assert.equal(memexRuns("zephyr"), n, "cached: memex not run again");
});

test("API: a newer search cancels the running memex; never two at once", async () => {
  // S5
  const slow = fetch(base + "/api/search?q=sleepy+one").then((r) => r.json());
  await waitFor(() => memexRuns("sleepy one") === 1, 3000);
  const t0 = Date.now();
  const fast = await search("capacitor bridge");
  const first = await slow;
  assert.equal(first.memex.status, "cancelled");
  assert.equal(fast.memex.status, "ok");
  assert.ok(Date.now() - t0 < 900, "did not wait for the old one to finish");
  await waitFor(() => memexLines().includes("memex killed sleepy one"), 3000);

  // A request the client drops kills its memex too.
  const ctrl = new AbortController();
  fetch(base + "/api/search?q=sleepy+two", { signal: ctrl.signal }).catch(() => {});
  await waitFor(() => memexRuns("sleepy two") === 1, 3000);
  ctrl.abort();
  await waitFor(() => memexLines().includes("memex killed sleepy two"), 3000);
  assert.ok(!memexLines().some((l) => l.startsWith("memex OVERLAP")), "never two memex at once");
});

test("API: a slow memex times out, file hits survive", async () => {
  // S6
  const t0 = Date.now();
  const r = await search("slowpoke capacitor");
  const took = Date.now() - t0;
  assert.equal(r.memex.status, "timeout");
  assert.ok(took >= 1500 && took < 3500, `took ${took}ms`);
  assert.ok(hit(r, "alpha/t-0003", "report"), "file hit kept");
  await waitFor(() => memexLines().includes("memex killed slowpoke capacitor"), 3000);
});

test("page: content mode searches on debounce or Enter and renders results", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const reqs = [];
  page.on("request", (r) => { if (r.url().includes("/api/search")) reqs.push(decodeURIComponent(new URL(r.url()).searchParams.get("q"))); });
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  // S11: title mode by default, client-side only.
  assert.equal(await page.locator("#search-mode").getAttribute("aria-pressed"), "false");
  await page.fill("#f-search", "zephyr");
  await page.waitForTimeout(700);
  assert.deepEqual(reqs, [], "title mode never calls the server");
  assert.equal(await page.locator("svg g.node.thread").count(), 0, "no title matches zephyr");
  await page.fill("#f-search", "");

  // Button toggles to content mode; the graph is no longer title-filtered.
  await page.click("#search-mode");
  assert.equal(await page.locator("#search-mode").getAttribute("aria-pressed"), "true");
  assert.match(await page.getAttribute("#f-search", "placeholder"), /content/i);

  // S4: < 3 chars never searches; typing is debounced to one request.
  await page.locator("#f-search").pressSequentially("ze", { delay: 60 });
  await page.waitForTimeout(700);
  assert.deepEqual(reqs, []);
  await page.locator("#f-search").pressSequentially("phyr", { delay: 60 });
  await page.waitForSelector("#search-results .hit");
  await page.waitForTimeout(600);
  assert.deepEqual(reqs, ["zephyr"]);
  assert.equal(await page.locator("svg g.node.thread").count(), 10, "content mode does not filter by title");

  // S10: rows say thread, source and time; snippets are text with marks.
  const rows = page.locator("#search-results .hit");
  assert.equal(await rows.count(), 7, "one row per thread or project");
  const t1 = page.locator('#search-results .hit[data-key="alpha/t-0001"]').first();
  assert.match(await t1.innerText(), /Widget pipeline/);
  assert.match(await page.locator("#search-results").innerText(), /transcript/i);
  assert.match(await page.locator("#search-results").innerText(), /report/i);
  assert.ok((await page.locator("#search-results .hit mark").count()) >= 8);
  assert.equal((await page.locator("#search-results mark").first().innerText()).toLowerCase(), "zephyr");
  assert.match(await page.locator("#search-results").innerText(), /<img src=x onerror=/);
  assert.equal(await page.locator("#search-results img").count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.match(await page.locator("#search-results .hit time").first().innerText(), /\w/);
  // Graph: matching nodes highlighted, the rest dimmed.
  assert.ok(await page.locator("svg#graph.searching").count());
  const lit = await page.locator("svg g.node.hit").evaluateAll((ns) => ns.map((n) => n.dataset.key).sort());
  assert.deepEqual(lit, ["alpha/t-0001", "alpha/t-0004", "alpha/t-0005", "beta/t-0001", "beta/t-0002", "hub:alpha", "hub:beta"]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(artifacts, "search-content.png") });

  // Clicking a result opens its panel.
  await page.locator('#search-results .hit[data-key="alpha/t-0004"]').first().click();
  await page.waitForSelector("#panel.open");
  assert.equal(await page.locator("#panel h2.title").innerText(), "Old cleanup");

  // Enter searches at once (no debounce wait).
  await page.fill("#f-search", "capacitor");
  await page.press("#f-search", "Enter");
  await page.waitForTimeout(150);
  assert.equal(reqs.at(-1), "capacitor");
  await page.waitForSelector('#search-results .hit[data-key="alpha/t-0003"]');
  assert.equal(reqs.filter((q) => q === "capacitor").length, 1, "debounce did not fire again after Enter");

  // Clearing the box clears results and highlights.
  await page.fill("#f-search", "");
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#search-results .hit").count(), 0);
  assert.equal(await page.locator("svg#graph.searching").count(), 0);

  // S11: persisted across reloads; the keybind toggles back.
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  assert.equal(await page.locator("#search-mode").getAttribute("aria-pressed"), "true");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Alt+KeyC");
  assert.equal(await page.locator("#search-mode").getAttribute("aria-pressed"), "false");
  await page.keyboard.press("Alt+KeyC");
  assert.equal(await page.locator("#search-mode").getAttribute("aria-pressed"), "true");

  // S12: the voice hook.
  await page.evaluate(() => window.dash.search("widget", { mode: "title" }));
  assert.equal(await page.locator("#search-mode").getAttribute("aria-pressed"), "false");
  await waitFor(async () => (await page.locator("svg g.node.thread").count()) === 2, 3000);
  await page.evaluate(() => window.dash.search("capacitor", { mode: "content" }));
  await page.waitForSelector('#search-results .hit[data-key="alpha/t-0003"]');
  assert.equal(await page.locator("#search-mode").getAttribute("aria-pressed"), "true");
  assert.equal(await page.inputValue("#f-search"), "capacitor");
  assert.deepEqual(errors, []);
  await page.close();
});

test("page: phone layout keeps results on screen", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(base + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.evaluate(() => window.dash.search("zephyr", { mode: "content" }));
  await page.waitForSelector("#search-results .hit");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "no horizontal scroll");
  await page.screenshot({ path: join(artifacts, "search-phone.png") });
  await page.close();
});

test("memex missing or off: files still searched, transcripts disabled", async () => {
  // S8
  const a = await boot(await freePort(), ["--memex", join(tmp, "no-such-memex")]);
  const b = await boot(await freePort(), [], { HERDR_DASH_MEMEX: "off" });
  for (const { url } of [a, b]) {
    const r = await search("zephyr", url);
    assert.equal(r.memex.status, "disabled");
    assert.ok(hit(r, "alpha/t-0001", "task"));
    assert.ok(!r.hits.some((h) => h.source === "transcript"));
    const cfg = await (await fetch(url + "/api/config")).json();
    assert.equal(cfg.memex, false);
  }
  assert.equal((await (await fetch(base + "/api/config")).json()).memex, true);
  a.s.kill();
  b.s.kill();
});

test("memex is rate limited", async () => {
  // S7: a second instance allowing one memex run a minute.
  const { url, s } = await boot(await freePort(), ["--memex-per-min", "1"]);
  const first = await search("alphabet one", url);
  const second = await search("alphabet two", url);
  assert.equal(first.memex.status, "ok");
  assert.equal(second.memex.status, "rate_limited");
  s.kill();
});

test("only read-only memex searches were run", () => {
  const lines = memexLines();
  writeFileSync(join(artifacts, "search-calls.log"), lines.join("\n") + "\n");
  for (const l of lines) {
    assert.match(l, /^memex (search --non-interactive --no-update-check --content all --mode lexical --format jsonl --limit \d+ --top-n-per-session \d+ --fields \S+ -- [a-z0-9 ]+|killed [a-z0-9 ]+)$/, l);
  }
  assert.ok(!lines.some((l) => l.startsWith("memex OVERLAP")));
});
