// herdr-dash prompt cards: the prompt a blocked pane shows (parsed by the
// server, prompt.go) as a card with one button per option. A click sends
// {pane, sig, option, text}; the server re-reads the pane, checks it still
// shows the same prompt, presses the option's keys once and watches the
// pane until the prompt leaves; the card says what happened.
// Also: one dialog window per waiting agent (static/windows.js), opened by
// itself for a new prompt, and opt-in browser notifications.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
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
  const KIND = { permission: "Permission", question: "Question", trust: "Trust", confirm: "Confirm" };
  const STALE_MS = 3000; // after a confirmed answer, a snapshot still showing that prompt is old
  const AUTO_MAX = 6; // windows opened by themselves at once

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
  const answerPath = (key) => {
    if (key.startsWith("hub:")) return `/api/project/${encodeURIComponent(key.slice(4))}/answer`;
    const [slug, id] = key.split("/");
    return `/api/thread/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/answer`;
  };
  // An option's cap is its shortcut number in a focused window (for Claude
  // and Codex menus also the digit the pane takes); its title names the keys.
  const keyCap = (o, i) => (o.submit ? "✓" : i < 9 ? String(i + 1) : "·");
  const keysTitle = (o) => (o.keys.length ? "Presses " + o.keys.join(" ") : "");

  // Diff-like lines (" 1 +foo", "-bar") get colours; everything stays text.
  function codeBlock(cls, text) {
    const pre = el("pre", { class: cls });
    for (const line of text.split("\n")) {
      const k = /^\s*\d*\s*\+/.test(line) ? "add" : /^\s*\d*\s*-(?!-)/.test(line) ? "del" : null;
      pre.append(k ? el("span", { class: k, text: line }) : document.createTextNode(line), "\n");
    }
    pre.lastChild?.remove();
    return pre;
  }

  // ---------------------------------------------------------------- the card
  const live = new Map(); // key -> mounted controller (the panel's or the popover's)

  // mount fills box with a card for key's prompt; update(prompt) redraws it
  // (null: no prompt). opts: { id, compact, readOnly(prompt) -> reason }.
  // mount fills box with a card for key's prompt; update(prompt) redraws it
  // (null: no prompt). opts: { id, compact, readOnly(prompt) -> reason,
  // onIdle() when the card has nothing left to show }.
  const answered = new Map(); // key -> { sig, at }: confirmed gone from the pane
  const stale = (key, p) => { const d = answered.get(key); return !!(p && d && d.sig === p.sig && Date.now() - d.at < STALE_MS); };
  function mount(box, key, opts = {}) {
    let cur = null, shownSig = "", busy = false, hideTimer = null;
    const body = el("div", { class: "pc-body" });
    const status = el("div", { class: "pc-status", role: "status" });
    const card = el("section", { id: opts.id || null, class: "pcard" + (opts.compact ? " compact" : ""), hidden: "", "aria-label": "Prompt" }, body, status);
    box.replaceChildren(card);
    const ctl = { update, answer, prompt: () => cur, key, pick };
    live.set(key, ctl);

    function setStatus(kind, text) {
      status.className = "pc-status " + kind;
      status.textContent = text;
    }
    function stateSig(p) { return p ? p.sig + "|" + p.options.map((o) => `${o.current ? 1 : 0}${o.checked == null ? "" : o.checked ? "+" : "-"}`).join("") : ""; }
    function idle() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { hideTimer = null; if (!cur && !busy) { card.hidden = true; opts.onIdle?.(); } }, 2500);
    }

    function update(p) {
      if (stale(key, p)) p = null;
      if (p && cur && p.sig !== cur.sig && !busy) setStatus("", "");
      cur = p || null;
      if (!p) {
        shownSig = "";
        if (!busy && !hideTimer) {
          if (status.textContent) idle();
          else { card.hidden = true; opts.onIdle?.(); }
        }
        return;
      }
      clearTimeout(hideTimer);
      hideTimer = null;
      card.hidden = false;
      if (stateSig(p) === shownSig) return;
      shownSig = stateSig(p);
      render(p);
    }

    function render(p) {
      const ro = document.body.classList.contains("ro") ? "This dashboard is read-only." : opts.readOnly?.(p);
      const head = el("div", { class: "pc-head" },
        el("span", { class: "pc-kind " + p.kind, text: KIND[p.kind] || "Prompt" }),
        p.title ? el("span", { class: "pc-title", text: p.title }) : null,
        el("span", { class: "pc-harness", text: p.harness }));
      const parts = [head];
      if (p.question) parts.push(el("div", { class: "pc-q", text: p.question }));
      if (p.desc) parts.push(el("div", { class: "pc-desc", text: p.desc }));
      if (p.subject) parts.push(codeBlock("pc-subject", p.subject));
      if (p.detail) parts.push(codeBlock("pc-detail", p.detail));
      const list = el("div", { class: "pc-opts" });
      p.options.forEach((o, i) => {
        const why = ro || (o.keys.length ? null : "The highlight is not visible here: use the keys below the screen.");
        const dis = why || busy ? "" : null;
        if (o.text) {
          const input = el("input", { type: "text", maxlength: "500", placeholder: o.text === "required" ? "Type your answer" : "Optional: what to do instead", "aria-label": o.label, disabled: dis });
          const send = el("button", { type: "button", class: "tbtn primary", text: o.text === "required" ? "Send" : "Pick", disabled: dis, title: why || keysTitle(o) || null,
            onclick: () => { if (o.text === "required" && !input.value.trim()) { input.focus(); return; } answer(i, input.value.trim()); } });
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send.click(); } });
          list.append(el("div", { class: "pc-text" + (o.current ? " current" : ""), "data-i": i },
            el("span", { class: "k", text: keyCap(o, i) }), el("span", { class: "lbl", text: o.label }), input, send));
          return;
        }
        list.append(el("button", {
          type: "button", "data-i": i, disabled: dis,
          class: "pc-opt" + (o.always ? " always" : "") + (o.current ? " current" : "") + (o.submit ? " submit" : ""),
          "aria-pressed": o.checked == null ? null : String(o.checked),
          title: why || [o.always ? "A lasting grant: the agent will not ask again." : o.checked != null ? "Toggle." : "Pick this option.", keysTitle(o)].join(" "),
          onclick: () => answer(i),
        }, el("span", { class: "k", text: o.checked == null ? keyCap(o, i) : o.checked ? "☑" : "☐" }), el("span", { class: "lbl", text: o.label }),
        o.always ? el("span", { class: "warn", text: "lasting" }) : null,
        o.detail ? el("span", { class: "desc", text: o.detail }) : null));
      });
      parts.push(list);
      if (ro && ro !== true) parts.push(el("p", { class: "muted pc-note", text: ro }));
      body.replaceChildren(...parts);
    }

    // pick is a shortcut: option i, a text option's field focused instead.
    function pick(i) {
      const o = cur?.options[i];
      if (!o || busy) return;
      if (o.text) { card.querySelector(`.pc-text[data-i="${i}"] input`)?.focus(); return; }
      const b = card.querySelector(`.pc-opt[data-i="${i}"]`);
      if (b && !b.disabled) answer(i);
    }

    // answer picks option i (text: for options that take it), once. The
    // server says whether the prompt left the pane. Resolves to the POST result.
    async function answer(i, text = "") {
      const p = cur;
      const o = p && p.options[i];
      if (!o || busy) return { ok: false, data: { error: "no such option" } };
      busy = true;
      card.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
      setStatus("pending", o.checked != null ? `Toggling “${o.label}”, checking…` : `Sending “${o.label}”, checking the pane…`);
      const req = { sig: p.sig, option: i };
      const pane = paneOf(key);
      if (pane) req.pane = pane;
      if (text) req.text = text;
      const r = await post(answerPath(key), req);
      busy = false;
      shownSig = "";
      if (!r.ok) {
        const code = r.data.code;
        setStatus("err", code === "prompt_stuck" ? `Still shows the prompt after “${o.label}”: the answer did not land. Nothing was sent again; check the screen.`
          : code === "prompt_changed" ? "The pane shows another prompt now: nothing was sent. Check it and answer again."
          : code === "prompt_gone" ? "The prompt is gone from the pane: nothing was sent."
          : code === "pane_changed" ? "The agent runs in another pane now: nothing was sent. Check it and answer again."
          : r.data.error || "HTTP " + r.status);
        if (cur) render(cur);
        return r;
      }
      const after = r.data.after;
      if (after === "toggled") setStatus("ok", `“${o.label}” ${o.checked ? "unchecked" : "checked"}.`);
      else {
        answered.set(key, { sig: p.sig, at: Date.now() });
        setStatus("ok", after === "next" ? `Answered “${o.label}”: the prompt cleared; a new one is up.` : `Answered “${o.label}”: the prompt cleared ✓`);
        if (cur?.sig === p.sig) cur = null;
      }
      if (cur) render(cur);
      else { shownSig = ""; idle(); }
      return r;
    }
    return ctl;
  }

  // ---------------------------------------------------------------- lookups
  let state = { projects: [], threads: [] };
  function promptIn(st, key) {
    if (key.startsWith("hub:")) return st.projects.find((p) => p.slug === key.slice(4))?.coordinator?.prompt || null;
    return st.threads.find((t) => t.key === key)?.prompt || null;
  }
  function paneOf(key) {
    if (key.startsWith("hub:")) return state.projects.find((p) => p.slug === key.slice(4))?.coordinator?.pane_id || "";
    return state.threads.find((t) => t.key === key)?.pane_id || "";
  }
  const coordTrust = (key) => (p) => (key.startsWith("hub:") && p.kind === "trust" ? "Trust screens are answered in the coordinator's own pane." : null);

  // ---------------------------------------------------------------- dialog windows
  // One window per waiting agent ("prompt:<key>"). A new prompt opens its
  // window by itself (unless turned off); one the user closed stays closed
  // for that prompt. Digits pick options in the focused window.
  const autoOn = () => { try { return localStorage.getItem("hd-win-auto") !== "0"; } catch { return true; } };
  const dismissed = (() => { try { return new Map(Object.entries(JSON.parse(sessionStorage.getItem("hd-win-dismissed") || "{}"))); } catch { return new Map(); } })();
  const saveDismissed = () => { try { sessionStorage.setItem("hd-win-dismissed", JSON.stringify(Object.fromEntries(dismissed))); } catch {} };
  const wctl = new Map(); // key -> card controller in its window

  function whereOf(key) {
    const t = state.threads.find((x) => x.key === key);
    if (t) {
      const p = state.projects.find((x) => x.slug === t.project);
      return { title: `${p?.name || t.project} · ${t.id} · ${t.title}`, short: t.id };
    }
    const p = key.startsWith("hub:") && state.projects.find((x) => "hub:" + x.slug === key);
    return p ? { title: `${p.name} · coordinator`, short: p.name } : { title: key, short: key };
  }

  function openWin(key, focus = true) {
    if (!window.HDWin) return null;
    const id = "prompt:" + key;
    if (HDWin.has(id)) { if (focus) HDWin.restore(id); return HDWin.get(id); }
    const where = whereOf(key);
    const w = HDWin.open(id, {
      title: where.title, short: "⚠ " + where.short, cls: "prompt-win", width: 480,
      build(body) {
        const box = el("div");
        const tools = el("div", { class: "pw-tools" },
          el("button", { type: "button", class: "tbtn", text: "Chat window", title: "Open the agent's screen and chat in a window", onclick: () => window.HDThreadWin?.open(key) }),
          el("button", { type: "button", class: "tbtn", text: "Panel", title: "Open the docked panel", onclick: () => window.hd?.select(key) }));
        body.append(box, tools);
        const ctl = mount(box, key, { compact: true, readOnly: coordTrust(key), onIdle: () => HDWin.close(id) });
        wctl.set(key, ctl);
        ctl.update(promptIn(state, key));
      },
      onClose() {
        const ctl = wctl.get(key);
        wctl.delete(key);
        if (live.get(key) === ctl) live.delete(key);
        // Closed while the prompt shows: not again for this prompt.
        const p = ctl?.prompt();
        if (p) { dismissed.set(key, p.sig); saveDismissed(); }
      },
    });
    w.el.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (/^[1-9]$/.test(e.key)) { e.preventDefault(); wctl.get(key)?.pick(+e.key - 1); }
    });
    if (!focus) w.el.blur();
    return w;
  }
  // Digits typed with no field focused go to the front prompt window.
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !/^[1-9]$/.test(e.key) || e.target !== document.body) return;
    const w = window.HDWin?.active();
    if (!w || !w.id.startsWith("prompt:")) return;
    e.preventDefault();
    wctl.get(w.id.slice(7))?.pick(+e.key - 1);
  });

  function allPrompts(st) {
    return [
      ...st.threads.filter((t) => t.prompt).map((t) => ({ key: t.key, p: t.prompt, where: `${t.key} · ${t.title}` })),
      ...st.projects.filter((p) => p.coordinator?.prompt).map((p) => ({ key: "hub:" + p.slug, p: p.coordinator.prompt, where: `${p.name} coordinator` })),
    ];
  }
  function syncWindows(st) {
    if (!window.HDWin) return;
    const now = new Map(allPrompts(st).filter((it) => !stale(it.key, it.p)).map((it) => [it.key, it.p]));
    for (const [key, ctl] of wctl) ctl.update(now.get(key) || null);
    for (const [key, sig] of dismissed) if (now.get(key)?.sig !== sig) dismissed.delete(key);
    saveDismissed();
    if (!autoOn() || document.body.classList.contains("ro")) return;
    let opened = HDWin.list().filter((id) => id.startsWith("prompt:")).length;
    for (const [key, p] of now) {
      if (opened >= AUTO_MAX) break;
      if (wctl.has(key) || dismissed.get(key) === p.sig) continue;
      openWin(key, false);
      opened++;
    }
  }

  // ---------------------------------------------------------------- notifications
  const seen = new Set();
  let seeded = false;
  const notifyOn = () => localStorage.getItem("hd-notify") === "1" && "Notification" in window && Notification.permission === "granted";
  function notify(st) {
    const items = allPrompts(st);
    for (const it of items) {
      const id = it.key + "|" + it.p.sig;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!seeded || !notifyOn()) continue;
      try {
        const n = new Notification(it.p.summary, { body: it.where, tag: id });
        n.onclick = () => { window.focus(); openWin(it.key); };
      } catch {}
    }
    seeded = true;
  }
  function settingsRow() {
    const supported = "Notification" in window;
    const box = el("input", { id: "vs-notify", type: "checkbox", checked: localStorage.getItem("hd-notify") === "1" && supported ? "" : null, disabled: supported ? null : "" });
    box.addEventListener("change", async () => {
      if (!box.checked) { localStorage.removeItem("hd-notify"); return; }
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (perm !== "granted") {
        box.checked = false;
        window.hd?.toast("The browser blocked notifications for this site.", "err");
        return;
      }
      localStorage.setItem("hd-notify", "1");
    });
    const auto = el("input", { id: "vs-win-auto", type: "checkbox", checked: autoOn() ? "" : null });
    auto.addEventListener("change", () => { try { localStorage.setItem("hd-win-auto", auto.checked ? "1" : "0"); } catch {} });
    const frag = document.createDocumentFragment();
    frag.append(el("label", { class: "row" }, el("span", { text: "Notify me of new prompts (this browser)" + (supported ? "" : " — not supported here") }), box),
      el("label", { class: "row" }, el("span", { text: "Open a window for each new prompt" }), auto));
    return frag;
  }

  // ---------------------------------------------------------------- hooks
  // onState runs on every snapshot: the windows follow it, notifications
  // fire for prompts not seen before.
  function onState(st) {
    state = st;
    syncWindows(st);
    notify(st);
  }
  // answerPrompt answers through the card showing key's prompt, if any, so
  // its status shows; else straight to the server.
  async function answerPrompt(key, i, text) {
    const c = live.get(key);
    if (c && c.prompt()) return c.answer(i, text);
    const p = promptIn(state, key);
    if (!p) return { ok: false, data: { error: "no prompt" } };
    const req = { sig: p.sig, option: i };
    if (paneOf(key)) req.pane = paneOf(key);
    if (text) req.text = text;
    return post(answerPath(key), req);
  }
  const promptFor = (key) => live.get(key)?.prompt() || promptIn(state, key);

  window.HDPrompt = { mount: (box, key, opts = {}) => mount(box, key, { readOnly: coordTrust(key), ...opts }), pop: (key) => openWin(key), open: openWin, onState, settingsRow, answerPrompt, promptFor };
})();
