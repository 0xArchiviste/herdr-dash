// herdr-dash floating windows: a small layer of movable windows above the
// page, with no backdrop, so the graph and the panel stay usable. Several
// can be open at once; each has an id, and the same id opens the same window.
// Click brings one to front, its title bar drags it (mouse or touch), "–"
// minimises it to the tray, "×" or Esc closes it, Alt+W cycles focus.
// Positions are kept per id in localStorage. Phones get full-width sheets.
window.HDWin = (() => {
  "use strict";
  const POS_KEY = "hd-win-pos";
  const PHONE = 700; // px: at or under this width windows are sheets
  const BAR = 36; // px of a window that always stays on screen
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

  const layer = el("div", { id: "win-layer" });
  const trayList = el("div", { class: "wt-list" });
  const tray = el("div", { id: "win-tray", role: "toolbar", "aria-label": "Open windows", hidden: "" },
    el("span", { class: "wt-label", title: "Alt+W cycles windows", text: "Windows" }), trayList);
  layer.append(tray);
  const wins = new Map(); // id -> win
  let top = 1, cascade = 0;
  const phone = () => innerWidth <= PHONE;

  function clamp(w) {
    if (phone()) return;
    const r = w.el.getBoundingClientRect();
    const width = r.width || w.el.offsetWidth;
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
    renderTray();
  }
  const activeWin = () => [...wins.values()].filter((w) => !w.min).sort((a, b) => b.at - a.at)[0] || null;

  function renderTray() {
    tray.hidden = wins.size === 0;
    const act = activeWin();
    trayList.replaceChildren(...[...wins.values()].map((w) => el("button", {
      type: "button", class: "wt-item" + (w.min ? " min" : "") + (w === act ? " active" : "") + (w.attn ? " attn" : ""), "data-win": w.id,
      title: (w.min ? "Restore: " : "Show: ") + w.title, text: w.short || w.title,
      onclick: () => { if (w.min || w !== activeWin()) restore(w.id); else minimise(w.id); },
    })));
    layer.classList.toggle("sheet", phone());
    // A phone shows one sheet at a time: the front one.
    if (phone()) for (const w of wins.values()) w.el.classList.toggle("behind", w !== act);
  }

  // open shows the window id, building it on first open. opts: { title,
  // short (tray label), cls, width, build(body, win), onClose(win) }.
  function open(id, opts = {}) {
    let w = wins.get(id);
    if (w) { restore(id); return w; }
    const body = el("div", { class: "hw-body" });
    const title = el("span", { class: "hw-title", text: opts.title || id });
    const bar = el("div", { class: "hw-bar" }, title,
      el("button", { type: "button", class: "hw-min", title: "Minimise", "aria-label": "Minimise", text: "–", onclick: () => minimise(id) }),
      el("button", { type: "button", class: "hw-close", title: "Close (Esc)", "aria-label": "Close", text: "×", onclick: () => close(id) }));
    const node = el("section", { class: "hwin " + (opts.cls || ""), "data-win": id, role: "dialog", "aria-label": opts.title || id, tabindex: "-1" }, bar, body);
    if (opts.width) node.style.width = `min(${opts.width}px, calc(100vw - 16px))`;
    w = { id, el: node, body, title: opts.title || id, short: opts.short, onClose: opts.onClose, min: false, at: 0, x: 0, y: 0,
      setTitle(t, short) { w.title = t; if (short) w.short = short; title.textContent = t; node.setAttribute("aria-label", t); renderTray(); },
      setAttn(on) { w.attn = !!on; renderTray(); },
      close: () => close(id), focus: () => restore(id) };
    wins.set(id, w);
    layer.append(node);
    const saved = store.get()[id];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) Object.assign(w, { x: saved.x, y: saved.y });
    // New windows cascade over the graph, clear of the header and the strip.
    else { const k = cascade++ % 8; Object.assign(w, { x: Math.round(Math.max(16, innerWidth * 0.3)) + k * 34, y: Math.round(Math.max(150, innerHeight * 0.26)) + k * 34 }); }
    node.addEventListener("pointerdown", () => { if (activeWin() !== w) front(w); }, true);
    node.addEventListener("focusin", () => { if (activeWin() !== w) front(w); });
    drag(w, bar);
    opts.build?.(body, w);
    clamp(w);
    front(w);
    return w;
  }

  function drag(w, bar) {
    let start = null;
    bar.addEventListener("pointerdown", (e) => {
      if (phone() || e.button > 0 || e.target.closest("button")) return;
      start = { px: e.clientX, py: e.clientY, x: w.x, y: w.y, id: e.pointerId };
      bar.setPointerCapture(e.pointerId);
      w.el.classList.add("dragging");
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      w.x = start.x + e.clientX - start.px;
      w.y = start.y + e.clientY - start.py;
      clamp(w);
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      w.el.classList.remove("dragging");
      store.put(w.id, { x: w.x, y: w.y });
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  function minimise(id) {
    const w = wins.get(id);
    if (!w) return;
    w.min = true;
    w.el.classList.add("min");
    w.el.classList.remove("active");
    const next = activeWin();
    if (next) front(next); else renderTray();
  }
  function restore(id) {
    const w = wins.get(id);
    if (!w) return;
    w.min = false;
    w.el.classList.remove("min");
    clamp(w);
    front(w);
  }
  function close(id) {
    const w = wins.get(id);
    if (!w) return;
    wins.delete(id);
    w.el.remove();
    try { w.onClose?.(w); } catch (e) { console.error(e); }
    const next = activeWin();
    if (next) front(next); else renderTray();
  }

  // Esc closes the front window when the focus is in it (or nowhere), Alt+W
  // brings the next window to front. Both run before the page's own keys.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      const w = activeWin();
      const a = document.activeElement;
      if (!w || document.querySelector("dialog[open]")) return;
      if (!(w.el.contains(a) || a === document.body || a == null)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(w.id);
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyW") {
      const list = [...wins.values()];
      if (!list.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const cur = activeWin();
      const order = list.sort((a, b) => a.id.localeCompare(b.id));
      const next = order[(order.indexOf(cur) + (e.shiftKey ? order.length - 1 : 1)) % order.length] || order[0];
      restore(next.id);
      next.el.focus({ preventScroll: true });
    }
  }, true);
  addEventListener("resize", () => { for (const w of wins.values()) clamp(w); renderTray(); });

  document.body.append(layer);
  return {
    open, close, minimise, restore,
    get: (id) => wins.get(id) || null,
    has: (id) => wins.has(id),
    active: () => activeWin(),
    list: () => [...wins.keys()],
  };
})();
