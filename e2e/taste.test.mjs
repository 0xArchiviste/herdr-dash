// UX failure cases, recorded before implementation:
// - Triage items run off-screen; phone statuses only communicate by colour.
// - Filtering to nothing has no recovery; reset leaves stale content-search hits.
// - A panned graph cannot be fitted again without reloading.
// - Enlarged controls consume the graph or collide with the docked detail panel.
// Screenshots and measurements make the responsive review repeatable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, freePort, startServer, waitFor } from './helpers.mjs';

let server, browser, base;
before(async () => {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  mkdirSync(artifacts, { recursive: true });
  server = startServer(port, join(artifacts, 'taste-stub.log'));
  await waitFor(async () => (await fetch(base + '/api/state')).ok);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.kill(); });

test('readable triage and recoverable graph at desktop, tablet and phone widths', async () => {
  const measurements = [];
  for (const [name, width, height] of [['desktop',1440,1000], ['tablet',768,1024], ['mobile',390,844]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    await page.goto(base);
    await page.waitForSelector('#needs .chip');
    for (const head of await page.locator('.group-head').all()) {
      assert.equal(await head.locator('.lbl').isVisible(), true);
      assert.ok((await head.getAttribute('aria-label'))?.length);
    }
    const statusFilter = page.locator('#legend button').first();
    await statusFilter.focus();
    assert.equal(await statusFilter.evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
    const measure = await page.evaluate(() => {
      const needs = document.querySelector('#needs'), stage = document.querySelector('#stage');
      return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
        queueWidth: needs.clientWidth, queueContent: needs.scrollWidth,
        graphHeight: stage.clientHeight, graphWidth: stage.clientWidth };
    });
    assert.ok(measure.pageWidth <= width, JSON.stringify(measure));
    assert.ok(measure.queueContent <= measure.queueWidth + 1, JSON.stringify(measure));
    assert.ok(measure.graphHeight >= 240 && measure.graphWidth >= 280, JSON.stringify(measure));
    measurements.push({ name, ...measure });
    await page.locator('#select-mode').click();
    const lastItem = page.locator('#needs .chip:not(.coord)').last();
    await lastItem.click(); // scrolls the queue to an item below its initial fold
    assert.equal(await lastItem.getAttribute('aria-pressed'), 'true');
    await page.locator('#select-mode').click();
    await page.locator('#needs').evaluate(e => { e.scrollTop = 0; });
    await page.selectOption('#f-state', 'blocked');
    assert.equal(await page.locator('#legend button.active').getAttribute('aria-pressed'), 'true');
    await page.locator('#f-search').fill('no-such-thread');
    await page.locator('#graph-empty').waitFor({ state: 'visible' });
    await page.locator('#reset-filters').click();
    assert.equal(await page.locator('#f-state').inputValue(), '');
    assert.equal(await page.locator('#f-search').inputValue(), '');
    assert.equal(await page.locator('#graph-empty').isVisible(), false);
    await page.waitForSelector('.node.thread');
    await page.locator('#graph').hover();
    await page.mouse.wheel(0, -400);
    await page.locator('#fit-graph').click();
    await waitFor(async () => page.evaluate(() => {
      const graph = document.querySelector('#graph').getBoundingClientRect();
      return [...document.querySelectorAll('.node .core')].every(n => {
        const r = n.getBoundingClientRect();
        return r.left >= graph.left && r.right <= graph.right && r.top >= graph.top && r.bottom <= graph.bottom;
      });
    }));
    await page.waitForTimeout(1200); // let the force layout settle before the review artifact
    await page.screenshot({ path: join(artifacts, `taste-${name}.png`) });
    await page.locator('#needs .chip').first().click();
    await page.waitForSelector('#panel.open');
    await page.locator('#close').click();
    await page.locator('#search-mode').click();
    await page.locator('#f-search').fill('approval');
    await page.locator('#reset-filters').click();
    assert.equal(await page.locator('#search-results').isVisible(), false);
    await page.screenshot({ path: join(artifacts, `taste-${name}-reset.png`) });
    await page.close();
  }
  writeFileSync(join(artifacts, 'taste-layout.json'), JSON.stringify(measurements, null, 2));
});
