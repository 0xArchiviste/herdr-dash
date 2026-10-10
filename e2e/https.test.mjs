// E2E for the public HTTPS address (--public-url) and the phone voice button.
// Browsers only give the microphone to a secure context, so a plain-http page
// from another machine is sent to the HTTPS address, and the voice UI links
// there. The servers listen on 0.0.0.0 and are reached through this machine's
// own non-loopback address, which makes the request come from a "remote"
// client; 127.0.0.1 stands in for the HTTPS proxy (tailscale serve).
// Artifacts land in e2e/artifacts/https-*.
//
// Ways this could fail, written before the feature existed:
//  H1. A remote plain-http page load is not redirected, or loses its path or
//      query, or uses a 301 a browser would cache past a config change.
//  H2. The redirect loops: requests through the proxy (loopback), or that a
//      proxy marks as HTTPS (X-Forwarded-Proto), or that already name the
//      public host, are redirected again.
//  H3. API, SSE, static assets or writes are redirected, so an open tab
//      breaks (fetch/EventSource do not follow to another origin).
//  H4. Without --public-url anything is redirected, or the URL is invented.
//  H5. A bad --public-url (not https, no host) starts anyway.
//  H6. The voice UI on plain http says "needs HTTPS" with no way out: no
//      "Open secure version" link, or one that drops the path/query/hash,
//      or the mic buttons are disabled so the message is never shown.
//  H7. The real browser does not end up on the HTTPS page with the hash.
//  H8. On a phone the floating mic covers a panel button (quick replies,
//      Send, close), at the top of the sheet or scrolled; or it disappears
//      instead of moving; or it ignores the safe area.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor, repo, td, stub } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-https-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");
let PUBLIC, publicPort;

// This machine's own non-loopback IPv4 address: requests to it are remote.
const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;

let pub, plain, pubPort, plainPort, browser;
const at = (host, port) => `http://${host}:${port}`;

// get sends a raw request so Host and headers are exactly what a client sent.
function get(url, headers = {}, method = "GET") {
  return new Promise((res, rej) => {
    const req = http.request(url, { method, headers }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c) => { body += c; if (/event-stream/.test(r.headers["content-type"] || "")) req.destroy(); });
      r.on("end", () => res({ status: r.statusCode, headers: r.headers, body }));
      r.on("close", () => res({ status: r.statusCode, headers: r.headers, body }));
    });
    req.on("error", rej);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

before(async () => {
  assert.ok(lan, "needs a non-loopback IPv4 address to act as a remote client");
  publicPort = await freePort();
  PUBLIC = `https://dash.example.test:${publicPort}`;
  pubPort = await freePort();
  plainPort = await freePort();
  pub = startServer(pubPort, stubLog, ["--addr", `0.0.0.0:${pubPort}`], { HERDR_DASH_PUBLIC_URL: PUBLIC });
  plain = startServer(plainPort, stubLog, ["--addr", `0.0.0.0:${plainPort}`]);
  for (const p of [pubPort, plainPort]) await waitFor(async () => (await (await fetch(at("127.0.0.1", p) + "/api/state")).json()).threads.length > 0);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  pub?.kill();
  plain?.kill();
});

test("remote plain-http page loads redirect to the public HTTPS URL", async () => {
  // H1
  let r = await get(at(lan, pubPort) + "/?project=alpha&state=needs");
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, PUBLIC + "/?project=alpha&state=needs");
  assert.match(r.headers["cache-control"] || "", /no-store/);
  r = await get(at(lan, pubPort) + "/index.html");
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, PUBLIC + "/index.html");
  r = await get(at(lan, pubPort) + "/", {}, "HEAD");
  assert.equal(r.status, 302);
});

test("no redirect loop: loopback proxy, X-Forwarded-Proto https, public host", async () => {
  // H2
  let r = await get(at("127.0.0.1", pubPort) + "/?project=alpha", { "X-Forwarded-For": "100.64.0.9", "X-Forwarded-Proto": "https" });
  assert.equal(r.status, 200, "through the proxy");
  assert.match(r.body, /<title>herdr-dash<\/title>/);
  r = await get(at("127.0.0.1", pubPort) + "/");
  assert.equal(r.status, 200, "on this machine");
  r = await get(at(lan, pubPort) + "/", { "X-Forwarded-Proto": "https" });
  assert.equal(r.status, 200, "a proxy says the client used HTTPS");
  r = await get(at(lan, pubPort) + "/", { Host: `dash.example.test:${publicPort}` });
  assert.equal(r.status, 200, "already addressed to the public host");
});

