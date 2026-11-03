// E2E for agent routing, stage 1: the Routing window edits routing.toml
// (global, project and thread scopes; drag and keyboard reorder; reset to
// inherited) and "Why this choice?" previews which candidate a new thread
// would get. Runs the real herdr-dash against fixture usage (a Claude Code
// usage cache, a Codex session, an opencode config with a self-hosted
// provider) in a temp dir, and the headless `herdr-dash routing preview`.
// Artifacts land in e2e/artifacts/routing-*.
//
// Ways this could fail, written before the feature existed:
//  R1. The page and the CLI disagree, or the preview ignores usage: an
//      exhausted Claude window (95%) is chosen, or unknown usage is free.
//  R2. Reorder does not stick: drag or the keyboard buttons change the
//      screen but not the saved order, focus is lost after a keyboard move,
//      or a reload shows the old order.
//  R3. Scope inheritance is wrong: a project without its own list does not
//      show the inherited one (read-only), an override does not win in the
//      preview, a thread does not inherit from its project, or "Reset to
//      inherited" leaves the override behind.
//  R4. A save from a stale tab overwrites another tab's save (last writer
//      wins) instead of a visible conflict with a way to reload.
//  R5. Saving runs herdr-projects or herdr (a launch, restart, stop or
//      keys): saving must only write routing.toml.
//  R6. Saving drops fields Dash does not edit (reserved caps), or leaves
//      the file with other permissions than 0600.
//  R7. The write path skips the guard (cross-origin, non-JSON, read-only),
//      accepts unknown profiles, ops or fields, or answers a stale revision
//      with success.
//  R8. An invalid routing.toml half-loads: the panel lets you save over it,
//      or the preview routes instead of saying invalid.
//  R9. On a phone the window overflows sideways.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, repo, startServer, waitFor, post, stubLogger, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-routing-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- fixtures
const cfgDir = join(tmp, "config", "herdr-projects");
mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
const policyPath = join(cfgDir, "routing.toml");
const ORIGINAL = `# written by hand
version = 1

[global]
enabled = true

[[global.modes.coding]]
provider = "claude"
profile = "claude"
model = "claude-opus-test"

[[global.modes.coding]]
provider = "codex"
profile = "codex"

[[global.modes.planning]]
provider = "codex"
profile = "astra"

[[global.modes.crawl]]
provider = "opencode"
profile = "opencode"

[projects.alpha.caps]
max_active = 1
`;
writeFileSync(policyPath, ORIGINAL, { mode: 0o600 });
writeFileSync(join(artifacts, "routing-policy-before.toml"), ORIGINAL);

const profilesPath = join(tmp, "profiles.toml");
writeFileSync(profilesPath, `[profiles.astra]\nagent = "codex"\nmodel = "gpt-astra-test"\n\n[profiles.codex-high]\nagent = "codex"\n`);

// Claude: Claude Code's own cached /usage answer, fresh, 5h window at 95%.
mkdirSync(join(tmp, "claude-home"));
const claudeState = join(tmp, "claude.json");
writeFileSync(claudeState, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now - 30_000, utilization: {
  five_hour: { utilization: 95, resets_at: iso(now + 3600_000) },
  seven_day: { utilization: 40, resets_at: iso(now + 3 * 86400_000) } } } }));
// Codex: a session that saw its rate limits a minute ago.
const codexDay = join(tmp, "codex", "2026", "11", "03");
mkdirSync(codexDay, { recursive: true });
writeFileSync(join(codexDay, "rollout-2026-11-03T08-00-00-33333333-3333-3333-3333-333333333333.jsonl"), JSON.stringify({
  timestamp: iso(now - 60_000), type: "event_msg", payload: { type: "token_count", rate_limits: {
    primary: { used_percent: 20, window_minutes: 300, resets_at: Math.floor((now + 2 * 3600_000) / 1000) },
    secondary: { used_percent: 35, window_minutes: 10080, resets_at: Math.floor((now + 3 * 86400_000) / 1000) },
    plan_type: "pro" } } }) + "\n");
