// E2E for prompt dialog windows and the floating-window layer: every agent
// waiting on a permission or a question gets its own window with the exact
// request and options; windows stack, move, minimise, close and survive a
// reload; thread chats open in the same windows; phones get sheets.
// The stub herdr serves fixture screens shaped like real 76-column Claude
// Code and Codex panes (testdata/prompts/*-wrapped.txt). Artifacts land in
// e2e/artifacts/win-*.
//
// Ways this could fail, written before the feature existed:
//  W1. An alternate-screen agent (Codex) reads blank through `--source
//      recent`, so its prompt never shows and its screen box stays empty.
//  W2. A command, path or option label wrapped by the agent shows cut or
//      split into a description.
//  W3. An answer is reported done while the pane still shows the prompt,
//      keys are resent, or keys go to a pane that is not the one the page
//      showed.
//  W4. Two agents waiting at once share one dialog, a new prompt does not
//      open its window, or a closed window pops up again for the same prompt.
//  W5. A window cannot be brought to front, dragged (mouse or touch), or
//      ends up off-screen after a resize; positions are lost on reload.
//  W6. Close, Esc, minimise/restore, the tray and Alt+W do not work, or Esc
//      closes something else.
//  W7. Digits in a focused window pick another option than shown, or fire
//      while typing in a field.
//  W8. A failure (prompt stuck, prompt changed) is not shown in the window.
//  W9. A thread's chat cannot open in a window, two cannot be watched side
//      by side, or the docked panel stops working.
// W10. Windows block the page (a backdrop), or float off a phone screen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-windows-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
mkdirSync(screens);
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const fixture = (f) => readFileSync(join(td, "prompts", f), "utf8");
const file = (pane) => join(screens, pane.replace(":", "_"));
const show = (pane, f) => writeFileSync(file(pane), f ? fixture(f) : "● Done.\n\n❯ \n");
const hp = "herdr-projects --root " + join(td, "root");
const DONE = "● Done.\n\n❯ \n";

// alpha/t-0002 (w1B:p1, claude, blocked): a wrapped Bash permission.
// alpha/t-0003 (w1C:p1, codex on the alternate screen): a wrapped command.
show("w1B:p1", "claude-bash-wrapped.txt");
show("w1C:p1", "codex-command-wrapped.txt");
writeFileSync(file("w1C:p1") + ".alt", "");
writeFileSync(file("w1C:p1") + ".status", "blocked");
writeFileSync(join(screens, "alpha_t-0002.pane"), "w1B_p1");
writeFileSync(join(screens, "alpha_t-0003.pane"), "w1C_p1");

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, ["--write-burst", "100", "--write-per-min", "600"], { STUB_SCREENS: screens });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const state = async () => (await fetch(url + "/api/state")).json();
const promptOf = async (key) => (await state()).threads.find((t) => t.key === key)?.prompt;
async function open(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...opts });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
const win = (page, id) => page.locator(`.hwin[data-win="${id}"]`);
const box = (page, id) => win(page, id).evaluate((w) => { const r = w.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), z: +getComputedStyle(w).zIndex }; });

test("detection: a Codex pane on the alternate screen shows its prompt and screen", async () => {
  // W1
  const p = await waitFor(() => promptOf("alpha/t-0003"), 8000);
  assert.equal(p.harness, "codex");
  assert.equal(p.subject, "printf hi > out2.txt");
  const r = await fetch(url + "/api/thread/alpha/t-0003/history?lines=50");
  assert.match((await r.json()).screen, /Would you like to run the following command\?/);
});

test("parsing: wrapped commands and labels arrive whole", async () => {
  // W2
  const p = await waitFor(() => promptOf("alpha/t-0002"), 8000);
  assert.equal(p.subject, "/opt/demo-tools/plugins/report-kit-0123456789abcdef/target/release/report-kit --root /srv/demo-projects report --percent 10 --activity 'Running command'");
  assert.deepEqual(p.options.map((o) => o.label), ["Yes", "Yes, and don’t ask again for: /opt/demo-tools/plugins/report-kit-0123456789abcdef/target/release/report-kit *", "Yes, and switch to auto mode", "No"]);
  assert.deepEqual(p.options.map((o) => !!o.always), [false, true, true, false]);
  const c = await promptOf("alpha/t-0003");
  assert.equal(c.options[1].label, "Yes, and don't ask again for commands that start with `printf hi > out2.txt`");
});

