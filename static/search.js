// herdr-dash search box: Title mode filters the graph by thread titles as you
// type (client-side). Content mode asks the server what was said or done in
// threads (herdr files, and agent transcripts through memex when installed):
// only on Enter or after a 400 ms pause with 3+ characters, one request at a
// time. Alt+C toggles the mode; "/" focuses the box.
(() => {
  "use strict";
  const DEBOUNCE = 400, MIN = 3;
  const SOURCES = { task: "task", report: "report", next: "next", project: "project", tasks: "tasks", memory: "memory", transcript: "transcript", "agent-memory": "agent memory" };
  const TIME_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const dash = (window.dash ||= {});
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

  const input = $("#f-search"), btn = $("#search-mode"), box = $("#search-results");
  let timer = null, ctrl = null, shown = "";

  function setMode(content, boot) {
    dash.contentMode = content;
    localStorage.setItem("hd-search-mode", content ? "content" : "title");
    btn.setAttribute("aria-pressed", String(content));
    btn.textContent = content ? "Content" : "Title";
    btn.title = (content ? "Searching what was said and done in threads" : "Searching thread titles") + " (Alt+C toggles)";
    input.placeholder = content ? "Search content… (Enter)" : "Search threads…";
    clear();
    if (content) schedule();
    if (!boot) dash.render?.();
  }

  function clear() {
    clearTimeout(timer);
    ctrl?.abort();
    ctrl = null;
    shown = "";
    box.replaceChildren();
    box.hidden = true;
    if (dash.hits?.size) { dash.hits = new Set(); dash.render?.(); }
  }

  function schedule() {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < MIN) { clear(); return; }
    if (q === shown) return;
    timer = setTimeout(() => run(q), DEBOUNCE);
  }

  async function run(q) {
    clearTimeout(timer);
    if (q.length < MIN) { clear(); return; }
    ctrl?.abort(); // one request at a time: the server cancels its memex too
    const mine = (ctrl = new AbortController());
    shown = q;
    box.hidden = false;
    box.replaceChildren(el("div", { class: "s-status", text: "Searching…" }));
    let d;
    try {
      const r = await fetch("/api/search?q=" + encodeURIComponent(q), { signal: mine.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      d = await r.json();
    } catch (e) {
      if (mine.signal.aborted) return;
      box.replaceChildren(el("div", { class: "s-status err", text: "Search failed: " + e.message }));
      return;
    }
    if (ctrl !== mine) return;
    ctrl = null;
    show(d);
  }

  function memexNote(m) {
    switch (m.status) {
      case "ok": return "";
      case "disabled": return "transcripts: off";
      case "timeout": return "transcripts: timed out";
      case "rate_limited": return "transcripts: rate limited, try again shortly";
      case "cancelled": return "";
      default: return "transcripts: error";
    }
  }

  function show(d) {
    const words = d.query.split(" ").filter(Boolean);
    const groups = new Map();
    for (const h of d.hits) {
      if (!groups.has(h.key)) groups.set(h.key, []);
      groups.get(h.key).push(h);
    }
    dash.hits = new Set(groups.keys());
    dash.render?.();
    const threads = new Map((dash.state?.().threads || []).map((t) => [t.key, t]));
    const names = Object.fromEntries((dash.state?.().projects || []).map((p) => [p.slug, p.name]));
    const note = memexNote(d.memex);
    const rows = [...groups].map(([key, hs]) => {
      const h0 = hs[0];
      const t = threads.get(key);
      const hub = key.startsWith("hub:");
      return el("button", { class: "hit", "data-key": key, title: "Open " + (hub ? "the coordinator panel" : key), onclick: () => { box.hidden = true; dash.open?.(key); } },
        el("div", { class: "s-head" },
          el("span", { class: "dot", style: `background:${hub ? "#ff8700" : dash.STATES?.[t?.state]?.color || "#baa67f"}` }),
          el("span", { class: "s-proj", text: names[h0.project] || h0.project }),
          el("span", { class: "s-title", text: hub ? (h0.project_only && hs.every((x) => x.project_only) ? "Project (repo sessions)" : "Coordinator") : `${h0.thread} · ${h0.title}` })),
        ...hs.map((h) => el("div", { class: "s-row" },
          el("span", { class: "s-src " + h.source, text: SOURCES[h.source] || h.source }),
          el("time", { datetime: h.time, text: h.time ? TIME_FMT.format(new Date(h.time)) : "" }),
          el("span", { class: "s-snip" }, ...marked(h.snippet, words)))));
    });
    box.replaceChildren(
      el("div", { class: "s-status" + (note ? " warn" : ""), text: `${groups.size} match${groups.size === 1 ? "" : "es"}${note ? " · " + note : ""}` }),
      ...rows);
    box.hidden = false;
  }

  // Text nodes with <mark>s around the query words: never HTML.
  function marked(text, words) {
    if (!words.length) return [text];
    const re = new RegExp("(" + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
    return text.split(re).map((part, i) => (i % 2 ? el("mark", { text: part }) : document.createTextNode(part)));
  }

  input.addEventListener("input", () => { if (dash.contentMode) schedule(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && dash.contentMode) { e.preventDefault(); shown = ""; run(input.value.trim()); }
    else if (e.key === "Escape") box.hidden = true;
  });
  input.addEventListener("focus", () => { if (dash.contentMode && box.childElementCount) box.hidden = false; });
  btn.addEventListener("click", () => setMode(!dash.contentMode));
  document.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyC") { e.preventDefault(); setMode(!dash.contentMode); return; }
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) { e.preventDefault(); input.focus(); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#search-box")) box.hidden = true; });

  // For voice navigation (also hd.search): dash.search("text", { mode: "content" | "title" }).
  dash.search = (text, { mode } = {}) => {
    if (mode === "content" || mode === "title") {
      if ((mode === "content") !== dash.contentMode) setMode(mode === "content");
    }
    input.value = String(text ?? "");
    input.dispatchEvent(new Event("input")); // title mode filters through app.js
    if (dash.contentMode) { shown = ""; run(input.value.trim()); }
  };

  if (window.hd) window.hd.search = dash.search; // voice navigation's hook
  setMode(localStorage.getItem("hd-search-mode") === "content", true);
})();
