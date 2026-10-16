import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import {
  artifacts,
  td,
  stub,
  startServer,
  freePort,
  waitFor,
} from "./helpers.mjs";

test("session provenance, live overrides, unknowns and responsive panels", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dash-session-"));
  const root = join(tmp, "root"),
    claude = join(tmp, "claude"),
    codex = join(tmp, "codex"),
    db = join(tmp, "opencode.db"),
    profiles = join(tmp, "profiles.toml");
  cpSync(join(td, "root"), root, { recursive: true });
  mkdirSync(join(claude, "project"), { recursive: true });
  mkdirSync(join(codex, "2026/10/16"), { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    profiles,
    '[profiles.claude]\nagent="claude"\nmodel="configured-claude"\neffort="medium"\n[profiles.codex]\nagent="codex"\nmodel="configured-codex"\neffort="high"\n',
  );
  writeFileSync(
    join(claude, "project/11111111-1111-1111-1111-111111111111.jsonl"),
    JSON.stringify({
      type: "assistant",
      effort: "high",
      perTurnEffort: "max",
      message: {
        model: "claude-session",
        usage: { input_tokens: 123, output_tokens: 456789 },
      },
    }) + "\n",
  );
  const codexFile = join(
    codex,
    "2026/10/16/rollout-22222222-2222-2222-2222-222222222222.jsonl",
  );
  const events = (model, effort, window) =>
    [
      { type: "session_meta", payload: { model_provider: "openai" } },
      { type: "turn_context", payload: { model, effort } },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            model_context_window: window,
            total_token_usage: { total_tokens: 900000 },
          },
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n";
  writeFileSync(codexFile, events("gpt-session", "low", 475000));
  const ocConfig = join(tmp, "oc-config");
  mkdirSync(ocConfig);
  writeFileSync(
    join(ocConfig, "opencode.jsonc"),
    JSON.stringify({
      model: "gateway/fallback-model",
      provider: {
        gateway: {
          models: {
            "model-with-a-long-provider-qualified-name-for-narrow-layouts": {
              limit: { context: 262144 },
            },
            "fallback-model": { limit: { context: 64000 } },
          },
        },
      },
    }),
  );
  const panes = JSON.parse(readFileSync(join(stub, "panes.json"), "utf8"));
  const oc = panes.result.panes.find((p) => p.pane_id === "w1Z:p1");
  oc.agent = "opencode";
  oc.agent_session = { agent: "opencode", value: "ses_fixture" };
  const paneFile = join(tmp, "panes.json");
  writeFileSync(paneFile, JSON.stringify(panes));
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE message (session_id TEXT,time_created INTEGER,data TEXT); INSERT INTO message VALUES ('ses_fixture',1,'{"role":"assistant","modelID":"model-with-a-long-provider-qualified-name-for-narrow-layouts","providerID":"gateway"}'),('ses_fixture',2,'{"role":"user","model":{"providerID":"gateway","modelID":"model-with-a-long-provider-qualified-name-for-narrow-layouts"},"variant":"high"}'),('ses_fixture',3,'{"role":"assistant","modelID":"model-with-a-long-provider-qualified-name-for-narrow-layouts","providerID":"gateway"}');`,
  ]);
  const port = await freePort(),
    base = `http://127.0.0.1:${port}`,
    log = join(tmp, "calls");
  writeFileSync(log, "");
  const server = startServer(
    port,
    log,
    [
      "--root",
      root,
      "--claude-dir",
      claude,
      "--codex-dir",
      codex,
      "--session-profiles",
      profiles,
      "--opencode-db",
      db,
      "--opencode-config",
      ocConfig,
    ],
    { STUB_PANES: paneFile },
  );
  let browser;
  try {
    const state = () => fetch(base + "/api/state").then((r) => r.json());
    let s = await waitFor(async () => {
      const s = await state();
      return (
        s.threads?.find((t) => t.key === "alpha/t-0003")?.session?.model
          .value === "gpt-session" && s
      );
    });
    const th = (id) => s.threads.find((t) => t.key === id).session;
    assert.equal(th("alpha/t-0001").model.value, "claude-session");
    assert.equal(th("alpha/t-0001").effort.source, "session");
    assert.equal(th("alpha/t-0001").effort.value, "max");
    assert.equal(th("alpha/t-0001").context_window.tokens, 0);
    assert.equal(th("alpha/t-0001").provider.value, "");
    assert.equal(th("alpha/t-0002").model.value, "configured-claude");
    assert.equal(th("alpha/t-0002").model.source, "profile");
    assert.equal(th("alpha/t-0003").context_window.tokens, 475000);
    assert.equal(th("alpha/t-0003").effort.value, "low");
    assert.equal(
      s.projects.find((p) => p.slug === "alpha").coordinator.session.provider
        .value,
      "gateway",
    );
    assert.equal(
      s.projects.find((p) => p.slug === "alpha").coordinator.session.effort
        .value,
      "high",
    );
    assert.equal(
      s.projects.find((p) => p.slug === "alpha").coordinator.session
        .context_window.tokens,
      262144,
    );
    assert.equal(
      s.projects.find((p) => p.slug === "alpha").coordinator.session
        .context_window.source,
      "config",
    );
    writeFileSync(
      join(artifacts, "session-initial-state.json"),
      JSON.stringify(s, null, 2),
    );
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForSelector("svg g.node");
    for (const [key, name] of [
      ["alpha/t-0001", "claude"],
      ["alpha/t-0003", "codex"],
      ["alpha/t-0002", "profile"],
      ["hub:alpha", "opencode"],
      ["hub:gamma", "missing"],
    ]) {
      await page.evaluate((k) => window.hd.select(k), key);
      await page.waitForSelector(".session-details");
      assert.match(
        await page.locator(".session-details").innerText(),
        /Provider[\s\S]*Model[\s\S]*Effort[\s\S]*Context window/,
      );
      for (const width of [1280, 760, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({
          path: join(artifacts, `session-${name}-${width}.png`),
        });
        assert.equal(
          await page
            .locator(".session-details")
            .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
          true,
        );
      }
    }
    await page.evaluate(() => window.hd.select("alpha/t-0003"));
    writeFileSync(
      codexFile,
      JSON.stringify({
        type: "session_meta",
        payload: { model_provider: "openai" },
      }) +
        "\n" +
        " ".repeat(5 * 1024 * 1024) +
        "\n" +
        events("gpt-switched", "medium", 200000)
          .split("\n")
          .slice(1)
          .join("\n"),
    );
    await waitFor(async () => {
      s = await state();
      return th("alpha/t-0003").model.value === "gpt-switched";
    });
    await page.waitForFunction(() =>
      document
        .querySelector(".session-details")
        .textContent.includes("gpt-switched"),
    );
    assert.equal(th("alpha/t-0003").provider.value, "openai");
    assert.equal(th("alpha/t-0003").context_window.tokens, 200000);
    oc.agent_session.value = "ses_missing";
    writeFileSync(paneFile, JSON.stringify(panes));
    await waitFor(async () => {
      s = await state();
      return (
        s.projects.find((p) => p.slug === "alpha").coordinator.session.model
          .value === "fallback-model"
      );
    });
    assert.equal(
      s.projects.find((p) => p.slug === "alpha").coordinator.session.model
        .source,
      "config",
    );
    assert.equal(
      s.projects.find((p) => p.slug === "alpha").coordinator.session
        .context_window.tokens,
      64000,
    );
    oc.agent = "codex";
    oc.agent_session = {
      agent: "codex",
      value: "22222222-2222-2222-2222-222222222222",
    };
    writeFileSync(paneFile, JSON.stringify(panes));
    await waitFor(async () => {
      s = await state();
      return (
        s.projects.find((p) => p.slug === "alpha").coordinator.session.model
          .value === "gpt-switched"
      );
    });
    oc.agent = "unsupported";
    oc.agent_session = { agent: "unsupported", value: "not-readable" };
    writeFileSync(paneFile, JSON.stringify(panes));
    await waitFor(async () => {
      s = await state();
      return (
        s.projects.find((p) => p.slug === "alpha").coordinator.session.model
          .source === "unknown"
      );
    });
    assert.equal(
      s.projects.find((p) => p.slug === "alpha").coordinator.session
        .context_window.tokens,
      0,
    );
    writeFileSync(
      join(artifacts, "session-state.json"),
      JSON.stringify(s, null, 2),
    );
  } finally {
    await browser?.close();
    server.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});
