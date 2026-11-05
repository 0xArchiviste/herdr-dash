// E2E for prompt windows as interactive as Claude Code's own menus: a
// highlight moved with the arrow keys, Enter, digits, Space for multi-select,
// Tab to amend, Esc to cancel, question tabs, previews with notes, plan
// approval, and the free-text rows ("Type something", "No, and tell Claude
// what to do differently") typed into from the window. The stub herdr
// serves screens taken live from a 76-column Claude Code 2.1 pane
// (testdata/prompts/claude-ask-*, -amend*, -plan*, -create). Artifacts land
// in e2e/artifacts/keys-*.
//
// Ways this could fail, written before the feature existed:
//  K1. Arrow keys do not move a highlight, Enter picks another option than
//      the one highlighted, or keys fire while typing in a field.
//  K2. The window does not follow the pane: the highlight the user moved
//      there, a check ticked there, text typed there, or the prompt answered
//      there (the window must close).
//  K3. "Type something" opens no field, or the text is sent before the row
//      is picked, without Enter, mangled (quotes, unicode, several lines), or
//      as keys (a tab, a newline taken as Enter by an agent that is not Claude).
//  K4. Multi-select: Space does not toggle, text in the Other row is followed
//      by Enter (which unticks it, seen live), Submit is missing.
//  K5. Question tabs are not shown, or left/right/Tab do not move between them.
//  K6. "No, and tell Claude what to do differently" sends a bare No, or the
//      text without Tab to open the field; Esc does not deny; text already
//      typed in the pane is typed over.
//  K7. A plan approval shows no plan, or its feedback row takes no text.
//  K8. A preview is not shown, or notes go nowhere.
//  K9. Over-long text is sent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-keys-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
mkdirSync(screens);
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const fixture = (f) => readFileSync(join(td, "prompts", f), "utf8");
const file = (pane) => join(screens, pane.replace(":", "_"));
const show = (pane, f) => writeFileSync(file(pane), f ? fixture(f) : DONE);
const onKeys = (pane, f) => writeFileSync(file(pane) + ".onkeys", f ? fixture(f) : DONE);
const hp = "herdr-projects --root " + join(td, "root");
const keys = (...k) => `${hp} thread keys alpha t-0002 ${k.join(" ")}`;
const DONE = "● Done.\n\n❯ \n";
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// The raw stub log since a mark: typed text may hold newlines.
const rawSince = (m) => readFileSync(stubLog, "utf8").split("\n").slice(m)
  .filter((l) => !/^(herdr|herdr-projects --root \S+|gh) .*(list|pane read|pr list|progress --pane|safety show)( |$)/.test(l)).join("\n");

// alpha/t-0002 runs claude in w1B:p1 (blocked).
show("w1B:p1", "claude-ask-tabs.ansi");
writeFileSync(join(screens, "alpha_t-0002.pane"), "w1B_p1");

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, ["--write-burst", "200", "--write-per-min", "1200"], { STUB_SCREENS: screens });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const promptOf = async () => (await (await fetch(url + "/api/state")).json()).threads.find((t) => t.key === "alpha/t-0002")?.prompt;
const waitPrompt = (pred) => waitFor(async () => { const p = await promptOf(); return p && pred(p) && p; }, 8000);
async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
const winOf = (page) => page.locator('.hwin[data-win="prompt:alpha/t-0002"]');
const selLabel = (w) => w.locator(".pc-row.sel .lbl").first().innerText();
const statusOf = (w) => w.locator(".pc-status").innerText();
async function focusWin(w) {
  await w.locator(".hw-title").click();
}

