// README screenshots from the demo (`make screenshots`), fictional data only:
//   node e2e/demo-shots.mjs http://127.0.0.1:8792 docs/screenshots
// Writes PNGs, plus hero.webm (a short screen recording) that the Makefile
// turns into an animated WebP when ffmpeg is installed.
import { chromium } from "playwright";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const [url = "http://127.0.0.1:8792", out = "docs/screenshots"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const desktop = { viewport: { width: 1440, height: 900 }, colorScheme: "dark" };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const settle = async (page) => {
  await page.waitForSelector("svg g.node.thread");
  await page.waitForTimeout(6000); // the force layout settles and fits
};
const shot = (page, name, opts = {}) => page.screenshot({ path: join(out, name + ".png"), ...opts });
const blockedChip = '#needs .group[data-state="blocked"] .chip:not(.coord)';

// Overview.
let page = await browser.newPage(desktop);
await page.goto(url);
await settle(page);
await shot(page, "overview");

// A blocked thread: its permission prompt, quick replies and chat.
await page.locator(`${blockedChip}[data-key="payments-svc/t-0001"]`).click();
await page.waitForSelector("#panel.open .quick:not([hidden])");
await page.waitForTimeout(1500);
await page.fill("#chat-input", "Yes, staging only. Run it with CONCURRENTLY.");
await page.locator("#panel").evaluate(e => { e.scrollTop = 0; });
await shot(page, "thread-blocked");

// The coordinator panel of the same project.
await page.locator("#open-coord").click();
await page.waitForSelector("#panel.open #coord-input");
await page.waitForSelector("#p-reports details");
await page.waitForTimeout(1500);
await shot(page, "coordinator");
await page.close();

// Triage: blocked and waiting folded, select mode, a few reviews picked.
// Capture the queue itself so all selected reviews are readable.
page = await browser.newPage({ ...desktop, viewport: { width: 1920, height: 900 } });
await page.goto(url);
await settle(page);
for (const g of ["blocked", "waiting"]) await page.locator(`#needs .group[data-state="${g}"] .group-head`).click();
await page.locator("#select-mode").click();
for (const k of ["nebula-api/t-0003", "docs-site/t-0001", "payments-svc/t-0003"]) await page.locator(`#needs .chip[data-key="${k}"]`).click();
await page.evaluate(() => document.querySelector('#needs .group[data-state="review"]').scrollIntoView({ inline: "start", block: "nearest" }));
await page.waitForTimeout(500);
await page.locator("#needs-wrap").screenshot({ path: join(out, "triage.png") });
await page.close();

// Phone.
page = await browser.newPage(phone);
await page.goto(url);
await settle(page);
await shot(page, "phone-overview");
await page.locator(`${blockedChip}[data-key="pixel-forge/t-0003"]`).click();
await page.waitForSelector("#panel.open .quick:not([hidden])");
await page.waitForTimeout(1500);
// Scroll the quick replies clear of the floating voice mic, crop above it.
await page.evaluate(() => { document.querySelector("#panel").scrollTop = 150; });
await page.waitForTimeout(300);
await shot(page, "phone-panel", { clip: { x: 0, y: 0, width: 390, height: 770 } });
await page.close();

// Hero recording: the graph pulsing, a hover, then a node opening its panel.
const ctx = await browser.newContext({ ...desktop, viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
page = await ctx.newPage();
await page.goto(url);
await settle(page);
const box = async (key) => (await page.locator(`svg g.node[data-key="${key}"] circle.core`).boundingBox());
for (const key of ["nebula-api/t-0001", "mobile-app/t-0001", "ml-pipeline/t-0003"]) {
  const b = await box(key);
  if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await page.waitForTimeout(900); }
}
const b = await box("payments-svc/t-0001");
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
await page.waitForTimeout(400);
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
await page.waitForSelector("#panel.open .quick:not([hidden])");
await page.waitForTimeout(2500);
const video = page.video();
await ctx.close();
rmSync(join(out, "hero.webm"), { force: true });
renameSync(await video.path(), join(out, "hero.webm"));
await browser.close();
console.log("screenshots in", out);
