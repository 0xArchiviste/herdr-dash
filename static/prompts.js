// herdr-dash prompt cards: the prompt a blocked pane shows (parsed by the
// server, prompt.go) as a card with one button per option. A click sends
// {sig, option, text}; the server re-reads the pane, checks the prompt is
// still the same and presses the option's keys itself. The card then
// watches the pane until the prompt clears (or says it did not).
// Also: the strip's answer popover and opt-in browser notifications.
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
  const CLEAR_WAIT = 8000; // how long an answered prompt may stay before the card says so

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
  const keyCap = (o) => (o.keys.length === 1 && /^\d$/.test(o.keys[0]) ? o.keys[0] : o.submit ? "✓" : o.keys.length ? "↵" : "·");

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
  function mount(box, key, opts = {}) {
    let cur = null, shownSig = "", wait = null, hideTimer = null;
    const body = el("div", { class: "pc-body" });
    const status = el("div", { class: "pc-status", role: "status" });
    const card = el("section", { id: opts.id || null, class: "pcard" + (opts.compact ? " compact" : ""), hidden: "", "aria-label": "Prompt" }, body, status);
    box.replaceChildren(card);
    const ctl = { update, answer, prompt: () => cur, key };
    live.set(key, ctl);

    function setStatus(kind, text) {
      status.className = "pc-status " + kind;
      status.textContent = text;
    }
    function stateSig(p) { return p ? p.sig + "|" + p.options.map((o) => `${o.current ? 1 : 0}${o.checked == null ? "" : o.checked ? "+" : "-"}`).join("") : ""; }

    function update(p) {
      if (wait) {
        if (!p || p.sig !== wait.sig) {
          settle("ok", p ? `Answered “${wait.label}”: the prompt cleared (a new one is up).` : `Answered “${wait.label}”: the prompt cleared ✓`);
          if (!p) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!cur) card.hidden = true; }, 2500); }
        } else if (wait.toggle) {
          const o = p.options[wait.opt];
          if (o && o.checked !== wait.was) settle("ok", `“${wait.label}” ${o.checked ? "checked" : "unchecked"}.`);
        }
      }
      cur = p || null;
      if (!p) {
        shownSig = "";
        if (!wait && !hideTimer) card.hidden = true;
        return;
      }
      clearTimeout(hideTimer);
      hideTimer = null;
      card.hidden = false;
      if (stateSig(p) === shownSig) return;
      shownSig = stateSig(p);
      render(p);
    }
    function settle(kind, text) {
      clearTimeout(wait?.timer);
      wait = null;
      setStatus(kind, text);
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
        if (o.text) {
          const input = el("input", { type: "text", maxlength: "500", placeholder: o.text === "required" ? "Type your answer" : "Optional: what to do instead", "aria-label": o.label, disabled: why ? "" : null });
          const send = el("button", { type: "button", class: "tbtn primary", text: o.text === "required" ? "Send" : "Pick", disabled: why ? "" : null, title: why || null,
            onclick: () => { if (o.text === "required" && !input.value.trim()) { input.focus(); return; } answer(i, input.value.trim()); } });
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send.click(); } });
          list.append(el("div", { class: "pc-text" + (o.current ? " current" : ""), "data-i": i },
            el("span", { class: "k", text: keyCap(o) }), el("span", { class: "lbl", text: o.label }), input, send));
          return;
        }
        list.append(el("button", {
          type: "button", "data-i": i, disabled: why ? "" : null,
          class: "pc-opt" + (o.always ? " always" : "") + (o.current ? " current" : "") + (o.submit ? " submit" : ""),
          "aria-pressed": o.checked == null ? null : String(o.checked),
          title: why || (o.always ? "A lasting grant: the agent will not ask again" : o.checked != null ? "Toggle" : "Pick this option"),
          onclick: () => answer(i),
        }, el("span", { class: "k", text: o.checked == null ? keyCap(o) : o.checked ? "☑" : "☐" }), el("span", { class: "lbl", text: o.label }),
        o.always ? el("span", { class: "warn", text: "lasting" }) : null,
        o.detail ? el("span", { class: "desc", text: o.detail }) : null));
      });
      parts.push(list);
      if (ro && ro !== true) parts.push(el("p", { class: "muted pc-note", text: ro }));
      body.replaceChildren(...parts);
    }

    // answer picks option i (text: for options that take it). Resolves to
    // the POST result.
    async function answer(i, text = "") {
      const p = cur;
      const o = p && p.options[i];
      if (!o) return { ok: false, data: { error: "no such option" } };
      card.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
      setStatus("pending", `Sending “${o.label}”…`);
      const r = await post(answerPath(key), text ? { sig: p.sig, option: i, text } : { sig: p.sig, option: i });
      shownSig = "";
      if (cur) render(cur);
      if (!r.ok) {
        setStatus("err", r.data.error || "HTTP " + r.status);
        return r;
      }
      clearTimeout(wait?.timer);
      wait = { sig: p.sig, opt: i, label: o.label, toggle: o.checked != null, was: o.checked };
      setStatus("pending", o.checked != null ? `Toggled “${o.label}”, checking…` : `Answered “${o.label}”, checking the prompt cleared…`);
      const w = wait;
      w.timer = setTimeout(() => {
        if (wait === w) settle("warn", `Still showing ${CLEAR_WAIT / 1000}s after “${o.label}”: the answer may not have registered. Check the screen.`);
      }, CLEAR_WAIT);
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
  const coordTrust = (key) => (p) => (key.startsWith("hub:") && p.kind === "trust" ? "Trust screens are answered in the coordinator's own pane." : null);

  // ---------------------------------------------------------------- strip popover
  const pop = el("div", { id: "prompt-pop", hidden: "", role: "dialog", "aria-label": "Answer the prompt" });
  let popKey = null, popCtl = null;
  function openPop(key, anchor) {
    const st = state;
    const t = st.threads.find((x) => x.key === key);
    const p = key.startsWith("hub:") && st.projects.find((x) => "hub:" + x.slug === key);
    const name = t ? `${t.key} · ${t.title}` : p ? `${p.name} · coordinator` : key;
    const box = el("div");
    pop.replaceChildren(
      el("div", { class: "pp-head" }, el("span", { class: "pp-t", text: name }),
        el("button", { type: "button", class: "tbtn", text: "Open panel", onclick: () => { closePop(); window.hd?.select(key); } }),
        el("button", { type: "button", class: "close", "aria-label": "Close", text: "×", onclick: closePop })),
      box);
    popKey = key;
    popCtl = mount(box, key, { compact: true, readOnly: coordTrust(key) });
    popCtl.update(promptIn(st, key));
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(460, innerWidth - 16);
    pop.style.width = w + "px";
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
    pop.style.top = Math.min(r.bottom + 6, innerHeight - 120) + "px";
  }
  function closePop() {
    if (popKey && live.get(popKey) === popCtl) live.delete(popKey);
    pop.hidden = true;
    popKey = popCtl = null;
  }
  document.addEventListener("mousedown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.(".chip-answer")) closePop();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { e.stopImmediatePropagation(); closePop(); } }, true);

  // ---------------------------------------------------------------- notifications
  const seen = new Set();
  let seeded = false;
  const notifyOn = () => localStorage.getItem("hd-notify") === "1" && "Notification" in window && Notification.permission === "granted";
  function notify(st) {
    const items = [
      ...st.threads.filter((t) => t.prompt).map((t) => ({ key: t.key, p: t.prompt, where: `${t.key} · ${t.title}` })),
      ...st.projects.filter((p) => p.coordinator?.prompt).map((p) => ({ key: "hub:" + p.slug, p: p.coordinator.prompt, where: `${p.name} coordinator` })),
    ];
    for (const it of items) {
      const id = it.key + "|" + it.p.sig;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!seeded || !notifyOn()) continue;
      try {
        const n = new Notification(it.p.summary, { body: it.where, tag: id });
        n.onclick = () => { window.focus(); window.hd?.select(it.key); };
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
    return el("label", { class: "row" }, el("span", { text: "Notify me of new prompts (this browser)" + (supported ? "" : " — not supported here") }), box);
  }

  // ---------------------------------------------------------------- hooks
  // onState runs on every snapshot: the popover follows it, notifications
  // fire for prompts not seen before.
  function onState(st) {
    state = st;
    if (popCtl) popCtl.update(promptIn(st, popKey));
    notify(st);
  }
  // answerPrompt answers through the card showing key's prompt, if any, so
  // its status shows; else straight to the server.
  async function answerPrompt(key, i, text) {
    const c = live.get(key);
    if (c && c.prompt()) return c.answer(i, text);
    const p = promptIn(state, key);
    if (!p) return { ok: false, data: { error: "no prompt" } };
    return post(answerPath(key), text ? { sig: p.sig, option: i, text } : { sig: p.sig, option: i });
  }
  const promptFor = (key) => live.get(key)?.prompt() || promptIn(state, key);

  document.body.append(pop);
  window.HDPrompt = { mount: (box, key, opts = {}) => mount(box, key, { readOnly: coordTrust(key), ...opts }), pop: openPop, onState, settingsRow, answerPrompt, promptFor };
})();
