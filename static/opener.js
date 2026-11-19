// herdr-dash: how a thread (or a coordinator) opens, the same everywhere.
//
// Three ways: its own floating window (static/threadwin.js), brought to the
// front and placed beside what was clicked when it is already open; the
// docked side panel; or a detached browser window of its own, the pop-out
// page /thread/<slug>/<id> (/coordinator/<slug>), which shows just that
// window full-size and streams like the main tab. On a phone the pop-out is
// a new tab. In the desktop app it opens in the default browser (Wails v2
// has one native window).
//
// Each place that opens a thread has its own way (the Threads cards' Open: a
// window; the graph and the Needs-you strip: the panel; the Master window: a
// window) until a default is chosen, in an Open menu ("Make this the
// default") or under ⚙; then every place uses that default. Ctrl/Cmd-click
// or middle-click pops out. The default is kept in this browser
// (localStorage hd-open-mode).
//
// The pop-out page itself (body.solo) is driven from here too: it waits for
// the live state, opens the one window full-size, keeps the page title on
// the thread, and when the thread is resolved or gone it says so and closes.
window.HDOpen = (() => {
  "use strict";
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  };
  const enc = encodeURIComponent;
  const PREF = "hd-open-mode";
  const MODES = ["window", "panel", "popout"];
  const LABEL = { window: "Open in window", panel: "Open in panel", popout: "Pop out to a new browser window" };
  const SHORT = { window: "a window", panel: "the panel", popout: "a new browser window" };
  const SOLO = !!window.HDWin?.solo;
  const phone = () => innerWidth <= 700;
  const isHub = (k) => k.startsWith("hub:");
  const nameOf = (k) => (isHub(k) ? `the ${k.slice(4)} coordinator` : k.split("/")[1] || k);

  // ---------------------------------------------------------------- default
  function chosen() {
    try { const v = localStorage.getItem(PREF); return MODES.includes(v) ? v : null; } catch { return null; }
  }
  function setDefault(m) {
    try { if (MODES.includes(m)) localStorage.setItem(PREF, m); else localStorage.removeItem(PREF); } catch {}
    document.dispatchEvent(new CustomEvent("hd-open-pref", { detail: chosen() }));
  }
  // how a click opens: Ctrl/Cmd or the middle button pop out; else the
  // chosen default, else the place's own way.
  function how(e, own = "window") {
    if (e && (e.ctrlKey || e.metaKey || e.button === 1)) return "popout";
    return chosen() || own;
  }

  // ---------------------------------------------------------------- open
  const pathOf = (key) => (isHub(key) ? `coordinator/${enc(key.slice(4))}` : "thread/" + key.split("/").map(enc).join("/"));
  const urlOf = (key) => new URL(pathOf(key), document.baseURI).href;
  const pops = new Map(); // key -> the browser window it popped out to
  function popout(key) {
    const u = urlOf(key);
    // The desktop app's webview: the default browser, when Wails offers it.
    if (window.runtime?.BrowserOpenURL) { window.runtime.BrowserOpenURL(u); return true; }
    const had = pops.get(key);
    if (had && !had.closed) { had.focus(); return true; }
    let w;
    if (phone()) w = window.open(u, "_blank");
    else {
      const W = Math.min(900, screen.availWidth || 900), H = Math.min(940, screen.availHeight || 940);
      w = window.open(u, "hd-pop-" + key.replace(/[^\w-]/g, "_"), `popup,width=${W},height=${H}`);
    }
    if (!w) { window.hd?.toast?.("The browser blocked the pop-out window: allow pop-ups for this site, or open " + u, "err"); return false; }
    pops.set(key, w);
    return true;
  }
  // beside places a floating window next to a node: right of it, else left,
  // else where it fits; level with its top.
  function beside(w, node) {
    if (!node || !node.isConnected || w.dock || phone() || !window.HDWin?.place) return;
    const r = node.getBoundingClientRect();
    const ww = w.el.offsetWidth, wh = w.el.offsetHeight, gap = 12;
    const x = r.right + gap + ww <= innerWidth ? r.right + gap : r.left - gap - ww >= 0 ? r.left - gap - ww : innerWidth - ww;
    // Room for the window as it fills (its screen arrives after it opens).
    const tall = Math.min(Math.max(wh, 680), innerHeight - 24);
    const y = Math.max(0, Math.min(r.top, innerHeight - tall));
    HDWin.place(w.id, Math.round(x), Math.round(y));
  }
  // open(key, { e, near, own, how }): e the click (modifiers), near the node
  // to open beside, own the place's own way, how to force one.
  function open(key, o = {}) {
    if (!key) return;
    let m = o.how || how(o.e, o.own);
    if (m === "popout") return popout(key);
    // A pop-out page has no panel: its windows open over it.
    if (m === "panel" && (SOLO || !window.dash?.open)) m = "window";
    if (m === "panel") { window.dash.open(key); return; }
    const w = window.HDThreadWin?.open(key);
    if (!w) { window.hd?.select(key); return; }
    if (!w.dock && !w.min) beside(w, typeof o.near === "function" ? o.near() : o.near);
    w.el.focus({ preventScroll: true });
  }
  // bind makes node open key on click (Ctrl/Cmd: pop out) and on a middle
  // click. near: a node or a function giving one.
  function bind(node, key, o = {}) {
    node.addEventListener("click", (e) => { e.stopPropagation(); open(typeof key === "function" ? key() : key, { ...o, e }); });
    node.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    node.addEventListener("auxclick", (e) => { if (e.button !== 1) return; e.preventDefault(); e.stopPropagation(); open(typeof key === "function" ? key() : key, { ...o, e }); });
    return node;
  }

  // ---------------------------------------------------------------- menu
  const menu = el("div", { id: "open-menu", role: "menu", "aria-label": "Open", hidden: "" });
  let anchor = null;
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')];
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    anchor?.setAttribute("aria-expanded", "false");
    if (refocus) anchor?.focus({ preventScroll: true });
    anchor = null;
  }
  function showMenu(btn, key, o = {}) {
    if (anchor === btn && !menu.hidden) { closeMenu(true); return; }
    closeMenu();
    anchor = btn;
    const def = chosen() || o.own || "window";
    let remember = false;
    const check = el("button", { type: "button", role: "menuitemcheckbox", class: "ho-remember", "aria-checked": "false", tabindex: "-1",
      title: "Use the next choice for Open everywhere (also under ⚙)", text: "Make this the default" });
    check.addEventListener("click", (e) => { e.stopPropagation(); remember = !remember; check.setAttribute("aria-checked", String(remember)); });
    menu.replaceChildren(
      el("div", { class: "ho-head", "aria-hidden": "true", text: "Open " + nameOf(key) }),
      ...MODES.map((m) => el("button", { type: "button", role: "menuitem", class: "ho-item", "data-how": m, tabindex: "-1",
        onclick: (e) => {
          e.stopPropagation();
          if (remember) setDefault(m);
          closeMenu();
          open(key, { ...o, how: m });
        } },
      el("span", { class: "ho-label", text: LABEL[m] }),
      m === def ? el("span", { class: "ho-def", text: "default" }) : null,
      m === "popout" ? el("span", { class: "ho-hint", text: phone() ? "new tab" : "Ctrl+click" }) : null)),
      el("div", { class: "ho-sep", role: "separator" }), check);
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    // Below the button, right-aligned; above it when there is no room.
    const r = btn.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + "px";
    menu.style.top = (r.bottom + 4 + mh <= innerHeight ? r.bottom + 4 : Math.max(8, r.top - 4 - mh)) + "px";
    items()[0].focus({ preventScroll: true });
  }
  menu.addEventListener("keydown", (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    const go = (j) => { e.preventDefault(); list[(j + list.length) % list.length].focus({ preventScroll: true }); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === "Tab") closeMenu(false);
  });
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== anchor) closeMenu(); }, true);
  addEventListener("resize", () => closeMenu());
  document.body.append(menu);

  // button(key, opts): an "Open" split button, its menu beside it. opts:
  // label, cls (more classes of the main button), own, near.
  function button(key, o = {}) {
    const own = o.own || "window";
    const m = chosen() || own;
    const main = el("button", { type: "button", class: "tbtn ho-main " + (o.cls || ""), "aria-label": `Open ${nameOf(key)}`,
      title: `Open ${nameOf(key)} in ${SHORT[m]} (Ctrl+click or middle-click: a new browser window)`, text: o.label || "Open" });
    const more = el("button", { type: "button", class: "tbtn ho-more", "aria-haspopup": "menu", "aria-expanded": "false",
      "aria-label": `More ways to open ${nameOf(key)}`, title: "Open in a window, the panel or a new browser window", text: "▾" });
    const near = o.near || (() => main.closest(".tv-card") || main);
    bind(main, key, { own, near });
    more.addEventListener("click", (e) => { e.stopPropagation(); showMenu(more, key, { own, near }); });
    return el("span", { class: "ho-split" }, main, more);
  }

  // settingsRow: the default under ⚙.
  function settingsRow() {
    const sel = el("select", { id: "vs-open-mode" },
      el("option", { value: "", text: "Each place's own way" }),
      ...MODES.map((m) => el("option", { value: m, text: m === "popout" ? "A new browser window" : m === "window" ? "A window" : "The panel" })));
    sel.value = chosen() || "";
    sel.addEventListener("change", () => setDefault(sel.value));
    return el("label", { class: "row" }, el("span", { text: "Open threads in" }), sel);
  }

  // ---------------------------------------------------------------- pop-out page
  const soloKey = (() => {
    if (!SOLO) return null;
    const m = location.pathname.match(/\/thread\/([^/]+)\/([^/]+)\/?$/);
    if (m) return decodeURIComponent(m[1]) + "/" + decodeURIComponent(m[2]);
    const c = location.pathname.match(/\/coordinator\/([^/]+)\/?$/);
    return c ? "hub:" + decodeURIComponent(c[1]) : null;
  })();
  let soloWin = null, soloDone = false, soloTries = 0, seenTitle = "";
  // What the page's thread is now: { ok, gone, why, title }.
  function soloNow() {
    const st = window.hd?.state() || { threads: [], projects: [] };
    if (isHub(soloKey)) {
      const p = st.projects.find((x) => x.slug === soloKey.slice(4));
      return p ? { ok: true, title: `${p.name} · coordinator` } : { gone: true, why: `There is no project ${soloKey.slice(4)}.` };
    }
    const t = st.threads.find((x) => x.key === soloKey);
    if (!t) return { gone: true, why: `There is no thread ${soloKey}.` };
    if (t.state === "resolved" || t.state === "leftover") return { gone: true, why: `${t.id} “${t.title}” was resolved.`, title: `${t.id} · ${t.title}` };
    return { ok: true, title: `${t.id} · ${t.title}` };
  }
  function soloGone(why) {
    if (soloDone) return;
    soloDone = true;
    if (soloWin) { const w = soloWin; soloWin = null; window.HDWin?.close(w.id); }
    document.title = "Closed · herdr-dash";
    document.body.append(el("div", { class: "solo-gone", role: "status" },
      el("p", { text: why }), el("p", { class: "muted", text: "Nothing to watch here: this window closes by itself." }),
      el("button", { type: "button", class: "tbtn", text: "Close now", onclick: () => window.close() })));
    setTimeout(() => window.close(), 2500);
  }
  // soloState runs on every state change of the pop-out page.
  async function soloState() {
    if (!SOLO || soloDone || !soloKey) return;
    const st = window.hd?.state();
    if (!st || (!st.threads.length && !st.projects.length)) return;
    let now = soloNow();
    // A thread missing from the live state may be resolved: ask once.
    if (now.gone && !soloWin && !soloTries++ && !isHub(soloKey)) { await window.hd?.needResolved?.(soloKey.split("/")[0]); now = soloNow(); }
    // Seen before, gone from the live state now: resolved (or removed).
    if (now.gone && seenTitle && !now.title) now.why = `${seenTitle} was resolved or removed.`;
    if (now.gone) { soloGone(now.why); return; }
    document.title = now.title + " · herdr-dash";
    seenTitle = now.title;
    if (!soloWin) {
      soloWin = window.HDThreadWin?.open(soloKey, { solo: true, onClose: () => { if (!soloDone) window.close(); } }) || null;
      soloWin?.el.classList.add("solo-win");
      soloWin?.el.focus({ preventScroll: true });
    } else soloWin.setTitle(now.title);
  }
  if (SOLO) {
    document.body.classList.add("solo");
    document.title = (soloKey || "Pop-out") + " · herdr-dash";
    if (!soloKey) soloGone("This address names no thread.");
  }

  return { open, bind, button, popout, url: urlOf, chosen, setDefault, how, settingsRow, closeMenu, solo: SOLO, state: soloState };
})();
