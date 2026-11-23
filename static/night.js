// herdr-dash Night mode (night.go): a "🌙 Night mode" toggle in the top bar
// opens its settings (off, on now with an auto-off time, or a nightly
// window; scope; questions; loop limit; the deny list). While it is on, a
// banner on every page (the dashboard, pop-outs, the desktop app, phones)
// says so with tonight's counts. The Night log window lists what was
// approved, what was left for the morning and why, and the loops flagged.
// When a night ends the page shows a summary toast (once per night, also
// when the page is opened the next morning). The server does the work: no
// page needs to be open.
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
      else if (k === "checked" || k === "value") e[k] = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const SEEN_KEY = "hd-night-seen"; // the last night whose summary was shown
  const POLL = 10_000;

  let st = null; // GET /api/night
  let wasActive = null;
  let setWin = null, logWin = null;
  let draft = null; // the settings being edited
  let logDays = 3;

  // ---------------------------------------------------------------- chrome
  const toggle = el("button", { id: "night-toggle", class: "tbtn night-toggle", type: "button", title: "Night mode: approve permission prompts automatically while you sleep", onclick: () => openSettings() },
    el("span", { class: "nt-label", text: "🌙 Night mode" }), el("span", { class: "nt-badge", hidden: true }));
  const top = $("#top");
  if (top) top.insertBefore(toggle, $("#updated"));

  const banner = el("div", { id: "night-banner", role: "status", hidden: true });
  document.body.prepend(banner);

  const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return (today ? "" : d.toLocaleDateString([], { weekday: "short" }) + " ") + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function renderChrome() {
    const on = !!st?.active;
    toggle.classList.toggle("on", on);
    const badge = $(".nt-badge", toggle);
    const sched = st?.settings?.mode === "schedule";
    badge.hidden = !on && !sched;
    badge.textContent = on ? "on" : sched ? `${st.settings.start}–${st.settings.end}` : "";
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
    banner.hidden = !on;
    document.body.classList.toggle("night-on", on);
    if (!on) { banner.replaceChildren(); return; }
    const s = st.session || { approved: 0, refused: 0, failed: 0, loops: 0 };
    const until = st.until ? ` until ${fmtClock(st.until)}` : "";
    banner.replaceChildren(
      el("span", { class: "nb-moon", "aria-hidden": "true", text: "🌙" }),
      el("span", { class: "nb-text" }, el("b", { text: "Night mode is on" }),
        el("span", { class: "nb-long", text: ` — permission prompts are approved automatically${until}.` }),
        el("span", { class: "nb-short", text: until })),
      el("span", { class: "nb-counts", text: `${s.approved} approved · ${s.refused + s.failed} left for you${s.loops ? ` · ${plural(s.loops, "loop", "loops")}` : ""}` }),
      el("button", { class: "tbtn nb-log", type: "button", text: "Night log", onclick: () => openLog() }),
      el("button", { class: "tbtn nb-set", type: "button", text: "Settings", onclick: () => openSettings() }),
      st.read_only ? null : el("button", { class: "tbtn nb-off", type: "button", text: "Turn off", onclick: () => save({ mode: "off" }) }));
    requestAnimationFrame(() => document.body.style.setProperty("--nb-h", banner.offsetHeight + "px"));
  }

  // The summary toast of a night that ended: once per night.
  function endToast(s) {
    if (!s?.ended) return;
    if (localStorage.getItem(SEEN_KEY) === s.ended) return;
    if (Date.now() - Date.parse(s.ended) > 18 * 3600_000) return;
    localStorage.setItem(SEEN_KEY, s.ended);
    const left = s.refused + s.failed;
    const t = el("div", { class: "toast night-end", role: "status", title: "Open the Night log" },
      el("b", { text: "🌙 Night mode ended. " }),
      `${plural(s.approved, "prompt", "prompts")} approved, ${left} left for you${s.loops ? `, ${plural(s.loops, "loop", "loops")} flagged` : ""}. `,
      el("u", { text: "Open the Night log" }));
    t.addEventListener("click", () => { t.remove(); openLog(); });
    ($("#toasts") || document.body).append(t);
    setTimeout(() => t.remove(), 60_000);
  }

  // ---------------------------------------------------------------- data
  let inflight = false;
  async function load() {
    if (inflight) return;
    inflight = true;
    try {
      const r = await fetch("/api/night");
      if (!r.ok) throw new Error("HTTP " + r.status);
      st = await r.json();
    } catch { return; } finally { inflight = false; }
    renderChrome();
    if (wasActive === true && !st.active) endToast(st.last_session);
    else if (wasActive === null && !st.active) endToast(st.last_session);
    wasActive = st.active;
    if (setWin && !draft) renderSettings();
    if (logWin) loadLog();
  }
  addEventListener("resize", () => { if (!banner.hidden) document.body.style.setProperty("--nb-h", banner.offsetHeight + "px"); });
  setInterval(() => { if (!document.hidden) load(); }, POLL);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  load();

  async function save(patch) {
    const r = await fetch("/api/night", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) return (j && j.error) || "HTTP " + r.status;
    st = j;
    renderChrome();
    if (wasActive === true && !st.active) endToast(st.last_session);
    wasActive = st.active;
    return "";
  }

  // ---------------------------------------------------------------- settings
  function openSettings() {
    setWin = window.HDWin.open("night", { title: "🌙 Night mode", short: "Night", cls: "nm-win", width: 560,
      onClose: () => { setWin = null; draft = null; } });
    draft = null;
    if (st) renderSettings(); else load();
  }

  function projectsKnown() {
    const s = window.dash?.state?.() || window.hd?.state?.() || { projects: [] };
    return (s.projects || []).map((p) => ({ slug: p.slug, name: p.name || p.slug }));
  }

  function renderSettings() {
    if (!setWin || !st) return;
    if (!draft) draft = JSON.parse(JSON.stringify(st.settings));
    const d = draft;
    const ro = st.read_only;
    const msg = el("p", { class: "nm-msg", role: "status" });
    const radio = (name, value, label, checked, onchange) =>
      el("label", { class: "nm-radio" }, el("input", { type: "radio", name, value, checked, disabled: ro, onchange }), " " + label);
    const time = (value, onchange, label) => el("input", { type: "time", step: "60", value: (value || "").slice(0, 5), "aria-label": label, disabled: ro, onchange: (e) => onchange(e.target.value) });
    const status = st.active
      ? `On now (${st.why === "schedule" ? "nightly window" : "switched on"})${st.until ? ", until " + fmtClock(st.until) : ""}.`
      : d.mode === "schedule" ? `Off now; on from ${st.settings.start} to ${st.settings.end}.` : "Off.";

    const modeBox = el("fieldset", { class: "nm-mode" }, el("legend", { text: "When" }),
      radio("nm-mode", "off", "Off", d.mode === "off", () => { d.mode = "off"; renderSettings(); }),
      el("div", { class: "nm-line" }, radio("nm-mode", "on", "On now", d.mode === "on", () => { d.mode = "on"; renderSettings(); }),
        el("label", { class: "nm-sub" }, el("input", { type: "checkbox", checked: !!d.off_at, disabled: ro || d.mode !== "on", onchange: (e) => { d.off_at = e.target.checked ? "08:00" : ""; renderSettings(); } }), " switch off at "),
        d.off_at ? time(d.off_at, (v) => (d.off_at = v), "Switch off at") : null),
      el("div", { class: "nm-line" }, radio("nm-mode", "schedule", "Every night from", d.mode === "schedule", () => { d.mode = "schedule"; renderSettings(); }),
        time(d.start, (v) => (d.start = v), "Start"), " to ", time(d.end, (v) => (d.end = v), "End"), el("span", { class: "nm-hint", text: " (this machine's local time)" })));

    const known = projectsKnown();
    const chosen = new Set(d.projects);
    const all = d.projects.length === 0;
    const projBox = el("fieldset", { class: "nm-proj" }, el("legend", { text: "Projects" }),
      radio("nm-proj", "all", "All projects", all, () => { d.projects = []; renderSettings(); }),
      radio("nm-proj", "chosen", "Chosen projects", !all, () => { const f = window.hd?.focus?.() || []; d.projects = f.length ? f : known.slice(0, 1).map((p) => p.slug); renderSettings(); }),
      all ? null : el("button", { class: "tbtn nm-usefocus", type: "button", disabled: ro, text: "Use the project focus", title: "Take the projects ticked in the focus picker (P)",
        onclick: () => { const f = window.hd?.focus?.() || []; if (f.length) { d.projects = f; renderSettings(); } else msg.textContent = "No projects are focused: tick some in the focus picker first."; } }),
      all ? null : el("div", { class: "nm-plist" }, ...known.map((p) => el("label", {}, el("input", { type: "checkbox", value: p.slug, checked: chosen.has(p.slug), disabled: ro,
        onchange: (e) => { if (e.target.checked) chosen.add(p.slug); else chosen.delete(p.slug); d.projects = [...chosen]; } }), " " + p.name))));

    const whatBox = el("fieldset", { class: "nm-what" }, el("legend", { text: "What it answers" }),
      el("p", { class: "nm-hint", text: "Permission prompts, with the allow-once option (never “don't ask again”). Plan approvals and anything ambiguous are always left for you." }),
      radio("nm-who", "threads", "Threads only", !d.coordinators, () => { d.coordinators = false; }),
      radio("nm-who", "both", "Threads and coordinators", d.coordinators, () => { d.coordinators = true; }),
      el("label", { class: "nm-check" }, el("input", { type: "checkbox", class: "nm-questions", checked: d.questions, disabled: ro, onchange: (e) => (d.questions = e.target.checked) }),
        " Answer questions that mark exactly one option “(Recommended)”"));

    const num = (v, min, max, set, label) => el("input", { type: "number", min, max, value: v, "aria-label": label, disabled: ro, class: "nm-num", onchange: (e) => set(parseInt(e.target.value, 10)) });
    const guardBox = el("fieldset", { class: "nm-guard" }, el("legend", { text: "Guardrails" }),
      el("div", { class: "nm-line" }, "Stop answering a pane that asks more than ", num(d.loop_max, 1, 1000, (v) => (d.loop_max = v), "Loop limit"), " times in ",
        num(d.loop_minutes, 1, 1440, (v) => (d.loop_minutes = v), "Loop minutes"), " minutes"),
      el("div", { class: "nm-line" }, "Answer once a prompt has been still for ", num(d.stable_seconds, 1, 60, (v) => (d.stable_seconds = v), "Stable seconds"), " seconds"),
      el("div", { class: "nm-deny-head" }, el("b", { text: "Never approve (deny list)" }),
        el("span", { class: "nm-hint", text: " regular expressions, case ignored; builtin:rm-outside-worktree checks rm -r targets" })),
      el("div", { class: "nm-deny" }, ...d.deny.map((r, i) => el("div", { class: "nm-rule" },
        el("input", { class: "nm-rname", value: r.name, "aria-label": "Rule name", disabled: ro, onchange: (e) => (r.name = e.target.value) }),
        el("input", { class: "nm-rpat mono", value: r.pattern, "aria-label": "Pattern", disabled: ro, spellcheck: "false", onchange: (e) => (r.pattern = e.target.value) }),
        el("button", { class: "tbtn", type: "button", title: "Remove", "aria-label": "Remove rule", disabled: ro, text: "×", onclick: () => { d.deny.splice(i, 1); renderSettings(); } })))),
      el("div", { class: "nm-line" },
        el("button", { class: "tbtn", type: "button", disabled: ro, text: "Add rule", onclick: () => { d.deny.push({ name: "", pattern: "" }); renderSettings(); } }),
        el("button", { class: "tbtn", type: "button", disabled: ro, text: "Restore defaults", onclick: () => { d.deny = JSON.parse(JSON.stringify(st.default_deny)); renderSettings(); } })));

    const foot = el("div", { class: "nm-foot" },
      el("button", { class: "tbtn primary nm-save", type: "button", disabled: ro, text: "Save", onclick: async () => {
        d.deny = d.deny.filter((r) => r.pattern.trim());
        const err = await save(d);
        if (err) { msg.textContent = err; msg.classList.add("err"); return; }
        draft = null;
        renderSettings();
        $(".nm-msg", setWin.body).textContent = "Saved.";
      } }),
      el("button", { class: "tbtn", type: "button", text: "Night log", onclick: () => openLog() }),
      msg);
    setWin.body.replaceChildren(
      el("p", { class: "nm-status" + (st.active ? " on" : "") }, el("b", { text: status }), ro ? " This dashboard is read-only: nothing is answered." : null),
      modeBox, projBox, whatBox, guardBox, foot);
    fit(setWin);
  }

  // fit keeps a tall window's bottom on screen (it scrolls inside).
  function fit(w) {
    if (!w || w.el.classList.contains("docked")) return;
    w.el.style.maxHeight = "";
    const r = w.el.getBoundingClientRect();
    if (r.bottom > innerHeight - 8) w.el.style.maxHeight = Math.max(200, innerHeight - r.top - 12) + "px";
  }

  // ---------------------------------------------------------------- log
  function openLog() {
    logWin = window.HDWin.open("night-log", { title: "🌙 Night log", short: "Night log", cls: "nl-win", width: 820,
      build: (b) => b.append(el("p", { class: "nm-hint", text: "Loading…" })), onClose: () => { logWin = null; } });
    loadLog();
  }

  let logBusy = false;
  async function loadLog() {
    if (!logWin || logBusy) return;
    logBusy = true;
    let entries = [];
    try {
      const r = await fetch(`/api/night/log?days=${logDays}`);
      entries = (await r.json()).entries || [];
    } catch (e) {
      logWin.body.replaceChildren(el("p", { class: "fl-error", text: "Could not load the Night log: " + e.message }));
      return;
    } finally { logBusy = false; }
    renderLog(entries);
  }

  function who(e) {
    return e.coordinator ? `${e.project} · coordinator` : `${e.project}/${e.thread}`;
  }
  function openWho(e) {
    const key = e.coordinator ? "hub:" + e.project : `${e.project}/${e.thread}`;
    if (window.HDOpen?.open) window.HDOpen.open(key);
    else window.hd?.select?.(key);
  }

  function renderLog(entries) {
    if (!logWin) return;
    const approved = entries.filter((e) => e.result === "approved").reverse();
    const loops = entries.filter((e) => e.result !== "approved" && /^loop/i.test(e.reason || "")).reverse();
    const left = entries.filter((e) => e.result !== "approved" && !/^loop/i.test(e.reason || "")).reverse();
    const row = (e, what) => el("li", { class: "nl-row" + (e.pending ? " pending" : ""), "data-result": e.result },
      el("span", { class: "nl-time mono", text: fmtWhen(e.ts) }),
      el("button", { class: "nl-who", type: "button", title: "Open " + who(e), text: who(e), onclick: () => openWho(e) }),
      el("span", { class: "nl-h", text: e.harness || "" }),
      el("span", { class: "nl-cmd mono", title: e.command, text: e.command }),
      el("span", { class: "nl-what", text: what(e) }),
      e.pending ? el("span", { class: "nl-pend", text: "still waiting" }) : null);
    const section = (title, list, what, empty) => el("section", { class: "nl-sec" },
      el("h3", {}, title + " ", el("span", { class: "nl-n", text: String(list.length) })),
      list.length ? el("ul", { class: "nl-list" }, ...list.map((e) => row(e, what))) : el("p", { class: "nm-hint", text: empty }));
    const s = st?.session || st?.last_session;
    const days = el("select", { "aria-label": "How far back", onchange: (e) => { logDays = +e.target.value; loadLog(); } },
      ...[[1, "Last 24 hours"], [3, "Last 3 days"], [7, "Last 7 days"], [30, "Last 30 days"]].map(([v, t]) => el("option", { value: String(v), text: t, selected: v === logDays })));
    logWin.body.replaceChildren(
      el("div", { class: "nl-tools" }, days,
        el("button", { class: "tbtn", type: "button", text: "Refresh", onclick: () => loadLog() }),
        el("span", { class: "nm-hint", text: s ? `${st.active ? "Tonight" : "Last night"}: ${s.approved} approved, ${s.refused + s.failed} left for you, ${s.loops} loops · also in the audit log (op night-approve)` : "Also in the audit log (op night-approve)" })),
      section("Left for you", left, (e) => (e.result === "failed" ? "failed: " : "") + (e.reason || ""), "Nothing was left for you."),
      section("Loops flagged", loops, (e) => e.reason || "", "No pane looped."),
      section("Approved", approved, (e) => "→ " + (e.option || "") + (e.reason ? " · " + e.reason : ""), "Nothing was approved."));
    fit(logWin);
  }

  window.HDNight = { open: openSettings, log: openLog, state: () => st, reload: load };
})();