// opencode: a self-hosted provider (no balance API, no per-token cost).
const ocDir = join(tmp, "opencode");
mkdirSync(ocDir);
writeFileSync(join(ocDir, "opencode.json"), JSON.stringify({ model: "gpu-box/qwen3-test",
  provider: { "gpu-box": { name: "GPU box", options: { baseURL: "http://127.0.0.1:9/v1" } } } }));

const serverArgs = [
  "--routing-config", policyPath,
  "--session-profiles", profilesPath,
  "--claude-home", join(tmp, "claude-home"),
  "--claude-state", claudeState,
  "--codex-dir", join(tmp, "codex"),
  "--opencode-config", ocDir,
  "--opencode-data", join(tmp, "opencode-data"),
  "--write-burst", "100", "--write-per-min", "600",
];
const usageEnv = { HERDR_DASH_USAGE: "claude,codex,opencode", HERDR_DASH_CLAUDE_USAGE_URL: "http://127.0.0.1:9/never" };
const assertions = [];
const record = (name, ok, detail = {}) => assertions.push({ name, ok, ...detail });

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, serverArgs, usageEnv);
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  writeFileSync(join(artifacts, "routing-assertions.json"), JSON.stringify(assertions, null, 2));
  try { writeFileSync(join(artifacts, "routing-policy-after.toml"), readFileSync(policyPath)); } catch {}
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const getState = async () => (await fetch(url + "/api/routing")).json();
const preview = async (body) => post(url, "/api/routing/preview", body);
function cli(...args) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^HERDR_DASH_/.test(k)) delete base[k];
  const out = execFileSync(join(repo, "bin/herdr-dash"), ["routing", "preview", "--json", "--root", join(td, "root"), ...serverArgs, ...args],
    { env: { ...base, ...usageEnv } });
  return JSON.parse(out.toString());
}

async function openPage(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...opts });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
async function openPanel(page) {
  await page.click("#routing-open");
  await page.waitForSelector('.hwin[data-win="routing"] .rt-mode[data-mode="coding"]');
  return page.locator('.hwin[data-win="routing"]');
}
const order = (page, mode) => page.$$eval(`.hwin[data-win="routing"] .rt-mode[data-mode="${mode}"] .rt-card`, (els) => els.map((e) => e.dataset.profile));
const saveAndWait = async (page) => {
  await page.click("#rt-save");
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#rt-status")?.textContent || ""));
};
const fileOrder = (mode) => {
  const t = readFileSync(policyPath, "utf8");
  return [...t.matchAll(new RegExp(`\\[\\[global\\.modes\\.${mode}\\]\\][^\\[]*?profile = '([^']+)'`, "g"))].map((m) => m[1]);
};

test("API and CLI preview the same choice from usage (R1)", async () => {
  const st = await getState();
  assert.equal(st.valid, true, JSON.stringify(st.errors));
  assert.notEqual(st.revision, "none");
  assert.deepEqual(st.policy.global.modes.coding.map((c) => c.profile), ["claude", "codex"]);
  const byId = Object.fromEntries(st.providers.map((p) => [p.id, p.usage]));
  assert.equal(byId.claude.status, "ok");
  assert.equal(byId.claude.windows[0].used_percent, 95);
  assert.equal(byId.codex.status, "ok");
  assert.equal(byId.opencode.model, "gpu-box/qwen3-test");
  assert.ok(st.warnings.some((w) => w.field === "projects.alpha.caps"), "caps reported as not enforced");
  assert.match(st.enforcement.subagents, /not enforced/);

  const { status, json: d } = await preview({ project: "alpha", mode: "coding" });
  assert.equal(status, 200);
  assert.equal(d.outcome, "select");
  assert.equal(d.selected.profile, "codex");
  assert.equal(d.candidates[0].code, "near_limit");
  assert.match(d.candidates[0].reason, /95%/);
  const c = cli("--project", "alpha", "--mode", "coding");
  assert.equal(c.outcome, d.outcome);
  assert.equal(c.selected.profile, d.selected.profile);
  assert.deepEqual(c.candidates.map((x) => x.code), d.candidates.map((x) => x.code));

  assert.equal((await preview({ project: "alpha", mode: "crawl" })).json.selected.profile, "opencode");
  assert.equal((await preview({ project: "alpha", mode: "planning" })).json.selected.profile, "astra");
  assert.equal((await preview({ project: "alpha", mode: "summary" })).status, 400);
  assert.equal((await preview({ project: "nope", mode: "coding" })).status, 404);
  record("api-cli-agree", true, { selected: d.selected.profile, skipped: d.candidates[0].reason });
});

