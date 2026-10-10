// E2E for picking up a new frontend after `make install`: the state payload
// carries a build id, and an open page that sees it change says so and
// reloads once nobody is typing. A restart with a new build is simulated by
// restarting the server on the same port with HERDR_DASH_BUILD_ID set.
// Artifacts land in e2e/artifacts/update-*.
//
// Ways this could fail, written before the feature existed:
//  U1. The state/SSE payload has no build id, or it differs between two runs
//      of the same binary (every restart would reload every tab).
//  U2. A page connected across a restart onto a new build keeps running the
//      old code silently: no notice, no reload.
//  U3. It reloads while someone is typing (a chat box, the search field) and
//      their text is lost.
//  U4. It reloads after a restart of the same build.
//  U5. It reloads in a loop, or the reloaded page shows the notice again.
//  U6. Clicking the notice does not reload.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, waitFor } from "./helpers.mjs";

mkdirSync(artifacts, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-update-"));
const stubLog = join(tmp, "calls.log");
writeFileSync(stubLog, "");

let port, url, srv, browser;
const ready = async () => waitFor(async () => (await (await fetch(url + "/api/state")).json()).threads.length > 0);
async function restart(build) {
  if (srv) {
    const gone = new Promise((r) => srv.once("exit", r));
    srv.kill();
    await gone;
  }
  srv = startServer(port, stubLog, [], build ? { HERDR_DASH_BUILD_ID: build } : {});
  await ready();
}

before(async () => {
  port = await freePort();
  url = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  srv?.kill();
});

test("the state and the stream carry a build id that is stable per build", async () => {
  // U1
  await restart();
  const a = (await (await fetch(url + "/api/state")).json()).build;
  assert.match(a, /^[0-9a-f]{12}$/);
  const r = await fetch(url + "/api/events");
  const reader = r.body.getReader();
  let text = "";
  while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  assert.equal(JSON.parse(text.match(/^data: (.*)$/m)[1]).build, a);
  await restart();
  assert.equal((await (await fetch(url + "/api/state")).json()).build, a, "same binary, same id");
  await restart("build-a");
  assert.equal((await (await fetch(url + "/api/state")).json()).build, "build-a");
});

async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForSelector("svg g.node.thread");
  await page.waitForSelector("#live.on");
  await page.evaluate(() => { window.__old = true; });
  page.errors = errors;
  return page;
}
const reloaded = (page) => page.evaluate(() => !window.__old).catch(() => false);
const notice = (page) => page.locator("#toasts .toast.update");

test("a new build: idle pages reload, typing pages wait, same build does nothing", async () => {
  await restart("build-a");
  const idle = await open();
  const typing = await open();
  await typing.locator('#needs .chip[data-key="alpha/t-0002"]').click();
  await typing.locator("#chat-input").fill("half-written reply");
  const searching = await open();
  await searching.locator("#f-search").fill("alp");

  // U4: same build, no notice, no reload.
  await restart("build-a");
  await waitFor(async () => (await idle.locator("#live.on").count()) === 1, 10_000);
  await idle.waitForTimeout(2500);
  for (const p of [idle, typing, searching]) {
    assert.equal(await reloaded(p), false);
    assert.equal(await notice(p).count(), 0);
  }

  // U2: new build, the idle page reloads onto it.
  await restart("build-b");
  await waitFor(() => reloaded(idle), 15_000);
  await idle.waitForSelector("svg g.node.thread");
  // U5: the new page is quiet.
  await idle.evaluate(() => { window.__old = true; });
  await idle.waitForTimeout(3000);
  assert.equal(await reloaded(idle), false, "no reload loop");
  assert.equal(await notice(idle).count(), 0);

  // U3: typing pages show the notice and keep the text.
  for (const p of [typing, searching]) {
    await notice(p).waitFor({ timeout: 10_000 });
    assert.match(await notice(p).innerText(), /Updated.*reload/i);
  }
  await typing.waitForTimeout(3000);
  assert.equal(await reloaded(typing), false);
  assert.equal(await typing.inputValue("#chat-input"), "half-written reply");
  assert.equal(await reloaded(searching), false);
  await typing.screenshot({ path: join(artifacts, "update-notice.png") });

  // Cleared text: the page is idle again and reloads.
  await typing.locator("#chat-input").fill("");
  await typing.locator("#chat-input").blur();
  await waitFor(() => reloaded(typing), 10_000);

  // U6: a click on the notice reloads at once.
  await notice(searching).click();
  await waitFor(() => reloaded(searching), 5000);

  for (const p of [idle, typing, searching]) {
    assert.deepEqual(p.errors.filter((e) => !/Failed to fetch|NetworkError/.test(e)), []);
    await p.close();
  }
});
