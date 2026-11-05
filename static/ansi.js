// herdr-dash ANSI rows: one row of `herdr pane read --format ansi` text
// into a styled <span class="tl">. Only SGR (colours and attributes) is
// read; every other escape (cursor moves, OSC titles and links, DCS) is
// dropped, and the text only ever goes in as text nodes, never as HTML.
// Characters past U+2000 (symbols, box drawing, CJK, emoji) sit in spans
// as wide as the cells the terminal gave them, so a fallback font cannot
// push a box's right edge out of line.
window.HDAnsi = (() => {
  "use strict";
  // The 16 base colours: Srcery (style.css), bright black from Srcery too.
  const HEX = ["#201f1d", "#ef2f27", "#519f50", "#fbb829", "#2c78bf", "#e02c6d", "#0aaeb3", "#c8bca9",
    "#918175", "#f75341", "#98bc37", "#fed06e", "#68a8e4", "#ff5c8f", "#2be4d0", "#f3ede3"];
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const FG = hex("#d7d0bd"), BG = hex("#0b0b0b"); // the screen's own colours (style.css .screen)
  const PAL = HEX.map(hex);
  const LV = [0, 95, 135, 175, 215, 255];
  for (let i = 16; i < 232; i++) { const n = i - 16; PAL.push([LV[Math.floor(n / 36)], LV[Math.floor(n / 6) % 6], LV[n % 6]]); }
  for (let i = 232; i < 256; i++) { const v = 8 + 10 * (i - 232); PAL.push([v, v, v]); }
  const MIN_CONTRAST = 3;

  // ---- cell widths (wcwidth): 0 for combining marks and joiners, 2 for
  // East Asian wide and full-width characters and emoji.
  const ZERO = [[0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x610, 0x61a], [0x64b, 0x65f], [0x200b, 0x200f], [0x202a, 0x202e],
    [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0x1f3fb, 0x1f3ff], [0xe0000, 0xe0fff]];
  const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
    [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
    [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
    [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
    [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
    [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
    [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff],
    [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251],
    [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3],
    [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
    [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
    [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc],
    [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd]];
  const inR = (t, c) => { let lo = 0, hi = t.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c < t[m][0]) hi = m - 1; else if (c > t[m][1]) lo = m + 1; else return true; } return false; };
  const cw = (c) => (c < 0x300 ? 1 : inR(ZERO, c) ? 0 : inR(WIDE, c) ? 2 : 1);
  // Columns a plain string takes.
  function width(s) { let n = 0; for (const ch of s) n += cw(ch.codePointAt(0)); return n; }

  // ---- colours
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const css = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  // A colour too close to its background is moved toward white (or black
  // on a light background) until it reads.
  function readable(fg, bg) {
    if (ratio(fg, bg) >= MIN_CONTRAST) return fg;
    const to = lum(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255];
    for (let t = 0.1; t < 1; t += 0.1) { const c = mix(fg, to, t); if (ratio(c, bg) >= MIN_CONTRAST) return c; }
    return to;
  }

  // ---- SGR
  const RESET = { fg: null, bg: null, b: false, d: false, i: false, u: false, s: false, v: false, h: false };
  const byte = (n) => (Number.isInteger(n) && n >= 0 && n <= 255 ? n : null);
  // An extended colour (38/48/58) at ps[k]: [colour or null, params used].
  function extColor(ps, k) {
    const p = ps[k];
    if (p.length > 1) { // colon form: 38:5:n, 38:2:r:g:b or 38:2:id:r:g:b
      if (p[1] === 5) return [byte(p[2]) != null ? PAL[p[2]] : null, 0];
      if (p[1] === 2) { const v = p.length >= 6 ? p.slice(3, 6) : p.slice(2, 5); return [v.length === 3 && v.every((x) => byte(x) != null) ? v : null, 0]; }
      return [null, 0];
    }
    const mode = ps[k + 1]?.[0];
    if (mode === 5) { const n = byte(ps[k + 2]?.[0]); return [n != null ? PAL[n] : null, 2]; }
    if (mode === 2) { const v = [ps[k + 2]?.[0], ps[k + 3]?.[0], ps[k + 4]?.[0]]; return [v.every((x) => byte(x) != null) ? v : null, 4]; }
    return [null, 0];
  }
  function sgr(st, params) {
    if (!/^[0-9;:]*$/.test(params)) return st;
    const ps = (params === "" ? "0" : params).split(";").map((p) => p.split(":").map((x) => (x === "" ? null : +x)));
    st = { ...st };
    for (let k = 0; k < ps.length; k++) {
      const n = ps[k][0] ?? 0;
      if (n === 0) Object.assign(st, RESET);
      else if (n === 1) st.b = true;
      else if (n === 2) st.d = true;
      else if (n === 3) st.i = true;
      else if (n === 4) st.u = ps[k][1] !== 0;
      else if (n === 7) st.v = true;
      else if (n === 8) st.h = true;
      else if (n === 9) st.s = true;
      else if (n === 21) st.u = true;
      else if (n === 22) st.b = st.d = false;
      else if (n === 23) st.i = false;
      else if (n === 24) st.u = false;
      else if (n === 27) st.v = false;
      else if (n === 28) st.h = false;
      else if (n === 29) st.s = false;
      else if (n >= 30 && n <= 37) st.fg = PAL[n - 30];
      else if (n === 39) st.fg = null;
      else if (n >= 40 && n <= 47) st.bg = PAL[n - 40];
      else if (n === 49) st.bg = null;
      else if (n >= 90 && n <= 97) st.fg = PAL[n - 90 + 8];
      else if (n >= 100 && n <= 107) st.bg = PAL[n - 100 + 8];
      else if (n === 38 || n === 48 || n === 58) {
        const [c, used] = extColor(ps, k);
        k += used;
        if (n === 38) st.fg = c ?? st.fg;
        else if (n === 48) st.bg = c ?? st.bg;
      }
    }
    return st;
  }
  // The inline style for a state ("" when it is the default look).
  const styleCache = new Map();
  function styleOf(st) {
    const key = `${st.fg}|${st.bg}|${+st.b}${+st.d}${+st.i}${+st.u}${+st.s}${+st.v}${+st.h}`;
    let s = styleCache.get(key);
    if (s != null) return s;
    let fg = st.fg || FG, bg = st.bg;
    if (st.v) { const f = fg; fg = bg || BG; bg = f; }
    const under = bg || BG;
    if (st.d) fg = mix(fg, under, 0.4);
    if (!st.h) fg = readable(fg, under);
    const out = [];
    if (st.h) out.push("color: transparent");
    else if (st.fg || st.v || st.d || fg !== (st.fg || FG)) out.push("color: " + css(fg));
    if (bg) out.push("background-color: " + css(bg));
    if (st.b) out.push("font-weight: 700");
    if (st.i) out.push("font-style: italic");
    if (st.u || st.s) out.push("text-decoration: " + [st.u && "underline", st.s && "line-through"].filter(Boolean).join(" "));
    s = out.join("; ");
    if (styleCache.size > 4000) styleCache.clear();
    styleCache.set(key, s);
    return s;
  }

  // parse splits a row into runs [{text, style, cells}] and its plain text.
  // Tabs become spaces to the next multiple of 8 columns.
  function parse(raw) {
    const runs = [];
    let st = RESET, text = "", plain = "", col = 0;
    const flush = () => { if (text) { runs.push({ text, style: styleOf(st) }); text = ""; } };
    const s = raw;
    for (let i = 0; i < s.length;) {
      const c = s.charCodeAt(i);
      if (c === 0x1b) {
        const nx = s[i + 1];
        if (nx === "[") {
          let j = i + 2;
          while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
          const params = s.slice(i + 2, j);
          while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
          if (j >= s.length) break; // cut off: drop the rest
          const fin = s[j];
          if (fin === "m" && j === i + 2 + params.length) { flush(); st = sgr(st, params); }
          i = j + 1;
        } else if (nx === "]" || nx === "P" || nx === "_" || nx === "^" || nx === "X") {
          // A string: OSC (titles, links), DCS, APC, PM, SOS. Up to BEL or ST.
          let j = i + 2;
          while (j < s.length && s[j] !== "\x07" && !(s[j] === "\x1b" && s[j + 1] === "\\")) j++;
          i = j >= s.length ? s.length : s[j] === "\x07" ? j + 1 : j + 2;
        } else if (nx === "(" || nx === ")" || nx === "*" || nx === "+" || nx === "#" || nx === "%") i += 3;
        else i += nx === undefined ? 1 : 2;
        continue;
      }
      if (c === 9) { const n = 8 - (col % 8); text += " ".repeat(n); plain += " ".repeat(n); col += n; i++; continue; }
      if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) { i++; continue; }
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      text += ch; plain += ch; col += cw(cp);
      i += ch.length;
    }
    flush();
    return { runs, plain };
  }

  // Plain text of a row (escapes out, tabs expanded): what copy and search see.
  const plain = (raw) => (raw.includes("\x1b") || raw.includes("\t") || /[\x00-\x1f\x7f]/.test(raw) ? parse(raw).plain : raw);

  // Pieces of text for a run: stretches below U+2000 as they are, the rest
  // as fixed-width cells. [text, cells or 0].
  function pieces(text) {
    const out = [];
    let cur = "", fixed = false, cells = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const f = cp >= 0x2000;
      if (f !== fixed && cur) { out.push([cur, fixed ? cells : 0]); cur = ""; cells = 0; }
      fixed = f;
      cur += ch;
      if (f) cells += cw(cp);
    }
    if (cur) out.push([cur, fixed ? cells : 0]);
    return out;
  }

  // line renders a row: <span class="tl">, its text as text nodes only.
  function line(raw) {
    const tl = document.createElement("span");
    tl.className = "tl";
    for (const r of parse(raw).runs) {
      for (const [t, cells] of pieces(r.text)) {
        if (!r.style && !cells) { tl.append(t); continue; }
        const sp = document.createElement("span");
        if (r.style) sp.style.cssText = r.style;
        if (cells) { sp.className = "u"; sp.style.width = cells + "ch"; }
        sp.textContent = t;
        tl.append(sp);
      }
    }
    return tl;
  }

  return { line, parse, plain, width };
})();
