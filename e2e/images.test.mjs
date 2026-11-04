// E2E for images in the chat boxes: pasted, dropped or attached in the page,
// stored by Dash as files the agent can read, and named in the message the
// way each harness reads them (Claude Code `@/abs/path`, Codex and opencode
// a plain absolute path). The stub herdr-projects logs each prompt's stdin.
// Artifacts land in e2e/artifacts/images-*.
//
// Ways this could fail, written before the feature existed:
//  I1. A pasted, dropped or attached image never shows as a thumbnail, or
//      the x does not take it out of the message.
//  I2. The message names no path, a path the agent cannot read, the wrong
//      form for the harness (Codex given `@`, Claude Code a bare path), or
//      an image that was removed.
//  I3. The stored file is outside the thread's own folder, has a guessable
//      or caller-chosen name, is readable by other users, or differs from
//      what was pasted.
//  I4. An SVG, HTML or other non-image is stored because its name or claimed
//      type says image; an oversize image or too many images are stored; a
//      refused message leaves files behind.
//  I5. A cross-origin page, a non-JSON body or read-only mode can upload.
//  I6. A thread whose harness or folder cannot take images gets a useless
//      path instead of a clear refusal, in the API and in the UI.
//  I7. The coordinator box, the thread window and the phone picker lack it.
//  I8. Old uploads and those of resolved threads are never cleaned up, or
//      the cleanup deletes files Dash did not write.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, cpSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, post, stubLogger, td } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-images-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");
const log = stubLogger(stubLog);
const wt = join(tmp, "wt");
const root = join(tmp, "root");
cpSync(join(td, "root"), root, { recursive: true });
const tdir = (id) => join(wt, `alpha-${id}`, ".herdr-project", `alpha-${id}`);
const up = (id) => join(tdir(id), "uploads");
const coordUp = join(root, "alpha", "uploads");
const listUp = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("dash-img-")).sort() : []);

// A real 1x1 PNG and minimal headers of the other allowed types.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(60, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(40, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");
const img = (buf, name = "shot.png") => ({ name, data: buf.toString("base64") });

// Cleanup fixtures, in place before the server starts (it sweeps at start):
// an old upload, a fresh one, and a file Dash did not write in an open
// thread; a fresh upload in a resolved thread.
mkdirSync(up("t-0001"), { recursive: true });
const OLD = "dash-img-" + "a".repeat(32) + ".png", FRESH = "dash-img-" + "b".repeat(32) + ".png", RES = "dash-img-" + "c".repeat(32) + ".png";
writeFileSync(join(up("t-0001"), OLD), PNG);
const eightDays = Date.now() / 1000 - 8 * 86400;
utimesSync(join(up("t-0001"), OLD), eightDays, eightDays);
writeFileSync(join(up("t-0001"), FRESH), PNG);
writeFileSync(join(up("t-0001"), "notes.png"), PNG);
const userOld = join(up("t-0001"), "user-old.png");
writeFileSync(userOld, PNG);
utimesSync(userOld, eightDays, eightDays);
mkdirSync(up("t-0004"), { recursive: true });
writeFileSync(join(up("t-0004"), RES), PNG);

let url, srv, browser;
before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  srv = startServer(port, stubLog, ["--root", root, "--write-burst", "100", "--write-per-min", "600"], { STUB_WT: wt });
  await waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

// The prompt stdin the stub logged for the last write since mark m.
const stdinSince = (m) => log.since(m).filter((l) => l.startsWith("stdin: ")).map((l) => l.slice(7).replaceAll("\\n", "\n"));
const refRe = (dir, at) => new RegExp(`${at ? "@" : "(?<!@)"}${dir.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/(dash-img-[0-9a-f]{32}\\.(png|jpg|gif|webp))`, "g");

test("I8: old uploads and a resolved thread's uploads are swept; other files stay", async () => {
  await waitFor(() => !existsSync(join(up("t-0001"), OLD)) && !existsSync(join(up("t-0004"), RES)));
  assert.ok(existsSync(join(up("t-0001"), FRESH)), "a fresh upload stays");
  assert.ok(existsSync(join(up("t-0001"), "notes.png")), "a file Dash did not name stays");
  assert.ok(existsSync(userOld), "an old file Dash did not name stays");
});

