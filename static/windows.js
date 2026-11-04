// herdr-dash floating windows: a small layer of movable windows above the
// page, with no backdrop, so the graph and the panel stay usable. Several
// can be open at once; each has an id, and the same id opens the same window.
// Click brings one to front, its title bar drags it (mouse or touch), "–"
// minimises it to the tray, "×" or Esc closes it, Alt+W cycles focus.
//
// The tray lists every window: it wraps, and what does not fit is counted
// in "+N", whose list holds all of them. Its buttons reorder by drag; its
// grip moves it to another edge or corner.
//
// Windows dock right, left or bottom of the page: drag one onto an edge or
// an open dock, press its dock button or Alt+Shift+D. A dock holds any
// number, as tabs or as a resizable split; drag a tab or a pane's title bar
// to reorder it, out of the dock to float it, or into another dock.
// Alt+] and Alt+[ step through a dock's tabs. Phones show the docked
// windows as tabs of one full-width sheet, floating ones as sheets too.
//
// Positions are kept per id; the tray, the docks, the order and the open
// thread windows in one layout record; both in localStorage.
//
// "Minimise all" (tray button, its list, Alt+Shift+M) minimises every window,
// empties the docks and hides registered panels (the side panel), keeping
// the layout before in layout.hidden; "Restore all" puts it back. A drag reads
// the layout once when it starts, then only writes styles each frame.
window.HDWin = (() => {
  "use strict";
  const POS_KEY = "hd-win-pos";
  const LAYOUT_KEY = "hd-win-layout";
  const PHONE = 700; // px: at or under this width windows are sheets
  const BAR = 36; // px of a window that always stays on screen
  const EDGE = 48; // px from the page's edge that docks a dragged window
  const SLOP = 5; // px a pointer moves before a press becomes a drag
  const SIDES = ["right", "left", "bottom"];
  const TRAY_POS = ["tl", "t", "tr", "l", "r", "bl", "b", "br"];
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
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(POS_KEY) || "{}") || {}; } catch { return {}; } },
    put(id, p) { try { const all = store.get(); all[id] = p; localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch {} },
  };

  // ---------------------------------------------------------------- layout
  const strs = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === "string"))] : []);
  function readDocks(s, L) {
    const seen = new Set();
    for (const side of SIDES) {
      const d = (s.docks && s.docks[side]) || {};
      const ids = strs(d.ids).filter((id) => !seen.has(id));
      ids.forEach((id) => seen.add(id));
      const ratio = {};
      if (d.ratio && typeof d.ratio === "object") for (const [k, v] of Object.entries(d.ratio)) if (ids.includes(k) && Number.isFinite(v) && v > 0) ratio[k] = v;
      L.docks[side] = { ids, mode: d.mode === "split" ? "split" : "tabs", active: ids.includes(d.active) ? d.active : ids[0] || null,
        size: Number.isFinite(d.size) && d.size > 0 ? Math.round(d.size) : 0, ratio };
    }
  }
  function loadLayout() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") || {}; } catch {}
    const L = { order: strs(s.order), tray: TRAY_POS.includes(s.tray) ? s.tray : "bl", open: strs(s.open), min: strs(s.min),
      side: SIDES.includes(s.side) ? s.side : "right", docks: {}, hidden: null };
    readDocks(s, L);
    // The layout to restore after "Minimise all", in the same shape.
    if (s.hidden && typeof s.hidden === "object") {
      const H = loadLayoutFrom(s.hidden);
      L.hidden = { docks: H.docks, side: H.side, min: H.min, front: typeof s.hidden.front === "string" ? s.hidden.front : null,
        panels: s.hidden.panels && typeof s.hidden.panels === "object" ? s.hidden.panels : {} };
    }
    return L;
  }
  const loadLayoutFrom = (s) => { const L = { min: strs(s.min), side: SIDES.includes(s.side) ? s.side : "right", docks: {} }; readDocks(s, L); return L; };
  const layout = loadLayout();
  const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {} };
  const dockOf = (id) => SIDES.find((s) => layout.docks[s].ids.includes(id)) || null;
  const drop = (arr, id) => { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); };
  function undockId(id) {
    for (const s of SIDES) {
      const D = layout.docks[s];
      const i = D.ids.indexOf(id);
      if (i < 0) continue;
      D.ids.splice(i, 1);
      delete D.ratio[id];
      if (D.active === id) D.active = D.ids[Math.min(i, D.ids.length - 1)] || null;
    }
  }

  // ---------------------------------------------------------------- DOM
  const layer = el("div", { id: "win-layer" });
  const trayList = el("div", { class: "wt-list" });
  const grip = el("button", { type: "button", class: "wt-grip", title: "Drag to move the tray to another edge or corner", "aria-label": "Move the tray", text: "⠿" });
  const more = el("button", { type: "button", class: "wt-more", title: "All windows", "aria-haspopup": "menu", "aria-expanded": "false", text: "≡" });
  const allBtn = el("button", { type: "button", class: "wt-all", onclick: () => toggleAll() });
  const menu = el("div", { id: "wt-menu", role: "menu", "aria-label": "All windows", hidden: "" });
  const tray = el("div", { id: "win-tray", role: "toolbar", "aria-label": "Open windows", hidden: "", "data-pos": layout.tray },
    grip, el("span", { class: "wt-label", title: "Alt+W cycles windows", text: "Windows" }), trayList, more, allBtn, menu);
  const hint = el("div", { id: "dock-hint", hidden: "" }, el("div", { class: "bar" }));
  layer.append(tray, hint);
  const wins = new Map(); // id -> win
  let top = 1, cascade = 0, sheetActive = null, wasPhone = null;
  const phone = () => innerWidth <= PHONE;

  // The docks wrap the page's work area: left and right columns, a bottom row.
  const docks = {};
  function makeDock(side) {
    const tabs = el("div", { class: "wd-tabs", role: "tablist", "aria-label": side === "sheet" ? "Docked windows" : `Windows docked ${side}` });
    const head = el("div", { class: "wd-head" }, tabs);
    if (side === "sheet") head.append(el("button", { type: "button", class: "wd-collapse", title: "Fold the sheet", "aria-label": "Fold the sheet", text: "–",
      onclick: () => { node.classList.toggle("folded"); changed(); } }));
    else head.append(
      el("button", { type: "button", class: "wd-mode", title: "Tabs or split", "aria-label": "Show as tabs or split", onclick: () => setMode(side) }),
      el("button", { type: "button", class: "wd-float", title: "Float the shown window (Alt+Shift+D cycles)", "aria-label": "Float the shown window", text: "⇱",
        onclick: () => { const id = layout.docks[side].active; if (id) floatWin(id); } }));
    const panes = el("div", { class: "wd-panes" });
    const node = el("section", { class: "wdock", "data-side": side, "aria-label": side === "sheet" ? "Docked windows" : `Dock ${side}`, hidden: "" }, head, panes);
    if (side !== "sheet") {
      const edge = el("div", { class: "wd-edge", role: "separator", tabindex: "0", "aria-label": `Resize the ${side} dock`, "aria-orientation": side === "bottom" ? "horizontal" : "vertical" });
      node.prepend(edge);
      resizeEdge(side, edge);
    }
    tabs.addEventListener("click", (e) => {
      const t = e.target.closest(".wd-tab");
      if (!t || justDragged()) return;
      if (e.target.closest(".wd-x")) return close(t.dataset.win);
      restore(t.dataset.win);
    });
    tabs.addEventListener("pointerdown", (e) => {
      const t = e.target.closest(".wd-tab");
      if (t && !e.target.closest(".wd-x")) beginDrag(e, t.dataset.win);
    });
    panes.addEventListener("pointerdown", (e) => { const g = e.target.closest(".wd-gut"); if (g) resizeGut(e, side, g); });
    docks[side] = { el: node, tabs, panes, mode: head.querySelector(".wd-mode") };
    return node;
  }
  for (const s of SIDES) makeDock(s);
  layer.prepend(makeDock("sheet"));
  const grid = el("div", { id: "dockgrid" });
  const work = document.getElementById("work");
  if (work) { work.replaceWith(grid); grid.append(docks.left.el, work, docks.right.el, docks.bottom.el); }

  // ---------------------------------------------------------------- windows
  function clamp(w, width) {
    if (phone() || w.dock) return;
    if (width == null) width = w.el.getBoundingClientRect().width || w.el.offsetWidth;
    w.x = Math.round(Math.max(0, Math.min(w.x, innerWidth - width)));
    w.y = Math.round(Math.max(0, Math.min(w.y, innerHeight - BAR)));
    w.el.style.left = w.x + "px";
    w.el.style.top = w.y + "px";
  }

  function front(w) {
    if (!w) return;
    for (const o of wins.values()) o.el.classList.toggle("active", o === w);
    w.el.style.zIndex = String(++top);
    w.at = top;
    if (w.dock) {
      const D = layout.docks[w.dock];
      if (D.active !== w.id || (phone() && sheetActive !== w.id)) { D.active = w.id; sheetActive = w.id; saveLayout(); renderDocks(); }
    }
    renderTray();
  }
  const activeWin = () => [...wins.values()].filter((w) => !w.min).sort((a, b) => b.at - a.at)[0] || null;
  // The window keys act on: the one holding the focus, else the front one.
  const focusedWin = () => {
    const a = document.activeElement;
    const tab = a?.closest?.(".wd-tab");
    return (tab && wins.get(tab.dataset.win)) || [...wins.values()].find((w) => w.el.contains(a)) || activeWin();
  };
  const orderedIds = () => {
    for (const id of wins.keys()) if (!layout.order.includes(id)) layout.order.push(id);
    return layout.order.filter((id) => wins.has(id));
  };

  function syncDockBtn(w) {
    const b = w.el.querySelector(".hw-dock");
    if (!b) return;
    b.textContent = w.dock ? "⇱" : "⇥";
    b.title = (w.dock ? "Float this window" : `Dock this window (${layout.side})`) + " · Alt+Shift+D";
    b.setAttribute("aria-label", w.dock ? "Float" : "Dock");
  }

  // ---------------------------------------------------------------- tray
  const menuOpen = () => !menu.hidden;
  function trayButton(w, act) {
    return el("button", {
      type: "button", class: "wt-item" + (w.min ? " min" : "") + (w === act ? " active" : "") + (w.attn ? " attn" : "") + (w.dock ? " docked" : ""),
      "data-win": w.id, title: (w.min ? "Restore: " : "Show: ") + w.title + (w.dock ? ` (docked ${w.dock})` : ""), text: w.short || w.title,
    });
  }
  const allLabel = () => (layout.hidden ? "Restore all" : "Minimise all");
  function renderTray() {
    tray.hidden = wins.size === 0 && !layout.hidden;
    allBtn.textContent = layout.hidden ? "▣ Restore all" : "▁ Minimise all";
    allBtn.title = (layout.hidden ? "Restore every window, dock and the panel as they were" : "Minimise every window, dock and the panel") + " · Alt+Shift+M";
    allBtn.setAttribute("aria-pressed", String(!!layout.hidden));
    tray.dataset.pos = layout.tray;
    const ph = phone();
    layer.classList.toggle("sheet", ph);
    const act = activeWin();
    // A phone shows one sheet at a time: the front one, floating or docked.
    for (const w of wins.values()) w.el.classList.toggle("behind", ph && !w.dock && w !== act);
    docks.sheet.el.classList.toggle("behind", !!(act && !act.dock));
    if (tray.hidden) { closeMenu(); return; }
    trayList.replaceChildren(...orderedIds().map((id) => trayButton(wins.get(id), act)));
    // What does not fit the tray's rows (or column) is counted in "+N".
    const lw = trayList.clientWidth, lh = trayList.clientHeight;
    let n = 0;
    for (const b of trayList.children) {
      const over = b.offsetLeft + b.offsetWidth > lw + 1 || b.offsetTop + b.offsetHeight > lh + 1;
      b.classList.toggle("over", over);
      if (over) n++;
    }
    more.textContent = n ? `+${n}` : "≡";
    more.title = n ? `${n} more: list all windows` : "List all windows";
    if (menuOpen()) renderMenu();
    changed();
  }
  // Owners hear (once per task) when what shows may have changed.
  let pending = false;
  function changed() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; document.dispatchEvent(new CustomEvent("hdwin:change")); });
  }
  // shown: a window on screen now (not minimised, a hidden tab, behind
  // another sheet, or in a folded sheet), from state, without layout reads.
  function shown(w) {
    if (w.min || w.el.classList.contains("wd-off") || w.el.classList.contains("behind")) return false;
    if (!w.dock) return true;
    return phone() ? !docks.sheet.el.classList.contains("behind") && !docks.sheet.el.classList.contains("folded") : !docks[w.dock].el.hidden;
  }
  function renderMenu() {
    const act = activeWin();
    menu.replaceChildren(el("button", { type: "button", role: "menuitem", class: "wt-menu-item wt-menu-all", title: allBtn.title },
      el("span", { class: "wm-t", text: allLabel() }), el("span", { class: "wm-s", text: "Alt+Shift+M" })), ...orderedIds().map((id) => {
      const w = wins.get(id);
      return el("button", { type: "button", role: "menuitem", class: "wt-menu-item" + (w === act ? " active" : "") + (w.attn ? " attn" : ""), "data-win": id, title: w.title },
        el("span", { class: "wm-t", text: w.title }), el("span", { class: "wm-s", text: w.dock ? (phone() ? "docked" : w.dock) : w.min ? "minimised" : "" }));
    }));
  }
  function closeMenu() { menu.hidden = true; more.setAttribute("aria-expanded", "false"); }
  more.addEventListener("click", () => {
    if (menuOpen()) return closeMenu();
    renderMenu();
    menu.hidden = false;
    more.setAttribute("aria-expanded", "true");
  });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest(".wt-menu-item");
    if (!b) return;
    closeMenu();
    if (b.classList.contains("wt-menu-all")) return toggleAll();
    restore(b.dataset.win);
    wins.get(b.dataset.win)?.el.focus({ preventScroll: true });
  });
  document.addEventListener("pointerdown", (e) => { if (menuOpen() && !tray.contains(e.target)) closeMenu(); }, true);
  trayList.addEventListener("click", (e) => {
    const b = e.target.closest(".wt-item");
    const w = b && wins.get(b.dataset.win);
    if (!w || justDragged()) return;
    if (w.min || w !== activeWin() || w.dock) restore(w.id); else minimise(w.id);
  });

  // A press that turned into a drag must not also click what is under it.
  let dragEnd = false;
  const justDragged = () => dragEnd;
  // press(e, onStart, onMove, onEnd): pointer tracking on the window, so the
  // pressed node may be re-rendered or moved under the pointer meanwhile.
  function press(e, h) {
    if (e.button > 0) return;
    const id = e.pointerId, x0 = e.clientX, y0 = e.clientY;
    let started = false, raf = 0, last = e;
    const frame = () => { raf = 0; h.move?.(last.clientX, last.clientY, last.clientX - x0, last.clientY - y0); };
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      last = ev;
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < SLOP) return;
        started = true;
        document.body.classList.add("win-dragging");
        h.start?.(x0, y0);
      }
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const end = (ev) => {
      if (ev.pointerId !== id) return;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      if (!started) return;
      if (raf) { cancelAnimationFrame(raf); frame(); }
      document.body.classList.remove("win-dragging");
      dragEnd = true;
      setTimeout(() => { dragEnd = false; }, 0);
      h.end?.(ev.type === "pointercancel");
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  }

  // Insertion index among item rects: items before the point come first,
  // row by row for wrapped tabs (axis "row") or along one axis.
  function indexAt(rects, x, y, axis) {
    let i = 0;
    for (const r of rects) {
      const before = axis === "y" ? r.top + r.height / 2 < y
        : axis === "x" ? r.left + r.width / 2 < x
        : r.bottom < y || (y >= r.top && r.left + r.width / 2 < x);
      if (before) i++;
    }
    return i;
  }

  // Tray buttons reorder by drag.
  trayList.addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".wt-item");
    if (!b || phone()) return;
    let rects, ids, at = -1, x0 = 0, y0 = 0;
    const vertical = layout.tray === "l" || layout.tray === "r";
    press(e, {
      start(x, y) {
        x0 = x; y0 = y;
        ids = [...trayList.children].map((c) => c.dataset.win);
        rects = [...trayList.children].map((c) => c.getBoundingClientRect());
        b.classList.add("lifted");
      },
      move(x, y) {
        b.style.transform = `translate(${x - x0}px, ${y - y0}px)`;
        const i = indexAt(rects, x, y, vertical ? "y" : "row");
        if (i === at) return;
        at = i;
        for (const c of trayList.children) c.classList.remove("drop-before", "drop-after");
        const c = trayList.children[Math.min(i, ids.length - 1)];
        c?.classList.add(i >= ids.length ? "drop-after" : "drop-before");
      },
      end(cancel) {
        b.style.transform = "";
        b.classList.remove("lifted");
        if (!cancel && at >= 0) {
          const from = ids.indexOf(b.dataset.win);
          const to = at > from ? at - 1 : at;
          ids.splice(from, 1);
          ids.splice(to, 0, b.dataset.win);
          layout.order = [...ids, ...layout.order.filter((id) => !ids.includes(id))];
          saveLayout();
        }
        renderTray();
      },
    });
  });

  // The grip moves the tray: dropped in a third of the screen, it takes that
  // edge or corner (the centre counts as the bottom).
  grip.addEventListener("pointerdown", (e) => {
    if (phone()) return;
    e.preventDefault();
    let x0 = 0, y0 = 0, at = null;
    press(e, {
      start(x, y) { x0 = x; y0 = y; tray.classList.add("moving"); closeMenu(); },
      move(x, y) {
        tray.style.transform = `translate(${x - x0}px, ${y - y0}px)`;
        const col = x < innerWidth / 3 ? "l" : x > (innerWidth * 2) / 3 ? "r" : "";
        const row = y < innerHeight / 3 ? "t" : y > (innerHeight * 2) / 3 ? "b" : "";
        at = row + col || "b";
      },
      end(cancel) {
        tray.style.transform = "";
        tray.classList.remove("moving");
        if (!cancel && at) { layout.tray = at; saveLayout(); }
        renderTray();
      },
    });
  });

  // ---------------------------------------------------------------- docks
  function reconcile(parent, kids) {
    kids.forEach((k, i) => {
      const cur = parent.children[i];
      if (cur === k) return;
      if (parent.moveBefore && k.isConnected) { try { parent.moveBefore(k, cur || null); return; } catch {} }
      parent.insertBefore(k, cur || null);
    });
    while (parent.children.length > kids.length) parent.lastElementChild.remove();
  }
  function renderDocks() {
    const ph = phone();
    for (const side of [...SIDES, "sheet"]) {
      const d = docks[side];
      const sheet = side === "sheet";
      const ids = (sheet ? (ph ? SIDES.flatMap((s) => layout.docks[s].ids) : []) : ph ? [] : layout.docks[side].ids).filter((id) => wins.has(id));
      d.el.hidden = !ids.length;
      const mode = sheet ? "tabs" : layout.docks[side].mode;
      d.el.dataset.mode = mode;
      if (d.mode) { d.mode.textContent = mode === "tabs" ? "▤" : "▭"; d.mode.title = mode === "tabs" ? "Split: show all, stacked" : "Tabs: one at a time"; }
      let act = sheet ? sheetActive : layout.docks[side].active;
      if (!ids.includes(act)) act = ids[0] || null;
      if (sheet) sheetActive = act;
      d.tabs.replaceChildren(...ids.map((id) => {
        const w = wins.get(id);
        return el("button", { type: "button", role: "tab", class: "wd-tab" + (id === act ? " active" : "") + (w.attn ? " attn" : ""), "data-win": id,
          "aria-selected": String(id === act), title: w.title },
          el("span", { class: "wd-tt", text: w.short || w.title }), el("span", { class: "wd-x", role: "button", "aria-label": "Close " + w.title, title: "Close", text: "×" }));
      }));
      const kids = [];
      ids.forEach((id, i) => {
        const w = wins.get(id);
        if (mode === "split" && i) kids.push(el("div", { class: "wd-gut", role: "separator", "data-i": String(i - 1) }));
        kids.push(w.el);
        w.el.classList.toggle("wd-off", mode === "tabs" && id !== act);
        paneSize(w.el, mode === "split" ? (!sheet && layout.docks[side].ratio[id]) || 1 : 0);
      });
      if (ids.length || d.panes.children.length) reconcile(d.panes, kids);
      if (!sheet) {
        const size = layout.docks[side].size;
        if (size) d.el.style.setProperty("--dock-size", size + "px"); else d.el.style.removeProperty("--dock-size");
      }
    }
    // Floating windows live in the layer.
    for (const w of wins.values()) if (!w.dock && w.el.parentElement !== layer) layer.append(w.el);
    changed();
  }
  // A split pane's share: it grows with its ratio and starts at ratio
  // units (--pane-unit); it never shrinks, so a crowded stack scrolls.
  function paneSize(node, g) {
    node.dataset.grow = g ? String(g) : "";
    node.style.flex = g ? `${g} 0 calc(${g} * var(--pane-unit))` : "";
  }
  function setMode(side) {
    const D = layout.docks[side];
    D.mode = D.mode === "tabs" ? "split" : "tabs";
    saveLayout();
    renderDocks();
  }
  function dockWin(id, side = layout.side, index = Infinity) {
    const w = wins.get(id);
    if (!w || !SIDES.includes(side)) return;
    undockId(id);
    const D = layout.docks[side];
    D.ids.splice(Math.max(0, Math.min(index, D.ids.length)), 0, id);
    D.active = id;
    layout.side = side;
    drop(layout.min, id);
    Object.assign(w, { dock: side, min: false });
    w.el.classList.remove("min", "dragging");
    w.el.classList.add("docked");
    w.el.style.left = w.el.style.top = w.el.style.zIndex = "";
    sheetActive = id;
    saveLayout();
    syncDockBtn(w);
    renderDocks();
    front(w);
  }
  function floatWin(id, at) {
    const w = wins.get(id);
    if (!w) return;
    undockId(id);
    w.dock = null;
    w.el.classList.remove("docked", "wd-off");
    paneSize(w.el, 0);
    layer.append(w.el);
    if (at) Object.assign(w, at);
    saveLayout();
    syncDockBtn(w);
    renderDocks();
    clamp(w);
    store.put(w.id, { x: w.x, y: w.y });
    front(w);
  }
  // Alt+Shift+D: floating -> right -> left -> bottom -> floating.
  function cycleDock(w) {
    if (!w) return;
    if (!w.dock) return dockWin(w.id, "right");
    const next = SIDES[SIDES.indexOf(w.dock) + 1];
    if (next) dockWin(w.id, next); else floatWin(w.id);
    wins.get(w.id)?.el.focus({ preventScroll: true });
  }
  function stepTab(w, by) {
    const side = w?.dock || (layout.docks[layout.side].ids.some((id) => wins.has(id)) ? layout.side : SIDES.find((s) => layout.docks[s].ids.some((id) => wins.has(id))));
    if (!side) return;
    const ids = layout.docks[side].ids.filter((id) => wins.has(id));
    const cur = w?.dock === side ? w.id : layout.docks[side].active;
    const next = ids[(ids.indexOf(cur) + by + ids.length) % ids.length];
    restore(next);
    wins.get(next)?.el.focus({ preventScroll: true });
  }

  // Dragging a window: by its title bar (floating, or a split pane) or its
  // tab. Inside its own dock it reorders; out of it, it floats under the
  // pointer and can land on an edge or another dock.
  function beginDrag(e, id) {
    const w = wins.get(id);
    if (!w || phone() || e.button > 0) return;
    if (!w.dock) e.preventDefault();
    let offx = 0, offy = 0, width = 0, zones = [], area = null, target = null;
    function measure() {
      area = grid.getBoundingClientRect();
      zones = SIDES.filter((s) => !docks[s].el.hidden).map((side) => {
        const d = docks[side], D = layout.docks[side];
        const items = D.mode === "tabs" ? [...d.tabs.children] : [...d.panes.children].filter((c) => c.classList.contains("hwin"));
        return { side, rect: d.el.getBoundingClientRect(), axis: D.mode === "tabs" ? "row" : side === "bottom" ? "x" : "y", rects: items.map((c) => c.getBoundingClientRect()), ids: items.map((c) => c.dataset.win) };
      });
      if (!w.dock) width = w.el.getBoundingClientRect().width;
    }
    const inside = (r, x, y) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    function hit(x, y) {
      for (const z of zones) if (inside(z.rect, x, y)) return { side: z.side, index: indexAt(z.rects, x, y, z.axis), z };
      if (!inside(area, x, y)) return null;
      if (x <= area.left + EDGE) return { side: "left", index: Infinity };
      if (x >= area.right - EDGE) return { side: "right", index: Infinity };
      if (y >= area.bottom - EDGE) return { side: "bottom", index: Infinity };
      return null;
    }
    function showHint(t) {
      if (!t) { hint.hidden = true; return; }
      const bar = hint.firstElementChild;
      let r;
      if (t.z) r = t.z.rect;
      else {
        const sz = t.side === "bottom" ? Math.min(area.height * 0.4, 280) : Math.min(area.width * 0.4, 380);
        r = t.side === "left" ? { left: area.left, top: area.top, width: sz, height: area.height }
          : t.side === "right" ? { left: area.right - sz, top: area.top, width: sz, height: area.height }
          : { left: area.left, top: area.bottom - sz, width: area.width, height: sz };
      }
      hint.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      bar.hidden = !t.z || !t.z.rects.length;
      if (!bar.hidden) {
        const rs = t.z.rects, i = Math.min(t.index, rs.length);
        const ref = rs[Math.min(i, rs.length - 1)], after = i >= rs.length;
        if (t.z.axis === "y") bar.style.cssText = `left:0;right:0;height:3px;width:auto;top:${(after ? ref.bottom : ref.top) - r.top - 1}px`;
        else bar.style.cssText = `top:${ref.top - r.top}px;height:${ref.height}px;width:3px;left:${(after ? ref.right : ref.left) - r.left - 1}px`;
      }
      hint.hidden = false;
    }
    press(e, {
      start(x, y) {
        if (!w.dock) { offx = x - w.x; offy = y - w.y; }
        w.el.classList.add("dragging");
        measure();
      },
      move(x, y) {
        if (w.dock) {
          const z = zones.find((q) => q.side === w.dock);
          if (z && inside(z.rect, x, y)) { target = { side: z.side, index: indexAt(z.rects, x, y, z.axis), z }; showHint(target); return; }
          // Torn out of its dock: it floats under the pointer from here on.
          offx = 60; offy = 14;
          floatWin(w.id, { x: x - offx, y: y - offy });
          w.el.classList.add("dragging");
          measure();
        }
        w.x = x - offx; w.y = y - offy;
        clamp(w, width);
        target = hit(x, y);
        showHint(target);
      },
      end(cancel) {
        hint.hidden = true;
        w.el.classList.remove("dragging");
        if (!cancel && target) {
          let i = target.index;
          const from = target.z ? target.z.ids.indexOf(w.id) : -1;
          if (from >= 0 && i > from) i--;
          dockWin(w.id, target.side, i);
        } else if (!w.dock) store.put(w.id, { x: w.x, y: w.y });
      },
    });
  }

  // A split's gutter shares the room of the two panes beside it.
  function resizeGut(e, side, g) {
    e.preventDefault();
    const D = layout.docks[side];
    const panes = [...docks[side].panes.children].filter((c) => c.classList.contains("hwin"));
    const i = +g.dataset.i, a = panes[i], b = panes[i + 1];
    if (!a || !b) return;
    const horiz = side === "bottom";
    let pa = 0, pb = 0, ga = 0, gb = 0;
    const MIN = horiz ? 120 : 48;
    press(e, {
      start() {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        pa = horiz ? ra.width : ra.height; pb = horiz ? rb.width : rb.height;
        ga = +a.dataset.grow || 1; gb = +b.dataset.grow || 1;
        g.classList.add("on");
      },
      move(x, y, dx, dy) {
        const tot = pa + pb, na = Math.max(MIN, Math.min(tot - MIN, pa + (horiz ? dx : dy)));
        paneSize(a, ((ga + gb) * na) / tot);
        paneSize(b, ((ga + gb) * (tot - na)) / tot);
      },
      end() {
        g.classList.remove("on");
        D.ratio[a.dataset.win] = +a.dataset.grow;
        D.ratio[b.dataset.win] = +b.dataset.grow;
        saveLayout();
      },
    });
  }
  // A dock's inner edge resizes it; arrows too, double-click resets.
  function resizeEdge(side, edge) {
    const D = () => layout.docks[side];
    const node = () => docks[side].el;
    const sign = side === "left" ? 1 : -1;
    const set = (px) => { D().size = Math.round(Math.max(side === "bottom" ? 120 : 220, px)); node().style.setProperty("--dock-size", D().size + "px"); };
    edge.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      let s0 = 0;
      press(e, {
        start() { const r = node().getBoundingClientRect(); s0 = side === "bottom" ? r.height : r.width; },
        move(x, y, dx, dy) { set(s0 + (side === "bottom" ? -dy : sign * dx)); },
        end() { const r = node().getBoundingClientRect(); D().size = Math.round(side === "bottom" ? r.height : r.width); saveLayout(); },
      });
    });
    edge.addEventListener("keydown", (e) => {
      const grow = { right: ["ArrowLeft", "ArrowRight"], left: ["ArrowRight", "ArrowLeft"], bottom: ["ArrowUp", "ArrowDown"] }[side];
      const d = e.key === grow[0] ? 24 : e.key === grow[1] ? -24 : 0;
      if (!d) return;
      e.preventDefault();
      const r = node().getBoundingClientRect();
      set((side === "bottom" ? r.height : r.width) + d);
      saveLayout();
    });
    edge.addEventListener("dblclick", () => { D().size = 0; node().style.removeProperty("--dock-size"); saveLayout(); });
  }

  // ---------------------------------------------------------------- open/close
  // open shows the window id, building it on first open. opts: { title,
  // short (tray label), cls, width, persist (reopened after a reload by its
  // owner, see saved()), build(body, win), onClose(win) }.
  function open(id, opts = {}) {
    let w = wins.get(id);
    if (w) { restore(id); return w; }
    const body = el("div", { class: "hw-body" });
    const title = el("span", { class: "hw-title", text: opts.title || id });
    const bar = el("div", { class: "hw-bar" }, title,
      el("button", { type: "button", class: "hw-dock", onclick: () => (w.dock ? floatWin(id) : dockWin(id)) }),
      el("button", { type: "button", class: "hw-min", title: "Minimise", "aria-label": "Minimise", text: "–", onclick: () => minimise(id) }),
      el("button", { type: "button", class: "hw-close", title: "Close (Esc)", "aria-label": "Close", text: "×", onclick: () => close(id) }));
    const node = el("section", { class: "hwin " + (opts.cls || ""), "data-win": id, role: "dialog", "aria-label": opts.title || id, tabindex: "-1" }, bar, body);
    if (opts.width) node.style.width = `min(${opts.width}px, calc(100vw - 16px))`;
    w = { id, el: node, body, title: opts.title || id, short: opts.short, onClose: opts.onClose, min: false, at: 0, x: 0, y: 0, dock: null,
      setTitle(t, short) { w.title = t; if (short) w.short = short; title.textContent = t; node.setAttribute("aria-label", t); renderTray(); if (w.dock) renderDocks(); },
      setAttn(on) { w.attn = !!on; renderTray(); if (w.dock) renderDocks(); },
      close: () => close(id), focus: () => restore(id) };
    wins.set(id, w);
    if (!layout.order.includes(id)) layout.order.push(id);
    if (opts.persist && !layout.open.includes(id)) layout.open.push(id);
    layer.append(node);
    const saved = store.get()[id];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) Object.assign(w, { x: saved.x, y: saved.y });
    // New windows cascade over the graph, clear of the header and the strip.
    else { const k = cascade++ % 8; Object.assign(w, { x: Math.round(Math.max(16, innerWidth * 0.3)) + k * 34, y: Math.round(Math.max(150, innerHeight * 0.26)) + k * 34 }); }
    node.addEventListener("pointerdown", () => { if (activeWin() !== w) front(w); }, true);
    node.addEventListener("focusin", () => { if (activeWin() !== w) front(w); });
    bar.addEventListener("pointerdown", (e) => { if (!e.target.closest("button")) beginDrag(e, id); });
    opts.build?.(body, w);
    w.dock = dockOf(id);
    if (w.dock) node.classList.add("docked");
    syncDockBtn(w);
    saveLayout();
    if (w.dock) renderDocks(); else clamp(w);
    // A docked window comes back behind its dock's shown tab.
    if (w.dock) renderTray();
    else if (layout.min.includes(id)) { w.min = true; node.classList.add("min"); renderTray(); }
    else front(w);
    return w;
  }

  function minimise(id) {
    const w = wins.get(id);
    if (!w || w.dock) return;
    w.min = true;
    w.el.classList.add("min");
    w.el.classList.remove("active");
    if (!layout.min.includes(id)) { layout.min.push(id); saveLayout(); }
    const next = activeWin();
    if (next) front(next); else renderTray();
  }
  function restore(id) {
    const w = wins.get(id);
    if (!w) return;
    w.min = false;
    w.el.classList.remove("min");
    if (layout.min.includes(id)) { drop(layout.min, id); saveLayout(); }
    clamp(w);
    front(w);
  }
  function close(id) {
    const w = wins.get(id);
    if (!w) return;
    wins.delete(id);
    w.el.remove();
    undockId(id);
    drop(layout.order, id); drop(layout.open, id); drop(layout.min, id);
    saveLayout();
    if (w.dock) renderDocks();
    try { w.onClose?.(w); } catch (e) { console.error(e); }
    const next = activeWin();
    if (next) front(next); else renderTray();
  }

  // ---------------------------------------------------------------- all
  // Panels outside the windows (the side panel) join "Minimise all" through
  // panel(name, { hide() -> what to show again or null, show(saved) }).
  const panels = new Map();
  function hideAll() {
    if (layout.hidden) return;
    const saved = {};
    for (const [name, p] of panels) { try { const v = p.hide(); if (v != null) saved[name] = v; } catch (e) { console.error(e); } }
    layout.hidden = { docks: JSON.parse(JSON.stringify(layout.docks)), side: layout.side, min: [...layout.min], front: activeWin()?.id || null, panels: saved };
    for (const s of SIDES) Object.assign(layout.docks[s], { ids: [], active: null, ratio: {} });
    for (const w of wins.values()) {
      if (w.dock) {
        w.dock = null;
        w.el.classList.remove("docked", "wd-off");
        paneSize(w.el, 0);
        layer.append(w.el);
        w.el.style.left = w.x + "px";
        w.el.style.top = w.y + "px";
        syncDockBtn(w);
      }
      w.min = true;
      w.el.classList.add("min");
      w.el.classList.remove("active");
      if (!layout.min.includes(w.id)) layout.min.push(w.id);
    }
    closeMenu();
    saveLayout();
    renderDocks();
    renderTray();
  }
  function showAll() {
    const H = layout.hidden;
    if (!H) return;
    layout.hidden = null;
    // Windows docked meanwhile stay where they are; the rest go back.
    const kept = (id) => wins.has(id) || layout.open.includes(id);
    const now = new Set(SIDES.flatMap((s) => layout.docks[s].ids));
    for (const s of SIDES) {
      const old = H.docks[s], cur = layout.docks[s];
      const ids = [...old.ids.filter((id) => kept(id) && !now.has(id)), ...cur.ids];
      const ratio = {};
      for (const id of ids) { const r = cur.ratio[id] ?? old.ratio[id]; if (r) ratio[id] = r; }
      layout.docks[s] = { ids, mode: old.mode, active: ids.includes(old.active) ? old.active : cur.active || ids[0] || null, size: old.size, ratio };
    }
    layout.side = H.side;
    layout.min = H.min.filter(kept);
    for (const w of wins.values()) {
      w.dock = dockOf(w.id);
      w.min = !w.dock && layout.min.includes(w.id);
      w.el.classList.toggle("docked", !!w.dock);
      w.el.classList.toggle("min", w.min);
      if (w.dock) w.el.style.left = w.el.style.top = w.el.style.zIndex = "";
      syncDockBtn(w);
    }
    saveLayout();
    renderDocks();
    for (const w of wins.values()) clamp(w);
    const f = wins.get(H.front);
    if (f && !f.min) front(f); else { const a = activeWin(); if (a) front(a); else renderTray(); }
    for (const [name, p] of panels) if (H.panels[name] != null) { try { p.show(H.panels[name]); } catch (e) { console.error(e); } }
  }
  const toggleAll = () => (layout.hidden ? showAll() : hideAll());

  // Esc closes the front window when the focus is in it (or nowhere), Alt+W
  // brings the next window to front, Alt+Shift+D docks or floats the focused
  // window, Alt+] and Alt+[ step through a dock's tabs. All run before the
  // page's own keys.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      if (menuOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closeMenu(); return; }
      const w = activeWin();
      const a = document.activeElement;
      if (!w || document.querySelector("dialog[open]")) return;
      if (!(w.el.contains(a) || a === document.body || a == null)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(w.id);
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === "KeyM" && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleAll();
      return;
    }
    if (!wins.size) return;
    if (e.code === "KeyW") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const order = [...wins.values()].sort((a, b) => a.id.localeCompare(b.id));
      const cur = activeWin();
      const next = order[(order.indexOf(cur) + (e.shiftKey ? order.length - 1 : 1)) % order.length] || order[0];
      restore(next.id);
      next.el.focus({ preventScroll: true });
    } else if (e.code === "KeyD" && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      cycleDock(focusedWin());
    } else if (e.code === "BracketRight" || e.code === "BracketLeft") {
      e.preventDefault();
      e.stopImmediatePropagation();
      stepTab(focusedWin(), e.code === "BracketRight" ? 1 : -1);
    }
  }, true);
  addEventListener("resize", () => {
    if (phone() !== wasPhone) { wasPhone = phone(); renderDocks(); }
    for (const w of wins.values()) clamp(w);
    renderTray();
  });
  wasPhone = phone();

  // Ids of a past session that never came back (a prompt answered, a thread
  // gone) leave the layout after a while.
  setTimeout(() => {
    const gone = (id) => !wins.has(id);
    const n = JSON.stringify(layout);
    layout.order = layout.order.filter((id) => !gone(id));
    layout.open = layout.open.filter((id) => !gone(id));
    layout.min = layout.min.filter((id) => !gone(id));
    for (const s of SIDES) for (const id of [...layout.docks[s].ids]) if (gone(id)) undockId(id);
    if (JSON.stringify(layout) !== n) saveLayout();
  }, 30000);

  document.body.append(layer);
  return {
    open, close, minimise, restore,
    minimiseAll: hideAll, restoreAll: showAll, toggleAll, allHidden: () => !!layout.hidden,
    // panel(name, { hide, show }): see "Minimise all" above.
    panel: (name, p) => { panels.set(name, p); renderTray(); },
    dock: (id, side, index) => dockWin(id, side, index),
    float: (id) => floatWin(id),
    get: (id) => wins.get(id) || null,
    has: (id) => wins.has(id),
    active: () => activeWin(),
    // shown lists the windows on screen, front-most first ("hdwin:change"
    // on document says when it may have changed).
    shown: () => [...wins.values()].filter(shown).sort((a, b) => b.at - a.at).map((w) => w.id),
    list: () => [...wins.keys()],
    // saved lists the persistent windows open at the last visit, in tray order.
    saved: () => [...layout.open].sort((a, b) => layout.order.indexOf(a) - layout.order.indexOf(b)),
    layout: () => JSON.parse(JSON.stringify(layout)),
  };
})();
