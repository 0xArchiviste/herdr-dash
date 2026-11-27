// E2E for the Routing window's catalog with many profiles and Codex's own
// model list: the effort levels and labels come from what each harness
// says it supports, and "Add candidate" works for every kind of pick.
// Runs the real herdr-dash against a fake profile set (several profiles
// share a model, one names a model and effort no catalog knows), a fake
// Codex models_cache.json and config.toml, in a temp dir. Artifacts land in
// e2e/artifacts/routing-catalog-*.
//
// Ways this could fail, written before the fix:
//  C1. Two sources name one model (two profiles, or a profile and the Codex
//      config) and the catalog sends "contexts": null; the picker throws and
//      "Add candidate" opens nothing.
//  C2. Codex efforts are a fixed guess (minimal…xhigh) instead of each
//      model's own levels from models_cache.json (max, ultra where listed).
//  C3. Claude efforts are not low…max.
//  C4. Labels are mangled ids ("Claude fable 5 2", "GPT 6.2 sol") instead of
//      Codex's display_name or a faithful reformat ("Claude Fable 5.2").
//  C5. A profile whose model and effort no catalog knows is hidden or not
//      selectable, or its effort is lost.
//  C6. A model Codex hides is offered though nothing names it.
//  C7. Adding by profile, by provider → model or by "Other…" fails in some
//      mode, or a pick logs a console error or a failing request.
//  C8. Save then reload drops effort/context, or the server refuses a level
//      the model supports (ultra on a model that lists it) or accepts one it
//      does not (ultra on a model that lacks it); a hand-edited file with a
//      Codex level stops loading.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-catalog-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- fixtures
const cfgDir = join(tmp, "config", "herdr-projects");
mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
const policyPath = join(cfgDir, "routing.toml");
// A policy like one saved before the new profiles were added.
writeFileSync(policyPath, `version = 1

[[projects.alpha.modes.coding]]
profile = 'builder'
provider = 'claude'
`, { mode: 0o600 });

const profiles = {
  builder: ["claude", "claude-opus-5-5", "medium"],
  "opus-high": ["claude", "claude-opus-5-5", "high"],
  sonnet: ["claude", "claude-sonnet-5-5", "medium"],
  haiku: ["claude", "claude-haiku-5-5", "low"],
  fable: ["claude", "claude-fable-5-2", "high"],
  "fable-max": ["claude", "claude-fable-5-2", "max"],
  "claude-odd": ["claude", "claude-test-unlisted", "turbo"],
  "sol-new": ["codex", "gpt-6.2-sol", "medium"],
  "sol-old": ["codex", "gpt-6.1-sol", "medium"],
  "astra-new": ["codex", "gpt-6.2-astra", "medium"],
  terra: ["codex", "gpt-6.1-terra", "high"],
  luna: ["codex", "gpt-6-luna", "low"],
  "codex-odd": ["codex", "gpt-test-unlisted", "turbo"],
  "codex-plain": ["codex", "", ""],
  "codex-hidden": ["codex", "gpt-test-hidden", ""],
  local: ["opencode", "gpu-box/qwen3-test", ""],
};
const profilesPath = join(tmp, "profiles.toml");
writeFileSync(profilesPath, `[defaults]\nthread_profile = "builder"\n\n` + Object.entries(profiles).map(([n, [agent, model, effort]]) =>
  `[profiles.${n}]\nagent = "${agent}"\n${model ? `model = "${model}"\n` : ""}${effort ? `effort = "${effort}"\n` : ""}description = "Test profile ${n}"\n`).join("\n"));

mkdirSync(join(tmp, "claude-home"));
const claudeState = join(tmp, "claude.json");
writeFileSync(claudeState, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now - 30_000, utilization: {
  five_hour: { utilization: 20, resets_at: iso(now + 3600_000) } } } }));
