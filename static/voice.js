// herdr-dash voice: dictation into the chat boxes and voice navigation.
//
// Speech comes from the browser's Web Speech API where it exists (Chrome,
// Edge, Safari; Chrome sends the audio to Google), else from the server
// (POST /api/voice/transcribe -> Cloudflare Workers AI Whisper) when it is
// configured. Spoken commands are resolved here by a small grammar with fuzzy
// matching against the live state; only what that cannot place goes to the
// server's intent model (POST /api/voice/intent). Dictation never sends, and
// ack/resolve/send always ask first.
(() => {
  "use strict";
  const hd = window.hd;
  if (!hd) return;
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
  const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>';
  const micIcon = () => { const s = el("span", { class: "ico" }); s.innerHTML = MIC_SVG; return s; }; // constant markup
  const BOXES = ["chat-input", "coord-input"]; // the chat boxes dictation writes into
  const SEND = { "chat-input": "chat-send", "coord-input": "coord-send" };

  // ---------------------------------------------------------------- settings
  const DEFAULTS = { nav: "Alt+KeyV", dict: "Alt+KeyM", dictMode: "toggle", engine: "auto", ai: true, lang: "" };
  const cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("hd-voice") || "{}") };
  const saveCfg = () => localStorage.setItem("hd-voice", JSON.stringify(cfg));
  let server = { intent: false, transcribe: false };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let browserFailed = false; // the browser's speech service was unreachable this session

  function engine() {
    if (!window.isSecureContext || !(navigator.mediaDevices || SR)) return null;
    const b = SR && !browserFailed, s = server.transcribe && window.MediaRecorder && navigator.mediaDevices;
    if (cfg.engine === "browser") return b ? "browser" : null;
    if (cfg.engine === "server") return s ? "server" : null;
    return b ? "browser" : s ? "server" : null;
  }
  function unavailable() {
    if (!window.isSecureContext) return "Voice not available: the microphone needs HTTPS (see the README: tailscale serve).";
    return "Voice not available: this browser has no speech recognition and server transcription is not configured.";
  }

  const fmtKey = (k) => (k || "").replace(/Key([A-Z])/, "$1").replace(/Digit(\d)/, "$1").replace("Slash", "/");
  const comboOf = (e) => [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", e.code].filter(Boolean).join("+");
  const typing = (t) => t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

  // ---------------------------------------------------------------- speech
  // listen() starts one recognition session. continuous sessions restart
  // when the engine ends them (Chrome stops after silence) until stop().
  // stop() finishes: the browser delivers what it heard; the server engine
  // transcribes the clip so far.
  function listen({ continuous, onInterim, onFinal, onStatus, onEnd }) {
    const kind = engine();
    if (!kind) { hd.toast(unavailable(), "err"); return null; }
    return kind === "browser" ? browserListen() : serverListen();

    function browserListen() {
      let want = true, rec = null, restarts = [];
      const start = () => {
        rec = new SR();
        rec.continuous = continuous;
        rec.interimResults = true;
        rec.lang = cfg.lang || navigator.language || "en-US";
        const done = new Set(); // Android repeats final results
        rec.onresult = (e) => {
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i], text = r[0].transcript;
            if (r.isFinal) { if (!done.has(i)) { done.add(i); onInterim(""); onFinal(text.trim()); } }
            else interim += text;
          }
          if (interim) onInterim(interim.trim());
        };
        rec.onerror = (e) => {
          if (e.error === "no-speech" || e.error === "aborted") return;
          want = false;
          if (e.error === "network" && server.transcribe) {
            browserFailed = true;
            hd.toast("The browser's speech service is unreachable: using server transcription from now on.", "err");
          } else hd.toast(e.error === "not-allowed" ? "Microphone access was denied." : "Speech recognition error: " + e.error, "err");
        };
        rec.onend = () => {
          restarts = restarts.filter((t) => Date.now() - t < 10000);
          if (want && continuous && restarts.length < 6) { restarts.push(Date.now()); try { start(); return; } catch {} }
          onInterim("");
          onEnd();
        };
        rec.start();
        onStatus("Listening…");
      };
      start();
      return { stop() { want = false; try { rec.stop(); } catch { onEnd(); } } };
    }

    function serverListen() {
      let want = true, stream = null, rec = null, ac = null, chunks = [], heard = false, userStop = false, t0 = 0, timer = null;
      const MAX = 15000, SILENCE = 1200;
      const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
      const finish = () => { clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); ac?.close(); onInterim(""); onEnd(); };
      navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
        stream = s;
        if (!want) return finish();
        // A cheap voice-activity check: stop a clip after a pause in speech.
        ac = new AudioContext();
        const an = ac.createAnalyser();
        an.fftSize = 1024;
        ac.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        let quietSince = 0;
        const clip = () => {
          chunks = []; heard = false; t0 = Date.now(); quietSince = 0;
          rec = new MediaRecorder(s, mime ? { mimeType: mime } : {});
          rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          rec.onstop = async () => {
            const long = Date.now() - t0 > 500;
            if ((heard || (userStop && long)) && chunks.length) {
              onStatus("Transcribing…");
              const text = await transcribe(new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }));
              if (text) onFinal(text);
            }
            if (want && continuous) { clip(); onStatus("Listening… (server)"); } else finish();
          };
          rec.start();
        };
        clip();
        onStatus("Listening… (server)");
        onInterim("");
        timer = setInterval(() => {
          if (rec?.state !== "recording") return;
          an.getFloatTimeDomainData(buf);
          const rms = Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length);
          if (rms > 0.02) { heard = true; quietSince = 0; } else if (!quietSince) quietSince = Date.now();
          if (Date.now() - t0 > MAX || (heard && quietSince && Date.now() - quietSince > SILENCE)) rec.stop();
        }, 100);
      }, (err) => { hd.toast("Microphone: " + err.message, "err"); want = false; finish(); });
      return { stop() { want = false; userStop = true; if (rec?.state === "recording") rec.stop(); else if (!rec) { /* getUserMedia pending: finish() runs there */ } } };
    }
  }

  async function transcribe(blob) {
    const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.readAsDataURL(blob); });
    const r = await postJSON("/api/voice/transcribe", { audio: b64, mime: (blob.type || "audio/webm").toLowerCase() });
    if (!r.ok) { hd.toast("Transcription failed: " + (r.data.error || "HTTP " + r.status), "err"); return ""; }
    return (r.data.text || "").trim();
  }

  async function postJSON(path, body) {
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let data = {};
      try { data = await r.json(); } catch {}
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e.message } };
    }
  }

  // ---------------------------------------------------------------- dictation
  let dict = null; // { id, session, hold }

  function attachMics() {
    for (const id of BOXES) {
      const box = document.getElementById(id);
      if (!box || box.dataset.voice) continue;
      box.dataset.voice = "1";
      const mic = el("button", { class: "tbtn mic w", type: "button", "data-for": id, "aria-pressed": "false", "aria-label": "Dictate" }, micIcon());
      mic.addEventListener("click", () => (dict && dict.id === id ? stopDictation() : startDictation(id)));
      box.after(mic);
      box.closest(".chat-row")?.after(el("div", { class: "voice-interim", "data-for": id, "aria-live": "polite" }));
    }
    refreshAvailability();
    if (dict && !document.getElementById(dict.id)) stopDictation();
  }

  function startDictation(id, hold = false) {
    const box = document.getElementById(id);
    if (!box) return;
    if (dict) stopDictation();
    pauseNav();
    const mic = $(`.mic[data-for="${id}"]`), interim = $(`.voice-interim[data-for="${id}"]`);
    const d = { id, hold };
    const session = listen({
      continuous: true,
      onInterim: (t) => { if (interim) interim.textContent = t; },
      onFinal: (t) => {
        if (!t) return;
        box.value = box.value && !/\s$/.test(box.value) ? box.value + " " + t : box.value + t;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      },
      onStatus: (s) => { if (interim) interim.dataset.status = s; },
      onEnd: () => {
        if (dict === d) dict = null;
        mic?.classList.remove("recording");
        mic?.setAttribute("aria-pressed", "false");
        box.classList.remove("dictating");
        if (interim) { interim.textContent = ""; interim.classList.remove("on"); }
        if (!dict) resumeNav();
      },
    });
    if (!session) { resumeNav(); return; }
    d.session = session;
    dict = d;
    mic?.classList.add("recording");
    mic?.setAttribute("aria-pressed", "true");
    box.classList.add("dictating");
    interim?.classList.add("on");
    box.focus();
  }

  function stopDictation() {
    if (!dict) return;
    const d = dict;
    d.session.stop();
    // Reflect it now: the engine's end event can lag behind.
    const mic = $(`.mic[data-for="${d.id}"]`), interim = $(`.voice-interim[data-for="${d.id}"]`);
    mic?.classList.remove("recording");
    mic?.setAttribute("aria-pressed", "false");
    document.getElementById(d.id)?.classList.remove("dictating");
    if (interim) { interim.textContent = ""; interim.classList.remove("on"); }
  }

  function dictTarget() {
    const a = document.activeElement;
    if (a && BOXES.includes(a.id)) return a.id;
    return BOXES.find((id) => document.getElementById(id));
  }

  // ---------------------------------------------------------------- voice nav
  let navOn = false, navSession = null, navPaused = false;
  const fab = el("button", { id: "voice-fab", type: "button", "aria-pressed": "false", "aria-label": "Voice navigation", title: "Voice navigation" }, micIcon());
  const hud = el("div", { id: "voice-hud", hidden: "", role: "status", "aria-live": "polite" },
    el("div", { class: "st" }), el("div", { class: "heard" }), el("div", { class: "result" }));
  let hudTimer = null;
  fab.addEventListener("click", () => toggleNav());

  function toggleNav() { navOn ? stopNav() : startNav(); }
  function startNav() {
    if (!engine()) { hd.toast(unavailable(), "err"); return; }
    navOn = true;
    fab.classList.add("listening");
    fab.setAttribute("aria-pressed", "true");
    showHud("Voice nav: listening…", "", "Say a command, or “help”.");
    if (!dict) runNav();
  }
  function runNav() {
    if (navSession || !navOn) return;
    const s = listen({
      continuous: true,
      onInterim: (t) => t && setHud({ heard: t + "…" }),
      onFinal: (t) => t && command(t),
      onStatus: (st) => setHud({ st: "Voice nav: " + st.toLowerCase() }),
      onEnd: () => { if (navSession === s) navSession = null; if (navOn && !navPaused) { navOn = false; navOff(); } },
    });
    navSession = s;
    if (!s) { navOn = false; navOff(); }
  }
  function stopNav() {
    navOn = false;
    navPaused = false;
    const s = navSession;
    navSession = null;
    s?.stop();
    cancelConfirm();
    navOff();
  }
  function navOff() {
    fab.classList.remove("listening");
    fab.setAttribute("aria-pressed", "false");
    setHud({ st: "Voice nav: off" });
    hideHudSoon();
  }
  // Dictation takes the microphone: nav pauses and comes back after.
  function pauseNav() {
    if (!navSession) return;
    navPaused = true;
    const s = navSession;
    navSession = null;
    s.stop();
    setHud({ st: "Voice nav: paused while dictating" });
  }
  function resumeNav() {
    if (!navPaused) return;
    navPaused = false;
    if (navOn) { setHud({ st: "Voice nav: listening…" }); runNav(); }
  }

  function showHud(st, heard, result) { clearTimeout(hudTimer); hud.hidden = false; setHud({ st, heard, result }); }
  function setHud({ st, heard, result }) {
    if (st != null) hud.querySelector(".st").textContent = st;
    if (heard != null) hud.querySelector(".heard").textContent = heard;
    if (result != null) hud.querySelector(".result").textContent = result;
  }
  function hideHudSoon() { clearTimeout(hudTimer); hudTimer = setTimeout(() => { if (!navOn && !pending) hud.hidden = true; }, 6000); }
  function say(result) { clearTimeout(hudTimer); hud.hidden = false; setHud({ result }); if (!navOn) hideHudSoon(); }

  // ---------------------------------------------------------------- confirmation
  let pending = null; // { run, timer, box }
  const YES = /^(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|affirmative|send it|yes please)$/;
  const NO = /^(no|nope|cancel|stop|never mind|nevermind|abort|dont|do not|no thanks)$/;

  function confirmAction(msg, run) {
    cancelConfirm();
    const box = el("div", { class: "confirm" },
      el("div", { class: "q", text: msg }),
      el("div", { class: "btns" },
        el("button", { id: "voice-yes", type: "button", class: "tbtn primary", text: "Yes", onclick: () => answer(true) }),
        el("button", { id: "voice-no", type: "button", class: "tbtn", text: "No", onclick: () => answer(false) }),
        el("span", { class: "muted", text: navOn ? "or say yes / no" : "" })));
    pending = { run, box, timer: setTimeout(() => { cancelConfirm(); say("No answer: cancelled."); }, 20000) };
    clearTimeout(hudTimer);
    hud.hidden = false;
    setHud({ result: "" });
    hud.append(box);
  }
  function answer(yes) {
    const p = pending;
    if (!p) return;
    cancelConfirm();
    if (yes) p.run();
    else say("Cancelled.");
  }
  function cancelConfirm() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.box.remove();
    pending = null;
  }

  // ---------------------------------------------------------------- grammar
  const NUM = { zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  function parseNum(s) {
    s = s.replace(/^(number|no|#)\s*/, "").replace(/^t\s*(?=\d)/, "").trim();
    if (/^\d+$/.test(s)) return +s;
    const w = s.split(" ");
    if (w.length === 1 && w[0] in NUM) return NUM[w[0]];
    if (w[0] in TENS && (w.length === 1 || (w.length === 2 && NUM[w[1]] > 0 && NUM[w[1]] < 10))) return TENS[w[0]] + (w[1] ? NUM[w[1]] : 0);
    return null;
  }
  const norm = (s) => s.toLowerCase().replace(/[’']/g, "").replace(/[-_/.,!?;:"()]+/g, " ").replace(/\s+/g, " ").trim();
  const STATE_WORDS = { blocked: "blocked", waiting: "waiting", "waiting on you": "waiting", review: "review", "ready for review": "review", reviews: "review",
    landing: "landing", working: "working", idle: "idle", resolved: "resolved", "needs you": "needs", needs: "needs", "needs attention": "needs" };

  function bigrams(s) { const g = []; s = s.replace(/ /g, ""); for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); return g; }
  function dice(a, b) {
    const x = bigrams(a), y = bigrams(b);
    if (!x.length || !y.length) return a === b ? 1 : 0;
    const m = new Map();
    x.forEach((g) => m.set(g, (m.get(g) || 0) + 1));
    let hit = 0;
    y.forEach((g) => { if (m.get(g) > 0) { hit++; m.set(g, m.get(g) - 1); } });
    return (2 * hit) / (x.length + y.length);
  }
  function sim(q, n) {
    if (!q || !n) return 0;
    if (q === n) return 1;
    const qt = q.split(" "), nt = n.split(" ");
    const hit = qt.filter((w) => nt.some((v) => v === w || (w.length > 3 && dice(w, v) >= 0.8))).length;
    return Math.max(dice(q, n), 0.7 * (hit / qt.length) + 0.3 * Math.min(1, hit / nt.length));
  }

  // targets: everything "open X" can name, scored against the live state.
  function targets() {
    const st = hd.state();
    const out = st.projects.map((p) => ({ key: "hub:" + p.slug, label: "project " + p.name, names: [norm(p.name), norm(p.slug)], bonus: 0.04 }));
    for (const t of st.threads) out.push({ key: t.key, label: `thread ${t.key} “${t.title}”`, names: [norm(t.title)], bonus: t.state === "resolved" ? -0.1 : 0 });
    return out;
  }
  function bestTarget(q) {
    const qs = [...new Set([q, q.replace(/^(the|project|thread) /, "").replace(/ (project|thread)$/, ""), q.replace(/^the /, "")])];
    const scored = targets().map((t) => ({ t, s: Math.max(...qs.flatMap((x) => t.names.map((n) => sim(x, n)))) + t.bonus }))
      .sort((a, b) => b.s - a.s);
    const [a, b] = scored;
    if (!a || a.s < 0.75) return { none: true, near: a };
    if (b && b.s > a.s - 0.08) return { ambiguous: [a.t, b.t] };
    return { target: a.t };
  }
  function projectFor(q) {
    const st = hd.state();
    const scored = st.projects.map((p) => ({ p, s: Math.max(sim(q, norm(p.name)), sim(q, norm(p.slug)), sim(q.replace(/^the /, "").replace(/ project$/, ""), norm(p.name))) })).sort((a, b) => b.s - a.s);
    return scored[0] && scored[0].s >= 0.6 && (!scored[1] || scored[1].s < scored[0].s - 0.05) ? scored[0].p : null;
  }
  function threadByNumber(n, proj) {
    const id = "t-" + String(n).padStart(4, "0");
    let ts = hd.state().threads.filter((t) => t.id === id && (!proj || t.project === proj.slug));
    if (ts.length > 1) {
      const cur = (hd.selected() || "").replace(/^hub:/, "").split("/")[0];
      const here = ts.filter((t) => t.project === cur);
      if (here.length === 1) ts = here;
      else if (ts.filter((t) => t.state !== "resolved").length === 1) ts = ts.filter((t) => t.state !== "resolved");
    }
    return ts;
  }

  // resolve: utterance -> { id, ... } command, { unknown } or { ask } (ambiguous).
  function resolve(raw) {
    let q = norm(raw).replace(/^((ok|okay|hey|please|can you|could you|now|and|then) )+/, "").replace(/ please$/, "");
    if (!q) return { unknown: true };
    let m;
    if (/^(stop|stop listening|stop voice( nav)?|voice off|quit|be quiet|go to sleep)$/.test(q)) return { id: "stop" };
    if (/^(help|show help|what can i say|commands|show commands|keyboard shortcuts)$/.test(q)) return { id: "help" };
    if (/^(close|close (the |this )?(panel|it|this|thread|project|window)|hide (the )?panel|escape|dismiss)$/.test(q)) return { id: "close" };
    if (/^(next|next one|next item|go next|next thread|next needs you( item)?|next needing you)$/.test(q)) return { id: "next" };
    if (/^(previous|prev|previous one|previous item|back|go back|last one|previous thread|previous needs you( item)?)$/.test(q)) return { id: "prev" };
    if (/^((focus|go to|open|jump to|select) )?(the )?chat( box| input)?$/.test(q) && q !== "chat") return { id: "focus" };
    if (/^(dictate|start dictation|dictation|take dictation|type a message)$/.test(q)) return { id: "dictate" };
    if ((m = q.match(/^(dock|move|put)( the)?( panel| it)?( to)?( the)? (bottom|left|right)$/))) return { id: "dock:" + m[6] };
    if (/^(ack|acknowledge|ac|act|axe|ask)( (this|it|that|the thread|this thread|this one|the report|report))?$/.test(q) && /^(ack|acknowledge)|this|it|that/.test(q)) return { id: "ack" };
    if (/^resolve( (this|it|that|this thread|the thread|this one))?$/.test(q)) return { id: "resolve" };
    if (/^(send|send it|send this|send that|send the message|send message|submit)$/.test(q)) return { id: "send" };
    if (/^(clear|reset|cancel|remove) (the )?search$/.test(q)) return { id: "search", q: "" };
    if ((m = q.match(/^(search|search for|find|look for|filter by) (.+)$/))) return { id: "search", q: m[2] };
    if (/^((show|filter|list)( me)? )?(all|everything|all threads|all projects)$/.test(q) || /^(clear|reset|remove) (the |all )?filters?$/.test(q)) return { id: "filter:all" };
    if ((m = q.match(/^(show|filter|only|list)( me)?( only)?( the)? (.+?)( ones| threads| items| only)?$/)) && STATE_WORDS[m[5]]) return { id: "filter:" + STATE_WORDS[m[5]] };
    if ((m = q.match(/^((show|open|go to|select|jump to) )?(the )?thread (number )?(.+?)(?: (?:in|of|from|for|on) (.+))?$/))) {
      const n = parseNum(m[5]);
      if (n != null) {
        let proj = null;
        if (m[6]) { proj = projectFor(m[6]); if (!proj) return { unknown: true }; }
        const ts = threadByNumber(n, proj);
        if (ts.length === 1) return { id: "open:" + ts[0].key };
        if (ts.length > 1) return { ask: `Thread ${n} of which project: ${ts.map((t) => t.project).join(" or ")}?` };
        return { unknown: true };
      }
    }
    if ((m = q.match(/^(open|show|go to|select|jump to|switch to|take me to)( project| thread)? (.+)$/))) {
      const tq = m[3];
      const k = tq.match(/^t ?(\d+)$/) || tq.match(/^(?:the )?(\S+) t ?(\d+)$/);
      if (k) {
        const proj = k.length === 3 ? projectFor(k[1]) : null;
        const ts = threadByNumber(+(k[2] || k[1]), proj);
        if (ts.length === 1) return { id: "open:" + ts[0].key };
      }
      const r = bestTarget(tq);
      if (r.target) return { id: "open:" + r.target.key };
      if (r.ambiguous) return { ask: `Did you mean ${r.ambiguous[0].label} or ${r.ambiguous[1].label}?` };
    }
    return { unknown: true };
  }

  // ---------------------------------------------------------------- commands
  const STATIC = [
    ["close", "Close the side panel"], ["next", "Open the next item that needs you"], ["prev", "Open the previous item that needs you"],
    ["focus", "Put the cursor in the chat box"], ["dictate", "Start dictating into the chat box"], ["help", "Show the help: keys and voice commands"],
    ["stop", "Stop listening for voice commands"], ["filter:all", "Show all threads: clear the filters"],
    ["filter:blocked", "Show only blocked threads"], ["filter:waiting", "Show only threads waiting on the user"], ["filter:review", "Show only threads ready for review"],
    ["filter:landing", "Show only landing threads (PR approved)"], ["filter:working", "Show only working threads"], ["filter:idle", "Show only idle threads"],
    ["filter:resolved", "Show only resolved threads"], ["filter:needs", "Show only threads that need the user"], ["search:clear", "Clear the search box"],
    ["dock:bottom", "Dock the panel at the bottom"], ["dock:left", "Dock the panel on the left"], ["dock:right", "Dock the panel on the right"],
    ["ack", "Acknowledge (ack) the open thread's report"], ["resolve", "Resolve the open thread"], ["send", "Send the text in the chat box"],
  ];
  function candidates() {
    const st = hd.state();
    const out = STATIC.map(([id, label]) => ({ id, label }));
    st.projects.slice(0, 16).forEach((p) => out.push({ id: "open:hub:" + p.slug, label: `Open project ${p.name} (${p.slug})` }));
    const rank = (t) => (t.needs_you ? 0 : 1);
    const ts = st.threads.filter((t) => t.state !== "resolved").sort((a, b) => rank(a) - rank(b) || Date.parse(b.last_activity || 0) - Date.parse(a.last_activity || 0));
    for (const t of ts) {
      if (out.length >= 64) break;
      const p = st.projects.find((x) => x.slug === t.project);
      out.push({ id: "open:" + t.key, label: `Open thread ${t.id} “${t.title}” in ${p ? p.name : t.project}`.slice(0, 160) });
    }
    return out;
  }
  function context() {
    const k = hd.selected();
    if (!k) return "no panel open";
    if (k.startsWith("hub:")) return "project panel open: " + k.slice(4);
    const t = hd.state().threads.find((x) => x.key === k);
    return `thread panel open: ${k}${t ? " " + t.title : ""}`.slice(0, 200);
  }

  async function command(text) {
    setHud({ heard: "“" + text + "”" });
    const q = norm(text);
    if (pending) {
      if (YES.test(q)) return answer(true);
      if (NO.test(q)) return answer(false);
      return say("Say yes or no (or click).");
    }
    const r = resolve(text);
    if (r.id) return run(r);
    if (r.ask) return say(r.ask);
    if (cfg.ai && server.intent) {
      setHud({ result: "Thinking…" });
      const a = await postJSON("/api/voice/intent", { utterance: text.slice(0, 200), context: context(), candidates: candidates() });
      if (a.ok && a.data.choice && a.data.choice !== "none" && a.data.confidence >= 0.5) {
        const id = a.data.choice === "search:clear" ? "search" : a.data.choice;
        return run(id === "search" ? { id, q: "" } : { id });
      }
      if (!a.ok && a.status !== 0) return say(`Didn't understand “${text}” (${a.data.error || "model unavailable"}).`);
    }
    say(`Didn't understand “${text}”. Say “help” for commands.`);
  }

  function setControl(sel, value, ev) {
    const e = $(sel);
    if (!e) return;
    e.value = value;
    e.dispatchEvent(new Event(ev, { bubbles: true }));
  }
  function clearFilters() {
    setControl("#f-project", "", "change");
    setControl("#f-state", "", "change");
    setControl("#f-window", "", "change");
    setControl("#f-search", "", "input");
  }
  function openKey(key) {
    const t = hd.state().threads.find((x) => x.key === key);
    if (t && !hd.visible(t)) clearFilters();
    hd.select(key);
    const p = key.startsWith("hub:") && hd.state().projects.find((x) => "hub:" + x.slug === key);
    return p ? "project " + p.name : t ? `${t.key} “${t.title}”` : key;
  }
  function chatBox() {
    const id = BOXES.find((b) => document.getElementById(b));
    return id && document.getElementById(id);
  }
  function openThread() {
    const k = hd.selected();
    if (!k || k.startsWith("hub:")) return null;
    return hd.state().threads.find((x) => x.key === k) || null;
  }

  function run(c) {
    const ro = document.body.classList.contains("ro");
    const [verb, arg] = c.id.split(/:(.*)/s);
    switch (verb) {
      case "open": return say("Opened " + openKey(arg));
      case "close": closeOverlays(); hd.select(null); return say("Closed the panel.");
      case "next": case "prev": {
        const list = hd.needs();
        if (!list.length) return say("Nothing needs you.");
        const i = list.findIndex((t) => t.key === hd.selected());
        const j = i < 0 ? (verb === "next" ? 0 : list.length - 1) : (i + (verb === "next" ? 1 : list.length - 1)) % list.length;
        return say(`${verb === "next" ? "Next" : "Previous"} (${j + 1}/${list.length}): ${openKey(list[j].key)}`);
      }
      case "filter":
        if (arg === "all") { clearFilters(); return say("Showing everything."); }
        setControl("#f-state", arg, "change");
        return say("Showing " + ($(`#f-state option[value="${arg}"]`)?.textContent || arg).toLowerCase() + ".");
      case "search":
        // hd.search (search.js) runs a content search at once, in the box's mode.
        if (window.hd?.search) window.hd.search(c.q || "");
        else setControl("#f-search", c.q || "", "input");
        return say(c.q ? `Searching “${c.q}”.` : "Search cleared.");
      case "focus": {
        const b = chatBox();
        if (!b) return say("No chat box open: open a thread or project first.");
        b.focus();
        return say("Chat box focused.");
      }
      case "dictate": {
        const id = dictTarget();
        if (!id) return say("No chat box open: open a thread or project first.");
        startDictation(id);
        return say("Dictating: toggle the mic (or " + fmtKey(cfg.dict) + ") to stop.");
      }
      case "dock": {
        if (typeof hd.dock === "function") { hd.dock(arg); return say("Docked " + arg + "."); }
        const b = document.querySelector(`[data-dock="${arg}"]`);
        if (b) { b.click(); return say("Docked " + arg + "."); }
        return say("Docking isn't available on this dashboard.");
      }
      case "help": showHelp(); return say("Help is open: Esc closes it.");
      case "stop": stopNav(); return say("Stopped listening.");
      case "ack": case "resolve": {
        if (ro) return say("This dashboard is read-only.");
        const t = openThread();
        if (!t || t.state === "resolved") return say(`Open a thread first to ${verb} it.`);
        const msg = verb === "ack" ? `Ack ${t.key} (“${t.title}”)?` : `Resolve ${t.key} (“${t.title}”)? This removes its worktree, merged branch and tab.`;
        return confirmAction(msg, () => { verb === "ack" ? hd.ack(t.key) : hd.resolve(t.key); say((verb === "ack" ? "Acked " : "Resolving ") + t.key + "."); });
      }
      case "send": {
        if (ro) return say("This dashboard is read-only.");
        const b = chatBox();
        const text = b && b.value.trim();
        if (!text) return say("Nothing to send: dictate or type into the chat box first.");
        const target = b.id === "coord-input" ? "the coordinator" : hd.selected();
        return confirmAction(`Send to ${target}: “${text.length > 140 ? text.slice(0, 139) + "…" : text}”?`, () => {
          document.getElementById(SEND[b.id])?.click();
          say("Sent.");
        });
      }
    }
    say("Didn't understand.");
  }

  // ---------------------------------------------------------------- help + settings
  const help = el("div", { id: "voice-help", hidden: "", role: "dialog", "aria-label": "Keys and voice commands" });
  const settings = el("div", { id: "voice-settings", hidden: "", role: "dialog", "aria-label": "Voice settings" });
  help.addEventListener("click", (e) => { if (e.target === help) closeOverlays(); });

  function showHelp() {
    const kb = [
      [fmtKey(cfg.nav), "Voice navigation on/off (also the floating mic)"],
      [fmtKey(cfg.dict), `Dictate into the chat box (${cfg.dictMode === "hold" ? "hold to talk" : "press to start/stop"})`],
      ["?", "This help (not while typing)"],
      ["Esc", "Close help, settings, a voice question, or the panel"],
      ["Ctrl+Enter", "Send the chat box"],
    ];
    const cmds = [
      ["open nebula api / show beta", "open a project's panel"],
      ["open widget pipeline / open t-0003", "open a thread by title or id"],
      ["show thread 27 in kaiba cord", "a thread by number and project"],
      ["show blocked / waiting / review / landing / working / needs you", "filter by state"],
      ["show all / clear filters", "clear the filters"],
      ["next / previous", "step through the Needs-you items"],
      ["search <text> / clear search", "the search box"],
      ["close panel", "close the side panel"],
      ["focus chat / dictate", "the open panel's chat box"],
      ["dock bottom / left / right", "move the panel"],
      ["ack this / resolve this / send", "ask yes/no first, by voice or click"],
      ["help / stop listening", ""],
    ];
    help.replaceChildren(el("div", { class: "card" },
      el("button", { class: "close", type: "button", "aria-label": "Close", text: "×", onclick: closeOverlays }),
      el("h2", { text: "Keys" }),
      el("table", {}, ...kb.map(([k, v]) => el("tr", {}, el("td", {}, el("kbd", { text: k })), el("td", { text: v })))),
      el("h2", { text: "Voice commands" }),
      el("table", {}, ...cmds.map(([k, v]) => el("tr", {}, el("td", { class: "say", text: "“" + k + "”" }), el("td", { text: v })))),
      el("p", { class: "muted", text: "Phrases the dashboard cannot place itself go to the server's intent model when one is configured. " + privacy() }),
      el("button", { class: "tbtn", type: "button", text: "Voice settings…", onclick: () => { closeOverlays(); showSettings(); } })));
    settings.hidden = true;
    help.hidden = false;
  }

  function privacy() {
    const e = engine();
    if (e === "browser") return "Speech: the browser's recognizer (Chrome and Edge send the audio to Google or Microsoft; Safari may process on the device).";
    if (e === "server") return "Speech: recorded here and sent through this dashboard's server to Cloudflare Workers AI (Whisper).";
    return unavailable();
  }

  function showSettings() {
    const keyField = (id, prop) => {
      const f = el("input", { id, class: "keycap", readonly: "", value: fmtKey(cfg[prop]), "aria-label": "Press a key combination" });
      f.addEventListener("focus", () => { f.value = "Press keys…"; });
      f.addEventListener("blur", () => { f.value = fmtKey(cfg[prop]); });
      f.addEventListener("keydown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return f.blur();
        if (/^(Control|Alt|Shift|Meta)/.test(e.code) || ["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
        const combo = comboOf(e);
        // A bare key would fire while typing: require a modifier, except F-keys.
        if (!(e.ctrlKey || e.altKey || e.metaKey) && !/^F\d+$/.test(e.code)) { f.value = "Needs Alt, Ctrl or ⌘"; return; }
        if (combo === cfg[prop === "nav" ? "dict" : "nav"]) { f.value = "Already used"; return; }
        cfg[prop] = combo;
        saveCfg();
        f.value = fmtKey(combo);
      });
      return f;
    };
    const mode = el("select", { id: "vs-dict-mode" }, el("option", { value: "toggle", text: "press to start / stop" }), el("option", { value: "hold", text: "hold to talk" }));
    mode.value = cfg.dictMode;
    mode.addEventListener("change", () => { cfg.dictMode = mode.value; saveCfg(); });
    const eng = el("select", { id: "vs-engine" },
      el("option", { value: "auto", text: "Automatic" }),
      el("option", { value: "browser", text: "Browser (Web Speech)" + (SR ? "" : " — not in this browser"), disabled: SR ? null : "" }),
      el("option", { value: "server", text: "Server (Cloudflare Whisper)" + (server.transcribe ? "" : " — not configured"), disabled: server.transcribe ? null : "" }));
    eng.value = cfg.engine;
    const note = el("p", { class: "muted", text: privacy() });
    eng.addEventListener("change", () => { cfg.engine = eng.value; saveCfg(); note.textContent = privacy(); refreshAvailability(); });
    const ai = el("input", { id: "vs-ai", type: "checkbox", checked: cfg.ai ? "" : null, disabled: server.intent ? null : "" });
    ai.addEventListener("change", () => { cfg.ai = ai.checked; saveCfg(); });
    const lang = el("input", { id: "vs-lang", value: cfg.lang, placeholder: navigator.language || "en-US", size: "8" });
    lang.addEventListener("change", () => { cfg.lang = lang.value.trim(); saveCfg(); });
    settings.replaceChildren(
      el("div", { class: "row head" }, el("b", { text: "Voice" }), el("button", { id: "voice-settings-close", class: "close", type: "button", "aria-label": "Close", text: "×", onclick: closeOverlays })),
      el("label", { class: "row" }, el("span", { text: "Voice navigation key" }), keyField("vs-nav-key", "nav")),
      el("label", { class: "row" }, el("span", { text: "Dictation key" }), keyField("vs-dict-key", "dict")),
      el("label", { class: "row" }, el("span", { text: "Dictation key mode" }), mode),
      el("label", { class: "row" }, el("span", { text: "Speech engine" }), eng),
      el("label", { class: "row" }, el("span", { text: "Language" }), lang),
      el("label", { class: "row" }, el("span", { text: "Ask the AI model for phrases the grammar misses" + (server.intent ? "" : " (not configured)") }), ai),
      note,
      el("div", { class: "row" }, el("button", { class: "tbtn", type: "button", text: "Reset to defaults", onclick: () => { Object.assign(cfg, DEFAULTS); saveCfg(); showSettings(); refreshAvailability(); } }),
        el("button", { class: "tbtn", type: "button", text: "Help (?)", onclick: () => { closeOverlays(); showHelp(); } })));
    help.hidden = true;
    settings.hidden = false;
  }

  function closeOverlays() {
    const was = !help.hidden || !settings.hidden;
    help.hidden = true;
    settings.hidden = true;
    return was;
  }

  // ---------------------------------------------------------------- keys
  let holdCode = null;
  window.addEventListener("keydown", (e) => {
    if (e.target?.classList?.contains("keycap")) return;
    const combo = comboOf(e);
    if (combo === cfg.nav) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) toggleNav(); return; }
    if (combo === cfg.dict) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (cfg.dictMode === "hold") {
        const id = dictTarget();
        if (!id) return hd.toast("No chat box open: open a thread or project first.");
        holdCode = e.code;
        startDictation(id, true);
      } else if (dict) stopDictation();
      else {
        const id = dictTarget();
        if (id) startDictation(id);
        else hd.toast("No chat box open: open a thread or project first.");
      }
      return;
    }
    if (e.key === "Escape") {
      if (pending) { e.stopImmediatePropagation(); answer(false); return; }
      if (closeOverlays()) { e.stopImmediatePropagation(); return; }
      return;
    }
    if (e.key === "?" && !e.ctrlKey && !e.altKey && !e.metaKey && !typing(e.target) && !$("#dlg")?.open) {
      e.preventDefault();
      help.hidden ? showHelp() : closeOverlays();
    }
  }, true);
  window.addEventListener("keyup", (e) => {
    if (!holdCode || !dict?.hold) return;
    const mods = cfg.dict.split("+").slice(0, -1);
    if (e.code === holdCode || mods.some((m) => e.key === (m === "Ctrl" ? "Control" : m))) { holdCode = null; stopDictation(); }
  }, true);
  window.addEventListener("blur", () => { if (holdCode && dict?.hold) { holdCode = null; stopDictation(); } });

  // ---------------------------------------------------------------- mount
  function refreshAvailability() {
    const ok = !!engine();
    const why = ok ? "" : unavailable();
    fab.disabled = !ok;
    fab.title = ok ? `Voice navigation (${fmtKey(cfg.nav)})` : why;
    document.querySelectorAll(".mic").forEach((m) => {
      m.disabled = !ok;
      m.title = ok ? `Dictate (${fmtKey(cfg.dict)}${cfg.dictMode === "hold" ? ", hold" : ""}): text goes into the box, never sent` : why;
    });
  }

  const top = $("#top");
  top.append(el("div", { class: "voice-tools" },
    el("button", { id: "help-btn", class: "tbtn", type: "button", title: "Keys and voice commands (?)", text: "?", onclick: () => (help.hidden ? showHelp() : closeOverlays()) }),
    el("button", { id: "voice-settings-btn", class: "tbtn", type: "button", title: "Voice settings", text: "⚙", onclick: () => (settings.hidden ? showSettings() : closeOverlays()) })));
  document.body.append(fab, hud, help, settings);
  new MutationObserver(attachMics).observe($("#panel-body"), { childList: true, subtree: true });
  attachMics();
  fetch("/api/config").then((r) => r.json()).then((c) => { server = c.voice || server; refreshAvailability(); }).catch(() => {});
})();
