// E2E for opencode's permission prompts as Dash reads them: the first step
// (Allow once / Allow always / Reject) and the "Always allow" confirmation
// (Confirm / Cancel), from screens taken live from opencode 1.18 at 76 and
// 120 columns (testdata/prompts/opencode-*). At 120 columns opencode draws a
// sidebar beside the prompt (wrapped cwd:branch, version). The stub herdr
// serves them for alpha/t-0003 (an opencode pane). Artifacts land in
// e2e/artifacts/opencode-*.
//
// Ways this could fail, written before the fix:
//  O1. Sidebar text or a bulleted pattern list becomes an option, or
//      "Confirm" is glued to a wrapped path (the reported bug): the window
//      offers options whose keys answer something else.
//  O2. The patterns are not shown, or shown as a diff (a "- " line in red).
//  O3. The confirmation is not marked as a lasting grant.
//  O4. Confirm and Cancel send other keys than opencode's button row takes
//      (Enter on the highlight; Right, Enter for Cancel), or the answer is
//      not checked against the pane afterwards.
//  O5. A parse that still looks wrong is offered anyway instead of
//      "answer in the terminal", or the answer API presses keys for it.
//  O6. Night mode confirms the lasting grant.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, td, stub } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-opencode-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
const nightCfg = join(tmp, "night.json");
const audit = join(tmp, "audit.jsonl");
mkdirSync(screens);
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const fixture = (f) => readFileSync(join(td, "prompts", f), "utf8");
const file = (pane) => join(screens, pane.replace(":", "_"));
const hp = "herdr-projects --root " + join(td, "root");
const PANE = "w1C:p1";
const KEY = "alpha/t-0003";
const CLEARED = "● Done.\n\n❯ \n";

// alpha/t-0003 runs opencode in w1C:p1, blocked.
const panes = JSON.parse(readFileSync(join(stub, "panes.json"), "utf8"));
for (const p of panes.result.panes) {
  if (p.pane_id === PANE) { p.agent = "opencode"; if (p.agent_session) p.agent_session.agent = "opencode"; }
}
const panesFile = join(tmp, "panes.json");
writeFileSync(panesFile, '{"id":"cli:pane:list","result":{"panes":[\n' + panes.result.panes.map((p) => JSON.stringify(p)).join(",\n") + "\n]}}\n");
writeFileSync(join(screens, "alpha_t-0003.pane"), "w1C_p1");
writeFileSync(file(PANE) + ".status", "blocked");

// show puts a screen in the pane; then: the screen after the next keys.
function show(text, then) {
  writeFileSync(file(PANE), text);
  if (then != null) writeFileSync(file(PANE) + ".onkeys", then);
  else rmSync(file(PANE) + ".onkeys", { force: true });
}
// unmarked: the reported screen with nothing left to tell the sidebar
// apart (its version line and boxes), so the parse glues it to the buttons.
const unmarked = (s) => s.replace(/\x1b\[[0-9;:]*m/g, "").replace(/• OpenCode [0-9.]+/g, (m) => " ".repeat([...m].length)).replace(/[┌┐└┘│─]/g, " ");
show(CLEARED);

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, ["--write-burst", "100", "--write-per-min", "600", "--night-config", nightCfg, "--fleet-audit", audit], { STUB_SCREENS: screens, STUB_PANES: panesFile });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const promptOf = async () => (await (await fetch(url + "/api/state")).json()).threads.find((t) => t.key === KEY)?.prompt;
const waitPrompt = (pred) => waitFor(async () => { const p = await promptOf(); return p && pred(p) && p; }, 8000);
const keysSent = (m) => log.since(m).filter((l) => l.includes(" thread keys alpha t-0003")).map((l) => l.replace(/^.* thread keys alpha t-0003 ?/, ""));
async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.evaluate((k) => window.hd.select(k), KEY);
  await page.waitForSelector("#prompt-card:not([hidden])");
  return page;
}
const card = (page) => page.locator("#prompt-card");
const status = (page) => card(page).locator(".pc-status").innerText();

