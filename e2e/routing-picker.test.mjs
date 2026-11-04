// E2E for the Routing window's model picker: candidates are picked from a
// list (a herdr-projects profile, or provider → model from what each
// harness offers), with a reasoning (effort) and a context-window selector
// per candidate, and an "Other…" entry for anything the catalog does not
// know. Runs the real herdr-dash against fake profiles, a fake Codex config
// and a fake opencode config in a temp dir; no routing.toml at the start.
// Artifacts land in e2e/artifacts/routing-picker-*.
//
// Ways this could fail, written before the feature existed:
//  P1. Adding a candidate still needs typing: provider → model → reasoning
//      → context cannot be done by clicks and selects alone.
//  P2. The picker offers what a harness cannot do: an effort level the
//      harness lacks (max for Codex, any effort for opencode), a context
//      choice for a model with one size, or none for one with two.
//  P3. Defaults lie: the effort selector does not default to the profile's
//      effort, or a default is written into routing.toml as if chosen.
//  P4. Friendly names hide the truth: the raw profile/model id is not
//      shown, or a profile's own model is replaced by a guess.
//  P5. Type-to-filter or the keyboard path does not work: no filtering,
//      arrows/Enter do nothing, Escape does not close or loses focus.
//  P6. "Other…" loses input (unknown model cannot be added) or accepts
//      junk (spaces, empty) without saying why.
//  P7. Effort and context are dropped on save, reload or reorder (drag or
//      buttons), or two candidates of one profile cannot coexist.
//  P8. The server accepts what the harness does not support (API or a hand
//      edit) instead of naming the field; old version 1 files stop loading.
//  P9. With no routing.toml the window prints a stray "null".
// P10. On a phone the picker is not a sheet that fits the screen.
// P11. The preview drops effort/context, or claims they already apply.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-picker-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- fixtures
const cfgDir = join(tmp, "config", "herdr-projects");
mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
const policyPath = join(cfgDir, "routing.toml"); // not created: P9

const profilesPath = join(tmp, "profiles.toml");
writeFileSync(profilesPath, `[defaults]
thread_profile = "builder"

[profiles.builder]
agent = "claude"
model = "claude-opus-5-5"
effort = "medium"
description = "Claude Opus 5.5 for building"

[profiles.planner]
agent = "codex"
model = "gpt-test-planner"
effort = "high"
description = "Codex planner at high effort"

[profiles.local]
agent = "opencode"
model = "gpu-box/qwen3-test"

[profiles.odd]
agent = "gemini"
`);

mkdirSync(join(tmp, "claude-home"));
const claudeState = join(tmp, "claude.json");
writeFileSync(claudeState, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now - 30_000, utilization: {
  five_hour: { utilization: 20, resets_at: iso(now + 3600_000) },
  seven_day: { utilization: 30, resets_at: iso(now + 3 * 86400_000) } } } }));
// Codex: config.toml beside the sessions dir names a model and its window.
const codexSessions = join(tmp, "codex", "sessions");
const codexDay = join(codexSessions, "2026", "11", "04");
mkdirSync(codexDay, { recursive: true });
writeFileSync(join(tmp, "codex", "config.toml"), `model = "gpt-test-codex"\nmodel_reasoning_effort = "medium"\nmodel_context_window = 272000\n`);
writeFileSync(join(codexDay, "rollout-2026-11-04T08-00-00-44444444-4444-4444-4444-444444444444.jsonl"), JSON.stringify({
  timestamp: iso(now - 60_000), type: "event_msg", payload: { type: "token_count", rate_limits: {
    primary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor((now + 2 * 3600_000) / 1000) },
    plan_type: "pro" } } }) + "\n");
// opencode: a self-hosted provider with one model and its context limit.
const ocDir = join(tmp, "opencode");
mkdirSync(ocDir);
writeFileSync(join(ocDir, "opencode.json"), JSON.stringify({ model: "gpu-box/qwen3-test",
  provider: { "gpu-box": { name: "GPU box", options: { baseURL: "http://127.0.0.1:9/v1" },
    models: { "qwen3-test": { name: "Qwen3 Test", limit: { context: 131072 } } } } } }));