test("keyboard: arrows move the highlight, Enter and digits pick, the window follows the pane", async () => {
  // K1, K2, K5
  show("w1B:p1", "claude-ask-tabs.ansi");
  await waitPrompt((p) => p.question === "Which color should the poster use?");
  const page = await open();
  const w = winOf(page);
  await w.locator(".pc-opt").first().waitFor();
  // Tabs: Color is the current question; there is no previous one.
  assert.deepEqual(await w.locator(".pc-tab").allInnerTexts(), ["Color", "Extras", "✔ Submit"]);
  assert.equal(await w.locator(".pc-tab.current").innerText(), "Color");
  assert.ok(await w.locator(".pc-prev").isDisabled());
  // The highlight starts where the pane's is and moves with the arrows.
  assert.equal(await selLabel(w), "Red");
  await focusWin(w);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await selLabel(w), "Green");
  await page.keyboard.press("ArrowUp");
  assert.equal(await selLabel(w), "Blue");
  assert.equal(await w.locator(".pc-row.current .lbl").first().innerText(), "Red", "the pane's highlight is marked apart");
  await page.screenshot({ path: join(artifacts, "keys-highlight.png") });
  // Enter picks the highlighted option with the pane's own keys.
  let m = log.mark();
  await page.keyboard.press("Enter");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("2")]);
  await waitFor(async () => /still/i.test(await statusOf(w)), 8000);
  // Right arrow (and Tab) go to the next question tab.
  await waitFor(async () => !(await w.locator(".pc-opt").first().isDisabled()), 4000);
  m = log.mark();
  await focusWin(w);
  await page.keyboard.press("ArrowRight");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("right")]);
  await waitFor(async () => !(await w.locator(".pc-opt").first().isDisabled()), 8000);

  // The highlight moves in the pane: the window's follows.
  writeFileSync(file("w1B:p1"), plain(fixture("claude-ask-tabs.ansi")).replace("❯ 1. Red", "  1. Red").replace("  3. Green", "❯ 3. Green"));
  await waitFor(async () => (await selLabel(w)) === "Green", 8000);
  // A digit picks that option.
  m = log.mark();
  await focusWin(w);
  await page.keyboard.press("1");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("1")]);
  await waitFor(async () => /still/i.test(await statusOf(w)), 8000);
  // Answered in the pane: the window closes by itself.
  show("w1B:p1", null);
  await waitFor(async () => (await w.count()) === 0, 10000);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("Type something: a field in the window, the row picked, the text typed literally, Enter", async () => {
  // K3
  show("w1B:p1", "claude-ask-tabs.ansi");
  const p = await waitPrompt((p) => p.question === "Which color should the poster use?");
  const page = await open();
  const w = winOf(page);
  await w.locator(".pc-opt").first().waitFor();
  await focusWin(w);
  // Arrow to it, Enter opens its field, like the pane.
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  assert.equal(await selLabel(w), "Type something.");
  await page.keyboard.press("Enter");
  const field = w.locator(".pc-row.sel .pc-field");
  await waitFor(() => field.evaluate((f) => f === document.activeElement), 3000);
  assert.equal(await field.evaluate((f) => f.tagName), "TEXTAREA", "several lines for Claude");
  // Digits and arrows while typing are text, not keys.
  let m = log.mark();
  await page.keyboard.type('Teal "#0aa" — ünï ✓ 42');
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("with a 2nd line");
  await page.waitForTimeout(400);
  assert.deepEqual(log.since(m), []);
  onKeys("w1B:p1", null);
  await page.keyboard.press("Enter");
  await waitFor(() => log.since(m).length >= 2, 4000);
  assert.equal(rawSince(m).trim(), `${keys("4")}\n${keys("enter")} --text=Teal "#0aa" — ünï ✓ 42\nwith a 2nd line`);
  await waitFor(async () => /cleared/i.test(await statusOf(w)), 8000);
  await page.screenshot({ path: join(artifacts, "keys-other-sent.png") });

  // The API side: newlines only for Claude; a tab or over-long text never.
  show("w1B:p1", "claude-ask-tabs.ansi");
  const q = await waitPrompt((x) => x.sig === p.sig);
  m = log.mark();
  for (const text of ["a\tb", "a\rb", "x".repeat(2001), "\u001b[A"]) {
    const r = await post(url, "/api/thread/alpha/t-0002/answer", { sig: q.sig, option: 3, text });
    assert.equal(r.status, 400, JSON.stringify(text.slice(0, 9)));
  }
  assert.deepEqual(log.since(m), []);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("text typed in the pane shows in the window and is never typed over", async () => {
  // K2, K6
  show("w1B:p1", "claude-ask-other-typed.txt");
  const p = await waitPrompt((x) => x.options[3]?.draft);
  assert.equal(p.options[3].draft, 'Teal "#0aa" — ünï ✓\nwith a 2nd line');
  const page = await open();
  const w = winOf(page);
  await w.locator(".pc-opt").first().waitFor();
  assert.equal(await w.locator(".pc-row.current .pc-field").inputValue(), p.options[3].draft);
  assert.ok(await w.locator(".pc-row.current .pc-field").evaluate((f) => f.readOnly), "the pane's text is not edited here");
  // Picking another row goes by arrows (a digit would be typed into the field).
  let m = log.mark();
  await w.locator(".pc-opt", { hasText: "Blue" }).click();
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("up up enter")]);
  await waitFor(async () => /still/i.test(await statusOf(w)), 8000);
  // Text over the draft is refused; sending it as typed is Enter.
  m = log.mark();
  const r = await post(url, "/api/thread/alpha/t-0002/answer", { sig: p.sig, option: 3, text: "Orange" });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "draft_in_field");
  assert.deepEqual(log.since(m), []);
  onKeys("w1B:p1", null);
  await waitFor(async () => !(await w.locator(".pc-row.current .send").isDisabled()), 4000);
  await w.locator(".pc-row.current .send").click();
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("enter")]);
  await waitFor(async () => /cleared/i.test(await statusOf(w)), 8000);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("multi-select: Space toggles, Other typed without Enter, Submit", async () => {
  // K4
  show("w1B:p1", "claude-ask-multi.txt");
  await waitPrompt((x) => x.multi && x.options.length === 5);
  const page = await open();
  const w = winOf(page);
  await w.locator(".pc-opt").first().waitFor();
  assert.deepEqual(await w.locator(".pc-tab").allInnerTexts(), ["✔ Color", "Extras", "✔ Submit"]);
  await focusWin(w);
  let m = log.mark();
  await page.keyboard.press("Space");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("1")]);
  writeFileSync(file("w1B:p1"), fixture("claude-ask-multi.txt").replace("[ ] Logo", "[✔] Logo"));
  await waitFor(async () => (await w.locator(".pc-opt", { hasText: "Logo" }).getAttribute("aria-pressed")) === "true", 8000);
  // The Other row: its field, the highlight moved there, the text, no Enter.
  const field = w.locator(".pc-row", { hasText: "Type something" }).locator(".pc-field");
  await field.fill('Dark mode "toggle" ✓');
  m = log.mark();
  onKeys("w1B:p1", "claude-ask-multi-typed.txt");
  await field.press("Enter");
  await waitFor(() => log.since(m).length >= 2, 4000);
  assert.deepEqual(log.since(m), [keys("down down down"), `${hp} thread keys alpha t-0002 --text=Dark mode "toggle" ✓`]);
  await waitFor(async () => /typed/i.test(await statusOf(w)), 8000);
  // With text in a question's field herdr says "done", not "blocked" (seen
  // live): the prompt stays all the same.
  writeFileSync(file("w1B:p1") + ".status", "done");
  await page.waitForTimeout(2500);
  assert.equal((await promptOf())?.options[3]?.draft, 'Dark mode "toggle" ✓');
  assert.equal(await w.locator(".pc-opt.submit").count(), 1);
  // Submit from where the pane's highlight now is.
  await waitFor(async () => !(await w.locator(".pc-opt.submit").isDisabled()), 4000);
  m = log.mark();
  onKeys("w1B:p1", null);
  await w.locator(".pc-opt.submit").click();
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("down enter")]);
  rmSync(file("w1B:p1") + ".status");
  await page.screenshot({ path: join(artifacts, "keys-multi.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("permission: Tab opens feedback, deny with text, Esc denies", async () => {
  // K6
  show("w1B:p1", "claude-bash-amend.txt");
  await waitPrompt((x) => x.title === "Bash command" && x.cancel);
  const page = await open();
  const w = winOf(page);
  await w.locator(".pc-opt").first().waitFor();
  assert.match(await w.locator(".pc-cancel").innerText(), /Deny/);
  await focusWin(w);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  assert.equal(await selLabel(w), "No");
  await page.keyboard.press("Tab");
  const field = w.locator(".pc-row.sel .pc-field");
  await waitFor(() => field.evaluate((f) => f === document.activeElement), 3000);
  let m = log.mark();
  await page.keyboard.type("use the 'report' make target instead — ✓");
  onKeys("w1B:p1", null);
  await page.keyboard.press("Enter");
  await waitFor(() => log.since(m).length >= 2, 4000);
  assert.deepEqual(log.since(m), [keys("down down down tab"), `${keys("enter")} --text=use the 'report' make target instead — ✓`]);
  await waitFor(async () => /cleared/i.test(await statusOf(w)), 8000);
  await page.screenshot({ path: join(artifacts, "keys-deny-feedback.png") });
  // Esc in the window is the pane's Esc: deny.
  show("w1B:p1", "claude-bash-amend.txt");
  await waitFor(async () => (await w.count()) === 1 && !(await w.locator(".pc-opt").first().isDisabled()), 10000);
  await focusWin(w);
  m = log.mark();
  onKeys("w1B:p1", null);
  await page.keyboard.press("Escape");
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("esc")]);
  await waitFor(async () => /cleared/i.test(await statusOf(w)), 8000);
  // Mid-amend in the pane: the window shows the text, picks go by arrows.
  show("w1B:p1", "claude-bash-amend-typed.txt");
  const t = await waitPrompt((x) => x.focused);
  assert.equal(t.cancel, undefined, "Esc would leave the field, not deny");
  await waitFor(async () => (await w.count()) === 1, 8000);
  await waitFor(async () => (await w.locator(".pc-row.current .pc-field").inputValue()) === 'skip "this" — café ✓\nsecond line', 8000);
  m = log.mark();
  await w.locator(".pc-opt").first().click();
  await waitFor(() => log.since(m).length > 0, 4000);
  assert.deepEqual(log.since(m), [keys("up up up enter")]);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("plan approval: the plan, approve, or feedback in a field", async () => {
  // K7
  show("w1B:p1", "claude-plan.txt");
  await waitPrompt((x) => x.kind === "plan");
  const page = await open();
  const w = winOf(page);
  await w.locator(".pc-opt").first().waitFor();
  assert.match(await w.locator(".pc-kind").innerText(), /plan/i);
  assert.match(await w.locator(".pc-plan").innerText(), /Put the single line Poster demo in it\./);
  assert.equal(await w.locator(".pc-plan .del").count(), 0, "plan bullets are not a diff");
  const field = w.locator(".pc-row", { hasText: "Tell Claude what to change" }).locator(".pc-field");
  await field.fill("Name it POSTER.md\nand keep it short");
  const m = log.mark();
  onKeys("w1B:p1", null);
  await w.locator(".pc-row", { hasText: "Tell Claude what to change" }).locator(".send").click();
  await waitFor(() => log.since(m).length >= 2, 4000);
  assert.equal(rawSince(m).trim(), `${keys("3")}\n${keys("enter")} --text=Name it POSTER.md\nand keep it short`);
  await waitFor(async () => /cleared/i.test(await statusOf(w)), 8000);
  await page.screenshot({ path: join(artifacts, "keys-plan.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("preview: shown beside the highlighted option; notes with n", async () => {
  // K8
  show("w1B:p1", "claude-ask-preview.txt");
  await waitPrompt((x) => x.notes);
  const page = await open();
  const w = winOf(page);
  await w.locator(".pc-opt").first().waitFor();
  assert.match(await w.locator(".pc-preview").innerText(), /│ Nav  │ Content   │/);
  await focusWin(w);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("n");
  const field = w.locator(".pc-row.sel .pc-field");
  await waitFor(() => field.evaluate((f) => f === document.activeElement), 3000);
  await page.keyboard.type('centered "logo"');
  const m = log.mark();
  onKeys("w1B:p1", null);
  await page.keyboard.press("Enter");
  await waitFor(() => log.since(m).length >= 2, 4000);
  assert.deepEqual(log.since(m), [keys("down n"), `${keys("enter")} --text=centered "logo"`]);
  await waitFor(async () => /cleared/i.test(await statusOf(w)), 8000);
  await page.screenshot({ path: join(artifacts, "keys-preview.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("only allow-listed commands ran", () => {
  const allowed = [
    /^herdr-projects --root \S+ (list|thread list \S+ --json|progress --pane \S+|safety show \S+)$/,
    /^herdr pane (list|get \S+|layout --pane \S+)$/,
    /^herdr pane read \S+ --source (recent|detection) --lines \d+( --format ansi)?$/,
    /^gh pr list /,
    /^herdr-projects --root \S+ thread keys alpha t-0002( (enter|esc|up|down|left|right|tab|space|n|\d))*( --text=.*)?$/,
  ];
  const calls = log.lines();
  for (const c of calls) {
    if (!c.startsWith("herdr")) continue; // the second line of typed text
    assert.ok(allowed.some((re) => re.test(c)), `unexpected command: ${c}`);
  }
  writeFileSync(join(artifacts, "keys-calls.log"), calls.join("\n") + "\n");
});
