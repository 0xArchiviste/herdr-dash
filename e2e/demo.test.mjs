// E2E: the demo (`make demo`) runs the real binary through demo/run.sh
// against the fictional data in demo/, the same way the README tells people
// to try it, and the screenshots in docs/screenshots/ are taken from it.
//
// Ways this could fail, written before the demo existed:
//  1. Real data leaks into the public repo: a /home/<user> path, the
//     machine's user or host name, an email, an IP, a real GitHub org, or the
//     name of a real herdr project on this machine.
//  2. The API shows a real path anyway (the herdr-projects binary or the demo
//     root in a jump command, a worktree, an error message).
//  3. The demo is too thin to show the product: few projects, threads, or a
//     state that never appears (so a screenshot misses a color).
//  4. Everything looks stale: fixed timestamps age, so no node is recent.
//  5. A blocked thread has no permission prompt on screen and no quick
//     replies, or a coordinator panel is empty.
//  6. A write in the demo reaches anything but the demo stubs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const demo = join(repo, "demo");

let server, base, browser;

function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

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
  // The real herdr-projects must never be reachable: the demo puts its stubs
  // first on PATH, and the env below would point anywhere else at nothing.
  server = spawn(join(demo, "run.sh"), [`127.0.0.1:${port}`], {
    env: { ...process.env, HERDR_DASH_HERDR_PROJECTS: "/nonexistent/herdr-projects" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitFor(async () => (await getJSON("/api/state")).threads.length > 0);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Words that would identify this machine or its owner, read at test time so
// the test itself names nothing real.
function forbidden() {
  const words = new Set();
  const user = userInfo().username;
  if (user && user !== "demo") words.add(user);
  words.add(hostname());
  words.add(homedir());
  words.add(repo);
  const realRoot = process.env.HERDR_PROJECTS_ROOT || join(homedir(), ".herdr-projects");
  if (existsSync(realRoot) && realRoot !== join(demo, "root")) {
    for (const n of readdirSync(realRoot)) if (/^[a-z0-9][a-z0-9._-]+$/.test(n) && statSync(join(realRoot, n)).isDirectory()) words.add(n);
  }
  // The demo's own project names, and this product's (public) name.
  const ok = new Set([...readdirSync(join(demo, "root")), "herdr-dash"]);
  return [...words].filter((w) => w && w.length > 2 && !ok.has(w));
}

function leaks(text, where) {
  const found = [];
  const rules = [
    [/\/home\/(?!demo\b)[\w.-]+/g, "home path"],
    [/\/Users\/[\w.-]+/g, "macOS home path"],
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "email"],
    [/\b(?!127\.0\.0\.1\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "IP address"],
    [/github\.com[/:](?!acme-labs\/)[\w.-]+/g, "GitHub org other than acme-labs"],
  ];
  for (const [re, what] of rules) for (const m of text.matchAll(re)) found.push(`${where}: ${what}: ${m[0]}`);
  for (const w of forbidden()) {
    const re = new RegExp(`(^|[^A-Za-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "i");
    if (re.test(text)) found.push(`${where}: names "${w}"`);
  }
  return found;
}

test("demo data names nothing real", () => {
  // 1
  const bad = walk(demo).flatMap((f) => leaks(readFileSync(f, "utf8"), relative(repo, f)));
  assert.deepEqual(bad, []);
});

test("demo API is rich, fresh and shows only fictional paths", async () => {
  const s = await getJSON("/api/state");
  // 3
  assert.ok(s.projects.length >= 6 && s.projects.length <= 8, `projects: ${s.projects.length}`);
  assert.ok(s.threads.length >= 30 && s.threads.length <= 40, `threads: ${s.threads.length}`);
  const states = new Set(s.threads.map((t) => t.state));
  for (const st of ["working", "waiting", "blocked", "review", "landing", "idle", "resolved"]) assert.ok(states.has(st), `state ${st} present`);
  assert.ok(s.threads.some((t) => t.state === "blocked" && t.live_status === "blocked"), "a thread is blocked on a prompt");
  assert.ok(s.threads.some((t) => t.acked), "an acked review thread");
  assert.ok(s.projects.some((p) => p.coordinator?.needs_you), "a coordinator needs you");
  assert.deepEqual(s.errors, []);
  for (const t of s.threads) if (t.pr) assert.match(t.pr, /^https:\/\/github\.com\/acme-labs\/[\w-]+\/pull\/\d+$/);
  // 4
  const fresh = s.threads.filter((t) => t.last_activity && Date.now() - Date.parse(t.last_activity) < 15 * 60_000);
  assert.ok(fresh.length >= 5, `recent threads: ${fresh.length}`);

  // 2: every page of the API, scanned for real data.
  const bodies = [["/api/state", s]];
  for (const t of s.threads) bodies.push([`/api/thread/${t.project}/${t.id}`, await getJSON(`/api/thread/${t.project}/${t.id}`)]);
  for (const p of s.projects) bodies.push([`/api/project/${p.slug}`, await getJSON(`/api/project/${p.slug}`)]);
  const bad = bodies.flatMap(([path, b]) => leaks(JSON.stringify(b), path));
  assert.deepEqual(bad, []);
  for (const [path, b] of bodies) {
    for (const j of b.jump || []) assert.match(j.command, /^herdr(-projects)? [\w :.-]+$/, `${path} jump: ${j.command}`);
  }
});

test("demo page: blocked thread shows its prompt and quick replies, hub opens the coordinator", async () => {
  // 5
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base);
  await page.waitForSelector("svg g.node.thread");
  await page.locator('#needs .group[data-state="blocked"] .chip:not(.coord)').first().click();
  await page.waitForSelector("#panel.open .quick:not([hidden])");
  assert.match(await page.locator("#panel .screen").innerText(), /Do you want to proceed\?/);

  // 6: a quick reply lands on the demo stub and says so.
  await page.locator('#panel .quick button[data-key="1"]').click();
  await page.waitForSelector("#chat-log .msg.ok");

  await page.locator("#open-coord").click();
  await page.waitForSelector("#panel.open #coord-input");
  await page.waitForSelector("#p-chat .screen:not(:empty)");
  await page.waitForSelector("#p-tasks li");
  await page.waitForSelector("#p-reports details");
  assert.ok(await page.locator("#p-threads li").count() >= 3, "coordinator lists its open threads");
  await page.close();
});
