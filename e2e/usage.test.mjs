// E2E for the Usage strip: how much is left on the Claude Code plan, the Codex
// (ChatGPT) plan and the opencode provider balance. Runs the real herdr-dash
// binary against fixture credential, state and session files written to a temp
// home, with a stub provider HTTP server standing in for Anthropic and
// OpenRouter. Artifacts land in e2e/artifacts/usage-*.
//
// Ways this could fail, written before the feature existed:
//  U1. A credential (Claude OAuth token, refresh token, provider API key)
//      reaches /api/usage, /api/state, /api/config, the page or the log.
//  U2. A source whose files are absent half-works or crashes instead of being
//      cleanly "disabled", and the page still shows a gauge for it.
//  U3. The Claude call has the wrong shape (no Bearer, no oauth beta header)
//      or its answer is mis-read (5h / weekly / per-model weekly windows,
//      percent, reset time, plan).
//  U4. An expired Claude token is used, refreshed or written back; or the
//      credentials file is modified at all.
//  U5. A slow provider hangs /api/usage (no ~3 s timeout), and the last
//      known data (Claude's own cached /usage result) is not used as a
//      clearly stale fallback.
//  U6. Network results are not cached: every page load or poll calls the
//      provider, or concurrent requests each start their own fetch. Fresh
//      local data (Claude's cache) is ignored in favour of a network call.
//  U7. Codex: not the newest session file, or not its last rate_limits event;
//      windows mislabelled (5h vs weekly); a window whose reset time has
//      passed still shows the old usage; the credits balance is lost.
//  U8. opencode: the configured model's provider is not found (JSONC config,
//      {file:} / {env:} keys); an OpenRouter balance is not shown; a provider
//      without a balance API gets its key sent somewhere or a guessed value
//      instead of "unavailable".
//  U9. The strip does not colour by what is left (green, amber, red), shows
//      reset times in the server's zone instead of the viewer's, has no
//      updated stamp, or clicking does not open details.
// U10. --usage off still reads files or calls providers.
// U11. On a phone the strip overflows the header.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import { artifacts, freePort, repo, td, stub, waitFor } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-usage-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const SECRETS = {
  full: "sk-ant-oat01-FULLTOKEN-not-real-0001",
  passive: "sk-ant-oat01-PASSIVETOKEN-not-real-0002",
  expired: "sk-ant-oat01-EXPIREDTOKEN-not-real-0003",
  slow: "sk-ant-oat01-SLOWTOKEN-not-real-0004",
  off: "sk-ant-oat01-OFFTOKEN-not-real-0005",
  refresh: "sk-ant-ort01-REFRESH-not-real-0006",
  openrouter: "sk-or-v1-OPENROUTERKEY-not-real-0007",
  custom: "rl-CUSTOMKEY-not-real-0008",
};

