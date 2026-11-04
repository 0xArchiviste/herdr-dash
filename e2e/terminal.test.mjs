// E2E for panes whose agent exited: Dash shows it on the node, in the
// System strip and in the panel and window, turns the chat into a command
// line for the shell left in the pane, offers raw keys, and brings the agent
// back with herdr-projects. The stub herdr lists a pane with no agent while
// STUB_SCREENS/<pane>.noagent exists. Artifacts: e2e/artifacts/terminal-*.
//
// Ways this could fail, written before the feature existed:
//  X1. An exited agent is not told apart from a live one (or a pane that is
//      gone, or a thread still being launched is called exited).
//  X2. The node, the strip and the window look the same as for a live agent.
//  X3. The command line changes what was typed (quotes, $, \, unicode),
//      runs a multi-line paste line by line, or sends no Enter.
//  X4. History is missing, or Up/Down lose the line being typed.
//  X5. Ctrl+C is sent as a key herdr encodes for the dead agent's keyboard
//      mode (bash sees garbage) instead of the raw byte.
//  X6. Text reaches a pane whose agent is alive (busy) without the user
//      switching to keys mode, a pane not ours, or a resolved thread; control
//      characters, cross-origin writes and read-only mode get through.
//  X7. Keys mode on a live agent goes around herdr's key encoder, or reaches
//      a trust screen.
//  X8. Restart runs without a confirmation, runs anything but
//      `herdr-projects thread restart` / `open`, or runs while the agent is up.
//  X9. A resumable coordinator is not offered "Resume session", or a thread
//      is promised a resume herdr-projects cannot do.
// X10. The screen does not follow what the command printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-term-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
mkdirSync(screens);
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const hp = "herdr-projects --root " + join(td, "root");
const f = (pane, ext) => join(screens, pane.replace(":", "_") + (ext ? "." + ext : ""));
const PROMPT = "user@host:~/wt/alpha-t-0001$ ";
// alpha/t-0001's agent (w1A:p1) and alpha's coordinator (w1Z:p1) exited.
function kill(pane) {
  writeFileSync(f(pane, "noagent"), "");
  writeFileSync(f(pane), "› Killed\n" + PROMPT + "\n");
}
kill("w1A:p1");
kill("w1Z:p1");
writeFileSync(join(screens, "alpha_t-0001.pane"), "w1A_p1");
writeFileSync(join(screens, "hub_alpha.pane"), "w1Z_p1");

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
const thread = async (key) => (await state()).threads.find((t) => t.key === key);
const coord = async (slug) => (await state()).projects.find((p) => p.slug === slug).coordinator;
async function open(viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
// One screen event from a pane's SSE stream.
async function screenEvent(path) {
  const ctl = new AbortController();
  const r = await fetch(url + path, { signal: ctl.signal });
  const rd = r.body.getReader();
  let buf = "";
  try {
    for (;;) {
      const { value } = await rd.read();
      buf += new TextDecoder().decode(value);
      const m = buf.match(/data: (.*)\n\n/);
      if (m) return JSON.parse(m[1]);
    }
  } finally { ctl.abort(); }
}
const sent = (m) => log.since(m).filter((l) => / pane send-(text|keys) /.test(l));

test("an exited agent is told apart from a live one, a gone pane and a launch", async () => {
  // X1
  const t = await waitFor(async () => { const x = await thread("alpha/t-0001"); return x.agent_exited && x; });
  assert.equal(t.pane_alive, true);
  for (const k of ["alpha/t-0002", "alpha/t-0003", "alpha/t-0005", "alpha/t-0004"]) assert.ok(!(await thread(k)).agent_exited, k);
  const co = await coord("alpha");
  assert.equal(co.agent_exited, true);
  assert.equal(co.state, "exited");
  assert.equal(co.resumable, true, "claude with a recorded session resumes");
  assert.ok(!(await coord("beta")).agent_exited);
  const ev = await screenEvent("/api/thread/alpha/t-0001/screen");
  assert.equal(ev.agent_exited, true);
  assert.equal(ev.shell, true);
  assert.equal(ev.foreground, "bash");
  assert.match(ev.screen, /user@host/);
  const live = await screenEvent("/api/thread/alpha/t-0002/screen");
  assert.ok(!live.agent_exited);
});

test("node, strip and window show the exited agent; the window's input is a command line", async () => {
  // X2, X3, X4, X10
  const page = await open();
  await page.waitForSelector('g.node.thread.exited[data-key="alpha/t-0001"], g.node.thread.exited');
  assert.equal(await page.locator("g.node.thread.exited").count(), 1);
  assert.equal(await page.locator("g.node.hub.exited").count(), 1);
  const pill = page.locator('.sysc[data-id="agents"] .sn[data-k="exited"]');
  await waitFor(async () => (await pill.innerText()) === "2");
  await page.evaluate(() => window.HDThreadWin.open("alpha/t-0001"));
  const win = page.locator('.thread-win');
  await win.locator(".hd-term .ht-banner").waitFor();
  assert.match(await win.locator(".ht-banner").innerText(), /Agent exited/);
  assert.match(await win.locator(".ht-banner").innerText(), /bash/);
  assert.equal(await win.locator(".chat-row").isVisible(), false, "no chat with a dead agent");
  const input = win.locator(".ht-input");
  const cmd = `echo "a b" $HOME 'q' \\; | cat # é ✓`;
  let m = log.mark();
  await input.fill(cmd);
  await input.press("Enter");
  await waitFor(() => sent(m).length === 1);
  assert.deepEqual(sent(m), [`herdr pane send-text w1A:p1 $'\\E[200~echo "a b" $HOME \\'q\\' \\\\; | cat # é ✓\\E[201~\\r'`]);
  assert.equal(await input.inputValue(), "");
  await waitFor(async () => (await win.locator(".screen").innerText()).includes(`$ echo "a b" $HOME 'q'`), 8000);
  // History: Up recalls, Down returns to the line being typed.
  m = log.mark();
  await input.fill("ls -la");
  await input.press("Enter");
  await waitFor(() => sent(m).length === 1);
  await input.fill("half typed");
  await input.press("ArrowUp");
  assert.equal(await input.inputValue(), "ls -la");
  await input.press("ArrowUp");
  assert.equal(await input.inputValue(), cmd);
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  assert.equal(await input.inputValue(), "half typed");
  // A multi-line paste is one bracketed paste and one Enter.
  m = log.mark();
  await input.fill("");
  await page.evaluate(() => { const i = document.querySelector(".thread-win .ht-input"); i.value = "echo one\necho two"; });
  await input.press("Enter");
  await waitFor(() => sent(m).length === 1);
  assert.deepEqual(sent(m), [`herdr pane send-text w1A:p1 $'\\E[200~echo one\\necho two\\E[201~\\r'`]);
  // Ctrl+C is the raw byte (X5), from the button and from the field.
  m = log.mark();
  await win.locator('.ht-ctl[data-key="ctrl+c"]').click();
  await waitFor(() => sent(m).length === 1);
  assert.deepEqual(sent(m), [`herdr pane send-text w1A:p1 $'\\003'`]);
  m = log.mark();
  await input.focus();
  await page.keyboard.press("Control+c");
  await waitFor(() => sent(m).length === 1);
  assert.deepEqual(sent(m), [`herdr pane send-text w1A:p1 $'\\003'`]);
  assert.match(await win.locator(".ht-log").innerText(), /Sent Ctrl\+C/);
  await win.screenshot({ path: join(artifacts, "terminal-window.png") });
  await page.screenshot({ path: join(artifacts, "terminal-page.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("keys mode sends raw keys to the dead pane, batched", async () => {
  const page = await open();
  await page.evaluate(() => window.hd.select("alpha/t-0001"));
  const term = page.locator("#p-chat .hd-term");
  await term.locator(".ht-banner").waitFor();
  assert.equal(await page.locator("#p-chat .chat-row").isVisible(), false);
  const m = log.mark();
  await term.locator(".ht-mode").click();
  const pad = term.locator(".ht-keys");
  await pad.waitFor();
  await pad.focus();
  await page.keyboard.type("q");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await waitFor(() => sent(m).length >= 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent(m).join("\n"), `herdr pane send-text w1A:p1 $'q\\E\\E[A\\r'`);
  await page.close();
});

test("guard: live agents, other panes, control characters, cross-origin", async () => {
  // X6, X7
  const m = log.mark();
  let r = await post(url, "/api/thread/alpha/t-0002/term", { mode: "line", text: "rm -rf x" });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "agent_alive");
  r = await post(url, "/api/thread/alpha/t-0002/term", { mode: "line", keys: ["ctrl+c"] });
  assert.equal(r.status, 409);
  r = await post(url, "/api/project/beta/term", { mode: "line", text: "ls" });
  assert.equal(r.status, 409);
  r = await post(url, "/api/thread/alpha/t-0004/term", { mode: "line", text: "ls" });
  assert.equal(r.status, 409, "resolved");
  r = await post(url, "/api/thread/alpha/t-9999/term", { mode: "line", text: "ls" });
  assert.equal(r.status, 404);
  r = await post(url, "/api/thread/alpha/t-0001/term", { mode: "line", text: "ls\u001b[2J" });
  assert.equal(r.status, 400);
  r = await post(url, "/api/thread/alpha/t-0001/term", { mode: "line", text: "ls" }, { Origin: "http://evil.example" });
  assert.equal(r.status, 403);
  r = await post(url, "/api/thread/alpha/t-0001/term", { mode: "keys", seq: [{ key: "ctrl+alt+del" }] });
  assert.equal(r.status, 400);
  r = await post(url, "/api/thread/alpha/t-0001/term", { mode: "shell", text: "ls" });
  assert.equal(r.status, 400);
  assert.deepEqual(sent(m), []);
  // Another program in front of the shell: text goes in without paste brackets.
  writeFileSync(f("w1A:p1", "fg"), "python3");
  r = await post(url, "/api/thread/alpha/t-0001/term", { mode: "line", text: "print(1)" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await post(url, "/api/thread/alpha/t-0001/term", { mode: "line", text: "a\nb" });
  assert.equal(r.status, 400, "no newlines without bracketed paste");
  rmSync(f("w1A:p1", "fg"));
  assert.deepEqual(sent(m), [`herdr pane send-text w1A:p1 $'print(1)\\r'`]);
  // Keys mode on a live agent: explicit, through herdr's key encoder.
  const k = log.mark();
  r = await post(url, "/api/thread/alpha/t-0003/term", { mode: "keys", seq: [{ text: "hi" }, { key: "enter" }, { key: "ctrl+c" }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(sent(k), ["herdr pane send-text w1C:p1 hi", "herdr pane send-keys w1C:p1 enter", "herdr pane send-keys w1C:p1 ctrl+c"]);
});

test("guard: a read-only dashboard refuses terminal writes", async () => {
  const port = await freePort();
  const ro = startServer(port, stubLog, ["--read-only"], { STUB_SCREENS: screens });
  try {
    await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).threads.length > 0);
    const m = log.mark();
    const r = await post(`http://127.0.0.1:${port}`, "/api/thread/alpha/t-0001/term", { mode: "line", text: "ls" });
    assert.equal(r.status, 403);
    const s = await post(`http://127.0.0.1:${port}`, "/api/thread/alpha/t-0001/restart", { confirm: "alpha/t-0001" });
    assert.equal(s.status, 403);
    assert.deepEqual(sent(m), []);
  } finally { ro.kill(); }
});

test("restart: refused while the agent runs or unconfirmed; from the window after a confirmation", async () => {
  // X8, X9
  let m = log.mark();
  let r = await post(url, "/api/thread/alpha/t-0002/restart", { confirm: "alpha/t-0002" });
  assert.equal(r.status, 409);
  r = await post(url, "/api/thread/alpha/t-0001/restart", {});
  assert.equal(r.status, 400);
  assert.deepEqual(log.since(m).filter((l) => / restart /.test(l)), []);
  const page = await open();
  await page.evaluate(() => window.HDThreadWin.open("alpha/t-0001"));
  const win = page.locator(".thread-win");
  await win.locator(".ht-banner").waitFor();
  assert.equal(await win.locator('[data-act="resume"]').count(), 0, "threads restart fresh: no resume promised");
  assert.equal(await win.locator('[data-act="resolve"]').count(), 1);
  await win.locator('[data-act="restart"]').click();
  await page.waitForSelector("#dlg[open]");
  assert.match(await page.locator("#dlg-msg").innerText(), /fresh session/);
  await page.locator("#dlg-cancel").click();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(log.since(m).filter((l) => / restart /.test(l)), []);
  m = log.mark();
  await win.locator('[data-act="restart"]').click();
  await page.locator("#dlg-ok").click();
  await waitFor(() => log.since(m).includes(`${hp} thread restart alpha t-0001`));
  assert.equal(existsSync(f("w1A:p1", "noagent")), false);
  // The window follows the agent coming back: the chat returns.
  await win.locator(".chat-row").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await win.locator(".ht-banner").isVisible(), false);
  assert.ok(!(await thread("alpha/t-0001")).agent_exited);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("coordinator: Resume session runs `open`, after a confirmation", async () => {
  // X8, X9
  const page = await open();
  await page.evaluate(() => window.hd.select("hub:alpha"));
  const term = page.locator("#p-chat .hd-term");
  await term.locator(".ht-banner").waitFor();
  assert.equal(await term.locator('[data-act="resolve"]').count(), 0);
  // A command line works on the coordinator's shell too.
  let m = log.mark();
  await term.locator(".ht-input").fill("git status");
  await term.locator(".ht-input").press("Enter");
  await waitFor(() => sent(m).length === 1);
  assert.deepEqual(sent(m), [`herdr pane send-text w1Z:p1 $'\\E[200~git status\\E[201~\\r'`]);
  m = log.mark();
  await term.locator('[data-act="resume"]').click();
  await page.waitForSelector("#dlg[open]");
  assert.match(await page.locator("#dlg-msg").innerText(), /Resume/);
  await page.locator("#dlg-ok").click();
  await waitFor(() => log.since(m).includes(`${hp} open alpha`));
  await waitFor(async () => !(await coord("alpha")).agent_exited, 8000);
  await page.screenshot({ path: join(artifacts, "terminal-coordinator.png") });
  writeFileSync(join(artifacts, "terminal-calls.log"), log.lines().filter((l) => !/ (list|pane read|pr list|progress --pane|safety show|pane list|pane get|pane process-info)( |$)/.test(l)).join("\n") + "\n");
  assert.deepEqual(page.errors, []);
  await page.close();
});