test("write guard, typed patch and revisions (R7)", async () => {
  const before = readFileSync(policyPath, "utf8");
  const { revision } = await getState();
  const op = { op: "set_mode", scope: {}, mode: "coding", candidates: [{ provider: "codex", profile: "codex" }] };
  assert.equal((await post(url, "/api/routing", { expected_revision: revision, ops: [op] }, { Origin: "http://evil.example" })).status, 403);
  const r = await fetch(url + "/api/routing", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ expected_revision: revision, ops: [op] }) });
  assert.equal(r.status, 415);
  assert.equal((await post(url, "/api/routing", { expected_revision: revision, ops: [op], extra: 1 })).status, 400);
  assert.equal((await post(url, "/api/routing", { ops: [op] })).status, 400);
  const unknownProfile = await post(url, "/api/routing", { expected_revision: revision, ops: [{ ...op, candidates: [{ provider: "codex", profile: "nope" }] }] });
  assert.equal(unknownProfile.status, 422);
  assert.equal(unknownProfile.json.fields[0].field, "ops[0].candidates[0].profile");
  const metered = await post(url, "/api/routing", { expected_revision: revision, ops: [{ ...op, candidates: [{ provider: "refuseless", profile: "codex" }] }] });
  assert.equal(metered.status, 422);
  assert.match(metered.json.error, /metered/);
  const stale = await post(url, "/api/routing", { expected_revision: "sha256:0000000000000000", ops: [op] });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "conflict");
  assert.equal(stale.json.state.revision, revision);
  assert.equal(readFileSync(policyPath, "utf8"), before, "refused writes left the file alone");
  record("guard", true);
});

test("keyboard reorder saves, keeps focus and runs nothing (R2, R5, R6)", async () => {
  const page = await openPage();
  await openPanel(page);
  assert.deepEqual(await order(page, "coding"), ["claude", "codex"]);
  const claudeUsage = await page.textContent('.rt-mode[data-mode="coding"] .rt-card[data-profile="claude"] .rt-usage');
  assert.match(claudeUsage, /95%/);
  await page.screenshot({ path: join(artifacts, "routing-global.png") });

  const mark = log.mark();
  await page.click('.rt-mode[data-mode="coding"] .rt-card[data-profile="codex"] .rt-up');
  assert.deepEqual(await order(page, "coding"), ["codex", "claude"]);
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".rt-card")?.dataset.profile), "codex", "focus follows the moved card");
  // Keyboard only: move it back down with Enter on the focused card's button.
  await page.focus('.rt-mode[data-mode="coding"] .rt-card[data-profile="codex"] .rt-down');
  await page.keyboard.press("Enter");
  assert.deepEqual(await order(page, "coding"), ["claude", "codex"]);
  // At the bottom its down button is off, so focus moved to its up button.
  assert.equal(await page.evaluate(() => document.activeElement?.className), "rt-up");
  await page.keyboard.press("Enter");
  assert.deepEqual(await order(page, "coding"), ["codex", "claude"]);
  assert.match(await page.textContent("#rt-status"), /Unsaved/);
  await saveAndWait(page);
  assert.deepEqual(fileOrder("coding"), ["codex", "claude"]);
  const text = readFileSync(policyPath, "utf8");
  assert.match(text, /max_active = 1/, "reserved caps kept");
  assert.match(text, /claude-opus-test/, "model kept");
  if (process.platform !== "win32") assert.equal(statSync(policyPath).mode & 0o777, 0o600);
  assert.deepEqual(log.since(mark), [], "saving ran no herdr-projects or herdr command");
  assert.deepEqual(page.errors, []);
  record("keyboard-reorder", true, { order: fileOrder("coding"), commands_on_save: log.since(mark) });
  await page.close();
});