const serverArgs = [
  "--routing-config", policyPath,
  "--session-profiles", profilesPath,
  "--claude-home", join(tmp, "claude-home"),
  "--claude-state", claudeState,
  "--codex-dir", codexSessions,
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
  writeFileSync(join(artifacts, "routing-picker-assertions.json"), JSON.stringify(assertions, null, 2));
  try { writeFileSync(join(artifacts, "routing-picker-policy.toml"), readFileSync(policyPath)); } catch {}
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const getState = async () => (await fetch(url + "/api/routing")).json();
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
const mode = (page, m) => page.locator(`.hwin[data-win="routing"] .rt-mode[data-mode="${m}"]`);
const cards = (page, m) => page.$$eval(`.hwin[data-win="routing"] .rt-mode[data-mode="${m}"] .rt-card`, (els) => els.map((e) => e.dataset.key));
const visibleOptions = (page) => page.$$eval("#rt-pick .rt-opt", (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.pick));
const optionValues = (loc) => loc.evaluate((s) => [...s.options].map((o) => o.value));
const saveAndWait = async (page) => {
  await page.click("#rt-save");
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#rt-status")?.textContent || ""));
};

test("catalog: harness efforts, model contexts, profiles with friendly names (P2, P4)", async () => {
  const st = await getState();
  assert.equal(st.exists, false);
  const cat = Object.fromEntries(st.catalog.map((h) => [h.id, h]));
  assert.deepEqual(cat.claude.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(cat.codex.efforts, ["minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(cat.opencode.efforts, []);
  const opus = cat.claude.models.find((m) => m.id === "claude-opus-5-5");
  assert.equal(opus.label, "Claude Opus 5.5");
  assert.deepEqual(opus.contexts, [200000, 1000000]);
  const codexCfg = cat.codex.models.find((m) => m.id === "gpt-test-codex");
  assert.deepEqual(codexCfg.contexts, [272000], "Codex config window");
  assert.ok(cat.codex.models.some((m) => m.id === "gpt-test-planner"), "profile models are offered");
  const qwen = cat.opencode.models.find((m) => m.id === "gpu-box/qwen3-test");
  assert.match(qwen.label, /Qwen3 Test/);
  assert.match(qwen.label, /opencode/);
  assert.deepEqual(qwen.contexts, [131072]);
  const planner = st.profiles.find((p) => p.name === "planner");
  assert.equal(planner.effort, "high");
  assert.equal(planner.description, "Codex planner at high effort");
  assert.ok(planner.label, "profiles carry a friendly label");
  record("catalog", true, { claude: cat.claude.efforts, codex: cat.codex.efforts });
});

test("no routing.toml: no stray null (P9)", async () => {
  const page = await openPage();
  const win = await openPanel(page);
  const text = await win.locator(".hw-body").innerText();
  assert.doesNotMatch(text, /\bnull\b/, text.slice(0, 400));
  assert.match(text, /not created yet/);
  await page.screenshot({ path: join(artifacts, "routing-picker-empty.png") });
  record("no-null", true);
  await page.close();
});

test("provider → model → reasoning → context with no typing; profile pick; reorder; save; reload (P1, P3, P4, P7, P11)", async () => {
  const page = await openPage();
  await openPanel(page);
  const mark = log.mark();
  const coding = mode(page, "coding");

  // Provider → model: Claude Opus 5.5, by clicks only.
  await coding.locator(".rt-add-btn").click();
  await page.waitForSelector("#rt-pick:not([hidden])");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "rt-pick-q", "search is focused");
  const fits = await page.evaluate(() => { const r = document.querySelector("#rt-pick").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; });
  assert.ok(fits, "the popover stays on screen");
  // A profile of a harness Dash cannot route is shown, but not pickable.
  assert.equal(await page.getAttribute('#rt-pick .rt-opt[data-pick="profile:odd"]', "aria-disabled"), "true");
  await page.screenshot({ path: join(artifacts, "routing-picker-open.png") });
  const opusOpt = page.locator('#rt-pick .rt-opt[data-pick="model:claude:claude-opus-5-5"]');
  assert.match(await opusOpt.locator(".rt-opt-label").textContent(), /Claude Opus 5\.5/);
  assert.match(await opusOpt.locator(".rt-opt-id").textContent(), /claude-opus-5-5/);
  await opusOpt.click();
  await page.waitForSelector("#rt-pick", { state: "hidden" });
  const opus = coding.locator('.rt-card[data-key="claude|claude-opus-5-5"]');
  assert.match(await opus.locator(".rt-label").textContent(), /Claude Opus 5\.5/);
  assert.match(await opus.locator(".rt-raw").textContent(), /claude-opus-5-5/);
  // Reasoning: only Claude's levels; default first. Context: 200k or 1M.
  assert.deepEqual(await optionValues(opus.locator("select.rt-effort")), ["", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(await optionValues(opus.locator("select.rt-context")), ["", "200000", "1000000"]);
  await opus.locator("select.rt-effort").selectOption("high");
  await opus.locator("select.rt-context").selectOption("1000000");

  // A profile: Codex planner. Effort defaults to the profile's own (high).
  await coding.locator(".rt-add-btn").click();
  await page.click('#rt-pick .rt-opt[data-pick="profile:planner"]');
  const planner = coding.locator('.rt-card[data-key="planner|"]');
  assert.match(await planner.locator(".rt-raw").textContent(), /planner/);
  assert.match(await planner.locator(".rt-raw").textContent(), /gpt-test-planner/);
  assert.deepEqual(await optionValues(planner.locator("select.rt-effort")), ["", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(await planner.locator("select.rt-effort").inputValue(), "");
  assert.match(await planner.locator("select.rt-effort option[value='']").textContent(), /high/);
  // Unknown context for a model the catalog does not size: said, not guessed.
  assert.match(await planner.locator(".rt-ctx-fixed").textContent(), /unknown/i);

  // The same harness twice: Codex's configured model with one context size.
  await coding.locator(".rt-add-btn").click();
  await page.click('#rt-pick .rt-opt[data-pick="model:codex:gpt-test-codex"]');
  const codexCard = coding.locator('.rt-card[data-key="codex|gpt-test-codex"]');
  assert.equal(await codexCard.locator("select.rt-context").count(), 0, "one size: no selector");
  assert.match(await codexCard.locator(".rt-ctx-fixed").textContent(), /272k/);

  // The note says reasoning/context are stored, not applied yet.
  assert.match(await coding.locator(".rt-applies").textContent(), /applies when the launch hook lands/);
  assert.deepEqual(await cards(page, "coding"), ["claude|claude-opus-5-5", "planner|", "codex|gpt-test-codex"]);

  // Reorder by button and by drag; effort/context travel with the card.
  await codexCard.locator(".rt-up").click();
  assert.deepEqual(await cards(page, "coding"), ["claude|claude-opus-5-5", "codex|gpt-test-codex", "planner|"]);
  await coding.locator('.rt-card[data-key="planner|"]').dragTo(opus, { targetPosition: { x: 20, y: 3 } });
  assert.deepEqual(await cards(page, "coding"), ["planner|", "claude|claude-opus-5-5", "codex|gpt-test-codex"]);
  assert.equal(await opus.locator("select.rt-effort").inputValue(), "high");
  assert.equal(await opus.locator("select.rt-context").inputValue(), "1000000");
  await page.screenshot({ path: join(artifacts, "routing-picker-cards.png") });

  await page.selectOption("#rt-enabled", "on");
  await saveAndWait(page);
  const text = readFileSync(policyPath, "utf8");
  assert.match(text, /effort = 'high'/);
  assert.match(text, /context = 1000000/);
  const st = await getState();
  const list = st.policy.global.modes.coding;
  assert.deepEqual(list.map((c) => [c.profile, c.model || "", c.effort || "", c.context || 0]),
    [["planner", "", "", 0], ["claude", "claude-opus-5-5", "high", 1000000], ["codex", "gpt-test-codex", "", 0]],
    "defaults are not written as choices");

  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await openPanel(page);
  assert.deepEqual(await cards(page, "coding"), ["planner|", "claude|claude-opus-5-5", "codex|gpt-test-codex"]);
  assert.equal(await opus.locator("select.rt-effort").inputValue(), "high");
  assert.equal(await opus.locator("select.rt-context").inputValue(), "1000000");

  // The preview carries effort and context, and says they do not apply yet.
  await page.selectOption("#rt-pv-project", "alpha");
  await page.selectOption("#rt-pv-mode", "coding");
  await page.click("#rt-why");
  await page.waitForSelector("#rt-pv .rt-pv-outcome");
  const pvText = await page.textContent("#rt-pv");
  assert.match(pvText, /high/);
  assert.match(pvText, /1M/);
  assert.match(pvText, /applies when the launch hook lands/);
  await page.screenshot({ path: join(artifacts, "routing-picker-preview.png") });

  assert.deepEqual(log.since(mark), [], "saving ran no herdr-projects or herdr command");
  assert.deepEqual(page.errors, []);
  record("pick-no-typing", true, { saved: list });
  await page.close();
});

test("type-to-filter and keyboard: arrows, Enter, Escape (P5)", async () => {
  const page = await openPage();
  await openPanel(page);
  const crawl = mode(page, "crawl");
  // Global crawl has no list yet: Add starts one.
  const add = crawl.locator(".rt-add-btn");
  await add.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#rt-pick:not([hidden])");
  await page.keyboard.type("qwen");
  const vis = await visibleOptions(page);
  assert.deepEqual(vis, ["profile:local", "model:opencode:gpu-box/qwen3-test"]);
  // The first match is active; ArrowDown moves to the next; Enter picks it.
  assert.equal(await page.getAttribute("#rt-pick-q", "aria-activedescendant"), await page.getAttribute('#rt-pick .rt-opt[data-pick="profile:local"]', "id"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#rt-pick", { state: "hidden" });
  assert.deepEqual(await cards(page, "crawl"), ["opencode|gpu-box/qwen3-test"]);
  const qcard = crawl.locator('.rt-card[data-key="opencode|gpu-box/qwen3-test"]');
  assert.equal(await qcard.locator("select.rt-effort").count(), 0, "opencode has no effort setting");
  assert.match(await qcard.locator(".rt-effort-na").textContent(), /no reasoning setting/i);
  assert.match(await qcard.locator(".rt-ctx-fixed").textContent(), /131k|128k/);

  // Escape closes and gives focus back to Add.
  await crawl.locator(".rt-add-btn").click();
  await page.waitForSelector("#rt-pick:not([hidden])");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#rt-pick", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("rt-add-btn")), true);
  await page.click("#rt-discard");
  assert.deepEqual(page.errors, []);
  record("keyboard-filter", true, { filtered: vis });
  await page.close();
});

test("Other…: free text, validated, nothing lost (P6)", async () => {
  const page = await openPage();
  await openPanel(page);
  const planning = mode(page, "planning");
  await planning.locator(".rt-add-btn").click();
  await page.click('#rt-pick .rt-opt[data-pick="other:codex"]');
  await page.waitForSelector("#rt-other:not([hidden])");
  await page.fill("#rt-other-model", "bad model!");
  await page.click("#rt-other-add");
  assert.match(await page.textContent("#rt-other-msg"), /model/i);
  assert.equal(await page.isVisible("#rt-pick"), true, "still open, input kept");
  assert.equal(await page.inputValue("#rt-other-model"), "bad model!");
  await page.fill("#rt-other-model", "gpt-test-other");
  await page.click("#rt-other-add");
  await page.waitForSelector("#rt-pick", { state: "hidden" });
  const card = planning.locator('.rt-card[data-key="codex|gpt-test-other"]');
  assert.match(await card.locator(".rt-raw").textContent(), /gpt-test-other/);
  assert.match(await card.locator(".rt-ctx-fixed").textContent(), /unknown/i);
  await card.locator("select.rt-effort").selectOption("xhigh");
  await saveAndWait(page);
  const st = await getState();
  assert.deepEqual(st.policy.global.modes.planning, [{ provider: "codex", profile: "codex", model: "gpt-test-other", effort: "xhigh" }]);
  assert.deepEqual(page.errors, []);
  record("other", true);
  await page.close();
});

test("the server names unsupported effort/context fields (P8)", async () => {
  const { revision } = await getState();
  const set = (c) => post(url, "/api/routing", { expected_revision: revision, ops: [{ op: "set_mode", scope: {}, mode: "crawl", candidates: [c] }] });
  let r = await set({ provider: "codex", profile: "codex", effort: "max" });
  assert.equal(r.status, 422);
  assert.equal(r.json.fields[0].field, "ops[0].candidates[0].effort");
  assert.match(r.json.fields[0].message, /minimal, low, medium, high, xhigh/);
  r = await set({ provider: "opencode", profile: "opencode", effort: "high" });
  assert.equal(r.status, 422);
  assert.match(r.json.fields[0].message, /no reasoning/);
  r = await set({ provider: "claude", profile: "claude", model: "claude-opus-5-5", context: 500000 });
  assert.equal(r.status, 422);
  assert.equal(r.json.fields[0].field, "ops[0].candidates[0].context");
  assert.match(r.json.fields[0].message, /200k or 1M/);
  // The profile's model counts too: builder runs Opus 5.5.
  r = await set({ provider: "claude", profile: "builder", context: 123456 });
  assert.equal(r.status, 422);
  r = await set({ provider: "codex", profile: "codex", model: "has space" });
  assert.equal(r.status, 422);
  assert.equal(r.json.fields[0].field, "ops[0].candidates[0].model");
  assert.equal((await getState()).revision, revision, "nothing written");

  // A hand edit with an unsupported effort: invalid, the field is named.
  const good = readFileSync(policyPath, "utf8");
  writeFileSync(policyPath, `version = 1\n\n[[global.modes.coding]]\nprovider = "claude"\nprofile = "claude"\neffort = "turbo"\ncontext = 12\n`, { mode: 0o600 });
  try {
    const st = await getState();
    assert.equal(st.valid, false);
    const fields = st.errors.map((e) => e.field);
    assert.ok(fields.includes("global.modes.coding[0].effort"), JSON.stringify(st.errors));
    assert.ok(fields.includes("global.modes.coding[0].context"), JSON.stringify(st.errors));
    const page = await openPage();
    await openPanel(page);
    await page.waitForSelector("#rt-errors:not([hidden])");
    assert.match(await page.textContent("#rt-errors"), /effort/);
    await page.close();
  } finally {
    writeFileSync(policyPath, good, { mode: 0o600 });
  }
  // A stage-1 file (no effort/context) still loads.
  writeFileSync(policyPath, `version = 1\n\n[[global.modes.coding]]\nprovider = "claude"\nprofile = "claude"\nmodel = "claude-opus-test"\n`, { mode: 0o600 });
  try {
    assert.equal((await getState()).valid, true);
  } finally {
    writeFileSync(policyPath, good, { mode: 0o600 });
  }
  record("server-validation", true);
});

test("phone: the picker is a sheet that fits (P10)", async () => {
  const page = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.click("#routing-open");
  await page.waitForSelector('.hwin[data-win="routing"] .rt-mode[data-mode="coding"] .rt-card');
  await mode(page, "coding").locator(".rt-add-btn").tap();
  await page.waitForSelector("#rt-pick.sheet:not([hidden])");
  const box = await page.evaluate(() => {
    const r = document.querySelector("#rt-pick").getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom, top: r.top, vw: innerWidth, vh: innerHeight, scroll: document.documentElement.scrollWidth - innerWidth };
  });
  assert.ok(box.left >= -1 && box.right <= box.vw + 1, JSON.stringify(box));
  assert.ok(Math.abs(box.bottom - box.vh) <= 2, "sheet sits at the bottom: " + JSON.stringify(box));
  assert.ok(box.top >= 0, JSON.stringify(box));
  assert.ok(box.scroll <= 1, JSON.stringify(box));
  await page.screenshot({ path: join(artifacts, "routing-picker-phone.png") });
  await page.locator('#rt-pick .rt-opt[data-pick="model:claude:claude-sonnet-5-5"]').tap();
  await page.waitForSelector("#rt-pick", { state: "hidden" });
  assert.ok((await cards(page, "coding")).includes("claude|claude-sonnet-5-5"));
  const over = await page.evaluate(() => {
    const b = document.querySelector('.hwin[data-win="routing"] .hw-body');
    return b.scrollWidth - b.clientWidth;
  });
  assert.ok(over <= 1, "cards fit the phone: " + over);
  await page.screenshot({ path: join(artifacts, "routing-picker-phone-cards.png") });
  assert.deepEqual(page.errors, []);
  record("phone", true, box);
  await page.close();
});

test("the policy file stays the only thing written", () => {
  assert.ok(existsSync(policyPath));
});
