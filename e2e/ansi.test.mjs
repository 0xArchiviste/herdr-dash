// E2E: pane screens rendered like the terminal they come from. The screen
// stream and history carry herdr's ANSI text (?ansi=1) and the pane's width;
// static/ansi.js turns SGR into styled spans, everything else into text.
// Fixtures: testdata/screens/*.ansi (Claude Code, Codex, opencode and a
// shell at 76 and 120 columns, fake content). Artifacts: e2e/artifacts/ansi-*.
//
// Ways this could fail, written before the renderer existed:
//  A1. Colours or attributes are lost or wrong: 16-colour codes not mapped
//      to Srcery, 256/truecolor (and the colon form) misread, dim, inverse,
//      italic, underline or strikethrough dropped, a reset not resetting, or
//      a dark colour left unreadable on the dark screen.
//  A2. An escape or the text itself injects HTML: tags in text, an OSC 8
//      link (javascript: URL), an OSC title, DCS or unknown CSI shown as
//      markup or as raw escape garbage.
//  A3. Box drawing does not line up: a right border drifts on rows with
//      wide characters (CJK, emoji are two cells), symbols from a fallback
//      font, or a tab.
//  A4. The browser wraps TUI rows (the pane's width ignored), "fit" still
//      overflows, or the wrap mode and font size are not kept per window.
//  A5. Reader mode keeps borders, spinners and status bars, or drops the
//      transcript itself.
//  A6. Ctrl/Cmd+F inside a window opens the browser's find instead of the
//      screen's, finds nothing in styled text, counts wrong, or stays open.
//  A7. Copy puts escapes or markup on the clipboard, or loses rows.
//  A8. "↓ New output" and "Load earlier" break with styled rows.
//  A9. The ANSI path reads panes more often than the plain one did, or
//      history in another format reads the pane again.
// A10. A long history is parsed in one go and blocks the page.
// A11. Some place still shows a grey wall: the docked panel, the dead-pane
//      shell (#32) (the demo is checked in demo.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-ansi-"));
const stubLog = join(tmp, "calls.log");
const screens = join(tmp, "screens");
mkdirSync(screens);
writeFileSync(stubLog, "");
const fx = (name) => readFileSync(join(td, "screens", name + ".ansi"), "utf8");
const f = (pane, ext) => join(screens, pane.replace(":", "_") + (ext ? "." + ext : ""));
function show(pane, name, cols) {
  writeFileSync(f(pane), typeof name === "string" && name.includes("\n") ? name : fx(name));
  writeFileSync(f(pane, "cols"), String(cols ?? +name.match(/\d+$/)?.[0] ?? 80));
}
// alpha/t-0001 (w1A:p1), alpha/t-0003 (w1C:p1), beta/t-0001 (w2A:p1),
// beta/t-0002 (w2B:p1), the alpha coordinator (w1Z:p1).
show("w1A:p1", "claude-120");
show("w1C:p1", "codex-76");
show("w2A:p1", "opencode-120");
show("w2B:p1", "shell-76");
show("w1Z:p1", "claude-76");
const out = {};

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, [], { STUB_SCREENS: screens });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  writeFileSync(join(artifacts, "ansi.json"), JSON.stringify(out, null, 2) + "\n");
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

async function open(opts = {}) {
  const ctx = opts.ctx || await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}
