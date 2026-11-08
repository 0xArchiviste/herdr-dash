// herdr-dash thread windows: a thread's (or a coordinator's) live screen,
// prompt card and chat in a floating window (static/windows.js), so several
// can be watched side by side next to the docked panel. Each window streams
// its own pane screen while open and stops when closed or hidden.
//
// Each window is in one of two modes, kept per window in this browser
// (View unless chosen otherwise), switched in its header or with
// Alt+Shift+R:
//  - View, made for a browser: nothing reaches the pane but what the input
//    box sends (Enter; Shift+Enter adds a line; Up/Down walk its history)
//    and the answers clicked on a prompt card. Scrolling, find, copy, reader
//    mode and selecting text stay in the page (static/scrollback.js).
//  - Raw, a terminal: every key pressed in the window goes to the pane
//    (static/terminal.js sends them), the screen follows the pane, Esc twice
//    or the toggle leaves. herdr takes no mouse input, so the wheel only
//    scrolls the page's copy, as the window says. Raw mode on a working
//    agent asks first, and asks again when a key would reach an agent that
//    started working since.
window.HDThreadWin = (() => {
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
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const QUICK = [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["enter", "Enter"], ["esc", "Esc"], ["up", "↑"], ["down", "↓"], ["tab", "Tab"]];
  const enc = encodeURIComponent;
  const LIVE = 3; // thread windows streaming their screens at once
  const ESC2 = 400; // ms within which a second Esc leaves raw mode
  const HIST = 100; // prompts kept in an input box's history

  // The mode of each window, kept in this browser.
  const modeKey = (id) => "hd-pane-mode:" + id;
  const loadMode = (id) => { try { return localStorage.getItem(modeKey(id)) === "raw" ? "raw" : "view"; } catch { return "view"; } };
  const saveMode = (id, m) => { try { if (m === "raw") localStorage.setItem(modeKey(id), "raw"); else localStorage.removeItem(modeKey(id)); } catch {} };
  // Prompts sent from a window's input box, per thread or coordinator.
  const histKey = (key) => "hd-chat-hist:" + key;
  function loadHist(key) {
    try { const h = JSON.parse(localStorage.getItem(histKey(key)) || "[]"); return Array.isArray(h) ? h.filter((x) => typeof x === "string") : []; } catch { return []; }
  }
  function saveHist(key, h) { try { localStorage.setItem(histKey(key), JSON.stringify(h.slice(-HIST))); } catch {} }

  // Windows by id: { toggle(), onKey(e) } for the keys below.
  const modal = new Map();
  // Alt+Shift+R switches the front window's mode; in raw mode its keys go
  // to its pane. Both run before the page's and the window layer's keys.
  addEventListener("keydown", (e) => {
    const w = window.HDWin?.active();
    const m = w && modal.get(w.id);
    if (!m || w.min || document.querySelector("dialog[open]")) return;
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyR") {
      e.preventDefault();
      e.stopImmediatePropagation();
      m.toggle();
      return;
    }
    m.onKey(e);
  }, true);
  async function post(path, body) {
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let data = {};
      try { data = await r.json(); } catch {}
      return { ok: r.ok && data.ok !== false, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: "network error: " + e.message } };
    }
  }

  // paths for key: a thread "slug/id" or a coordinator "hub:slug".
  function paths(key) {
    if (key.startsWith("hub:")) {
      const s = enc(key.slice(4));
      return { screen: `/api/project/${s}/screen`, history: `/api/project/${s}/history`, keys: `/api/project/${s}/keys`, send: `/api/project/${s}/coordinator` };
    }
    const [slug, id] = key.split("/");
    const b = `/api/thread/${enc(slug)}/${enc(id)}`;
    return { screen: b + "/screen", history: b + "/history", keys: b + "/keys", send: b + "/prompt" };
  }
  function about(key) {
    const st = window.hd?.state() || { threads: [], projects: [] };
    if (key.startsWith("hub:")) {
      const p = st.projects.find((x) => x.slug === key.slice(4));
      return { name: p ? `${p.name} · coordinator` : key, sub: p ? `Project · ${p.slug}` : "", short: p?.name || key, live: !!p?.coordinator?.pane_id };
    }
    const t = st.threads.find((x) => x.key === key);
    if (!t) window.hd?.needResolved?.(key.split("/")[0]); // a resolved thread
    const p = t && st.projects.find((x) => x.slug === t.project);
    return { name: t?.title || key, sub: t ? `${p?.name || t.project} · ${t.id} · ${t.state}` : "", short: t?.id || key, live: !!(t && t.pane_alive && t.state !== "resolved" && t.state !== "leftover") };
  }

  // imagesOf is whether key's chat box takes images (images.go), from the state.
  function imagesOf(key) {
    const st = window.hd?.state() || { threads: [], projects: [] };
    const s = key.startsWith("hub:") ? st.projects.find((x) => x.slug === key.slice(4))?.coordinator?.images : st.threads.find((x) => x.key === key)?.images;
    return s || { ok: false };
  }

  function open(key) {
    if (!window.HDWin) return null;
    const id = "thread:" + key;
    if (HDWin.has(id)) { HDWin.restore(id); return HDWin.get(id); }
    const a = about(key);
    const P = paths(key);
    let es = null, blocked = false, ctl = null, screen = null;
    let mode = "view", status = "", alive = false, pane = "", consent = false, seen = false, restoring = loadMode(id) === "raw";
    const w = HDWin.open(id, {
      title: (key.startsWith("hub:") ? "" : key.split("/")[1] + " · ") + a.name, short: a.short, cls: "thread-win", width: 560, persist: true,
      build(body, win) {
        const log = el("div", { class: "tw-log" });
        const msg = (text, kind) => { log.append(el("div", { class: "msg " + kind, text })); while (log.childElementCount > 6) log.firstElementChild.remove(); };
        const PH = "Follow-up prompt… (Enter sends, Shift+Enter new line, ↑ history)";
        const input = el("textarea", { class: "tw-input w", rows: "2", placeholder: PH });
        const hist = loadHist(key);
        let at = hist.length, draft = "";
        const remember = (text) => {
          if (text && hist[hist.length - 1] !== text) hist.push(text);
          saveHist(key, hist);
          at = hist.length; draft = "";
        };
        const send = el("button", { type: "button", class: "tbtn primary w tw-send", text: "Send" });
        const att = window.HDAttach?.mount(input, () => imagesOf(key)) || null;
        const quick = el("div", { class: "quick w", hidden: "" }, el("span", { class: "muted", text: "Keys:" }),
          ...QUICK.map(([k, label]) => el("button", { type: "button", class: "tbtn", "data-key": k, title: "Press " + k, text: label, onclick: () => keys([k]) })));
        async function keys(ks, text) {
          const r = await post(P.keys, text ? { keys: ks, text } : { keys: ks });
          msg(r.ok ? (text ? `Typed “${text}”, pressed ${ks.join(" ")}` : `Pressed ${ks.join(" ")}`) : r.data.error || "HTTP " + r.status, r.ok ? "ok" : "err");
          return r;
        }
        async function go() {
          const text = input.value.trim();
          const n = att?.count() || 0;
          if ((!text && !n) || send.disabled) return;
          send.disabled = true;
          try {
            if (blocked && !key.startsWith("hub:")) {
              if (n) { att.error("The agent is waiting on a prompt: answer it first; images go with a normal message."); return; }
              if ((await keys(["enter"], text)).ok) { remember(text); input.value = ""; }
              return;
            }
            msg("Sending…", "pending");
            const r = await post(P.send, n ? { text, images: await att.images() } : { text });
            log.querySelector(".pending")?.remove();
            if (r.ok) { remember(text); input.value = ""; att?.clear(); msg("Sent: " + text + (n ? `${text ? " " : ""}(+${n} image${n > 1 ? "s" : ""})` : ""), "ok"); return; }
            if (r.data.code === "prompt_unconfirmed") { input.value = ""; att?.clear(); msg("Typed into the pane but not confirmed as started. Not resent: check the screen.", "warn"); }
            else if (r.data.code === "agent_blocked") msg("The agent is waiting on a prompt: answer it with the card above.", "err");
            else msg(r.data.error || "HTTP " + r.status, "err");
          } finally { send.disabled = false; }
        }
        send.addEventListener("click", go);
        input.addEventListener("keydown", (e) => {
          const multi = input.value.includes("\n");
          if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing) { e.preventDefault(); go(); }
          else if (e.key === "ArrowUp" && !e.shiftKey && (!multi || input.selectionStart === 0) && at > 0) {
            e.preventDefault();
            if (at === hist.length) draft = input.value;
            input.value = hist[--at];
          } else if (e.key === "ArrowDown" && !e.shiftKey && (!multi || input.selectionEnd === input.value.length) && at < hist.length) {
            e.preventDefault();
            input.value = ++at === hist.length ? draft : hist[at];
          }
        });
        const card = el("div", { class: "tw-prompt" });
        screen = window.HDScrollback.box((n) => `${P.history}?lines=${n}`, () => HDWin.has(id), id);
        const chatRow = a.live || key.startsWith("hub:") ? el("div", { class: "chat-row" }, input, att?.button, send) : el("p", { class: "muted", text: "No live pane: nothing to chat with." });
        // A pane whose agent exited: a command line and the way back (static/terminal.js).
        const term = a.live || key.startsWith("hub:") ? window.HDTerm?.mount(key, { noKeys: true, onExited: (x) => { chatRow.hidden = x; } }) : null;
        // ---- View / Raw
        const can = !!((a.live || key.startsWith("hub:")) && window.HDTerm);
        const modeBtn = (m, text, title) => el("button", { type: "button", class: "tw-mode-btn", "data-mode": m, "aria-pressed": "false", text, title, disabled: m === "raw" && !can ? "" : null,
          onclick: () => setMode(m) });
        const modes = el("div", { class: "tw-mode", role: "group", "aria-label": "Window mode" },
          modeBtn("view", "View", "View mode: scroll, find and copy here; only the input box sends to the pane (Alt+Shift+R switches)"),
          modeBtn("raw", "Raw", "Raw mode: every key you press goes to the pane, like its terminal (Alt+Shift+R switches, Esc Esc leaves)"));
        const badge = el("span", { class: "tw-raw-badge", hidden: "", text: "RAW", title: "Keys go to the pane" });
        const hint = el("p", { class: "tw-raw-hint", hidden: "",
          text: "Raw: every key goes to the pane, Esc included. Esc Esc or Alt+Shift+R leaves. The mouse wheel scrolls this copy only: herdr passes no mouse input to the pane." });
        const sendKeys = window.HDTerm?.sender(key, { pane: () => pane, report: (ok, text) => { if (!ok) msg(text, "err"); } });
        const head = el("div", { class: "tw-head" }, el("h2", { class: "tw-name", text: a.name }), badge, modes,
          el("button", { type: "button", class: "tbtn tw-panel", text: "Panel", title: "Open the docked panel", onclick: () => window.hd?.select(key) }),
          el("div", { class: "muted tw-sub", text: a.sub }));
        const busy = () => alive && status === "working";
        const ask = (why) => (window.hd?.confirm ? window.hd.confirm(why, [], "Raw mode") : Promise.resolve(false));
        const busyText = () => `The agent is working right now. In raw mode every key you press goes straight to it, Esc and Ctrl+C included, even while it works. Switch ${a.short} to raw mode?`;
        async function setMode(m, restore = false) {
          if (m === mode && !restore) return;
          if (m === "raw") {
            if (!can) return;
            if (busy() && !(await ask(busyText()))) { if (restore) { saveMode(id, "view"); paint("view"); } return; }
            consent = busy();
          }
          paint(m);
          saveMode(id, m);
          if (m === "raw") screen.pre.focus({ preventScroll: true });
        }
        function paint(m) {
          mode = m;
          win.el.dataset.mode = m;
          win.el.classList.toggle("raw", m === "raw");
          for (const b of modes.children) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
          badge.hidden = hint.hidden = m !== "raw";
          screen.setMode(m);
        }
        // Raw keys: from anywhere in the window but its fields and buttons.
        let escAt = 0, escTimer = null;
        async function onKey(e) {
          if (mode !== "raw" || !win.el.contains(e.target) || e.target.closest?.("input, textarea, select, button, [contenteditable]")) return;
          if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (escTimer) { clearTimeout(escTimer); escTimer = null; setMode("view"); return; }
            escTimer = setTimeout(() => { escTimer = null; press({ key: "esc" }); }, ESC2);
            return;
          }
          const it = window.HDTerm.keyItem(e);
          if (!it) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          press(it);
        }
        async function press(it) {
          if (busy() && !consent) {
            if (!(await ask(busyText().replace(/Switch .* to raw mode\?$/, "Send keys to it?")))) return;
            consent = true;
          }
          if (!busy()) consent = false;
          sendKeys.push(it);
        }
        screen.pre.addEventListener("paste", (e) => { if (mode !== "raw") return; e.preventDefault(); sendKeys.paste(e.clipboardData?.getData("text")); });
        modal.set(id, { toggle: () => setMode(mode === "raw" ? "view" : "raw"), onKey });
        paint("view");
        const chat = [hint, card, screen.el, quick,
          a.live || key.startsWith("hub:") ? att?.tray : null,
          chatRow, term?.el, log];
        if (key.startsWith("hub:") && window.HDThreads) {
          // A coordinator window: its screen and chat, or its project's
          // threads, organised by stage (static/threads.js).
          const coordPane = el("div", { class: "tw-pane", "data-pane": "coord", role: "tabpanel" }, ...chat.filter(Boolean));
          const tvPane = el("div", { class: "tw-pane", "data-pane": "threads", role: "tabpanel", hidden: "" });
          let tv = null;
          const tabs = el("div", { class: "tw-tabs", role: "tablist", "aria-label": "Coordinator or threads" });
          const show = (which) => {
            for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === which));
            coordPane.hidden = which !== "coord";
            tvPane.hidden = which !== "threads";
            if (which === "threads" && !tv) tv = window.HDThreads.mount(tvPane, key.slice(4), { compact: true });
          };
          tabs.append(
            el("button", { type: "button", class: "tw-tab", role: "tab", "data-tab": "coord", "aria-selected": "true", text: "Coordinator", onclick: () => show("coord") }),
            el("button", { type: "button", class: "tw-tab", role: "tab", "data-tab": "threads", "aria-selected": "false", text: "Threads", onclick: () => show("threads") }));
          body.append(head, tabs, coordPane, tvPane);
        } else body.append(head, ...chat.filter(Boolean));
        ctl = window.HDPrompt?.mount(card, key, { compact: true }) || null;
        const paused = el("p", { class: "muted tw-paused", hidden: "", text: `Paused: only the ${LIVE} front-most windows stream. Click here to resume.` });
        screen.el.before(paused);
        const start = () => {
          paused.hidden = true;
          if (es || document.hidden || !(a.live || key.startsWith("hub:"))) return;
          es = new EventSource(P.screen + "?ansi=1");
          es.addEventListener("screen", (e) => {
            const d = JSON.parse(e.data);
            status = d.live_status || "";
            alive = d.pane_alive !== false && !d.agent_exited;
            pane = d.pane_id || "";
            screen.live(d.screen, d);
            if (!seen) { seen = true; if (restoring) { restoring = false; setMode("raw", true); } }
            blocked = d.live_status === "blocked";
            quick.hidden = !blocked;
            ctl?.update(blocked ? d.prompt : null);
            term?.update(d);
            input.placeholder = blocked && !key.startsWith("hub:") ? "Type an answer: typed into the prompt, then Enter" : PH;
          });
        };
        const stop = () => { es?.close(); es = null; };
        // Streams only while it shows, and among the front-most few: each
        // stream holds one of the browser's few connections to the server.
        const vis = () => {
          const front = HDWin.shown().filter((x) => x.startsWith("thread:")).slice(0, LIVE);
          if (!document.hidden && front.includes(id)) return start();
          stop();
          paused.hidden = document.hidden || !(a.live || key.startsWith("hub:")) || !HDWin.shown().includes(id);
        };
        document.addEventListener("visibilitychange", vis);
        document.addEventListener("hdwin:change", vis);
        win.stop = () => { stop(); modal.delete(id); clearTimeout(escTimer); document.removeEventListener("visibilitychange", vis); document.removeEventListener("hdwin:change", vis); };
      },
      onClose: (win) => win.stop?.(),
    });
    return w;
  }
  // Thread windows open at the last visit come back once the state has
  // arrived (their titles come from it); a few tries, then give up.
  (function reopen(tries) {
    const ids = window.HDWin?.saved().filter((id) => id.startsWith("thread:")) || [];
    if (!ids.length) return;
    if (!window.hd?.state().threads.length) { if (tries > 0) setTimeout(() => reopen(tries - 1), 250); return; }
    for (const id of ids) open(id.slice(7));
  })(120);
  return { open };
})();
