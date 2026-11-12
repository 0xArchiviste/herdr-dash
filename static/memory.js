// herdr-dash Memory map: a zoomable treemap of what holds memory on the
// machine, in an HDWin window. Machine → project → thread or coordinator
// (or leftover, orphan pane) → agent process → its child processes; Dash and
// its voice sidecar in a group of their own; every process outside a herdr
// pane in "Not herdr", grouped by name. Area is memory (PSS where it could be
// read, else RSS; RSS on demand), colour the owner's state, as on the graph.
//
// Click zooms one level in, the breadcrumb or Esc back out; hover shows a
// tooltip; double-click a thread or coordinator opens its window; a leftover
// tile has "Close leftover…" (the confirmed close of leftover.go, nothing
// else). Clicking a tile rings its node on the graph; selecting a node on the
// graph marks its tile. Phones get a sorted list with bars.
//
// Data: GET /api/memory/events (memory_http.go), open only while the window
// is on screen and the page visible: the server walks every process only
// then. The first event is the whole frame, then deltas. History (project
// sparklines, top growers) is GET /api/memory/history, at its own step (15 s).
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "style") e.style.cssText = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  };
  const SVG = "http://www.w3.org/2000/svg";
  const PHONE = 700;
  const HEAD = 17; // px of a group's header
  // The graph's state colours (app.js STATES), plus the map's own owners.
  const COLOR = {
    working: "#98bc37", waiting: "#fbb829", blocked: "#ef2f27", review: "#68a8e4", landing: "#2be4d0", idle: "#c8bca9",
    leftover: "#9a7fc4", resolved: "#4e4e4e", orphan: "#ff5c8f", coordinator: "#ff8700", dash: "#0aaeb3", pane: "#7a7a7a", other: "#4e4e4e",
  };
  const LABEL = {
    working: "Working", waiting: "Waiting on you", blocked: "Blocked", review: "Ready for review", landing: "Landing", idle: "Idle",
    leftover: "Leftover: resolved, agent still running", resolved: "Resolved", orphan: "Orphan agent pane", coordinator: "Coordinator",
    dash: "Herdr Dash", pane: "Other herdr pane", other: "Not herdr", project: "Project", machine: "Machine",
  };
  const LEGEND = ["working", "waiting", "blocked", "review", "landing", "idle", "coordinator", "leftover", "orphan", "dash", "pane", "other"];

  const GiB = 1024 ** 3;
  const gib = (b) => `${(b / GiB).toFixed(1)} GiB`;
  const bytes = (b) => (b >= GiB ? `${(b / GiB).toFixed(1)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.round(b / 1024)} kB`);
  function dur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h < 48 ? `${h}h ${m}m` : `${Math.floor(h / 24)}d`;
  }
  const st = () => window.hd?.state() || { projects: [], threads: [] };
  const phone = () => innerWidth <= PHONE;

  // ---------------------------------------------------------------- data
  let head = null; // MemHead
  const owners = new Map(); // tag -> MemOwner
  const procs = new Map(); // id -> MemProc
  let hist = null; // MemHistory
  let metricPick = "pss"; // what the user asked for; PSS only once read
  try { if (localStorage.getItem("hd-mem-metric") === "rss") metricPick = "rss"; } catch {}
  const metric = () => (metricPick === "pss" && head?.pss ? "pss" : "rss");
  const val = (p) => (metric() === "pss" && p.pss ? p.pss : p.rss);

  let win = null, es = null, histTimer = null, path = ["machine"], hl = null, zoomTimer = null, drawQueued = false, err = "";
  let tree = null; // the last built hierarchy (d3)

  function applyFrame(f) {
    head = f.head;
    owners.clear();
    for (const o of f.owners || []) owners.set(o.tag, o);
    procs.clear();
    for (const p of f.procs || []) procs.set(p.id, p);
  }
  function applyDelta(d) {
    if (d.head) head = d.head;
    if (d.owners) { owners.clear(); for (const o of d.owners) owners.set(o.tag, o); }
    for (const p of d.up || []) procs.set(p.id, p);
    for (const id of d.gone || []) procs.delete(id);
  }

  // ---------------------------------------------------------------- tree
  // Owner node ids: th:<thread key>, hub:<slug>, lo:<pane>, pane:<pane>, dash, voice.
  function ownerNode(o) {
    const s = st();
    if (o.kind === "dash" || o.kind === "voice") return { id: o.kind, name: o.kind === "dash" ? "Dash service" : "Voice sidecar", state: "dash", kind: o.kind };
    if (o.kind === "coordinator") return { id: o.key, key: o.key, name: "coordinator", state: "coordinator", kind: "coordinator", project: o.project };
    if (o.kind === "thread") {
      const t = s.threads.find((x) => x.key === o.key);
      return { id: "th:" + o.key, key: o.key, name: `${o.thread} ${t?.title || ""}`.trim(), state: t?.state || "idle", kind: "thread", project: o.project };
    }
    if (o.kind === "leftover") {
      const t = o.thread ? s.threads.find((x) => x.key === o.key) : null;
      return { id: "lo:" + o.pane, key: o.thread ? o.key : null, pane: o.pane, name: o.thread ? `${o.thread} ${t?.title || ""} · leftover`.replace("  ", " ") : `orphan pane ${o.pane}`,
        state: o.thread ? "leftover" : "orphan", kind: "leftover", project: o.project, thread: o.thread };
    }
    return { id: "pane:" + o.pane, name: `pane ${o.pane}`, state: "pane", kind: "pane", pane: o.pane };
  }
  // A process tree from one owner's processes: a process with children is a
  // group holding its own memory as a "self" leaf.
  function procTree(ps, state) {
    const by = new Map(ps.map((p) => [p.pid, { id: "p:" + p.pid, name: p.comm, proc: p, state, kids: [] }]));
    const roots = [];
    for (const n of by.values()) { const par = by.get(n.proc.ppid); (par && par !== n ? par.kids : roots).push(n); }
    const fin = (n) => {
      if (!n.kids.length) { delete n.kids; n.value = val(n.proc); return n; }
      n.kids = [{ id: "s:" + n.proc.pid, name: n.proc.comm, proc: n.proc, state, self: true, value: val(n.proc) }, ...n.kids.map(fin)];
      return n;
    };
    return roots.map(fin);
  }
  function build() {
    const s = st();
    const root = { id: "machine", name: "Machine", kind: "machine", state: "machine", kids: [] };
    const projects = new Map(), byTag = new Map(), other = new Map();
    const group = (id, mk) => { let g = projects.get(id); if (!g) { g = mk(); projects.set(id, g); root.kids.push(g); } return g; };
    for (const p of procs.values()) {
      if (p.tag && owners.has(p.tag)) { if (!byTag.has(p.tag)) byTag.set(p.tag, []); byTag.get(p.tag).push(p); }
      else { if (!other.has(p.comm)) other.set(p.comm, []); other.get(p.comm).push(p); }
    }
    const nodes = new Map();
    for (const [tag, ps] of byTag) {
      const o = owners.get(tag), n = ownerNode(o);
      let g = nodes.get(n.id);
      if (!g) {
        g = { ...n, kids: [] };
        nodes.set(n.id, g);
        const parent = o.project ? group("proj:" + o.project, () => ({ id: "proj:" + o.project, slug: o.project, name: s.projects.find((x) => x.slug === o.project)?.name || o.project, kind: "project", state: "project", kids: [] }))
          : n.state === "dash" ? group("herdr-dash", () => ({ id: "herdr-dash", name: "Herdr Dash", kind: "group", state: "dash", kids: [] }))
            : group("panes", () => ({ id: "panes", name: "Other herdr panes", kind: "group", state: "pane", kids: [] }));
        parent.kids.push(g);
      }
      g.kids.push(...procTree(ps, n.state));
    }
    if (other.size) {
      const nh = { id: "nh", name: "Not herdr", kind: "group", state: "other", kids: [] };
      for (const [comm, ps] of other) nh.kids.push({ id: "nh:" + comm, name: comm, kind: "comm", state: "other", kids: ps.map((p) => ({ id: "p:" + p.pid, name: p.comm, proc: p, state: "other", value: val(p) })) });
      root.kids.push(nh);
    }
    tree = d3.hierarchy(root, (d) => d.kids).sum((d) => (d.kids ? 0 : d.value || 0)).sort((a, b) => b.value - a.value || (a.data.id < b.data.id ? -1 : 1));
    return tree;
  }
  const find = (id) => { let f = null; tree?.each((n) => { if (!f && n.data.id === id) f = n; }); return f; };
  function current() {
    while (path.length > 1 && !find(path[path.length - 1])) path.pop();
    return find(path[path.length - 1]) || tree;
  }
  // What a node adds up to: processes, RSS, PSS, CPU, oldest start, cwd.
  function totals(n) {
    const ps = [];
    n.each((x) => { if (x.data.proc && !x.children) ps.push(x.data.proc); });
    const t = { n: ps.length, rss: 0, pss: 0, pssAll: true, cpu: 0, cpuKnown: false, start: Infinity, cwd: "" };
    for (const p of ps) {
      t.rss += p.rss;
      if (p.pss) t.pss += p.pss; else { t.pss += p.rss; t.pssAll = false; }
      if (p.cpu != null) { t.cpu += p.cpu; t.cpuKnown = true; }
      if (p.start < t.start) t.start = p.start;
    }
    // A group's cwd: its first top process's (the agent's, under the shell).
    let top = n;
    while (top && !top.data.proc && top.children) top = top.children[0];
    t.cwd = top?.data.proc?.cwd || "";
    return t;
  }
  // The owner node (thread, coordinator, leftover…) a node belongs to.
  const ownerOf = (n) => { for (let x = n; x; x = x.parent) if (x.data.key || x.data.kind === "leftover" || x.data.kind === "dash" || x.data.kind === "voice") return x; return null; };

  // ---------------------------------------------------------------- view
  let note = null, body = null, map = null, list = null, crumbsEl = null, totalsEl = null, metricEl = null, side = null, tip = null;
  const tiles = new Map(); // id -> div

  function scaffold(b) {
    totalsEl = el("div", { class: "mm-totals" });
    metricEl = el("div", { class: "mm-metric" });
    crumbsEl = el("nav", { class: "mm-crumbs", "aria-label": "Zoom path" });
    map = el("div", { class: "mm-map", role: "group", "aria-label": "Memory treemap" });
    list = el("div", { class: "mm-list", role: "list" });
    side = el("aside", { class: "mm-side" });
    const legend = el("div", { class: "mm-legend" }, ...LEGEND.map((k) => el("span", { "data-state": k }, el("i", { style: `background:${COLOR[k]}` }), LABEL[k].split(":")[0])));
    body = el("div", { class: "mm-body" },
      totalsEl, el("div", { class: "mm-bar2" }, metricEl, crumbsEl),
      el("div", { class: "mm-main" }, el("div", { class: "mm-stage" }, map, list), side),
      legend);
    note = el("p", { class: "mm-note", text: "RSS counts a shared page in every process that maps it, so RSS sums overcount (a Node or Python runtime shared by its workers adds up many times). PSS splits each shared page between the processes that share it, so PSS sums add up to what they really hold. Neither counts the page cache or the kernel; the cgroup's memory.current does, and it is what MemoryMax limits." });
    b.append(body);
    map.addEventListener("click", onClick);
    map.addEventListener("dblclick", onDbl);
    map.addEventListener("mousemove", onHover);
    map.addEventListener("mouseleave", hideTip);
    new ResizeObserver(() => queue()).observe(map);
  }

  function renderTotals() {
    if (!head) { totalsEl.replaceChildren(el("span", { class: "mm-calm", text: err || "Reading /proc…" })); return; }
    if (!head.available && head.reason) { totalsEl.replaceChildren(el("span", { class: "mm-calm", text: head.reason })); return; }
    const where = head.wsl ? " (WSL VM)" : "";
    const lv = (p) => (p >= 95 ? "crit" : p >= 80 ? "warn" : "ok");
    const item = (k, label, text, level, title) => el("span", { class: "mm-t", "data-k": k, "data-level": level || "ok", title }, el("b", { text: label }), " ", text);
    const kids = [
      item("used", "Used" + where, `${gib(head.used)} of ${gib(head.total)}`, lv((100 * head.used) / (head.total || 1)), "MemTotal − MemAvailable"),
      item("available", "Available", gib(head.avail), null, "MemAvailable: what new work can get without swapping"),
      item("cache", "Cache", gib(head.cache), null, `Page cache, buffers and reclaimable slab (shared memory ${gib(head.shmem)})`),
      item("swap", "Swap", head.swap_total ? `${gib(head.swap_used)} of ${gib(head.swap_total)}` : "none", head.swap_total ? lv((100 * head.swap_used) / head.swap_total) : null),
    ];
    if (head.psi) {
      const s10 = head.psi.some[0], f10 = head.psi.full[0];
      kids.push(item("psi", "Pressure", `some ${s10.toFixed(1)}% · full ${f10.toFixed(1)}%`, f10 >= 10 || s10 >= 40 ? "crit" : f10 >= 1 || s10 >= 10 ? "warn" : "ok",
        `PSI, last 10 s: share of time some (full: all) tasks waited on memory. 60 s: some ${head.psi.some[1].toFixed(1)}%, full ${head.psi.full[1].toFixed(1)}%; 300 s: some ${head.psi.some[2].toFixed(1)}%, full ${head.psi.full[2].toFixed(1)}%`));
    } else kids.push(item("psi", "Pressure", "n/a", null, "No /proc/pressure/memory (kernel without PSI)"));
    const c = head.cgroup;
    if (c) {
      // Critical at MemoryHigh (the kernel throttles there) or 85% of MemoryMax (OOM kills there).
      const ofMax = c.max ? c.current / c.max : 0, ofHigh = c.high ? c.current / c.high : 0;
      const level = ofHigh >= 1 || ofMax >= 0.85 ? "crit" : ofHigh >= 0.9 || ofMax >= 0.75 ? "warn" : "ok";
      const ev = c.events || {};
      kids.push(item("cgroup", c.name, `${gib(c.current)} · high ${c.high ? gib(c.high) : "none"} · max ${c.max ? gib(c.max) : "none"}` +
        (c.peak ? ` · peak ${gib(c.peak)}` : "") + (ev.oom_kill ? ` · oom kill ${ev.oom_kill}` : "") + (ev.high ? ` · over high ${ev.high}×` : ""), level,
        `cgroup ${c.path}: memory.current against memory.high (MemoryHigh) and memory.max (MemoryMax); includes page cache. Events since the unit started.`),
        c.max ? el("b", { class: "mm-cgbar", "data-level": level, title: `${Math.round(100 * ofMax)}% of MemoryMax` }, el("i", { style: `width:${Math.min(100, 100 * ofMax).toFixed(1)}%` }),
          c.high ? el("u", { style: `left:${Math.min(100, (100 * c.high) / c.max).toFixed(1)}%`, title: "MemoryHigh" }) : null) : null);
    } else kids.push(item("cgroup", "cgroup", "unknown", null, "The herdr panes' cgroup has no memory files (no cgroup v2, or not in a unit)"));
    totalsEl.replaceChildren(...kids);
  }

  function renderMetric() {
    const m = metric();
    metricEl.dataset.metric = m;
    const what = m === "pss" ? `PSS, read every ${Math.round(head?.pss_every || 30)} s; RSS where unreadable` :
      head?.pss ? "RSS (shared pages counted in every process)" : "RSS (PSS unavailable: smaps_rollup unreadable or off)";
    metricEl.replaceChildren(el("span", { class: "mm-what", text: "Area: " + what }),
      el("span", { class: "mm-seg", role: "group", "aria-label": "Area metric" }, ...["pss", "rss"].map((k) => el("button", { type: "button", class: "tbtn", "data-m": k, "aria-pressed": String(metricPick === k),
        disabled: k === "pss" && !head?.pss ? true : null, text: k.toUpperCase(), onclick: () => { metricPick = k; try { localStorage.setItem("hd-mem-metric", k); } catch {} draw(); } }))));
  }

  // Crumbs update in place: a frame changes their sizes, not their buttons.
  function renderCrumbs() {
    const ns = path.map((id) => find(id)).filter(Boolean);
    const ids = ns.map((n) => n.data.id).join("\n");
    if (crumbsEl.dataset.ids !== ids) {
      crumbsEl.dataset.ids = ids;
      crumbsEl.replaceChildren(...ns.flatMap((n, i) => [i ? el("span", { class: "mm-sep", text: "›" }) : null,
        el("button", { type: "button", class: "mm-crumb", "data-id": n.data.id, "aria-current": i === ns.length - 1 ? "true" : null,
          onclick: () => { path = path.slice(0, i + 1); draw(); } })]).filter(Boolean));
    }
    crumbsEl.querySelectorAll(".mm-crumb").forEach((b, i) => { const t = `${ns[i].data.name} · ${bytes(ns[i].value)}`; if (b.textContent !== t) b.textContent = t; });
  }

  const ownerKey = (n) => ownerOf(n)?.data.key || null;
  function tileFor(n, parentId, x, y, w, h, hasHead) {
    const d = n.data;
    let t = tiles.get(d.id);
    if (!t) { t = el("div", { class: "mm-tile", "data-id": d.id }); tiles.set(d.id, t); }
    const color = COLOR[d.state] || null;
    t.dataset.parent = parentId || "";
    t.dataset.state = d.state;
    t.dataset.bytes = String(n.value);
    t.dataset.kind = d.kind || (d.self ? "self" : "proc");
    const k = ownerKey(n);
    if (k) t.dataset.key = k; else delete t.dataset.key;
    t.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;` + (color ? `--mm-c:${color}` : "");
    t.classList.toggle("group", !!n.children);
    t.classList.toggle("nohead", !!n.children && !hasHead);
    t.classList.toggle("hl", !!hl && (d.id === hl));
    // The Agent filter dims tiles of threads and coordinators not on it.
    t.classList.toggle("agent-dim", !!k && !!window.HDAgents?.active() && !window.HDAgents.matchKey(k));
    const sig = [d.name, hasHead, w > 46 && h > 15, d.kind, d.kind === "leftover" && !!leftoverOf(d)].join("|");
    if (t.dataset.sig !== sig) {
      t.dataset.sig = sig;
      const kids = [];
      if (n.children && hasHead) {
        const lo = d.kind === "leftover" ? leftoverOf(d) : null;
        kids.push(el("div", { class: "mm-head" }, el("span", { class: "mm-n", text: d.name }), el("span", { class: "mm-v", text: bytes(n.value) }),
          lo ? el("button", { type: "button", class: "tbtn danger mm-close", "data-pane": d.pane, title: `herdr closes pane ${d.pane}; asks first`, text: "Close leftover…",
            onclick: (e) => { e.stopPropagation(); clearTimeout(zoomTimer); window.HDThreads?.closeLeftover(d.project, lo); } }) : null));
      } else if (!n.children && w > 46 && h > 15) kids.push(el("span", { class: "mm-lab" }, el("span", { class: "mm-n", text: d.self ? `${d.name} (self)` : d.name }), " ", el("span", { class: "mm-v", text: bytes(n.value) })));
      t.replaceChildren(...kids);
    }
    // Sizes change every frame: their text in place, the rest stays put.
    const v = t.querySelector(":scope > .mm-head > .mm-v, :scope > .mm-lab > .mm-v");
    if (v && v.textContent !== bytes(n.value)) v.textContent = bytes(n.value);
    return t;
  }
  // The leftover entry (state.go) of a leftover tile, for the close dialog.
  function leftoverOf(d) {
    const s = st();
    if (d.thread) {
      const t = s.threads.find((x) => x.key === d.key);
      const l = t?.leftover?.find((x) => x.pane === d.pane);
      return l ? { ...l, thread: t.id, title: t.title } : null;
    }
    const o = s.projects.find((p) => p.slug === d.project)?.orphans?.find((x) => x.pane === d.pane);
    return o ? { ...o, thread: "" } : null;
  }

  function drawMap(cur) {
    const W = map.clientWidth, H = map.clientHeight;
    const seen = new Set();
    if (W < 20 || H < 20) return;
    const sub = d3.hierarchy(cur.data, (d) => d.kids).sum((d) => (d.kids ? 0 : d.value || 0)).sort((a, b) => b.value - a.value || (a.data.id < b.data.id ? -1 : 1));
    const big = (n) => n.y1 - n.y0 > HEAD + 18 && n.x1 - n.x0 > 44;
    d3.treemap().tile(d3.treemapSquarify).size([W, H]).round(false)
      .paddingInner(2).paddingOuter((n) => (n.depth === 0 ? 0 : 2)).paddingTop((n) => (n.depth === 0 ? 0 : big(n) ? HEAD : 2))(sub);
    const frag = [];
    sub.each((n) => {
      const w = n.x1 - n.x0, h = n.y1 - n.y0;
      if (n.parent && !seen.has(n.parent.data.id)) return; // parent not drawn
      if (w < 2 || h < 2) return;
      seen.add(n.data.id);
      const parentId = n.depth === 0 ? (path.length > 1 ? path[path.length - 2] : "") : n.parent.data.id;
      frag.push(tileFor(n, parentId, n.x0, n.y0, w, h, n.depth > 0 && big(n)));
    });
    for (const [id, t] of tiles) if (!seen.has(id)) { t.remove(); tiles.delete(id); }
    // Order: parents before children (paint order).
    frag.forEach((t, i) => { if (map.children[i] !== t) map.insertBefore(t, map.children[i] || null); });
  }

  function drawList(cur) {
    const rows = (cur.children || []).filter((n) => n.value > 0);
    const max = rows[0]?.value || 1;
    list.replaceChildren(...rows.map((n) => {
      const d = n.data;
      return el("button", { type: "button", class: "mm-row", role: "listitem", "data-id": d.id, "data-state": d.state, "data-bytes": String(n.value), "data-key": ownerKey(n) || null,
        style: COLOR[d.state] ? `--mm-c:${COLOR[d.state]}` : "",
        onclick: () => { if (n.children) { path.push(d.id); draw(); } else tipFor(n, null); } },
      el("span", { class: "mm-rn", text: d.self ? `${d.name} (self)` : d.name }), el("span", { class: "mm-rv", text: bytes(n.value) }),
      el("b", { class: "mm-bar" }, el("i", { style: `width:${+(100 * n.value / max).toFixed(2)}%` })));
    }));
  }

  function spark(pts) {
    const w = 80, h = 18, svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("class", "mm-spark");
    svg.setAttribute("aria-hidden", "true");
    const pl = document.createElementNS(SVG, "polyline");
    const vs = pts.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs);
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    pl.setAttribute("points", pts.map((p) => `${((w * (p.t - t0)) / Math.max(1, t1 - t0)).toFixed(1)},${(h - 2 - ((h - 4) * (p.v - lo)) / Math.max(1, hi - lo)).toFixed(1)}`).join(" "));
    svg.append(pl);
    return svg;
  }
  function renderSide() {
    const s = st();
    const title = (g) => g.kind === "coordinator" ? "coordinator" : g.thread ? `${g.thread} ${s.threads.find((t) => t.key === g.key)?.title || ""}`.trim() : g.key;
    const projs = Object.entries(hist?.projects || {}).filter(([, pts]) => pts.length).sort((a, b) => b[1][b[1].length - 1].v - a[1][a[1].length - 1].v);
    const win = hist ? dur(hist.window) : "30m";
    side.replaceChildren(
      el("h3", { text: `Top growers · last ${win}` }),
      hist?.growers?.length ? el("ol", { class: "mm-growers" }, ...hist.growers.slice(0, 8).map((g) => el("li", { "data-key": g.key, "data-kind": g.kind },
        el("button", { type: "button", class: "mm-gn", title: `${g.key}: ${bytes(g.from)} → ${bytes(g.to)} over ${dur(g.over)}`, onclick: () => (g.kind === "thread" || g.kind === "coordinator" ? window.dash?.open(g.key) : null) },
          g.project && g.kind !== "coordinator" ? el("span", { class: "mm-gp", text: g.project }) : null, g.kind === "coordinator" ? `${g.project} · coordinator` : title(g)),
        el("span", { class: "mm-gd", text: `+${bytes(g.delta)}` })))) : el("p", { class: "mm-calm", text: hist ? "Nothing grew." : "Collecting…" }),
      el("h3", { text: "Projects (RSS)" }),
      projs.length ? el("div", { class: "mm-projs" }, ...projs.map(([slug, pts]) => el("div", { class: "mm-proj", "data-slug": slug },
        el("span", { class: "mm-pn", text: s.projects.find((p) => p.slug === slug)?.name || slug }), pts.length > 1 ? spark(pts) : el("span", { class: "mm-spark" }),
        el("span", { class: "mm-pv", text: bytes(pts[pts.length - 1].v) })))) : el("p", { class: "mm-calm", text: "Collecting…" }),
      el("h3", { text: "Shared memory" }), note);
  }

  function draw() {
    drawQueued = false;
    if (!win || !body) return;
    renderTotals();
    if (!head) return;
    renderMetric();
    build();
    const cur = current();
    renderCrumbs();
    body.classList.toggle("phone", phone());
    if (phone()) { map.replaceChildren(); tiles.clear(); drawList(cur); }
    else { list.replaceChildren(); drawMap(cur); }
  }
  function queue() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }

  // ---------------------------------------------------------------- tooltip
  function tipFor(n, e) {
    if (!tip) { tip = el("div", { id: "mm-tip", class: "tip mm-tip", role: "tooltip" }); document.body.append(tip); }
    const d = n.data, t = totals(n), now = Date.now() / 1000;
    const o = ownerOf(n);
    const state = d.proc ? (o ? LABEL[o.data.state] : LABEL[d.state]) : LABEL[d.state] || d.state;
    const rows = [
      ["RSS", bytes(t.rss)],
      ["PSS", head?.pss ? bytes(t.pss) + (t.pssAll ? "" : " (RSS where unreadable)") : "not read"],
      ["CPU", t.cpuKnown ? `${Math.round(t.cpu)}% of a core` : "measuring…"],
      ["Processes", `${t.n} process${t.n === 1 ? "" : "es"}`],
      ["Age", Number.isFinite(t.start) ? dur(now - t.start) + (t.n > 1 ? " (oldest)" : "") : "—"],
      ["State", state || "—"],
      ["Cwd", t.cwd || "—"],
    ];
    if (d.proc) rows.unshift(["Process", `${d.proc.comm} · pid ${d.proc.pid}${d.self ? " (its own memory; children apart)" : ""}`]);
    tip.replaceChildren(el("b", { text: d.self ? `${d.name} (self)` : d.name }), el("dl", {}, ...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
      d.key && !d.proc && (d.kind === "thread" || d.kind === "coordinator") ? el("div", { class: "mm-hint", text: "Double-click opens its window" }) : null);
    tip.hidden = false;
    if (e) {
      const r = tip.getBoundingClientRect();
      tip.style.left = `${Math.max(4, Math.min(innerWidth - r.width - 4, e.clientX + 14))}px`;
      tip.style.top = `${Math.max(4, Math.min(innerHeight - r.height - 4, e.clientY + 14))}px`;
    } else { tip.style.left = "8px"; tip.style.top = "8px"; }
  }
  function hideTip() { if (tip) tip.hidden = true; }
  const nodeAt = (e) => { const t = e.target.closest?.(".mm-tile"); return t ? find(t.dataset.id) : null; };
  function onHover(e) { const n = nodeAt(e); if (n) tipFor(n, e); else hideTip(); }

  // ---------------------------------------------------------------- clicks
  function mark(n) {
    const o = ownerOf(n);
    hl = o ? o.data.id : null;
    for (const t of tiles.values()) t.classList.toggle("hl", t.dataset.id === hl);
    window.dash?.mark?.(o?.data.key || null);
  }
  function onClick(e) {
    if (e.target.closest("button")) return;
    const n = nodeAt(e);
    if (!n) return;
    mark(n);
    // Zoom one level: to the child of the current root that holds the tile.
    const cur = current();
    let z = n;
    while (z && z.parent && z.parent.data.id !== cur.data.id) z = z.parent;
    if (!z || z === cur || !z.children || z.parent?.data.id !== cur.data.id) return;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => { path.push(z.data.id); hideTip(); draw(); }, 240);
  }
  function onDbl(e) {
    clearTimeout(zoomTimer);
    const n = nodeAt(e);
    const o = n && ownerOf(n);
    if (o && (o.data.kind === "thread" || o.data.kind === "coordinator") && o.data.key) window.HDThreadWin?.open(o.data.key);
  }
  // A node selected on the graph: mark its tile.
  document.addEventListener("hd-select", (e) => {
    if (!win || !tree) return;
    const key = e.detail;
    let id = null;
    tree.each((n) => { if (!id && n.data.key === key && !n.data.proc) id = n.data.id; });
    hl = id;
    for (const t of tiles.values()) t.classList.toggle("hl", t.dataset.id === hl);
  });

  // ---------------------------------------------------------------- stream
  const onScreen = () => !!win && !document.hidden && window.HDWin?.shown().includes("memory");
  function sync() {
    if (onScreen()) {
      if (!es) {
        es = new EventSource("/api/memory/events");
        es.addEventListener("memory", (ev) => { applyFrame(JSON.parse(ev.data)); err = ""; queue(); });
        es.addEventListener("memdelta", (ev) => { applyDelta(JSON.parse(ev.data)); queue(); });
        es.onerror = () => { err = "Reconnecting…"; };
        es.onmessage = (ev) => { try { const j = JSON.parse(ev.data); if (j.head) { head = j.head; queue(); } } catch {} };
        loadHist();
      }
    } else if (es) {
      es.close(); es = null;
      clearTimeout(histTimer); histTimer = null;
    }
  }
  // History moves one point per its step (15 s live): refetch at that pace.
  async function loadHist() {
    clearTimeout(histTimer);
    try {
      const r = await fetch("/api/memory/history");
      hist = await r.json();
      if (win) renderSide();
    } catch {}
    if (es) histTimer = setTimeout(loadHist, 1000 * Math.min(15, Math.max(2, hist?.every || 15)));
  }
  document.addEventListener("visibilitychange", sync);
  document.addEventListener("hd-focus", () => { if (win) queue(); });
  document.addEventListener("hdwin:change", sync);
  addEventListener("resize", () => { if (win) queue(); });

  function open() {
    if (win) { window.HDWin.restore("memory"); sync(); return; }
    win = window.HDWin.open("memory", {
      title: "Memory map", short: "Memory", cls: "mm-win", width: 1100, persist: true,
      build: (b) => scaffold(b),
      onEsc: () => { if (path.length > 1) { path.pop(); draw(); return true; } return false; },
      onClose: () => { win = null; tiles.clear(); hideTip(); window.dash?.mark?.(null); hl = null; path = ["machine"]; sync(); },
    });
    renderSide();
    draw();
    sync();
  }

  const btn = el("button", { id: "mem-open", class: "tbtn", type: "button", title: "Memory map: which projects, threads and processes hold the memory", text: "Memory", onclick: () => open() });
  ($("#master-open") ? $("#master-open").before(btn) : ($("#filters") || document.body).append(btn));

  // app.js hands over each new snapshot (thread states and titles).
  window.HDMemory = {
    open,
    state: () => { if (win && head) queue(); },
    frame: () => ({ head, owners: [...owners.values()], procs: [...procs.values()] }),
  };
  if (window.HDWin?.saved?.().includes("memory")) open();
})();