const codexHome = join(tmp, "codex");
const codexSessions = join(codexHome, "sessions");
mkdirSync(codexSessions, { recursive: true });
// The Codex config names a model a profile names too (C1), with no window.
writeFileSync(join(codexHome, "config.toml"), `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n`);
const lv = (...e) => e.map((effort) => ({ effort, description: `${effort} reasoning` }));
const ALL = ["low", "medium", "high", "xhigh", "max", "ultra"];
const NO_ULTRA = ["low", "medium", "high", "xhigh", "max"];
writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({ fetched_at: iso(now - 3600_000), etag: "test", client_version: "0.0.0", models: [
  { slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", default_reasoning_level: "low", supported_reasoning_levels: lv(...ALL), visibility: "list", context_window: 500000, priority: 1 },
  { slug: "gpt-6.2-astra", display_name: "GPT-6.2-Astra", default_reasoning_level: "low", supported_reasoning_levels: lv(...ALL), visibility: "list", context_window: 272000, priority: 2 },
  { slug: "gpt-6.1-terra", display_name: "GPT-6.1 Terra", default_reasoning_level: "low", supported_reasoning_levels: lv(...ALL), visibility: "list", context_window: 500000, priority: 3 },
  { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", default_reasoning_level: "low", supported_reasoning_levels: lv(...ALL), visibility: "list", context_window: 500000, priority: 4 },
  { slug: "gpt-6-luna", display_name: "GPT-6-Luna", default_reasoning_level: "medium", supported_reasoning_levels: lv(...NO_ULTRA), visibility: "list", context_window: 272000, priority: 5 },
  { slug: "gpt-test-secret", display_name: "GPT-Test-Secret", default_reasoning_level: "medium", supported_reasoning_levels: lv(...NO_ULTRA), visibility: "hide", context_window: 272000, priority: 6 },
  { slug: "gpt-test-hidden", display_name: "GPT-Test-Hidden", default_reasoning_level: "medium", supported_reasoning_levels: lv("low", "high"), visibility: "hide", context_window: 128000, priority: 7 },
] }));
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
  writeFileSync(join(artifacts, "routing-catalog-assertions.json"), JSON.stringify(assertions, null, 2));
  try { writeFileSync(join(artifacts, "routing-catalog-policy.toml"), readFileSync(policyPath)); } catch {}
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const getState = async () => (await fetch(url + "/api/routing")).json();
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.problems = [];
  page.on("pageerror", (e) => page.problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") page.problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400) page.problems.push(`http ${r.status()} ${r.url()}`); });
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.click("#routing-open");
  await page.waitForSelector('.hwin[data-win="routing"] .rt-mode[data-mode="coding"]');
  return page;
}
const mode = (page, m) => page.locator(`.hwin[data-win="routing"] .rt-mode[data-mode="${m}"]`);
const cards = (page, m) => page.$$eval(`.hwin[data-win="routing"] .rt-mode[data-mode="${m}"] .rt-card`, (els) => els.map((e) => e.dataset.key));
const optionValues = (loc) => loc.evaluate((s) => [...s.options].map((o) => o.value));
async function openAdd(page, m) {
  await mode(page, m).locator(".rt-add-btn").click();
  await page.waitForSelector("#rt-pick:not([hidden])");
}
async function pick(page, m, what) {
  await openAdd(page, m);
  await page.click(`#rt-pick .rt-opt[data-pick="${what}"]`);
  await page.waitForSelector("#rt-pick", { state: "hidden" });
}
const saveAndWait = async (page) => {
  await page.click("#rt-save");
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#rt-status")?.textContent || ""));
};

test("catalog: arrays only, per-model Codex efforts, real labels, hidden models (C1-C4, C6)", async () => {
  const st = await getState();
  assert.equal(st.valid, true, JSON.stringify(st.errors));
  const cat = Object.fromEntries(st.catalog.map((h) => [h.id, h]));
  for (const h of st.catalog) {
    assert.ok(Array.isArray(h.efforts), `${h.id} efforts`);
    for (const m of h.models) {
      assert.ok(Array.isArray(m.contexts), `${h.id}/${m.id} contexts is ${JSON.stringify(m.contexts)}`);
      assert.ok(m.efforts === undefined || Array.isArray(m.efforts), `${h.id}/${m.id} efforts`);
    }
  }
  assert.deepEqual(cat.claude.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(cat.codex.efforts, ALL, "Codex's levels: what its models list");
  assert.deepEqual(cat.opencode.efforts, []);
  const cm = (id) => cat.codex.models.find((m) => m.id === id);
  assert.deepEqual(cm("gpt-6.2-sol").efforts, ALL);
  assert.deepEqual(cm("gpt-6-luna").efforts, NO_ULTRA);
  assert.deepEqual(cm("gpt-6.2-sol").contexts, [500000]);
  assert.deepEqual(cm("gpt-6.1-sol").contexts, [500000], "config and profile do not erase the cache's size");
  assert.equal(cm("gpt-6.2-sol").label, "GPT-6.2-Sol");
  assert.equal(cm("gpt-6.1-terra").label, "GPT-6.1 Terra");
  assert.equal(cm("gpt-test-secret"), undefined, "a hidden model nothing names is not offered");
  assert.deepEqual(cm("gpt-test-hidden").efforts, ["low", "high"], "a hidden model a profile names is");
  assert.equal(cm("gpt-test-unlisted").efforts, undefined, "unknown model: the harness's levels apply");
  assert.equal(cm("gpt-test-unlisted").label, "GPT-Test-Unlisted");
  assert.deepEqual(cm("gpt-test-unlisted").contexts, []);
  const fable = cat.claude.models.find((m) => m.id === "claude-fable-5-2");
  assert.equal(fable.label, "Claude Fable 5.2");
  assert.deepEqual(fable.contexts, []);
  assert.equal(cat.claude.models.find((m) => m.id === "claude-test-unlisted").label, "Claude Test Unlisted");
  const prof = Object.fromEntries(st.profiles.map((p) => [p.name, p]));
  assert.equal(prof["fable-max"].label, "Claude Fable 5.2");
  assert.equal(prof["sol-new"].label, "GPT-6.2-Sol", "profiles use the catalog's label");
  assert.equal(prof["codex-odd"].effort, "turbo");
  record("catalog", true, { codex: cat.codex.efforts, claude: cat.claude.efforts });
});

test("Add candidate: every profile, in every mode, with no errors (C1, C5, C7)", async () => {
  const page = await openPage();
  const mark = log.mark();
  const names = Object.keys(profiles);
  // Every mode's picker opens and lists every profile.
  for (const m of ["planning", "coding", "crawl"]) {
    await openAdd(page, m);
    const listed = await page.$$eval("#rt-pick .rt-opt[data-pick^='profile:']", (els) => els.map((e) => e.dataset.pick.slice(8)));
    assert.deepEqual(listed.sort(), [...names].sort(), m);
    if (m === "planning") await page.screenshot({ path: join(artifacts, "routing-catalog-picker.png") });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#rt-pick", { state: "hidden" });
  }
  // Every profile can be added; its card shows its levels and its default.
  const want = {
    "sol-new": ALL, luna: NO_ULTRA, terra: ALL, "codex-hidden": ["low", "high"], "codex-odd": ALL, "codex-plain": ALL,
    builder: ["low", "medium", "high", "xhigh", "max"], "fable-max": ["low", "medium", "high", "xhigh", "max"],
  };
  for (const n of names) {
    await pick(page, "planning", `profile:${n}`);
    const card = mode(page, "planning").locator(`.rt-card[data-key="${n}|"]`);
    await card.waitFor();
    if (profiles[n][0] === "opencode") continue;
    const sel = card.locator("select.rt-effort");
    if (want[n]) assert.deepEqual((await optionValues(sel)).filter(Boolean), want[n], n);
    const eff = profiles[n][2];
    if (eff) assert.match(await sel.locator("option[value='']").textContent(), new RegExp(`\\(${eff}\\)`), n);
  }
  assert.deepEqual(await cards(page, "planning"), names.map((n) => `${n}|`));
  assert.match(await mode(page, "planning").locator('.rt-card[data-key="sol-new|"] .rt-label').textContent(), /GPT-6\.2-Sol/);
  assert.match(await mode(page, "planning").locator('.rt-card[data-key="fable-max|"] .rt-label').textContent(), /Claude Fable 5\.2/);
  assert.match(await mode(page, "planning").locator('.rt-card[data-key="sol-new|"] .rt-ctx-fixed').textContent(), /500k/);
  await page.screenshot({ path: join(artifacts, "routing-catalog-profiles.png"), fullPage: true });
  await page.click("#rt-discard");
  assert.deepEqual(log.since(mark), []);
  assert.deepEqual(page.problems, []);
  record("profiles", true, { added: names.length });
  await page.close();
});

test("provider → model → reasoning → context, Other…, save and reload (C2, C3, C7, C8)", async () => {
  const page = await openPage();
  const coding = mode(page, "coding");
  // A project scope with an older saved list: the window opens on it fine.
  // Provider → model: Codex GPT-6.2-Sol at ultra.
  await pick(page, "coding", "model:codex:gpt-6.2-sol");
  const sol = coding.locator('.rt-card[data-key="codex|gpt-6.2-sol"]');
  assert.deepEqual(await optionValues(sol.locator("select.rt-effort")), ["", ...ALL]);
  await sol.locator("select.rt-effort").selectOption("ultra");
  assert.match(await sol.locator(".rt-ctx-fixed").textContent(), /500k/);
  // GPT-6-Luna has no ultra.
  await pick(page, "coding", "model:codex:gpt-6-luna");
  const luna = coding.locator('.rt-card[data-key="codex|gpt-6-luna"]');
  assert.deepEqual(await optionValues(luna.locator("select.rt-effort")), ["", ...NO_ULTRA]);
  await luna.locator("select.rt-effort").selectOption("max");
  // Claude Fable 5.2 (named only by profiles) at max.
  await pick(page, "coding", "model:claude:claude-fable-5-2");
  const fable = coding.locator('.rt-card[data-key="claude|claude-fable-5-2"]');
  assert.match(await fable.locator(".rt-label").textContent(), /Claude Fable 5\.2/);
  assert.deepEqual(await optionValues(fable.locator("select.rt-effort")), ["", "low", "medium", "high", "xhigh", "max"]);
  await fable.locator("select.rt-effort").selectOption("max");
  // Claude Opus 5.5 with a 1M context.
  await pick(page, "coding", "model:claude:claude-opus-5-5");
  const opus = coding.locator('.rt-card[data-key="claude|claude-opus-5-5"]');
  await opus.locator("select.rt-context").selectOption("1000000");
  // Other…: a Codex model nothing lists gets the harness's levels.
  await openAdd(page, "coding");
  await page.click('#rt-pick .rt-opt[data-pick="other:codex"]');
  await page.fill("#rt-other-model", "gpt-test-other");
  await page.click("#rt-other-add");
  await page.waitForSelector("#rt-pick", { state: "hidden" });
  const other = coding.locator('.rt-card[data-key="codex|gpt-test-other"]');
  assert.deepEqual(await optionValues(other.locator("select.rt-effort")), ["", ...ALL]);
  await other.locator("select.rt-effort").selectOption("ultra");
  // A profile whose model and effort no catalog knows.
  await pick(page, "coding", "profile:codex-odd");

  await saveAndWait(page);
  const saved = (await getState()).policy.global.modes.coding;
  const want = [
    { provider: "codex", profile: "codex", model: "gpt-6.2-sol", effort: "ultra" },
    { provider: "codex", profile: "codex", model: "gpt-6-luna", effort: "max" },
    { provider: "claude", profile: "claude", model: "claude-fable-5-2", effort: "max" },
    { provider: "claude", profile: "claude", model: "claude-opus-5-5", context: 1000000 },
    { provider: "codex", profile: "codex", model: "gpt-test-other", effort: "ultra" },
    { provider: "codex", profile: "codex-odd" },
  ];
  assert.deepEqual(saved, want);
  const text = readFileSync(policyPath, "utf8");
  assert.match(text, /effort = 'ultra'/);
  assert.match(text, /\[\[projects\.alpha\.modes\.coding\]\]/, "the older project list is kept");

  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await page.click("#routing-open");
  await page.waitForSelector('.hwin[data-win="routing"] .rt-card[data-key="codex|gpt-6.2-sol"]');
  assert.deepEqual(await cards(page, "coding"), want.map((c) => `${c.profile}|${c.model || ""}`));
  assert.equal(await sol.locator("select.rt-effort").inputValue(), "ultra");
  assert.equal(await luna.locator("select.rt-effort").inputValue(), "max");
  assert.equal(await fable.locator("select.rt-effort").inputValue(), "max");
  assert.equal(await opus.locator("select.rt-context").inputValue(), "1000000");
  assert.equal(await other.locator("select.rt-effort").inputValue(), "ultra");
  await page.screenshot({ path: join(artifacts, "routing-catalog-saved.png"), fullPage: true });
  // Reopening the picker after a save still works.
  await openAdd(page, "coding");
  await page.keyboard.press("Escape");
  assert.deepEqual(page.problems, []);
  record("save-reload", true, { saved });
  await page.close();
});

test("the server checks effort per model; hand-edited Codex levels load (C8)", async () => {
  const { revision } = await getState();
  const set = (c) => post(url, "/api/routing", { expected_revision: revision, ops: [{ op: "set_mode", scope: {}, mode: "crawl", candidates: [c] }] });
  let r = await set({ provider: "codex", profile: "codex", model: "gpt-6-luna", effort: "ultra" });
  assert.equal(r.status, 422);
  assert.equal(r.json.fields[0].field, "ops[0].candidates[0].effort");
  assert.match(r.json.fields[0].message, /GPT-6-Luna supports low, medium, high, xhigh, max/);
  // The profile's model counts: luna runs GPT-6-Luna.
  r = await set({ provider: "codex", profile: "luna", effort: "ultra" });
  assert.equal(r.status, 422);
  r = await set({ provider: "codex", profile: "codex", model: "gpt-6-luna", effort: "minimal" });
  assert.equal(r.status, 422);
  assert.equal((await getState()).revision, revision, "nothing written");

  const good = readFileSync(policyPath, "utf8");
  writeFileSync(policyPath, `version = 1\n\n[[global.modes.crawl]]\nprovider = "codex"\nprofile = "sol-new"\neffort = "ultra"\n`, { mode: 0o600 });
  try {
    const st = await getState();
    assert.equal(st.valid, true, JSON.stringify(st.errors));
    const page = await openPage();
    const card = mode(page, "crawl").locator('.rt-card[data-key="sol-new|"]');
    assert.equal(await card.locator("select.rt-effort").inputValue(), "ultra");
    assert.deepEqual(page.problems, []);
    await page.close();
  } finally {
    writeFileSync(policyPath, good, { mode: 0o600 });
  }
  record("server-validation", true);
});
