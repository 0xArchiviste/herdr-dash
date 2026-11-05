// Generates the ANSI screen fixtures in this folder (node gen.mjs). They are
// modelled on `herdr pane read --format ansi` captures of Claude Code, Codex,
// opencode and a plain shell at 76 and 120 columns, with every word replaced
// by fake content: the escapes are the kinds those programs print (truecolor
// accents, 16- and 256-colour palettes, dim, inverse, erase-in-line), rows
// end with a reset the way herdr writes them, and boxes are padded to the
// pane's width counting wide characters as two cells.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const E = "\x1b[";
const rgb = (r, g, b) => `${E}38;2;${r};${g};${b}m`;
const bgrgb = (r, g, b) => `${E}48;2;${r};${g};${b}m`;
const R = `${E}0m`;
const strip = (s) => s.replace(/\x1b\[[0-9;:?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
const wide = (c) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}]/u.test(c);
const cells = (s) => [...strip(s)].reduce((n, c) => n + (c === "\t" ? 8 : wide(c) ? 2 : 1), 0);
const pad = (s, w) => s + " ".repeat(Math.max(0, w - cells(s)));

// A rounded box w cells wide around rows, in colour col.
function box(w, rows, col) {
  const out = [col + "╭" + "─".repeat(w - 2) + "╮" + R];
  for (const r of rows) out.push(col + "│" + R + pad(" " + r, w - 2) + col + "│" + R);
  out.push(col + "╰" + "─".repeat(w - 2) + "╯" + R);
  return out;
}

function claude(w) {
  const org = rgb(215, 119, 87), grey = rgb(153, 153, 153), line = rgb(136, 136, 136), ok = rgb(78, 186, 101), white = rgb(255, 255, 255);
  return [
    ...box(w, [`${org}✻${R} Welcome to ${E}1mClaude Code${R}!`, "", `${grey}/help for help, /status for your current setup${R}`, "", `${grey}cwd: ~/src/acme-widgets${R}`], org),
    "",
    `${bgrgb(55, 55, 55)}${white}> Read README.md and main.go, then summarise them.${R}`,
    "",
    `${ok}⏺${R} ${E}1mRead${R}(README.md)`,
    `  ${grey}⎿  Read 2 lines${R}`,
    "",
    `${ok}⏺${R} ${E}1mBash${R}(wc -l README.md main.go)`,
    `  ${grey}⎿     2 README.md${R}`,
    `  ${grey}      3 main.go${R}`,
    `  ${grey}      5 total${R}`,
    "",
    `${ok}⏺${R} Both files are tiny:`,
    "",
    `  ┌───────────┬───────┐`,
    `  │ ${E}1mFile${R}      │ ${E}1mLines${R} │`,
    `  ├───────────┼───────┤`,
    `  │ README.md │ 2     │`,
    `  │ main.go   │ 3     │`,
    `  └───────────┴───────┘`,
    "",
    `  ${E}3mmain.go${R} prints ${rgb(177, 185, 249)}hello${R}; the README names the demo.`,
    "",
    `${ok}⏺${R} ${E}1mUpdate${R}(main.go)`,
    `  ${grey}⎿  Updated main.go with 1 addition and 1 removal${R}`,
    `      ${grey}3${R} ${bgrgb(122, 41, 54)}${white}-func main() { println("hello") }${R}`,
    `      ${grey}3${R} ${bgrgb(34, 92, 43)}${white}+func main() { println("hello, widgets") }${R}`,
    "",
    ...box(w, ["メモ: 日本語 notes 🙂 fit two cells each"], line),
    "",
    `${org}✢ Summarising…${R} ${grey}(12s · ↓ 1.2k tokens · esc to interrupt)${R}`,
    "",
    line + "─".repeat(w) + R,
    `${E}1m❯${R} `,
    line + "─".repeat(w) + R,
    `  ${rgb(255, 107, 128)}⏵⏵ accept edits on${R}${grey} (shift+tab to cycle) · ? for shortcuts${R}`,
  ];
}

function codex(w) {
  const dim = `${E}2m`, cyan = `${E}36m`, bold = `${E}1m`;
  return [
    ...box(w, [`${bold}>_ OpenAI Codex${R} ${dim}(v0.0.0)${R}`, "", `${dim}model:${R}     gpt-demo   ${cyan}/model${R} ${dim}to change${R}`, `${dim}directory:${R} ~/src/acme-widgets`], dim),
    "",
    `${E}48;5;236m› Read README.md and main.go, then summarise them.${E}K${R}`,
    "",
    `${E}32m•${R} ${bold}Explored${R}`,
    `  ${dim}└${R} ${cyan}Read${R} README.md, main.go`,
    "",
    `${E}32m•${R} ${bold}Ran${R} ${E}35mwc -l README.md main.go${R}`,
    `  ${dim}│${R}        2 README.md`,
    `  ${dim}│${R}        3 main.go`,
    `  ${dim}└${R}        5 total`,
    "",
    `${E}32m•${R} Two small files:`,
    "",
    `  ${bold}| File      | Lines |${R}`,
    `  | --------- | ----- |`,
    `  | README.md | 2     |`,
    `  | main.go   | 3     |`,
    "",
    `  ${E}4mmain.go${E}24m prints ${E}33mhello${E}39m; README names the demo.`,
    `  ${E}9mold note${E}29m ${E}7m inverse ${E}27m ${E}31merror${R} ${E}91mbright red${R}`,
    "",
    `${E}33m•${R} ${bold}Working${R} ${dim}(8s • esc to interrupt)${R}`,
    "",
    `${E}1m›${R} ${dim}Ask Codex to do anything${R}`,
    "",
    `  ${dim}? for shortcuts${R}${" ".repeat(Math.max(1, w - 34))}${dim}100% context left${R}`,
  ];
}

function opencode(w) {
  const acc = rgb(250, 178, 131), mut = rgb(128, 128, 128), panel = bgrgb(30, 30, 30), txt = rgb(238, 238, 238), grn = rgb(127, 216, 143);
  const bar = (s) => `  ${acc}┃${R}${panel}${txt}${pad("  " + s, w - 3)}${R}`;
  const logo = " ".repeat(Math.floor((w - 40) / 2));
  return [
    "",
    logo + `${mut}█▀▀█ █▀▀█ █▀▀█ █▀▀▄ ${R}${txt}█▀▀▀ █▀▀█ █▀▀█ █▀▀█${R}`,
    logo + `${mut}█  █ █  █ █▀▀▀ █  █ ${R}${txt}█    █  █ █  █ █▀▀▀${R}`,
    logo + `${mut}▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ${R}${txt}▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀${R}`,
    "",
    bar("Read README.md and main.go, then summarise them."),
    bar(""),
    bar(`${acc}Build${txt} · demo-model`),
    `  ${acc}╹${R}${mut}${"▀".repeat(w - 3)}${R}`,
    "",
    `  ${grn}→${R} ${E}1mRead${R} README.md`,
    `  ${grn}→${R} ${E}1mRead${R} main.go`,
    `  ${mut}$${R} wc -l README.md main.go`,
    `  ${mut}       5 total${R}`,
    "",
    `  Both files are small. ${E}3mmain.go${R} prints ${acc}hello${R}.`,
    "",
    `  ${E}38;5;214m⬝⬝⬝■■■■■${R}  ${mut}esc interrupt${R}`,
    "",
    `  ${mut}~/src/acme-widgets:main${R}${" ".repeat(Math.max(1, w - 53))}${mut}tab agents  ctrl+p commands${R}`,
  ];
}

function shell(w) {
  const ps1 = `${E}32mdev@box${E}0m:${E}34m~/acme-widgets${E}0m$ `;
  return [
    ps1 + "ls -la --color=always",
    "total 16",
    `drwxr-xr-x 3 dev dev 4096 Nov  4 10:00 ${E}01;34m.${E}0m`,
    `drwxr-xr-x 9 dev dev 4096 Nov  4 10:00 ${E}01;34m..${E}0m`,
    `-rwxr-xr-x 1 dev dev   48 Nov  4 10:00 ${E}01;32mbuild.sh${E}0m`,
    `-rw-r--r-- 1 dev dev   20 Nov  4 10:00 README.md`,
    ps1 + "git log --oneline --decorate -2",
    `${E}33m4f2c9e1 (${E}1;36mHEAD -> ${E}1;32mmain${E}33m)${E}m Add widgets`,
    `${E}33m1a0b3c7${E}m init demo`,
    ps1 + "git diff",
    `${E}1mdiff --git a/main.go b/main.go${E}m`,
    `${E}36m@@ -1,3 +1,3 @@${E}m`,
    `${E}31m-func main() { println("hello") }${E}m`,
    `${E}32m+func main() { println("hello, widgets") }${E}m`,
    ps1 + "./attrs.sh",
    `${E}1mbold${E}0m ${E}2mdim${E}0m ${E}3mitalic${E}0m ${E}4munder${E}0m ${E}7minverse${E}0m ${E}9mstrike${E}0m ${E}38;5;208m256-orange${E}0m`,
    `${E}38;2;100;200;255mtruecolor${E}0m ${E}44;97mon-blue${E}0m ${E}30mblack-on-default${E}0m ${E}1;31mbold-red${E}0m`,
    `${E}38;5;34mcube-green${E}0m ${E}38;5;244mgrey-244${E}0m ${E}48;5;52m bg-52 ${E}0m ${E}38:2::255:0:255mcolon-magenta${E}0m`,
    "\tTAB|after one tab",
    "日本語 wide 🙂 emoji|",
    "abcdefgh wide 12345 emoji|",
    ps1 + "grep -n main main.go",
    `${E}32m${E}K3${E}m${E}K${E}36m${E}K:${E}m${E}Kfunc ${E}01;31m${E}Kmain${E}m${E}K() { println("hello") }`,
    ps1 + "./ruler.sh",
    "-".repeat(w - 1) + "|",
    ps1,
  ];
}

const gens = { claude, codex, opencode, shell };
for (const [name, fn] of Object.entries(gens)) {
  for (const w of [76, 120]) {
    const rows = fn(w).map((r) => (r.endsWith(R) || !r.includes("\x1b") ? r : r + R));
    for (const r of rows) if (cells(r) > w) throw new Error(`${name}-${w}: row over ${w} cells: ${strip(r)}`);
    writeFileSync(join(here, `${name}-${w}.ansi`), rows.join("\n") + "\n");
  }
}