test("drag reorder saves and survives a reload (R2)", async () => {
  const page = await openPage();
  await openPanel(page);
  assert.deepEqual(await order(page, "coding"), ["codex", "claude"]);
  const mark = log.mark();
  const claude = page.locator('.rt-mode[data-mode="coding"] .rt-card[data-profile="claude"]');
  const codex = page.locator('.rt-mode[data-mode="coding"] .rt-card[data-profile="codex"]');
  await claude.dragTo(codex, { targetPosition: { x: 20, y: 3 } });
  assert.deepEqual(await order(page, "coding"), ["claude", "codex"]);
  await saveAndWait(page);
  assert.deepEqual(fileOrder("coding"), ["claude", "codex"]);
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await openPanel(page);
  assert.deepEqual(await order(page, "coding"), ["claude", "codex"]);
  assert.deepEqual(log.since(mark), []);
  assert.deepEqual(page.errors, []);
  record("drag-reorder", true, { order: fileOrder("coding") });
  await page.close();
});

test("project override, thread inheritance, reset to inherited (R3)", async () => {
  const page = await openPage();
  const win = await openPanel(page);
  const mark = log.mark();
  await page.click('[role="tab"][data-scope="project"]');
  await page.selectOption("#rt-project", "alpha");
  const coding = win.locator('.rt-mode[data-mode="coding"]');
  assert.match(await coding.locator(".rt-src").textContent(), /Inherited from global/);
  assert.equal(await coding.locator(".rt-up").count(), 0, "inherited list is read-only");
  assert.deepEqual(await order(page, "coding"), ["claude", "codex"]);

  await coding.locator(".rt-override").click();
  assert.match(await coding.locator(".rt-src").textContent(), /Set here/);
  await coding.locator('.rt-card[data-profile="claude"] .rt-del').click();
  assert.deepEqual(await order(page, "coding"), ["codex"]);
  await saveAndWait(page);
  let st = await getState();
  assert.deepEqual(st.policy.projects.alpha.modes.coding.map((c) => c.profile), ["codex"]);
  assert.ok(readFileSync(policyPath, "utf8").includes("max_active = 1"));

  // Why this choice? for the project, from the saved policy.
  await page.selectOption("#rt-pv-project", "alpha");
  await page.selectOption("#rt-pv-mode", "coding");
  await page.click("#rt-why");
  await page.waitForSelector("#rt-pv .rt-pv-outcome");
  assert.match(await page.textContent("#rt-pv .rt-pv-outcome"), /codex/);
  assert.match(await page.textContent("#rt-pv"), /project list/);
  await page.screenshot({ path: join(artifacts, "routing-project-why.png") });

  // A thread inherits per mode: coding from its project, planning from global.
  await page.click('[role="tab"][data-scope="thread"]');
  await page.selectOption("#rt-project", "alpha");
  await page.selectOption("#rt-thread", "t-0002");
  assert.match(await win.locator('.rt-mode[data-mode="coding"] .rt-src').textContent(), /Inherited from project/);
  assert.match(await win.locator('.rt-mode[data-mode="planning"] .rt-src').textContent(), /Inherited from global/);
  assert.deepEqual(await order(page, "coding"), ["codex"]);

  // Reset the project override: the global list applies again.
  await page.click('[role="tab"][data-scope="project"]');
  await page.selectOption("#rt-project", "alpha");
  await coding.locator(".rt-reset").click();
  assert.match(await coding.locator(".rt-src").textContent(), /Inherited from global/);
  await saveAndWait(page);
  st = await getState();
  assert.equal(st.policy.projects.alpha?.modes?.coding, undefined, "override removed");
  assert.ok(readFileSync(policyPath, "utf8").includes("max_active = 1"), "caps kept through the reset");
  const d = (await preview({ project: "alpha", mode: "coding" })).json;
  assert.equal(d.list_from, "global");

  // Routing off for one project: the preview falls back to legacy.
  await page.selectOption("#rt-enabled", "off");
  await saveAndWait(page);
  const off = (await preview({ project: "alpha", mode: "coding" })).json;
  assert.equal(off.outcome, "legacy");
  assert.match(off.reason, /codex-high/);
  await page.selectOption("#rt-enabled", "inherit");
  await saveAndWait(page);
  assert.equal((await preview({ project: "alpha", mode: "coding" })).json.outcome, "select");
  assert.deepEqual(log.since(mark), []);
  assert.deepEqual(page.errors, []);
  record("scopes", true);
  await page.close();
});

