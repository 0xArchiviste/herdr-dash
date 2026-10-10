// herdr-dash usage: a compact strip in the header with what is left on the
// Claude Code plan, the Codex plan and the opencode provider balance, and a
// details popover. The server reads and caches the sources (GET /api/usage);
// this only polls it while the page is visible. Sources the server reports as
// disabled get no gauge; unavailable ones say so instead of guessing.
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
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };

  const strip = el("div", { id: "usage", class: "usage", role: "group", "aria-label": "Plan usage" });
  strip.hidden = true;
  const pop = el("div", { id: "usage-pop", class: "usage-pop", role: "dialog", "aria-label": "Usage details" });
  pop.hidden = true;
  const top = $("#top");
  top.insertBefore(strip, $("#updated"));
  document.body.append(pop);

  let data = null, openID = null, lastFetch = 0, every = 120_000;

  const left = (w) => Math.max(0, Math.min(100, 100 - w.used_percent));
  const level = (pct) => (pct >= 50 ? "ok" : pct >= 20 ? "warn" : "low");
  const worst = (lv) => (lv.includes("low") ? "low" : lv.includes("warn") ? "warn" : "ok");
  const pct = (n) => `${Math.round(n)}%`;
  const balLevel = (b) => (b && b.total ? level((100 * b.remaining) / b.total) : "ok");
  const money = (n, unit) => unit === "USD"
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n)
    : `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
  const short = (n, unit) => unit === "USD" ? money(n, unit) : `${Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)} cr`;
  const when = (iso) => new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const clock = (iso) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  function rel(iso) {
    let s = Math.round((Date.parse(iso) - Date.now()) / 1000);
    const past = s < 0;
    s = Math.abs(s);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    const txt = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : "now";
    return txt === "now" ? txt : past ? `${txt} ago` : `in ${txt}`;
  }
  const visible = () => (data?.sources || []).filter((s) => s.status !== "disabled");

  function gauge(w, i) {
    const l = left(w), lv = level(l);
    return el("span", { class: "ug", "data-win": String(i), "data-level": lv, title: `${w.label}: ${pct(l)} left` },
      el("span", { class: "ul", text: w.label.split(" · ")[0] }),
      el("b", {}, el("i", { style: `width:${l}%` })));
  }

  function renderStrip() {
    const srcs = visible();
    strip.hidden = !srcs.length;
    strip.replaceChildren();
    for (const s of srcs) {
      const kids = [el("span", { class: "un", text: s.name })];
      const lv = [];
      if (s.status !== "ok") {
        kids.push(el("span", { class: "una", text: "n/a" }));
      } else {
        s.windows.slice(0, 2).forEach((w, i) => { kids.push(gauge(w, i)); lv.push(level(left(w))); });
        const minLeft = s.windows.length ? Math.min(...s.windows.slice(0, 2).map(left)) : null;
        if (minLeft != null) kids.push(el("span", { class: "upct", text: pct(minLeft) }));
        if (s.balance && !s.windows.length) { kids.push(el("span", { class: "ubal", text: short(s.balance.remaining, s.balance.unit) })); lv.push(balLevel(s.balance)); }
      }
      const title = s.status === "ok"
        ? [s.name, ...s.windows.map((w) => `${w.label} ${pct(left(w))} left`), s.balance ? `${money(s.balance.remaining, s.balance.unit)} left` : null, s.stale ? "(stale)" : null].filter(Boolean).join(" · ")
        : `${s.name}: unavailable (${s.reason || "unknown"})`;
      strip.append(el("button", {
        class: "usrc" + (s.status === "ok" ? "" : " na") + (s.stale ? " stale" : ""), type: "button", "data-id": s.id,
        "data-level": s.status === "ok" ? worst(lv) : "na", title, "aria-expanded": String(openID === s.id),
        onclick: (e) => { e.stopPropagation(); openID === s.id && !pop.hidden ? close() : open(s.id); },
      }, ...kids));
    }
    if (data) strip.append(el("time", { class: "ustamp", datetime: data.generated_at, title: `Usage updated ${clock(data.generated_at)}`, text: clock(data.generated_at) }));
  }

  function section(s) {
    const head = el("div", { class: "uh" }, el("b", { text: s.name }), s.plan ? el("span", { class: "uplan", text: s.plan }) : null,
      s.status === "ok" ? null : el("span", { class: "ubad", text: "unavailable" }));
    const body = [head];
    if (s.status !== "ok") body.push(el("div", { class: "ureason", text: s.reason || "No data." }));
    for (const w of s.windows) {
      const l = left(w);
      const reset = w.reset_passed
        ? el("span", { class: "ureset", text: "reset since last seen" })
        : w.resets_at ? el("span", { class: "ureset" }, "resets ", el("time", { class: "reset", datetime: w.resets_at, text: when(w.resets_at) }), ` (${rel(w.resets_at)})`) : null;
      body.push(el("div", { class: "uw", "data-level": level(l) },
        el("span", { class: "ul", text: w.label }),
        el("b", { class: "ubar" }, el("i", { style: `width:${l}%` })),
        el("span", { class: "upct", text: `${pct(l)} left` }),
        el("span", { class: "uused", text: `${pct(w.used_percent)} used` }),
        reset));
    }
    if (s.balance) {
      const b = s.balance;
      body.push(el("div", { class: "ubalance", "data-level": balLevel(b) }, el("span", { class: "ul", text: "Balance" }),
        el("span", { text: b.total ? `${money(b.remaining, b.unit)} of ${money(b.total, b.unit)} left` : `${money(b.remaining, b.unit)} left` })));
    }
    if (s.status === "ok" && s.reason) body.push(el("div", { class: "ureason", text: `Live check failed: ${s.reason}` }));
    const stamp = [];
    if (s.as_of) stamp.push(`data from ${rel(s.as_of)}${s.stale ? " (stale)" : ""}`);
    stamp.push(`checked ${clock(s.checked_at)}`);
    body.push(el("div", { class: "umeta", text: stamp.join(" · ") }));
    return el("section", { class: "usec" + (s.id === openID ? " focus" : ""), "data-id": s.id }, ...body);
  }

  function renderPop() {
    if (pop.hidden) return;
    const srcs = visible();
    pop.replaceChildren(
      el("div", { class: "utop" }, el("b", { text: "Usage left" }),
        el("button", { class: "close", type: "button", "aria-label": "Close usage", text: "×", onclick: close })),
      ...srcs.map(section),
      el("div", { class: "umeta" }, "Updated ", el("time", { datetime: data.generated_at, text: clock(data.generated_at) }),
        ` · refreshes every ${Math.round(every / 60000)} min while open`));
    const r = $("#top").getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    pop.querySelector(`.usec[data-id="${openID}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function open(id) {
    openID = id;
    pop.hidden = false;
    renderStrip();
    renderPop();
    if (Date.now() - lastFetch > 60_000) load();
  }
  function close() {
    pop.hidden = true;
    openID = null;
    renderStrip();
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) close(); });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && !strip.contains(e.target)) close(); });

  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const r = await fetch("/api/usage");
      if (r.ok) {
        data = await r.json();
        lastFetch = Date.now();
        if (data.refresh_seconds > 0) every = Math.max(60_000, data.refresh_seconds * 1000);
        renderStrip();
        renderPop();
      }
    } catch {} finally { loading = false; }
  }
  // Poll only while the page is visible; the server caches each source.
  setInterval(() => { if (document.visibilityState === "visible" && Date.now() - lastFetch >= every - 1000) load(); }, 30_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastFetch >= every) load(); });
  load();
})();
