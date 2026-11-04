// herdr-dash terminal controls for a pane whose agent exited (terminal.go):
// a banner, the way back (Restart agent, Resume session, Resolve thread), a
// command line for the shell left in the pane (Enter runs, Shift+Enter adds
// a line, Up/Down walk the history, Ctrl+C interrupts) and a keys mode that
// forwards every key press. Mounted in the docked panel and in thread
// windows, and fed by their screen streams. With a live agent only the keys
// mode toggle shows, and switching it on asks first.
window.HDTerm = (() => {
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
  const enc = encodeURIComponent;
  const HIST = 100;
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
  function base(key) {
    if (key.startsWith("hub:")) return `/api/project/${enc(key.slice(4))}`;
    const [slug, id] = key.split("/");
    return `/api/thread/${enc(slug)}/${enc(id)}`;
  }
  // Command history per pane owner, kept in this browser.
  const histKey = (key) => "hd-term-hist:" + key;
  function loadHist(key) {
    try { const h = JSON.parse(localStorage.getItem(histKey(key)) || "[]"); return Array.isArray(h) ? h.filter((x) => typeof x === "string") : []; } catch { return []; }
  }
  function saveHist(key, h) {
    try { localStorage.setItem(histKey(key), JSON.stringify(h.slice(-HIST))); } catch {}
  }

  // Key presses in keys mode, as terminal.go names them.
  const NAMED = { Enter: "enter", Escape: "esc", Backspace: "backspace", Tab: "tab", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", Delete: "delete" };
  function keyItem(e) {
    if (e.metaKey || e.altKey) return null;
    if (e.ctrlKey) return /^[a-z]$/i.test(e.key) ? { key: "ctrl+" + e.key.toLowerCase() } : null;
    if (e.key === "Tab" && e.shiftKey) return { key: "shift+tab" };
    if (NAMED[e.key]) return { key: NAMED[e.key] };
    if (e.key.length === 1) return { text: e.key };
    return null;
  }
  const keyLabel = (k) => k.replace(/^ctrl\+(.)$/, (_, c) => "Ctrl+" + c.toUpperCase());

  // mount(key, opts): returns { el, update(ev) }. ev is a screen event
  // ({agent_exited, shell, foreground, live_status, pane_alive}); onExited
  // is told when the pane flips between an agent and none.
  function mount(key, opts = {}) {
    const hub = key.startsWith("hub:");
    const B = base(key);
    const hist = loadHist(key);
    let at = hist.length, draft = "", exited = null, keysOn = false, liveStatus = "";
    const logBox = el("div", { class: "ht-log", "aria-live": "polite" });
    const msg = (text, kind) => { logBox.append(el("div", { class: "msg " + kind, text })); while (logBox.childElementCount > 6) logBox.firstElementChild.remove(); };
    const banner = el("p", { class: "ht-banner", role: "status" });
    const acts = el("div", { class: "ht-actions w" });
    const input = el("textarea", { class: "ht-input", rows: "1", spellcheck: "false", autocomplete: "off", "aria-label": "Command line" });
    const run = el("button", { type: "button", class: "tbtn primary ht-run", text: "Run" });
    const ctl = (k) => el("button", { type: "button", class: "tbtn ht-ctl", "data-key": k, title: `Send ${keyLabel(k)} to the pane`, text: keyLabel(k), onclick: () => control(k) });
    const ctls = el("div", { class: "ht-ctls" }, ctl("ctrl+c"), ctl("ctrl+d"), ctl("ctrl+l"));
    const line = el("div", { class: "ht-line w" }, el("div", { class: "ht-row" }, input, run), ctls);
    const mode = el("button", { type: "button", class: "tbtn ht-mode", "aria-pressed": "false", text: "Keys mode", title: "Send every key you press to the pane" });
    const pad = el("div", { class: "ht-keys", tabindex: "0", hidden: "", role: "textbox", "aria-label": "Keys mode: keys typed here go to the pane",
      text: "Keys mode: click here and type. Every key goes to the pane as you press it (Esc and Ctrl+C too)." });
    const modes = el("div", { class: "ht-modes w" }, mode);
    const root = el("section", { class: "hd-term", hidden: "" }, banner, acts, line, modes, pad, logBox);

    // ---- command line
    async function send(body, label) {
      const r = await post(B + "/term", body);
      if (r.ok) msg(label, "ok");
      else msg(r.data.error || "HTTP " + r.status, "err");
      return r;
    }
    async function runLine() {
      const text = input.value;
      if (!text.trim() || run.disabled) return;
      run.disabled = true;
      try {
        const r = await send({ mode: "line", text }, "Ran: " + text);
        if (!r.ok) return;
        if (hist[hist.length - 1] !== text) hist.push(text);
        saveHist(key, hist);
        at = hist.length; draft = "";
        input.value = "";
      } finally { run.disabled = false; }
    }
    function control(k) { return send({ mode: "line", keys: [k] }, `Sent ${keyLabel(k)}`); }
    run.addEventListener("click", runLine);
    input.addEventListener("keydown", (e) => {
      const multi = input.value.includes("\n");
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); runLine(); }
      else if (e.key === "ArrowUp" && (!multi || input.selectionStart === 0) && at > 0) {
        e.preventDefault();
        if (at === hist.length) draft = input.value;
        input.value = hist[--at];
      } else if (e.key === "ArrowDown" && (!multi || input.selectionEnd === input.value.length) && at < hist.length) {
        e.preventDefault();
        input.value = ++at === hist.length ? draft : hist[at];
      } else if (e.ctrlKey && !e.shiftKey && (e.key === "c" || e.key === "C") && input.selectionStart === input.selectionEnd) {
        // Nothing selected to copy: interrupt, as a terminal does.
        e.preventDefault();
        input.value = "";
        control("ctrl+c");
      } else return;
      e.stopPropagation();
    });

    // ---- keys mode: presses are batched for a moment, then sent in order.
    let queue = [], timer = null;
    function flush() {
      timer = null;
      if (!queue.length) return;
      const seq = [];
      for (const it of queue.splice(0, 64)) {
        const last = seq[seq.length - 1];
        if (it.text && last?.text) last.text += it.text;
        else seq.push({ ...it });
      }
      send({ mode: "keys", seq }, "Sent " + seq.map((x) => x.text != null ? `“${x.text}”` : keyLabel(x.key)).join(" "));
      if (queue.length) timer = setTimeout(flush, 120);
    }
    pad.addEventListener("keydown", (e) => {
      const it = keyItem(e);
      if (!it) return;
      e.preventDefault();
      e.stopPropagation();
      queue.push(it);
      if (!timer) timer = setTimeout(flush, 120);
    });
    pad.addEventListener("paste", (e) => {
      const t = e.clipboardData?.getData("text") || "";
      e.preventDefault();
      t.split(/\r?\n/).forEach((part, i) => { if (i) queue.push({ key: "enter" }); if (part) queue.push({ text: part.replace(/[\u0000-\u001f\u007f]/g, "") }); });
      if (!timer) timer = setTimeout(flush, 120);
    });
    async function setKeys(on) {
      if (on && !exited) {
        const ask = window.hd?.confirm;
        const ok = ask ? await ask(`Keys mode on a running agent (${liveStatus || "live"}): every key you press goes straight to it, Esc and Ctrl+C included, even while it works. Switch it on?`, [], "Keys mode") : false;
        if (!ok) return;
      }
      keysOn = on;
      mode.setAttribute("aria-pressed", String(on));
      mode.classList.toggle("on", on);
      mode.textContent = on ? "Keys mode: on" : "Keys mode";
      pad.hidden = !on;
      if (on) pad.focus();
    }
    mode.addEventListener("click", () => setKeys(!keysOn));

    // ---- the way back
    function actions(about) {
      const ask = window.hd?.confirm || (async (m) => confirm(m));
      const kids = [];
      if (hub) {
        const slug = key.slice(4);
        const resume = !!about?.resumable;
        kids.push(el("button", { type: "button", class: "tbtn primary", "data-act": resume ? "resume" : "restart", text: resume ? "Resume session" : "Restart agent…",
          title: `herdr-projects open ${slug}`,
          onclick: async () => {
            const ok = await ask(resume
              ? `Resume the ${about?.name || slug} coordinator? herdr-projects runs “open ${slug}”: it starts ${about?.agent || "the agent"} again in this pane with its profile and resumes its recorded session (a fresh one if that session is gone).`
              : `Restart the ${about?.name || slug} coordinator? herdr-projects runs “open ${slug}”: it starts the coordinator again in this pane with its profile. This is a fresh session: the old conversation is not resumed.`, [], resume ? "Resume" : "Restart");
            if (!ok) return;
            msg(resume ? "Resuming…" : "Restarting…", "pending");
            const r = await post(B + "/restart", { confirm: slug });
            logBox.querySelector(".pending")?.remove();
            msg(r.ok ? (r.data.output || "Started") : r.data.error || "HTTP " + r.status, r.ok ? "ok" : "err");
          } }));
      } else {
        kids.push(el("button", { type: "button", class: "tbtn primary", "data-act": "restart", text: "Restart agent…", title: `herdr-projects thread restart ${key.replace("/", " ")}`,
          onclick: async () => {
            const ok = await ask(`Restart the agent of ${key}${about?.title ? ` (“${about.title}”)` : ""}? herdr-projects runs “thread restart”: it starts the thread's profile${about?.profile ? ` (${about.profile})` : ""} again in this pane and sends the brief. This is a fresh session: the old conversation is not resumed.`, [], "Restart");
            if (!ok) return;
            msg("Restarting…", "pending");
            const r = await post(B + "/restart", { confirm: key });
            logBox.querySelector(".pending")?.remove();
            msg(r.ok ? (r.data.output || "Restarted") : r.data.error || "HTTP " + r.status, r.ok ? "ok" : "err");
          } }));
        kids.push(el("button", { type: "button", class: "tbtn danger", "data-act": "resolve", text: "Resolve thread…", onclick: () => window.hd?.resolveAsk?.(key) }));
      }
      acts.replaceChildren(...kids);
    }
    function about() {
      const st = window.hd?.state() || { threads: [], projects: [] };
      if (hub) {
        const p = st.projects.find((x) => x.slug === key.slice(4));
        return p && { name: p.name, agent: p.coordinator?.agent || p.coordinator?.session?.harness, resumable: p.coordinator?.resumable };
      }
      const t = st.threads.find((x) => x.key === key);
      return t && { title: t.title, profile: t.profile };
    }

    function update(ev) {
      liveStatus = ev.live_status || "";
      const now = !!(ev.pane_alive !== false && ev.agent_exited);
      if (now) {
        banner.replaceChildren(el("b", { text: "Agent exited." }), " ",
          ev.shell ? `The pane is at a ${ev.foreground || "shell"} prompt: commands typed below run there. A killed agent can leave its screen behind: “reset” clears it.` : ev.foreground ? `Running in the pane: ${ev.foreground}. Text below is typed into it.` : "The pane is still there.");
        input.placeholder = ev.shell ? `Command for ${ev.foreground || "the shell"}… (Enter runs, Shift+Enter new line, ↑↓ history)` : "Text for the pane… (Enter sends)";
      }
      if (now === exited) return;
      exited = now;
      root.hidden = false;
      root.classList.toggle("exited", now);
      banner.hidden = acts.hidden = line.hidden = !now;
      (now ? ctls : modes).append(mode);
      modes.hidden = now;
      if (now) actions(about());
      else if (keysOn) setKeys(false);
      opts.onExited?.(now);
    }
    return { el: root, update, refresh: () => exited && actions(about()) };
  }
  return { mount };
})();
