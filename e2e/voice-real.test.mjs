// Explicit local-model gate. Requires HERDR_DASH_STT_DIR, HERDR_DASH_STT_PYTHON
// and HERDR_DASH_STT_FIXTURE (16 kHz mono WAV); not a fixture-only CI test.
// Failure modes: cold startup loses first words; previews insert permanently;
// endpoint/EOF duplicates; navigation steals dictation; final goes to wrong box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { freePort, startServer, waitFor, artifacts } from "./helpers.mjs";

test("real Parakeet TDT v3 microphone preview and single final insertion", { timeout: 90000 }, async () => {
  assert.ok(process.env.HERDR_DASH_STT_FIXTURE, "set HERDR_DASH_STT_FIXTURE");
  mkdirSync(artifacts, { recursive: true });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const server = startServer(port, "", [], { HERDR_DASH_STT: "local", HERDR_DASH_STT_IDLE: "1s", HERDR_DASH_STT_SERVER_CMD: "", HERDR_DASH_STT_DIR: process.env.HERDR_DASH_STT_DIR, HERDR_DASH_STT_PYTHON: process.env.HERDR_DASH_STT_PYTHON });
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${process.env.HERDR_DASH_STT_FIXTURE}%noloop`] });
  const observations = [];
  let page;
  try {
    await waitFor(async () => (await fetch(url + "/api/config")).ok);
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.addInitScript(() => localStorage.setItem("hd-voice", JSON.stringify({ engine: "local" })));
    page.on("websocket", (socket) => socket.on("framereceived", (event) => {
      try { observations.push({ time: Date.now(), ...JSON.parse(event.payload.toString()) }); } catch {}
    }));
    page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
    await page.goto(url);
    await page.locator('#needs .chip[data-key="alpha/t-0002"]').click();
    await page.waitForSelector('.mic[data-for="chat-input"]');
    await page.fill("#chat-input", "Before selected after");
    await page.locator("#chat-input").evaluate((box) => box.setSelectionRange(7, 15));
    await page.locator('.mic[data-for="chat-input"]').click();
    await waitFor(async () => observations.some((m) => m.interim && m.text), 45000);
    assert.equal(await page.inputValue("#chat-input"), "Before selected after");
    await page.screenshot({ path: join(artifacts, "voice-real-partial.png") });
    await waitFor(async () => observations.some((m) => m.final && m.text), 15000);
    await waitFor(async () => (await page.inputValue("#chat-input")) === "Before The dashboard shows three red threads and one waiting on review. after", 10000);
    await page.locator('.mic[data-for="chat-input"]').click();
    await waitFor(async () => observations.some((m) => m.eof), 10000);
    await page.waitForTimeout(500);
    assert.equal(await page.inputValue("#chat-input"), "Before The dashboard shows three red threads and one waiting on review. after");
    await page.screenshot({ path: join(artifacts, "voice-real-final.png") });
    writeFileSync(join(artifacts, "voice-real-transcripts.json"), JSON.stringify(observations, null, 2));
  } finally {
    writeFileSync(join(artifacts, "voice-real-transcripts.json"), JSON.stringify(observations, null, 2));
    if (page) await page.screenshot({ path: join(artifacts, "voice-real-last.png") });
    await browser.close(); server.kill();
  }
});