test("confirm step at 120 columns: Confirm and Cancel only, patterns listed, a lasting grant; Cancel sends Right, Enter", async () => {
  // O1, O2, O3, O4
  show(fixture("opencode-always-120.ansi"), fixture("opencode-perm-120.ansi"));
  const p = await waitPrompt((p) => p.title === "Always allow");
  assert.equal(p.harness, "opencode");
  assert.equal(p.lasting, true);
  assert.deepEqual(p.list, ["ls *", "wc *"]);
  assert.deepEqual(p.options.map((o) => [o.label, o.keys.join(" "), !!o.always, !!o.current]), [["Confirm", "enter", true, true], ["Cancel", "right enter", false, false]]);
  assert.ok(!JSON.stringify(p).includes("oc-demo/worktrees"), "no sidebar text in the prompt");

  const page = await open();
  await page.waitForSelector("#prompt-card .pc-opt");
  assert.deepEqual(await card(page).locator(".pc-opt .lbl").allInnerTexts(), ["Confirm", "Cancel"]);
  assert.deepEqual(await card(page).locator(".pc-list li").allInnerTexts(), ["ls *", "wc *"]);
  assert.equal(await card(page).locator(".pc-list .del").count(), 0, "patterns are not a diff");
  assert.match(await card(page).locator(".pc-lasting").innerText(), /lasting/i);
  assert.deepEqual(await card(page).locator(".pc-opt").evaluateAll((bs) => bs.map((b) => b.classList.contains("always"))), [true, false]);
  await page.screenshot({ path: join(artifacts, "opencode-always-120.png") });

  const m = log.mark();
  await card(page).locator(".pc-opt", { hasText: "Cancel" }).click();
  await waitFor(() => keysSent(m).length > 0, 4000);
  assert.deepEqual(keysSent(m), ["right enter"]);
  // Cancel goes back to the first step: the window follows it.
  await waitFor(async () => (await card(page).locator(".pc-opt .lbl").allInnerTexts()).join("|") === "Allow once|Allow always|Reject", 8000);
  assert.equal(await card(page).locator(".pc-lasting").count(), 0);
  await page.screenshot({ path: join(artifacts, "opencode-perm-120.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("the reported screen (sidebar glued to the buttons): Confirm sends Enter and the answer is checked", async () => {
  // O1, O4
  show(fixture("opencode-always-glued.ansi"), CLEARED);
  const p = await waitPrompt((p) => p.title === "Always allow" && p.options.length === 2);
  assert.deepEqual(p.options.map((o) => o.label), ["Confirm", "Cancel"]);
  const page = await open();
  await page.waitForSelector("#prompt-card .pc-opt");
  const m = log.mark();
  await card(page).locator(".pc-opt", { hasText: "Confirm" }).click();
  await waitFor(() => keysSent(m).length > 0, 4000);
  assert.deepEqual(keysSent(m), ["enter"]);
  await waitFor(async () => /cleared/i.test(await status(page)), 8000);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("a parse that still looks glued is unparsed: answer in the terminal, no options, no keys", async () => {
  // O5
  show(unmarked(fixture("opencode-always-glued.ansi")));
  const p = await waitPrompt((p) => p.kind === "unparsed");
  assert.deepEqual(p.options, []);
  assert.match(p.summary, /answer in the terminal/);
  const page = await open();
  await waitFor(async () => /answer in the terminal/i.test(await card(page).innerText()), 6000);
  assert.equal(await card(page).locator(".pc-opt").count(), 0);
  await page.screenshot({ path: join(artifacts, "opencode-unparsed.png") });
  const m = log.mark();
  const r = await post(url, "/api/thread/alpha/t-0003/answer", { sig: p.sig, option: 0 });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.deepEqual(keysSent(m), []);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("night mode leaves the lasting confirmation and approves the first step's Allow once", async () => {
  // O6
  const night = async (s) => { const r = await post(url, "/api/night", s); assert.equal(r.status, 200, JSON.stringify(r.json)); };
  const entries = async () => (await (await fetch(url + "/api/night/log")).json()).entries;
  const m = log.mark();
  show(fixture("opencode-always-120.ansi"), CLEARED);
  await waitPrompt((p) => p.lasting);
  await night({ mode: "on", off_at: "", projects: [], coordinators: true, questions: false, stable_seconds: 1, loop_max: 20, loop_minutes: 10 });
  const e = await waitFor(async () => (await entries()).find((e) => e.pane === PANE && e.result === "refused"), 10_000);
  assert.match(e.reason, /lasting grant/);
  assert.deepEqual(keysSent(m), []);
  show(fixture("opencode-perm-120.ansi"), CLEARED);
  await waitFor(() => keysSent(m).length > 0, 10_000);
  assert.deepEqual(keysSent(m), ["enter"]);
  await night({ mode: "off" });
});