test("answer API: confirms the prompt left, never resends, refuses another pane", async () => {
  // W3
  let p = await promptOf("alpha/t-0002");
  // Another pane than the page saw: nothing is sent.
  let m = log.mark();
  let r = await post(url, "/api/thread/alpha/t-0002/answer", { pane: "w9X:p9", sig: p.sig, option: 3 });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "pane_changed");
  assert.deepEqual(log.since(m), []);
  // The pane stays on the prompt: one key press, then "stuck", not a resend.
  m = log.mark();
  r = await post(url, "/api/thread/alpha/t-0002/answer", { pane: "w1B:p1", sig: p.sig, option: 3 });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.code, "prompt_stuck");
  assert.match(r.json.error, /No/);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 4`]);
  // The agent moves on after the keys: "cleared".
  writeFileSync(file("w1B:p1") + ".onkeys", DONE);
  m = log.mark();
  r = await post(url, "/api/thread/alpha/t-0002/answer", { pane: "w1B:p1", sig: p.sig, option: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.after, "cleared");
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 1`]);
  // Another prompt follows: "next".
  show("w1B:p1", "claude-bash-wrapped.txt");
  p = await waitFor(() => promptOf("alpha/t-0002"), 8000);
  writeFileSync(file("w1B:p1") + ".onkeys", fixture("claude-edit-wrapped.txt"));
  r = await post(url, "/api/thread/alpha/t-0002/answer", { sig: p.sig, option: 0 });
  assert.equal(r.json.after, "next");
  // A coordinator on the alternate screen (Codex) is answered and confirmed.
  show("w2Z:p1", "codex-trust-wrapped.txt");
  writeFileSync(file("w2Z:p1") + ".alt", "");
  const co = await waitFor(async () => (await state()).projects.find((x) => x.slug === "beta").coordinator.prompt?.kind === "trust", 8000);
  assert.ok(co);
  show("w2Z:p1", "codex-command-wrapped.txt");
  const cp = await waitFor(async () => { const x = (await state()).projects.find((x) => x.slug === "beta").coordinator.prompt; return x?.kind === "permission" && x; }, 8000);
  writeFileSync(file("w2Z:p1") + ".onkeys", DONE);
  m = log.mark();
  r = await post(url, "/api/project/beta/answer", { pane: "w2Z:p1", sig: cp.sig, option: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.after, "cleared");
  assert.deepEqual(log.since(m), ["herdr pane get w2Z:p1", "herdr pane send-keys w2Z:p1 1"]);
  rmSync(file("w2Z:p1") + ".alt");
  show("w1B:p1", "claude-bash-wrapped.txt");
});