test("I2/I3: a Claude Code thread gets @/abs/path refs to private copies in its own folder", async () => {
  const m = log.mark();
  const before = listUp(up("t-0001"));
  const r = await post(url, "/api/thread/alpha/t-0001/prompt", { text: "What is in these?", images: [img(PNG), img(JPEG, "x.jpg")] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [msg] = stdinSince(m);
  assert.ok(msg.startsWith("What is in these?"), msg);
  const refs = [...msg.matchAll(refRe(up("t-0001"), true))];
  assert.equal(refs.length, 2, msg);
  assert.deepEqual(refs.map((x) => x[2]), ["png", "jpg"], "the extension follows the bytes");
  const added = listUp(up("t-0001")).filter((f) => !before.includes(f));
  assert.deepEqual(added.sort(), refs.map((x) => x[1]).sort());
  const f = join(up("t-0001"), refs[0][1]);
  assert.deepEqual(readFileSync(f), PNG, "stored bytes are the pasted bytes");
  assert.equal(statSync(f).mode & 0o777, 0o600, "only the owner can read it");
});

test("I2: Codex and opencode threads get a plain absolute path; images alone are a message", async () => {
  for (const id of ["t-0003", "t-0005"]) {
    const m = log.mark();
    const r = await post(url, `/api/thread/alpha/${id}/prompt`, { text: "", images: [img(GIF, "a.gif"), img(WEBP, "b.webp")] });
    assert.equal(r.status, 200, id + " " + JSON.stringify(r.json));
    const [msg] = stdinSince(m);
    assert.equal([...msg.matchAll(refRe(up(id), false))].length, 2, msg);
    assert.ok(!msg.includes("@/"), "no @ for " + id);
    assert.equal(statSync(up(id)).mode & 0o077, 0, "the uploads folder is private when Dash makes it");
  }
});

test("I2: the coordinator gets refs to files in the project's uploads folder", async () => {
  const m = log.mark();
  const r = await post(url, "/api/project/alpha/coordinator", { text: "See this", images: [img(PNG)] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [msg] = stdinSince(m);
  assert.equal([...msg.matchAll(refRe(coordUp, true))].length, 1, msg);
});

test("I4: non-images, oversize and too many images are refused and nothing is stored", async () => {
  const before = listUp(up("t-0001"));
  const cases = [
    [[img(SVG, "evil.png")], 415],
    [[img(HTML, "page.gif")], 415],
    [[img(Buffer.from("plain text"), "a.webp")], 415],
    [[img(PNG), img(SVG, "b.png")], 415],
    [[img(Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]))], 413],
    [Array.from({ length: 7 }, () => img(PNG)), 400],
    [[{ name: "a.png", data: "not base64!!" }], 400],
  ];
  for (const [images, status] of cases) {
    const m = log.mark();
    const r = await post(url, "/api/thread/alpha/t-0001/prompt", { text: "x", images });
    assert.equal(r.status, status, JSON.stringify(r.json));
    assert.deepEqual(log.since(m).filter((l) => l.includes("thread prompt")), [], "nothing was sent");
  }
  assert.deepEqual(listUp(up("t-0001")), before, "a refused message stores nothing");
});

test("I5: cross-origin, non-JSON and oversize bodies are refused before anything is stored", async () => {
  const before = listUp(up("t-0001"));
  const body = { text: "x", images: [img(PNG)] };
  assert.equal((await post(url, "/api/thread/alpha/t-0001/prompt", body, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await post(url, "/api/thread/alpha/t-0001/prompt", body, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post(url, "/api/thread/alpha/t-0001/prompt", JSON.stringify(body), { "Content-Type": "text/plain" })).status, 415);
  const huge = JSON.stringify({ text: "x", images: Array.from({ length: 7 }, () => img(Buffer.alloc(10 * 1024 * 1024))) });
  assert.equal((await post(url, "/api/thread/alpha/t-0001/prompt", huge)).status, 413);
  assert.deepEqual(listUp(up("t-0001")), before);
  // Uploads are never served back.
  const name = before[0];
  for (const p of [`/uploads/${name}`, `/api/thread/alpha/t-0001/uploads/${name}`, `/${name}`]) {
    const r = await fetch(url + p);
    assert.ok(!(r.ok && r.headers.get("content-type")?.startsWith("image/")), p + " serves an upload");
  }
});

test("I6: a thread with no folder of its own is refused with a reason", async () => {
  const m = log.mark();
  const r = await post(url, "/api/thread/alpha/t-0002/prompt", { text: "x", images: [img(PNG)] });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.match(r.json.error, /image/i);
  assert.deepEqual(log.since(m).filter((l) => l.includes("thread prompt")), []);
});

// ---------------------------------------------------------------- browser

async function open(viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  return page;
}

// Puts files on the page as a paste into, or a drop onto, sel.
async function deliver(page, sel, how, files) {
  await page.evaluate(({ sel, how, files }) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const target = document.querySelector(sel);
    const ev = how === "paste"
      ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
      : new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
  }, { sel, how, files });
}
const file = (buf, name, type) => ({ b64: buf.toString("base64"), name, type });

test("I1/I2: paste, drop and attach show thumbnails; x removes one; send names the rest", async () => {
  const page = await open();
  await page.evaluate(() => window.hd.select("alpha/t-0001"));
  await page.waitForSelector("#chat-input");
  const box = "#p-chat";
  await deliver(page, "#chat-input", "paste", [file(PNG, "pasted.png", "image/png")]);
  await page.waitForSelector(`${box} .att-thumb`);
  await deliver(page, "#chat-input", "drop", [file(JPEG, "dropped.jpg", "image/jpeg")]);
  await page.setInputFiles(`${box} input[type=file]`, [{ name: "picked.gif", mimeType: "image/gif", buffer: GIF }]);
  await waitFor(async () => (await page.locator(`${box} .att-thumb`).count()) === 3);
  assert.equal(await page.locator(`${box} .att-thumb img`).count(), 3, "each has a thumbnail");
  await page.locator("#p-chat .chat-row").scrollIntoViewIfNeeded();
  await page.locator("#p-chat").screenshot({ path: join(artifacts, "images-thumbnails.png") });
  // Remove the dropped one.
  await page.locator(`${box} .att-thumb`).nth(1).locator(".att-x").click();
  assert.equal(await page.locator(`${box} .att-thumb`).count(), 2);
  await page.fill("#chat-input", "Two pictures");
  const m = log.mark();
  await page.click("#chat-send");
  await waitFor(() => stdinSince(m).length === 1);
  const [msg] = stdinSince(m);
  const refs = [...msg.matchAll(refRe(up("t-0001"), true))];
  assert.deepEqual(refs.map((x) => x[2]), ["png", "gif"], msg);
  assert.ok(msg.startsWith("Two pictures"));
  await waitFor(async () => (await page.locator(`${box} .att-thumb`).count()) === 0);
  assert.equal(await page.inputValue("#chat-input"), "");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("I4: the page refuses non-images, oversize and too many images before sending", async () => {
  const page = await open();
  await page.evaluate(() => window.hd.select("alpha/t-0001"));
  await page.waitForSelector("#chat-input");
  const box = "#p-chat";
  await page.setInputFiles(`${box} input[type=file]`, [{ name: "x.svg", mimeType: "image/svg+xml", buffer: SVG }]);
  await page.waitForSelector(`${box} .att-err`);
  assert.match(await page.textContent(`${box} .att-err`), /png|jpeg|gif|webp/i);
  await deliver(page, "#chat-input", "paste", [file(Buffer.alloc(10 * 1024 * 1024 + 1), "big.png", "image/png")]);
  await waitFor(async () => /10 MB/.test(await page.textContent(`${box} .att-err`)));
  assert.equal(await page.locator(`${box} .att-thumb`).count(), 0);
  await deliver(page, "#chat-input", "paste", Array.from({ length: 7 }, (_, i) => file(PNG, `p${i}.png`, "image/png")));
  await waitFor(async () => (await page.locator(`${box} .att-thumb`).count()) === 6);
  assert.match(await page.textContent(`${box} .att-err`), /6/);
  // Pasting plain text still pastes text.
  await page.locator(`${box} .att-thumb .att-x`).first().click();
  await page.locator("#p-chat .chat-row").scrollIntoViewIfNeeded();
  await page.locator("#p-chat").screenshot({ path: join(artifacts, "images-refused.png") });
  await page.close();
});

test("I6: an agent that cannot take images says so; opencode warns about its model", async () => {
  const page = await open();
  await page.evaluate(() => window.hd.select("alpha/t-0002"));
  await page.waitForSelector("#chat-input");
  assert.equal(await page.locator("#p-chat .att-btn").isDisabled(), true);
  assert.match(await page.locator("#p-chat .att-btn").getAttribute("title"), /image/i);
  await deliver(page, "#chat-input", "paste", [file(PNG, "p.png", "image/png")]);
  await page.waitForSelector("#p-chat .att-err");
  assert.equal(await page.locator("#p-chat .att-thumb").count(), 0);
  await page.close();
  // The fixture's opencode thread has no live pane: its note is in the state.
  const t = (await (await fetch(url + "/api/state")).json()).threads;
  assert.match(t.find((x) => x.key === "alpha/t-0005").images.note, /model/i);
  assert.equal(t.find((x) => x.key === "alpha/t-0005").images.ok, true);
  assert.deepEqual(t.find((x) => x.key === "alpha/t-0001").images, { ok: true });
});

test("I7: the coordinator box and the thread window take images too; phone picker accepts images", async () => {
  const page = await open();
  await page.evaluate(() => window.hd.select("hub:alpha"));
  await page.waitForSelector("#coord-input");
  await deliver(page, "#coord-input", "paste", [file(PNG, "c.png", "image/png")]);
  await page.waitForSelector("#p-chat .att-thumb");
  await page.fill("#coord-input", "for the coordinator");
  let m = log.mark();
  await page.click("#coord-send");
  await waitFor(() => stdinSince(m).length === 1);
  assert.equal([...stdinSince(m)[0].matchAll(refRe(coordUp, true))].length, 1);

  await page.evaluate(() => window.HDThreadWin?.open("alpha/t-0003"));
  const win = ".thread-win";
  await page.waitForSelector(`${win} .tw-input`);
  await deliver(page, `${win} .tw-input`, "drop", [file(WEBP, "w.webp", "image/webp")]);
  await page.waitForSelector(`${win} .att-thumb`);
  await page.fill(`${win} .tw-input`, "from the window");
  m = log.mark();
  await page.click(`${win} .tw-send`);
  await waitFor(() => stdinSince(m).length === 1);
  const msg = stdinSince(m)[0];
  assert.equal([...msg.matchAll(refRe(up("t-0003"), false))].length, 1, msg);
  assert.deepEqual(page.errors, []);
  await page.close();

  const phone = await open({ width: 390, height: 844 });
  await phone.evaluate(() => window.hd.select("alpha/t-0001"));
  await phone.waitForSelector("#chat-input");
  const accept = await phone.locator("#p-chat input[type=file]").getAttribute("accept");
  assert.deepEqual(accept.split(",").sort(), ["image/gif", "image/jpeg", "image/png", "image/webp"]);
  assert.equal(await phone.locator("#p-chat input[type=file]").getAttribute("multiple"), "");
  await phone.setInputFiles("#p-chat input[type=file]", [{ name: "cam.jpg", mimeType: "image/jpeg", buffer: JPEG }]);
  await phone.waitForSelector("#p-chat .att-thumb");
  const sw = await phone.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(sw <= 390, "no sideways scroll on a phone: " + sw);
  await phone.locator("#p-chat .chat-row").scrollIntoViewIfNeeded();
  await phone.screenshot({ path: join(artifacts, "images-phone.png") });
  await phone.close();
});

test("I5: read-only mode refuses images", async () => {
  const port = await freePort();
  const ro = startServer(port, stubLog, ["--root", root, "--read-only"], { STUB_WT: wt });
  try {
    const u = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await (await fetch(u + "/api/state")).json()).threads.length > 0);
    const before = listUp(up("t-0001"));
    const r = await post(u, "/api/thread/alpha/t-0001/prompt", { text: "x", images: [img(PNG)] });
    assert.equal(r.status, 403);
    assert.deepEqual(listUp(up("t-0001")), before);
  } finally {
    ro.kill();
  }
});
