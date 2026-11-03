// herdr-dash routing: the Routing window (an HDWin window). It edits the
// agent routing policy in routing.toml: per scope (global, a project, a
// thread) and per mode, an ordered list of candidates (provider + profile,
// optionally a model), reordered by drag or by the move buttons. A scope
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
        out.push(list ? { op: "set_mode", scope: sc, mode, candidates: list.map(({ provider, profile, model }) => (model ? { provider, profile, model } : { provider, profile })) }
          : { op: "reset_mode", scope: sc, mode });
      }
      if ("enabled" in e && e.enabled !== serverEnabled(e.scope)) out.push({ op: "set_enabled", scope: sc, enabled: e.enabled });
    }
    return out;
  }
  const editable = () => st && st.valid && !st.read_only && !st.write_block;

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

  function card(c, i, list, mode, canEdit) {
    const u = usage(c);
    const move = (to, key) => {
      const next = list.slice();
      const [x] = next.splice(i, 1);
      next.splice(to, 0, x);
      focusKey = to === 0 || to === next.length - 1 ? null : key;
      // At an edge the pressed button turns off: focus its sibling.
      if (to === 0) focusKey = `down:${mode}:${c.profile}`;
      if (to === next.length - 1) focusKey = `up:${mode}:${c.profile}`;
      if (next.length === 1) focusKey = `del:${mode}:${c.profile}`;
      setList(scope, mode, next);
      say(`${c.profile} moved to position ${to + 1}`);
    };
    const acts = canEdit ? el("div", { class: "rt-acts" },
      el("button", { type: "button", class: "rt-up", "data-focus": `up:${mode}:${c.profile}`, "aria-label": `Move ${c.profile} up`, title: "Move up", text: "↑", disabled: i === 0, onclick: () => move(i - 1, `up:${mode}:${c.profile}`) }),
      el("button", { type: "button", class: "rt-down", "data-focus": `down:${mode}:${c.profile}`, "aria-label": `Move ${c.profile} down`, title: "Move down", text: "↓", disabled: i === list.length - 1, onclick: () => move(i + 1, `down:${mode}:${c.profile}`) }),
      el("button", { type: "button", class: "rt-del", "data-focus": `del:${mode}:${c.profile}`, "aria-label": `Remove ${c.profile}`, title: "Remove", text: "×", onclick: () => {
        focusKey = `id:rt-add-profile-${mode}`;
        setList(scope, mode, list.filter((_, j) => j !== i));
        say(`${c.profile} removed`);
      } })) : null;
    const li = el("li", { class: "rt-card" + (canEdit ? "" : " inherited"), "data-profile": c.profile, "data-provider": c.provider, draggable: canEdit ? "true" : null },
      canEdit ? el("span", { class: "rt-grip", "aria-hidden": "true", text: "⠿" }) : null,
      el("span", { class: "rt-pos", text: String(i + 1) }),
      el("div", { class: "rt-main" },
        el("div", { class: "rt-name" },
          el("span", { class: "rt-prov", "data-provider": c.provider, text: PROVIDER_LABEL[c.provider] || c.provider }),
          el("span", { class: "rt-prof mono", text: c.profile }),
          c.model ? el("span", { class: "rt-model mono", text: c.model }) : null),
        el("div", { class: "rt-usage", "data-level": u.level, text: u.text })),
      acts);
    if (canEdit) {
      li.addEventListener("dragstart", (e) => {
        dragging = { mode, profile: c.profile };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", c.profile);
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
        const from = list.findIndex((x) => x.profile === dragging.profile);
        if (from < 0) return;
        const next = list.slice();
        const [x] = next.splice(from, 1);
        let to = next.findIndex((y) => y.profile === c.profile);
        if (!before) to++;
        next.splice(to, 0, x);
        dragging = null;
        setList(scope, mode, next);
        say(`${x.profile} moved to position ${to + 1}`);
      });
    }
    return li;
  }

  function addRow(mode, list) {
    const prov = el("select", { class: "rt-add-provider", "aria-label": "Provider" },
      ...(st.providers || []).map((p) => el("option", { value: p.id, text: p.label })));
    const dl = `rt-profiles-${mode}`;
    const prof = el("input", { class: "rt-add-profile", id: `rt-add-profile-${mode}`, "data-focus": `id:rt-add-profile-${mode}`, list: dl, placeholder: "profile", "aria-label": "Profile", autocomplete: "off", spellcheck: "false" });
    const model = el("input", { class: "rt-add-model", placeholder: "model (optional)", "aria-label": "Model (optional)", autocomplete: "off", spellcheck: "false" });
    const msg = el("span", { class: "rt-add-msg", role: "status" });
    const options = () => {
      const agent = prov.value;
      const names = new Set([agent, ...(st.profiles || []).filter((p) => !p.agent || p.agent === agent).map((p) => p.name)]);
      return [...names].map((n) => el("option", { value: n }));
    };
    const datalist = el("datalist", { id: dl }, ...options());
    prov.addEventListener("change", () => datalist.replaceChildren(...options()));
    const add = () => {
      const c = { provider: prov.value, profile: prof.value.trim() };
      if (model.value.trim()) c.model = model.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.profile)) { msg.textContent = "Enter a profile name"; prof.focus(); return; }
      if (list.some((x) => x.profile === c.profile)) { msg.textContent = `${c.profile} is already in the list`; prof.focus(); return; }
      focusKey = `id:rt-add-profile-${mode}`;
      setList(scope, mode, [...list, c]);
      say(`${c.profile} added at position ${list.length + 1}`);
    };
    prof.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    return el("div", { class: "rt-add" }, prov, prof, datalist, model,
      el("button", { type: "button", class: "tbtn rt-add-btn", text: "Add", onclick: add }), msg);
  }

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
      can && (own || eff.from === "none") ? addRow(m.id, own ? eff.list : []) : null);
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
        select: `Would choose ${d.selected?.provider}/${d.selected?.profile}`,
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
          el("span", { class: "mono", text: `${c.provider}/${c.profile}` }),
          el("span", { class: "rt-pv-why", text: c.reason })))));
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
    body.replaceChildren(
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
      live);
    body.scrollTop = scrollTop;
    if (focusKey) {
      const target = body.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
      if (target && !target.disabled) target.focus({ preventScroll: true });
      focusKey = null;
    }
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
      onClose: () => { win = null; } });
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

  // A tall window opened low would hang off the screen: lift it to fit.
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
