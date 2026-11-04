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
  const KIND = { permission: "Permission", question: "Question", plan: "Plan", trust: "Trust", confirm: "Confirm" };
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
    // sel is the window's own highlight (arrow keys); it follows the pane's
    // highlight whenever that moves. open: optional text fields shown.
    let sel = 0, paneCur = -1, open = new Set();
    const body = el("div", { class: "pc-body" });
    const status = el("div", { class: "pc-status", role: "status" });
    const card = el("section", { id: opts.id || null, class: "pcard" + (opts.compact ? " compact" : ""), hidden: "", "aria-label": "Prompt" }, body, status);
    box.replaceChildren(card);
    const ctl = { update, answer, prompt: () => cur, key, pick, keydown, escape };
    live.set(key, ctl);

    function setStatus(kind, text) {
      status.className = "pc-status " + kind;
      status.textContent = text;
    }
    function stateSig(p) { return p ? p.sig + "|" + (p.focused ? "f" : "") + (p.cancel ? "c" : "") + (p.prev ? "<" : "") + (p.next ? ">" : "") + p.options.map((o) => `${o.current ? 1 : 0}${o.checked == null ? "" : o.checked ? "+" : "-"}${o.keys.length}${o.text_keys ? "t" : ""}:${o.draft || ""}:${o.preview || ""}`).join("|") + (p.tabs || []).map((t) => (t.current ? "*" : "") + (t.done ? "+" : "")).join("") : ""; }
    function idle() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { hideTimer = null; if (!cur && !busy) { card.hidden = true; opts.onIdle?.(); } }, 2500);
    }

    function update(p) {
      if (stale(key, p)) p = null;
      if (p && cur && p.sig !== cur.sig && !busy) setStatus("", "");
      const was = cur;
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
      const pc = p.options.findIndex((o) => o.current);
      if (!was || was.sig !== p.sig) { sel = Math.max(0, pc); open = new Set(); }
      else if (pc !== paneCur && pc >= 0) sel = pc; // moved in the pane: follow it
      paneCur = pc;
      sel = Math.min(sel, p.options.length - 1);
      if (stateSig(p) === shownSig) return;
      shownSig = stateSig(p);
      render(p);
    }

    // The fields keep what is typed in them (and the focus) across redraws.
    function fieldState() {
      const out = new Map();
      card.querySelectorAll(".pc-row").forEach((r) => {
        const f = r.querySelector(".pc-field");
        if (f && !f.readOnly) out.set(r.dataset.i, { v: f.value, focus: f === document.activeElement, s: f.selectionStart, e: f.selectionEnd });
      });
      return out;
    }

    function render(p) {
      const keep = fieldState();
      const ro = document.body.classList.contains("ro") ? "This dashboard is read-only." : opts.readOnly?.(p);
      const head = el("div", { class: "pc-head" },
        el("span", { class: "pc-kind " + p.kind, text: KIND[p.kind] || "Prompt" }),
        p.title && p.title !== KIND[p.kind] ? el("span", { class: "pc-title", text: p.title }) : null,
        el("span", { class: "pc-harness", text: p.harness }));
      const parts = [head];
      if (p.tabs?.length > 1) {
        parts.push(el("div", { class: "pc-tabs", role: "tablist", "aria-label": "Questions" },
          el("button", { type: "button", class: "tbtn pc-prev", text: "←", title: "Previous question (←)", "aria-label": "Previous question", disabled: p.prev && !ro && !busy ? null : "", onclick: () => answer(-1, "", "prev") }),
          ...p.tabs.map((t) => el("span", { class: "pc-tab" + (t.current ? " current" : "") + (t.done ? " done" : ""), role: "tab", "aria-selected": String(!!t.current), text: (t.done ? "✔ " : "") + t.label })),
          el("button", { type: "button", class: "tbtn pc-next", text: "→", title: "Next question (→ or Tab)", "aria-label": "Next question", disabled: p.next && !ro && !busy ? null : "", onclick: () => answer(-1, "", "next") })));
      }
      if (p.question) parts.push(el("div", { class: "pc-q", text: p.question }));
      if (p.desc) parts.push(el("div", { class: "pc-desc", text: p.desc }));
      if (p.subject) parts.push(codeBlock("pc-subject", p.subject));
      if (p.detail) parts.push(p.kind === "plan" ? el("pre", { class: "pc-plan", text: p.detail }) : codeBlock("pc-detail", p.detail));
      const list = el("div", { class: "pc-opts", role: "listbox", "aria-label": "Options" });
      const claude = p.harness === "claude";
      p.options.forEach((o, i) => {
        const why = ro || (o.keys.length || o.text ? null : "The highlight is not visible here: use the keys below the screen.");
        const dis = why || busy ? "" : null;
        const row = el("div", { class: "pc-row" + (i === sel ? " sel" : "") + (o.current ? " current" : ""), "data-i": i, role: "option", "aria-selected": String(i === sel) });
        const cap = o.checked == null ? keyCap(o, i) : o.checked ? "☑" : "☐";
        if (o.text !== "required") {
          row.append(el("button", {
            type: "button", "data-i": i, disabled: dis || (o.keys.length ? null : ""),
            class: "pc-opt" + (o.always ? " always" : "") + (o.current ? " current" : "") + (o.submit ? " submit" : ""),
            "aria-pressed": o.checked == null ? null : String(o.checked),
            title: why || [o.always ? "A lasting grant: the agent will not ask again." : o.checked != null ? "Toggle." : "Pick this option.", keysTitle(o)].join(" "),
            onclick: () => { sel = i; answer(i); },
          }, el("span", { class: "k", text: cap }), el("span", { class: "lbl", text: o.label }),
          o.always ? el("span", { class: "warn", text: "lasting" }) : null,
          o.detail ? el("span", { class: "desc", text: o.detail }) : null));
        }
        if (o.text) {
          const optional = o.text === "optional";
          const shown = !optional || o.draft || open.has(i);
          const hint = p.notes ? "Notes for this option" : optional ? (/^yes/i.test(o.label) ? "and tell Claude what to do next" : "and tell the agent what to do differently") : "Type your answer";
          if (optional && !o.draft) row.append(el("button", { type: "button", class: "tbtn pc-amend", text: open.has(i) ? "Close" : p.notes ? "n · notes" : "Tab · add text", title: p.notes ? "Add notes (n)" : "Add text to this answer (Tab)", disabled: dis || (o.text_keys ? null : ""), onclick: () => toggleField(i) }));
          if (shown) {
            const canType = !!o.text_keys && !o.draft;
            const field = el(claude ? "textarea" : "input", { class: "pc-field", rows: claude ? "1" : null, type: claude ? null : "text", maxlength: "2000", placeholder: hint, "aria-label": `${o.label}: ${hint}`,
              disabled: o.draft ? null : canType && !dis ? null : "", readonly: o.draft ? "" : null,
              title: o.draft ? "Typed in the pane: send it as it is, or change it there." : canType ? (claude ? "Enter sends, Shift+Enter starts a new line" : "Enter sends") : "A field in the pane has the keyboard: type there." });
            if (o.draft) field.value = o.draft;
            const send = el("button", { type: "button", class: "tbtn primary send", text: o.draft ? "Send as typed" : p.multi && !optional ? "Type" : "Send", disabled: dis || (o.draft ? (o.keys.length ? null : "") : canType ? null : ""), title: why || keysTitle(o) || null,
              onclick: () => {
                if (o.draft) { answer(i); return; }
                const v = field.value.trim();
                if (!v) { if (optional && o.keys.length) answer(i); else field.focus(); return; }
                answer(i, field.value);
              } });
            const grow = () => { if (claude) { field.style.height = "auto"; field.style.height = Math.min(field.scrollHeight + 2, 160) + "px"; } };
            field.addEventListener("input", grow);
            field.addEventListener("keydown", (e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send.click(); }
              else if (e.key === "Escape") { e.preventDefault(); escape(e); }
              e.stopPropagation(); // typing is text, never the window's keys
            });
            row.append(el("div", { class: "pc-text" + (o.current ? " current" : "") },
              optional ? null : el("span", { class: "k", text: cap }), optional ? null : el("span", { class: "lbl", text: o.label }), field, send));
            requestAnimationFrame(grow);
          }
        }
        list.append(row);
      });
      parts.push(list);
      const shownPreview = p.options.find((o) => o.preview);
      if (shownPreview) parts.push(el("div", { class: "pc-preview-h muted", text: "Preview: " + shownPreview.label }), el("pre", { class: "pc-preview", text: shownPreview.preview }));
      if (p.cancel) parts.push(el("div", { class: "pc-foot" }, el("button", { type: "button", class: "tbtn pc-cancel", text: "Esc · " + (p.kind === "permission" ? "Deny" : "Cancel"), disabled: ro || busy ? "" : null,
        title: p.kind === "permission" ? "Deny, as Esc does in the pane" : "Cancel, as Esc does in the pane", onclick: () => answer(-1, "", "cancel") })));
      if (p.focused) parts.push(el("p", { class: "muted pc-note", text: "A text field in the pane has the keyboard: options are reached with the arrow keys." }));
      if (ro && ro !== true) parts.push(el("p", { class: "muted pc-note", text: ro }));
      body.replaceChildren(...parts);
      for (const [i, st] of keep) {
        const f = card.querySelector(`.pc-row[data-i="${i}"] .pc-field`);
        if (!f || f.readOnly || f.disabled) continue;
        f.value = st.v;
        if (st.focus) { f.focus(); try { f.setSelectionRange(st.s, st.e); } catch {} }
      }
    }

    function markSel() {
      card.querySelectorAll(".pc-row").forEach((r) => { const on = +r.dataset.i === sel; r.classList.toggle("sel", on); r.setAttribute("aria-selected", String(on)); });
      card.querySelector(".pc-row.sel")?.scrollIntoView({ block: "nearest" });
    }
    function toggleField(i, focus = true) {
      const o = cur?.options[i];
      if (!o?.text) return;
      if (o.text === "optional" && !o.draft) open.has(i) && !focus ? open.delete(i) : open.add(i);
      sel = i;
      shownSig = "";
      render(cur);
      if (focus) card.querySelector(`.pc-row[data-i="${i}"] .pc-field`)?.focus();
    }

    // keydown drives the card like the pane's own menu; true when used.
    function keydown(e) {
      if (!cur || busy || e.altKey || e.ctrlKey || e.metaKey) return false;
      const n = cur.options.length;
      const o = cur.options[sel];
      switch (e.key) {
        case "ArrowDown": case "ArrowUp":
          sel = (sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n; markSel(); return true;
        case "Enter":
          if (o?.text === "required" && !o.draft) toggleField(sel); else pick(sel);
          return true;
        case " ":
          if (o && (o.checked != null || o.submit)) { pick(sel); return true; }
          return false;
        case "Tab":
          if (e.shiftKey) return false;
          if (o?.text === "optional" && o.text_keys) { toggleField(sel); return true; }
          if (cur.next) { answer(-1, "", "next"); return true; }
          return false;
        case "ArrowLeft": case "ArrowRight": {
          const a = e.key === "ArrowLeft" ? "prev" : "next";
          if (cur[a]) { answer(-1, "", a); return true; }
          return false;
        }
        case "n":
          if (cur.notes && o?.text_keys) { toggleField(sel); return true; }
          return false;
        case "Escape":
          if (cur.cancel) { answer(-1, "", "cancel"); return true; }
          return false;
      }
      if (/^[1-9]$/.test(e.key)) { pick(+e.key - 1); return true; }
      return false;
    }

    // escape is Esc anywhere in the card: out of a text field first (as in
    // the pane), else the prompt's own Esc. True when used.
    function escape(e) {
      const f = document.activeElement;
      if (f && card.contains(f) && f.classList.contains("pc-field")) {
        const i = +f.closest(".pc-row").dataset.i;
        if (cur?.options[i]?.text === "optional" && !f.value.trim()) { open.delete(i); shownSig = ""; render(cur); }
        else f.blur();
        card.closest(".hwin")?.focus();
        return true;
      }
      return keydown(e);
    }

    // pick is a shortcut: option i, a text option's field focused instead.
    function pick(i) {
      const o = cur?.options[i];
      if (!o || busy) return;
      sel = i;
      markSel();
      if (o.text === "required" && !o.draft) { toggleField(i); return; }
      const b = card.querySelector(`.pc-opt[data-i="${i}"]`) || (o.draft && card.querySelector(`.pc-row[data-i="${i}"] .send`));
      if (b && !b.disabled) answer(i);
    }

    // answer picks option i (text: for options that take it), or runs an
    // action (cancel, prev, next), once. The server says whether the
    // prompt left the pane. Resolves to the POST result.
    async function answer(i, text = "", action = "") {
      const p = cur;
      const o = p && !action ? p.options[i] : null;
      if (!p || (!o && !action) || busy) return { ok: false, data: { error: "no such option" } };
      const label = o ? o.label : { cancel: "Esc", prev: "previous question", next: "next question" }[action];
      busy = true;
      card.querySelectorAll("button, input, textarea").forEach((b) => (b.disabled = true));
      setStatus("pending", o?.checked != null && !text ? `Toggling “${label}”, checking…` : text ? `Typing into “${label}”, checking the pane…` : `Sending “${label}”, checking the pane…`);
      const req = { sig: p.sig, option: Math.max(0, i) };
      if (action) req.action = action;
      const pane = paneOf(key);
      if (pane) req.pane = pane;
      if (text) req.text = text;
      const r = await post(answerPath(key), req);
      busy = false;
      shownSig = "";
      if (!r.ok) {
        const code = r.data.code;
        setStatus("err", code === "prompt_stuck" ? `Still shows the prompt after “${label}”: the answer did not land. Nothing was sent again; check the screen.`
          : code === "prompt_changed" ? "The pane shows another prompt now: nothing was sent. Check it and answer again."
          : code === "prompt_gone" ? "The prompt is gone from the pane: nothing was sent."
          : code === "pane_changed" ? "The agent runs in another pane now: nothing was sent. Check it and answer again."
          : code === "draft_in_field" ? "Text is already typed into that field in the pane: send it as it is, or change it there."
          : r.data.error || "HTTP " + r.status);
        // The prompt may have left while this was out (answered elsewhere,
        // or the agent was slow): then the card goes too.
        if (cur) render(cur); else idle();
        return r;
      }
      const after = r.data.after;
      if (after === "toggled") setStatus("ok", `“${label}” ${o.checked ? "unchecked" : "checked"}.`);
      else if (after === "typed") setStatus("ok", `Typed into “${label}”: it is ticked. Submit when ready.`);
      else if (action === "prev" || action === "next") setStatus("", "");
      else {
        answered.set(key, { sig: p.sig, at: Date.now() });
        // The same prompt asked again right away arrives looking stale and
        // the snapshot stream only sends changes: look again once it is not.
        setTimeout(() => syncWindows(state), STALE_MS + 100);
        setStatus("ok", action === "cancel" ? (after === "next" ? "Esc sent: a new prompt is up." : "Esc sent: the prompt cleared ✓")
          : after === "next" ? `Answered “${label}”: the prompt cleared; a new one is up.` : `Answered “${label}”: the prompt cleared ✓`);
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
      onEsc: (e) => !!wctl.get(key)?.escape(e),
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
    // The window takes the pane's menu keys: arrows, Enter, Space, digits,
    // Tab, n, Esc (cancel or deny when the pane offers it, else the window
    // closes). Not while typing in a field or using a button.
    w.el.addEventListener("keydown", (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.target.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
      if (wctl.get(key)?.keydown(e)) { e.preventDefault(); e.stopPropagation(); }
    });
    if (!focus) w.el.blur();
    return w;
  }
  // Keys typed with nothing focused go to the front prompt window (before
  // the window layer's own Esc, which would close it).
  document.addEventListener("keydown", (e) => {
    if (e.target !== document.body || document.querySelector("dialog[open]")) return;
    const w = window.HDWin?.active();
    if (!w || !w.id.startsWith("prompt:") || w.min) return;
    if (wctl.get(w.id.slice(7))?.keydown(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

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