// ---------------------------------------------------------------- stub providers
const calls = [];
const RESET_5H = iso(now + 85 * 60_000);
const RESET_WEEK = iso(now + 5 * 86400_000 + 3600_000);
const claudeAnswer = {
  five_hour: { utilization: 85, resets_at: RESET_5H },
  seven_day: { utilization: 47, resets_at: RESET_WEEK },
  seven_day_opus: null,
  limits: [
    { kind: "session", group: "session", percent: 85, severity: "warning", resets_at: RESET_5H, scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 47, severity: "normal", resets_at: RESET_WEEK, scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 96, severity: "critical", resets_at: RESET_WEEK, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
};
const prov = http.createServer((req, res) => {
  const call = { method: req.method, url: req.url, auth: req.headers.authorization || "", beta: req.headers["anthropic-beta"] || "" };
  calls.push(call);
  const send = (o, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/ok/api/oauth/usage") {
    if (!/^Bearer sk-ant-oat01-/.test(call.auth)) return send({ error: "unauthorized" }, 401);
    return send(claudeAnswer);
  }
  if (req.url === "/slow/api/oauth/usage") {
    setTimeout(() => send(claudeAnswer), 8000).unref();
    return;
  }
  if (req.url === "/openrouter/api/v1/credits") {
    if (call.auth !== `Bearer ${SECRETS.openrouter}`) return send({ error: { message: "No auth" } }, 401);
    return send({ data: { total_credits: 20, total_usage: 15.5 } });
  }
  send({ error: "no route " + req.url }, 404);
});
const callsWith = (secret) => calls.filter((c) => c.auth.includes(secret));

// ---------------------------------------------------------------- fixture homes
function claudeHome(dir, token, expiresAt) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ".credentials.json");
  writeFileSync(file, JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: SECRETS.refresh, expiresAt, scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x" },
  }));
  return file;
}
function claudeState(file, fetchedAtMs) {
  writeFileSync(file, JSON.stringify({
    numStartups: 3,
    cachedUsageUtilization: {
      fetchedAtMs,
      utilization: {
        five_hour: { utilization: 12, resets_at: RESET_5H },
        seven_day: { utilization: 30, resets_at: RESET_WEEK },
        limits: [
          { kind: "session", percent: 12, resets_at: RESET_5H, scope: null },
          { kind: "weekly_all", percent: 30, resets_at: RESET_WEEK, scope: null },
        ],
      },
    },
  }));
}
const rl = (primary, secondary, credits) => ({ limit_id: "codex", primary, secondary, credits, plan_type: "pro" });
const tokenCount = (ts, rate_limits) => JSON.stringify({ timestamp: iso(ts), type: "event_msg", payload: { type: "token_count", info: null, rate_limits } });
function codexDir(dir, files) {
  for (const [rel, lines, mtime] of files) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, lines.join("\n") + "\n");
    utimesSync(p, new Date(mtime), new Date(mtime));
  }
}
function opencode(dir, cfg, data) {
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "config/opencode.jsonc"), cfg);
  if (data) writeFileSync(join(dir, "data/auth.json"), JSON.stringify(data));
}

const H = Object.fromEntries(["full", "passive", "expired", "slow", "empty", "off"].map((k) => [k, join(tmp, k)]));
const sessionRel = (d, name) => `2026/10/${d}/rollout-${name}.jsonl`;
const PRIMARY_RESET = Math.floor((now + 2 * 3600_000) / 1000);
const WEEK_RESET = Math.floor((now + 4 * 86400_000) / 1000);
let credFiles = {};

