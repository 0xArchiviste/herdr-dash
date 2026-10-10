// herdr-dash screen box scrollback: the live stream sends only the newest
// lines of a pane; this keeps a longer buffer by merging each new tail into
// it, and loads earlier lines on demand when the reader scrolls to the top.
window.HDScrollback = (() => {
  "use strict";
  const CAP = 2000; // lines kept, and the most one load asks for (server caps too)
  const FIRST = 200; // first load; each next one asks for twice as many
  const NEAR_TOP = 40; // px from the top that starts a load

  const split = (s) => {
    s = (s || "").replace(/\s+$/, ""); // drops blank rows at the bottom
    return s ? s.split("\n").map((l) => l.replace(/\s+$/, "")) : [];
  };
  const solid = (l) => /\S/.test(l);

  // Where b starts in a: an index from which a agrees with b's first lines
  // for long enough to trust (blank lines and borders repeat; three real
  // lines in a row rarely do). Of several, the one nearest `near`. -1: none.
  function overlap(a, b, near) {
    const need = Math.min(3, b.filter(solid).length);
    if (!need) return -1;
    let best = -1;
    for (let i = a.length - 1; i >= 0; i--) {
      let j = 0, got = 0;
      while (got < need && i + j < a.length && j < b.length && a[i + j] === b[j]) got += solid(b[j++]);
      if (got >= need && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
      if (best >= 0 && i < near && near - i > Math.abs(best - near)) break;
    }
    return best;
  }

  // box builds a screen box: { el, live(text) }. history(n) fetches the
  // pane's last n lines ({screen}); current() says the box is still shown.
  function box(history, current) {
    const top = document.createElement("div");
    top.className = "screen-top";
    const pre = document.createElement("pre");
    pre.className = "screen";
    const jump = document.createElement("button");
    jump.className = "new-output";
    jump.hidden = true;
    jump.textContent = "↓ New output";
    const wrap = document.createElement("div");
    wrap.className = "screen-wrap";
    wrap.append(top, pre, jump);

    let buf = [];
    let asked = 0; // lines the last load asked for
    let loading = false, start = false, capped = false;

    const atBottom = () => pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    const toBottom = () => { pre.scrollTop = pre.scrollHeight; };
    const lineH = () => parseFloat(getComputedStyle(pre).lineHeight) || 14;

    function note() {
      if (loading) top.replaceChildren("Loading earlier lines…");
      else if (capped) top.replaceChildren(`Showing the last ${CAP} lines`);
      else if (start) top.replaceChildren("Start of the pane's history");
      else {
        const b = document.createElement("button");
        b.textContent = "↑ Load earlier";
        b.addEventListener("click", load);
        top.replaceChildren(b);
      }
    }

    // Keep at most CAP lines; returns how many were cut from the top.
    function trim() {
      const cut = Math.max(0, buf.length - CAP);
      if (cut) { buf = buf.slice(cut); capped = true; }
      return cut;
    }

    // A new live tail: replace the buffer from where the tail starts in it.
    // No overlap (more output than the tail holds, or a full-screen redraw):
    // replace the buffer rather than glue unrelated screens together.
    function live(text) {
      const tail = split(text);
      const first = !pre.dataset.n;
      const stick = first || atBottom();
      const old = buf;
      const i = overlap(buf, tail, buf.length);
      if (i < 0) { buf = tail; start = capped = false; asked = 0; }
      else buf = buf.slice(0, i).concat(tail);
      const cut = trim();
      const changed = buf.length !== old.length || buf.some((l, k) => l !== old[k]);
      const y = pre.scrollTop;
      if (changed || first) pre.textContent = buf.join("\n"); // textContent: never HTML
      pre.dataset.n = (+pre.dataset.n || 0) + 1;
      if (stick) {
        toBottom();
        // Again after layout: the box may have just appeared (was :empty).
        requestAnimationFrame(toBottom);
      } else {
        pre.scrollTop = Math.max(0, y - cut * lineH());
        if (changed) jump.hidden = false;
      }
      note();
    }

    // Earlier lines: ask for more than the buffer holds, up to CAP, and
    // prepend what precedes the buffer without moving the reader's place.
    async function load() {
      if (loading || start || capped || !buf.length) return;
      let n = asked ? asked * 2 : FIRST;
      while (n <= buf.length) n *= 2;
      n = Math.min(CAP, n);
      asked = n;
      loading = true;
      note();
      let older = null;
      try {
        const r = await fetch(history(n));
        if (r.ok) older = split((await r.json()).screen);
      } catch {}
      loading = false;
      if (!current()) return;
      if (older?.length) {
        const i = overlap(older, buf, older.length - buf.length);
        const fromBottom = pre.scrollHeight - pre.scrollTop;
        if (i < 0) buf = older; // the pane changed past recognition
        else buf = older.slice(0, i).concat(buf);
        if (older.length < n) start = true;
        else if (n >= CAP) capped = true;
        trim();
        pre.textContent = buf.join("\n");
        pre.scrollTop = pre.scrollHeight - fromBottom;
      }
      note();
    }

    pre.addEventListener("scroll", () => {
      if (atBottom()) jump.hidden = true;
      if (pre.scrollTop < NEAR_TOP) load();
    }, { passive: true });
    // A box too short to scroll still loads on a wheel or swipe up.
    pre.addEventListener("wheel", (e) => { if (e.deltaY < 0 && pre.scrollTop === 0) load(); }, { passive: true });
    jump.addEventListener("click", () => { toBottom(); jump.hidden = true; });

    return { el: wrap, live };
  }

  return { box, CAP };
})();
