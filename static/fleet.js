// herdr-dash Master window: the whole fleet at a glance. One row per
// project (cards on a phone or in a narrow dock) and a ranked Attention list
// on top, both from GET /api/fleet (fleet_http.go, internal/fleet). The
// window refetches only when the snapshot or the System strip's frame
// changes, never on a timer of its own, and the server builds the table from
// memory: opening it costs no CLI call. Click a row to open that project's
// coordinator window; tick rows (Shift for a range) to copy a summary or to
// act on them.
//
// Bulk actions (stage 1b, fleet_actions.go): every action opens a dialog
// with the dry-run plan (per project the exact command, the change, its
// undo, or why it is refused or queued); a tier-2 plan asks for its count
// typed back; Run executes with live per-project results; tier-1 batches
// can be undone. Broadcasts to busy coordinators wait in the queue with a
// "send now". The Audit tab shows the log, filterable.
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

  // put replaces node's children, skipping null ones (replaceChildren would
  // print "null").
  const put = (node, ...kids) => node.replaceChildren(...kids.filter((k) => k != null));

  const COORD = { blocked: "Blocked", waiting: "Waiting on you", working: "Working", idle: "Idle", exited: "Exited", missing: "Missing" };
  const COORD_RANK = { blocked: 0, waiting: 1, exited: 2, missing: 3, working: 4, idle: 5 };
  const STAGES = [["blocked", "blocked"], ["waiting", "waiting"], ["working", "working"], ["review", "review"], ["landing", "landing"], ["launching", "launching"], ["idle", "idle"]];
  const FILTERS = [["", "All projects"], ["attention", "Needs attention"], ["needs-you", "Needs you"], ["coord-down", "No live coordinator"],
    ["launches", "Failed or stuck launches"], ["priority", "Priority"]];
  const COLS = [
    ["name", "Project"], ["coord", "Coordinator"], ["open", "Threads"], ["needs", "Needs you"], ["unacked", "Unacked"],
    ["launches", "Launches"], ["cpu", "CPU"], ["rss", "RAM"], ["last", "Last activity"],
  ];

  let data = null, win = null, err = "";
  let sortKey = "score", sortDir = 1; // 1: the column's natural order
  let filter = "", query = "";
  const picked = new Set();
  let anchor = null; // last ticked row, for Shift ranges
  let tab = "fleet"; // fleet | audit
  let ops = null; // GET /api/fleet/ops
  let queue = []; // GET /api/fleet/queue
  let audit = null, auditErr = "";
  const auditF = { op: "", result: "", q: "", day: "" };

  const btn = el("button", { id: "master-open", class: "tbtn", type: "button", title: "Master: every project at a glance, and what needs you first", text: "Master", onclick: () => openWin() });
  ($("#filters") || document.body).append(btn);

  // ---------------------------------------------------------------- data
  let inflight = false, again = false, lastAt = 0, timer = null, dataSig = "";
  async function load() {
    if (inflight) { again = true; return; }
    inflight = true;
    try {
      const r = await fetch("/api/fleet");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      queue = d.queue || [];
      const sig = JSON.stringify([d.rows, d.attention, d.policy, queue]);
      // Unchanged (the clock aside): leave the DOM, an open menu and the
      // keyboard alone.
      if (sig === dataSig && !err) return;
      data = d;
      dataSig = sig;
      err = "";
      render();
    } catch (e) {
      err = "Could not load the fleet: " + e.message;
      render();
    } finally {
      inflight = false;
      lastAt = Date.now();
      if (again) { again = false; load(); }
    }
  }
  // refresh coalesces: a snapshot at once (after a short settle), system
  // frames at most every few seconds.
  function refresh(minGap) {
    if (!win || document.hidden) return;
    clearTimeout(timer);
    timer = setTimeout(load, Math.max(150, minGap - (Date.now() - lastAt)));
  }

  // ---------------------------------------------------------------- helpers
  const inFocus = (slug) => (window.dash?.inFocus ? window.dash.inFocus(slug) : true) && (!window.HDAgents?.active() || window.HDAgents.matchProject(slug));
  // With the Agent filter on, a row's thread counts, CPU and RAM are those
  // of its threads and coordinator on the filter (from the snapshot and the
  // System strip's frame); the server's numbers otherwise.
  function agentView(r) {
    const A = window.HDAgents;
    if (!A?.active()) return r;
    const s = window.dash?.state?.() || { threads: [], projects: [] };
    const ts = s.threads.filter((t) => t.project === r.slug && t.state !== "resolved" && t.state !== "leftover" && A.match(t));
    const stages = {};
    for (const t of ts) { const k = t.launch ? "launching" : t.state; stages[k] = (stages[k] || 0) + 1; }
    const keys = new Set(ts.map((t) => t.key));
    const p = s.projects.find((x) => x.slug === r.slug);
    if (p && A.matchCoord(p)) keys.add("hub:" + r.slug);
    let cpuSum = null, rss = 0, agents = 0;
    for (const pr of window.HDSystem?.frameNow?.()?.procs || []) {
      if (!keys.has(pr.key)) continue;
      agents++; rss += pr.rss || 0;
      if (pr.cpu != null) cpuSum = (cpuSum || 0) + pr.cpu;
    }
    return { ...r, stages, open: ts.length, needs_you: ts.filter((t) => t.needs_you).length, cpu: cpuSum, rss, agents };
  }
  function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.round(s / 60) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  }
  function bytes(b) {
    if (!b) return "–";
    if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
    return Math.round(b / 1e6) + " MB";
  }
  const cpu = (r) => (r.cpu == null ? (r.agents ? "…" : "–") : Math.round(r.cpu) + "%");
  const launches = (r) => r.launches.failed + r.launches.stuck;
  const attnOf = (slug) => (data?.attention || []).filter((a) => a.slug === slug);
  function stagesText(r) {
    const parts = STAGES.filter(([k]) => r.stages[k]).map(([k, l]) => `${r.stages[k]} ${l}`);
    return parts.length ? parts.join(", ") : "none open";
  }

  function rowsShown() {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const rows = data.rows.filter((r) => inFocus(r.slug)).map(agentView).filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.slug.includes(q)) return false;
      switch (filter) {
        case "attention": return r.score > 0;
        case "needs-you": return r.needs_you > 0 || r.coordinator.state === "blocked" || r.coordinator.state === "waiting";
        case "coord-down": return r.coordinator.state === "missing" || r.coordinator.state === "exited";
        case "launches": return launches(r) > 0;
        case "priority": return r.priority;
      }
      return true;
    });
    const key = {
      score: (r) => -r.score, name: (r) => r.name.toLowerCase(), coord: (r) => COORD_RANK[r.coordinator.state] ?? 9, open: (r) => -r.open,
      needs: (r) => -r.needs_you, unacked: (r) => -r.unacked, launches: (r) => -launches(r), cpu: (r) => -(r.cpu ?? -1), rss: (r) => -r.rss,
      last: (r) => -(Date.parse(r.last_activity) || 0),
    }[sortKey];
    const order = data.rows.map((r) => r.slug); // the server's triage order breaks ties
    return rows.sort((a, b) => {
      const x = key(a), y = key(b);
      const c = x < y ? -1 : x > y ? 1 : order.indexOf(a.slug) - order.indexOf(b.slug);
      return c * sortDir;
    });
  }

  // ---------------------------------------------------------------- open
  function openCoord(key) {
    if (!key) return;
    if (window.HDThreadWin) window.HDThreadWin.open(key);
    else window.hd?.select(key);
  }

  // ---------------------------------------------------------------- select
  function tick(slug, on, range) {
    const shown = rowsShown().map((r) => r.slug);
    if (range && anchor && shown.includes(anchor) && shown.includes(slug)) {
      const [i, j] = [shown.indexOf(anchor), shown.indexOf(slug)].sort((a, b) => a - b);
      for (const s of shown.slice(i, j + 1)) picked.add(s);
    } else if (on) picked.add(slug);
    else picked.delete(slug);
    anchor = slug;
    render();
  }
  function summary(slugs) {
    const rows = data.rows.filter((r) => slugs.includes(r.slug));
    const lines = rows.map((r) => {
      const bits = [`coordinator ${COORD[r.coordinator.state]?.toLowerCase() || r.coordinator.state}`, `${r.open} open (${stagesText(r)})`];
      if (r.needs_you) bits.push(`${r.needs_you} need you`);
      if (r.unacked) bits.push(`${r.unacked} unacked`);
      if (r.launches.failed) bits.push(`${r.launches.failed} failed launch${r.launches.failed > 1 ? "es" : ""} (${r.launches.errors.join("; ")})`);
      if (r.launches.stuck) bits.push(`${r.launches.stuck} stuck launch${r.launches.stuck > 1 ? "es" : ""}`);
      if (r.priority) bits.push("priority");
      if (r.status !== "active") bits.push(r.status);
      bits.push(`CPU ${cpu(r)}, RAM ${bytes(r.rss)}`);
      if (r.last_activity) bits.push(`last activity ${ago(r.last_activity)} ago`);
      const attn = attnOf(r.slug).map((a) => a.text);
      return `- ${r.name} (${r.slug}): ${bits.join(" · ")}` + (attn.length ? `\n  attention: ${attn.join("; ")}` : "");
    });
    return `Fleet summary, ${rows.length} project${rows.length === 1 ? "" : "s"} (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n` + lines.join("\n") + "\n";
  }
  async function copy() {
    const text = summary([...picked]);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el("textarea", { class: "fl-copybuf", "aria-hidden": "true" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    window.hd?.toast?.(`Copied a summary of ${picked.size} project${picked.size === 1 ? "" : "s"}`);
  }

  // ---------------------------------------------------------------- render
  const chip = (st) => el("span", { class: "fl-chip", "data-state": st, title: "Coordinator: " + (COORD[st] || st) }, el("i", { "aria-hidden": "true" }), COORD[st] || st);
  function stageBar(r) {
    const total = STAGES.reduce((n, [k]) => n + (r.stages[k] || 0), 0);
    const bar = el("span", { class: "fl-bar", "aria-hidden": "true" });
    for (const [k] of STAGES) if (r.stages[k]) bar.append(el("span", { "data-stage": k, style: `flex:${r.stages[k]}` }));
    return el("span", { class: "fl-stages", title: stagesText(r) }, total ? bar : null, el("span", { class: "fl-stxt", text: total ? stagesText(r) : "none open" }));
  }
  const badges = (r) => [
    r.priority ? el("span", { class: "fl-prio", title: "Priority project (fleet.toml): display only for now", text: "Priority" }) : null,
    r.mode && r.mode !== "full" ? el("span", { class: "fl-mode", "data-mode": r.mode, title: r.mode === "off" ? "Opted out of bulk actions (fleet.toml)" : "Read-only for bulk actions: reads and nudges only (fleet.toml)", text: r.mode === "off" ? "opted out" : "read-only" }) : null,
    r.status !== "active" ? el("span", { class: "fl-status", "data-status": r.status, text: r.status }) : null,
    r.error ? el("span", { class: "fl-err", title: r.error, text: "list error" }) : null,
  ];
  const lastCell = (r) => el("span", { title: r.last_activity || "no activity seen", text: r.last_activity ? ago(r.last_activity) + " ago" : "–" });
  const launchCell = (r) => launches(r)
    ? el("span", { class: "fl-launch", title: r.launches.errors.join("; ") || "stuck before the brief", text: [r.launches.failed ? `${r.launches.failed} failed` : "", r.launches.stuck ? `${r.launches.stuck} stuck` : ""].filter(Boolean).join(", ") })
    : el("span", { class: "fl-zero", text: "–" });
  const num = (n, cls) => el("span", { class: n ? cls : "fl-zero", text: n ? String(n) : "–" });
  const selBox = (r) => el("input", { type: "checkbox", class: "fl-sel", "aria-label": `Select ${r.name}`, checked: picked.has(r.slug),
    onclick: (e) => { e.stopPropagation(); tick(r.slug, e.target.checked, e.shiftKey); } });
  const nameBtn = (r) => el("button", { type: "button", class: "fl-name", title: `Open ${r.name}'s coordinator`, onclick: (e) => { e.stopPropagation(); openCoord("hub:" + r.slug); } },
    el("b", { text: r.name }), el("small", { text: r.slug }));

  function table(rows) {
    const head = el("tr", {}, el("th", { class: "fl-c-sel" }, el("input", { type: "checkbox", id: "fl-sel-all", "aria-label": "Select every shown project",
      checked: rows.length > 0 && rows.every((r) => picked.has(r.slug)),
      onclick: (e) => { for (const r of rows) e.target.checked ? picked.add(r.slug) : picked.delete(r.slug); render(); } })));
    for (const [k, label] of COLS) {
      const on = sortKey === k;
      head.append(el("th", { "aria-sort": on ? (sortDir === 1 ? "ascending" : "descending") : null },
        el("button", { type: "button", "data-sort": k, class: on ? "on" : null, title: `Sort by ${label.toLowerCase()}` + (on ? " (again: reverse)" : ""),
          onclick: () => { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; } render(); } }, label, on ? el("span", { class: "fl-dir", text: sortDir === 1 ? " ▾" : " ▴" }) : null)));
    }
    const body = el("tbody");
    for (const r of rows) {
      const tr = el("tr", { "data-slug": r.slug, tabindex: "0", class: picked.has(r.slug) ? "sel" : null, "aria-selected": String(picked.has(r.slug)),
        onclick: () => openCoord("hub:" + r.slug),
        onkeydown: (e) => {
          if (e.target !== tr) return;
          if (e.key === "Enter") { e.preventDefault(); openCoord("hub:" + r.slug); }
          else if (e.key === " ") { e.preventDefault(); tick(r.slug, !picked.has(r.slug), e.shiftKey); }
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); (e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
        } },
        el("td", { class: "fl-c-sel" }, selBox(r)),
        el("td", { class: "fl-c-name" }, nameBtn(r), ...badges(r)),
        el("td", {}, chip(r.coordinator.state)),
        el("td", { class: "fl-c-threads" }, stageBar(r)),
        el("td", { class: "fl-n" }, num(r.needs_you, "fl-needs")),
        el("td", { class: "fl-n", title: r.oldest_unacked ? `oldest ${ago(r.oldest_unacked)} ago` + (r.inbox ? ` · inbox ${r.inbox}` : "") : r.inbox ? `inbox ${r.inbox}` : null }, num(r.unacked, "fl-unacked")),
        el("td", {}, launchCell(r)),
        el("td", { class: "fl-n" }, cpu(r)),
        el("td", { class: "fl-n" }, bytes(r.rss)),
        el("td", { class: "fl-n" }, lastCell(r)));
      body.append(tr);
    }
    return el("table", { id: "fl-table", class: "fl-table" }, el("thead", {}, head), body);
  }

  function cards(rows) {
    return el("ul", { class: "fl-cards", "aria-label": "Projects" }, ...rows.map((r) => el("li", { class: "fl-card" + (picked.has(r.slug) ? " sel" : ""), "data-slug": r.slug },
      el("div", { class: "fl-card-head" }, selBox(r), nameBtn(r), chip(r.coordinator.state)),
      el("div", { class: "fl-card-tags" }, ...badges(r)),
      stageBar(r),
      el("dl", { class: "fl-facts" },
        el("dt", { text: "Needs you" }), el("dd", {}, num(r.needs_you, "fl-needs")),
        el("dt", { text: "Unacked" }), el("dd", {}, num(r.unacked, "fl-unacked")),
        el("dt", { text: "Launches" }), el("dd", {}, launchCell(r)),
        el("dt", { text: "CPU · RAM" }), el("dd", { text: `${cpu(r)} · ${bytes(r.rss)}` }),
        el("dt", { text: "Last activity" }), el("dd", {}, lastCell(r))))));
  }

  function attention() {
    const items = (data?.attention || []).filter((a) => inFocus(a.slug));
    if (!items.length) return el("p", { id: "fl-attn", class: "fl-calm", text: "Nothing needs you across the fleet." });
    return el("ol", { id: "fl-attn", class: "fl-attn", "aria-label": "Needs attention, most urgent first" }, ...items.map((a) =>
      el("li", { "data-slug": a.slug, "data-kind": a.kind },
        el("button", { type: "button", title: `Open ${a.name}'s coordinator`, onclick: () => openCoord(a.key) },
          el("span", { class: "fl-akind", "data-kind": a.kind, "aria-hidden": "true" }),
          el("b", { text: a.name }), el("span", { class: "fl-atext", text: a.text }),
          a.since ? el("span", { class: "fl-aage", text: ago(a.since) }) : null))));
  }

  function render() {
    if (!win) return;
    const body = win.body;
    const keep = document.activeElement && body.contains(document.activeElement) ? document.activeElement : null;
    const keepSlug = keep?.closest("[data-slug]")?.dataset.slug, keepId = keep?.id, keepSort = keep?.dataset?.sort;
    if (!data) {
      body.replaceChildren(el("p", { class: err ? "fl-error" : "fl-calm", role: err ? "alert" : null, text: err || "Loading the fleet…" }));
      return;
    }
    const all = data.rows.filter((r) => inFocus(r.slug)).length;
    for (const s of [...picked]) if (!data.rows.some((r) => r.slug === s)) picked.delete(s);
    const rows = rowsShown();
    const q = body.querySelector("#fl-q");
    const qSel = q && document.activeElement === q ? [q.selectionStart, q.selectionEnd] : null;
    const tools = el("div", { class: "fl-tools" },
      el("select", { id: "fl-filter", "aria-label": "Show", onchange: (e) => { filter = e.target.value; render(); } },
        ...FILTERS.map(([v, l]) => el("option", { value: v, selected: v === filter, text: l }))),
      el("input", { id: "fl-q", type: "search", placeholder: "Filter projects…", "aria-label": "Filter projects by name", value: query, autocomplete: "off",
        oninput: (e) => { query = e.target.value; render(); } }),
      el("span", { id: "fl-note", class: "fl-note", text: `${rows.length} shown · ${all < data.rows.length ? `${all} of ${data.rows.length} in focus` : `${data.rows.length} projects`}` +
        (window.HDAgents?.active() ? ` · agent filter: ${window.HDAgents.summary()} (counts, CPU and RAM are its own)` : "") }));
    const selbar = el("div", { class: "fl-selbar", hidden: picked.size === 0 },
      el("span", { id: "fl-count", text: `${picked.size} selected` }),
      el("button", { type: "button", id: "fl-copy", class: "tbtn", title: "Copy a plain-text summary of the selected projects", onclick: copy, text: "Copy summary" }),
      el("button", { type: "button", id: "fl-clear", class: "tbtn", onclick: () => { picked.clear(); render(); }, text: "Clear" }));
    const pol = data.policy || {};
    if (tab === "audit") {
      put(body, tabs(), auditView());
    } else put(body,
      tabs(),
      el("section", { class: "fl-top", "aria-label": "Attention" }, el("h3", { text: "Attention" }), attention()),
      queueView(),
      el("section", { class: "fl-main", "aria-label": "Fleet" },
        tools, selbar, actionBar(),
        err ? el("p", { class: "fl-error", role: "alert", text: err }) : null,
        pol.error ? el("p", { class: "fl-error", text: pol.error }) : null,
        rows.length ? null : el("p", { id: "fl-empty", class: "fl-calm", text: "No project matches. Change the filter or the focus." }),
        el("div", { class: "fl-scroll" }, table(rows)),
        cards(rows),
        el("p", { class: "fl-foot", text: footText() })));
    // Keep the keyboard where it was.
    let back = null;
    if (keepId) back = body.querySelector("#" + CSS.escape(keepId));
    else if (keepSort) back = body.querySelector(`button[data-sort="${keepSort}"]`);
    else if (keepSlug) back = body.querySelector(`#fl-table tr[data-slug="${CSS.escape(keepSlug)}"]`);
    if (back) {
      back.focus({ preventScroll: true });
      if (qSel && back.id === "fl-q") back.setSelectionRange(...qSel);
    }
  }


  // ---------------------------------------------------------------- actions
  const TIER = ["tier 0: always allowed", "tier 1: reversible, logged with undo", "tier 2: confirmed per batch"];
  const VERDICT = { will: "Will run", queue: "Queued", refuse: "Refused" };
  const RESULT = { pending: "Pending", ok: "Done", failed: "Failed", refused: "Refused", queued: "Queued", "not-attempted": "Not attempted" };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error(j?.error || `HTTP ${r.status}`);
      e.code = j?.code;
      e.status = r.status;
      throw e;
    }
    return j;
  }
  async function loadOps() {
    try { ops = await api("/api/fleet/ops"); } catch { ops = null; }
    render();
  }
  async function loadQueue() {
    try { queue = (await api("/api/fleet/queue")).items || []; } catch {}
  }
  function footText() {
    if (!ops) return "Actions load…";
    const l = ops.limits;
    const bits = [`Actions: up to ${l.batch_without_confirm} projects without a typed confirmation, ${l.batch_max} per batch, ${l.actions_per_minute} a minute fleet-wide; ${l.broadcast_cooldown_minutes} min between broadcasts to one coordinator.`];
    if (ops.read_only) bits.push("This dashboard is read-only: previews only.");
    if (!ops.enabled) bits.push("fleet.toml turns bulk actions off: previews only.");
    bits.push(`Audit log: ${ops.audit_path}.`);
    return bits.join(" ");
  }
  function tabs() {
    const b = (id, label) => el("button", { type: "button", "data-tab": id, class: tab === id ? "on" : null, "aria-pressed": String(tab === id),
      onclick: () => { tab = id; if (id === "audit") loadAudit(); render(); } }, label);
    return el("div", { class: "fl-tabs", role: "toolbar", "aria-label": "Master window views" }, b("fleet", "Fleet"), b("audit", "Audit"));
  }
  function actionBar() {
    if (!ops || picked.size === 0) return null;
    return el("div", { class: "fl-actions", role: "toolbar", "aria-label": "Act on the selected projects" },
      ...ops.ops.map((o) => el("button", { type: "button", class: "tbtn", "data-op": o.op, "data-tier": o.tier, title: `${o.help} (${TIER[o.tier]})`,
        onclick: () => openDialog(o.op) }, o.label)));
  }
  function queueView() {
    const items = queue.filter((q) => inFocus(q.slug));
    if (!items.length) return null;
    return el("section", { class: "fl-queue-box", "aria-label": "Queued broadcasts" },
      el("h3", { text: `Queued broadcasts (${items.length})` }),
      el("ul", { id: "fl-queue", class: "fl-queue" }, ...items.map((q) => el("li", { "data-slug": q.slug },
        el("b", { text: q.name }), el("span", { class: "fl-qwhy", text: q.reason }),
        el("span", { class: "fl-aage", text: ago(q.queued_at) }),
        el("button", { type: "button", class: "tbtn fl-sendnow", title: "Send it now if the coordinator is idle (never into a busy one)", onclick: (e) => sendNow(q, e.target) }, "Send now")))));
  }
  async function sendNow(q, b) {
    b.disabled = true;
    try {
      await api("/api/fleet/queue/send", { slug: q.slug, batch: q.batch });
      window.hd?.toast?.(`Sent to ${q.name}`);
      await loadQueue();
      render();
    } catch (e) {
      b.disabled = false;
      window.hd?.toast?.(`${q.name}: ${e.message}`, "err");
    }
  }

  // The dialog: an overlay on the window, so a re-render of the table under
  // it leaves what is typed alone.
  let dlg = null; // { op, targets, node, form, plan, batch, poll }
  function openDialog(op) {
    closeDialog();
    const spec = ops.ops.find((o) => o.op === op);
    const shown = rowsShown().map((r) => r.slug);
    const targets = [...shown.filter((s) => picked.has(s)), ...[...picked].filter((s) => !shown.includes(s))];
    const node = el("div", { id: "fl-dlg", class: "fl-dlg", role: "dialog", "aria-label": spec.label + " (preview)" });
    dlg = { op, spec, targets, node };
    win.el.append(node);
    drawDialog();
    if (!["message", "set", "priority"].includes(op)) doPreview();
  }
  function closeDialog() {
    if (!dlg) return;
    clearInterval(dlg.poll);
    clearInterval(dlg.tick);
    dlg.node.remove();
    dlg = null;
  }
  function names(slugs) {
    return slugs.map((s) => data?.rows.find((r) => r.slug === s)?.name || s).join(", ");
  }
  function formFor() {
    const { op } = dlg;
    if (op === "message") {
      const ta = el("textarea", { id: "fl-text", rows: "4", maxlength: "4000", placeholder: "What every selected coordinator should be told", "aria-label": "Message" });
      ta.value = dlg.text || "";
      ta.addEventListener("input", () => { dlg.text = ta.value; dlg.plan = null; const pv = dlg.node.querySelector(".fl-sendprev"); if (pv) pv.textContent = `${ops.prefix} ${ta.value.trim()}`; drawPlan(); });
      return el("div", { class: "fl-form" },
        el("label", { for: "fl-text", text: "Message" }), ta,
        el("p", { class: "fl-hint" }, "Sent as: ", el("q", { class: "fl-sendprev", text: `${ops.prefix} ${(dlg.text || "").trim()}` })),
        el("p", { class: "fl-hint", text: `To: ${names(dlg.targets)}. Only coordinators idle for 60 s get it now; busy ones are queued.` }),
        el("button", { type: "button", id: "fl-preview", class: "tbtn", onclick: doPreview }, "Preview"));
    }
    if (op === "set") {
      const key = el("select", { id: "fl-key", "aria-label": "Setting" }, ...ops.set_keys.map((k) => el("option", { value: k, selected: k === dlg.key, text: k })));
      const val = el("input", { id: "fl-value", "aria-label": "Value", placeholder: "4, true, false", value: dlg.value || "", autocomplete: "off" });
      key.onchange = () => { dlg.key = key.value; dlg.plan = null; drawPlan(); };
      val.oninput = () => { dlg.value = val.value; dlg.plan = null; drawPlan(); };
      dlg.key ||= key.value;
      return el("div", { class: "fl-form fl-row" }, key, el("span", { text: "=" }), val, el("button", { type: "button", id: "fl-preview", class: "tbtn", onclick: doPreview }, "Preview"));
    }
    if (op === "priority") {
      const val = el("select", { id: "fl-value", "aria-label": "Priority" }, el("option", { value: "true", text: "Priority on", selected: dlg.value !== "false" }), el("option", { value: "false", text: "Priority off", selected: dlg.value === "false" }));
      val.onchange = () => { dlg.value = val.value; dlg.plan = null; drawPlan(); };
      dlg.value ||= "true";
      return el("div", { class: "fl-form fl-row" }, val, el("button", { type: "button", id: "fl-preview", class: "tbtn", onclick: doPreview }, "Preview"));
    }
    return null;
  }
  function drawDialog() {
    const { spec, targets } = dlg;
    const title = dlg.undoOf ? `Undo ${dlg.undoOf}` : `${spec.label.replace("…", "")}: ${plural(targets.length, "project", "projects")}`;
    put(dlg.node,
      el("div", { class: "fl-dlg-head" }, el("b", { text: title }),
        el("button", { type: "button", id: "fl-dlg-close", class: "tbtn", onclick: () => { closeDialog(); load(); } }, "Close")),
      dlg.undoOf || dlg.batch ? null : formFor(),
      el("div", { class: "fl-dlg-plan" }));
    drawPlan();
  }
  async function doPreview() {
    const body = dlg.undoOf ? { op: "undo", batch: dlg.undoOf } : { op: dlg.op, targets: dlg.targets, key: dlg.key, value: dlg.value, text: dlg.text };
    dlg.err = "";
    dlg.plan = null;
    dlg.batch = null;
    drawPlan("Previewing…");
    try {
      dlg.plan = await api("/api/fleet/preview", body);
    } catch (e) {
      dlg.err = e.message;
    }
    if (dlg) drawPlan();
  }
  function drawPlan(msg) {
    if (!dlg) return;
    const box = dlg.node.querySelector(".fl-dlg-plan");
    clearInterval(dlg.tick);
    const p = dlg.plan;
    if (dlg.batch) return drawResults(box);
    if (!p) {
      put(box, dlg.err ? el("p", { class: "fl-error", role: "alert", text: dlg.err }) : el("p", { class: "fl-calm", text: msg || "" }));
      return;
    }
    const expiry = el("span", { class: "fl-expiry" });
    const tickExp = () => {
      const s = Math.round((Date.parse(p.expires) - Date.now()) / 1000);
      expiry.textContent = s > 0 ? `expires in ${s} s` : "expired: preview again";
      if (s <= 0) { run.disabled = true; clearInterval(dlg?.tick); }
    };
    const confirm = p.needs_confirm ? el("input", { id: "fl-confirm", inputmode: "numeric", autocomplete: "off", "aria-label": `Type ${p.confirm_count} to confirm`, placeholder: String(p.confirm_count), size: "4" }) : null;
    const runnable = p.counts.will + p.counts.queue > 0 && ops?.enabled && !ops?.read_only;
    const run = el("button", { type: "button", id: "fl-run", class: "tbtn fl-go", disabled: !runnable || !!confirm, onclick: () => doRun(confirm?.value) },
      p.counts.queue && !p.counts.will ? "Queue" : "Run");
    if (confirm) confirm.oninput = () => { run.disabled = !runnable || confirm.value.trim() !== String(p.confirm_count); };
    const rows = p.steps.map((st) => el("tr", { "data-slug": st.slug, "data-verdict": st.verdict },
      el("td", {}, el("b", { text: st.name }), el("small", { text: st.slug })),
      el("td", {}, el("span", { class: "fl-verdict", "data-verdict": st.verdict, text: VERDICT[st.verdict] })),
      el("td", { class: "fl-what" },
        st.command ? el("code", { text: st.command }) : null,
        st.change ? el("div", { class: "fl-change", text: st.change }) : null,
        st.reason ? el("div", { class: "fl-reason", text: st.reason }) : null,
        st.undo ? el("div", { class: "fl-undo-note", text: "Undo: " + st.undo }) : null)));
    put(box,
      p.text ? el("p", { class: "fl-hint" }, "Exact text: ", el("q", { class: "fl-sendtext", text: p.text })) : null,
      el("p", { class: "fl-sum" },
        el("span", { text: `${p.counts.will} will run · ${p.counts.queue} queued · ${p.counts.refuse} refused` }),
        el("span", { class: "fl-tier", "data-tier": p.tier, text: TIER[p.tier] + (p.confirm_reason ? ` (${p.confirm_reason})` : "") }),
        el("span", { class: "fl-hash", title: p.hash, text: p.hash.slice(0, 19) + "…" }), expiry),
      el("div", { class: "fl-scroll" }, el("table", { class: "fl-plan" }, el("tbody", {}, ...rows))),
      dlg.err ? el("p", { class: "fl-error", role: "alert", text: dlg.err }) : null,
      el("div", { class: "fl-dlg-foot" },
        confirm ? el("label", { class: "fl-confirm" }, `Type ${p.confirm_count} to confirm `, confirm) : null,
        !ops?.enabled ? el("span", { class: "fl-hint", text: "fleet.toml turns bulk actions off" }) : null,
        ops?.read_only ? el("span", { class: "fl-hint", text: "read-only dashboard" }) : null,
        run));
    tickExp();
    dlg.tick = setInterval(tickExp, 1000);
  }
  async function doRun(confirm) {
    const p = dlg.plan;
    dlg.err = "";
    try {
      const r = await api("/api/fleet/apply", { token: p.token, confirm: confirm || undefined });
      dlg.batch = { batch: r.batch, status: "running", results: p.steps.map((s) => ({ slug: s.slug, name: s.name, command: s.command, result: s.verdict === "refuse" ? "refused" : s.verdict === "queue" ? "queued" : "pending", reason: s.reason })) };
      drawPlan();
      dlg.poll = setInterval(pollBatch, 400);
    } catch (e) {
      if (e.code === "plan_changed" || e.code === "confirm_expired" || e.code === "confirm_used") {
        await doPreview();
        if (dlg) { dlg.err = e.code === "plan_changed" ? "The fleet changed since the preview: here is the fresh plan." : e.message; drawPlan(); }
      } else {
        dlg.err = e.message;
        drawPlan();
      }
    }
  }
  async function pollBatch() {
    if (!dlg?.batch) return;
    try {
      const b = await api(`/api/fleet/batch/${dlg.batch.batch}`);
      if (!dlg) return;
      dlg.batch = b;
      if (b.status !== "running") {
        clearInterval(dlg.poll);
        await loadQueue();
        load();
        if (tab === "audit") loadAudit();
      }
      drawPlan();
    } catch {}
  }
  function drawResults(box) {
    const b = dlg.batch;
    const n = (k) => b.results.filter((r) => r.result === k).length;
    put(box,
      el("p", { class: "fl-sum" }, el("span", { text: b.status === "running" ? "Running…" : `${n("ok")} done · ${n("failed")} failed · ${n("queued")} queued · ${n("refused")} refused` + (n("not-attempted") ? ` · ${n("not-attempted")} not attempted` : "") }),
        el("span", { class: "fl-hash", text: b.batch })),
      b.note ? el("p", { class: "fl-error", role: "alert", text: b.note }) : null,
      el("div", { class: "fl-scroll" }, el("table", { class: "fl-results", "data-status": b.status }, el("tbody", {}, ...b.results.map((r) => el("tr", { "data-slug": r.slug, "data-result": r.result },
        el("td", {}, el("b", { text: r.name || r.slug })),
        el("td", {}, el("span", { class: "fl-verdict", "data-result": r.result, text: RESULT[r.result] || r.result })),
        el("td", { class: "fl-what" }, r.command ? el("code", { text: r.command }) : null,
          r.output ? el("pre", { class: "fl-out", text: r.output }) : null,
          r.error ? el("div", { class: "fl-reason fl-bad", text: r.error }) : null,
          r.reason && r.result !== "ok" ? el("div", { class: "fl-reason", text: r.reason }) : null)))))),
      el("div", { class: "fl-dlg-foot" },
        b.undoable && b.status !== "running" ? el("button", { type: "button", id: "fl-undo", class: "tbtn", title: "Preview the recorded undo of this batch",
          onclick: () => { dlg.undoOf = b.batch; dlg.batch = null; drawDialog(); doPreview(); } }, "Undo…") : null));
  }

  // ---------------------------------------------------------------- audit
  async function loadAudit() {
    try {
      audit = (await api("/api/fleet/audit?limit=2000")).lines;
      auditErr = "";
    } catch (e) {
      auditErr = "Could not load the audit log: " + e.message;
    }
    render();
  }
  function auditView() {
    const lines = (audit || []).filter((l) => (!auditF.op || l.op === auditF.op) && (!auditF.result || l.result === auditF.result) &&
      (!auditF.q || (l.target || "").includes(auditF.q.trim().toLowerCase()) || (l.batch || "").includes(auditF.q.trim())) && (!auditF.day || (l.ts || "").startsWith(auditF.day)));
    const opsSeen = [...new Set((audit || []).map((l) => l.op))].sort();
    const sel = (id, label, key, values) => el("select", { id, "aria-label": label, onchange: (e) => { auditF[key] = e.target.value; render(); } },
      el("option", { value: "", text: label }), ...values.map((v) => el("option", { value: v, selected: v === auditF[key], text: v })));
    const exportBtn = el("button", { type: "button", class: "tbtn", title: "Download the shown lines as JSON", onclick: () => {
      const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(lines, null, 2)], { type: "application/json" })), download: "fleet-audit.json" });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } }, "Export");
    return el("section", { class: "fl-main", "aria-label": "Audit log" },
      el("div", { class: "fl-tools" },
        sel("fl-audit-op", "Every action", "op", opsSeen),
        sel("fl-audit-result", "Every result", "result", ["ok", "failed", "refused", "queued", "not-attempted"]),
        el("input", { id: "fl-audit-q", type: "search", placeholder: "Project or batch…", "aria-label": "Filter by project or batch", value: auditF.q, autocomplete: "off",
          oninput: (e) => { auditF.q = e.target.value; render(); } }),
        el("input", { id: "fl-audit-day", type: "date", "aria-label": "Day (UTC)", value: auditF.day, onchange: (e) => { auditF.day = e.target.value; render(); } }),
        el("button", { type: "button", class: "tbtn", onclick: loadAudit }, "Reload"), exportBtn,
        el("span", { class: "fl-note", text: audit ? `${lines.length} of ${audit.length} lines` : "" })),
      auditErr ? el("p", { class: "fl-error", role: "alert", text: auditErr }) : null,
      !audit ? el("p", { class: "fl-calm", text: "Loading the audit log…" }) :
        lines.length ? el("div", { class: "fl-scroll" }, el("table", { id: "fl-audit", class: "fl-table fl-audit" },
          el("thead", {}, el("tr", {}, ...["When", "Who", "Action", "Project", "Result", "Details", "Batch"].map((h) => el("th", { text: h })))),
          el("tbody", {}, ...lines.map((l) => el("tr", { "data-op": l.op, "data-target": l.target || "", "data-result": l.result },
            el("td", { title: l.ts, text: l.ts ? new Date(l.ts).toLocaleString() : "" }),
            el("td", { text: l.actor }),
            el("td", { text: l.op + (l.args?.length ? " " + l.args.join(" ") : "") + (l.undo_of ? " (undo)" : "") }),
            el("td", { text: l.target || "–" }),
            el("td", {}, el("span", { class: "fl-verdict", "data-result": l.result, text: l.result })),
            el("td", { class: "fl-what" },
              l.command ? el("code", { text: l.command }) : null,
              l.text ? el("div", { class: "fl-change", text: l.text }) : null,
              l.previous ? el("div", { class: "fl-change", text: "previous: " + l.previous }) : null,
              l.reason ? el("div", { class: "fl-reason", text: l.reason }) : null,
              l.error ? el("div", { class: "fl-reason fl-bad", text: l.error }) : null,
              l.undo ? el("div", { class: "fl-undo-note", text: "undo: " + l.undo.command }) : null),
            el("td", { title: (l.preview || "") + (l.confirm ? " · " + l.confirm : ""), text: l.batch || "–" })))))) :
          el("p", { class: "fl-calm", text: "No audit line matches." }));
  }

  function openWin() {
    const existed = !!win;
    win = HDWin.open("master", { title: "Master · fleet", short: "Master", cls: "fl-win", width: 1000, persist: true,
      build: (body) => body.append(el("p", { class: "fl-calm", text: "Loading the fleet…" })),
      onClose: () => { win = null; dlg = null; } });
    if (!existed || !data) { dataSig = ""; load(); }
    else render();
    loadOps();
  }

  // app.js hands over each new snapshot and system frame.
  window.HDFleet = {
    open: openWin,
    state: () => refresh(0),
    frame: () => refresh(3000),
  };
  document.addEventListener("hd-focus", () => render());
  document.addEventListener("visibilitychange", () => { if (!document.hidden && win) refresh(0); });
  // Ages move on even when nothing else does.
  setInterval(() => { if (win && !document.hidden) render(); }, 60_000);
  if (window.HDWin?.saved?.().includes("master")) openWin();
})();
