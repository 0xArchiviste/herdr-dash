// herdr-dash Agent filter: which harness (claude, codex, opencode, …) and
// model each active thread and coordinator runs, a multi-select filter over
// them that every view applies (AND with the project focus), and the
// Landscape: per agent and model, threads by state, coordinators, projects,
// CPU and RAM. Everything comes from the streamed snapshot and the System
// strip's frames: no requests of its own.
//
// The agent is the one observed in the pane (herdr's live agent) where
// known, else the one herdr-projects recorded (thread agent, coordinator
// record, profile); a disagreement is marked. The model is the session's
// (observed, or the matching profile's); without one, the profile's name.
//
// Selection: keys "harness" or "harness:model", in localStorage (hd-agents)
// and the URL (?agent=a,b; the URL wins). Keys nothing runs are kept but
// never hide everything. A opens the picker; on phones it is a bottom sheet.
window.HDAgents = (() => {
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
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  };
  const st = () => window.dash?.state?.() || { projects: [], threads: [] };
  const HARNESSES = ["claude", "codex", "opencode", "cursor", "grok", "hermes", "gemini", "amp", "aider", "goose", "crush", "qwen", "kimi", "pi"];
  const COLORS = { claude: "#ff8700", codex: "#68a8e4", opencode: "#98bc37", cursor: "#c47fd5", grok: "#fce8c3", hermes: "#2be4d0", gemini: "#fbb829" };
  const colorOf = (h) => COLORS[h] || "#baa67f";

  // ------------------------------------------------------------ classify
  // A profile named after its harness ("codex-high") names it when nothing
  // else does.
  const profAgent = (p) => { const h = (p || "").toLowerCase().split(/[-_:.\s]/)[0]; return HARNESSES.includes(h) ? h : ""; };
  function shortModel(h, m) {
    m = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
    return h === "claude" ? m.replace(/^claude-/, "") : m;
  }
  function classify(observed, recorded, session, profile) {
    observed = observed || "";
    recorded = recorded || "";
    const harness = observed || recorded || "unknown";
    const mismatch = !!(observed && recorded && observed !== recorded);
    const m = session?.model?.value || "";
    // A model only belongs to the harness its session or profile ran.
    const sAgent = session?.agent || "";
    const sub = m && !(session?.model?.source === "profile" && sAgent && sAgent !== harness) ? shortModel(harness, m) : (!mismatch && profile) || "";
    return { harness, sub, observed, recorded, mismatch, label: sub ? `${harness} · ${sub}` : harness };
  }
  const isDone = (t) => t.state === "resolved" || t.state === "leftover";
  function ofThread(t) {
    const s = t.session || {};
    const c = classify(t.live_agent, t.agent || s.agent || profAgent(t.profile || s.profile), s, t.profile || s.profile);
    return { ...c, key: t.key, project: t.project, kind: "thread", active: !isDone(t),
      bucket: t.needs_you ? "waiting" : t.state === "working" || t.state === "landing" ? "working" : "idle" };
  }
  function ofCoord(p) {
    const co = p.coordinator || {};
    const s = co.session || {};
    const c = classify(co.agent, co.recorded_agent || s.agent || profAgent(s.profile), s, s.profile);
    return { ...c, key: "hub:" + p.slug, project: p.slug, kind: "coord", active: !!co.agent && co.state !== "none" && !co.agent_exited };
  }
  // One index per snapshot object: key -> classification, and the active ones.
  let idxFor = null, idx = null;
  function index() {
    const s = st();
    if (idxFor === s && idx) return idx;
    const byKey = new Map();
    for (const t of s.threads) byKey.set(t.key, ofThread(t));
    for (const p of s.projects) byKey.set("hub:" + p.slug, ofCoord(p));
    const items = [...byKey.values()].filter((c) => c.active);
    idxFor = s;
    idx = { byKey, items, known: new Set(items.flatMap((c) => (c.sub ? [c.harness, c.harness + ":" + c.sub] : [c.harness]))) };
    return idx;
  }
  const of = (t) => index().byKey.get(t.key) || ofThread(t);

  // ------------------------------------------------------------ selection
  const sel = new Set();
  try { (JSON.parse(localStorage.getItem("hd-agents") || "[]") || []).forEach((k) => typeof k === "string" && sel.add(k)); } catch {}
  const urlSel = new URLSearchParams(location.search).get("agent");
  if (urlSel != null) {
    sel.clear();
    urlSel.split(",").map((x) => x.trim()).filter(Boolean).forEach((x) => sel.add(x));
  }
  const eff = () => { const k = index().known; return new Set([...sel].filter((x) => k.has(x))); };
  const active = () => eff().size > 0;
  const okCls = (c, e = eff()) => !e.size || e.has(c.harness) || (!!c.sub && e.has(c.harness + ":" + c.sub));
  // A thread (open or not) on the selection.
  const match = (t) => okCls(of(t));
  // A coordinator: only a live one can be on it.
  function matchCoord(p) {
    const e = eff();
    if (!e.size) return true;
    const c = index().byKey.get("hub:" + p.slug);
    return !!c?.active && okCls(c, e);
  }
  // A project runs something on the selection (an open thread or its coordinator).
  function matchProject(slug) {
    const e = eff();
    return !e.size || index().items.some((c) => c.project === slug && okCls(c, e));
  }
  // Any keyed owner: a thread key, hub:<slug>, or anything else (kept).
  function matchKey(key) {
    const e = eff();
    if (!e.size || !key) return true;
    const c = index().byKey.get(key);
    if (!c) return true;
    return c.kind === "coord" ? c.active && okCls(c, e) : okCls(c, e);
  }
  // Harness level only, for panes known by their agent alone.
  const matchHarness = (h) => { const e = eff(); return !e.size || [...e].some((k) => k.split(":")[0] === h); };

  function save() {
    const keys = [...sel].sort();
    try { localStorage.setItem("hd-agents", JSON.stringify(keys)); } catch {}
    const u = new URL(location.href);
    if (keys.length) u.searchParams.set("agent", keys.join(",")); else u.searchParams.delete("agent");
    const next = u.pathname + u.search.replace(/%2C/gi, ",").replace(/%3A/gi, ":") + u.hash;
    if (next !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", next);
  }
  function changed() {
    save();
    window.dash?.render?.();
    document.dispatchEvent(new CustomEvent("hd-focus"));
  }
  function set(keys) { sel.clear(); keys.forEach((k) => sel.add(k)); changed(); }
  function toggle(key) {
    const known = index().known;
    for (const x of [...sel]) if (!known.has(x)) sel.delete(x); // stale keys never decide
    sel.has(key) ? sel.delete(key) : sel.add(key);
    changed();
  }
  const labelOf = (k) => k.replace(":", " · ");
  const summary = () => [...eff()].sort().map(labelOf).join(", ");

  // ------------------------------------------------------------ options
  function options() {
    const groups = new Map();
    for (const c of index().items) {
      if (!groups.has(c.harness)) groups.set(c.harness, { key: c.harness, harness: c.harness, items: [], subs: new Map() });
      const g = groups.get(c.harness);
      g.items.push(c);
      if (c.sub) {
        const k = c.harness + ":" + c.sub;
        if (!g.subs.has(k)) g.subs.set(k, { key: k, harness: c.harness, sub: c.sub, items: [] });
        g.subs.get(k).items.push(c);
      }
    }
    const byN = (a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key);
    return [...groups.values()].sort(byN).map((g) => ({ ...g, subs: [...g.subs.values()].sort(byN) }));
  }
  const procs = () => window.HDSystem?.frameNow?.()?.procs || [];
  function stats(items) {
    const n = { working: 0, waiting: 0, idle: 0, coord: 0, projects: new Set(), cpu: null, ram: 0, mismatch: [] };
    const keys = new Set();
    for (const c of items) {
      keys.add(c.key);
      n.projects.add(c.project);
      if (c.kind === "coord") n.coord++; else n[c.bucket]++;
      if (c.mismatch) n.mismatch.push(c);
    }
    for (const p of procs()) {
      if (!keys.has(p.key)) continue;
      n.ram += p.rss || 0;
      if (p.cpu != null) n.cpu = (n.cpu || 0) + p.cpu;
    }
    return n;
  }
  const dash0 = (v) => (v ? String(v) : "–");
  const bytes = (b) => (!b ? "–" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

  // ------------------------------------------------------------ UI
  const box = el("div", { id: "agent-box" });
  const btn = el("button", { id: "f-agent", class: "fbtn", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "agent-picker", title: "Filter by agent (A)" }, "All agents");
  const picker = el("div", { id: "agent-picker", role: "dialog", "aria-label": "Filter by agent", hidden: "" });
  const list = el("div", { id: "ap-list", role: "group", "aria-label": "Agents and models" });
  const land = el("div", { id: "ap-land-wrap" });
  const note = el("p", { id: "ap-note", class: "pp-note" });
  const fade = el("input", { id: "ap-fade", type: "checkbox" });
  picker.append(
    el("div", { class: "pp-head" }, el("h3", { class: "ap-title", text: "Agents" }), el("button", { id: "ap-done", class: "tbtn", type: "button", text: "Done", onclick: () => close(true) })),
    el("div", { class: "pp-acts" },
      el("button", { id: "ap-all", class: "tbtn", type: "button", title: "Tick every agent", text: "All", onclick: () => set(options().map((o) => o.key)) }),
      el("button", { id: "ap-none", class: "tbtn", type: "button", title: "Untick every agent: all show", text: "None", onclick: () => set([]) }),
      el("label", { class: "pp-fade", title: "Threads of other agents stay on the map, faded" }, fade, " Fade others")),
    list, note, el("h4", { class: "ap-sub", text: "Landscape" }), land);
  box.append(btn, picker);
  const chipsBox = el("div", { id: "agent-chips", "aria-label": "Agent filter", hidden: "" });
  const anchor = $("#focus-chips") || $("#focus-box");
  if (anchor) anchor.after(box, chipsBox); else $("#filters")?.prepend(box, chipsBox);

  const isOpen = () => !picker.hidden;
  function open(viaKey) {
    if (isOpen()) return;
    picker.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.body.classList.add("agent-picking");
    render();
    if (viaKey || !matchMedia("(pointer: coarse)").matches) (list.querySelector(".arow") || btn).focus({ preventScroll: true });
  }
  function close(refocus) {
    if (!isOpen()) return;
    picker.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.body.classList.remove("agent-picking");
    if (refocus || picker.contains(document.activeElement)) btn.focus({ preventScroll: true });
  }

  function misTitle(n) {
    return n.mismatch.map((c) => `${c.kind === "coord" ? c.project + " coordinator" : c.key}: ${c.observed} running, recorded ${c.recorded}`).join("\n");
  }
  function row(o, sub) {
    const n = stats(o.items);
    const on = eff().has(o.key);
    return el("div", { class: "arow" + (sub ? " sub" : ""), role: "checkbox", tabindex: "0", "data-key": o.key, "aria-checked": String(on), style: `--c:${colorOf(o.harness)}`,
      title: `${o.items.length} active: ${n.working + n.waiting + n.idle} threads, ${n.coord} coordinator${n.coord === 1 ? "" : "s"}` },
      el("span", { class: "box", "aria-hidden": "true" }), sub ? null : el("span", { class: "dot" }),
      el("span", { class: "an", text: sub ? o.sub : o.harness }),
      n.mismatch.length ? el("span", { class: "amis", title: `${n.mismatch.length} differ from what was recorded:\n` + misTitle(n), text: "≠" + n.mismatch.length }) : null,
      el("span", { class: "ac", text: String(o.items.length) }));
  }
  function landTable(opts) {
    const cols = [["working", "Working"], ["waiting", "Waiting"], ["idle", "Idle"], ["coord", "Coord"], ["projects", "Projects"], ["cpu", "CPU"], ["ram", "RAM"]];
    const tr = (o, sub) => {
      const n = stats(o.items);
      const v = { working: dash0(n.working), waiting: dash0(n.waiting), idle: dash0(n.idle), coord: dash0(n.coord), projects: dash0(n.projects.size),
        cpu: n.cpu == null ? (n.ram ? "…" : "–") : Math.round(n.cpu) + "%", ram: bytes(n.ram) };
      return el("tr", { "data-key": o.key, class: (sub ? "sub" : "") + (eff().has(o.key) ? " on" : ""), tabindex: "0", title: `Show only ${labelOf(o.key)}`,
        onclick: () => set([o.key]), onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); set([o.key]); } } },
        el("th", { scope: "row" }, sub ? o.sub : el("span", { class: "lh", style: `--c:${colorOf(o.harness)}` }, el("span", { class: "dot" }), o.harness),
          n.mismatch.length ? el("span", { class: "amis", title: misTitle(n), text: " ≠" + n.mismatch.length }) : null),
        ...cols.map(([k]) => el("td", { "data-col": k, text: v[k] })));
    };
    return el("table", { id: "ap-land", class: "ap-land" },
      el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "Agent" }), ...cols.map(([, l]) => el("th", { scope: "col", text: l })))),
      el("tbody", {}, ...opts.flatMap((o) => [tr(o, false), ...o.subs.map((s) => tr(s, true))])));
  }
  let listSig = "", landSig = "";
  function renderPicker() {
    const opts = options();
    const e = eff();
    const sig = JSON.stringify([opts.map((o) => [o.key, o.items.length, o.items.filter((c) => c.mismatch).map((c) => c.key), o.subs.map((s) => [s.key, s.items.length])]), [...e]]);
    if (sig !== listSig) {
      listSig = sig;
      const had = document.activeElement?.closest?.(".arow")?.dataset.key;
      list.replaceChildren(...(opts.length ? opts.flatMap((o) => [row(o, false), ...o.subs.map((s) => row(s, true))]) : [el("p", { class: "pp-note", text: "No active agents." })]));
      if (had) list.querySelector(`.arow[data-key="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
    }
    const lsig = JSON.stringify([sig, procs().filter((p) => p.key).map((p) => [p.key, p.rss, p.cpu == null ? null : Math.round(p.cpu)])]);
    if (lsig !== landSig) { landSig = lsig; land.replaceChildren(landTable(opts)); }
    fade.checked = !!window.dash?.fade?.();
    note.textContent = e.size ? `Showing ${summary()}; combines with the project focus` : "Nothing ticked: every agent shows";
  }
  function render() {
    const e = eff();
    const label = !e.size ? "All agents" : e.size === 1 ? labelOf([...e][0]) : `${e.size} agents`;
    if (btn.firstChild?.textContent !== label) btn.replaceChildren(el("span", { class: "fl", text: label }), el("span", { class: "caret", "aria-hidden": "true", text: "▾" }));
    btn.classList.toggle("on", e.size > 0);
    btn.setAttribute("aria-label", "Agent filter: " + (e.size ? summary() : "all agents") + ". Press A");
    const want = [...e].sort();
    if (chipsBox.dataset.k !== want.join(",")) {
      chipsBox.dataset.k = want.join(",");
      chipsBox.replaceChildren(...want.map((k) => el("span", { class: "achip", "data-key": k, style: `--c:${colorOf(k.split(":")[0])}` },
        el("span", { class: "dot" }), el("span", { class: "an", text: labelOf(k) }),
        el("button", { type: "button", class: "ax", title: "Remove from the agent filter", "aria-label": `Remove ${labelOf(k)} from the agent filter`, text: "×", onclick: () => toggle(k) }))));
    }
    chipsBox.hidden = !want.length;
    if (isOpen()) renderPicker();
  }

  btn.addEventListener("click", () => (isOpen() ? close() : open(false)));
  fade.addEventListener("change", () => window.dash?.setFade?.(fade.checked));
  list.addEventListener("click", (e) => { const r = e.target.closest(".arow"); if (r) toggle(r.dataset.key); });
  list.addEventListener("keydown", (e) => {
    const r = e.target.closest(".arow");
    if (!r) return;
    const rows = [...list.querySelectorAll(".arow")], i = rows.indexOf(r);
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(r.dataset.key); }
    else if (e.key === "o" || e.key === "O") { e.preventDefault(); set([r.dataset.key]); }
    else if (e.key === "ArrowDown") { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); rows[Math.max(0, i - 1)]?.focus(); }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
  }, true);
  document.addEventListener("pointerdown", (e) => { if (isOpen() && !e.target.closest("#agent-box")) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "a" || e.ctrlKey || e.altKey || e.metaKey || $("#dlg")?.open) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (document.querySelector("#voice-help:not([hidden]), #voice-settings:not([hidden])")) return;
    e.preventDefault();
    isOpen() ? close(true) : open(true);
  });
  if (urlSel != null) save(); // a bookmark's selection is the stored one now

  return { of, ofCoord, match, matchCoord, matchProject, matchKey, matchHarness, active, summary, set, toggle, render, keys: () => [...eff()] };
})();