test("API, SSE, assets and writes are never redirected", async () => {
  // H3
  const base = at(lan, pubPort);
  for (const p of ["/api/state", "/api/config", "/api/thread/alpha/t-0001", "/app.js", "/voice.js", "/style.css"]) {
    const r = await get(base + p, { Accept: "text/html,*/*" });
    assert.equal(r.status, 200, p);
  }
  const sse = await get(base + "/api/events");
  assert.equal(sse.status, 200);
  assert.match(sse.headers["content-type"], /event-stream/);
  const w = await get(base + "/api/ack", { "Content-Type": "application/json" }, "POST");
  assert.notEqual(w.status, 302);
  const c = JSON.parse((await get(base + "/api/config")).body);
  assert.equal(c.public_url, PUBLIC);
});

test("without --public-url nothing is redirected", async () => {
  // H4
  const r = await get(at(lan, plainPort) + "/?project=alpha");
  assert.equal(r.status, 200);
  const c = JSON.parse((await get(at(lan, plainPort) + "/api/config")).body);
  assert.equal(c.public_url, "");
});

test("a bad --public-url refuses to start", () => {
  // H5
  for (const bad of ["http://dash.example.test", "dash.example.test", "https://", "https://dash.example.test/sub?x=1"]) {
    const r = spawnSync(join(repo, "bin/herdr-dash"), ["--public-url", bad, "--root", join(td, "root"), "--herdr", join(stub, "herdr"), "--addr", "127.0.0.1:1"], { encoding: "utf8", timeout: 5000, env: { ...process.env, HERDR_DASH_USAGE: "off" } });
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /public-url/, bad);
  }
});

