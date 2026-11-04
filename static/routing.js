// herdr-dash routing: the Routing window (an HDWin window). It edits the
// agent routing policy in routing.toml: per scope (global, a project, a
// thread) and per mode, an ordered list of candidates, reordered by drag or
// by the move buttons. A candidate is picked from a searchable list (a
// herdr-projects profile, or provider → model from the catalog, or
// "Other…" for an id the catalog does not know), then given a reasoning
// (effort) level and a context size from what that harness and model
// offer; both are stored and previewed, and apply when the launch hook
// lands. A scope
// without its own list shows the inherited one, read-only, with "Override
// here"; an override can be reset to inherited. Edits stay a local draft
// until Save, which sends a typed patch with the revision it started from;
// a save from a stale tab is refused and offers Reload. "Why this choice?"
// asks the server which candidate a new thread would get, from the saved
// policy and current usage. Saving writes the policy only: it never starts,
// stops or switches an agent.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const PROVIDER_LABEL = { claude: "Claude", codex: "Codex", opencode: "opencode" };

  let st = null; // GET /api/routing
  let edits = {}; // scope key -> { modes: { mode: list | null }, enabled: true | false | null }
  let scope = { kind: "global", project: "", thread: "" };
  let win = null, status = "", alert = null, focusKey = null, dragging = null, saving = false;
  const pv = { project: "", thread: "", mode: "coding", result: null, error: "" };

  const btn = el("button", { id: "routing-open", class: "tbtn", type: "button", title: "Agent routing: which model new threads get, and why", text: "Routing", onclick: () => openWin() });
  ($("#filters") || document.body).append(btn);

  // ---------------------------------------------------------------- model
  const keyOf = (s) => (s.kind === "global" ? "g" : s.kind === "project" ? `p:${s.project}` : `t:${s.project}/${s.thread}`);
  const chain = (s) => s.kind === "thread"
    ? [s, { kind: "project", project: s.project }, { kind: "global" }]
    : s.kind === "project" ? [s, { kind: "global" }] : [s];
  function serverScope(s) {
    const p = st?.policy;
    if (!p) return null;
    if (s.kind === "global") return p.global;
    const proj = p.projects?.[s.project];
    if (s.kind === "project") return proj || null;
    return proj?.threads?.[s.thread] || null;
  }
  const serverList = (s, mode) => { const l = serverScope(s)?.modes?.[mode]; return l?.length ? l : null; };
  function ownList(s, mode) {
    const e = edits[keyOf(s)];
    if (e?.modes && mode in e.modes) return e.modes[mode];
    return serverList(s, mode);
  }
  function effective(s, mode) {
    for (const c of chain(s)) {
      const l = ownList(c, mode);
      if (l?.length) return { list: l, from: c.kind, own: c === s };
    }
    return { list: [], from: "none", own: false };
  }
  const serverEnabled = (s) => serverScope(s)?.enabled ?? null;
  function ownEnabled(s) {
    const e = edits[keyOf(s)];
    return e && "enabled" in e ? e.enabled : serverEnabled(s);
  }
  function edit(s) { return (edits[keyOf(s)] ||= { scope: { ...s }, modes: {} }); }
  function setList(s, mode, list) {
    const e = edit(s);
    const next = list && list.length ? list : null;
    if (JSON.stringify(next) === JSON.stringify(serverList(s, mode))) delete e.modes[mode];
    else e.modes[mode] = next;
    status = "";
    render();
  }

  function ops() {
    const out = [];
    for (const e of Object.values(edits)) {
      const sc = e.scope.kind === "global" ? {} : e.scope.kind === "project" ? { project: e.scope.project } : { project: e.scope.project, thread: e.scope.thread };
      for (const [mode, list] of Object.entries(e.modes)) {
        if (JSON.stringify(list) === JSON.stringify(serverList(e.scope, mode))) continue;
        out.push(list ? { op: "set_mode", scope: sc, mode, candidates: list.map(wire) }
          : { op: "reset_mode", scope: sc, mode });
      }
      if ("enabled" in e && e.enabled !== serverEnabled(e.scope)) out.push({ op: "set_enabled", scope: sc, enabled: e.enabled });
    }
    return out;
  }
  const editable = () => st && st.valid && !st.read_only && !st.write_block;
  // wire is a candidate as the server stores it: unset fields left out.
  function wire({ provider, profile, model, effort, context }) {
    const c = { provider, profile };
    if (model) c.model = model;
    if (effort) c.effort = effort;
    if (context) c.context = context;
    return c;
  }

  // ---------------------------------------------------------------- catalog
  const ckey = (c) => `${c.profile}|${c.model || ""}`;
  const harness = (id) => (st?.catalog || []).find((h) => h.id === id);
  const profileOf = (name) => (st?.profiles || []).find((p) => p.name === name);
  const providerOfAgent = (agent) => (st?.providers || []).find((p) => p.agent === agent)?.id || "";
  const ctxLabel = (n) => n >= 1e6 ? (n % 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${n / 1e6}M`) : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  const modelInfo = (provider, id) => (id ? harness(provider)?.models.find((m) => m.id === id) : null) || null;
  const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
  // What a candidate runs: its own model, else its profile's.
  function describe(c) {
    const p = profileOf(c.profile);
    const id = c.model || p?.model || "";
    const m = modelInfo(c.provider, id);
    const label = m?.label || id || `${PROVIDER_LABEL[c.provider] || c.provider} default model`;
    const raw = c.model ? `${c.profile} · ${c.model}` : `profile ${c.profile}${p?.model ? ` · ${p.model}` : ""}`;
    return { id, model: m, label, raw, profile: p, efforts: harness(c.provider)?.efforts || [] };
  }
  const settingsText = (c) => [c.effort ? `reasoning ${c.effort}` : "", c.context ? `${ctxLabel(c.context)} context` : ""].filter(Boolean).join(" · ");

  // ---------------------------------------------------------------- usage
  const ago = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  };
  const applies = (w, model) => {
    const i = w.label.indexOf(" · ");
    return i < 0 || !model || model.toLowerCase().includes(w.label.slice(i + 3).trim().toLowerCase());
  };
  function modelOf(c) {
    if (c.model) return c.model;
    return (st?.profiles || []).find((p) => p.name === c.profile)?.model || "";
  }
  // usage is what the card shows; the server's preview is what decides.
  function usage(c) {
    const u = (st?.providers || []).find((p) => p.id === c.provider)?.usage;
    const set = st?.usage_settings || { max_age_seconds: 900, avoid_at_percent: 90 };
    if (!u) return { level: "unknown", text: "Usage unknown: skipped" };
    if (u.status === "disabled") return { level: "unknown", text: `Usage not read${u.reason ? ` (${u.reason})` : ""}: skipped` };
    if (c.provider === "opencode") {
      const m = modelOf(c);
      if (u.metered) return { level: "bad", text: "Metered provider (per-token cost): not allowed" };
      if (!u.model) return { level: "unknown", text: "No opencode default model: skipped" };
      if (m && m !== u.model) return { level: "bad", text: `Runs ${m}; only the self-hosted default ${u.model} is allowed` };
      return { level: "ok", text: `Self-hosted ${u.model} · no quota meter · read ${ago(u.checked_at)} ago` };
    }
    if (u.status !== "ok") return { level: "unknown", text: `Unavailable${u.reason ? `: ${u.reason}` : ""}: skipped` };
    if (!u.as_of) return { level: "unknown", text: "No observation time: skipped" };
    const age = (Date.now() - Date.parse(u.as_of)) / 1000;
    if (u.stale || (u.valid_until && Date.parse(u.valid_until) <= Date.now()) || age > set.max_age_seconds)
      return { level: "unknown", text: `Stale: observed ${ago(u.as_of)} ago: skipped` };
    const wins = (u.windows || []).filter((w) => applies(w, modelOf(c)));
    if (!wins.length) return { level: "unknown", text: "No usage windows: skipped" };
    if (wins.some((w) => w.reset_passed || (w.resets_at && Date.parse(w.resets_at) <= Date.now())))
      return { level: "unknown", text: "A window has reset; new usage unknown: skipped" };
    const worst = Math.max(...wins.map((w) => w.used_percent));
    const parts = wins.map((w) => `${w.label} ${Math.round(w.used_percent)}%`).join(" · ");
    const level = worst >= set.avoid_at_percent ? "bad" : worst >= 70 ? "warn" : "ok";
    return { level, text: `${parts} used${level === "bad" ? ` · over ${set.avoid_at_percent}%: skipped` : ""} · observed ${ago(u.as_of)} ago` };
  }

  // ---------------------------------------------------------------- render
  const live = el("div", { class: "rt-live", "aria-live": "polite" });
  const say = (t) => { live.textContent = t; };

  // settings: the reasoning and context controls (or, read-only, text).
  function settings(c, i, list, mode, canEdit) {
    const d = describe(c);
    const set = (patch) => {
      const next = list.slice();
      next[i] = { ...c, ...patch };
      for (const k of Object.keys(patch)) if (!patch[k]) delete next[i][k];
      focusKey = Object.keys(patch)[0] === "effort" ? `effort:${mode}:${ckey(c)}` : `context:${mode}:${ckey(c)}`;
      setList(scope, mode, next);
    };
    const defEffort = d.profile?.effort || "";
    let effort;
    if (!d.efforts.length) effort = el("span", { class: "rt-effort-na", text: "No reasoning setting" });
    else if (!canEdit) effort = el("span", { class: "rt-effort-ro", text: `Reasoning: ${c.effort || (defEffort ? `${defEffort} (profile)` : "default")}` });
    else {
      effort = el("select", { class: "rt-effort", "data-focus": `effort:${mode}:${ckey(c)}`, "aria-label": `Reasoning for ${d.label}`, title: "Reasoning (effort). Applies when the launch hook lands." },
        el("option", { value: "", text: defEffort ? `Profile default (${defEffort})` : "Harness default" }),
        ...d.efforts.map((l) => el("option", { value: l, text: l, selected: l === c.effort })));
      effort.addEventListener("change", () => set({ effort: effort.value }));
    }
    const sizes = d.model?.contexts || [];
    let ctx;
    if (sizes.length > 1 && canEdit) {
      ctx = el("select", { class: "rt-context", "data-focus": `context:${mode}:${ckey(c)}`, "aria-label": `Context window for ${d.label}`, title: "Context window. Applies when the launch hook lands." },
        el("option", { value: "", text: `Default context (${ctxLabel(sizes[0])})` }),
        ...sizes.map((n) => el("option", { value: String(n), text: `${ctxLabel(n)} context`, selected: n === c.context })));
      ctx.addEventListener("change", () => set({ context: Number(ctx.value) || 0 }));
    } else {
      const n = c.context || sizes[0];
      ctx = el("span", { class: "rt-ctx-fixed", text: n ? `${ctxLabel(n)} context${sizes.length > 1 && !c.context ? " (default)" : ""}` : "Context unknown" });
    }
    return el("div", { class: "rt-settings" }, effort, ctx);
  }

  function card(c, i, list, mode, canEdit) {
    const u = usage(c);
    const d = describe(c);
    const move = (to, key) => {
      const next = list.slice();
      const [x] = next.splice(i, 1);
      next.splice(to, 0, x);
      focusKey = to === 0 || to === next.length - 1 ? null : key;
      // At an edge the pressed button turns off: focus its sibling.
      if (to === 0) focusKey = `down:${mode}:${ckey(c)}`;
      if (to === next.length - 1) focusKey = `up:${mode}:${ckey(c)}`;
      if (next.length === 1) focusKey = `del:${mode}:${ckey(c)}`;
      setList(scope, mode, next);
      say(`${d.label} moved to position ${to + 1}`);
    };
    const acts = canEdit ? el("div", { class: "rt-acts" },
      el("button", { type: "button", class: "rt-up", "data-focus": `up:${mode}:${ckey(c)}`, "aria-label": `Move ${d.label} (${c.profile}) up`, title: "Move up", text: "↑", disabled: i === 0, onclick: () => move(i - 1, `up:${mode}:${ckey(c)}`) }),
      el("button", { type: "button", class: "rt-down", "data-focus": `down:${mode}:${ckey(c)}`, "aria-label": `Move ${d.label} (${c.profile}) down`, title: "Move down", text: "↓", disabled: i === list.length - 1, onclick: () => move(i + 1, `down:${mode}:${ckey(c)}`) }),
      el("button", { type: "button", class: "rt-del", "data-focus": `del:${mode}:${ckey(c)}`, "aria-label": `Remove ${d.label} (${c.profile})`, title: "Remove", text: "×", onclick: () => {
        focusKey = `add:${mode}`;
        setList(scope, mode, list.filter((_, j) => j !== i));
        say(`${d.label} removed`);
      } })) : null;
    const li = el("li", { class: "rt-card" + (canEdit ? "" : " inherited"), "data-profile": c.profile, "data-model": c.model || "", "data-key": ckey(c), "data-provider": c.provider, draggable: canEdit ? "true" : null },
      canEdit ? el("span", { class: "rt-grip", "aria-hidden": "true", text: "⠿" }) : null,
      el("span", { class: "rt-pos", text: String(i + 1) }),
      el("div", { class: "rt-main" },
        el("div", { class: "rt-name" },
          el("span", { class: "rt-prov", "data-provider": c.provider, text: PROVIDER_LABEL[c.provider] || c.provider }),
          el("span", { class: "rt-label", text: d.label })),
        el("div", { class: "rt-raw mono", text: d.raw }),
        settings(c, i, list, mode, canEdit),
        el("div", { class: "rt-usage", "data-level": u.level, text: u.text })),
      acts);
    if (canEdit) {
      li.addEventListener("dragstart", (e) => {
        dragging = { mode, key: ckey(c) };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", ckey(c));
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => { dragging = null; li.classList.remove("dragging"); });
      li.addEventListener("dragover", (e) => {
        if (!dragging || dragging.mode !== mode) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        li.classList.toggle("drop-before", before);
        li.classList.toggle("drop-after", !before);
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
      li.addEventListener("drop", (e) => {
        if (!dragging || dragging.mode !== mode) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        const from = list.findIndex((x) => ckey(x) === dragging.key);
        if (from < 0) return;
        const next = list.slice();
        const [x] = next.splice(from, 1);
        let to = next.findIndex((y) => ckey(y) === ckey(c));
        if (!before) to++;
        next.splice(to, 0, x);
        dragging = null;
        setList(scope, mode, next);
        say(`${describe(x).label} moved to position ${to + 1}`);
      });
    }
    return li;
  }

  function addRow(mode, list) {
    const b = el("button", { type: "button", class: "tbtn rt-add-btn", id: `rt-add-${mode}`, "data-focus": `add:${mode}`, "aria-haspopup": "dialog",
      text: "+ Add candidate", onclick: () => openPicker(mode, list, b) });
    return el("div", { class: "rt-add" }, b);
  }

  // ---------------------------------------------------------------- picker
  // A searchable list: profiles first, then each harness's models, then
  // "Other…" per harness. A popover by its Add button; a sheet on a phone.
  let pick = null; // { mode, list, opener, root, q, ul, opts, active }
  function pickOptions(list) {
    const have = new Set(list.map(ckey));
    const opts = [];
    const routable = (st.profiles || []).filter((p) => providerOfAgent(p.agent));
    const odd = (st.profiles || []).filter((p) => !providerOfAgent(p.agent));
    if (routable.length || odd.length) opts.push({ group: "Profiles" });
    for (const p of [...routable, ...odd]) {
      const provider = providerOfAgent(p.agent);
      const c = { provider, profile: p.name };
      const why = !provider ? `${p.agent} is not routable` : have.has(ckey(c)) ? "in this list" : "";
      opts.push({ pick: `profile:${p.name}`, cand: provider ? c : null, why,
        label: p.label || p.name, raw: `profile ${p.name}${p.model ? ` · ${p.model}` : ""}${p.effort ? ` · ${p.effort}` : ""}`, sub: p.description || "",
        text: `${p.name} ${p.model || ""} ${p.label || ""} ${p.description || ""} ${p.agent}` });
    }
    for (const h of st.catalog || []) {
      opts.push({ group: h.label });
      const base = { provider: h.id, profile: h.id };
      opts.push({ pick: `model:${h.id}:`, cand: base, why: have.has(ckey(base)) ? "in this list" : "",
        label: `${h.label} default model`, raw: `profile ${h.id}`, text: `${h.id} ${h.label} default` });
      for (const m of h.models) {
        const c = { provider: h.id, profile: h.id, model: m.id };
        const ctx = m.contexts.length ? m.contexts.map(ctxLabel).join(" / ") : "context unknown";
        opts.push({ pick: `model:${h.id}:${m.id}`, cand: c, why: have.has(ckey(c)) ? "in this list" : "",
          label: m.label, raw: `${m.id} · ${ctx}`, text: `${h.id} ${h.label} ${m.id} ${m.label}` });
      }
      opts.push({ pick: `other:${h.id}`, other: h.id, label: `Other ${h.label} model…`, raw: "type a model id the list does not have", text: `other ${h.id} ${h.label}` });
    }
    return opts;
  }

  function openPicker(mode, list, opener) {
    closePicker(false);
    const label = (st.modes.find((m) => m.id === mode) || {}).label || mode;
    const sheet = innerWidth <= 700;
    const q = el("input", { id: "rt-pick-q", type: "search", role: "combobox", "aria-expanded": "true", "aria-controls": "rt-pick-list", "aria-autocomplete": "list",
      placeholder: "Search models and profiles", "aria-label": "Search models and profiles", autocomplete: "off", spellcheck: "false" });
    const ul = el("ul", { id: "rt-pick-list", role: "listbox", "aria-label": `Candidates for ${label}` });
    const opts = pickOptions(list);
    let n = 0;
    for (const o of opts) {
      if (o.group) { o.node = el("li", { class: "rt-pick-group", role: "presentation", text: o.group }); ul.append(o.node); continue; }
      o.node = el("li", { class: "rt-opt", role: "option", id: `rt-opt-${n++}`, "data-pick": o.pick, "aria-disabled": o.why ? "true" : null, "aria-selected": "false",
        onclick: () => choose(o) },
        el("span", { class: "rt-opt-label", text: o.label }),
        el("span", { class: "rt-opt-id mono", text: o.raw + (o.why ? ` · ${o.why}` : "") }),
        o.sub ? el("span", { class: "rt-opt-sub", text: o.sub }) : null);
      o.node.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the search box
      o.text = `${o.text} ${o.label} ${o.raw}`.toLowerCase();
      ul.append(o.node);
    }
    const other = el("form", { id: "rt-other", hidden: true, novalidate: true });
    const root = el("div", { id: "rt-pick", class: "rt-pick" + (sheet ? " sheet" : ""), role: "dialog", "aria-modal": "true", "aria-label": `Add a ${label} candidate` },
      el("div", { class: "rt-pick-head" },
        el("strong", { text: `Add to ${label}` }),
        el("button", { type: "button", class: "rt-pick-x", "aria-label": "Close", text: "×", onclick: () => closePicker(true) })),
      q, ul, other,
      el("p", { class: "rt-hint", text: "Reasoning and context are set on the card after you pick; they apply when the launch hook lands." }));
    const back = el("div", { class: "rt-pick-back" + (sheet ? " sheet" : ""), onclick: () => closePicker(true) });
    document.body.append(back, root);
    pick = { mode, list, opener, root, back, q, ul, opts, other, active: null };
    q.addEventListener("input", filter);
    q.addEventListener("keydown", pickKey);
    root.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePicker(true); } });
    filter();
    place();
    q.focus();
  }

  function place() {
    if (!pick) return;
    const r = pick.root;
    if (r.classList.contains("sheet")) return;
    const a = pick.opener.getBoundingClientRect();
    const w = Math.min(420, innerWidth - 16);
    r.style.width = w + "px";
    r.style.left = Math.max(8, Math.min(a.left, innerWidth - w - 8)) + "px";
    const below = innerHeight - a.bottom - 12, above = a.top - 12;
    // Below the button when there is room for a useful list, else above.
    const down = below >= 300 || below >= above;
    const h = Math.min(460, down ? below : above);
    r.style.maxHeight = h + "px";
    r.style.top = (down ? a.bottom + 4 : Math.max(8, a.top - 4 - Math.min(h, r.offsetHeight))) + "px";
  }

  const visible = () => pick.opts.filter((o) => o.pick && !o.node.hidden);
  const usable = () => visible().filter((o) => !o.why);
  function setActive(o) {
    if (!pick) return;
    if (pick.active) { pick.active.node.classList.remove("active"); pick.active.node.setAttribute("aria-selected", "false"); }
    pick.active = o || null;
    if (o) {
      o.node.classList.add("active");
      o.node.setAttribute("aria-selected", "true");
      pick.q.setAttribute("aria-activedescendant", o.node.id);
      o.node.scrollIntoView({ block: "nearest" });
    } else pick.q.removeAttribute("aria-activedescendant");
  }
  function filter() {
    const terms = pick.q.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const o of pick.opts) if (o.pick) o.node.hidden = !terms.every((t) => o.text.includes(t));
    // Nothing matches: every "Other…" stays, so what was typed is not lost.
    if (!pick.opts.some((o) => o.pick && !o.other && !o.node.hidden)) for (const o of pick.opts) if (o.other) o.node.hidden = false;
    let group = null, shown = 0;
    for (const o of pick.opts) {
      if (o.group) {
        if (group) group.node.hidden = !shown;
        group = o; shown = 0;
      } else if (!o.node.hidden) shown++;
    }
    if (group) group.node.hidden = !shown;
    setActive(usable()[0]);
  }
  function pickKey(e) {
    const list = usable();
    const i = list.indexOf(pick.active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!list.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(list[(i + step + list.length) % list.length] || list[0]);
    } else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setActive(list[0]); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setActive(list[list.length - 1]); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (pick.active) choose(pick.active);
    }
  }

  function addCand(c) {
    const { mode, list } = pick;
    if (list.some((x) => ckey(x) === ckey(c))) return `${describe(c).label} (${c.profile}) is already in the list`;
    closePicker(false);
    focusKey = `effort:${mode}:${ckey(c)}`;
    setList(scope, mode, [...list, c]);
    // No effort control (opencode): focus the Add button again instead.
    if (!win.body.querySelector(`[data-focus="${CSS.escape(`effort:${mode}:${ckey(c)}`)}"]`)) win.body.querySelector(`[data-focus="add:${mode}"]`)?.focus();
    say(`${describe(c).label} added at position ${list.length + 1}`);
    return "";
  }
  function choose(o) {
    if (o.why) return;
    if (o.other) return otherForm(o.other);
    addCand({ ...o.cand });
  }

  // otherForm: a model id typed by hand for one harness, with the profile
  // to run it under picked from a list. Checked here and by the server.
  function otherForm(provider) {
    const h = harness(provider);
    const agent = (st.providers || []).find((p) => p.id === provider)?.agent || provider;
    const profiles = [provider, ...(st.profiles || []).filter((p) => p.agent === agent && p.name !== provider).map((p) => p.name)];
    const model = el("input", { id: "rt-other-model", placeholder: provider === "opencode" ? "provider/model" : "model id", "aria-label": `${h.label} model id`, autocomplete: "off", spellcheck: "false",
      value: pick.q.value.trim() });
    const prof = el("select", { id: "rt-other-profile", "aria-label": "Run it under profile" }, ...profiles.map((n) => el("option", { value: n, text: n })));
    const msg = el("p", { id: "rt-other-msg", class: "rt-add-msg", role: "status" });
    const f = pick.other;
    f.replaceChildren(
      el("p", { class: "rt-other-head", text: `Other ${h.label} model` }),
      el("label", {}, el("span", { text: "Model id" }), model),
      el("label", {}, el("span", { text: "Profile" }), prof),
      el("div", { class: "rt-other-acts" },
        el("button", { type: "button", class: "tbtn", text: "Back", onclick: () => { f.hidden = true; pick.ul.hidden = false; pick.q.hidden = false; pick.q.focus(); } }),
        el("button", { type: "submit", id: "rt-other-add", class: "tbtn primary", text: "Add" })),
      msg);
    f.onsubmit = (e) => {
      e.preventDefault();
      const id = model.value.trim();
      if (!MODEL_RE.test(id)) { msg.textContent = "Enter a model id: letters, digits and . _ : / @ + -, no spaces, at most 128 characters."; model.focus(); return; }
      const err = addCand({ provider, profile: prof.value, model: id });
      if (err) { msg.textContent = err; model.focus(); }
    };
    pick.ul.hidden = true;
    pick.q.hidden = true;
    f.hidden = false;
    model.focus();
  }

  function closePicker(refocus) {
    if (!pick) return;
    const { root, back, opener, mode } = pick;
    root.remove();
    back.remove();
    pick = null;
    if (refocus) (opener.isConnected ? opener : win?.body.querySelector(`[data-focus="add:${mode}"]`))?.focus();
  }
  addEventListener("resize", () => place());

  const FROM = { global: "global", project: "project", thread: "thread" };
  function modeSection(m) {
    const eff = effective(scope, m.id);
    const can = editable();
    const own = eff.own;
    let src;
    if (!st.valid) src = "Policy unreadable";
    else if (own) src = "Set here";
    else if (eff.from !== "none") src = `Inherited from ${FROM[eff.from]}`;
    else src = "No list: new threads use the project's default profile";
    const tools = [];
    if (can && !own && eff.from !== "none") {
      tools.push(el("button", { type: "button", class: "tbtn rt-override", "data-focus": `override:${m.id}`, text: "Override here",
        title: "Copy the inherited list into this scope to change it here", onclick: () => { focusKey = `reset:${m.id}`; setList(scope, m.id, eff.list.map((c) => ({ ...c }))); } }));
    }
    if (can && own) {
      tools.push(el("button", { type: "button", class: "tbtn rt-reset", "data-focus": `reset:${m.id}`,
        text: scope.kind === "global" ? "Remove list" : "Reset to inherited",
        title: scope.kind === "global" ? "No global list: modes without a project or thread list use legacy launches" : "Drop this scope's list; the one above applies again",
        onclick: () => { focusKey = `override:${m.id}`; setList(scope, m.id, null); } }));
    }
    const ol = el("ol", { class: "rt-list" + (own ? "" : " inherited"), "aria-label": `${m.label} candidates, in order` },
      ...eff.list.map((c, i) => card(c, i, eff.list, m.id, can && own)));
    return el("section", { class: "rt-mode", "data-mode": m.id },
      el("div", { class: "rt-mode-head" }, el("h3", { text: m.label }), el("span", { class: "rt-src", "data-own": own ? "1" : "0", text: src }), ...tools),
      eff.list.length ? ol : null,
      can && (own || eff.from === "none") ? addRow(m.id, own ? eff.list : []) : null,
      eff.list.some((c) => c.effort || c.context) || (can && own) ? el("p", { class: "rt-hint rt-applies", text: "Reasoning and context are saved and shown in the preview; each applies when the launch hook lands." }) : null);
  }

  function enabledRow() {
    if (scope.kind === "thread") return el("p", { class: "rt-hint", text: "Routing is switched on or off per project or globally; a thread can override lists only." });
    const own = ownEnabled(scope);
    const inherited = scope.kind === "project" ? (serverEnabled({ kind: "global" }) ?? false) : false;
    const opts = scope.kind === "global"
      ? [["off", "Off: new threads use their project's default profile"], ["on", "On"]]
      : [["inherit", `Inherit (global: ${inherited ? "on" : "off"})`], ["on", "On for this project"], ["off", "Off for this project"]];
    const val = own === true ? "on" : own === false ? "off" : scope.kind === "global" ? "off" : "inherit";
    const sel = el("select", { id: "rt-enabled", "data-focus": "id:rt-enabled", "aria-label": "Routing", disabled: !editable() },
      ...opts.map(([v, t]) => el("option", { value: v, text: t, selected: v === val })));
    sel.addEventListener("change", () => {
      const e = edit(scope);
      let next = sel.value === "on" ? true : sel.value === "off" ? false : null;
      if (scope.kind === "global" && next === false && serverEnabled(scope) == null) next = null;
      if (next === serverEnabled(scope)) delete e.enabled; else e.enabled = next;
      focusKey = "id:rt-enabled";
      status = "";
      render();
    });
    return el("label", { class: "rt-enabled" }, el("span", { text: "Routing" }), sel);
  }

  function scopePicker() {
    if (scope.kind === "global") return null;
    const projects = st.projects || [];
    const ps = el("select", { id: "rt-project", "data-focus": "id:rt-project", "aria-label": "Project" },
      ...projects.map((p) => el("option", { value: p.slug, text: p.name ? `${p.name} (${p.slug})` : p.slug, selected: p.slug === scope.project })));
    ps.addEventListener("change", () => {
      scope.project = ps.value;
      scope.thread = (projects.find((p) => p.slug === ps.value)?.threads || [])[0]?.id || "";
      pv.project = ps.value;
      focusKey = "id:rt-project";
      render();
    });
    const kids = [el("label", {}, el("span", { text: "Project" }), ps)];
    const proj = projects.find((p) => p.slug === scope.project);
    if (proj) kids.push(el("span", { class: "rt-hint", text: `Default profile (PROJECT.md): ${proj.legacy_profile || "herdr-projects default"}` }));
    if (scope.kind === "thread") {
      const threads = proj?.threads || [];
      const ts = el("select", { id: "rt-thread", "data-focus": "id:rt-thread", "aria-label": "Thread" },
        ...threads.map((t) => el("option", { value: t.id, text: `${t.id} ${t.title || ""}`.trim(), selected: t.id === scope.thread })));
      ts.addEventListener("change", () => { scope.thread = ts.value; pv.thread = ts.value; focusKey = "id:rt-thread"; render(); });
      kids.push(el("label", {}, el("span", { text: "Thread" }), ts));
      if (!threads.length) kids.push(el("span", { class: "rt-hint", text: "No threads in this project yet." }));
    }
    return el("div", { class: "rt-picker" }, ...kids);
  }

  function previewBox() {
    const projects = st.projects || [];
    if (!pv.project) pv.project = scope.project || projects[0]?.slug || "";
    const proj = projects.find((p) => p.slug === pv.project);
    const ps = el("select", { id: "rt-pv-project", "data-focus": "id:rt-pv-project", "aria-label": "Preview project" },
      ...projects.map((p) => el("option", { value: p.slug, text: p.slug, selected: p.slug === pv.project })));
    ps.addEventListener("change", () => { pv.project = ps.value; pv.thread = ""; pv.result = null; focusKey = "id:rt-pv-project"; render(); });
    const ms = el("select", { id: "rt-pv-mode", "data-focus": "id:rt-pv-mode", "aria-label": "Preview mode" },
      ...st.modes.map((m) => el("option", { value: m.id, text: m.label, selected: m.id === pv.mode })));
    ms.addEventListener("change", () => { pv.mode = ms.value; pv.result = null; focusKey = "id:rt-pv-mode"; render(); });
    const ts = el("select", { id: "rt-pv-thread", "data-focus": "id:rt-pv-thread", "aria-label": "Preview thread" },
      el("option", { value: "", text: "A new thread", selected: !pv.thread }),
      ...(proj?.threads || []).map((t) => el("option", { value: t.id, text: `${t.id} (next launch)`, selected: t.id === pv.thread })));
    ts.addEventListener("change", () => { pv.thread = ts.value; pv.result = null; focusKey = "id:rt-pv-thread"; render(); });
    const why = el("button", { type: "button", id: "rt-why", class: "tbtn primary", "data-focus": "id:rt-why", text: "Why this choice?", onclick: runPreview });
    const out = el("div", { id: "rt-pv", "aria-live": "polite" });
    if (pv.error) out.append(el("p", { class: "rt-pv-err", role: "alert", text: pv.error }));
    const d = pv.result;
    if (d) {
      const head = {
        select: `Would choose ${d.selected?.provider}/${d.selected?.profile}${d.selected && settingsText(d.selected) ? ` (${settingsText(d.selected)})` : ""}`,
        queue: "Would wait: nothing qualifies",
        legacy: `Legacy launch: ${d.legacy_profile || "the project's default profile"}`,
        invalid: "Blocked: routing.toml is invalid",
      }[d.outcome] || d.outcome;
      out.append(
        el("p", { class: "rt-pv-outcome", "data-outcome": d.outcome, text: head }),
        el("p", { class: "rt-pv-reason", text: d.reason }),
        el("p", { class: "rt-hint", text: `${d.list_from === "none" ? "no" : d.list_from} list · routing ${d.enabled ? "on" : "off"} (${d.enabled_from}) · saved policy ${d.revision}` }));
      if (d.would_select) out.append(el("p", { class: "rt-hint", text: `Once routing is on it would choose ${d.would_select.provider}/${d.would_select.profile}.` }));
      if (d.candidates.length) {
        out.append(el("ol", { class: "rt-pv-list" }, ...d.candidates.map((c) => el("li", { class: "rt-pv-cand", "data-profile": c.profile, "data-status": c.status },
          el("span", { class: "rt-chip", "data-status": c.status, text: c.status.replace("_", " ") }),
          el("span", { class: "mono", text: `${c.provider}/${c.profile}${c.model ? ` · ${c.model}` : ""}` }),
          settingsText(c) ? el("span", { class: "rt-pv-set", text: settingsText(c) }) : null,
          el("span", { class: "rt-pv-why", text: c.reason })))));
        if (d.candidates.some((c) => c.effort || c.context)) out.append(el("p", { class: "rt-hint", text: "Reasoning and context: saved, not applied yet; each applies when the launch hook lands." }));
      }
    }
    return el("section", { class: "rt-preview" },
      el("h3", { text: "Why this choice?" }),
      el("p", { class: "rt-hint", text: "Asks the server, with the saved policy and current usage. Unsaved edits are not included." }),
      el("div", { class: "rt-pv-row" }, ps, ms, ts, why), out);
  }

  async function runPreview() {
    pv.error = "";
    try {
      const r = await fetch("/api/routing/preview", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pv.thread ? { project: pv.project, thread: pv.thread, mode: pv.mode } : { project: pv.project, mode: pv.mode }) });
      const j = await r.json();
      if (!r.ok) { pv.result = null; pv.error = j.error || `HTTP ${r.status}`; } else pv.result = j;
    } catch (e) { pv.result = null; pv.error = "Preview failed: " + e.message; }
    focusKey = "id:rt-why";
    render();
  }

  function render() {
    if (!win || !st) return;
    const body = win.body;
    const active = document.activeElement;
    if (!focusKey && active && body.contains(active)) focusKey = active.dataset.focus || null;
    const scrollTop = body.scrollTop;
    const pending = ops();
    const can = editable();
    const tabs = el("div", { class: "rt-tabs", role: "tablist", "aria-label": "Scope" },
      ...[["global", "Global"], ["project", "Project"], ["thread", "Thread"]].map(([k, t]) => el("button", {
        type: "button", role: "tab", "data-scope": k, "data-focus": `tab:${k}`, "aria-selected": String(scope.kind === k), class: "rt-tab", text: t,
        onclick: () => {
          scope.kind = k;
          const projects = st.projects || [];
          if (k !== "global" && !scope.project) scope.project = projects[0]?.slug || "";
          if (k === "thread" && !scope.thread) scope.thread = (projects.find((p) => p.slug === scope.project)?.threads || [])[0]?.id || "";
          focusKey = `tab:${k}`;
          render();
        } })));
    const errs = el("div", { id: "rt-errors", class: "rt-errors", role: "alert", hidden: st.valid && !st.problem ? true : null },
      el("p", { text: st.problem || "routing.toml is invalid; fix it by hand. Saving is off until then, and routed launches would be blocked." }),
      el("ul", {}, ...(st.errors || []).map((e) => el("li", {}, el("code", { text: e.field }), " " + e.message))));
    const notes = [];
    if (st.read_only) notes.push("This dashboard is read-only: the policy can be viewed and previewed, not saved.");
    if (st.write_block) notes.push(st.write_block);
    for (const w of st.warnings || []) notes.push(`${w.field}: ${w.message}`);
    const alertBox = el("div", { id: "rt-alert", class: "rt-alert", role: "alert", hidden: alert ? null : true },
      el("span", { text: alert?.text || "" }),
      alert?.reload ? el("button", { type: "button", id: "rt-reload", class: "tbtn", text: "Reload", onclick: reload }) : null);
    const statusText = pending.length ? `Unsaved changes (${pending.length})` : status || "No unsaved changes";
    const foot = el("div", { class: "rt-foot" },
      el("button", { type: "button", id: "rt-save", class: "tbtn primary", "data-focus": "id:rt-save", text: saving ? "Saving…" : "Save", disabled: !can || !pending.length || saving, onclick: save }),
      el("button", { type: "button", id: "rt-discard", class: "tbtn", "data-focus": "id:rt-discard", text: "Discard", disabled: !pending.length || saving, onclick: () => { edits = {}; status = "Changes discarded"; alert = null; render(); } }),
      el("span", { id: "rt-status", class: "rt-status", role: "status", "data-dirty": pending.length ? "1" : "0", text: statusText }));
    // replaceChildren would print a null as text: drop the absent parts.
    body.replaceChildren(...[
      el("p", { class: "rt-file" }, "Policy ", el("code", { text: st.path }), st.exists ? ` · ${st.revision}` : " · not created yet (legacy launches)"),
      el("p", { class: "rt-note", text: st.enforcement?.threads || "" }),
      errs,
      notes.length ? el("ul", { class: "rt-notes" }, ...notes.map((n) => el("li", { text: n }))) : null,
      tabs,
      el("div", { class: "rt-scope", role: "tabpanel" }, scopePicker(), enabledRow(), ...st.modes.map(modeSection)),
      alertBox,
      foot,
      previewBox(),
      el("p", { class: "rt-hint rt-foot-note", text: `${st.enforcement?.helpers || ""} ${st.enforcement?.subagents || ""}`.trim() }),
      live].filter((x) => x != null));
    body.scrollTop = scrollTop;
    if (focusKey) {
      const target = body.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
      if (target && !target.disabled) target.focus({ preventScroll: true });
      focusKey = null;
    }
    fit(); // added cards make it taller: keep the foot on screen
  }

  async function load() {
    const r = await fetch("/api/routing", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    st = await r.json();
  }

  async function save() {
    const list = ops();
    if (!list.length || saving) return;
    saving = true;
    alert = null;
    render();
    try {
      const r = await fetch("/api/routing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: st.revision, ops: list }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        st = j.state;
        edits = {};
        status = `Saved · ${st.revision}. No agent was started, stopped or switched.`;
      } else if (r.status === 409 && j.code === "conflict") {
        alert = { text: j.error, reload: true };
      } else {
        alert = { text: j.error || `Save failed (HTTP ${r.status})` };
      }
    } catch (e) {
      alert = { text: "Save failed: " + e.message };
    }
    saving = false;
    focusKey = alert?.reload ? null : "id:rt-save";
    render();
    if (alert?.reload) win?.body.querySelector("#rt-reload")?.focus();
  }

  async function reload() {
    try {
      await load();
      edits = {};
      alert = null;
      status = `Reloaded · ${st.revision}`;
    } catch (e) {
      alert = { text: "Reload failed: " + e.message, reload: true };
    }
    render();
  }

  async function openWin() {
    const existed = HDWin.has("routing");
    win = HDWin.open("routing", { title: "Agent routing", short: "Routing", cls: "rt-win", width: 620, persist: true,
      build: (body) => body.append(el("p", { class: "rt-hint", text: "Loading…" })),
      onClose: () => { closePicker(false); win = null; } });
    if (existed && st) return;
    try {
      // A fresh open shows the file as it is now; a draft survives only
      // while the window stays open.
      edits = {};
      alert = null;
      status = "";
      await load();
    } catch (e) {
      win.body.replaceChildren(el("p", { class: "rt-errors", role: "alert", text: "Could not load the routing policy: " + e.message }));
      return;
    }
    render();
    fit();
  }

  // A window grown taller than the room below it would hang off the
  // screen: lift it to fit.
  function fit() {
    const w = HDWin.get("routing");
    if (!w || w.dock || innerWidth <= 700) return;
    const r = w.el.getBoundingClientRect();
    if (r.bottom <= innerHeight - 8) return;
    w.y = Math.max(8, Math.round(innerHeight - 8 - r.height));
    w.el.style.top = w.y + "px";
  }

  window.HDRouting = { open: openWin };
  // Open (floating or docked) at the last visit: open again, in place.
  if (window.HDWin?.saved?.().includes("routing")) openWin();
})();