function writeFixtures(provURL) {
  // full: network Claude, newest Codex session, OpenRouter balance via {env:}.
  credFiles.full = claudeHome(join(H.full, "claude"), SECRETS.full, now + 3600_000);
  codexDir(join(H.full, "codex"), [
    [sessionRel("09", "old"), [tokenCount(now - 86400_000, rl({ used_percent: 99, window_minutes: 300, resets_at: PRIMARY_RESET }, null, null))], now - 86400_000],
    [sessionRel("10", "new"), [
      tokenCount(now - 120_000, rl({ used_percent: 10, window_minutes: 300, resets_at: PRIMARY_RESET }, { used_percent: 20, window_minutes: 10080, resets_at: WEEK_RESET }, null)),
      tokenCount(now - 60_000, rl({ used_percent: 62, window_minutes: 300, resets_at: PRIMARY_RESET }, { used_percent: 33, window_minutes: 10080, resets_at: WEEK_RESET }, { has_credits: true, unlimited: false, balance: "1234.5600" })),
      JSON.stringify({ timestamp: iso(now - 30_000), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: null } }),
      JSON.stringify({ timestamp: iso(now - 20_000), type: "response_item", payload: { type: "message", content: [{ type: "output_text", text: "done" }] } }),
    ], now - 20_000],
  ]);
  opencode(join(H.full, "opencode"), `{
    // JSONC with comments and a trailing comma
    "model": "openrouter/anthropic/claude-sonnet-4.5",
    "provider": {
      "openrouter": { "options": { "baseURL": "${provURL}/openrouter/api/v1", "apiKey": "{env:TEST_OPENROUTER_KEY}", }, },
    },
  }`);

  // passive: fresh Claude cache is used without a call; Codex window already
  // reset; a custom provider without a balance API.
  credFiles.passive = claudeHome(join(H.passive, "claude"), SECRETS.passive, now + 3600_000);
  claudeState(join(H.passive, "claude.json"), now - 60_000);
  codexDir(join(H.passive, "codex"), [
    [sessionRel("10", "reset"), [tokenCount(now - 7 * 3600_000, rl({ used_percent: 90, window_minutes: 300, resets_at: Math.floor((now - 3600_000) / 1000) }, null, null))], now - 7 * 3600_000],
  ]);
  writeFileSync(join(tmp, "custom-key"), SECRETS.custom + "\n");
  opencode(join(H.passive, "opencode"), JSON.stringify({
    model: "refuse/glm-big",
    provider: { refuse: { npm: "@ai-sdk/openai-compatible", name: "Refuse Cloud", options: { baseURL: `${provURL}/custom/v1`, apiKey: `{file:${join(tmp, "custom-key")}}` } } },
  }));

  // expired: expired Claude token, no Codex rate limits, no opencode config.
  credFiles.expired = claudeHome(join(H.expired, "claude"), SECRETS.expired, now - 3600_000);
  codexDir(join(H.expired, "codex"), [
    [sessionRel("10", "nolimits"), [JSON.stringify({ timestamp: iso(now), type: "session_meta", payload: { id: "x" } })], now],
  ]);

  // slow: the Claude endpoint hangs; Claude's own (old) cache is the fallback.
  credFiles.slow = claudeHome(join(H.slow, "claude"), SECRETS.slow, now + 3600_000);
  claudeState(join(H.slow, "claude.json"), now - 3 * 3600_000);

  // off: everything present, but --usage off.
  credFiles.off = claudeHome(join(H.off, "claude"), SECRETS.off, now + 3600_000);
  opencode(join(H.off, "opencode"), JSON.stringify({ model: "openrouter/x", provider: { openrouter: { options: { baseURL: `${provURL}/openrouter/api/v1`, apiKey: SECRETS.openrouter } } } }));
}

