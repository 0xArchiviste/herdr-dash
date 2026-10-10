// herdr-dash frontend: a live force graph of projects (hubs) and threads.
(() => {
  "use strict";
  const STATES = {
    working: { label: "Working", color: "#98bc37" },
    waiting: { label: "Waiting on you", color: "#fbb829" },
    blocked: { label: "Blocked", color: "#ef2f27" },
    review: { label: "Ready for review", color: "#68a8e4" },
    landing: { label: "Landing", color: "#2be4d0" },
    idle: { label: "Idle", color: "#baa67f" },
    resolved: { label: "Resolved", color: "#4e4e4e" },
  };
  // A coordinator's state: herdr's live status, plus herdr-projects' "needs you".
  const COORD = { blocked: "Blocked", waiting: "Waiting on you", working: "Working", idle: "Idle", none: "No live pane" };
  const ORDER = ["blocked", "waiting", "review", "landing", "working", "idle", "resolved"];
  const HUB_COLORS = ["#ff8700", "#ff5c8f", "#2be4d0", "#fed06e", "#68a8e4", "#98bc37", "#e02c6d", "#0aaeb3", "#f75341", "#fce8c3"];
  // Viewer's local time zone, labelled (e.g. "Oct 10, 5:00 PM EDT").
  const TIME_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
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

  let state = { projects: [], threads: [], errors: [] };
  let selected = null;
  let detailTimer = null;
  const filters = JSON.parse(localStorage.getItem("hd-filters") || "{}");
  const saveFilters = () => localStorage.setItem("hd-filters", JSON.stringify(filters));

  // ---------------------------------------------------------------- time
  function ago(iso) {
    if (!iso) return "—";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  const nyTime = (iso) => (iso ? TIME_FMT.format(new Date(iso)) : "—");
  const ageSec = (t) => (t.last_activity ? (Date.now() - Date.parse(t.last_activity)) / 1000 : 1e9);

  // ---------------------------------------------------------------- filters
  function visible(t) {
    if (filters.project && t.project !== filters.project) return false;
    if (filters.state === "needs" ? !t.needs_you : filters.state && t.state !== filters.state) return false;
    if (filters.window && ageSec(t) > +filters.window) return false;
    if (filters.q) {
      const p = state.projects.find((p) => p.slug === t.project);
      const hay = [t.title, t.key, t.activity, t.branch, t.agent, p && p.name].join(" ").toLowerCase();
      if (!filters.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function initFilters() {
    const bind = (id, key, ev = "change") => {
      const e = $(id);
      if (filters[key]) e.value = filters[key];
      e.addEventListener(ev, () => { filters[key] = e.value; saveFilters(); render(); });
    };
    bind("#f-project", "project");
    bind("#f-state", "state");
    bind("#f-window", "window");
    bind("#f-search", "q", "input");
  }

  // ---------------------------------------------------------------- graph
  const svg = d3.select("#graph");
  const root = svg.append("g");
  const linkG = root.append("g");
  const nodeG = root.append("g");
  let userZoomed = false;
  const zoom = d3.zoom().scaleExtent([0.15, 4]).on("zoom", (e) => {
    if (e.sourceEvent) userZoomed = true;
    root.attr("transform", e.transform);
  });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", (e) => { if (e.target === svg.node()) select(null); });
  const nodes = new Map(); // id -> node object, kept across updates for stable positions
  const sim = d3.forceSimulation()
    .force("link", d3.forceLink().id((d) => d.id).distance((l) => 34 + l.target.r * 2.2).strength(0.6))
    .force("charge", d3.forceManyBody().strength((d) => (d.hub ? -420 : -38)))
    .force("collide", d3.forceCollide().radius((d) => d.r + (d.hub ? 14 : 3)))
    .force("x", d3.forceX().strength(0.045))
    .force("y", d3.forceY().strength(0.06))
    .alphaDecay(0.035)
    .on("tick", tick)
    .on("end", () => fit(true));

  // Fit the whole graph in view until the user pans or zooms themselves.
  let fitted = 0;
  function fit(animate) {
    if (userZoomed || !nodes.size) return;
    const ns = [...nodes.values()];
    const pad = 40;
    const x0 = d3.min(ns, (d) => d.x - d.r) - pad, x1 = d3.max(ns, (d) => d.x + d.r) + pad;
    const y0 = d3.min(ns, (d) => d.y - d.r) - pad, y1 = d3.max(ns, (d) => d.y + d.r + 18) + pad;
    const r = svg.node().getBoundingClientRect();
    const k = Math.min(2.2, r.width / (x1 - x0), r.height / (y1 - y0));
    const t = d3.zoomIdentity.scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    (animate ? svg.transition().duration(700) : svg).call(zoom.transform, t);
  }

  function size() {
    const r = svg.node().getBoundingClientRect();
    svg.attr("viewBox", [-r.width / 2, -r.height / 2, r.width, r.height]);
    // Spread the layout to the screen's shape: tall on phones, wide on laptops.
    const aspect = Math.min(2.5, Math.max(0.4, r.height / Math.max(1, r.width)));
    sim.force("x").strength(0.05 * aspect);
    sim.force("y").strength(0.05 / aspect);
  }
  window.addEventListener("resize", size);

  function threadRadius(t) {
    if (t.state === "resolved") return 4;
    const a = ageSec(t);
    const recency = Math.exp(-a / (6 * 3600)); // 1 now, ~0.37 after 6h
    return 6 + 9 * recency + (t.needs_you ? 2 : 0);
  }

  let linkSel = linkG.selectAll("line");
  let nodeSel = nodeG.selectAll("g.node");

  function renderGraph(threads) {
    const projects = state.projects.filter((p) => !filters.project || p.slug === filters.project);
    const hubColor = {};
    state.projects.forEach((p, i) => (hubColor[p.slug] = HUB_COLORS[i % HUB_COLORS.length]));
    const want = [];
    const links = [];
    const per = d3.group(threads, (t) => t.project);
    projects.forEach((p, i) => {
      const id = "hub:" + p.slug;
      const n = nodes.get(id) || { id, x: Math.cos(i) * 200, y: Math.sin(i) * 200 };
      const ts = per.get(p.slug) || [];
      Object.assign(n, { hub: true, p, color: hubColor[p.slug], r: 14 + Math.sqrt((p.counts && Object.values(p.counts).reduce((a, b) => a + b, 0)) || ts.length) * 2.2, open: ts.filter((t) => t.state !== "resolved").length });
      want.push(n);
    });
    const hubIds = new Set(want.map((n) => n.id));
    for (const t of threads) {
      const id = t.key;
      const hub = nodes.get("hub:" + t.project);
      const n = nodes.get(id) || { id, x: (hub?.x || 0) + (Math.random() - 0.5) * 60, y: (hub?.y || 0) + (Math.random() - 0.5) * 60 };
      Object.assign(n, { hub: false, t, r: threadRadius(t), color: STATES[t.state]?.color || "#baa67f" });
      want.push(n);
      if (hubIds.has("hub:" + t.project)) links.push({ source: "hub:" + t.project, target: id, state: t.state });
    }
    const keep = new Set(want.map((n) => n.id));
    for (const k of nodes.keys()) if (!keep.has(k)) nodes.delete(k);
    want.forEach((n) => nodes.set(n.id, n));

    linkSel = linkG.selectAll("line").data(links, (l) => l.target + "").join("line")
      .attr("class", (l) => "link" + (l.state === "resolved" ? " dim" : ""));

    nodeSel = nodeG.selectAll("g.node:not(.leaving)").data(want, (d) => d.id).join(
      (enter) => {
        const g = enter.append("g").attr("data-key", (d) => d.id).style("opacity", 0);
        g.append("circle").attr("class", "ring");
        g.append("circle").attr("class", "core").attr("r", 0);
        g.filter((d) => d.hub).append("text").attr("class", "count").attr("text-anchor", "middle").attr("dy", "0.35em");
        g.append("text").attr("class", (d) => (d.hub ? "name" : "label")).attr("text-anchor", "middle");
        g.on("click", (e, d) => { e.stopPropagation(); d.hub ? hubClick(d) : select(d.id); })
          .on("mouseenter", (e, d) => showTip(e, d)).on("mousemove", moveTip).on("mouseleave", hideTip)
          .call(d3.drag().on("start", dragStart).on("drag", dragged).on("end", dragEnd));
        g.transition().duration(600).style("opacity", 1);
        return g;
      },
      (update) => update,
      (exit) => exit.attr("class", "node leaving").transition().duration(400).style("opacity", 0).remove(),
    );
    nodeSel.attr("class", (d) => d.hub ? `node hub${d.p.coordinator?.needs_you ? " " + d.p.coordinator.state : ""}${d.id === selected ? " selected" : ""}` : `node thread ${d.t.state}${d.t.needs_you && d.t.state !== "review" ? " attn" : ""}${d.id === selected ? " selected" : ""}`)
      .style("color", (d) => d.color);
    nodeSel.select("circle.core").transition().duration(800).attr("r", (d) => d.r)
      .attr("fill", (d) => (d.hub ? "#262626" : d.color)).style("stroke", (d) => (d.hub ? d.color : null));
    nodeSel.filter((d) => d.hub).select("text.count").attr("fill", (d) => d.color);
    nodeSel.select("circle.ring").attr("r", (d) => d.r);
    nodeSel.filter((d) => d.hub).select("text.count").text((d) => d.open || "");
    nodeSel.select("text.name").attr("dy", (d) => d.r + 16).text((d) => d.p.name);
    nodeSel.select("text.label").attr("dy", (d) => -d.r - 5).text((d) => d.t && trunc(d.t.title, 34));

    sim.nodes(want);
    sim.force("link").links(links);
    sim.alpha(Math.max(sim.alpha(), 0.25)).restart();
  }

  function tick() {
    if (fitted < 3 && sim.alpha() < 0.3) { fitted++; fit(true); }
    linkSel.attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y).attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
    nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
  }
  function dragStart(e, d) { if (!e.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; }
  function dragged(e, d) { d.fx = e.x; d.fy = e.y; }
  function dragEnd(e, d) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }
  function hubClick(d) { select(d.id); }
  function toggleProjectFilter(slug) {
    filters.project = filters.project === slug ? "" : slug;
    $("#f-project").value = filters.project;
    saveFilters();
    render();
  }

  const tip = $("#tip");
  function showTip(e, d) {
    tip.replaceChildren();
    if (d.hub) {
      tip.append(el("div", { class: "tt", text: d.p.name }), el("div", { class: "sub", text: d.p.summary || "no threads" }));
      if (d.p.goal) tip.append(el("div", { text: d.p.goal }));
      const co = d.p.coordinator;
      if (co) tip.append(el("div", { class: "s-" + co.state, text: "Coordinator: " + (COORD[co.state] || co.state) + (co.activity ? " · " + co.activity : "") }));
    } else {
      const t = d.t;
      tip.append(el("div", { class: "tt", text: t.title }),
        el("div", { class: "s-" + t.state, text: STATES[t.state]?.label + (t.activity ? " · " + t.activity : "") }),
        el("div", { class: "sub", text: `${t.key} · ${t.agent || "?"} · ${ago(t.last_activity)}` }));
    }
    tip.hidden = false;
    moveTip(e);
  }
  function moveTip(e) {
    const r = $("#stage").getBoundingClientRect();
    const x = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 6);
    tip.style.left = Math.max(4, x) + "px";
    tip.style.top = (e.clientY - r.top + 14) + "px";
  }
  function hideTip() { tip.hidden = true; }
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

  // ---------------------------------------------------------------- header, strip
  function renderLegend(threads) {
    const counts = d3.rollup(state.threads, (v) => v.length, (t) => t.state);
    const box = $("#legend");
    box.replaceChildren(...ORDER.filter((s) => counts.get(s)).map((s) =>
      el("button", { class: filters.state === s ? "active" : "", title: "Filter: " + STATES[s].label, onclick: () => {
        filters.state = filters.state === s ? "" : s; $("#f-state").value = filters.state; saveFilters(); render();
      } }, el("span", { class: "dot", style: `background:${STATES[s].color}` }), el("span", { class: "lbl", text: STATES[s].label }), el("span", { class: "n", text: counts.get(s) }))));
    $("#shown").textContent = `${threads.length} of ${state.threads.length} threads`;
    $("#updated").textContent = state.generated_at ? "updated " + nyTime(state.generated_at) : "";
  }

  // ---------------------------------------------------------------- triage
  // Local, optimistic overlay on top of the server state: what this page just
  // acked or resolved, until the server agrees (or 90s pass).
  const overlay = new Map(); // key -> { acked?, resolved?, at }
  const snoozed = JSON.parse(localStorage.getItem("hd-snooze") || "{}"); // key -> until ms
  const collapsed = new Set(JSON.parse(localStorage.getItem("hd-collapsed") || "[]"));
  const picked = new Set();
  let selecting = false;
  let readOnly = false;
  const STRIP = ["blocked", "waiting", "review", "landing"];

  const isSnoozed = (t) => (snoozed[t.key] || 0) > Date.now();
  const parked = (t) => t.acked || isSnoozed(t);
  function saveSnooze() {
    for (const [k, v] of Object.entries(snoozed)) if (v < Date.now()) delete snoozed[k];
    localStorage.setItem("hd-snooze", JSON.stringify(snoozed));
  }
  function effective(t) {
    const o = overlay.get(t.key);
    if (!o) return t;
    if (Date.now() - o.at > 90000 || (o.acked && t.acked) || (o.resolved && t.state === "resolved")) { overlay.delete(t.key); return t; }
    if (o.resolved) return { ...t, state: "resolved", needs_you: false };
    if (o.acked) return { ...t, acked: true };
    return t;
  }
  function needsList() {
    const mode = $("#needs-filter").value;
    const rank = (t) => ORDER.indexOf(t.state);
    // Coordinators that need you are never acked or snoozed: they show until answered.
    const coords = mode === "parked" ? [] : coordItems();
    return state.threads.filter((t) => t.needs_you && (mode === "all" || (mode === "parked") === parked(t))).concat(coords)
      .sort((a, b) => rank(a) - rank(b) || ageSec(a) - ageSec(b));
  }
  function coordItems() {
    return state.projects.filter((p) => p.coordinator?.needs_you).map((p) => ({
      key: "hub:" + p.slug, project: p.slug, coord: true, needs_you: true, state: p.coordinator.state,
      title: "Coordinator" + (p.coordinator.activity ? " · " + p.coordinator.activity : ""), last_activity: p.coordinator.last_activity,
    }));
  }

  function renderNeeds() {
    const list = needsList();
    const hidden = state.threads.filter((t) => t.needs_you).length + coordItems().length - list.length;
    const names = Object.fromEntries(state.projects.map((p) => [p.slug, p.name]));
    $("#needs-n").textContent = (list.length || "") + (hidden > 0 && $("#needs-filter").value === "active" ? ` (+${hidden} parked)` : "");
    const by = d3.group(list, (t) => t.state);
    for (const k of [...picked]) if (!list.some((t) => t.key === k)) picked.delete(k);
    $("#needs").replaceChildren(...STRIP.filter((s) => by.get(s)).map((s) => {
      const ts = by.get(s);
      const closed = collapsed.has(s);
      const head = el("button", { class: "group-head", "aria-expanded": String(!closed), title: (closed ? "Show " : "Hide ") + STATES[s].label,
        onclick: () => { closed ? collapsed.delete(s) : collapsed.add(s); localStorage.setItem("hd-collapsed", JSON.stringify([...collapsed])); renderNeeds(); } },
        el("span", { class: "dot", style: `background:${STATES[s].color}` }), el("span", { class: "lbl", text: STATES[s].label }), el("span", { class: "n", text: ts.length }), el("span", { class: "caret", text: closed ? "▸" : "▾" }));
      return el("div", { class: "group " + s + (closed ? " collapsed" : ""), "data-state": s }, head,
        ...(closed ? [] : ts.map((t) => el("button", {
          class: "chip " + t.state + (t.coord ? " coord" : "") + (picked.has(t.key) ? " picked" : "") + (!t.coord && parked(t) ? " parked" : ""), "data-key": t.key,
          title: `${STATES[t.state].label}: ${t.title}${t.acked ? " (acked)" : ""}${isSnoozed(t) ? " (snoozed)" : ""}`,
          onclick: () => {
            if (selecting) {
              if (t.coord) return; // nothing to ack on a coordinator
              picked.has(t.key) ? picked.delete(t.key) : picked.add(t.key); renderNeeds(); return;
            }
            if (t.coord) { select(t.key); return; }
            // Make sure the node is visible before selecting it.
            if (!visible(t)) { Object.assign(filters, { project: "", state: "", window: "", q: "" }); syncFilterInputs(); saveFilters(); render(); }
            select(t.key);
          },
        }, el("span", { class: "dot", style: `background:${STATES[t.state].color}` }), el("span", { class: "proj", text: names[t.project] || t.project }), el("span", { class: "t", text: t.title })))));
    }));
    $("#bulk-ack").hidden = $("#bulk-snooze").hidden = !selecting;
    $("#bulk-ack").textContent = `Ack selected (${picked.size})`;
    $("#bulk-snooze").textContent = `Snooze 1 day (${picked.size})`;
    $("#bulk-ack").disabled = $("#bulk-snooze").disabled = !picked.size;
  }

  // POST JSON to a write endpoint. Never throws: { ok, status, data }.
  async function api(path, body) {
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      let data = {};
      try { data = await r.json(); } catch {}
      return { ok: r.ok && data.ok !== false, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: "network error: " + e.message } };
    }
  }
  const tpath = (key, act) => { const [slug, id] = key.split("/"); return `/api/thread/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/${act}`; };

  function toast(msg, kind = "") {
    const t = el("div", { class: "toast " + kind, role: kind === "err" ? "alert" : "status", text: msg });
    t.addEventListener("click", () => t.remove());
    $("#toasts").append(t);
    setTimeout(() => t.remove(), kind === "err" ? 10000 : 4000);
  }

  // A modal confirm. Resolves true on OK.
  function confirmDlg(msg, extra = [], okText = "OK", onOpen) {
    const dlg = $("#dlg");
    $("#dlg-msg").textContent = msg;
    $("#dlg-extra").replaceChildren(...extra);
    $("#dlg-ok").textContent = okText;
    dlg.returnValue = "";
    dlg.showModal();
    onOpen && onOpen();
    return new Promise((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok"), { once: true }));
  }

  async function ackKeys(keys) {
    if (!keys.length) return;
    keys.forEach((k) => overlay.set(k, { acked: true, at: Date.now() }));
    reapply();
    const r = keys.length === 1 ? await api(tpath(keys[0], "ack")) : await api("/api/ack", { threads: keys });
    const results = keys.length === 1 ? [{ key: keys[0], ok: r.ok, error: r.data.error }] : (r.data.results || keys.map((key) => ({ key, ok: false, error: r.data.error || "HTTP " + r.status })));
    const bad = results.filter((x) => !x.ok);
    bad.forEach((x) => { overlay.delete(x.key); toast(`Ack ${x.key} failed: ${x.error || "error"}`, "err"); });
    const good = results.length - bad.length;
    if (good) toast(good === 1 ? `Acked ${results.find((x) => x.ok).key}` : `Acked ${good} threads`);
    reapply();
  }

  async function resolveKey(key) {
    const t = state.threads.find((x) => x.key === key);
    const ok = await confirmDlg(`Resolve ${key}${t ? ` (“${t.title}”)` : ""}? herdr-projects copies its files home, then removes its worktree, merged branch and tab. Reports and library are kept.`, [], "Resolve");
    if (!ok) return;
    overlay.set(key, { resolved: true, at: Date.now() });
    if (selected === key) select(null);
    reapply();
    const r = await api(tpath(key, "resolve"), { confirm: key });
    if (r.ok) toast(`Resolved ${key}`);
    else { overlay.delete(key); toast(`Resolve ${key} failed: ${r.data.error || "HTTP " + r.status}`, "err"); reapply(); }
  }

  function snoozeKeys(keys) {
    keys.forEach((k) => (snoozed[k] = Date.now() + 86400000));
    saveSnooze();
    toast(keys.length === 1 ? `Snoozed ${keys[0]} for a day` : `Snoozed ${keys.length} threads for a day`);
    render();
  }

  function initTriage() {
    const nf = $("#needs-filter");
    nf.value = localStorage.getItem("hd-needs-filter") || "active";
    nf.addEventListener("change", () => { localStorage.setItem("hd-needs-filter", nf.value); renderNeeds(); });
    $("#select-mode").addEventListener("click", () => {
      selecting = !selecting;
      picked.clear();
      $("#select-mode").setAttribute("aria-pressed", String(selecting));
      $("#select-mode").classList.toggle("on", selecting);
      $("#select-mode").textContent = selecting ? "Done" : "Select";
      renderNeeds();
    });
    $("#bulk-ack").addEventListener("click", () => { const k = [...picked]; picked.clear(); ackKeys(k); });
    $("#bulk-snooze").addEventListener("click", () => { const k = [...picked]; picked.clear(); snoozeKeys(k); });
    $("#ack-all").addEventListener("click", async () => {
      const proj = el("select", { id: "ack-all-project" }, el("option", { value: "", text: "All projects" }), ...state.projects.map((p) => el("option", { value: p.slug, text: p.name })));
      const age = el("select", { id: "ack-all-age" }, ...[["0", "any age"], ["3600", "older than 1 hour"], ["86400", "older than 1 day"], ["259200", "older than 3 days"], ["604800", "older than 7 days"]].map(([v, l]) => el("option", { value: v, text: l })));
      proj.value = filters.project || "";
      const targets = () => state.threads.filter((t) => t.state === "review" && !t.acked && (!proj.value || t.project === proj.value) && ageSec(t) >= +age.value);
      const upd = () => { $("#dlg-msg").textContent = `Ack ${targets().length} ready-for-review thread(s)? Acking records that you saw the report; a thread with an open PR stays in review.`; };
      proj.addEventListener("change", upd);
      age.addEventListener("change", upd);
      const ok = await confirmDlg("", [el("label", { text: "Project " }, proj), el("label", { text: " Age " }, age)], "Ack", upd);
      if (!ok) return;
      const keys = targets().map((t) => t.key);
      if (!keys.length) toast("Nothing to ack");
      else ackKeys(keys);
    });
  }

  function syncFilterInputs() {
    $("#f-project").value = filters.project || "";
    $("#f-state").value = filters.state || "";
    $("#f-window").value = filters.window || "";
    $("#f-search").value = filters.q || "";
  }

  function renderProjectsSelect() {
    const sel = $("#f-project");
    const cur = filters.project || "";
    const opts = [el("option", { value: "", text: "All projects" }), ...state.projects.map((p) => el("option", { value: p.slug, text: p.name }))];
    if (sel.options.length !== opts.length || [...sel.options].some((o, i) => o.value !== opts[i].value)) {
      sel.replaceChildren(...opts);
    }
    sel.value = cur;
  }

  function renderErrors() {
    const box = $("#errors");
    box.hidden = !state.errors.length;
    box.textContent = state.errors.slice(0, 3).join("\n");
  }

  function render() {
    const threads = state.threads.filter(visible);
    renderProjectsSelect();
    renderLegend(threads);
    renderNeeds();
    renderErrors();
    renderGraph(threads);
    if (selected) isHub(selected) ? refreshCoordHeader() : refreshPanelHeader();
  }

  // ---------------------------------------------------------------- panel
  const panel = $("#panel");
  $("#close").addEventListener("click", () => select(null));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("#dlg").open || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    select(null);
  });
  let screenES = null;
  let live = ""; // live status of the open panel's pane, from its screen stream
  const isHub = (key) => key.startsWith("hub:");

  function select(key) {
    selected = key;
    nodeSel.classed("selected", (d) => d.id === key);
    clearInterval(detailTimer);
    screenES?.close();
    screenES = null;
    live = "";
    coordDetail = null;
    if (!key) {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
      return;
    }
    const n = nodes.get(key);
    if (n) svg.transition().duration(600).call(zoom.translateTo, n.x + (innerWidth > 700 ? 160 : 0), n.y + (innerWidth > 700 ? 0 : 150));
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    panel.scrollTop = 0;
    if (isHub(key)) {
      const slug = key.slice(4);
      buildCoordPanel(slug);
      loadProject(slug);
      detailTimer = setInterval(() => loadProject(slug), 10000);
      // Always streamed while open: the server re-identifies the pane on each
      // read, so a coordinator that starts later shows up, and none is guessed.
      screenES = new EventSource(`/api/project/${encodeURIComponent(slug)}/screen`);
      screenES.addEventListener("screen", (e) => { if (selected === key) showScreen(JSON.parse(e.data)); });
      return;
    }
    buildPanel(key);
    loadDetail(key);
    detailTimer = setInterval(() => loadDetail(key), 10000);
    const t = state.threads.find((x) => x.key === key);
    if (t && t.pane_alive && t.state !== "resolved") {
      // The screen streams over SSE: every few seconds, faster after a send.
      screenES = new EventSource(tpath(key, "screen"));
      screenES.addEventListener("screen", (e) => { if (selected === key) showScreen(JSON.parse(e.data)); });
    }
  }

  function buildPanel(key) {
    const t = state.threads.find((x) => x.key === key);
    const body = $("#panel-body");
    if (!t) { body.replaceChildren(el("p", { text: "Thread not found." })); return; }
    const p = state.projects.find((x) => x.slug === t.project) || { name: t.project };
    body.replaceChildren(
      el("div", { class: "proj" }, el("button", { id: "open-coord", class: "projlink", title: "Open the project's coordinator panel", text: p.name, onclick: () => select("hub:" + t.project) }), ` · ${t.id}`),
      el("h2", { class: "title", text: t.title }),
      el("div", { id: "p-head" }),
      el("div", { id: "p-actions", class: "w" }),
      el("dl", { class: "meta", id: "p-meta" }),
      buildChat(t),
      el("div", { id: "p-next" }),
      // The report lives mainly in the coordinator panel; here it is a one-liner.
      el("details", { id: "p-report-box", class: "fold" },
        el("summary", {}, el("span", { class: "fold-h", text: "Latest report" }), el("span", { class: "preview" })),
        el("div", { class: "md", id: "p-report", text: "…" })),
      el("h3", { text: "Task" }), el("div", { class: "md", id: "p-task", text: "…" }),
      el("h3", { text: "Jump to it" }), el("div", { id: "p-jump" }),
    );
    refreshPanelHeader();
  }

  // ---------------------------------------------------------------- chat
  const QUICK = [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["enter", "Enter"], ["esc", "Esc"], ["up", "↑"], ["down", "↓"], ["tab", "Tab"]];

  function buildChat(t) {
    const box = el("section", { id: "p-chat" }, el("h3", { text: "Chat" }));
    if (!t.pane_alive || t.state === "resolved") {
      box.append(el("p", { class: "muted", text: t.state === "resolved" ? "Resolved: no pane to chat with." : "The pane is gone: nothing to chat with." }));
      return box;
    }
    const key = t.key;
    const input = el("textarea", { id: "chat-input", class: "w", rows: "2", placeholder: "Follow-up prompt… (Ctrl+Enter sends)" });
    const send = el("button", { id: "chat-send", class: "tbtn primary w", text: "Send" });
    const go = () => sendChat(key, input, send);
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    box.append(
      el("pre", { class: "screen" }),
      el("div", { class: "quick w", hidden: "" }, el("span", { class: "muted", text: "Answer the prompt:" }),
        ...QUICK.map(([k, label]) => el("button", { class: "tbtn", "data-key": k, title: "Press " + k, text: label, onclick: () => pressKeys(key, [k]) }))),
      el("div", { class: "chat-row" }, input, send),
      el("div", { id: "chat-log" }),
    );
    return box;
  }

  // The newest lines are at the bottom: keep the box pinned there unless the
  // reader scrolled up, and re-pin once they scroll back down.
  function showScreen(d) {
    const box = $("#p-chat");
    const pre = box?.querySelector(".screen");
    if (!pre) return;
    const stick = !pre.dataset.n || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.textContent = (d.screen || "").replace(/\s+$/, ""); // textContent: never HTML; drops blank rows only
    pre.dataset.n = (+pre.dataset.n || 0) + 1;
    if (stick) {
      pre.scrollTop = pre.scrollHeight;
      // Again after layout: the box may have just appeared (was :empty).
      requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    }
    live = d.live_status || "";
    const blocked = live === "blocked";
    if (isHub(selected || "")) { coordNote(d.pane_alive, blocked); return; }
    box.querySelector(".quick").hidden = !blocked;
    const input = $("#chat-input");
    if (input) input.placeholder = blocked ? "Type an answer: typed into the prompt, then Enter" : "Follow-up prompt… (Ctrl+Enter sends)";
  }

  function chatMsg(text, kind, ...extra) {
    const log = $("#chat-log");
    if (!log) return;
    log.append(el("div", { class: "msg " + kind }, el("span", { text }), ...extra));
    while (log.childElementCount > 8) log.firstElementChild.remove();
  }

  async function pressKeys(key, keys, text) {
    const r = await api(tpath(key, "keys"), text ? { keys, text } : { keys });
    if (selected !== key) return r;
    if (r.ok) chatMsg(text ? `Typed “${text}”, pressed ${keys.join(" ")}` : `Pressed ${keys.join(" ")}`, "ok");
    else chatMsg(r.data.error || "HTTP " + r.status, "err");
    return r;
  }

  async function sendChat(key, input, btn) {
    const text = input.value.trim();
    if (!text || btn.disabled) return;
    btn.disabled = true;
    try {
      if (live === "blocked") {
        // A question/permission menu is up: type the answer, then Enter.
        if ((await pressKeys(key, ["enter"], text)).ok) input.value = "";
        return;
      }
      chatMsg("Sending…", "pending");
      const r = await api(tpath(key, "prompt"), { text });
      $("#chat-log .pending")?.remove();
      if (selected !== key) return;
      if (r.ok) { input.value = ""; chatMsg("Sent: " + text, "ok"); return; }
      const code = r.data.code;
      if (code === "prompt_unconfirmed") {
        // Typed, but not seen starting: it may sit in the input box. Never resend.
        input.value = "";
        chatMsg("Typed into the pane but not confirmed as started. Not resent: check the screen, then submit it if it sits in the box.", "warn",
          el("button", { class: "tbtn submit-enter", text: "Press Enter", onclick: () => pressKeys(key, ["enter"]) }));
      } else if (code === "agent_blocked") {
        live = "blocked";
        const q = $("#p-chat .quick");
        if (q) q.hidden = false;
        chatMsg("The agent is waiting on a prompt in its pane: answer it with the buttons above, or type the answer and send again.", "err");
      } else chatMsg(r.data.error || "HTTP " + r.status, "err");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- coordinator panel
  let coordDetail = null; // last /api/project/{slug} of the open coordinator panel

  function buildCoordPanel(slug) {
    const p = state.projects.find((x) => x.slug === slug);
    const body = $("#panel-body");
    if (!p) { body.replaceChildren(el("p", { text: "Project not found." })); return; }
    const input = el("textarea", { id: "coord-input", class: "w", rows: "2", placeholder: `Message the ${p.name} coordinator… (Ctrl+Enter sends)` });
    const send = el("button", { id: "coord-send", class: "tbtn primary w", text: "Send" });
    const go = () => sendCoord(slug, input, send);
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    body.replaceChildren(
      el("div", { class: "proj", text: `Project · ${slug}` }),
      el("h2", { class: "title", text: p.name }),
      el("div", { id: "p-head" }),
      el("div", { id: "p-actions" }),
      el("dl", { class: "meta", id: "p-meta" }),
      el("section", { id: "p-chat" }, el("h3", { text: "Coordinator" }),
        el("pre", { class: "screen" }),
        el("div", { id: "coord-note" }),
        el("div", { class: "chat-row" }, input, send),
        el("div", { id: "chat-log" })),
      el("h3", { text: "Open threads" }), el("ul", { id: "p-threads", class: "tlist" }),
      el("h3", { text: "Thread reports" }), el("div", { id: "p-reports", text: "…" }),
      el("h3", { text: "Tasks" }), el("div", { class: "md", id: "p-tasks", text: "…" }),
      el("details", { id: "p-memory", class: "fold" }, el("summary", {}, el("span", { class: "fold-h", text: "Memory index" })), el("div", { class: "md", id: "p-memory-md" })),
      el("h3", { text: "Jump to it" }), el("div", { id: "p-jump" }),
    );
    refreshCoordHeader();
    coordNote(!!p.coordinator?.pane_id, p.coordinator?.state === "blocked");
  }

  // herdr-projects only offers `coordinator prompt`: no key presses, so no
  // quick replies here, and a blocked coordinator is answered in its pane.
  function coordNote(alive, blocked) {
    const box = $("#coord-note");
    if (!box) return;
    const slug = selected.slice(4);
    const sig = `${alive}/${blocked}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (!alive) box.replaceChildren(el("p", { class: "msg warn no-pane", text: `No live pane: no coordinator pane could be identified for this project. “herdr-projects open ${slug}” starts one (Jump below).` }));
    else if (blocked) box.replaceChildren(el("p", { class: "msg warn note", text: "The coordinator is waiting on a prompt in its pane. The dashboard can only send it prompts (herdr-projects has no key command for coordinators): answer it in its pane, see Jump below." }));
    else box.replaceChildren(el("p", { class: "muted note", text: "Send only: herdr-projects can only send the coordinator a prompt. Menus in its pane are answered there." }));
  }

  async function sendCoord(slug, input, btn) {
    const key = "hub:" + slug;
    const text = input.value.trim();
    if (!text || btn.disabled) return;
    btn.disabled = true;
    chatMsg("Sending…", "pending");
    const r = await api(`/api/project/${encodeURIComponent(slug)}/coordinator`, { text });
    btn.disabled = false;
    $("#chat-log .pending")?.remove();
    if (selected !== key) return;
    if (r.ok) { input.value = ""; chatMsg("Sent: " + text, "ok"); }
    else chatMsg(r.data.error || "HTTP " + r.status, "err"); // kept in the box for a retry
  }

  function refreshCoordHeader() {
    const slug = selected.slice(4);
    const p = state.projects.find((x) => x.slug === slug);
    if (!p || !$("#p-head")) return;
    const co = p.coordinator || { state: "none" };
    const d = coordDetail;
    const color = STATES[co.state]?.color || STATES.idle.color;
    const head = $("#p-head");
    head.replaceChildren(...[el("span", { class: "pill", style: `background:${co.state === "none" ? "#4e4e4e" : color}`, text: COORD[co.state] || co.state }),
      co.activity && el("span", { text: "  " + co.activity })].filter(Boolean));
    const pg = d && d.progress;
    if (pg) {
      head.append(el("div", { class: "muted", text: `Progress: ${pg.activity || "—"}${pg.percent ? ` · ${pg.percent}%` : ""}${pg.reported_at ? ` · reported ${ago(pg.reported_at)}` : ""}` }));
      if (pg.percent && pg.percent < 100) head.append(el("div", { class: "bar" }, el("i", { style: `width:${pg.percent}%` })));
    }
    const acts = $("#p-actions");
    const on = filters.project === slug;
    acts.replaceChildren(el("button", { class: "tbtn" + (on ? " on" : ""), "data-act": "filter", text: on ? "Showing only this project" : "Show only this project", onclick: () => { toggleProjectFilter(slug); refreshCoordHeader(); } }));
    const st = (d && d.settings) || {};
    const rows = [
      ["Project", slug],
      ["Goal", p.goal || "(none set)"],
      ["Status", p.status || "—"],
      ["Coordinator", co.pane_id ? `${co.agent || "?"} · pane ${co.pane_id}` : "no live pane"],
      ["Live", co.live_status || "—"],
      ["Last activity", `${nyTime(co.last_activity)} (${ago(co.last_activity)})`],
      ["Threads", p.summary || "no threads"],
      ["Inbox", String(p.inbox ?? 0)],
      ["Thread profile", st.thread_profile],
      ["Coordinator profile", st.coordinator_profile],
      ["Max parallel threads", st.max_parallel_threads],
      ["Auto-resolve days", st.auto_resolve_days],
      ["Repos", st.repos],
      ["Safety", d && d.safety],
    ].filter(([, v]) => v);
    $("#p-meta").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
    if (p.error) $("#p-meta").append(el("dt", { text: "Error" }), el("dd", { class: "s-blocked", text: p.error }));
    // Open threads: rebuilt only when they change, so clicks are not lost.
    const open = state.threads.filter((t) => t.project === slug && t.state !== "resolved")
      .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || ageSec(a) - ageSec(b));
    const ul = $("#p-threads");
    const sig = JSON.stringify(open.map((t) => [t.key, t.state, t.title, t.activity]));
    if (ul.dataset.sig !== sig) {
      ul.dataset.sig = sig;
      ul.replaceChildren(...(open.length ? open.map((t) => el("li", { "data-key": t.key },
        el("button", { class: "trow", title: "Open " + t.key, onclick: () => select(t.key) },
          el("span", { class: "dot", style: `background:${STATES[t.state].color}` }),
          el("span", { class: "t", text: t.title }),
          el("span", { class: "muted", text: `${t.id} · ${STATES[t.state].label}${t.activity ? " · " + t.activity : ""}` })))) : [el("li", { class: "muted", text: "No open threads." })]));
    }
  }

  async function loadProject(slug) {
    const key = "hub:" + slug;
    let d;
    try {
      const r = await fetch(`/api/project/${encodeURIComponent(slug)}`);
      if (!r.ok) throw new Error(r.status);
      d = await r.json();
    } catch (e) { return; }
    if (selected !== key) return;
    coordDetail = d;
    refreshCoordHeader();
    const setHTML = (box, html, empty) => {
      if (box.dataset.html === html) return false;
      box.dataset.html = html;
      box.replaceChildren(...(html ? safeHTML(html) : [el("em", { text: empty })]));
      return true;
    };
    if (setHTML($("#p-tasks"), d.tasks_html, "No TASKS.md.")) collapsible($("#p-tasks"));
    setHTML($("#p-memory-md"), d.memory_html, "No MEMORY.md.");
    const reps = $("#p-reports");
    const rsig = JSON.stringify(d.reports.map((x) => [x.key, x.time, x.state, x.html.length]));
    if (reps.dataset.sig !== rsig) {
      reps.dataset.sig = rsig;
      const was = new Set([...reps.querySelectorAll("details[open]")].map((x) => x.dataset.key));
      reps.replaceChildren(...(d.reports.length ? d.reports.map((x) => el("details", { class: "fold report", "data-key": x.key, open: was.has(x.key) ? "" : null },
        el("summary", {},
          el("span", { class: "dot", style: `background:${STATES[x.state]?.color || STATES.idle.color}` }),
          el("span", { class: "t", text: x.title }),
          el("span", { class: "muted", text: `${x.id} · ${nyTime(x.time)}` })),
        el("div", { class: "md" }, ...(x.html ? safeHTML(x.html) : [])),
        el("button", { class: "tbtn open-thread", text: `Open ${x.id}`, onclick: () => select(x.key) }))) : [el("em", { class: "muted", text: "No thread reports yet." })]));
    }
    fillJump(d.jump);
  }

  function fillJump(jumps) {
    const jump = $("#p-jump");
    const sig = JSON.stringify(jumps);
    if (jump.dataset.sig === sig) return;
    jump.dataset.sig = sig;
    jump.replaceChildren(...jumps.flatMap((j) => {
      const b = el("button", { text: "Copy" });
      b.addEventListener("click", () => copy(j.command, b));
      return [el("div", { class: "jl", text: j.label }), el("div", { class: "jump" }, el("code", { text: j.command }), b)];
    }));
  }

  function refreshPanelHeader() {
    const t = state.threads.find((x) => x.key === selected);
    if (!t || !$("#p-head")) return;
    const st = STATES[t.state];
    const head = $("#p-head");
    head.replaceChildren(...[el("span", { class: "pill", style: `background:${st.color}`, text: st.label }),
      t.activity && el("span", { text: "  " + t.activity })].filter(Boolean));
    if (t.percent && t.state !== "resolved") head.append(el("div", { class: "bar" }, el("i", { style: `width:${t.percent}%` })));
    const rows = [
      ["Agent", `${t.agent || "?"}${t.pane_id ? " · pane " + t.pane_id : ""}${t.pane_alive ? "" : t.state === "resolved" ? "" : " (pane gone)"}`],
      ["Live", t.live_status || "—"],
      ["Group", t.group || "—"],
      ["Last activity", `${nyTime(t.last_activity)} (${ago(t.last_activity)})`],
      ["Created", nyTime(t.created)],
    ];
    const acts = $("#p-actions");
    if (acts) {
      acts.replaceChildren(...(t.state === "resolved" ? [] : [
        el("button", { class: "tbtn", "data-act": "ack", text: t.acked ? "Acked" : "Ack", disabled: t.acked ? "" : null, title: "Record that you saw the current report", onclick: () => ackKeys([t.key]) }),
        el("button", { class: "tbtn", "data-act": "snooze", text: "Snooze 1 day", onclick: () => snoozeKeys([t.key]) }),
        el("button", { class: "tbtn danger", "data-act": "resolve", text: "Resolve…", onclick: () => resolveKey(t.key) }),
      ]).filter(Boolean));
    }
    const meta = $("#p-meta");
    meta.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
    if (t.pr) meta.append(el("dt", { text: "PR" }), el("dd", {}, el("a", { href: t.pr, target: "_blank", rel: "noopener", text: t.pr.replace("https://github.com/", "") + (t.pr_state ? ` (${t.pr_state.toLowerCase()})` : "") })));
    if (t.branch) {
      const m = t.pr && t.pr.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\//);
      const dd = el("dd", { class: "mono" });
      if (m) dd.append(el("a", { href: `${m[1]}/tree/${t.branch}`, target: "_blank", rel: "noopener", text: t.branch }));
      else dd.textContent = t.branch;
      meta.append(el("dt", { text: "Branch" }), dd);
    }
    if (t.error) meta.append(el("dt", { text: "Error" }), el("dd", { class: "s-blocked", text: t.error }));
  }

  // The server renders markdown with raw HTML dropped; parse it inertly and
  // strip anything active again before inserting, as a second guard.
  function safeHTML(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,form,input,button,link,meta,svg,math").forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((n) => {
      for (const a of [...n.attributes]) {
        const v = a.value.trim().toLowerCase();
        if (a.name.startsWith("on") || a.name === "style" || ((a.name === "href" || a.name === "src") && !/^(https?:|mailto:|#|\/)/.test(v) && v !== "")) n.removeAttribute(a.name);
      }
      if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); }
    });
    return [...doc.body.firstChild.childNodes];
  }

  function copy(text, btn) {
    const done = () => { btn.textContent = "Copied"; btn.classList.add("ok"); setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("ok"); }, 1400); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, () => fallback()); } else fallback();
    function fallback() {
      // Plain http to a non-localhost address has no Clipboard API.
      const ta = el("textarea", { style: "position:fixed;opacity:0" });
      ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch { btn.textContent = "Select + copy"; }
      ta.remove();
    }
  }

  async function loadDetail(key) {
    const [slug, id] = key.split("/");
    let d;
    try {
      const r = await fetch(`/api/thread/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(r.status);
      d = await r.json();
    } catch (e) { return; }
    if (selected !== key) return;
    const task = $("#p-task");
    if (task.dataset.html !== d.task_html) {
      task.dataset.html = d.task_html;
      task.replaceChildren(...(d.task_html ? safeHTML(d.task_html) : [el("em", { text: "No task file." })]));
      collapsible(task);
    }
    const next = $("#p-next");
    const nextSig = JSON.stringify(d.next);
    if (next.dataset.sig !== nextSig) {
      next.dataset.sig = nextSig;
      next.replaceChildren(...(d.next.length ? [el("h3", { text: "Next" }), el("ol", { class: "next" }, ...d.next.map((n, i) => el("li", {},
        el("span", { text: n }),
        el("button", { class: "tbtn send w", title: "Forward this line to the thread as a prompt", text: "Send", onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          const r = await api(tpath(key, "next"), { line: i + 1 });
          b.disabled = false;
          if (r.ok) toast(`Sent Next line ${i + 1} to ${key}`);
          else toast(`Next line ${i + 1} to ${key}: ${r.data.error || "HTTP " + r.status}`, "err");
        } }))))] : []));
    }
    fillJump(d.jump);
    $("#p-report-box .preview").textContent = d.report_summary || (d.report_html ? "(no summary)" : "No report yet.");
    const rep = $("#p-report");
    if (rep.dataset.html !== d.report_html) {
      rep.dataset.html = d.report_html;
      rep.replaceChildren(...(d.report_html ? safeHTML(d.report_html) : [el("em", { text: "No report yet." })]));
    }
  }

  function collapsible(box) {
    box.classList.remove("collapsed");
    box.nextElementSibling?.classList.contains("more") && box.nextElementSibling.remove();
    requestAnimationFrame(() => {
      if (box.scrollHeight > 260) {
        box.classList.add("collapsed");
        const b = el("button", { class: "more", text: "Show full task" });
        b.addEventListener("click", () => { box.classList.toggle("collapsed"); b.textContent = box.classList.contains("collapsed") ? "Show full task" : "Show less"; });
        box.after(b);
      }
    });
  }

  // ---------------------------------------------------------------- live data
  let raw = state;
  function apply(s) {
    raw = s;
    reapply();
  }
  function reapply() {
    state = { ...raw, threads: raw.threads.map(effective) };
    render();
  }
  function connect() {
    const es = new EventSource("/api/events");
    es.addEventListener("state", (e) => { $("#live").className = "live on"; apply(JSON.parse(e.data)); });
    es.onerror = () => { $("#live").className = "live off"; };
  }

  size();
  initFilters();
  initTriage();
  fetch("/api/config").then((r) => r.json()).then((c) => { readOnly = c.read_only; document.body.classList.toggle("ro", readOnly); }).catch(() => {});
  connect();
  // Recency drives node size; nudge it as time passes even without changes.
  setInterval(() => { if (state.threads.length) render(); }, 60000);
})();
