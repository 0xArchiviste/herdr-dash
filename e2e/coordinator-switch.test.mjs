// A coordinator switch can precede the next herdr-projects ticker and Dash
// thread poll. The new recorded pane must become available on the pane poll,
// and an open panel must clear its earlier "No live pane" notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, freePort, startServer, td, stub, waitFor } from "./helpers.mjs";

test("a switched coordinator appears before the slow thread poll and clears the panel notice", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "herdr-dash-switch-"));
  mkdirSync(artifacts, { recursive: true });
  const root = join(tmp, "root"), panesFile = join(tmp, "panes.json"), log = join(tmp, "calls.log");
  cpSync(join(td, "root"), root, { recursive: true });
  const initial = JSON.parse(readFileSync(join(stub, "panes.json"), "utf8"));
  const panes = initial.result.panes;
  writeFileSync(panesFile, JSON.stringify(initial));
  writeFileSync(log, "");
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const server = startServer(port, log, ["--root", root, "--threads-every", "30s"], { STUB_PANES: panesFile });
  let browser, page;
  const coordinator = async () => (await (await fetch(base + "/api/state")).json()).projects.find((p) => p.slug === "alpha").coordinator;
  try {
    await waitFor(async () => (await coordinator()).pane_id === "w1Z:p1");
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(base);
    await page.waitForSelector("svg g.node.hub");
    await page.evaluate(() => window.hd.select("hub:alpha"));
    await page.waitForSelector("#p-chat");

    // The old coordinator exits before the new one starts. The panel sees
    // the real, short gap and must later recover without being reopened.
    writeFileSync(panesFile, JSON.stringify({ ...initial, result: { panes: panes.filter((p) => p.pane_id !== "w1Z:p1") } }));
    await waitFor(async () => (await coordinator()).state === "none");
    await page.waitForSelector("#coord-note .no-pane");

    const recFile = join(root, "alpha/.state/coordinator.json");
    const rec = JSON.parse(readFileSync(recFile, "utf8"));
    Object.assign(rec, { pane_id: "w1Q:p1", tab_id: "w1Q:t1", workspace_id: "w1Q", agent_session: "new-session" });
    writeFileSync(recFile, JSON.stringify(rec));
    const next = { ...panes.find((p) => p.pane_id === "w1Z:p1"), pane_id: "w1Q:p1", tab_id: "w1Q:t1", workspace_id: "w1Q", agent_status: "working", agent_session: { agent: "claude", value: "new-session" }, tokens: {} };
    writeFileSync(panesFile, JSON.stringify({ ...initial, result: { panes: [...panes.filter((p) => p.pane_id !== "w1Z:p1"), next] } }));

    await waitFor(async () => (await coordinator()).pane_id === "w1Q:p1", 5_000);
    await page.waitForFunction(() => document.querySelector("#p-head")?.textContent.includes("Working") && !document.querySelector("#coord-note .no-pane"), null, { timeout: 5_000 });
    await page.screenshot({ path: join(artifacts, "coordinator-after-switch.png") });
    writeFileSync(join(artifacts, "coordinator-after-switch.json"), JSON.stringify(await coordinator(), null, 2));
    assert.equal((await coordinator()).state, "working");
  } finally {
    await page?.close();
    await browser?.close();
    server.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});
