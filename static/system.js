// herdr-dash system: a compact header strip with machine CPU, RAM and swap,
// active agents against each project's max_parallel_threads and the launch
// queue, plus a details popover (per-core sparklines, load, the processes
// of every agent pane heaviest first, the queue in order). Machine numbers
// arrive as `system` events on the page's event stream, which app.js closes
// while the page is hidden; agents and the queue come from the snapshot.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "style") e.style.cssText = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  };
  const SVG = "http://www.w3.org/2000/svg";

  const strip = el("div", { id: "sys", class: "sys", role: "group", "aria-label": "System" });
  const pop = el("div", { id: "sys-pop", class: "sys-pop", role: "dialog", "aria-label": "System details" });
  pop.hidden = true;
  $("#top").insertBefore(strip, $("#usage") || $("#updated"));
  document.body.append(pop);

  let frame = null, openID = null;
  const HIST = 40;
  const hist = { cpu: [], cores: [] };

  // Warning at 80%, critical at 95% (of a core, of RAM, of a limit).
  const level = (p) => (p == null ? "na" : p >= 95 ? "crit" : p >= 80 ? "warn" : "ok");
  const worst = (ls) => (ls.includes("crit") ? "crit" : ls.includes("warn") ? "warn" : "ok");
  const pctOf = (m) => (m && m.total ? (100 * m.used) / m.total : null);
  const gib = (b) => (b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1);
  const bytes = (b) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
  const pct = (n) => `${Math.round(n)}%`;
  function dur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h < 48 ? `${h}h ${m}m` : `${Math.floor(h / 24)}d`;
  }
  const since = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 1000 : 0);
  const st = () => window.dash?.state?.() || { projects: [], threads: [] };
  // Agents, processes and the queue follow the project focus; the machine
  // (CPU, RAM, swap) stays whole. Dash and voice belong to no project.
  const inFocus = (slug) => !slug || !window.dash?.inFocus || window.dash.inFocus(slug);
  const focusNote = () => {
    const f = window.hd?.focus?.() || [];
    return f.length && f.length < st().projects.length ? el("div", { class: "snote sfocus", text: `Agents, queue and processes: ${f.length} focused project${f.length === 1 ? "" : "s"} only.` }) : null;
  };

  // ------------------------------------------------------------ derived
  function agents() {
    const s = st(), per = new Map();
    for (const p of s.projects) if (inFocus(p.slug)) per.set(p.slug, { slug: p.slug, name: p.name || p.slug, max: p.max_parallel || 10, open: 0, working: 0, waiting: 0, idle: 0, exited: 0 });
    const tot = { working: 0, waiting: 0, idle: 0, exited: 0 };
    // Agents that exited, leaving a shell in their pane: threads and coordinators.
    for (const p of s.projects) if (per.has(p.slug) && p.coordinator?.agent_exited) { per.get(p.slug).exited++; tot.exited++; }
    for (const t of s.threads) {
      const p = per.get(t.project);
      if (!p || t.state === "resolved") continue;
      // herdr-projects counts open and starting threads against the limit.
      if (!t.launch || t.launch.stage !== "failed") p.open++;
      if (!t.pane_alive) continue;
      const k = t.agent_exited ? "exited" : t.needs_you ? "waiting" : t.state === "working" ? "working" : "idle";
      p[k]++; tot[k]++;
    }
    const rows = [...per.values()].filter((p) => p.open || p.working || p.waiting || p.idle || p.exited);
    for (const p of rows) p.level = level((100 * p.open) / p.max);
    return { tot, rows };
  }

  function queue() {
    const order = { placing: 0, queued: 0, launching: 0, briefing: 0, stuck: 1, failed: 2 };
    const rows = st().threads.filter((t) => t.launch && t.state !== "resolved" && inFocus(t.project))
      .sort((a, b) => (order[a.launch.stage] ?? 0) - (order[b.launch.stage] ?? 0) || Date.parse(a.launch.since) - Date.parse(b.launch.since));
    let n = 0;
    for (const t of rows) t._pos = t.launch.stage === "failed" || t.launch.stage === "stuck" ? null : ++n;
    return { rows, waiting: n, failed: rows.length - n };
  }
  function stageText(l) {
    switch (l.stage) {
      case "placing": return "placing worktree";
      case "queued": return "waiting for the ticker";
      case "launching": return `starting agent, attempt ${l.attempt} of ${l.max_attempts}`;
      case "briefing": return "agent up, sending brief";
      case "stuck": return "brief stuck";
      case "failed": return `failed${l.error ? ": " + l.error : ""}`;
    }
    return l.stage;
  }
  const qLevel = (t) => (t.launch.stage === "failed" || t.launch.stage === "stuck" ? "crit" : since(t.launch.since) > 300 ? "warn" : "ok");

  // ------------------------------------------------------------ strip
  function bar(p, lv) {
    return el("b", { class: "sbar", "data-level": lv }, el("i", { style: `width:${Math.min(100, Math.max(0, p ?? 0))}%` }));
  }
  function pill(id, lv, title, ...kids) {
    return el("button", {
      class: "sysc", type: "button", "data-id": id, "data-level": lv, title, "aria-expanded": String(openID === id && !pop.hidden),
      onclick: (e) => { e.stopPropagation(); openID === id && !pop.hidden ? close() : open(id); },
    }, ...kids);
  }

  function renderStrip() {
    const kids = [];
    const ok = frame?.available;
    const where = frame?.wsl ? " (WSL VM)" : "";
    if (!ok) {
      kids.push(pill("cpu", "na", frame ? `System: ${frame.reason}` : "System: waiting for data",
        el("span", { class: "sl", text: "CPU" }), el("span", { class: "sna", text: frame ? "n/a" : "…" })));
    } else {
      const c = frame.cpu?.pct;
      kids.push(pill("cpu", c == null ? "ok" : level(c), `CPU${where}: ${c == null ? "measuring" : pct(c)} of ${frame.ncpu} cores`,
        el("span", { class: "sl", text: "CPU" }), bar(c, level(c)), el("span", { class: "sv", text: c == null ? "…" : pct(c) })));
      const m = pctOf(frame.mem);
      if (frame.mem) kids.push(pill("mem", level(m), `RAM${where}: ${gib(frame.mem.used)} of ${gib(frame.mem.total)} GiB used`,
        el("span", { class: "sl", text: "RAM" }), bar(m, level(m)), el("span", { class: "sv", text: `${gib(frame.mem.used)}/${gib(frame.mem.total)}G` })));
      const sw = pctOf(frame.swap);
      if (frame.swap?.total) kids.push(pill("swap", level(sw), `Swap${where}: ${bytes(frame.swap.used)} of ${bytes(frame.swap.total)} used`,
        el("span", { class: "sl", text: "Swap" }), el("span", { class: "sv", text: pct(sw) })));
    }
    const a = agents(), over = a.rows.filter((p) => p.level !== "ok");
    kids.push(pill("agents", worst(a.rows.map((p) => p.level)),
      `Agents: ${a.tot.working} working, ${a.tot.waiting} waiting on you, ${a.tot.idle} idle` + (a.tot.exited ? `, ${a.tot.exited} exited (a shell is left in the pane)` : "") + (over.length ? ` · at or over the limit: ${over.map((p) => `${p.slug} ${p.open}/${p.max}`).join(", ")}` : ""),
      el("span", { class: "sl", text: "Agents" }),
      el("span", { class: "sn", "data-k": "working", text: String(a.tot.working) }),
      el("span", { class: "sn", "data-k": "waiting", text: String(a.tot.waiting) }),
      el("span", { class: "sn", "data-k": "idle", text: String(a.tot.idle) }),
      a.tot.exited ? el("span", { class: "sn", "data-k": "exited", text: String(a.tot.exited) }) : null));
    const q = queue();
    kids.push(pill("queue", q.rows.length ? worst(q.rows.map(qLevel)) : "ok",
      `Launch queue: ${q.waiting} waiting` + (q.failed ? `, ${q.failed} failed or stuck` : ""),
      el("span", { class: "sl", text: "Queue" }), el("span", { class: "sv", text: String(q.waiting) }),
      q.failed ? el("span", { class: "sfail", text: `${q.failed} failed` }) : null));
    strip.replaceChildren(...kids);
  }

  // ------------------------------------------------------------ popover
  function spark(vals, max = 100) {
    const w = 60, h = 18, svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("class", "spark");
    svg.setAttribute("aria-hidden", "true");
    const pl = document.createElementNS(SVG, "polyline");
    const n = Math.max(2, HIST);
    const pts = vals.map((v, i) => `${((w * (i + n - vals.length)) / (n - 1)).toFixed(1)},${(h - 1 - ((h - 2) * Math.min(v, max)) / max).toFixed(1)}`);
    if (pts.length === 1) pts.unshift(`${(w - w / (n - 1)).toFixed(1)},${pts[0].split(",")[1]}`);
    pl.setAttribute("points", pts.join(" "));
    svg.append(pl);
    return svg;
  }

  function meter(label, p, text) {
    return el("div", { class: "smeter", "data-level": level(p) }, el("span", { class: "sl", text: label }), bar(p, level(p)), el("span", { class: "sv", text }));
  }

  function machine() {
    const body = [el("h3", { text: "Machine" })];
    if (!frame?.available) {
      body.push(el("div", { class: "snote", text: frame?.reason || "Waiting for data." }));
      return el("section", { class: "ssec", "data-id": "machine" }, ...body);
    }
    if (frame.wsl) body.push(el("div", { class: "swsl", text: "WSL VM: these are the WSL virtual machine's numbers, not the Windows host's." }));
    const c = frame.cpu;
    body.push(el("div", { class: "scpu", "data-level": level(c?.pct) },
      meter("CPU", c?.pct, c ? `${pct(c.pct)} of ${frame.ncpu} cores` : "measuring…"), hist.cpu.length > 1 ? spark(hist.cpu) : null));
    if (c) {
      body.push(el("div", { class: "scores" }, ...c.cores.map((v, i) =>
        el("div", { class: "score", "data-level": level(v), title: `core ${i}: ${pct(v)}` },
          el("span", { class: "sci", text: String(i) }), spark(hist.cores[i] || [v]), el("span", { class: "scv", text: pct(v) })))));
    }
    if (frame.mem) body.push(meter("RAM", pctOf(frame.mem), `${gib(frame.mem.used)} of ${gib(frame.mem.total)} GiB (${pct(pctOf(frame.mem))})`));
    if (frame.swap) body.push(frame.swap.total ? meter("Swap", pctOf(frame.swap), `${bytes(frame.swap.used)} of ${bytes(frame.swap.total)} (${pct(pctOf(frame.swap))})`)
      : el("div", { class: "snote", text: "No swap." }));
    if (frame.load?.length) {
      const per = frame.ncpu ? (100 * frame.load[0]) / frame.ncpu : null;
      body.push(el("div", { class: "sload", "data-level": level(per) }, el("span", { class: "sl", text: "Load" }),
        el("span", { class: "sv", text: frame.load.map((v) => v.toFixed(2)).join("  ") }),
        el("span", { class: "snote", text: "1, 5, 15 min" })));
    }
    return el("section", { class: "ssec", "data-id": "machine" }, ...body);
  }

  function agentsSec() {
    const a = agents();
    const body = [el("h3", { text: "Active agents" }),
      el("div", { class: "sagent-tot" },
        el("span", { "data-k": "working", text: `${a.tot.working} working` }), " · ",
        el("span", { "data-k": "waiting", text: `${a.tot.waiting} waiting on you` }), " · ",
        el("span", { "data-k": "idle", text: `${a.tot.idle} idle` }),
        a.tot.exited ? " · " : null, a.tot.exited ? el("span", { "data-k": "exited", text: `${a.tot.exited} exited` }) : null)];
    if (!a.rows.length) body.push(el("div", { class: "snote", text: "No open threads." }));
    else body.push(el("div", { class: "sprojs" }, ...a.rows.map((p) =>
      el("div", { class: "sproj", "data-slug": p.slug },
        el("span", { class: "spn", text: p.name, title: p.slug }),
        el("span", { class: "sc", "data-k": "working", title: "working", text: String(p.working) }),
        el("span", { class: "sc", "data-k": "waiting", title: "waiting on you", text: String(p.waiting) }),
        el("span", { class: "sc", "data-k": "idle", title: "idle", text: String(p.idle) }),
        p.exited ? el("span", { class: "sc", "data-k": "exited", title: "agent exited", text: String(p.exited) }) : null,
        el("span", { class: "slimit", "data-level": p.level, title: `${p.open} open threads; max_parallel_threads ${p.max}`, text: `${p.open}/${p.max}` })))));
    return el("section", { class: "ssec", "data-id": "agents" }, ...body);
  }

  function procName(p) {
    const s = st();
    if (p.kind === "dash") return "Dash service";
    if (p.kind === "voice") return "Voice sidecar";
    if (p.kind === "coordinator") return `${s.projects.find((x) => x.slug === p.project)?.name || p.project} · coordinator`;
    if (p.kind === "thread") return `${p.thread} ${s.threads.find((t) => t.key === p.key)?.title || ""}`.trim();
    return `pane ${p.pane}`;
  }
  const opens = (p) => p.kind === "thread" || p.kind === "coordinator";

  function procsSec() {
    const body = [el("h3", { text: "Processes" })];
    const rows = frame?.available ? frame.procs.filter((p) => inFocus(p.project)) : [];
    if (!rows.length) body.push(el("div", { class: "snote", text: frame?.available ? "No agent processes." : "Unavailable." }));
    for (const p of rows) {
      const lv = level(p.cpu);
      body.push(el(opens(p) ? "button" : "div", {
        class: "sproc", type: opens(p) ? "button" : null, "data-key": p.key, "data-kind": p.kind, "data-level": lv,
        title: `${p.n} process${p.n === 1 ? "" : "es"}, busiest ${p.top}` + (opens(p) ? " · open" : ""),
        onclick: opens(p) ? () => { close(); window.dash.open(p.key); } : null,
      },
        el("span", { class: "spname" }, p.project && p.kind === "thread" ? el("span", { class: "spproj", text: p.project }) : null, procName(p)),
        el("span", { class: "spagent", text: (p.exited ? "agent exited · " + p.top : [p.agent, p.top !== p.agent ? p.top : null].filter(Boolean).join(" · ")) + ` (${p.n})` }),
        el("span", { class: "spcpu", text: p.cpu == null ? "…" : pct(p.cpu) }),
        el("span", { class: "sprss", text: bytes(p.rss) })));
    }
    if (rows.length) body.push(el("div", { class: "snote", text: "CPU is % of one core; RSS sums each pane's processes (shared memory counts more than once)." }));
    return el("section", { class: "ssec", "data-id": "procs" }, ...body);
  }

  function queueSec() {
    const q = queue();
    const body = [el("h3", { text: "Launch queue" })];
    if (!q.rows.length) body.push(el("div", { class: "snote", text: "Nothing waiting to launch." }));
    for (const t of q.rows) {
      body.push(el("button", { class: "squeue", type: "button", "data-key": t.key, "data-level": qLevel(t), title: `Open ${t.key}`,
        onclick: () => { close(); window.dash.open(t.key); } },
        el("span", { class: "spos", text: t._pos == null ? "—" : String(t._pos) }),
        el("span", { class: "sqt" }, el("span", { class: "sqproj", text: t.project }), `${t.id} ${t.title || ""}`),
        el("span", { class: "sprof", text: t.profile || t.agent || "" }),
        el("span", { class: "sstage", text: stageText(t.launch) }),
        el("span", { class: "swait", title: `since ${new Date(t.launch.since).toLocaleString()}`, text: dur(since(t.launch.since)) })));
    }
    body.push(el("div", { class: "snote", text: "herdr-projects starts accepted threads right away; max_parallel_threads only warns." }));
    return el("section", { class: "ssec", "data-id": "queue" }, ...body);
  }

  function renderPop() {
    if (pop.hidden) return;
    const keep = pop.scrollTop;
    const focus = { cpu: "machine", mem: "machine", swap: "machine" }[openID] || openID;
    pop.replaceChildren(
      el("div", { class: "stop" }, el("b", { text: "System" }),
        frame?.at ? el("time", { class: "snote", datetime: frame.at, text: `sampled ${new Date(frame.at).toLocaleTimeString()}` }) : null,
        el("button", { class: "close", type: "button", "aria-label": "Close system details", text: "×", onclick: close })),
      machine(), focusNote(), agentsSec(), queueSec(), procsSec());
    pop.querySelector(`.ssec[data-id="${focus}"]`)?.classList.add("focus");
    const r = $("#top").getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    if (pop.dataset.scrolled !== openID) {
      pop.dataset.scrolled = openID;
      pop.querySelector(".ssec.focus")?.scrollIntoView({ block: "nearest" });
    } else pop.scrollTop = keep;
  }

  function open(id) {
    openID = id;
    pop.hidden = false;
    delete pop.dataset.scrolled;
    renderStrip();
    renderPop();
  }
  function close() {
    pop.hidden = true;
    openID = null;
    renderStrip();
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) close(); });
  document.addEventListener("hd-focus", () => { renderStrip(); renderPop(); });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && !strip.contains(e.target)) close(); });

  // app.js hands over each `system` event and each new snapshot.
  window.HDSystem = {
    frame(f) {
      frame = f;
      if (f.cpu) {
        hist.cpu = [...hist.cpu, f.cpu.pct].slice(-HIST);
        f.cpu.cores.forEach((v, i) => { hist.cores[i] = [...(hist.cores[i] || []), v].slice(-HIST); });
        hist.cores.length = f.cpu.cores.length;
      }
      renderStrip();
      renderPop();
    },
    state() {
      renderStrip();
      renderPop();
    },
    frameNow: () => frame,
  };
  renderStrip();
  // Wait times move on even when nothing else does.
  setInterval(() => { if (!document.hidden && !pop.hidden) renderPop(); }, 15_000);
})();
