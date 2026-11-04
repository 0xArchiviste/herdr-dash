// E2E for prompts that must go away: a prompt window and its Needs-you
// entry clear on the next pane reading after the question is answered,
// whoever answered it and however the page learns of it. Artifacts land in
// e2e/artifacts/stale-*.
//
// Ways this could fail (the user saw windows and strip entries stay after
// an answer), written before the fix:
//  S1. Answered in the pane: the window stays, or the strip keeps the thread
//      as needing you until herdr-projects regroups it (seconds or longer).
//  S2. Answered from another tab: this tab's window stays.
//  S3. The agent moved on to another prompt: the old one still shows.
//  S4. The pane closed or the agent died: its last prompt stays.
//  S5. An answer that timed out (prompt_stuck) while the prompt left in the
//      meantime: the card keeps its error and never closes.
//  S6. A hidden tab coming back (its stream closed and reconnects with a
//      full snapshot): windows for prompts answered meanwhile stay open.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, td, stub } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-stale-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
const panes = join(tmp, "panes.json");
mkdirSync(screens);
writeFileSync(stubLog, "");
const allPanes = readFileSync(join(stub, "panes.json"), "utf8");
writeFileSync(panes, allPanes);
const log = stubLogger(stubLog);
const fixture = (f) => readFileSync(join(td, "prompts", f), "utf8");
const file = (pane) => join(screens, pane.replace(":", "_"));
const DONE = "● Done.\n\n❯ \n";
const show = (f) => writeFileSync(file("w1B:p1"), f ? fixture(f) : DONE);
const status = (s) => (s ? writeFileSync(file("w1B:p1") + ".status", s) : rmSync(file("w1B:p1") + ".status", { force: true }));
const KEY = "alpha/t-0002";

// alpha/t-0002 runs claude in w1B:p1 (blocked); herdr-projects keeps it
// "waiting on you" throughout (the stub never regroups, and the thread list
// is not refetched during a test: the strip must not wait for it).
show("claude-bash-amend.txt");
writeFileSync(join(screens, "alpha_t-0002.pane"), "w1B_p1");

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, ["--write-burst", "100", "--write-per-min", "600", "--threads-every", "10m"], { STUB_SCREENS: screens, STUB_PANES: panes });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const thread = async () => (await (await fetch(url + "/api/state")).json()).threads.find((t) => t.key === KEY);
async function reset() {
  writeFileSync(panes, allPanes);
  status(null);
  show("claude-bash-amend.txt");
  await waitFor(async () => (await thread())?.prompt?.title === "Bash command", 8000);
}
async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.locator('.hwin[data-win="prompt:alpha/t-0002"] .pc-opt').first().waitFor({ timeout: 8000 });
  return page;
}
const win = (page) => page.locator('.hwin[data-win="prompt:alpha/t-0002"]');
const chip = (page) => page.locator(`#needs .chip[data-key="${KEY}"]`);
const gone = (page, ms = 8000) => waitFor(async () => (await win(page).count()) === 0, ms);

test("answered in the pane: the window closes, the strip drops it at once", async () => {
  // S1
  await reset();
  const page = await open();
  assert.match(await chip(page).innerText(), /Permission: Bash/);
  // The pane leaves the prompt; herdr still says blocked for a moment.
  show(null);
  await gone(page);
  await waitFor(async () => !/Permission:/.test(await chip(page).innerText().catch(() => "")), 8000);
  // The agent works on: not "needing you", though herdr-projects has not
  // regrouped it yet.
  status("working");
  const t = await waitFor(async () => { const x = await thread(); return x.state === "working" && x; }, 8000);
  assert.equal(t.needs_you, false);
  await waitFor(async () => (await chip(page).count()) === 0, 8000);
  await page.screenshot({ path: join(artifacts, "stale-pane-answered.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("answered from another tab: this tab's window closes", async () => {
  // S2
  await reset();
  const a = await open();
  const b = await open();
  writeFileSync(file("w1B:p1") + ".onkeys", DONE);
  await win(a).locator(".pc-opt").first().click();
  await waitFor(async () => /cleared/i.test(await win(a).locator(".pc-status").innerText()), 8000);
  await gone(b);
  await gone(a);
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.close();
  await b.close();
});

test("the agent moved to another prompt: only the new one shows", async () => {
  // S3
  await reset();
  const page = await open();
  show("claude-plan.txt");
  await waitFor(async () => /plan/i.test(await win(page).locator(".pc-kind").innerText()), 8000);
  assert.equal(await win(page).locator(".pc-subject").count(), 0, "nothing of the Bash prompt left");
  assert.match(await chip(page).innerText(), /Plan: add README\.md/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("the pane closed, or the agent died: its prompt is dropped", async () => {
  // S4
  await reset();
  let page = await open();
  writeFileSync(panes, allPanes.split("\n").filter((l) => !l.includes('"pane_id":"w1B:p1"')).join("\n"));
  await gone(page);
  const t = await thread();
  assert.equal(t.prompt, undefined);
  assert.equal(t.pane_alive, false);
  assert.doesNotMatch(await chip(page).innerText().catch(() => ""), /Permission:/);
  await page.close();
  // The agent exits: herdr says done and the screen is a shell.
  await reset();
  page = await open();
  status("done");
  writeFileSync(file("w1B:p1"), "$ claude\n...\n$ ");
  await gone(page);
  assert.equal((await thread()).prompt, undefined);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("an answer that timed out while the prompt left: the card still closes", async () => {
  // S5: the snapshot without the prompt arrives while the answer is out;
  // the answer then comes back stuck.
  await reset();
  const page = await open();
  let release;
  const held = new Promise((r) => (release = r));
  await page.route("**/api/thread/alpha/t-0002/answer", async (route) => {
    const resp = await route.fetch(); // the server presses the key, waits, says stuck
    show(null); // then the pane moves on
    await held;
    await route.fulfill({ response: resp });
  });
  const m = log.mark();
  await win(page).locator(".pc-opt").first().click();
  await waitFor(() => log.since(m).length > 0, 4000);
  await waitFor(async () => !(await thread()).prompt, 10000);
  await page.waitForTimeout(1200); // the page has the empty snapshot, the answer is still out
  release();
  await waitFor(async () => /still shows/i.test(await win(page).locator(".pc-status").innerText().catch(() => "")) || (await win(page).count()) === 0, 8000);
  await gone(page);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("a hidden tab coming back (stream reconnects): answered prompts are gone", async () => {
  // S6
  await reset();
  const page = await open();
  const setHidden = (h) => page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, h);
  await setHidden(true);
  await waitFor(async () => /paused/.test(await page.locator("#live").getAttribute("class")), 3000);
  show(null);
  status("working");
  await waitFor(async () => !(await thread()).needs_you, 8000);
  await page.waitForTimeout(500);
  assert.equal(await win(page).count(), 1, "nothing updates while hidden");
  await setHidden(false);
  await gone(page);
  await waitFor(async () => (await chip(page).count()) === 0, 8000);
  // A reconnect with the prompt still up keeps it, of course.
  await reset();
  await win(page).locator(".pc-opt").first().waitFor({ timeout: 8000 });
  await setHidden(true);
  await setHidden(false);
  await page.waitForTimeout(1500);
  assert.equal(await win(page).count(), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});