test("two tabs: the stale save conflicts and can reload (R4)", async () => {
  const a = await openPage();
  const b = await openPage();
  await openPanel(a);
  await openPanel(b);
  await a.click('.rt-mode[data-mode="coding"] .rt-card[data-profile="codex"] .rt-up');
  await saveAndWait(a);
  assert.deepEqual(fileOrder("coding"), ["codex", "claude"]);

  await b.click('.rt-mode[data-mode="coding"] .rt-card[data-profile="codex"] .rt-del');
  await b.click("#rt-save");
  await b.waitForSelector("#rt-alert:not([hidden])");
  assert.match(await b.textContent("#rt-alert"), /changed/i);
  await b.screenshot({ path: join(artifacts, "routing-conflict.png") });
  assert.deepEqual(fileOrder("coding"), ["codex", "claude"], "stale tab did not overwrite");
  await b.click("#rt-reload");
  await b.waitForSelector("#rt-alert", { state: "hidden" });
  assert.deepEqual(await order(b, "coding"), ["codex", "claude"]);
  assert.doesNotMatch(await b.textContent("#rt-status"), /Unsaved/);
  record("conflict", true);
  await a.close();
  await b.close();
});

test("an invalid file blocks saving and previews as invalid (R8)", async () => {
  const good = readFileSync(policyPath, "utf8");
  writeFileSync(policyPath, "version = 7\n[global]\nenabled = true\n", { mode: 0o600 });
  try {
    const st = await getState();
    assert.equal(st.valid, false);
    assert.equal(st.errors[0].field, "version");
    const page = await openPage();
    await openPanel(page);
    await page.waitForSelector("#rt-errors:not([hidden])");
    assert.match(await page.textContent("#rt-errors"), /version/);
    assert.equal(await page.isDisabled("#rt-save"), true);
    assert.equal((await preview({ project: "alpha", mode: "coding" })).json.outcome, "invalid");
    assert.equal(cli("--project", "alpha", "--mode", "coding").outcome, "invalid");
    assert.equal(readFileSync(policyPath, "utf8"), "version = 7\n[global]\nenabled = true\n");
    await page.close();
  } finally {
    writeFileSync(policyPath, good, { mode: 0o600 });
  }
  record("invalid-file", true);
});

test("read-only mode refuses saves but still previews (R7)", async () => {
  const port = await freePort();
  const ro = startServer(port, stubLog, [...serverArgs, "--read-only"], usageEnv);
  const u = `http://127.0.0.1:${port}`;
  try {
    const st = await waitFor(async () => (await fetch(u + "/api/routing")).json());
    const res = await post(u, "/api/routing", { expected_revision: st.revision, ops: [{ op: "reset_mode", scope: {}, mode: "crawl" }] });
    assert.equal(res.status, 403);
    assert.equal((await post(u, "/api/routing/preview", { project: "alpha", mode: "crawl" })).status, 200);
  } finally {
    ro.kill();
  }
  record("read-only", true);
});

test("phone: the window fits the screen (R9)", async () => {
  const page = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.click("#routing-open");
  await page.waitForSelector('.hwin[data-win="routing"] .rt-card');
  const over = await page.evaluate(() => {
    const w = document.querySelector('.hwin[data-win="routing"]');
    const r = w.getBoundingClientRect();
    return { right: r.right, vw: innerWidth, scroll: w.querySelector(".hw-body").scrollWidth - w.querySelector(".hw-body").clientWidth };
  });
  assert.ok(over.right <= over.vw + 1, JSON.stringify(over));
  assert.ok(over.scroll <= 1, JSON.stringify(over));
  await page.screenshot({ path: join(artifacts, "routing-phone.png") });
  assert.deepEqual(page.errors, []);
  record("phone", true, over);
  await page.close();
});