test("dialogs: one window per waiting agent, front on click, drag, close, Esc, no backdrop", async () => {
  // W4, W5, W6, W10
  show("w1B:p1", "claude-bash-wrapped.txt");
  await waitFor(async () => (await promptOf("alpha/t-0002"))?.title === "Bash command", 8000);
  const page = await open();
  const a = win(page, "prompt:alpha/t-0002"), c = win(page, "prompt:alpha/t-0003");
  await a.waitFor();
  await c.waitFor();
  // The exact request and its real options.
  assert.match(await a.locator(".hw-title").innerText(), /t-0002/);
  assert.equal(await a.locator(".pc-subject").innerText(), "/opt/demo-tools/plugins/report-kit-0123456789abcdef/target/release/report-kit --root /srv/demo-projects report --percent 10 --activity 'Running command'");
  assert.deepEqual(await a.locator(".pc-opt .lbl").allInnerTexts(), ["Yes", "Yes, and don’t ask again for: /opt/demo-tools/plugins/report-kit-0123456789abcdef/target/release/report-kit *", "Yes, and switch to auto mode", "No"]);
  assert.deepEqual(await a.locator(".pc-opt .k").allInnerTexts(), ["1", "2", "3", "4"]);
  assert.match(await c.locator(".pc-harness").innerText(), /codex/);
  // Cascaded, not on top of each other.
  let ba = await box(page, "prompt:alpha/t-0002"), bc = await box(page, "prompt:alpha/t-0003");
  assert.ok(ba.x !== bc.x || ba.y !== bc.y, "cascaded");
  // No backdrop: the graph still takes clicks while windows are open.
  assert.equal(await page.locator(".hw-backdrop, dialog[open]").count(), 0);
  await page.screenshot({ path: join(artifacts, "win-two-prompts.png") });

  // Click to bring to front.
  await a.locator(".hw-bar .hw-title").click();
  ba = await box(page, "prompt:alpha/t-0002"); bc = await box(page, "prompt:alpha/t-0003");
  assert.ok(ba.z > bc.z, "clicked window in front");
  // Its corner that sticks out from under the other window.
  await page.mouse.click(bc.x + bc.w - 6, bc.y + bc.h - 6);
  ba = await box(page, "prompt:alpha/t-0002"); bc = await box(page, "prompt:alpha/t-0003");
  assert.ok(bc.z > ba.z, "click in the body brings it front too");

  // Drag by the title bar.
  const before = await box(page, "prompt:alpha/t-0002");
  const bar = await a.locator(".hw-title").boundingBox();
  await page.mouse.move(bar.x + 20, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + 120, bar.y + bar.height / 2 + 80, { steps: 6 });
  await page.mouse.up();
  const moved = await box(page, "prompt:alpha/t-0002");
  assert.ok(Math.abs(moved.x - before.x - 100) <= 2 && Math.abs(moved.y - before.y - 80) <= 2, `moved ${JSON.stringify([before, moved])}`);
  // Dragged far off the screen, it stays reachable.
  const bar2 = await a.locator(".hw-title").boundingBox();
  await page.mouse.move(bar2.x + 20, bar2.y + 5);
  await page.mouse.down();
  await page.mouse.move(3000, 2000, { steps: 4 });
  await page.mouse.up();
  let off = await box(page, "prompt:alpha/t-0002");
  assert.ok(off.x + off.w <= 1440 && off.y + 30 <= 900, `kept on screen ${JSON.stringify(off)}`);
  // A smaller viewport pulls windows back in.
  await page.setViewportSize({ width: 1000, height: 700 });
  await waitFor(async () => { const b = await box(page, "prompt:alpha/t-0002"); return b.x + b.w <= 1000 && b.y + 30 <= 700; }, 3000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Put it somewhere known for the reload check.
  const bar3 = await a.locator(".hw-title").boundingBox();
  await page.mouse.move(bar3.x + 10, bar3.y + 5);
  await page.mouse.down();
  await page.mouse.move(bar3.x + 10 - (bar3.x - 300) + 0, bar3.y + 5 - (bar3.y - 200), { steps: 4 });
  await page.mouse.up();
  const placed = await box(page, "prompt:alpha/t-0002");

  // Close with the button. (Esc in a prompt window is the pane's Esc when
  // the prompt offers one: prompt-keys.test.mjs.)
  await c.locator(".hw-close").click();
  assert.equal(await c.count(), 0);
  await a.locator(".hw-close").click();
  assert.equal(await a.count(), 0);
  // A closed window does not pop up again for the same prompt.
  await page.waitForTimeout(2500);
  assert.equal(await page.locator(".hwin").count(), 0);
  // The strip's Answer opens it again, where it was left.
  await page.locator('#needs .chip-answer[data-key="alpha/t-0002"]').click();
  await a.waitFor();
  const again = await box(page, "prompt:alpha/t-0002");
  assert.deepEqual([again.x, again.y], [placed.x, placed.y]);
  // And after a reload too.
  await page.reload();
  await page.waitForSelector("svg g.node.thread");
  await page.locator('#needs .chip-answer[data-key="alpha/t-0002"]').click();
  await a.waitFor();
  const reloaded = await box(page, "prompt:alpha/t-0002");
  assert.deepEqual([reloaded.x, reloaded.y], [placed.x, placed.y]);
  // A new prompt on a pane opens its window by itself.
  show("w1B:p1", "claude-edit-wrapped.txt");
  await waitFor(async () => /notes\.txt/.test(await a.locator(".pc-q").innerText()), 8000);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("dialogs: digits answer the focused window, results and failures show in it", async () => {
  // W3, W7, W8
  show("w1B:p1", "claude-bash-wrapped.txt");
  const p = await waitFor(async () => { const x = await promptOf("alpha/t-0002"); return x?.title === "Bash command" && x; }, 8000);
  const page = await open();
  const a = win(page, "prompt:alpha/t-0002");
  await a.locator(".pc-opt").first().waitFor();
  await a.locator(".hw-title").click();
  // The pane stays on the prompt: the window says the answer did not land.
  let m = log.mark();
  await page.keyboard.press("4");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 4`]);
  await waitFor(async () => /still shows/i.test(await a.locator(".pc-status").innerText()), 8000);
  assert.match(await a.locator(".pc-status").getAttribute("class"), /err/);
  await page.screenshot({ path: join(artifacts, "win-stuck.png") });
  // The agent moves on after "Yes": the window confirms and closes.
  writeFileSync(file("w1B:p1") + ".onkeys", DONE);
  await a.locator(".pc-opt").first().waitFor();
  await waitFor(async () => !(await a.locator(".pc-opt").first().isDisabled()), 4000);
  m = log.mark();
  await a.locator(".hw-title").click();
  await page.keyboard.press("1");
  await waitFor(async () => /cleared/i.test(await a.locator(".pc-status").innerText()), 8000);
  assert.deepEqual(log.since(m), [`${hp} thread keys alpha t-0002 1`]);
  await page.screenshot({ path: join(artifacts, "win-cleared.png") });
  await waitFor(async () => (await a.count()) === 0, 8000);
  // A prompt that changed under the window: refused, said, nothing sent.
  show("w1B:p1", "claude-bash-wrapped.txt");
  await a.locator(".pc-opt").first().waitFor({ timeout: 8000 });
  writeFileSync(file("w1B:p1"), fixture("claude-bash-wrapped.txt").replace("--percent 10", "--percent 20"));
  m = log.mark();
  await a.locator(".pc-opt").first().click();
  await waitFor(async () => /another prompt|changed/i.test(await a.locator(".pc-status").innerText()), 6000);
  assert.deepEqual(log.since(m), []);
  // Digits do nothing while typing in a field.
  show("w1B:p1", "claude-question.txt");
  await waitFor(async () => (await a.locator(".pc-text .pc-field").count()) === 1, 8000);
  m = log.mark();
  await a.locator(".pc-text .pc-field").fill("");
  await a.locator(".pc-text .pc-field").press("2");
  await page.waitForTimeout(600);
  assert.deepEqual(log.since(m), []);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("windows: minimise, tray, Alt+W, thread chats side by side, panel still works", async () => {
  // W6, W9
  show("w1B:p1", "claude-bash-wrapped.txt");
  await waitFor(async () => (await promptOf("alpha/t-0002"))?.title === "Bash command", 8000);
  const page = await open();
  const a = win(page, "prompt:alpha/t-0002");
  await a.waitFor();
  // Minimise to the tray and restore.
  await a.locator(".hw-min").click();
  assert.ok(!(await a.isVisible()), "minimised");
  const item = page.locator('#win-tray .wt-item[data-win="prompt:alpha/t-0002"]');
  assert.ok(await item.isVisible());
  await item.click();
  assert.ok(await a.isVisible(), "restored");
  // A thread's chat in a window: from the graph node (Shift+click) and the strip.
  await page.evaluate(() => {
    const g = document.querySelector('svg g.node[data-key="alpha/t-0001"]');
    g.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  });
  const t1 = win(page, "thread:alpha/t-0001");
  await t1.waitFor();
  await page.locator('#needs .chip-win[data-key="alpha/t-0002"]').click();
  const t2 = win(page, "thread:alpha/t-0002");
  await t2.waitFor();
  await waitFor(async () => /LAST LINE of w1A:p1/.test(await t1.locator(".screen").innerText()), 8000);
  await waitFor(async () => /report-kit/.test(await t2.locator(".screen").innerText()), 8000);
  assert.equal(await t1.locator("h2, .tw-name").first().innerText().then((s) => /Widget pipeline/.test(s)), true);
  // Its chat sends through herdr-projects.
  let m = log.mark();
  await t1.locator(".tw-input").fill("check the logs");
  await t1.locator(".tw-send").click();
  await waitFor(() => log.since(m).some((l) => l.startsWith(`${hp} thread prompt alpha t-0001`)), 4000);
  await waitFor(async () => /Sent/.test(await t1.locator(".tw-log").innerText()), 4000);
  // The blocked thread's window carries its prompt card.
  assert.ok(await t2.locator(".pcard .pc-opt").first().isVisible());
  // Alt+W cycles focus through the open windows.
  const active = () => page.evaluate(() => document.querySelector(".hwin.active")?.dataset.win);
  const all = await page.evaluate(() => [...document.querySelectorAll(".hwin")].map((w) => w.dataset.win).sort());
  assert.ok(all.includes("thread:alpha/t-0001") && all.includes("thread:alpha/t-0002") && all.includes("prompt:alpha/t-0002"), all.join());
  const seen = new Set();
  for (let i = 0; i < all.length; i++) { await page.keyboard.press("Alt+KeyW"); seen.add(await active()); }
  assert.deepEqual([...seen].sort(), all);
  // The docked panel still opens beside the windows.
  await page.evaluate(() => window.hd.select("alpha/t-0003"));
  await page.waitForSelector("#panel.open");
  assert.equal(await page.locator(".hwin").count(), all.length);
  await page.locator("#pop-out").click();
  await win(page, "thread:alpha/t-0003").waitFor();
  await page.screenshot({ path: join(artifacts, "win-side-by-side.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("phone: windows are full-width sheets, touch drag does nothing harmful", async () => {
  // W10
  show("w1B:p1", "claude-bash-wrapped.txt");
  await waitFor(async () => (await promptOf("alpha/t-0002"))?.title === "Bash command", 8000);
  const page = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = win(page, "prompt:alpha/t-0002");
  // One sheet shows at a time; the tray brings the other forward.
  await page.locator('#win-tray .wt-item[data-win="prompt:alpha/t-0002"]').tap();
  await a.waitFor();
  assert.equal(await page.locator(".hwin:not(.min):not(.behind)").count(), 1, "one sheet shown");
  const b = await box(page, "prompt:alpha/t-0002");
  assert.equal(b.x, 0);
  assert.equal(b.w, 390);
  assert.ok(b.y + b.h <= 844);
  const over = await page.evaluate(() => [...document.querySelectorAll(".hwin:not(.min) *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
  assert.equal(over, 0, "nothing wider than the screen");
  await page.screenshot({ path: join(artifacts, "win-phone.png") });
  await a.locator(".hw-close").tap();
  assert.equal(await a.count(), 0);
  await page.close();
});

test("only allow-listed commands ran", () => {
  const allowed = [
    /^herdr-projects --root \S+ (list|thread list \S+ --json|progress --pane \S+|safety show \S+)$/,
    /^herdr pane list$/,
    /^herdr pane layout --pane \S+$/,
    /^herdr pane read \S+ --source (recent|detection) --lines \d+( --format ansi)?$/,
    /^gh pr list /,
    /^herdr-projects --root \S+ thread keys [a-z]+ t-\d{4}( (enter|esc|up|down|left|right|tab|space|backspace|y|n|\d))+( --text=.*)?$/,
    /^herdr-projects --root \S+ thread prompt alpha t-0001 --text-file -$/,
    /^stdin: check the logs$/,
    /^herdr pane get w2Z:p1$/,
    /^herdr pane send-keys w2Z:p1( (enter|esc|up|down|left|right|tab|space|backspace|y|n|\d))+$/,
  ];
  const calls = log.lines();
  for (const c of calls) assert.ok(allowed.some((re) => re.test(c)), `unexpected command: ${c}`);
  writeFileSync(join(artifacts, "win-calls.log"), calls.join("\n") + "\n");
  assert.ok(existsSync(join(artifacts, "win-two-prompts.png")));
});