async function win(page, key) {
  await page.evaluate((k) => window.HDThreadWin.open(k), key);
  const w = page.locator(`.hwin[data-win="thread:${key}"]`);
  await w.locator(".screen .tl").first().waitFor();
  return w;
}
// The computed style of the span holding text t (innermost).
const styleOf = (w, t) => w.locator(".screen").evaluate((pre, t) => {
  const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    if (!n.data.includes(t)) continue;
    const cs = getComputedStyle(n.parentElement);
    return { color: cs.color, bg: cs.backgroundColor, weight: cs.fontWeight, italic: cs.fontStyle, deco: cs.textDecorationLine, opacity: cs.opacity, el: n.parentElement.tagName };
  }
  return null;
}, t);
// Each row's text and the right edge of its last visible character.
const rows = (w) => w.locator(".screen").evaluate((pre) => [...pre.querySelectorAll(".tl")].map((tl) => {
  const r = document.createRange();
  const text = tl.textContent.replace(/\s+$/, "");
  let right = null;
  if (text) {
    const walk = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
    let left = text.length, last = null, off = 0;
    for (let n; (n = walk.nextNode());) { if (left <= 0) break; last = n; off = Math.min(n.data.length, left); left -= n.data.length; }
    r.setStart(last, Math.max(0, off - 1));
    r.setEnd(last, off);
    const span = last.parentElement.closest(".u");
    right = (span || r).getBoundingClientRect().right;
  }
  return { text, right };
}));
const lum = (c) => {
  const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("the stream and history carry ANSI and the pane's width only when asked", async () => {
  const ev = await screenEvent("/api/thread/alpha/t-0001/screen?ansi=1");
  assert.match(ev.screen, /\x1b\[38;2;215;119;87m/);
  assert.equal(ev.ansi, true);
  assert.equal(ev.cols, 120);
  const plain = await screenEvent("/api/thread/alpha/t-0001/screen");
  assert.doesNotMatch(plain.screen, /\x1b/);
  assert.ok(!plain.cols && !plain.ansi);
  const h = await (await fetch(url + "/api/thread/alpha/t-0001/history?lines=200&ansi=1")).json();
  assert.match(h.screen, /\x1b\[/);
  const hp = await (await fetch(url + "/api/thread/alpha/t-0001/history?lines=200")).json();
  assert.doesNotMatch(hp.screen, /\x1b/);
  assert.equal(hp.screen.split("\n").length, h.screen.split("\n").length);
});

test("colours and attributes render; Srcery base colours; readable contrast", async () => {
  // A1
  const page = await open();
  const w = await win(page, "beta/t-0002"); // shell-76
  const scr = w.locator(".screen");
  const bg = await scr.evaluate((e) => getComputedStyle(e).backgroundColor);
  const fg = await scr.evaluate((e) => getComputedStyle(e).color);
  const s = async (t) => { const x = await styleOf(w, t); assert.ok(x, "no text " + t); return x; };
  assert.equal((await s("dev@box")).color, "rgb(81, 159, 80)", "32 is Srcery green");
  assert.equal((await s("~/acme-widgets")).color, "rgb(44, 120, 191)", "34 is Srcery blue");
  assert.equal((await s("-func main()")).color, "rgb(239, 47, 39)", "31 is Srcery red");
  assert.ok(+(await s("bold-red")).weight >= 600);
  assert.equal((await s("bold-red")).color, "rgb(239, 47, 39)");
  assert.ok(+(await s("bold")).weight >= 600, "bold");
  assert.equal((await s("italic")).italic, "italic");
  assert.match((await s("under")).deco, /underline/);
  assert.match((await s("strike")).deco, /line-through/);
  const dim = await s("dim");
  assert.notEqual(dim.color, fg, "dim differs from the default");
  assert.ok(contrast(dim.color, bg) >= 3, "dim stays readable " + dim.color);
  const inv = await s("inverse");
  assert.equal(inv.bg, fg, "inverse: background is the default foreground");
  assert.equal(inv.color, bg, "inverse: text is the default background");
  assert.equal((await s("256-orange")).color, "rgb(255, 135, 0)");
  assert.equal((await s("truecolor")).color, "rgb(100, 200, 255)");
  assert.equal((await s("cube-green")).color, "rgb(0, 175, 0)");
  assert.equal((await s("grey-244")).color, "rgb(128, 128, 128)");
  assert.equal((await s("bg-52")).bg, "rgb(95, 0, 0)");
  assert.equal((await s("colon-magenta")).color, "rgb(255, 0, 255)");
  const ob = await s("on-blue");
  assert.equal(ob.bg, "rgb(44, 120, 191)");
  assert.equal(ob.color, "rgb(243, 237, 227)", "97 is Srcery bright white");
  const blk = await s("black-on-default");
  assert.ok(contrast(blk.color, bg) >= 3, "black text stays readable on the dark screen: " + blk.color);
  // A reset resets: the text after a coloured word is the default again.
  assert.equal((await s(" init demo")).color, fg);
  // Erase-in-line (\e[K) leaves nothing behind.
  assert.match(await scr.innerText(), /3:func main\(\) \{ println\("hello"\) \}/);
  const grep = await scr.evaluate((pre) => {
    const row = [...pre.querySelectorAll(".tl")].find((l) => l.textContent.startsWith("3:func"));
    const m = [...row.querySelectorAll("span")].find((x) => x.textContent === "main");
    return m && getComputedStyle(m).color;
  });
  assert.equal(grep, "rgb(239, 47, 39)", "grep's match is red");
  // Claude Code's truecolor accents and the prompt row's background.
  const c = await win(page, "alpha/t-0001");
  assert.equal((await styleOf(c, "Summarising")).color, "rgb(215, 119, 87)");
  assert.equal((await styleOf(c, "> Read README.md")).bg, "rgb(55, 55, 55)");
  assert.ok(+(await styleOf(c, "Bash")).weight >= 600);
  await w.screenshot({ path: join(artifacts, "ansi-shell-76.png") });
  await c.screenshot({ path: join(artifacts, "ansi-claude-120.png") });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("no HTML gets in through escapes or text", async () => {
  // A2
  const evil = [
    "\x1b[31m<img src=x onerror=\"window.__pwned=1\">red</img>\x1b[0m",
    "\x1b]8;;javascript:window.__pwned=2\x1b\\click me\x1b]8;;\x1b\\ and \x1b]8;;https://example.com\x07a link\x1b]8;;\x07",
    "\x1b]0;<script>window.__pwned=3</script>\x07title gone",
    "\x1bP1;2|<b>dcs</b>\x1b\\after dcs",
    "\x1b[38;2;999;-1;x<b>m bad params\x1b[0m \x1b[?25l\x1b[2J\x1b[Hcursor moves dropped",
    "\x1b[38;5;300mout of range\x1b[0m \x1b[1m&amp; &lt;b&gt; \"quotes\" 'single'\x1b[0m",
    "<style>.screen{display:none}</style><svg onload=window.__pwned=4>",
    "trailing lone escape \x1b",
  ].join("\n") + "\n";
  show("w1C:p1", evil, 76);
  const page = await open();
  const w = await win(page, "alpha/t-0003");
  await waitFor(async () => (await w.locator(".screen").innerText()).includes("trailing lone escape"));
  const scr = w.locator(".screen");
  const tags = await scr.evaluate((e) => [...e.querySelectorAll("*")].map((x) => x.tagName.toLowerCase()).filter((t) => t !== "span"));
  assert.deepEqual([...new Set(tags)], [], "only spans inside the screen");
  const text = await scr.evaluate((e) => e.textContent);
  assert.ok(!/\x1b|\x07|\]8;;|\]0;/.test(text), "no escape residue: " + JSON.stringify(text));
  for (const t of ["<img src=x onerror=", "click me", "a link", "title gone", "after dcs", "cursor moves dropped", "&amp; &lt;b&gt;", "<style>.screen{display:none}</style>"]) assert.ok(text.includes(t), "shows as text: " + t);
  assert.ok(!text.includes("<script>"), "an OSC title is not shown");
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await scr.isVisible(), true);
  assert.equal((await styleOf(w, "<img")).color, "rgb(239, 47, 39)");
  assert.deepEqual(page.errors, []);
  await page.context().close();
  show("w1C:p1", "codex-76");
});

test("boxes line up at 76 and 120 columns, wide characters take two cells", async () => {
  // A3, A4 (pane width)
  // The 120-column fixtures go to alpha/t-0001's pane, the 76-column ones
  // to alpha/t-0003's: a pane keeps its width, as real panes do.
  const page = await open({ viewport: { width: 1600, height: 1000 } });
  const wins = { 120: await win(page, "alpha/t-0001"), 76: await win(page, "alpha/t-0003") };
  const panes = { 120: "w1A:p1", 76: "w1C:p1" };
  const report = {};
  const strip = (t) => t.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  try {
  for (const name of ["claude-76", "claude-120", "codex-76", "codex-120", "opencode-76", "opencode-120", "shell-76", "shell-120"]) {
    const cols = +name.split("-")[1];
    const w = wins[cols];
    await page.evaluate((k) => window.HDWin.restore("thread:" + k), cols === 120 ? "alpha/t-0001" : "alpha/t-0003");
    await w.evaluate((e) => { e.style.width = "1500px"; e.style.left = "10px"; });
    show(panes[cols], name);
    const ls = strip(fx(name)).filter((l) => /\S/.test(l));
    await waitFor(async () => {
      const t = await w.locator(".screen").innerText();
      return (await w.locator(".screen").getAttribute("data-cols")) === String(cols) && t.includes(ls[0].trim()) && t.includes(ls[ls.length - 1].trim());
    }, 10_000);
    const rs = await rows(w);
    const ch = await w.locator(".screen").evaluate((pre) => { const s = document.createElement("span"); s.textContent = "0".repeat(100); pre.append(s); const x = s.getBoundingClientRect().width / 100; s.remove(); return x; });
    const left = await w.locator(".screen .tl").first().evaluate((e) => e.getBoundingClientRect().left);
    // Every row is one line high: nothing wrapped.
    const heights = await w.locator(".screen .tl").evaluateAll((ls) => {
      const lh = parseFloat(getComputedStyle(ls[0].parentElement).lineHeight);
      return ls.map((l) => l.getBoundingClientRect().height / lh);
    });
    assert.ok(heights.every((n) => n < 1.9), `${name}: a row wrapped: ${JSON.stringify(rs.filter((r, k) => heights[k] >= 1.9).map((r) => r.text))}`);
    // Rows ending in a box edge (│ ╮ ╯ ┃ or the ruler's |) end where their cell count says.
    const edges = rs.filter((r) => /[│╮╯|▀█┃┘┤┐]$/.test(r.text) && r.right != null);
    assert.ok(edges.length >= 3, `${name}: rows with edges`);
    const off = edges.map((r) => {
      const cells = [...r.text].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}]/u.test(c) ? 2 : 1), 0);
      return Math.abs((r.right - left) / ch - (r.text.startsWith("\t") ? cells + 7 : cells));
    });
    report[name] = { rows: rs.length, edges: edges.length, worstCellOffset: +Math.max(...off).toFixed(3), ch: +ch.toFixed(2) };
    assert.ok(Math.max(...off) < 0.25, `${name}: an edge is off its cell by ${Math.max(...off)} (${JSON.stringify(edges.map((e) => e.text.slice(-12)))})`);
    await w.locator(".screen").screenshot({ path: join(artifacts, `ansi-box-${name}.png`) });
  }
  } finally {
    show("w1A:p1", "claude-120");
    show("w1C:p1", "codex-76");
  }
  out.alignment = report;
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("font size and wrap mode are kept per window", async () => {
  // A4
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  let page = await open({ ctx });
  let w = await win(page, "alpha/t-0001"); // 120 columns
  const pre = () => w.locator(".screen");
  const size = async () => parseFloat(await pre().evaluate((e) => getComputedStyle(e).fontSize));
  const s0 = await size();
  await w.locator('.screen-tools [data-act="bigger"]').click();
  await w.locator('.screen-tools [data-act="bigger"]').click();
  assert.equal(await size(), s0 + 2);
  // Pane width: no wrapping, scrolls sideways when the window is narrower.
  await w.evaluate((e) => { e.style.width = "520px"; });
  assert.equal(await pre().getAttribute("data-wrap"), "pane");
  assert.ok(await pre().evaluate((e) => e.scrollWidth > e.clientWidth + 50), "scrolls sideways");
  // Fit: the 120 columns fit the window's width.
  await w.locator('.screen-tools [data-act="wrap"]').click();
  assert.equal(await pre().getAttribute("data-wrap"), "fit");
  await waitFor(async () => pre().evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  // Wrap: the browser wraps long rows.
  await w.locator('.screen-tools [data-act="wrap"]').click();
  assert.equal(await pre().getAttribute("data-wrap"), "wrap");
  assert.ok(await pre().evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  // The panel's box is another window: its own settings.
  const other = await win(page, "alpha/t-0003");
  assert.equal(await other.locator(".screen").getAttribute("data-wrap"), "pane");
  assert.equal(parseFloat(await other.locator(".screen").evaluate((e) => getComputedStyle(e).fontSize)), s0);
  await page.close();
  // A reload brings the window back with its settings.
  page = await ctx.newPage();
  await page.goto(url + "/");
  w = page.locator('.hwin[data-win="thread:alpha/t-0001"]');
  await w.locator(".screen .tl").first().waitFor();
  assert.equal(await pre().getAttribute("data-wrap"), "wrap");
  assert.equal(await size(), s0 + 2);
  await w.locator('.screen-tools [data-act="smaller"]').click();
  assert.equal(await size(), s0 + 1);
  await ctx.close();
});

test("reader mode drops TUI chrome and keeps the transcript", async () => {
  // A5
  const page = await open();
  const w = await win(page, "alpha/t-0001");
  await waitFor(async () => (await w.locator(".screen").innerText()).includes("Welcome to Claude Code"), 8000);
  const btn = w.locator('.screen-tools [data-act="reader"]');
  await btn.click();
  assert.equal(await btn.getAttribute("aria-pressed"), "true");
  const text = await w.locator(".screen").innerText();
  for (const keep of ["Read(README.md)", "Bash(wc -l README.md main.go)", "Both files are tiny", "README.md │ 2", "main.go prints hello", "Welcome to Claude Code"]) assert.ok(text.includes(keep), "keeps " + keep);
  for (const drop of ["╭──", "╰──", "esc to interrupt", "? for shortcuts", "shift+tab to cycle", "────────"]) assert.ok(!text.includes(drop), "drops " + drop);
  assert.ok(!/^│|│$/m.test(text), "no box sides");
  assert.ok(!/\n\n\n/.test(text), "blank runs collapse");
  // Codex and opencode too.
  show("w1A:p1", "codex-120");
  await waitFor(async () => (await w.locator(".screen").innerText()).includes("Two small files"), 8000);
  let t2 = await w.locator(".screen").innerText();
  assert.ok(!/esc to interrupt|\? for shortcuts|context left|╭|╰/.test(t2), t2);
  assert.ok(t2.includes("Ran wc -l README.md main.go"));
  show("w1A:p1", "opencode-120");
  await waitFor(async () => (await w.locator(".screen").innerText()).includes("Both files are small"), 8000);
  t2 = await w.locator(".screen").innerText();
  assert.ok(!/esc interrupt|ctrl\+p commands|▀▀▀▀▀▀|█▀▀█|⬝⬝⬝/.test(t2), t2);
  assert.ok(t2.includes("Read README.md and main.go, then summarise them."));
  await w.screenshot({ path: join(artifacts, "ansi-reader.png") });
  await btn.click();
  assert.match(await w.locator(".screen").innerText(), /tab agents/);
  show("w1A:p1", "claude-120");
  await page.context().close();
});

test("Ctrl+F searches the window's screen", async () => {
  // A6
  const page = await open();
  const w = await win(page, "alpha/t-0001");
  await w.locator(".tw-input").click();
  await page.keyboard.press("Control+f");
  const find = w.locator(".screen-find");
  await find.waitFor();
  const input = find.locator("input");
  assert.equal(await input.evaluate((e) => e === document.activeElement), true);
  await input.fill("readme");
  const count = find.locator(".sf-count");
  const n = fx("claude-120").match(/readme/gi).length;
  await waitFor(async () => (await count.innerText()) === `1/${n}`);
  assert.ok(await w.locator(".screen .tl.hit").count() >= 1);
  const hl = await page.evaluate(() => (window.CSS?.highlights ? CSS.highlights.get("hd-find").size + CSS.highlights.get("hd-find-cur").size : -1));
  assert.ok(hl === -1 || hl === n, "highlights every match: " + hl);
  await input.press("Enter");
  assert.equal(await count.innerText(), `2/${n}`);
  await input.press("Shift+Enter");
  await input.press("Shift+Enter");
  assert.equal(await count.innerText(), `${n}/${n}`, "wraps around");
  // Matches across styled spans: "Bash(wc" spans a bold run and plain text.
  await input.fill("bash(wc");
  await waitFor(async () => (await count.innerText()) === "1/1");
  await input.fill("no such words");
  await waitFor(async () => (await count.innerText()) === "0/0");
  await w.screenshot({ path: join(artifacts, "ansi-find.png") });
  await input.press("Escape");
  assert.equal(await find.isHidden(), true);
  assert.equal(await w.locator(".screen .tl.hit").count(), 0);
  // Outside any window, Ctrl+F stays the browser's.
  await page.locator("#graph, svg").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press("Control+f");
  assert.equal(await find.isHidden(), true);
  await page.context().close();
});

test("copy puts the plain screen on the clipboard", async () => {
  // A7
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
  const page = await open({ ctx });
  const w = await win(page, "alpha/t-0001");
  await w.locator('.screen-tools [data-act="copy"]').click();
  await waitFor(async () => /Copied/.test(await w.locator('.screen-tools [data-act="copy"]').innerText()));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const want = fx("claude-120").replace(/\x1b\[[0-9;:]*m/g, "").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim();
  assert.ok(!/\x1b|<span/.test(clip));
  assert.equal(clip.trim(), want);
  await ctx.close();
});

test("new output and load earlier work with styled rows", async () => {
  // A8, A10
  const long = Array.from({ length: 2400 }, (_, i) => `\x1b[38;5;${16 + (i % 200)}mrow ${i + 1}\x1b[0m \x1b[1mbold ${i + 1}\x1b[0m │ cell`).join("\n");
  show("w1A:p1", long + "\n", 120);
  const page = await open();
  await page.evaluate(() => {
    window.__long = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration); }).observe({ type: "longtask", buffered: false });
  });
  const w = await win(page, "alpha/t-0001");
  const pre = w.locator(".screen");
  await waitFor(async () => (await pre.innerText()).includes("row 2400"));
  // Load earlier until the cap.
  for (let i = 0; i < 6; i++) {
    const before = await pre.locator(".tl").count();
    if (before >= 2000) break;
    await pre.evaluate((e) => { e.scrollTop = 0; e.dispatchEvent(new Event("scroll")); });
    await waitFor(async () => (await pre.locator(".tl").count()) > before, 20_000)
      .catch(async (e) => { throw new Error(`no earlier rows after ${before}: ${await w.locator(".screen-top").innerText()} / ${await pre.locator(".tl").count()}`); });
  }
  assert.equal(await pre.locator(".tl").count(), 2000);
  // Rows loaded earlier get their colours too, a frame budget at a time.
  await waitFor(async () => (await pre.locator(".tl.raw").count()) === 0, 8000);
  // row 431: colour 16 + 30, the cube's (0, 5, 0).
  assert.equal((await styleOf(w, "row 431")).color, "rgb(0, 255, 0)");
  out.longestTaskMsLoading2000Rows = Math.round(await page.evaluate(() => window.__long));
  assert.ok(out.longestTaskMsLoading2000Rows < 400, "longest task " + out.longestTaskMsLoading2000Rows);
  // Scrolled up, new output shows the jump button; it goes to the bottom.
  await pre.evaluate((e) => { e.scrollTop = 0; });
  show("w1A:p1", long + "\n\x1b[32mfresh output\x1b[0m\n", 120);
  await w.locator(".new-output:not([hidden])").waitFor({ timeout: 8000 });
  await w.locator(".new-output").click();
  assert.equal(await pre.evaluate((e) => e.scrollTop + e.clientHeight >= e.scrollHeight - 8), true);
  assert.equal((await styleOf(w, "fresh output")).color, "rgb(81, 159, 80)");
  show("w1A:p1", "claude-120");
  await page.context().close();
});