// An insecure tab that was open before the redirect existed: its document is
// let through, everything else goes to the server over plain http.
async function insecureTab(port, path, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...opts });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => { window.SpeechRecognition = window.webkitSpeechRecognition = class {}; });
  // (Header, not fulfill: Chromium blocks a fulfilled page's local requests.)
  await page.route((u) => u.pathname === "/", (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-proto": "https" } }));
  await page.goto(at(lan, port) + path);
  await page.waitForSelector("svg g.node.thread");
  page.errors = errors;
  return page;
}

test("plain-http voice says why and links to the secure version", async () => {
  // H6, H3 (an open tab keeps working: graph, SSE, panel API)
  const page = await insecureTab(pubPort, "/?x=1#thread=alpha/t-0002");
  assert.equal(await page.evaluate(() => window.isSecureContext), false);
  await waitFor(async () => (await page.locator("#live.on").count()) === 1, 5000);
  const fab = page.locator("#voice-fab");
  await waitFor(async () => /HTTPS/.test(await fab.getAttribute("title")), 3000);
  assert.equal(await fab.isDisabled(), false, "clickable, so the message can be shown");
  await fab.click();
  const link = page.locator("#voice-hud a.secure");
  await link.waitFor();
  assert.match(await page.locator("#voice-hud").innerText(), /needs HTTPS/i);
  assert.equal(await link.innerText(), "Open secure version");
  assert.equal(await link.getAttribute("href"), PUBLIC + "/?x=1#thread=alpha/t-0002");
  assert.equal(await page.locator("#voice-fab.listening").count(), 0);
  await page.screenshot({ path: join(artifacts, "https-insecure-notice.png") });

  // The chat-box mic shows it too.
  await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  const mic = page.locator('.mic[data-for="chat-input"]');
  await mic.waitFor();
  assert.equal(await mic.isDisabled(), false);
  await page.evaluate(() => { document.querySelector("#voice-hud").hidden = true; });
  await mic.click();
  await link.waitFor();
  assert.equal(await page.locator("#chat-input.dictating").count(), 0);
  assert.deepEqual(page.errors, []);
  await page.close();

  // Without a public URL: the reason, and no link.
  const p2 = await insecureTab(plainPort, "/");
  await waitFor(async () => /HTTPS/.test(await p2.locator("#voice-fab").getAttribute("title")), 3000);
  await p2.locator("#voice-fab").click();
  await waitFor(async () => /needs HTTPS/i.test(await p2.locator("#voice-hud").innerText()), 2000);
  assert.equal(await p2.locator("#voice-hud a.secure").count(), 0);
  await p2.close();
});

test("a real browser follows the redirect to the HTTPS page, hash intact", async () => {
  // H7, H2: a TLS proxy to 127.0.0.1 stands in for tailscale serve, and
  // Chromium resolves the public host to it.
  const dir = mkdtempSync(join(tmp, "tls-"));
  const key = join(dir, "key.pem"), crt = join(dir, "crt.pem");
  const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=dash.example.test",
    "-addext", "subjectAltName=DNS:dash.example.test", "-keyout", key, "-out", crt], { encoding: "utf8" });
  assert.equal(ssl.status, 0, ssl.stderr);
  const proxied = [];
  const proxy = https.createServer({ key: readFileSync(key), cert: readFileSync(crt) }, (req, res) => {
    proxied.push(req.url);
    const up = http.request({ host: "127.0.0.1", port: pubPort, path: req.url, method: req.method,
      headers: { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-for": req.socket.remoteAddress } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(publicPort, "127.0.0.1", r));
  const b = await chromium.launch({ args: ["--host-resolver-rules=MAP dash.example.test 127.0.0.1"] });
  try {
    const page = await b.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 800 } });
    await page.goto(at(lan, pubPort) + "/?x=1#thread=alpha/t-0002");
    await page.waitForSelector("svg g.node.thread");
    assert.equal(page.url(), PUBLIC + "/?x=1#thread=alpha/t-0002");
    assert.equal(await page.evaluate(() => window.isSecureContext), true);
    await waitFor(async () => (await page.locator("#live.on").count()) === 1, 5000);
    assert.equal(proxied.filter((u) => u.startsWith("/?")).length, 1, "one page load through the proxy, no loop: " + proxied.join(" "));
    await waitFor(async () => !(await page.locator("#voice-fab").isDisabled()), 3000);
    assert.doesNotMatch(await page.locator("#voice-fab").getAttribute("title"), /HTTPS/);
    await page.screenshot({ path: join(artifacts, "https-redirected.png") });
  } finally {
    await b.close();
    proxy.closeAllConnections();
    proxy.close();
  }
});

// Overlap of the voice button with every visible control in the open sheet.
async function fabClashes(page) {
  return page.evaluate(() => {
    const f = document.querySelector("#voice-fab").getBoundingClientRect();
    const hit = (r) => r.width > 0 && r.height > 0 && r.left < f.right && f.left < r.right && r.top < f.bottom && f.top < r.bottom;
    const ctl = "button, a, input, textarea, select, summary, [role=button], .chip";
    return [...document.querySelectorAll(`#panel :is(${ctl}), #panel h2.title, #panel .proj`)]
      .filter((e) => e.id !== "voice-fab" && !e.closest("#voice-fab") && hit(e.getBoundingClientRect()))
      .map((e) => e.id || e.className || e.tagName);
  });
}

test("phone: the voice button never covers a panel button", async () => {
  // H8
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.addInitScript(() => {
    class Rec extends EventTarget { start() { this._on = true; } stop() { this._on = false; setTimeout(() => this.onend?.(new Event("end")), 0); } abort() { this.stop(); } }
    window.SpeechRecognition = window.webkitSpeechRecognition = Rec;
  });
  await page.goto(at("127.0.0.1", plainPort) + "/");
  await page.waitForSelector("svg g.node.thread");
  const fab = page.locator("#voice-fab");
  // Closed panel: floating, inside the screen and the safe area.
  let b = await fab.boundingBox();
  assert.ok(b && b.width >= 40 && b.x >= 14 && b.y + b.height <= 844 - 14, JSON.stringify(b));

  for (const key of ["alpha/t-0002", "hub:alpha"]) {
    await page.locator(`#needs .chip[data-key="${key}"]`).tap();
    await page.waitForSelector(key.startsWith("hub:") ? "#p-chat .screen:not(:empty)" : '#p-chat .quick button[data-key="1"]');
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#panel #voice-fab").count(), 1, "moved into the sheet header");
    b = await fab.boundingBox();
    const sheet = await page.locator("#panel").boundingBox();
    assert.ok(b.width >= 32 && b.y >= sheet.y && b.y + b.height <= sheet.y + 60, `in the header row: ${JSON.stringify(b)}`);
    assert.deepEqual(await fabClashes(page), [], `${key} at the top`);
    await page.screenshot({ path: join(artifacts, `https-phone-${key.replace(/\W/g, "-")}-top.png`) });
    for (const sel of ["#p-chat .quick", "#p-chat textarea", "#panel-body > :last-child"]) {
      if (!(await page.locator(sel).count())) continue;
      await page.locator(sel).first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      assert.deepEqual(await fabClashes(page), [], `${key} scrolled to ${sel}`);
    }
    await page.locator("#p-chat").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, `https-phone-${key.replace(/\W/g, "-")}-chat.png`) });
    await page.locator("#panel").evaluate((p) => { p.scrollTop = 0; });
    // Still works from the header.
    await fab.tap();
    await page.waitForSelector("#voice-fab.listening");
    await fab.tap();
    await waitFor(async () => (await page.locator("#voice-fab.listening").count()) === 0, 2000);
    await page.locator("#close").tap();
    await waitFor(async () => (await page.locator("body > #voice-fab").count()) === 1, 2000);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.close();
});
