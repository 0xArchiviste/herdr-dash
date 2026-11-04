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
  const motionMs = (ms) => matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
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
  // Shared with search.js (and voice navigation): content-search mode and
  // the keys its results matched, highlighted in the graph.
  const dash = (window.dash ||= {});
  dash.contentMode ||= false;
  dash.hits ||= new Set();
  let selected = null;
  let detailTimer = null;
  const filters = JSON.parse(localStorage.getItem("hd-filters") || "{}");
  // Project focus: any number of projects; none focused shows them all. A
  // URL focus (?focus=a,b) wins over the stored one, so a bookmark opens as
  // saved. Slugs no project has (yet) are kept but never hide everything.
  const focus = new Set(Array.isArray(filters.projects) ? filters.projects : filters.project ? [filters.project] : []);
  delete filters.project;
  const urlFocus = new URLSearchParams(location.search).get("focus");
  if (urlFocus != null) {
    focus.clear();
    urlFocus.split(",").map((x) => x.trim()).filter(Boolean).forEach((x) => focus.add(x));
    filters.projects = [...focus];
    localStorage.setItem("hd-filters", JSON.stringify(filters));
  }
  let eff = new Set(); // focus ∩ known projects
  function updateEff() {
    const known = new Set(state.projects.map((p) => p.slug));
    eff = new Set([...focus].filter((x) => known.has(x)));
  }
  const inFocus = (slug) => !eff.size || eff.has(slug);
  function orderedFocus() {
    const idx = new Map(state.projects.map((p, i) => [p.slug, i]));
    return [...focus].sort((a, b) => (idx.get(a) ?? 1e9) - (idx.get(b) ?? 1e9));
  }
  function saveFilters() {
    filters.projects = orderedFocus();
    localStorage.setItem("hd-filters", JSON.stringify(filters));
    const u = new URL(location.href);
    if (focus.size) u.searchParams.set("focus", filters.projects.join(","));
    else u.searchParams.delete("focus");
    // Commas stay readable in a bookmark.
    const next = u.pathname + u.search.replace(/%2C/gi, ",") + u.hash;
    if (next !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", next);
  }
  const anyFilter = () => !!(eff.size || filters.state || filters.window || filters.q);
  // Clear what hides threads (keeping the search text unless asked).
  function clearFilters(q = true, keepFocus = false) {
    if (!keepFocus) focus.clear();
    Object.assign(filters, { state: "", window: "" }, q ? { q: "" } : {});
    syncFilterInputs();
    saveFilters();
    render();
  }

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
  // visible: in focus and matching the other filters. drawn: on the graph
  // (in fade mode an unfocused project stays on it, faded).
  function visible(t) {
    return inFocus(t.project) && matches(t);
  }
  const drawn = (t) => (filters.fade || inFocus(t.project)) && matches(t);
  function matches(t) {
    if (filters.state === "needs" ? !t.needs_you : filters.state && t.state !== filters.state) return false;
    if (filters.window && ageSec(t) > +filters.window) return false;
    if (filters.q && !dash.contentMode) {
      const p = state.projects.find((p) => p.slug === t.project);
      const hay = [t.title, t.key, t.activity, t.branch, t.agent, p && p.name].join(" ").toLowerCase();
      if (!filters.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function initFilters() {
    $("#reset-filters").addEventListener("click", () => {
      clearFilters();
      focusChanged();
      // Notify content search as well, cancelling pending requests and highlights.
      $("#f-search").dispatchEvent(new Event("input"));
    });
    $("#fit-graph").addEventListener("click", () => { userZoomed = false; lastGo = null; fit(true); });
    const bind = (id, key, ev = "change") => {
      const e = $(id);
      if (filters[key]) e.value = filters[key];
      e.addEventListener(ev, () => { filters[key] = e.value; saveFilters(); render(); });
    };
    initPicker();
    initNeedsLight();
    bind("#f-state", "state");
    bind("#f-window", "window");
    bind("#f-search", "q", "input");
  }

  // ---------------------------------------------------------------- graph
  const svg = d3.select("#graph");
  const root = svg.append("g");
  const linkG = root.append("g");
  const nodeG = root.append("g");
  // Labels sit above every node; project names above thread labels.
  const tlabelG = root.append("g").attr("class", "labels threads");
  const hlabelG = root.append("g").attr("class", "labels hubs");
  let hovered = null;
  let userZoomed = false;
  const zoom = d3.zoom().scaleExtent([0.15, 4]).on("zoom", (e) => {
    if (e.sourceEvent) { userZoomed = true; lastGo = null; }
    root.attr("transform", e.transform);
  });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", (e) => { if (e.target === svg.node()) select(null); });
  const nodes = new Map(); // id -> node object, kept across updates for stable positions
  const sim = d3.forceSimulation()
    .force("link", d3.forceLink().id((d) => d.id).distance((l) => 34 + l.target.r * 2.2).strength(0.6))
    // A hub pushes harder the bigger its cluster, and harder still when
    // there are few projects, so clusters do not overlap.
    .force("charge", d3.forceManyBody().strength((d) => (d.hub ? -(320 + 45 * (d.size || 0)) * (hubCount() <= 8 ? 1.3 : 1) : -38)))
    .force("collide", d3.forceCollide().radius((d) => (d.hub ? Math.max(d.r + 14, (d.lw || 0) * 0.8) : d.r + 3)))
    .force("labelRoom", labelRoom())
    .force("x", d3.forceX().strength(0.045))
    .force("y", d3.forceY().strength(0.06))
    .alphaDecay(0.035)
    .on("tick", tick)
    .on("end", () => {
      // A project just added to the focus by "go": frame it where it settled.
      if (pendingGo) { const s = pendingGo; pendingGo = null; goToProject(s); } else fit(true);
    });

  // Fit the whole graph in view until the user pans or zooms themselves.
  let fitted = 0;
  function fit(animate) {
    if (userZoomed || !nodes.size) return;
    const ns = [...nodes.values()];
    const pad = 40;
    // A project's name can be wider than its hub: keep the whole name in view.
    const half = (d) => Math.max(d.r, (d.hub && d.lw) || 0);
    // Thread labels too, so none is cut at the edge.
    const labs = ns.filter((d) => d.lab).map((d) => d.lab);
    const x0 = Math.min(d3.min(ns, (d) => d.x - half(d)), d3.min(labs, (b) => b.l) ?? Infinity) - pad;
    const x1 = Math.max(d3.max(ns, (d) => d.x + half(d)), d3.max(labs, (b) => b.r) ?? -Infinity) + pad;
    const y0 = Math.min(d3.min(ns, (d) => d.y - d.r), d3.min(labs, (b) => b.t) ?? Infinity) - pad;
    const y1 = Math.max(d3.max(ns, (d) => d.y + d.r + 18), d3.max(labs, (b) => b.b) ?? -Infinity) + pad;
    const r = svg.node().getBoundingClientRect();
    const k = Math.min(2.2, r.width / (x1 - x0), r.height / (y1 - y0));
    const t = d3.zoomIdentity.scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    (animate ? svg.transition().duration(motionMs(700)) : svg).call(zoom.transform, t);
  }

  // ---------------------------------------------------------------- go to a project
  // Pan and zoom to one project's hub and threads, then pulse them briefly.
  // Only the view transform changes: the layout is never reheated for this.
  let lastGo = null, pendingGo = null, pulseSlug = null, pulseTimer = null, litSlug = null;
  const projOf = (d) => (d.hub ? d.p.slug : d.t.project);
  const own = (slug) => [...nodes.values()].filter((d) => projOf(d) === slug && !d.faded);
  function frame(ns, maxK) {
    const half = (d) => Math.max(d.r, (d.hub && d.lw) || 0);
    const pad = 50;
    const x0 = d3.min(ns, (d) => d.x - half(d)) - pad, x1 = d3.max(ns, (d) => d.x + half(d)) + pad;
    const y0 = d3.min(ns, (d) => d.y - d.r) - pad, y1 = d3.max(ns, (d) => d.y + d.r + 18) + pad;
    const r = svg.node().getBoundingClientRect();
    const k = Math.max(0.15, Math.min(maxK, r.width / (x1 - x0), r.height / (y1 - y0)));
    return d3.zoomIdentity.scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  }
  function viewTo(t) {
    svg.interrupt();
    const ms = motionMs(700);
    (ms ? svg.transition().duration(ms).ease(d3.easeCubicInOut) : svg).call(zoom.transform, t);
  }
  function goToProject(slug) {
    if (!state.projects.some((p) => p.slug === slug)) return;
    // Out of focus: bring it in first, then frame it again once it settles.
    if (!inFocus(slug)) { toggleFocus(slug); pendingGo = slug; }
    const ns = own(slug);
    if (!ns.length) return;
    userZoomed = true;
    lastGo = slug;
    viewTo(frame(ns, 2.2));
    pulseSlug = slug;
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => { pulseSlug = null; marks(); }, 2000);
    marks();
  }
  // Fit every focused project (all of them with no focus), faded ones aside.
  function fitFocus() {
    const ns = [...nodes.values()].filter((d) => !d.faded);
    if (!ns.length) return;
    lastGo = null;
    userZoomed = !!filters.fade; // fade mode keeps faded projects out of auto-fit
    viewTo(frame(ns, 2.2));
  }
  // Light one project on the map (null: none), dimming the rest.
  function light(slug) {
    if (litSlug === slug) return;
    litSlug = slug;
    marks();
  }
  function marks() {
    nodeSel.classed("pulse", (d) => projOf(d) === pulseSlug).classed("lit", (d) => projOf(d) === litSlug);
    hlabelSel.classed("lit", (d) => projOf(d) === litSlug);
    svg.classed("spotlit", !!litSlug && nodeSel.filter((d) => projOf(d) === litSlug).size() > 0);
  }

  function size() {
    const r = svg.node().getBoundingClientRect();
    svg.attr("viewBox", [-r.width / 2, -r.height / 2, r.width, r.height]);
    // Spread the layout to the screen's shape: tall on phones, wide on laptops.
    const aspect = Math.min(2.5, Math.max(0.4, r.height / Math.max(1, r.width)));
    sim.force("x").strength(0.05 * aspect);
    sim.force("y").strength(0.05 / aspect);
  }
  // The stage shrinks and grows with the docked panel and the window: keep
  // the viewBox in step every frame, then re-fit once it settles.
  let refitTimer = null;
  function refit() {
    if (!userZoomed) return fit(true);
    const n = selected && nodes.get(selected);
    if (n) svg.transition().duration(motionMs(500)).call(zoom.translateTo, n.x, n.y);
  }
  new ResizeObserver(() => {
    size();
    clearTimeout(refitTimer);
    refitTimer = setTimeout(refit, 120);
  }).observe($("#stage"));

  function threadRadius(t) {
    if (t.state === "resolved") return 4;
    const a = ageSec(t);
    const recency = Math.exp(-a / (6 * 3600)); // 1 now, ~0.37 after 6h
    return 6 + 9 * recency + (t.needs_you ? 2 : 0);
  }

  let linkSel = linkG.selectAll("line");
  let nodeSel = nodeG.selectAll("g.node");
  let hlabelSel = hlabelG.selectAll("text");
  let tlabelSel = tlabelG.selectAll("text");
  const hubCount = () => hlabelSel.size();

  // ---------------------------------------------------------------- labels
  // Boxes in graph units: a node's core, and a hub's name under it.
  const HUB_FONT = 13, LABEL_FONT = 11;
  const nodeBox = (n, pad = 0) => ({ l: n.x - n.r - pad, r: n.x + n.r + pad, t: n.y - n.r - pad, b: n.y + n.r + pad });
  const hubBox = (h, pad = 0) => ({ l: h.x - (h.lw || 30) - pad, r: h.x + (h.lw || 30) + pad, t: h.y + h.r + 3 - pad, b: h.y + h.r + 4 + HUB_FONT * 1.3 + pad });
  const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

  // A force that keeps every other node, and other hubs' names, off a hub's
  // name: project names stay readable however the clusters settle.
  function labelRoom() {
    let ns = [];
    // Push a and b apart along the axis where they overlap least.
    function part(a, ba, b, bb, share) {
      const dx = Math.min(ba.r - bb.l, bb.r - ba.l), dy = Math.min(ba.b - bb.t, bb.b - ba.t);
      if (dx <= 0 || dy <= 0) return;
      const sx = (ba.l + ba.r) / 2 < (bb.l + bb.r) / 2 ? -1 : 1, sy = (ba.t + ba.b) / 2 < (bb.t + bb.b) / 2 ? -1 : 1;
      const [mx, my] = dx < dy ? [sx * dx, 0] : [0, sy * dy];
      a.vx += mx * share * 0.5; a.vy += my * share * 0.5;
      b.vx -= mx * (1 - share) * 0.5; b.vy -= my * (1 - share) * 0.5;
    }
    function force() {
      for (const h of ns) {
        if (!h.hub) continue;
        const hb = hubBox(h, 3);
        for (const n of ns) {
          if (n === h) continue;
          part(h, hb, n, nodeBox(n, 2), n.hub ? 0.5 : 0.15);
          if (n.hub && n.id > h.id) part(h, hb, n, hubBox(n, 3), 0.5);
        }
      }
    }
    force.initialize = (n) => (ns = n);
    return force;
  }

  // Thread labels: the selected and hovered threads, then the few that need
  // you most (blocked, waiting, landing). Each takes the first free spot
  // around its node (above, below, right, left) that covers no node, no
  // project name and no other label; with no free spot it is left out.
  const MAX_LABELS = 8;
  function placeLabels() {
    const all = [...nodes.values()];
    const taken = all.filter((n) => n.hub).map((h) => hubBox(h, 2));
    const boxes = all.map((n) => [n, nodeBox(n, 2)]);
    const forced = (n) => n.id === selected || n.id === hovered;
    const rank = (n) => (forced(n) ? -1 : ORDER.indexOf(n.t.state));
    const cands = all.filter((n) => !n.hub && n.t && (forced(n) || (n.t.needs_you && n.t.state !== "review")))
      .sort((a, b) => rank(a) - rank(b) || ageSec(a.t) - ageSec(b.t));
    for (const n of all) n.lab = null;
    let shown = 0;
    for (const n of cands) {
      if (!forced(n) && shown >= MAX_LABELS) break;
      const w = (n.tw || 60) + 4, h = LABEL_FONT * 1.35, g = 3;
      const spots = [
        { l: n.x - w / 2, r: n.x + w / 2, t: n.y - n.r - g - h, b: n.y - n.r - g },
        { l: n.x - w / 2, r: n.x + w / 2, t: n.y + n.r + g, b: n.y + n.r + g + h },
        { l: n.x + n.r + g, r: n.x + n.r + g + w, t: n.y - h / 2, b: n.y + h / 2 },
        { l: n.x - n.r - g - w, r: n.x - n.r - g, t: n.y - h / 2, b: n.y + h / 2 },
      ];
      const free = (sp) => !taken.some((b) => overlaps(sp, b)) && !boxes.some(([m, b]) => m !== n && overlaps(sp, b));
      const sp = spots.find(free) || (forced(n) ? spots[0] : null);
      if (!sp) continue;
      taken.push(sp);
      n.lab = sp;
      if (!forced(n)) shown++;
    }
    tlabelSel.classed("off", (d) => !d.lab)
      .attr("x", (d) => (d.lab ? (d.lab.l + d.lab.r) / 2 : d.x)).attr("y", (d) => (d.lab ? d.lab.b - LABEL_FONT * 0.35 : d.y));
  }

  function renderGraph(threads) {
    const projects = state.projects.filter((p) => filters.fade || inFocus(p.slug));
    const hubColor = {};
    state.projects.forEach((p) => (hubColor[p.slug] = projColor(p.slug)));
    const want = [];
    const links = [];
    const per = d3.group(threads, (t) => t.project);
    projects.forEach((p, i) => {
      const id = "hub:" + p.slug;
      const n = nodes.get(id) || { id, x: Math.cos(i) * 200, y: Math.sin(i) * 200 };
      const ts = per.get(p.slug) || [];
      Object.assign(n, { hub: true, p, faded: !inFocus(p.slug), size: ts.length, color: hubColor[p.slug], r: 14 + Math.sqrt((p.counts && Object.values(p.counts).reduce((a, b) => a + b, 0)) || ts.length) * 2.2, open: ts.filter((t) => t.state !== "resolved").length });
      want.push(n);
    });
    const hubIds = new Set(want.map((n) => n.id));
    for (const t of threads) {
      const id = t.key;
      const hub = nodes.get("hub:" + t.project);
      const n = nodes.get(id) || { id, x: (hub?.x || 0) + (Math.random() - 0.5) * 60, y: (hub?.y || 0) + (Math.random() - 0.5) * 60 };
      Object.assign(n, { hub: false, t, faded: !inFocus(t.project), r: threadRadius(t), color: STATES[t.state]?.color || "#baa67f" });
      want.push(n);
      if (hubIds.has("hub:" + t.project)) links.push({ source: "hub:" + t.project, target: id, state: t.state, faded: n.faded });
    }
    const keep = new Set(want.map((n) => n.id));
    // Reheat the layout only when it has something new to place: a node
    // added or gone, or one that grew or shrank. A state or title change
    // repaints in place, so a settled graph stays still (and idle).
    // Only nodes gone (a project left the focus): a gentle re-settle.
    const added = want.some((n) => !nodes.has(n.id) || Math.abs((n.placedR ?? -1) - n.r) > 0.5);
    let moved = added || keep.size !== nodes.size;
    for (const k of nodes.keys()) if (!keep.has(k)) nodes.delete(k);
    want.forEach((n) => nodes.set(n.id, n));

    linkSel = linkG.selectAll("line").data(links, (l) => l.target + "").join("line")
      .attr("class", (l) => "link" + (l.state === "resolved" ? " dim" : "") + (l.faded ? " faded" : ""));

    nodeSel = nodeG.selectAll("g.node:not(.leaving)").data(want, (d) => d.id).join(
      (enter) => {
        const g = enter.append("g").attr("data-key", (d) => d.id).style("opacity", 0);
        g.append("circle").attr("class", "ring");
        g.append("circle").attr("class", "core").attr("r", 0);
        g.filter((d) => d.hub).append("text").attr("class", "count").attr("text-anchor", "middle").attr("dy", "0.35em");
        // Shift+click opens the thread (or coordinator) in a floating window.
        // Ctrl/Cmd/Shift+click on a project adds it to the focus or takes it out.
        g.on("click", (e, d) => {
          e.stopPropagation();
          if (d.hub && (e.ctrlKey || e.metaKey || e.shiftKey)) toggleFocus(d.p.slug);
          else if (e.shiftKey && window.HDThreadWin) window.HDThreadWin.open(d.id);
          else d.hub ? hubClick(d) : select(d.id);
        })
          .on("mouseenter", (e, d) => { hovered = d.id; placeLabels(); showTip(e, d); }).on("mousemove", moveTip)
          .on("mouseleave", () => { hovered = null; placeLabels(); hideTip(); })
          .call(d3.drag().on("start", dragStart).on("drag", dragged).on("end", dragEnd));
        g.transition().duration(motionMs(600)).style("opacity", 1);
        return g;
      },
      (update) => update,
      (exit) => exit.attr("class", "node leaving").transition().duration(motionMs(400)).style("opacity", 0).remove(),
    );
    nodeSel.attr("class", (d) => d.hub ? `node hub${d.p.coordinator?.needs_you ? " " + d.p.coordinator.state : ""}${d.id === selected ? " selected" : ""}` : `node thread ${d.t.state}${d.t.needs_you && d.t.state !== "review" ? " attn" : ""}${d.id === selected ? " selected" : ""}`)
      .style("color", (d) => d.color);
    nodeSel.classed("hit", (d) => dash.hits.has(d.id)).classed("faded", (d) => d.faded);
    marks();
    svg.classed("searching", dash.hits.size > 0);
    // Animate only the nodes whose size or colour changed.
    nodeSel.filter((d) => d.drawn !== d.r + d.color).each((d) => (d.drawn = d.r + d.color))
      .select("circle.core").transition().duration(motionMs(800)).attr("r", (d) => d.r)
      .attr("fill", (d) => (d.hub ? "#262626" : d.color)).style("stroke", (d) => (d.hub ? d.color : null));
    nodeSel.filter((d) => d.hub).select("text.count").attr("fill", (d) => d.color);
    nodeSel.select("circle.ring").attr("r", (d) => d.r);
    nodeSel.filter((d) => d.hub).select("text.count").text((d) => d.open || "");
    hlabelSel = hlabelG.selectAll("text.name").data(want.filter((d) => d.hub), (d) => d.id)
      .join((enter) => enter.append("text").attr("class", "name").attr("text-anchor", "middle"))
      .attr("data-key", (d) => d.id)
      .each(function (d) { if (this.textContent !== d.p.name || d.lw == null) { this.textContent = d.p.name; d.lw = this.getComputedTextLength() / 2; moved = true; } });
    hlabelSel.classed("faded", (d) => d.faded);
    tlabelSel = tlabelG.selectAll("text.label").data(want.filter((d) => !d.hub), (d) => d.id)
      .join((enter) => enter.append("text").attr("class", "label off").attr("text-anchor", "middle"))
      .attr("data-key", (d) => d.id)
      // Measuring text forces a layout: only for labels whose text changed.
      .classed("faded", (d) => d.faded)
      .each(function (d) { const s = trunc(d.t.title, 34); if (this.textContent !== s || d.tw == null) { this.textContent = s; d.tw = this.getComputedTextLength(); } });

    if (!moved) { placeLabels(); return; }
    want.forEach((n) => (n.placedR = n.r));
    sim.nodes(want);
    sim.force("link").links(links);
    sim.alpha(Math.max(sim.alpha(), added ? 0.25 : 0.12)).restart();
  }

  function tick() {
    if (fitted < 3 && sim.alpha() < 0.3) { fitted++; fit(true); }
    linkSel.attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y).attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
    nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    hlabelSel.attr("x", (d) => d.x).attr("y", (d) => d.y + d.r + 3 + HUB_FONT);
    placeLabels();
  }
  function dragStart(e, d) { if (!e.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; }
  function dragged(e, d) { d.fx = e.x; d.fy = e.y; }
  function dragEnd(e, d) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }
  function hubClick(d) { select(d.id); }
  function setFocus(slugs) {
    focus.clear();
    slugs.forEach((x) => focus.add(x));
    saveFilters();
    render();
    focusChanged();
  }
  // Toggle one project. With everything shown, the first toggle focuses it.
  function toggleFocus(slug) {
    updateEff();
    if (eff.has(slug)) focus.delete(slug);
    else focus.add(slug);
    // Keep stale (unknown) slugs from deciding what an empty focus means.
    for (const x of [...focus]) if (!state.projects.some((p) => p.slug === x)) focus.delete(x);
    setFocus([...focus]);
  }
  const focusChanged = () => document.dispatchEvent(new CustomEvent("hd-focus"));
  const projColor = (slug) => HUB_COLORS[Math.max(0, state.projects.findIndex((p) => p.slug === slug)) % HUB_COLORS.length];

  const tip = $("#tip");
  function showTip(e, d) {
    tip.replaceChildren();
    if (d.hub) {
      tip.append(el("div", { class: "tt", text: d.p.name }), el("div", { class: "sub", text: d.p.summary || "no threads" }));
      if (d.p.goal) tip.append(el("div", { text: d.p.goal }));
      const co = d.p.coordinator;
      if (co) tip.append(el("div", { class: "s-" + co.state, text: "Coordinator: " + (COORD[co.state] || co.state) + (co.activity ? " · " + co.activity : "") }));
      if (co?.prompt) tip.append(el("div", { class: "s-blocked", text: co.prompt.summary }));
    } else {
      const t = d.t;
      tip.append(el("div", { class: "tt", text: t.title }),
        el("div", { class: "s-" + t.state, text: STATES[t.state]?.label + (t.activity ? " · " + t.activity : "") }),
        el("div", { class: "sub", text: `${t.key} · ${t.agent || "?"} · ${ago(t.last_activity)}` }));
      if (t.prompt) tip.append(el("div", { class: "s-blocked", text: t.prompt.summary }));
    }
    tip.append(el("div", { class: "sub hint", text: d.hub ? "Ctrl/Shift+click: add to or remove from focus" : "Shift+click: open in a window" }));
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
      el("button", { class: filters.state === s ? "active" : "", "aria-pressed": String(filters.state === s), "aria-label": `${STATES[s].label}: ${counts.get(s)} threads`, title: "Filter: " + STATES[s].label, onclick: () => {
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
    return state.threads.filter((t) => t.needs_you && inFocus(t.project) && (mode === "all" || (mode === "parked") === parked(t))).concat(coords)
      .sort((a, b) => rank(a) - rank(b) || ageSec(a) - ageSec(b));
  }
  function coordItems() {
    return state.projects.filter((p) => p.coordinator?.needs_you && inFocus(p.slug)).map((p) => ({
      key: "hub:" + p.slug, project: p.slug, coord: true, needs_you: true, state: p.coordinator.state,
      title: "Coordinator" + (p.coordinator.activity ? " · " + p.coordinator.activity : ""), last_activity: p.coordinator.last_activity, prompt: p.coordinator.prompt,
    }));
  }

  function renderNeeds() {
    const list = needsList();
    const hidden = state.threads.filter((t) => t.needs_you && inFocus(t.project)).length + coordItems().length - list.length;
    const names = Object.fromEntries(state.projects.map((p) => [p.slug, p.name]));
    $("#needs-n").textContent = (list.length || "") + (hidden > 0 && $("#needs-filter").value === "active" ? ` (+${hidden} parked)` : "");
    const by = d3.group(list, (t) => t.state);
    for (const k of [...picked]) if (!list.some((t) => t.key === k)) picked.delete(k);
    $("#needs").replaceChildren(...STRIP.filter((s) => by.get(s)).map((s) => {
      const ts = by.get(s);
      const closed = collapsed.has(s);
      const head = el("button", { class: "group-head", "aria-expanded": String(!closed), "aria-label": `${STATES[s].label}: ${ts.length} items. ${closed ? "Show" : "Hide"} group`, title: (closed ? "Show " : "Hide ") + STATES[s].label,
        onclick: () => { closed ? collapsed.delete(s) : collapsed.add(s); localStorage.setItem("hd-collapsed", JSON.stringify([...collapsed])); renderNeeds(); } },
        el("span", { class: "dot", style: `background:${STATES[s].color}` }), el("span", { class: "lbl", text: STATES[s].label }), el("span", { class: "n", text: ts.length }), el("span", { class: "caret", text: closed ? "▸" : "▾" }));
      return el("div", { class: "group " + s + (closed ? " collapsed" : ""), "data-state": s }, head,
        ...(closed ? [] : ts.map((t) => chipWith(t, el("button", {
          class: "chip " + t.state + (t.coord ? " coord" : "") + (picked.has(t.key) ? " picked" : "") + (!t.coord && parked(t) ? " parked" : ""), "data-key": t.key,
          "aria-pressed": selecting && !t.coord ? String(picked.has(t.key)) : null,
          title: `${STATES[t.state].label}: ${t.title}${t.acked ? " (acked)" : ""}${isSnoozed(t) ? " (snoozed)" : ""}`,
          onclick: () => {
            if (selecting) {
              if (t.coord) return; // nothing to ack on a coordinator
              picked.has(t.key) ? picked.delete(t.key) : picked.add(t.key); renderNeeds(); return;
            }
            if (t.coord) { select(t.key); return; }
            // Make sure the node is visible before selecting it.
            if (!visible(t)) clearFilters(true, true);
            select(t.key);
          },
        }, el("span", { class: "dot", style: `background:${STATES[t.state].color}` }), el("span", { class: "proj", text: names[t.project] || t.project }), el("span", { class: "t", text: t.title }),
          t.prompt ? el("span", { class: "psum", text: t.prompt.summary }) : null)))));
    }));
    $("#bulk-ack").hidden = $("#bulk-snooze").hidden = !selecting;
    $("#bulk-ack").textContent = `Ack selected (${picked.size})`;
    $("#bulk-snooze").textContent = `Snooze 1 day (${picked.size})`;
    $("#bulk-ack").disabled = $("#bulk-snooze").disabled = !picked.size;
  }

  // A chip with a prompt gets an Answer button beside it: a popover with
  // the prompt card, without opening the panel.
  // Every chip gets a window button (the thread's chat in a floating window);
  // one with a prompt also an Answer button (its dialog window).
  function chipWith(t, chip) {
    if (selecting) return chip;
    const win = el("button", { class: "chip-win", "data-key": t.key, title: "Open in a window", "aria-label": "Open " + t.title + " in a window", text: "⧉",
      onclick: () => window.HDThreadWin?.open(t.key) });
    if (!t.prompt || readOnly) return el("span", { class: "chipwrap" }, chip, win);
    return el("span", { class: "chipwrap" }, chip, el("button", { class: "chip-answer", "data-key": t.key, title: "Answer: " + t.prompt.summary, text: "Answer",
      onclick: () => window.HDPrompt?.pop(t.key) }), win);
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

  // confirmed: the caller already asked (voice confirmation).
  async function resolveKey(key, confirmed = false) {
    const t = state.threads.find((x) => x.key === key);
    const ok = confirmed || await confirmDlg(`Resolve ${key}${t ? ` (“${t.title}”)` : ""}? herdr-projects copies its files home, then removes its worktree, merged branch and tab. Reports and library are kept.`, [], "Resolve");
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
      proj.value = eff.size === 1 ? [...eff][0] : "";
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
    $("#f-state").value = filters.state || "";
    $("#f-window").value = filters.window || "";
    $("#f-search").value = filters.q || "";
  }

  // ---------------------------------------------------------------- focus picker
  // A checkbox list of projects (type to filter), All / None / Only this,
  // and a fade-or-hide toggle. P opens it; on phones it is a bottom sheet.
  const picker = $("#proj-picker");
  const pickerOpen = () => !picker.hidden;
  let rowsKey = "";
  function renderFocus() {
    const n = eff.size, total = state.projects.length;
    const names = Object.fromEntries(state.projects.map((p) => [p.slug, p.name]));
    const btn = $("#f-project");
    const label = !n || n === total ? "All projects" : n === 1 ? names[[...eff][0]] : `${n} projects`;
    if (btn.firstChild?.textContent !== label) btn.replaceChildren(el("span", { class: "fl", text: label }), el("span", { class: "caret", "aria-hidden": "true", text: "▾" }));
    btn.classList.toggle("on", n > 0 && n < total);
    btn.setAttribute("aria-label", "Project focus: " + (n && n < total ? [...eff].map((x) => names[x]).join(", ") : "all projects") + ". Press P");
    // A chip per focused project: the name goes there on the map (again:
    // opens its coordinator), × removes it. Fit all frames them all.
    const want = n && n < total ? orderedFocus().filter((x) => eff.has(x)) : [];
    const box = $("#focus-chips");
    if (box.dataset.k !== want.join(",") + "|" + want.map((x) => names[x]).join(",")) {
      box.dataset.k = want.join(",") + "|" + want.map((x) => names[x]).join(",");
      if (litSlug) light(null); // a chip under the pointer may be gone
      box.replaceChildren(...want.map((x) => el("span", { class: "fchip", "data-slug": x, style: `--c:${projColor(x)}` },
        el("button", { type: "button", class: "fgo", title: `Go to ${names[x]} on the map (click again: open its coordinator)`,
          "aria-label": `Go to ${names[x]} on the map. Again: open its coordinator. Delete: remove from focus` },
        el("span", { class: "dot" }), el("span", { class: "fn", text: names[x] })),
        el("button", { type: "button", class: "fx", tabindex: "-1", title: "Remove from focus", "aria-label": `Remove ${names[x]} from focus`, text: "×", onclick: () => toggleFocus(x) }))),
      el("button", { type: "button", id: "fit-focus", class: "fitall", title: "Fit every focused project in view", text: "Fit all" }));
    }
    box.hidden = !want.length;
    if (pickerOpen()) renderPicker();
  }
  function renderPicker() {
    const key = state.projects.map((p) => p.slug + "\u0000" + p.name).join("\u0001");
    const list = $("#pp-list");
    if (key !== rowsKey) {
      rowsKey = key;
      list.replaceChildren(...state.projects.map((p) => el("div", { class: "prow", role: "checkbox", tabindex: "0", "data-slug": p.slug, "aria-checked": "false", style: `--c:${projColor(p.slug)}` },
        el("span", { class: "box", "aria-hidden": "true" }), el("span", { class: "dot" }), el("span", { class: "pn", text: p.name }), el("span", { class: "pc" }),
        el("button", { type: "button", class: "ponly", tabindex: "-1", title: "Focus on this project only", text: "Only" }),
        el("button", { type: "button", class: "pgo", tabindex: "-1", title: "Go to this project on the map (G)", "aria-label": "Go to " + p.name, text: "Go" }))));
      filterRows();
    }
    const counts = d3.rollup(state.threads, (v) => v.filter((t) => t.state !== "resolved").length, (t) => t.project);
    for (const r of list.children) {
      const on = eff.has(r.dataset.slug);
      if (r.getAttribute("aria-checked") !== String(on)) r.setAttribute("aria-checked", String(on));
      const c = String(counts.get(r.dataset.slug) || "");
      const pc = r.querySelector(".pc");
      if (pc.textContent !== c) { pc.textContent = c; pc.title = c ? c + " open threads" : ""; }
    }
    $("#pp-fade").checked = !!filters.fade;
    $("#pp-note").textContent = eff.size ? `${eff.size} of ${state.projects.length} in focus` : "Nothing ticked: all projects show";
  }
  function filterRows() {
    const q = $("#pp-filter").value.trim().toLowerCase();
    for (const r of $("#pp-list").children) r.hidden = !!q && !(r.dataset.slug + " " + r.querySelector(".pn").textContent).toLowerCase().includes(q);
  }
  const shownRows = () => [...$("#pp-list").children].filter((r) => !r.hidden);
  function openPicker(viaKey) {
    if (pickerOpen()) return;
    picker.hidden = false;
    $("#f-project").setAttribute("aria-expanded", "true");
    document.body.classList.add("picking");
    $("#pp-filter").value = "";
    renderPicker();
    filterRows();
    if (viaKey || !matchMedia("(pointer: coarse)").matches) $("#pp-filter").focus();
  }
  function closePicker(refocus) {
    if (!pickerOpen()) return;
    picker.hidden = true;
    light(null);
    $("#f-project").setAttribute("aria-expanded", "false");
    document.body.classList.remove("picking");
    if (refocus || picker.contains(document.activeElement)) $("#f-project").focus({ preventScroll: true });
  }
  // Chips: click goes (again: opens the coordinator), hover/focus lights,
  // Delete/Backspace remove, arrows move; on touch a long-press removes.
  function initChips() {
    const box = $("#focus-chips");
    const gos = () => [...box.querySelectorAll(".fgo")];
    const slugOf = (e) => e.target.closest?.(".fgo") && e.target.closest(".fchip").dataset.slug;
    let press = null, swallow = 0;
    function remove(slug, refocus) {
      const g = gos(), i = g.findIndex((b) => b.closest(".fchip").dataset.slug === slug);
      const next = (g[i + 1] || g[i - 1])?.closest(".fchip").dataset.slug;
      toggleFocus(slug);
      if (refocus) (box.querySelector(`.fchip[data-slug="${CSS.escape(next || "")}"] .fgo`) || $("#f-project")).focus({ preventScroll: true });
    }
    box.addEventListener("click", (e) => {
      if (e.target.closest("#fit-focus")) return fitFocus();
      const slug = slugOf(e);
      if (!slug) return;
      if (Date.now() < swallow) return; // the click that ends a long-press
      if (lastGo === slug) { lastGo = null; select("hub:" + slug); } else goToProject(slug);
    });
    box.addEventListener("keydown", (e) => {
      const slug = slugOf(e);
      if (!slug) return;
      const g = gos(), i = g.indexOf(e.target.closest(".fgo"));
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(slug, true); }
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); g[Math.min(g.length - 1, i + 1)].focus(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); g[Math.max(0, i - 1)].focus(); }
    });
    box.addEventListener("mouseover", (e) => light(slugOf(e) || null));
    box.addEventListener("mouseleave", () => light(null));
    box.addEventListener("focusin", (e) => light(slugOf(e) || null));
    box.addEventListener("focusout", (e) => { if (!box.contains(e.relatedTarget)) light(null); });
    box.addEventListener("pointerdown", (e) => {
      const slug = slugOf(e);
      if (!slug || e.pointerType === "mouse") return;
      clearTimeout(press?.t);
      press = { x: e.clientX, y: e.clientY, t: setTimeout(() => { press = null; swallow = Date.now() + 800; navigator.vibrate?.(15); remove(slug, false); }, 550) };
    });
    const cancel = () => { clearTimeout(press?.t); press = null; };
    box.addEventListener("pointerup", cancel);
    box.addEventListener("pointercancel", cancel);
    box.addEventListener("pointermove", (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel(); });
    box.addEventListener("contextmenu", (e) => { if (slugOf(e)) e.preventDefault(); });
  }
  function initNeedsLight() {
    const box = $("#needs");
    box.addEventListener("mouseover", (e) => { const k = e.target.closest?.("[data-key]")?.dataset.key; light(k ? k.replace(/^hub:/, "").split("/")[0] : null); });
    box.addEventListener("mouseleave", () => light(null));
  }
  function initPicker() {
    $("#f-project").addEventListener("click", () => (pickerOpen() ? closePicker() : openPicker(false)));
    $("#pp-done").addEventListener("click", () => closePicker(true));
    $("#pp-all").addEventListener("click", () => setFocus(state.projects.map((p) => p.slug)));
    $("#pp-none").addEventListener("click", () => setFocus([]));
    $("#pp-fade").addEventListener("change", (e) => { filters.fade = e.target.checked; saveFilters(); render(); });
    const list = $("#pp-list");
    list.addEventListener("click", (e) => {
      const r = e.target.closest(".prow");
      if (!r) return;
      if (e.target.closest(".pgo")) { closePicker(); goToProject(r.dataset.slug); }
      else if (e.target.closest(".ponly")) setFocus([r.dataset.slug]);
      else toggleFocus(r.dataset.slug);
    });
    list.addEventListener("keydown", (e) => {
      const r = e.target.closest(".prow");
      if (!r) return;
      const rows = shownRows(), i = rows.indexOf(r);
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleFocus(r.dataset.slug); }
      else if (e.key === "o" || e.key === "O") { e.preventDefault(); setFocus([r.dataset.slug]); }
      else if (e.key === "g" || e.key === "G") { e.preventDefault(); closePicker(); goToProject(r.dataset.slug); }
      else if (e.key === "ArrowDown") { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); (i > 0 ? rows[i - 1] : $("#pp-filter")).focus(); }
    });
    // Hovering or focusing a row lights its project on the map.
    const rowLight = (e) => light(e.target.closest?.(".prow")?.dataset.slug || null);
    list.addEventListener("mouseover", rowLight);
    list.addEventListener("focusin", rowLight);
    list.addEventListener("mouseleave", () => light(null));
    list.addEventListener("focusout", (e) => { if (!list.contains(e.relatedTarget)) light(null); });
    initChips();
    const input = $("#pp-filter");
    input.addEventListener("input", filterRows);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const r = shownRows()[0]; if (r) toggleFocus(r.dataset.slug); }
      else if (e.key === "ArrowDown") { e.preventDefault(); shownRows()[0]?.focus(); }
    });
    // Escape closes the picker before anything else (panel, search box).
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pickerOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closePicker(true); }
    }, true);
    document.addEventListener("pointerdown", (e) => { if (pickerOpen() && !e.target.closest("#focus-box")) closePicker(); });
    // P opens the picker (not while typing or with a dialog open).
    document.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() !== "p" || e.ctrlKey || e.altKey || e.metaKey || $("#dlg").open) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (document.querySelector("#voice-help:not([hidden]), #voice-settings:not([hidden])")) return;
      e.preventDefault();
      pickerOpen() ? closePicker(true) : openPicker(true);
    });
  }

  function renderErrors() {
    const box = $("#errors");
    box.hidden = !state.errors.length;
    box.textContent = state.errors.slice(0, 3).join("\n");
  }

  function render() {
    updateEff();
    const threads = state.threads.filter(visible);
    $("#reset-filters").hidden = !anyFilter();
    $("#graph-empty").hidden = threads.length > 0;
    renderFocus();
    renderLegend(threads);
    renderNeeds();
    renderErrors();
    renderGraph(state.threads.filter(drawn));
    if (selected) isHub(selected) ? refreshCoordHeader() : refreshPanelHeader();
    window.HDPrompt?.onState(state);
  }

  // ---------------------------------------------------------------- dock
  // The panel docks right (default), left or bottom, with a size kept per
  // position. Phones always get the bottom sheet (CSS hides the controls).
  const work = $("#work");
  const splitter = $("#splitter");
  const DOCKS = ["right", "left", "bottom"];
  const dock = { pos: "right" };
  try { Object.assign(dock, JSON.parse(localStorage.getItem("hd-dock") || "{}")); } catch {}
  if (!DOCKS.includes(dock.pos)) dock.pos = "right";
  const saveDock = () => localStorage.setItem("hd-dock", JSON.stringify(dock));
  const vertical = () => dock.pos === "bottom";
  // [min, max] panel size: never so small it is useless, nor so big the graph vanishes.
  function dockLimits() {
    const r = work.getBoundingClientRect();
    return vertical() ? [160, Math.max(160, Math.min(r.height * 0.8, r.height - 120))]
      : [320, Math.max(320, Math.min(r.width * 0.75, r.width - 280))];
  }
  const clampSize = (px) => { const [lo, hi] = dockLimits(); return Math.round(Math.min(hi, Math.max(lo, px))); };
  function applyDock() {
    for (const p of DOCKS) {
      document.body.classList.toggle("dock-" + p, p === dock.pos);
      $("#dock-" + p).setAttribute("aria-pressed", String(p === dock.pos));
    }
    splitter.setAttribute("aria-orientation", vertical() ? "horizontal" : "vertical");
    const want = +dock[dock.pos] || (vertical() ? innerHeight * 0.4 : 480);
    work.style.setProperty("--panel-size", clampSize(want) + "px");
  }
  function resizePanel(px) {
    dock[dock.pos] = clampSize(px);
    work.style.setProperty("--panel-size", dock[dock.pos] + "px");
  }
  const panelPx = () => parseFloat(work.style.getPropertyValue("--panel-size")) || 480;
  $("#dock").addEventListener("click", (e) => {
    const b = e.target.closest(".dockbtn");
    if (!b) return;
    dock.pos = b.dataset.pos;
    saveDock();
    applyDock();
  });
  // Drag the splitter; the panel grows toward the graph.
  splitter.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    const start = panelPx(), x0 = e.clientX, y0 = e.clientY, sign = dock.pos === "left" ? 1 : -1;
    const move = (ev) => resizePanel(start + (vertical() ? y0 - ev.clientY : sign * (ev.clientX - x0)));
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      splitter.removeEventListener("pointercancel", up);
      document.body.classList.remove("dragging");
      saveDock();
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
    splitter.addEventListener("pointercancel", up);
  });
  splitter.addEventListener("keydown", (e) => {
    const grow = { right: ["ArrowLeft", "ArrowRight"], left: ["ArrowRight", "ArrowLeft"], bottom: ["ArrowUp", "ArrowDown"] }[dock.pos];
    const d = e.key === grow[0] ? 24 : e.key === grow[1] ? -24 : 0;
    if (!d) return;
    e.preventDefault();
    resizePanel(panelPx() + d);
    saveDock();
  });
  splitter.addEventListener("dblclick", () => { delete dock[dock.pos]; saveDock(); applyDock(); });
  // D cycles right, left, bottom: a way back that nothing on screen can cover.
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "d" || e.ctrlKey || e.altKey || e.metaKey || $("#dlg").open) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    e.preventDefault();
    dock.pos = DOCKS[(DOCKS.indexOf(dock.pos) + 1) % DOCKS.length];
    saveDock();
    applyDock();
  });
  window.addEventListener("resize", applyDock);
  applyDock();

  // ---------------------------------------------------------------- panel
  const panel = $("#panel");
  $("#close").addEventListener("click", () => select(null));
  $("#pop-out").addEventListener("click", () => { if (selected) window.HDThreadWin?.open(selected); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("#dlg").open || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    select(null);
  });
  // "Minimise all" (static/windows.js) closes the panel; "Restore all"
  // reopens what it showed, if that thread or project is still there.
  window.HDWin?.panel("side", {
    hide() { const k = selected; if (k) select(null); return k; },
    show(k) {
      const there = isHub(k) ? state.projects.some((p) => "hub:" + p.slug === k) : state.threads.some((t) => t.key === k);
      if (typeof k === "string" && there && selected !== k) dash.open(k);
    },
  });
  let screenES = null;
  let live = ""; // live status of the open panel's pane, from its screen stream
  const isHub = (key) => key.startsWith("hub:");

  function select(key) {
    selected = key;
    nodeSel.classed("selected", (d) => d.id === key);
    placeLabels();
    stopFeeds();
    live = "";
    coordDetail = null;
    promptCtl = null;
    if (!key) {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
      splitter.hidden = true;
      return;
    }
    const n = nodes.get(key);
    // Phones: the sheet covers the lower part, so lift the node above it.
    // Desktop: the graph re-fits beside the panel; only a zoomed-in view pans.
    if (n && innerWidth <= 700) svg.transition().duration(motionMs(600)).call(zoom.translateTo, n.x, n.y + 150);
    else if (n && userZoomed) svg.transition().duration(motionMs(600)).call(zoom.translateTo, n.x, n.y);
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    splitter.hidden = false;
    panel.scrollTop = $("#panel-body").scrollTop = 0;
    if (isHub(key)) {
      const slug = key.slice(4);
      buildCoordPanel(slug);
      loadProject(slug);
      startFeeds(key);
      return;
    }
    buildPanel(key);
    loadDetail(key);
    startFeeds(key);
  }

  // The open panel's feeds: its details every 10s and the screen stream.
  // Each costs the server pane reads, so they stop while the page is hidden.
  function startFeeds(key) {
    stopFeeds();
    if (isHub(key)) {
      const slug = key.slice(4);
      detailTimer = setInterval(() => loadProject(slug), 10000);
      // Always streamed while open: the server re-identifies the pane on each
      // read, so a coordinator that starts later shows up, and none is guessed.
      screenES = new EventSource(`/api/project/${encodeURIComponent(slug)}/screen`);
      screenES.addEventListener("screen", (e) => { if (selected === key) showScreen(JSON.parse(e.data)); });
      return;
    }
    detailTimer = setInterval(() => loadDetail(key), 10000);
    const t = state.threads.find((x) => x.key === key);
    if (t && t.pane_alive && t.state !== "resolved") {
      // The screen streams over SSE: every few seconds, faster after a send.
      screenES = new EventSource(tpath(key, "screen"));
      screenES.addEventListener("screen", (e) => { if (selected === key) showScreen(JSON.parse(e.data)); });
    }
  }
  function stopFeeds() {
    clearInterval(detailTimer);
    screenES?.close();
    screenES = null;
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
      el("section", { class: "session-details", "aria-label": "Session details" }),
      el("div", { id: "p-actions", class: "w" }),
      el("dl", { class: "meta", id: "p-meta" }),
      buildChat(t),
      el("div", { id: "p-next" }),
      el("section", { id: "p-timeline", "aria-label": "Timeline" }, el("h3", { text: "Timeline" }), el("div", { id: "p-tl" })),
      // The report lives mainly in the coordinator panel; here it is a one-liner.
      el("details", { id: "p-report-box", class: "fold" },
        el("summary", {}, el("span", { class: "fold-h", text: "Latest report" }), el("span", { class: "preview" })),
        el("div", { class: "md", id: "p-report", text: "…" })),
      el("h3", { text: "Task" }), el("div", { class: "md", id: "p-task", text: "…" }),
      el("h3", { text: "Jump to it" }), el("div", { id: "p-jump" }),
    );
    window.HDThreads?.mountThread($("#p-tl"), key);
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
    const att = attach(input, () => state.threads.find((x) => x.key === key)?.images);
    const go = () => sendChat(key, input, send, att);
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    box.append(
      promptBox(key),
      screenBox(tpath(key, "history"), key),
      el("div", { class: "quick w", hidden: "" }, el("span", { class: "muted", text: "Keys:" }),
        ...QUICK.map(([k, label]) => el("button", { class: "tbtn", "data-key": k, title: "Press " + k, text: label, onclick: () => pressKeys(key, [k]) }))),
      att?.tray,
      el("div", { class: "chat-row" }, input, att?.button, send),
      el("div", { id: "chat-log" }),
    );
    return box;
  }

  // attach adds images to a chat box (static/attach.js); support() is the
  // target's `images` from the state.
  function attach(input, support) {
    return window.HDAttach ? HDAttach.mount(input, () => support() || { ok: false }) : null;
  }
  const sentLine = (text, n) => "Sent: " + text + (n ? `${text ? " " : ""}(+${n} image${n > 1 ? "s" : ""})` : "");

  // The open panel's prompt card (static/prompts.js), above its screen: fed
  // by the screen stream, which carries the parsed prompt of a blocked pane.
  let promptCtl = null;
  function promptBox(key) {
    const box = el("div", { id: "p-prompt" });
    promptCtl = window.HDPrompt ? window.HDPrompt.mount(box, key, { id: "prompt-card" }) : null;
    return box;
  }

  // The open panel's screen box (static/scrollback.js): the live stream's
  // tails merge into a longer buffer, earlier lines load on scroll up.
  let screen = null;
  function screenBox(historyURL, key) {
    screen = HDScrollback.box((n) => `${historyURL}?lines=${n}`, () => selected === key);
    return screen.el;
  }

  // The newest lines are at the bottom: the box stays pinned there unless the
  // reader scrolled up, and re-pins once they scroll back down.
  function showScreen(d) {
    const box = $("#p-chat");
    if (!box?.querySelector(".screen") || !screen) return;
    screen.live(d.screen);
    live = d.live_status || "";
    const blocked = live === "blocked";
    promptCtl?.update(blocked ? d.prompt : null);
    if (isHub(selected || "")) {
      coordNote(d.pane_alive, blocked);
      const q = box.querySelector(".quick");
      if (q) q.hidden = !blocked;
      return;
    }
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

  async function sendChat(key, input, btn, att) {
    const text = input.value.trim();
    const n = att?.count() || 0;
    if ((!text && !n) || btn.disabled) return;
    btn.disabled = true;
    try {
      if (live === "blocked") {
        // A question/permission menu is up: type the answer, then Enter.
        if (n) { att.error("The agent is waiting on a prompt: answer it first; images go with a normal message."); return; }
        if ((await pressKeys(key, ["enter"], text)).ok) input.value = "";
        return;
      }
      chatMsg("Sending…", "pending");
      const r = await api(tpath(key, "prompt"), n ? { text, images: await att.images() } : { text });
      $("#chat-log .pending")?.remove();
      if (selected !== key) return;
      if (r.ok) { input.value = ""; att?.clear(); chatMsg(sentLine(text, n), "ok"); return; }
      const code = r.data.code;
      if (code === "prompt_unconfirmed") {
        // Typed, but not seen starting: it may sit in the input box. Never resend.
        input.value = "";
        att?.clear();
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
    const att = attach(input, () => state.projects.find((x) => x.slug === slug)?.coordinator?.images);
    const go = () => sendCoord(slug, input, send, att);
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    body.replaceChildren(
      el("div", { class: "proj", text: `Project · ${slug}` }),
      el("h2", { class: "title", text: p.name }),
      el("div", { id: "p-head" }),
      el("section", { id: "p-tv-box", "aria-label": "Threads" }, el("h3", { text: "Threads" }), el("div", { id: "p-tv" })),
      el("section", { class: "session-details", "aria-label": "Session details" }),
      el("div", { id: "p-actions" }),
      el("dl", { class: "meta", id: "p-meta" }),
      el("section", { id: "p-chat" }, el("h3", { text: "Coordinator" }),
        promptBox("hub:" + slug),
        screenBox(`/api/project/${encodeURIComponent(slug)}/history`, "hub:" + slug),
        el("div", { class: "quick w", hidden: "" }, el("span", { class: "muted", text: "Keys:" }),
          ...QUICK.map(([k, label]) => el("button", { class: "tbtn", "data-key": k, title: "Press " + k, text: label, onclick: () => coordKeys(slug, [k]) }))),
        el("div", { id: "coord-note" }),
        att?.tray,
        el("div", { class: "chat-row" }, input, att?.button, send),
        el("div", { id: "chat-log" })),
      el("h3", { text: "Thread reports" }), el("div", { id: "p-reports", text: "…" }),
      el("h3", { text: "Tasks" }), el("div", { class: "md", id: "p-tasks", text: "…" }),
      el("details", { id: "p-memory", class: "fold" }, el("summary", {}, el("span", { class: "fold-h", text: "Memory index" })), el("div", { class: "md", id: "p-memory-md" })),
      el("h3", { text: "Jump to it" }), el("div", { id: "p-jump" }),
    );
    window.HDThreads?.mount($("#p-tv"), slug);
    refreshCoordHeader();
    coordNote(!!p.coordinator?.pane_id, p.coordinator?.state === "blocked");
  }

  // Messages go through `coordinator prompt`. herdr-projects has no key
  // command for coordinators: a blocked one is answered with `herdr pane
  // send-keys` on its verified pane (server-side checks, actions.go).
  async function coordKeys(slug, keys) {
    const r = await api(`/api/project/${encodeURIComponent(slug)}/keys`, { keys });
    if (selected !== "hub:" + slug) return r;
    if (r.ok) chatMsg(`Pressed ${keys.join(" ")}`, "ok");
    else chatMsg(r.data.error || "HTTP " + r.status, "err");
    return r;
  }

  function coordNote(alive, blocked) {
    const box = $("#coord-note");
    if (!box) return;
    const slug = selected.slice(4);
    const sig = `${alive}/${blocked}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (!alive) box.replaceChildren(el("p", { class: "msg warn no-pane", text: `No live pane: no coordinator pane could be identified for this project. “herdr-projects open ${slug}” starts one (Jump below).` }));
    else if (blocked) box.replaceChildren(el("p", { class: "msg warn note", text: "The coordinator is waiting on a prompt in its pane: answer it with the card or the keys above (pressed with herdr in its verified pane; trust screens stay in the pane)." }));
    else box.replaceChildren(el("p", { class: "muted note", text: "Messages go through herdr-projects. When the coordinator waits on a prompt, it can be answered here." }));
  }

  async function sendCoord(slug, input, btn, att) {
    const key = "hub:" + slug;
    const text = input.value.trim();
    const n = att?.count() || 0;
    if ((!text && !n) || btn.disabled) return;
    btn.disabled = true;
    chatMsg("Sending…", "pending");
    const r = await api(`/api/project/${encodeURIComponent(slug)}/coordinator`, n ? { text, images: await att.images() } : { text });
    btn.disabled = false;
    $("#chat-log .pending")?.remove();
    if (selected !== key) return;
    if (r.ok) { input.value = ""; att?.clear(); chatMsg(sentLine(text, n), "ok"); }
    else chatMsg(r.data.error || "HTTP " + r.status, "err"); // kept in the box for a retry
  }

  function refreshCoordHeader() {
    const slug = selected.slice(4);
    const p = state.projects.find((x) => x.slug === slug);
    if (!p || !$("#p-head")) return;
    const co = p.coordinator || { state: "none" };
    coordNote(!!co.pane_id, co.state === "blocked");
    renderSession(co.session);
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
    const only = eff.size === 1 && eff.has(slug), has = eff.has(slug);
    acts.replaceChildren(
      el("button", { class: "tbtn" + (only ? " on" : ""), "data-act": "filter", text: only ? "Showing only this project" : "Show only this project", onclick: () => { setFocus(only ? [] : [slug]); refreshCoordHeader(); } }),
      el("button", { class: "tbtn" + (has ? " on" : ""), "data-act": "focus", "aria-pressed": String(has), text: has ? "Remove from focus" : "Add to focus", onclick: () => { toggleFocus(slug); refreshCoordHeader(); } }));
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

  function renderSession(d = {}) {
    const box = document.querySelector(".session-details");
    if (!box) return;
    const sig = JSON.stringify(d);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const fields = [["Provider", d.provider], ["Model", d.model], ["Effort", d.effort], ["Context window", d.context_window]];
    box.replaceChildren(el("h3", { text: "Session details" }),
      el("div", { class: "muted session-profile", text: d.profile ? "Configured profile: " + d.profile : "Configured profile: unknown" }),
      el("dl", { class: "session-grid" }, ...fields.flatMap(([label, f = {}]) => {
        const value = f.tokens > 0 ? f.tokens.toLocaleString() + " tokens" : f.value || "Unknown";
        const source = f.source === "session_variant" ? "OpenCode session variant" : f.source === "session" ? "Observed in session" : f.source === "profile" ? "Configured profile" : f.source === "config" ? "Harness config fallback" : "Unavailable";
        return [el("dt", { text: label }), el("dd", { title: f.reason || source }, el("span", { text: value }), el("small", { text: source }))];
      })));
  }

  function refreshPanelHeader() {
    const t = state.threads.find((x) => x.key === selected);
    if (!t || !$("#p-head")) return;
    renderSession(t.session);
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
    window.HDSystem?.state();
    window.HDThreads?.state();
  }
  let stream = null;
  function connect() {
    stream?.close();
    const es = (stream = new EventSource("/api/events"));
    es.addEventListener("state", (e) => { $("#live").className = "live on"; const s = JSON.parse(e.data); checkBuild(s.build); apply(s); });
    es.addEventListener("system", (e) => window.HDSystem?.frame(JSON.parse(e.data)));
    es.onerror = () => { $("#live").className = "live off"; };
  }
  // A hidden page parses and draws nothing: the stream closes (the server
  // sends a full snapshot on reconnect) and so do the open panel's feeds.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stream?.close();
      stream = null;
      stopFeeds();
      $("#live").className = "live paused";
      return;
    }
    connect();
    if (selected) {
      isHub(selected) ? loadProject(selected.slice(4)) : loadDetail(selected);
      startFeeds(selected);
    }
  });

  // After an install the server restarts with a new frontend: the stream
  // reconnects with a new build id. Say so, and reload once nobody is
  // typing (text in a visible field, a focused field, a dialog, dictation).
  let build = null, updateTimer = null;
  function checkBuild(b) {
    if (!b) return;
    if (build === null) build = b;
    if (b === build || updateTimer) return;
    const t = el("div", { class: "toast update", role: "status", title: "A new version is installed: click to reload now", text: "Updated — reload" });
    t.addEventListener("click", () => location.reload());
    $("#toasts").append(t);
    updateTimer = setInterval(() => { if (idleForReload()) location.reload(); }, 1000);
  }
  function idleForReload() {
    const a = document.activeElement;
    if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return false;
    if ($("#dlg").open || document.querySelector(".dictating, .recording, #voice-fab.listening, #voice-hud .confirm")) return false;
    return ![...document.querySelectorAll("input, textarea")].some((f) =>
      !/^(checkbox|radio|button|submit|range|color|hidden)$/.test(f.type) && f.value.trim() && f.getClientRects().length);
  }

  // Open a thread or hub panel, clearing filters that hide its node.
  dash.open = (key) => {
    const t = state.threads.find((x) => x.key === key);
    if (t && !drawn(t)) { clearFilters(false); focusChanged(); }
    select(key);
  };
  dash.render = () => render();
  dash.inFocus = (slug) => inFocus(slug);
  dash.goProject = (slug) => goToProject(slug);
  dash.light = (slug) => light(slug || null);
  dash.state = () => state;
  dash.STATES = STATES;
  dash.safeHTML = safeHTML;
  // The page's hooks for static/voice.js (and other add-ons).
  window.hd = {
    state: () => state,
    selected: () => selected,
    select,
    needs: needsList,
    visible,
    focus: () => [...eff],
    setFocus,
    clearFilters: () => { clearFilters(); focusChanged(); },
    ack: (key) => ackKeys([key]),
    resolve: (key) => resolveKey(key, true),
    dock: (pos) => { if (DOCKS.includes(pos)) { dock.pos = pos; saveDock(); applyDock(); } },
    toast,
    promptFor: (key) => window.HDPrompt?.promptFor(key) || null,
    answerPrompt: (key, i, text) => window.HDPrompt?.answerPrompt(key, i, text),
  };

  size();
  initFilters();
  initTriage();
  fetch("/api/config").then((r) => r.json()).then((c) => { readOnly = c.read_only; document.body.classList.toggle("ro", readOnly); }).catch(() => {});
  connect();
  // Recency drives node size; nudge it as time passes even without changes.
  setInterval(() => { if (state.threads.length && !document.hidden) render(); }, 60000);
})();