// ---------------------------------------------------------------- servers
const servers = {};
function start(name, port, usageURL, extra = []) {
  const h = H[name];
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(CLOUDFLARE_|HERDR_DASH_)/.test(k)) delete base[k];
  const p = spawn(join(repo, "bin/herdr-dash"), [
    "--root", join(td, "root"),
    "--herdr", join(stub, "herdr"),
    "--gh", join(stub, "gh"),
    "--claude-dir", join(td, "claude"),
    "--codex-dir", join(h, "codex"),
    "--claude-home", join(h, "claude"),
    "--claude-state", join(h, "claude.json"),
    "--claude-usage-url", usageURL,
    "--opencode-config", join(h, "opencode/config"),
    "--opencode-data", join(h, "opencode/data"),
    "--poll", "1s",
    ...extra,
  ], {
    env: { ...base, STUB_LOG: stubLog, HERDR_DASH_ADDR: `127.0.0.1:${port}`, HERDR_DASH_HERDR_PROJECTS: join(stub, "herdr-projects"), TEST_OPENROUTER_KEY: SECRETS.openrouter },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const s = { proc: p, url: `http://127.0.0.1:${port}`, log: "" };
  p.stdout.on("data", (b) => (s.log += b));
  p.stderr.on("data", (b) => (s.log += b));
  servers[name] = s;
  return s;
}
const getJSON = async (s, path) => {
  const r = await fetch(s.url + path);
  assert.equal(r.status, 200, `${path} -> ${r.status}`);
  return r.json();
};
const usage = (s) => getJSON(s, "/api/usage");
const src = (u, id) => u.sources.find((x) => x.id === id);

let browser, provURL, credBefore = {};

before(async () => {
  const pp = await freePort();
  await new Promise((r) => prov.listen(pp, "127.0.0.1", r));
  provURL = `http://127.0.0.1:${pp}`;
  writeFixtures(provURL);
  for (const [k, f] of Object.entries(credFiles)) credBefore[k] = readFileSync(f, "utf8");
  const ports = await Promise.all(Object.keys(H).map(() => freePort()));
  start("full", ports[0], `${provURL}/ok/api/oauth/usage`);
  start("passive", ports[1], `${provURL}/ok/api/oauth/usage`);
  start("expired", ports[2], `${provURL}/ok/api/oauth/usage`);
  start("slow", ports[3], `${provURL}/slow/api/oauth/usage`);
  start("empty", ports[4], `${provURL}/ok/api/oauth/usage`);
  start("off", ports[5], `${provURL}/ok/api/oauth/usage`, ["--usage", "off"]);
  for (const s of Object.values(servers)) await waitFor(async () => (await (await fetch(s.url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  for (const s of Object.values(servers)) s.proc.kill();
  prov.close();
});

test("Claude: request shape, windows, plan and caching (U3, U6)", async () => {
  const s = servers.full;
  // Concurrent first requests share one fetch.
  const [u] = await Promise.all([usage(s), usage(s), usage(s)]);
  writeFileSync(join(artifacts, "usage-full.json"), JSON.stringify(u, null, 2));
  const c = src(u, "claude");
  assert.equal(c.status, "ok", JSON.stringify(c));
  assert.equal(c.plan, "max");
  assert.equal(c.stale, false);
  assert.deepEqual(c.windows.map((w) => [w.label, w.used_percent, w.resets_at && Date.parse(w.resets_at)]), [
    ["5h", 85, Date.parse(RESET_5H)],
    ["Week", 47, Date.parse(RESET_WEEK)],
    ["Week · Fable", 96, Date.parse(RESET_WEEK)],
  ]);
  assert.ok(Date.parse(c.as_of) >= now - 5000, "as_of is the fetch time");
  const hits = callsWith(SECRETS.full);
  assert.equal(hits.length, 1, `one fetch for concurrent requests, got ${hits.length}`);
  assert.equal(hits[0].method, "GET");
  assert.equal(hits[0].auth, `Bearer ${SECRETS.full}`);
  assert.match(hits[0].beta, /oauth-2025-04-20/);
  // Polls within the network interval are served from the cache.
  for (let i = 0; i < 3; i++) await usage(s);
  assert.equal(callsWith(SECRETS.full).length, 1, "cached");
});

test("Claude: fresh local cache used without a call; expired token never used (U4, U6)", async () => {
  const p = src(await usage(servers.passive), "claude");
  assert.equal(p.status, "ok", JSON.stringify(p));
  assert.equal(p.stale, false);
  assert.deepEqual(p.windows.map((w) => [w.label, w.used_percent]), [["5h", 12], ["Week", 30]]);
  assert.equal(callsWith(SECRETS.passive).length, 0, "passive data preferred");

  const e = src(await usage(servers.expired), "claude");
  assert.equal(e.status, "unavailable");
  assert.match(e.reason, /expired/i);
  assert.equal(e.windows.length, 0);
  assert.equal(callsWith(SECRETS.expired).length, 0, "expired token not sent");
  assert.equal(calls.filter((c) => /token|refresh/i.test(c.url)).length, 0, "no refresh");
  for (const [k, f] of Object.entries(credFiles)) assert.equal(readFileSync(f, "utf8"), credBefore[k], `${k} credentials untouched`);
});

test("Claude: a hanging endpoint times out and falls back to stale cache (U5)", async () => {
  const t0 = Date.now();
  const u = await usage(servers.slow);
  const took = Date.now() - t0;
  assert.ok(took < 4500, `answered in ${took}ms`);
  const c = src(u, "claude");
  assert.equal(c.status, "ok", JSON.stringify(c));
  assert.equal(c.stale, true);
  assert.match(c.reason, /timed out|timeout/i);
  assert.deepEqual(c.windows.map((w) => [w.label, w.used_percent]), [["5h", 12], ["Week", 30]]);
  assert.ok(Math.abs(Date.parse(c.as_of) - (now - 3 * 3600_000)) < 2000, "as_of is the cache time");
  // The failure is cached too: the next poll does not wait again.
  const t1 = Date.now();
  await usage(servers.slow);
  assert.ok(Date.now() - t1 < 1000, "failure cached");
  assert.equal(callsWith(SECRETS.slow).length, 1);
});

test("Codex: newest session, last rate_limits, labels, reset windows, credits (U7)", async () => {
  const c = src(await usage(servers.full), "codex");
  assert.equal(c.status, "ok", JSON.stringify(c));
  assert.equal(c.plan, "pro");
  assert.deepEqual(c.windows.map((w) => [w.label, w.used_percent, Date.parse(w.resets_at) / 1000]), [
    ["5h", 62, PRIMARY_RESET],
    ["Week", 33, WEEK_RESET],
  ]);
  assert.equal(c.balance.remaining, 1234.56);
  assert.equal(c.balance.unit, "credits");
  assert.ok(Math.abs(Date.parse(c.as_of) - (now - 60_000)) < 2000, "as_of is the event time");

  const r = src(await usage(servers.passive), "codex");
  assert.equal(r.status, "ok");
  assert.equal(r.windows[0].used_percent, 0, "window reset since the event");
  assert.equal(r.windows[0].reset_passed, true);

  const n = src(await usage(servers.expired), "codex");
  assert.equal(n.status, "unavailable");
  assert.match(n.reason, /no rate.limit/i);
});

test("opencode: OpenRouter balance; no guessing for other providers (U8)", async () => {
  const o = src(await usage(servers.full), "opencode");
  assert.equal(o.status, "ok", JSON.stringify(o));
  assert.equal(o.plan, "openrouter/anthropic/claude-sonnet-4.5");
  assert.equal(o.balance.remaining, 4.5);
  assert.equal(o.balance.total, 20);
  assert.equal(o.balance.unit, "USD");
  assert.equal(callsWith(SECRETS.openrouter).length, 1);
  await usage(servers.full);
  assert.equal(callsWith(SECRETS.openrouter).length, 1, "cached");

  const p = src(await usage(servers.passive), "opencode");
  assert.equal(p.status, "unavailable");
  assert.match(p.reason, /Refuse Cloud.*no balance API/);
  assert.equal(p.balance, null);
  assert.equal(callsWith(SECRETS.custom).length, 0, "custom key never sent");
  assert.equal(calls.filter((c) => c.url.startsWith("/custom")).length, 0);

  assert.equal(src(await usage(servers.expired), "opencode").status, "disabled");
});

test("absent files and --usage off are cleanly disabled (U2, U10)", async () => {
  const e = await usage(servers.empty);
  assert.deepEqual(e.sources.map((x) => [x.id, x.status]), [["claude", "disabled"], ["codex", "disabled"], ["opencode", "disabled"]]);
  const before = calls.length;
  const o = await usage(servers.off);
  assert.deepEqual(o.sources.map((x) => x.status), ["disabled", "disabled", "disabled"]);
  assert.equal(o.enabled, false);
  assert.equal(calls.length, before, "off makes no calls");
  assert.equal(callsWith(SECRETS.off).length, 0);

  const page = await browser.newPage();
  await page.goto(servers.empty.url);
  await page.waitForSelector("svg g.node");
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#usage .usrc").count(), 0, "no gauges for disabled sources");
  assert.ok(await page.locator("#usage").isHidden());
  await page.close();
});

test("strip: colours, local reset times, details, phone layout (U9, U11)", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "Asia/Tokyo" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(servers.full.url);
  await page.waitForSelector("#usage .usrc");
  const ids = await page.locator("#usage .usrc").evaluateAll((els) => els.map((e) => e.dataset.id));
  assert.deepEqual(ids, ["claude", "codex", "opencode"]);
  // Claude 5h has 15% left -> low; weekly 53% -> ok. Codex 5h 38% -> warn.
  const lvl = (sel) => page.locator(sel).getAttribute("data-level");
  assert.equal(await lvl('#usage .usrc[data-id="claude"] .ug[data-win="0"]'), "low");
  assert.equal(await lvl('#usage .usrc[data-id="claude"] .ug[data-win="1"]'), "ok");
  assert.equal(await lvl('#usage .usrc[data-id="codex"] .ug[data-win="0"]'), "warn");
  const colors = await page.locator('#usage .usrc[data-id="claude"] .ug i').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  assert.notEqual(colors[0], colors[1], "levels have distinct colours");
  assert.match(await page.locator('#usage .usrc[data-id="opencode"]').innerText(), /\$4\.50/);
  assert.ok(await page.locator("#usage .ustamp").getAttribute("datetime"), "updated stamp");
  await page.screenshot({ path: join(artifacts, "usage-strip.png"), clip: { x: 0, y: 0, width: 1440, height: 120 } });

  await page.locator('#usage .usrc[data-id="claude"]').click();
  const pop = page.locator("#usage-pop");
  await pop.waitFor({ state: "visible" });
  const t = pop.locator('.usec[data-id="claude"] time.reset').first();
  const want = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(RESET_5H));
  assert.equal(new Date(await t.getAttribute("datetime")).toISOString(), new Date(RESET_5H).toISOString());
  assert.match(await t.innerText(), new RegExp(want.replace(/\s/g, "\\s")));
  const text = await pop.innerText();
  assert.match(text, /15% left/);
  assert.match(text, /Week · Fable/);
  assert.match(text, /1,234\.56 credits/);
  assert.match(text, /\$4\.50 of \$20\.00/);
  await page.screenshot({ path: join(artifacts, "usage-details.png") });
  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "hidden" });

  // U1: no secret in the page.
  const html = await page.content();
  for (const v of Object.values(SECRETS)) assert.ok(!html.includes(v), "secret in page");
  assert.deepEqual(errors, []);
  await page.close();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto(servers.full.url);
  await phone.waitForSelector("#usage .usrc");
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `no horizontal overflow (${overflow}px)`);
  const box = await phone.locator("#usage").boundingBox();
  assert.ok(box.x + box.width <= 390, "strip inside viewport");
  await phone.locator('#usage .usrc[data-id="codex"]').tap();
  await phone.locator("#usage-pop").waitFor({ state: "visible" });
  const pb = await phone.locator("#usage-pop").boundingBox();
  assert.ok(pb.x >= 0 && pb.x + pb.width <= 390, "details fit the phone");
  await phone.screenshot({ path: join(artifacts, "usage-phone.png") });
  await phone.close();
});

test("no credential reaches any API response or the log (U1)", async () => {
  for (const [name, s] of Object.entries(servers)) {
    for (const path of ["/api/usage", "/api/state", "/api/config"]) {
      const body = await (await fetch(s.url + path)).text();
      for (const v of Object.values(SECRETS)) assert.ok(!body.includes(v), `${name} ${path} leaks a secret`);
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  const logs = Object.values(servers).map((s) => s.log).join("\n");
  writeFileSync(join(artifacts, "usage-server.log"), logs.replaceAll(tmp, "$TMP"));
  for (const v of Object.values(SECRETS)) assert.ok(!logs.includes(v), "secret in the log");
});
