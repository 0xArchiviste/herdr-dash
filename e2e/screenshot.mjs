// Screenshot a running herdr-dash (real data check):
//   node e2e/screenshot.mjs http://127.0.0.1:8791 out/
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url = "http://127.0.0.1:8791", out = "e2e/artifacts/real"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const shots = [
  ["desktop", { viewport: { width: 1440, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
];
for (const [name, opts] of shots) {
  const page = await browser.newPage(opts);
  await page.goto(url);
  await page.waitForSelector("svg g.node.thread");
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(out, `${name}.png`) });
  const chip = page.locator("#needs .chip").first();
  if (await chip.count()) {
    await chip.click();
    await page.waitForSelector("#panel.open");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, `${name}-panel.png`) });
  }
  await page.close();
}
await browser.close();
console.log("screenshots in", out);
