// herdr-dash images in a chat box: pasted (Ctrl/Cmd+V), dropped, or picked
// with the attach button (a phone offers its camera and photos). They show
// as thumbnails with an x until the message is sent; the server stores them
// where the agent can read them and names them in the message (images.go).
// The thumbnails are the page's own copies: uploads are never served back.
window.HDAttach = (() => {
  "use strict";
  const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const MAX = 6, MAX_BYTES = 10 * 1024 * 1024;
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
  const hasFiles = (dt) => !!dt && [...(dt.types || [])].includes("Files");

  // A file dropped outside a box must not replace the page (a browser, or
  // the desktop app's webview, would open it in place of the dashboard).
  for (const ev of ["dragover", "drop"]) {
    document.addEventListener(ev, (e) => { if (hasFiles(e.dataTransfer) && !e.defaultPrevented) e.preventDefault(); });
  }

  const b64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });

  // mount wires images into input (a textarea). support() says whether the
  // target takes images now: {ok, note}. Returns the tray (put it above the
  // input's row), the attach button (put it in the row) and the list.
  function mount(input, support = () => ({ ok: true })) {
    const items = []; // {file, url}
    const list = el("div", { class: "att-list" });
    const note = el("div", { class: "att-note muted", hidden: "" });
    const err = el("div", { class: "att-err msg err", hidden: "" });
    const picker = el("input", { type: "file", accept: TYPES.join(","), multiple: "", hidden: "", class: "att-file" });
    const tray = el("div", { class: "att w" }, list, note, err, picker);
    const button = el("button", { type: "button", class: "tbtn att-btn w", "aria-label": "Attach images", text: "📎" });

    function sync() {
      const s = support() || {};
      button.disabled = !s.ok;
      button.title = s.ok ? "Attach images (or paste / drop them in the box)" : "No images: " + (s.note || "this agent cannot take images");
      note.hidden = !(s.ok && s.note && items.length);
      note.textContent = s.note || "";
      tray.classList.toggle("on", items.length > 0 || !err.hidden);
    }
    function shout(text) {
      err.textContent = text;
      err.hidden = !text;
      sync();
    }
    function render() {
      list.replaceChildren(...items.map((it, i) => el("div", { class: "att-thumb", title: it.file.name || "image" },
        el("img", { src: it.url, alt: it.file.name || "image" }),
        el("button", { type: "button", class: "att-x", "aria-label": "Remove image", title: "Remove", text: "×",
          onclick: () => { URL.revokeObjectURL(it.url); items.splice(i, 1); shout(""); render(); } }))));
      sync();
    }
    function add(files) {
      const s = support() || {};
      if (!s.ok) { shout("No images: " + (s.note || "this agent cannot take images")); return; }
      const problems = [];
      for (const f of files) {
        if (!TYPES.includes(f.type)) { problems.push(`${f.name || "That file"}: only PNG, JPEG, GIF or WebP images`); continue; }
        if (f.size > MAX_BYTES) { problems.push(`${f.name || "That image"} is over 10 MB`); continue; }
        if (items.length >= MAX) { problems.push(`At most ${MAX} images a message`); break; }
        items.push({ file: f, url: URL.createObjectURL(f) });
      }
      shout(problems.join(" · "));
      render();
    }

    button.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => { add([...picker.files]); picker.value = ""; });
    input.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return; // plain text pastes as text
      e.preventDefault();
      add(files);
    });
    for (const target of [input, tray]) {
      target.addEventListener("dragover", (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); input.classList.add("att-over"); } });
      target.addEventListener("dragleave", () => input.classList.remove("att-over"));
      target.addEventListener("drop", (e) => {
        input.classList.remove("att-over");
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length) return;
        e.preventDefault();
        add(files);
      });
    }
    sync();
    return {
      tray, button,
      count: () => items.length,
      // images: the attached images as the server takes them.
      images: () => Promise.all(items.map(async (it) => ({ name: it.file.name || "image", data: await b64(it.file) }))),
      clear() { for (const it of items) URL.revokeObjectURL(it.url); items.length = 0; shout(""); render(); },
      error: shout,
      sync,
    };
  }

  return { mount, TYPES, MAX, MAX_BYTES };
})();
