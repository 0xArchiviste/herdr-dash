// herdr-dash Threads view: how each of a project's threads is progressing,
// organised instead of one stream of text. One card per thread, grouped by
// stage (Needs you, Working, Queued, Idle, Review / PR open, Done), each
// with a labelled state chip, its reported progress, and a colour-coded
// timeline collapsed to the latest event. A summary strip counts the
// stages, filters by them, and names what is blocked on you.
//
// Mounted in the coordinator panel and window (mount) and, for a single
// thread, in the thread panel (mountThread). Data: the snapshot the page
// already streams, plus /api/project/{slug}/timeline, fetched only when the
// project's events_sig changes (never on a timer). Read state is local to
// this browser (localStorage): what is newer than you last looked at a
// thread is marked "new".
window.HDThreads = (() => {
  "use strict";
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
  const enc = encodeURIComponent;
  const st = () => window.hd?.state() || { threads: [], projects: [] };

  // Stages, in the order they are read: what needs you, then live work,
  // review last before the folded Done.
  const STAGES = [
    { id: "needs", label: "Needs you", ico: "!" },
    { id: "working", label: "Working", ico: "▸" },
    { id: "queued", label: "Queued · starting", ico: "◷" },
    { id: "idle", label: "Idle", ico: "◌" },
    { id: "review", label: "Review · PR open", ico: "⇡" },
    { id: "done", label: "Done", ico: "✓" },
  ];
  const STAGE = Object.fromEntries(STAGES.map((s) => [s.id, s]));
  const CHIP = {
    blocked: "Blocked", waiting: "Waiting on you", review: "Ready for review", landing: "Landing",
    working: "Working", idle: "Idle", resolved: "Resolved",
  };
  const LAUNCH = { placing: "Placing", queued: "Queued", launching: "Launching", briefing: "Briefing", stuck: "Brief stuck", failed: "Launch failed" };
  // Timeline event types: an icon and a colour class each (threads.css).
  const EV = {
    started: { ico: "▶", c: "start" }, progress: { ico: "◔", c: "work" }, report: { ico: "✎", c: "info" },
    "pr-opened": { ico: "⇡", c: "info" }, "pr-updated": { ico: "↻", c: "info" }, "pr-failing": { ico: "✕", c: "bad" },
    "pr-merged": { ico: "✓", c: "good" }, "pr-closed": { ico: "⊘", c: "mute" }, idle: { ico: "◌", c: "mute" },
    waiting: { ico: "!", c: "attn" }, blocked: { ico: "!", c: "bad" }, prompted: { ico: "↳", c: "mute" },
    resolved: { ico: "✓", c: "mute" }, warn: { ico: "⚠", c: "attn" }, other: { ico: "•", c: "mute" },
  };
  const stageOf = (t) => {
    if (t.state === "resolved") return "done";
    if (t.state === "blocked" || t.state === "waiting") return "needs";
    if (t.state === "review" || t.state === "landing") return "review";
    if (t.launch) return "queued";
    if (t.state === "working") return "working";
    return "idle";
  };
  const chipOf = (t) => (t.launch && t.state !== "resolved" && stageOf(t) === "queued" ? { cls: "s-queued", text: LAUNCH[t.launch.stage] || "Queued" } : { cls: "s-" + t.state, text: CHIP[t.state] || t.state });
  function ago(iso) {
    if (!iso) return "—";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!Number.isFinite(s)) return "—";
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  const age = (iso) => ago(iso).replace(/ ago$/, "").replace("just now", "<1m");
  const TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const when = (iso) => (iso ? TIME.format(new Date(iso)) : "");
  const prNum = (u) => (u && u.match(/\/pull\/(\d+)/)?.[1]) || "";

  // ---------------------------------------------------------------- read state
  const SEEN_KEY = "hd-tv-seen";
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch {}
  const saveSeen = () => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {} };
  // An event counts as new when it is newer than the thread's last look, or
  // than the first look at its project (so a first visit is quiet). Progress
  // ticks are shown but never counted: they are not news.
  function unread(slug, id) {
    const evs = tl.get(slug)?.threads?.[id];
    if (!evs) return 0;
    const since = Date.parse(seen[slug + "/" + id] || seen["@" + slug] || "") || 0;
    if (!since) return 0;
    return evs.filter((e) => e.type !== "progress" && Date.parse(e.at) > since).length;
  }
  function markRead(slug, ids) {
    const now = new Date().toISOString();
    for (const id of ids) seen[slug + "/" + id] = now;
    saveSeen();
    refreshAll();
  }

  // ---------------------------------------------------------------- timelines
  const tl = new Map(); // slug -> { want, have, threads, busy }
  function wantSig(slug) {
    const p = st().projects.find((x) => x.slug === slug);
    const ids = st().threads.filter((t) => t.project === slug).map((t) => t.id).join(",");
    return `${p?.events_sig || ""}|${ids}`;
  }
  // Fetch the project's timeline when what it is built from changed.
  function ensure(slug) {
    let e = tl.get(slug);
    if (!e) tl.set(slug, (e = { want: "", have: null, threads: null, busy: false, err: "" }));
    e.want = wantSig(slug);
    if (e.busy || e.have === e.want) return;
    e.busy = true;
    const want = e.want;
    fetch(`/api/project/${enc(slug)}/timeline`).then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((d) => {
        e.threads = d.threads || {};
        e.have = want;
        e.err = "";
        if (!seen["@" + slug]) { seen["@" + slug] = new Date().toISOString(); saveSeen(); }
      })
      .catch((err) => { e.err = String(err.message || err); e.have = want; })
      .finally(() => { e.busy = false; refreshAll(); if (e.want !== e.have) ensure(slug); });
  }

  // ---------------------------------------------------------------- report window
  function openReport(key) {
    const [slug, id] = key.split("/");
    markRead(slug, [id]);
    if (!window.HDWin) return;
    const wid = "report:" + key;
    if (HDWin.has(wid)) { HDWin.restore(wid); return; }
    const t = st().threads.find((x) => x.key === key);
    HDWin.open(wid, {
      title: `${id} · report${t ? " · " + t.title : ""}`, short: id + " report", cls: "report-win", width: 620,
      build(body) {
        const box = el("div", { class: "md", text: "Loading…" });
        body.append(box);
        fetch(`/api/thread/${enc(slug)}/${enc(id)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((d) => {
            const safe = window.dash?.safeHTML;
            if (!d.report_html) box.replaceChildren(el("em", { class: "muted", text: "No report yet. The thread writes one when it finishes or stops to ask you." }));
            else box.replaceChildren(...(safe ? safe(d.report_html) : [document.createTextNode(d.report_summary || "")]));
          })
          .catch((err) => box.replaceChildren(el("p", { class: "msg err", text: `Could not load the report (${err.message}). Close and open it again to retry.` })));
      },
    });
  }

  // ---------------------------------------------------------------- pieces
  function evRow(e) {
    const k = EV[e.type] || EV.other;
    return el("li", { class: "tv-ev ev-" + k.c, "data-type": e.type, "data-at": e.at },
      el("span", { class: "tv-ico", "aria-hidden": "true", text: k.ico }),
      el("span", { class: "tv-ev-label", text: e.label }),
      e.text ? el("span", { class: "tv-ev-text", text: e.text, title: e.text }) : null,
      el("time", { class: "tv-ev-time", datetime: e.at, title: when(e.at), text: ago(e.at) }));
  }
  function bar(t) {
    const pct = Math.max(0, Math.min(100, t.percent || 0));
    return el("div", { class: "tv-progress" },
      el("div", { class: "tv-bar", role: "progressbar", "aria-label": `${t.id} progress`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, el("i", { style: `width:${pct}%` })),
      el("span", { class: "tv-pct", text: t.percent ? pct + "%" : "—" }),
      el("span", { class: "tv-act", text: t.activity || (t.launch ? (LAUNCH[t.launch.stage] || "Queued") + (t.launch.attempt ? ` · try ${t.launch.attempt}/${t.launch.max_attempts}` : "") : "No progress reported") }));
  }
  function model(t) {
    const s = t.session || {};
    return [t.profile || s.profile || t.agent, s.model?.value].filter(Boolean).join(" · ");
  }

  // ---------------------------------------------------------------- project view
  const views = new Set();

  function mount(container, slug, opts = {}) {
    const v = { slug, opts, filter: new Set(), q: "", open: new Set(), cards: new Map(), root: null };
    const search = el("input", { class: "tv-search", type: "search", placeholder: "Search threads and events…", "aria-label": "Search threads", autocomplete: "off" });
    search.addEventListener("input", () => { v.q = search.value.trim().toLowerCase(); render(v); });
    const markAll = el("button", { type: "button", class: "tbtn tv-markall", hidden: "", onclick: () => markRead(slug, st().threads.filter((t) => t.project === slug).map((t) => t.id)) });
    v.sum = el("div", { class: "tv-sum" });
    v.counts = el("div", { class: "tv-counts", role: "group", "aria-label": "Filter by stage" });
    v.overall = el("div", { class: "tv-overall" });
    v.blocked = el("div", { class: "tv-blocked" });
    v.status = el("p", { class: "tv-status muted", role: "status", "aria-live": "polite" });
    v.sum.append(v.counts, el("div", { class: "tv-sumrow" }, v.overall, markAll), v.blocked);
    v.markAll = markAll;
    v.search = search;
    v.stages = new Map();
    for (const s of STAGES) {
      const head = [el("span", { class: "tv-dot", "aria-hidden": "true" }), el("span", { class: "tv-sh-label", text: s.label }), el("span", { class: "tv-sh-n" })];
      const list = el("div", { class: "tv-list" });
      const node = s.id === "done"
        ? el("details", { class: "tv-stage", "data-stage": s.id }, el("summary", { class: "tv-sh" }, ...head), list)
        : el("section", { class: "tv-stage", "data-stage": s.id, "aria-label": s.label }, el("h4", { class: "tv-sh" }, ...head), list);
      v.stages.set(s.id, { node, list, n: head[2] });
    }
    v.empty = el("div", { class: "tv-empty", hidden: "" });
    v.root = el("div", { class: "tv" + (opts.compact ? " compact" : "") }, v.sum,
      el("div", { class: "tv-tools" }, search), v.status, ...[...v.stages.values()].map((s) => s.node), v.empty);
    container.replaceChildren(v.root);
    views.add(v);
    ensure(slug);
    render(v);
    return { el: v.root, update: () => render(v), destroy: () => views.delete(v) };
  }

  function matches(v, t) {
    if (!v.q) return true;
    const evs = tl.get(v.slug)?.threads?.[t.id] || [];
    const hay = [t.id, t.title, t.activity, t.branch, t.profile, t.agent, CHIP[t.state], ...evs.flatMap((e) => [e.label, e.text])].join("\n").toLowerCase();
    return hay.includes(v.q);
  }

  function card(v, t) {
    const evs = tl.get(v.slug)?.threads?.[t.id] || [];
    const n = unread(v.slug, t.id);
    const open = v.open.has(t.id);
    const chip = chipOf(t);
    const pr = prNum(t.pr);
    const sig = JSON.stringify([t.state, t.title, t.percent, t.activity, t.launch, t.pr, t.pr_state, t.last_activity, model(t), evs.length, evs[0]?.at, n, open, Math.floor(Date.now() / 60000)]);
    let c = v.cards.get(t.id);
    if (c && c.dataset.sig === sig) return c;
    if (!c) { c = el("article", { class: "tv-card", "data-id": t.id, "data-key": t.key }); v.cards.set(t.id, c); }
    c.dataset.sig = sig;
    c.classList.toggle("unread", n > 0);
    c.dataset.stage = stageOf(t);
    const latest = evs[0];
    const more = Math.max(0, evs.length - 1);
    const expand = el("button", { type: "button", class: "tv-expand", "aria-expanded": String(open), "aria-controls": `tv-ev-${v.slug}-${t.id}`,
      title: open ? "Hide the timeline" : `Show the timeline (${evs.length} event${evs.length === 1 ? "" : "s"})`,
      onclick: () => {
        if (v.open.has(t.id)) v.open.delete(t.id); else { v.open.add(t.id); }
        markRead(v.slug, [t.id]);
      } },
    el("span", { class: "tv-caret", "aria-hidden": "true", text: open ? "▾" : "▸" }),
    open ? el("span", { class: "tv-latest" }, el("span", { class: "tv-ev-label", text: `Timeline · ${evs.length} event${evs.length === 1 ? "" : "s"}, newest first` }))
      : latest ? el("span", { class: "tv-latest ev-" + (EV[latest.type] || EV.other).c },
      el("span", { class: "tv-ico", "aria-hidden": "true", text: (EV[latest.type] || EV.other).ico }),
      el("span", { class: "tv-ev-label", text: latest.label }),
      latest.text ? el("span", { class: "tv-ev-text", text: latest.text }) : null)
      : el("span", { class: "tv-latest muted", text: tl.get(v.slug)?.threads ? "No events yet" : "Loading events…" }),
    latest && !open ? el("time", { class: "tv-ev-time", datetime: latest.at, title: when(latest.at), text: ago(latest.at) }) : null,
    el("span", { class: "tv-more", text: open ? "Hide" : more ? `+${more} more` : "" }));
    c.replaceChildren(...[
      el("div", { class: "tv-top" },
        n ? el("span", { class: "tv-unread", title: `${n} new event${n === 1 ? "" : "s"} since you last looked`, text: `${n} new` }) : null,
        el("span", { class: "tv-chip " + chip.cls, text: chip.text }),
        el("span", { class: "tv-id", text: t.id }),
        el("span", { class: "tv-title", text: t.title, title: t.title }),
        el("span", { class: "tv-acts" },
          el("button", { type: "button", class: "tbtn tv-report", title: `Open ${t.id}'s report in a window`, "aria-label": `Report of ${t.id}`, text: "Report", onclick: () => openReport(t.key) }),
          el("button", { type: "button", class: "tbtn tv-open", title: `Open ${t.id}'s panel`, "aria-label": `Open ${t.id}`, text: "Open", onclick: () => window.hd?.select(t.key) }))),
      t.state === "resolved" ? null : bar(t),
      el("div", { class: "tv-meta" },
        model(t) ? el("span", { text: model(t) }) : null,
        el("span", { title: "Age: since the thread started", text: "age " + age(t.created) }),
        el("span", { title: when(t.last_activity), text: "updated " + ago(t.last_activity) }),
        pr ? el("a", { class: "tv-pr", href: t.pr, target: "_blank", rel: "noopener noreferrer", text: `PR #${pr}${t.pr_state ? " · " + t.pr_state.toLowerCase() : ""}` }) : null),
      expand,
      open ? el("ol", { class: "tv-events", id: `tv-ev-${v.slug}-${t.id}`, "aria-label": `${t.id} timeline, newest first` }, ...evs.map(evRow)) : null].filter(Boolean));
    return c;
  }

  function render(v) {
    if (!v.root.isConnected) { views.delete(v); return; }
    const slug = v.slug;
    ensure(slug);
    // Done needs the project's resolved threads, which the live stream leaves out.
    window.hd?.needResolved?.(slug);
    const all = st().threads.filter((t) => t.project === slug);
    const by = Object.fromEntries(STAGES.map((s) => [s.id, []]));
    for (const t of all) by[stageOf(t)].push(t);
    const rank = { blocked: 0, waiting: 1, landing: 0, review: 1 };
    const recent = (t) => -(Date.parse(t.last_activity || t.updated || t.created || "") || 0);
    for (const k of Object.keys(by)) by[k].sort((a, b) => (rank[a.state] ?? 5) - (rank[b.state] ?? 5) || recent(a) - recent(b));
    // Summary: counts that filter, overall progress, what is blocked on you.
    const csig = JSON.stringify([STAGES.map((s) => by[s.id].length), [...v.filter]]);
    if (v.counts.dataset.sig !== csig) {
      v.counts.dataset.sig = csig;
      v.counts.replaceChildren(...STAGES.map((s) => el("button", { type: "button", class: "tv-count s-" + s.id, "data-stage": s.id, "aria-pressed": String(v.filter.has(s.id)),
        title: v.filter.has(s.id) ? `Showing ${s.label}: click to show every stage` : `Show only ${s.label}`,
        onclick: () => { v.filter.has(s.id) ? v.filter.delete(s.id) : v.filter.add(s.id); render(v); } },
      el("span", { class: "tv-dot", "aria-hidden": "true" }), el("span", { class: "lbl", text: s.label }), el("span", { class: "n", text: String(by[s.id].length) }))));
    }
    const open = all.filter((t) => t.state !== "resolved");
    const avg = open.length ? Math.round(open.reduce((a, t) => a + Math.max(0, Math.min(100, t.percent || 0)), 0) / open.length) : 0;
    const totalNew = all.reduce((a, t) => a + unread(slug, t.id), 0);
    v.overall.replaceChildren(...[
      el("span", { class: "tv-ov-label", text: open.length ? `Open work ${avg}%` : "No open threads" }),
      open.length ? el("span", { class: "tv-bar wide", role: "progressbar", "aria-label": "Average progress of open threads", "aria-valuenow": String(avg), "aria-valuemin": "0", "aria-valuemax": "100" }, el("i", { style: `width:${avg}%` })) : null,
      el("span", { class: "muted", text: `${open.length} open · ${by.done.length} done${totalNew ? ` · ${totalNew} new` : ""}` })].filter(Boolean));
    v.markAll.hidden = !totalNew;
    v.markAll.textContent = `Mark ${totalNew} new as read`;
    const needs = by.needs;
    v.blocked.hidden = !needs.length;
    const bsig = JSON.stringify(needs.map((t) => [t.id, t.title, t.state]));
    if (v.blocked.dataset.sig !== bsig) {
      v.blocked.dataset.sig = bsig;
      v.blocked.replaceChildren(el("span", { class: "tv-bl-label", text: "Blocked on you:" }),
        ...needs.map((t) => el("button", { type: "button", class: "tbtn tv-bl", "data-id": t.id, title: `${CHIP[t.state]}: open ${t.id}`, onclick: () => window.hd?.select(t.key) },
          el("span", { class: "tv-chip s-" + t.state, text: CHIP[t.state] }), ` ${t.id} · ${t.title}`)));
    }
    const e = tl.get(slug);
    v.status.textContent = e?.err ? `Timeline unavailable (${e.err}); cards still update. It retries when the project changes.` : "";
    v.status.hidden = !e?.err;
    // Cards, by stage.
    let shown = 0;
    for (const s of STAGES) {
      const g = v.stages.get(s.id);
      const want = !v.filter.size || v.filter.has(s.id);
      const list = want ? by[s.id].filter((t) => matches(v, t)) : [];
      shown += list.length;
      g.node.hidden = !list.length;
      g.n.textContent = String(list.length);
      if (s.id === "done" && v.filter.has("done") && !g.node.open) g.node.open = true;
      const cards = list.map((t) => card(v, t));
      if (cards.length !== g.list.childElementCount || cards.some((c, i) => g.list.children[i] !== c)) g.list.replaceChildren(...cards);
    }
    for (const id of v.cards.keys()) if (!all.some((t) => t.id === id)) v.cards.delete(id);
    v.empty.hidden = shown > 0;
    if (!shown) {
      const filtered = v.q || v.filter.size;
      v.empty.replaceChildren(...[el("p", { text: filtered ? `No threads match${v.q ? ` “${v.search.value.trim()}”` : ""}${v.filter.size ? " in the chosen stages" : ""}.` : "No threads in this project yet." }),
        filtered ? el("button", { type: "button", class: "tbtn", text: "Clear search and filters", onclick: () => { v.q = ""; v.search.value = ""; v.filter.clear(); render(v); } }) : null].filter(Boolean));
    }
  }

  // ---------------------------------------------------------------- one thread
  const singles = new Set();
  function mountThread(container, key) {
    const [slug, id] = key.split("/");
    const s = { slug, id, key, root: el("div", { class: "tv tv-thread" }) };
    container.replaceChildren(s.root);
    singles.add(s);
    ensure(slug);
    renderThread(s);
    return { el: s.root, update: () => renderThread(s), destroy: () => singles.delete(s) };
  }
  function renderThread(s) {
    if (!s.root.isConnected) { singles.delete(s); return; }
    ensure(s.slug);
    const e = tl.get(s.slug);
    const evs = e?.threads?.[s.id] || [];
    const sig = JSON.stringify([evs.length, evs[0]?.at, e?.err, !!e?.threads, Math.floor(Date.now() / 60000)]);
    if (s.root.dataset.sig === sig) return;
    s.root.dataset.sig = sig;
    if (s.root.isConnected && evs.length && unread(s.slug, s.id)) { seen[s.slug + "/" + s.id] = new Date().toISOString(); saveSeen(); }
    s.root.replaceChildren(...[
      e?.err ? el("p", { class: "msg warn", text: `Timeline unavailable (${e.err}). It retries when the project changes.` }) : null,
      evs.length ? el("ol", { class: "tv-events", "aria-label": `${s.id} timeline, newest first` }, ...evs.map(evRow))
        : el("p", { class: "muted", text: e?.threads ? "No events yet." : "Loading events…" }),
      el("button", { type: "button", class: "tbtn tv-report", text: "Open the report in a window", onclick: () => openReport(s.key) })].filter(Boolean));
  }

  function refreshAll() {
    for (const v of [...views]) render(v);
    for (const s of [...singles]) renderThread(s);
  }
  // Relative times age even when nothing else changes.
  setInterval(() => { if (!document.hidden) refreshAll(); }, 60000);

  return { mount, mountThread, state: refreshAll, openReport, stageOf, STAGES };
})();