test("ANSI costs no more pane reads than plain text", async () => {
  // A9: measured on the same pane for the same time, plain then ANSI.
  const reads = (from) => readFileSync(stubLog, "utf8").split("\n").slice(from).filter((l) => /pane read w2A:p1 /.test(l)).length;
  const mark = () => readFileSync(stubLog, "utf8").split("\n").length - 1;
  const watch = async (q, ms) => {
    const ctl = new AbortController();
    const r = await fetch(url + "/api/thread/beta/t-0001/screen" + q, { signal: ctl.signal });
    const rd = r.body.getReader();
    const end = Date.now() + ms;
    try { while (Date.now() < end) await Promise.race([rd.read(), new Promise((res) => setTimeout(res, 200))]); } finally { ctl.abort(); }
  };
  await new Promise((r) => setTimeout(r, 3500)); // nothing cached
  let m = mark();
  await watch("", 9000);
  const plain = reads(m);
  await new Promise((r) => setTimeout(r, 3500));
  m = mark();
  await watch("?ansi=1", 9000);
  const ansi = reads(m);
  out.paneReadsPer9s = { plain, ansi };
  assert.ok(ansi <= plain, `ANSI ${ansi} reads vs plain ${plain}`);
  // History: one read serves both formats.
  await new Promise((r) => setTimeout(r, 5500));
  m = mark();
  await fetch(url + "/api/thread/beta/t-0001/history?lines=300&ansi=1").then((r) => r.json());
  await fetch(url + "/api/thread/beta/t-0001/history?lines=300").then((r) => r.json());
  await fetch(url + "/api/thread/beta/t-0001/history?lines=200&ansi=1").then((r) => r.json());
  out.historyReadsFor3Requests = reads(m);
  assert.equal(reads(m), 1);
  // The width is asked of herdr at most once a minute per pane.
  const layouts = readFileSync(stubLog, "utf8").split("\n").filter((l) => /pane layout .*w2A:p1/.test(l)).length;
  out.layoutCallsW2A = layouts;
  assert.ok(layouts <= 1, "layout calls " + layouts);
});

test("the docked panel and the dead-pane shell render ANSI too", async () => {
  // A11
  const page = await open();
  await page.evaluate(() => window.hd.select("beta/t-0002"));
  const scr = page.locator("#p-chat .screen");
  await scr.locator(".tl").first().waitFor();
  const green = await scr.evaluate((pre) => [...pre.querySelectorAll("span")].find((s) => s.textContent === "dev@box") && getComputedStyle([...pre.querySelectorAll("span")].find((s) => s.textContent === "dev@box")).color);
  assert.equal(green, "rgb(81, 159, 80)");
  assert.ok(await page.locator("#p-chat .screen-tools").isVisible());
  // A pane whose agent exited: its shell screen in colour, under the command line.
  writeFileSync(f("w2B:p1", "noagent"), "");
  const w = await win(page, "beta/t-0002");
  await w.locator(".hd-term .ht-banner").waitFor({ timeout: 10_000 });
  assert.equal((await styleOf(w, "dev@box")).color, "rgb(81, 159, 80)");
  await w.screenshot({ path: join(artifacts, "ansi-dead-pane.png") });
  rmSync(f("w2B:p1", "noagent"));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

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
