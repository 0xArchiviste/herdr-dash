// herdr-dash screen box: a pane's screen as its terminal draws it. The live
// stream sends only the newest rows (with their escapes, ?ansi=1); this
// keeps a longer buffer by merging each new tail into it, loads earlier
// rows on demand when the reader scrolls to the top, and renders rows with
// static/ansi.js: new rows only, at most BUDGET a frame, the rest as plain
// text until their turn. An update that only adds rows appends them; the
// rows on screen are left alone.
//
// Two modes (setMode), chosen by the window: "view" (the default) keeps the
// reader's place: output that arrives while they are scrolled up is counted
// on "↓ Jump to latest (N new)" (End too), a burst bigger than one live read
// is bridged with one history read instead of replacing the buffer, and a
// screen that cannot be bridged waits until they come back down. "raw"
// follows the pane like a terminal: every update goes to the newest row. Above the screen: font size, wrap mode (the
// pane's width with sideways scrolling, fit to the window, or wrapped),
// reader mode (TUI chrome dropped), find (Ctrl/Cmd+F in the window) and
// copy as plain text. Settings are kept per window in this browser.
window.HDScrollback = (() => {
  "use strict";
  const CAP = 2000; // the most one load asks for (the server caps too)
  const KEEP = 10000; // rows kept: live output adds up past what one read returns
  const BRIDGE = 40; // newest buffered rows looked for in a bridging read
  const BRIDGE_PAUSE = 30000; // ms without bridging after one found no overlap
  const FIRST = 200; // first load; each next one asks for twice as many
  const NEAR_TOP = 40; // px from the top that starts a load
  const BUDGET = 250; // rows parsed and styled per frame
  const SIZES = [7, 24], SIZE = 12;
  const WRAPS = ["pane", "fit", "wrap"];
  const WRAP_LABEL = { pane: "↔ Pane width", fit: "⤢ Fit", wrap: "↩ Wrap" };
  const WRAP_TITLE = {
    pane: "Rows as wide as the pane, scroll sideways (click: fit to the window)",
    fit: "Font shrunk so the pane's width fits the window (click: wrap rows)",
    wrap: "Long rows wrap (click: rows as wide as the pane)",
  };
  const A = window.HDAnsi;

  // Rows of a read: trailing blank rows dropped, trailing spaces trimmed.
  const split = (s) => {
    const ls = (s || "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
    while (ls.length && !/\S/.test(plainOf(ls[ls.length - 1]))) ls.pop();
    return ls;
  };
  // Plain text per raw row, memoised (the same rows come back every read).
  let plains = new Map();
  function plainOf(raw) {
    if (!raw.includes("\x1b") && !raw.includes("\t")) return raw;
    let p = plains.get(raw);
    if (p == null) {
      if (plains.size > 12000) plains = new Map();
      p = A ? A.plain(raw) : raw.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
      plains.set(raw, p);
    }
    return p;
  }
  const solid = (l) => /\S/.test(plainOf(l));

  // Where b starts in a: an index from which a agrees with b's first lines
  // for long enough to trust (blank lines and borders repeat; three real
  // lines in a row rarely do). Of several, the one nearest `near`. -1: none.
  function overlap(a, b, near) {
    const need = Math.min(3, b.filter(solid).length);
    if (!need) return -1;
    let best = -1;
    for (let i = a.length - 1; i >= 0; i--) {
      let j = 0, got = 0;
      while (got < need && i + j < a.length && j < b.length && a[i + j] === b[j]) got += solid(b[j++]);
      if (got >= need && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
      if (best >= 0 && i < near && near - i > Math.abs(best - near)) break;
    }
    return best;
  }

  // ---- reader mode: the transcript without the TUI around it.
  const CHROME = /^[\s│┃║┆┊╎╏▏▕▌▐|─━═┄┈╌╍▀▄█▔▁▂▃▅▆▇░▒▓╭╮╯╰┌┐└┘├┤┬┴┼╹╻╷╵┏┓┗┛┣┫┳┻╋⎯⬝■□▪▫·•]*$/;
  const STATUS = /esc to (interrupt|cancel)|esc interrupt|ctrl\+c to (interrupt|quit|exit)|\? for shortcuts|shift\+tab to cycle|context left|ctrl\+p commands|tab agents|accept edits on|bypass permissions on|auto-accept edits|plan mode on/i;
  const SPIN = /^\s*[✻✶✳✢✽✺✹✷✸⏺◐◓◑◒◴◵◶◷⠁-⣿*·•]\s+\S.*…/;
  const PROMPT = /^\s*[❯›>]\s*$/;
  function reader(lines) {
    const out = [];
    for (const raw of lines) {
      let t = plainOf(raw);
      if (STATUS.test(t) || SPIN.test(t) || PROMPT.test(t)) continue;
      if (/\S/.test(t) && CHROME.test(t)) continue;
      t = t.replace(/^\s*[│┃║▌▐▏▎▍▕]\s?/, "").replace(/\s*[│┃║▌▐▏▎▍▕]\s*$/, "").replace(/\s+$/, "");
      if (!/\S/.test(t) && (!out.length || !/\S/.test(out[out.length - 1]))) continue;
      out.push(t);
    }
    while (out.length && !/\S/.test(out[out.length - 1])) out.pop();
    return out;
  }

  // ---- settings per window
  const skey = (id) => "hd-screen:" + id;
  function loadSet(id) {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(skey(id)) || "{}") || {}; } catch {}
    return {
      size: Number.isFinite(s.size) ? Math.min(SIZES[1], Math.max(SIZES[0], s.size)) : SIZE,
      wrap: WRAPS.includes(s.wrap) ? s.wrap : "pane",
      reader: s.reader === true,
    };
  }
  function saveSet(id, s) { try { localStorage.setItem(skey(id), JSON.stringify(s)); } catch {} }

  // ---- find: one Highlight per kind shared by every box (CSS.highlights
  // is per document); each box adds and removes its own ranges.
  const HL = window.CSS?.highlights && window.Highlight ? { all: new Highlight(), cur: new Highlight() } : null;
  if (HL) { CSS.highlights.set("hd-find", HL.all); CSS.highlights.set("hd-find-cur", HL.cur); }
  // A range over [start, start+len) of an element's text.
  function rangeIn(el, start, len) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let pos = 0, set = false;
    for (let n; (n = walk.nextNode());) {
      const end = pos + n.data.length;
      if (!set && start < end) { r.setStart(n, start - pos); set = true; }
      if (set && start + len <= end) { r.setEnd(n, start + len - pos); return r; }
      pos = end;
    }
    return null;
  }

  const boxes = new Set();
  // Ctrl/Cmd+F inside a window (or the panel) opens that window's find.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.key !== "f" && e.key !== "F")) return;
    for (const b of boxes) {
      if (!b.wrap.isConnected) { boxes.delete(b); continue; }
      if (b.wrap.offsetParent === null || b.raw()) continue;
      const scope = b.wrap.closest(".hwin, #panel") || b.wrap;
      if (scope.contains(e.target)) { e.preventDefault(); e.stopPropagation(); b.openFind(); return; }
    }
  }, true);

  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };

  // box builds a screen box: { el, live(text, ev) }. history(n) is the URL of
  // the pane's last n rows ({screen}); current() says the box is still
  // shown; id names the window its settings are kept for. ev is the screen
  // event (cols: the pane's width).
  function box(history, current, id = "panel") {
    const set = loadSet(id);
    const top = el("div", { class: "screen-top" });
    const pre = el("pre", { class: "screen", tabindex: "0" });
    const jump = el("button", { class: "new-output", hidden: "", text: "↓ Jump to latest", title: "Go to the newest output (End)" });
    const tool = (act, text, title, extra = {}) => el("button", { type: "button", class: "st-btn", "data-act": act, text, title, ...extra });
    const smaller = tool("smaller", "A−", "Smaller text");
    const bigger = tool("bigger", "A+", "Bigger text");
    const wrapB = tool("wrap", "", "");
    const readB = tool("reader", "Reader", "Reader mode: the transcript without borders, spinners and status bars", { "aria-pressed": "false" });
    const findB = tool("find", "Find", "Find in this screen (Ctrl+F)");
    const copyB = tool("copy", "Copy", "Copy the screen as plain text");
    const tools = el("div", { class: "screen-tools", role: "toolbar", "aria-label": "Screen" }, smaller, bigger, wrapB, readB, el("span", { class: "st-gap" }), findB, copyB);
    const fIn = el("input", { type: "search", class: "sf-input", placeholder: "Find in screen", "aria-label": "Find in screen", spellcheck: "false" });
    const fCount = el("span", { class: "sf-count", "aria-live": "polite", text: "" });
    const findBar = el("div", { class: "screen-find", hidden: "" }, fIn, fCount,
      tool("prev", "↑", "Previous (Shift+Enter)"), tool("next", "↓", "Next (Enter)"), tool("close", "✕", "Close (Esc)"));
    const wrap = el("div", { class: "screen-wrap" }, tools, findBar, top, pre, jump);

    let buf = []; // raw rows
    let shown = []; // rows on screen now: [{raw, el}] (reader: plain rows)
    let cols = 0; // the pane's width, from herdr (0: unknown)
    let asked = 0; // lines the last load asked for
    let loading = false, start = false, capped = false, limit = 0;
    let mode = "view";
    let unseen = 0; // rows added while the reader was scrolled up
    let held = null; // view mode: a screen that replaces the buffer, held while the reader is up
    let bridging = false, nextTail = null, noBridgeUntil = 0, retried = false;

    const atBottom = () => pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    const toBottom = () => { pre.scrollTop = pre.scrollHeight; };
    const lineH = () => parseFloat(getComputedStyle(pre).lineHeight) || 14;

    function note() {
      if (loading) top.replaceChildren("Loading earlier lines…");
      else if (limit) top.replaceChildren(`Herdr reads back at most ${limit} lines: nothing earlier to load`);
      else if (capped) top.replaceChildren(buf.length > CAP ? `Showing ${buf.length} lines kept by this window` : `Showing the last ${CAP} lines`);
      else if (start) top.replaceChildren("Start of the pane's history");
      else top.replaceChildren(el("button", { text: "↑ Load earlier", onclick: load }));
    }

    // Keep at most KEEP lines; returns how many were cut from the top.
    function trim() {
      const cut = Math.max(0, buf.length - KEEP);
      if (cut) { buf = buf.slice(cut); capped = true; }
      return cut;
    }

    // ---- rendering: rows already on screen are kept (by their raw text),
    // new ones parsed, BUDGET now and the rest a frame at a time.
    let pending = false;
    function placeholder(raw) {
      const t = el("span", { class: "tl raw" });
      t.textContent = plainOf(raw);
      return t;
    }
    function render() {
      let rows;
      if (set.reader) rows = reader(buf).map((t) => ({ raw: null, el: el("span", { class: "tl", text: t }) }));
      else {
        const pool = new Map();
        for (const r of shown) if (r.raw != null) (pool.get(r.raw) || pool.set(r.raw, []).get(r.raw)).push(r.el);
        let budget = BUDGET;
        // Newest rows first: they are the ones in view.
        rows = new Array(buf.length);
        for (let k = buf.length - 1; k >= 0; k--) {
          const raw = buf[k];
          let e = pool.get(raw)?.pop();
          if (!e) e = A && budget-- > 0 ? A.line(raw) : placeholder(raw);
          rows[k] = { raw, el: e };
        }
      }
      shown = rows;
      const frag = document.createDocumentFragment();
      rows.forEach((r, k) => { if (k) frag.append("\n"); frag.append(r.el); });
      pre.replaceChildren(frag);
      if (!set.reader && A && rows.some((r) => r.el.classList.contains("raw"))) upgradeSoon();
      fit();
      if (!findBar.hidden) find(false);
    }
    // patch brings the screen up to buf when buf is the rows on screen with
    // `cut` gone from the top and the end replaced: only the rows that
    // changed are removed and added.
    function patch(cut) {
      if (set.reader || !shown.length) return render();
      const drop = (r, k) => { const s = k ? r.el.previousSibling : r.el.nextSibling; if (s?.nodeType === 3) s.remove(); r.el.remove(); };
      for (let k = 0; k < Math.min(cut, shown.length); k++) drop(shown[k], 0);
      shown = shown.slice(cut);
      let p = 0;
      while (p < shown.length && p < buf.length && shown[p].raw === buf[p]) p++;
      if (p === 0) return render();
      for (let k = shown.length - 1; k >= p; k--) drop(shown[k], k);
      shown.length = p;
      const frag = document.createDocumentFragment();
      let budget = BUDGET, plain = false;
      for (let k = p; k < buf.length; k++) {
        const raw = buf[k];
        const e = A && budget-- > 0 ? A.line(raw) : placeholder(raw);
        plain ||= e.classList.contains("raw");
        frag.append("\n", e);
        shown.push({ raw, el: e });
      }
      pre.append(frag);
      if (plain && A) upgradeSoon();
      if (!findBar.hidden) find(false);
    }
    function upgradeSoon() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(upgrade);
    }
    // Style a frame's worth of plain rows, bottom up.
    function upgrade() {
      pending = false;
      if (set.reader || !pre.isConnected) return;
      let budget = BUDGET, left = false;
      for (let k = shown.length - 1; k >= 0; k--) {
        const r = shown[k];
        if (!r.el.classList.contains("raw")) continue;
        if (budget-- <= 0) { left = true; break; }
        const e = A.line(r.raw);
        r.el.replaceWith(e);
        r.el = e;
      }
      if (left) upgradeSoon();
      if (!findBar.hidden) find(false);
    }

    // ---- font size and wrap mode
    let chRatio = 0; // width of one cell per px of font size
    function measure() {
      const s = el("span", { text: "0".repeat(100) });
      s.style.cssText = "position:absolute;visibility:hidden;font-size:100px;white-space:pre";
      pre.append(s);
      const w = s.getBoundingClientRect().width / 10000;
      s.remove();
      return w;
    }
    // The width to fit: the pane's own (herdr's, up to a minute old), or the
    // widest of the newest rows if one is wider.
    const widest = () => buf.slice(-200).reduce((m, l) => Math.max(m, A ? A.width(plainOf(l)) : plainOf(l).length), cols);
    function fit() {
      let size = set.size;
      if (set.wrap === "fit" && !set.reader && pre.isConnected && pre.clientWidth) {
        if (!chRatio) chRatio = measure();
        const cs = getComputedStyle(pre);
        const room = pre.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 1;
        const n = widest();
        if (chRatio && n) size = Math.max(4, Math.min(set.size, Math.floor((room / (n * chRatio)) * 10) / 10));
      }
      pre.style.fontSize = size + "px";
    }
    function apply() {
      pre.dataset.wrap = set.wrap;
      pre.toggleAttribute("data-reader", set.reader);
      readB.setAttribute("aria-pressed", String(set.reader));
      wrapB.textContent = WRAP_LABEL[set.wrap];
      wrapB.title = WRAP_TITLE[set.wrap];
      smaller.disabled = set.size <= SIZES[0];
      bigger.disabled = set.size >= SIZES[1];
      saveSet(id, set);
      fit();
    }
    const sticky = (fn) => () => { const stick = atBottom(); fn(); if (stick) toBottom(); };
    smaller.addEventListener("click", sticky(() => { set.size = Math.max(SIZES[0], set.size - 1); apply(); }));
    bigger.addEventListener("click", sticky(() => { set.size = Math.min(SIZES[1], set.size + 1); apply(); }));
    wrapB.addEventListener("click", sticky(() => { set.wrap = WRAPS[(WRAPS.indexOf(set.wrap) + 1) % WRAPS.length]; apply(); }));
    readB.addEventListener("click", sticky(() => { set.reader = !set.reader; apply(); render(); }));
    if (window.ResizeObserver) new ResizeObserver(() => { if (set.wrap === "fit") fit(); }).observe(pre);

    // ---- copy
    const text = () => (set.reader ? reader(buf) : buf.map((l) => plainOf(l).replace(/\s+$/, ""))).join("\n");
    copyB.addEventListener("click", async () => {
      const t = text();
      let ok = false;
      try { await navigator.clipboard.writeText(t); ok = true; } catch {
        const ta = el("textarea");
        ta.value = t;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.append(ta);
        ta.select();
        try { ok = document.execCommand("copy"); } catch {}
        ta.remove();
      }
      copyB.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => { copyB.textContent = "Copy"; }, 1500);
    });

    // ---- find
    let hits = [], at = 0, mine = { all: [], cur: [] };
    function unmark() {
      if (HL) { for (const r of mine.all) HL.all.delete(r); for (const r of mine.cur) HL.cur.delete(r); }
      mine = { all: [], cur: [] };
      for (const e of pre.querySelectorAll(".tl.hit")) e.classList.remove("hit", "hit-cur");
    }
    // find(true) moves to the current match; find(false) only re-marks.
    function find(go) {
      unmark();
      const q = fIn.value.toLowerCase();
      const prev = hits[at];
      hits = [];
      if (q) {
        shown.forEach((r, k) => {
          const t = r.el.textContent.toLowerCase();
          for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) hits.push([k, i]);
        });
      }
      if (!go && prev) { const k = hits.findIndex(([a, b]) => a === prev[0] && b === prev[1]); at = k >= 0 ? k : Math.min(at, Math.max(0, hits.length - 1)); }
      at = hits.length ? (at + hits.length) % hits.length : 0;
      fCount.textContent = hits.length ? `${at + 1}/${hits.length}` : q ? "0/0" : "";
      hits.forEach(([k, i], n) => {
        const line = shown[k].el;
        line.classList.add("hit");
        if (n === at) line.classList.add("hit-cur");
        const r = HL && rangeIn(line, i, q.length);
        if (r) { (n === at ? mine.cur : mine.all).push(r); (n === at ? HL.cur : HL.all).add(r); }
      });
      if (go && hits.length) {
        const line = shown[hits[at][0]].el;
        const y = line.offsetTop - pre.offsetTop;
        if (y < pre.scrollTop || y > pre.scrollTop + pre.clientHeight - lineH()) pre.scrollTop = Math.max(0, y - pre.clientHeight / 2);
        const box = line.getBoundingClientRect(), pr = pre.getBoundingClientRect();
        const r = HL ? rangeIn(line, hits[at][1], q.length)?.getBoundingClientRect() : null;
        if (r && (r.left < pr.left || r.right > pr.right)) pre.scrollLeft += r.left - pr.left - pr.width / 2;
        else if (box.left > pr.right) pre.scrollLeft = 0;
      }
    }
    function step(d) { if (hits.length) { at = (at + d + hits.length) % hits.length; find(true); } }
    function openFind() {
      findBar.hidden = false;
      fIn.focus();
      fIn.select();
      if (fIn.value) find(true);
    }
    function closeFind() {
      findBar.hidden = true;
      unmark();
      hits = [];
      pre.focus({ preventScroll: true });
    }
    fIn.addEventListener("input", () => { at = 0; find(true); });
    fIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
    });
    findBar.querySelector('[data-act="prev"]').addEventListener("click", () => step(-1));
    findBar.querySelector('[data-act="next"]').addEventListener("click", () => step(1));
    findBar.querySelector('[data-act="close"]').addEventListener("click", closeFind);
    findB.addEventListener("click", openFind);

    // A new live tail: replace the buffer from where the tail starts in it.
    // No overlap (more output than the tail holds, or a full-screen redraw):
    // view mode reads further back to bridge the gap; failing that (and in
    // raw mode) the tail replaces the buffer rather than glue unrelated
    // screens together, at once at the bottom, when the reader comes back
    // down otherwise.
    function live(textIn, ev) {
      if (ev && ev.cols > 0 && ev.cols !== cols) { cols = ev.cols; pre.dataset.cols = String(cols); fit(); }
      const tail = split(textIn);
      if (bridging) { nextTail = tail; return; }
      const first = !pre.dataset.n;
      pre.dataset.n = (+pre.dataset.n || 0) + 1;
      const stick = first || mode === "raw" || atBottom();
      if (held && !stick) { held = tail; return; }
      held = null;
      const i = overlap(buf, tail, buf.length);
      if (i < 0 && !first && mode === "view" && buf.length && Date.now() > noBridgeUntil) { bridge(tail); return; }
      if (i < 0 && !first && !stick) { held = tail; unseen += tail.length; showJump(); return; }
      merge(i < 0 ? null : buf.slice(0, i).concat(tail), tail, stick, first);
    }
    // merge puts next (or, null, the tail alone) in the buffer and on screen.
    function merge(next, tail, stick, first) {
      const old = buf;
      if (!next) { buf = tail; start = capped = false; limit = 0; asked = 0; }
      else buf = next;
      const cut = trim();
      const changed = buf.length !== old.length || buf.some((l, k) => l !== old[k]);
      const y = pre.scrollTop;
      if (first || !next) render();
      else if (changed) patch(cut);
      if (stick) {
        unseen = 0;
        toBottom();
        // Again after layout: the box may have just appeared (was :empty).
        requestAnimationFrame(toBottom);
        jump.hidden = true;
      } else {
        pre.scrollTop = Math.max(0, y - cut * lineH());
        const added = buf.length + cut - old.length;
        if (added > 0) { unseen += added; showJump(); }
      }
      note();
    }
    function showJump() {
      jump.textContent = unseen > 0 ? `↓ Jump to latest (${unseen} new)` : "↓ Jump to latest";
      jump.hidden = false;
    }
    // bridge reads as far back as herdr goes to find where the buffer ends
    // in it, and adds what came after; the newest tail goes on top of that.
    async function bridge(tail) {
      bridging = true;
      let older = null;
      try {
        const r = await fetch(history(1000) + "&ansi=1");
        if (r.ok) older = split((await r.json()).screen);
      } catch {}
      bridging = false;
      if (!current()) return;
      const stick = mode === "raw" || atBottom();
      const late = nextTail;
      nextTail = null;
      const k = Math.min(BRIDGE, buf.length);
      const j = older?.length ? overlap(older, buf.slice(-k), older.length) : -1;
      // The read must lead up to the newest tail too: a cached read from
      // before the burst would bridge nothing.
      let next = null;
      if (j >= 0) {
        next = buf.slice(0, buf.length - k).concat(older.slice(j));
        for (const t of late ? [tail, late] : [tail]) {
          const i = overlap(next, t, next.length);
          if (i < 0) { next = null; break; }
          next = next.slice(0, i).concat(t);
        }
      }
      if (!next) {
        noBridgeUntil = Date.now() + BRIDGE_PAUSE;
        if (stick) merge(null, late || tail, true, false);
        else { held = late || tail; unseen += held.length; showJump(); }
        return;
      }
      merge(next, tail, stick, false);
    }
    // jumpLatest goes to the newest row, with a held screen put in first.
    function jumpLatest() {
      if (held) { const t = held; held = null; merge(null, t, true, false); }
      toBottom();
      unseen = 0;
      jump.hidden = true;
    }
    // setMode: "view" or "raw" (see the top of this file).
    function setMode(m) {
      mode = m === "raw" ? "raw" : "view";
      wrap.dataset.mode = mode;
      if (mode === "raw") jumpLatest();
    }

    // Earlier lines: ask for more than the buffer holds, up to CAP, and
    // prepend what precedes the buffer without moving the reader's place.
    async function load() {
      if (loading || start || capped || limit || !buf.length || mode === "raw") return;
      if (buf.length >= CAP) { capped = true; note(); return; }
      let n = asked ? asked * 2 : FIRST;
      while (n <= buf.length) n *= 2;
      n = Math.min(CAP, n);
      asked = n;
      loading = true;
      note();
      let older = null, lim = 0;
      try {
        const r = await fetch(history(n) + "&ansi=1");
        if (r.ok) { const d = await r.json(); older = split(d.screen); lim = d.limit || 0; }
      } catch {}
      loading = false;
      if (!current()) return;
      if (older?.length) {
        const i = overlap(older, buf, older.length - buf.length);
        const fromBottom = pre.scrollHeight - pre.scrollTop;
        // No overlap: the read is older than the screen (a cached read
        // from before a redraw) or the pane changed past recognition.
        // Either way it does not lead up to what is shown: keep the screen.
        if (i < 0) {
          asked = n / 2;
          if (!retried) { retried = true; setTimeout(() => { if (current() && pre.scrollTop < NEAR_TOP) load(); }, 1500); }
          note();
          return;
        }
        retried = false;
        buf = older.slice(0, i).concat(buf);
        if (lim) limit = lim;
        else if (older.length < n) start = true;
        else if (n >= CAP) capped = true;
        trim();
        render();
        pre.scrollTop = pre.scrollHeight - fromBottom;
      }
      note();
    }

    pre.addEventListener("scroll", () => {
      if (atBottom()) { if (held) jumpLatest(); unseen = 0; jump.hidden = true; }
      if (pre.scrollTop < NEAR_TOP) load();
    }, { passive: true });
    // A box too short to scroll still loads on a wheel or swipe up.
    pre.addEventListener("wheel", (e) => { if (e.deltaY < 0 && pre.scrollTop === 0) load(); }, { passive: true });
    jump.addEventListener("click", jumpLatest);
    // End goes to the newest row (view mode; raw mode sends it to the pane).
    wrap.addEventListener("keydown", (e) => {
      if (e.key !== "End" || e.ctrlKey || e.altKey || e.metaKey || mode === "raw" || e.target.closest("input, textarea")) return;
      e.preventDefault();
      jumpLatest();
    });

    apply();
    const self = { wrap, openFind, raw: () => mode === "raw" };
    boxes.add(self);
    return { el: wrap, pre, live, setMode, jumpLatest };
  }

  return { box, CAP };
})();
