// E2E: the Master window's bulk actions (stage 1b) on the generated fake
// fleet of 30 fictional projects (fleet-fixtures.mjs), with the real
// herdr-dash binary and stubbed herdr-projects / herdr. Every action is a
// dry-run preview first, then (tier 2) a confirmation bound to the preview's
// hash, then an execute step that runs one herdr-projects subcommand per
// project, writes one audit line per project, and records an undo.
// Artifacts: e2e/artifacts/fleet-actions-*.png and fleet-actions.json.
//
// Ways it could fail, written before the code:
//  B1. A tier-3 action exists: merge, resolve, delete, rename, key presses,
//      safety or profile changes, herdr-projects update, archive, sweep
//      --yes, or a hibernate of a coordinator, in the API or as a button.
//  B2. The preview is wrong: a missing or extra target, the wrong command, a
//      read-only, opted-out, paused, archived or busy project not refused
//      (or refused without saying why), no undo note, no hash or expiry, or
//      the preview itself runs a command.
//  B3. Limits: more than 30 targets accepted; more than 5 without the typed
//      confirmation; more than the fleet-wide actions a minute; a
//      broadcast to the same coordinator inside its 10-minute cooldown; a
//      kill switch (enabled = false) that does not stop execution.
//  B4. Confirmation: an apply with no token, an unknown, a reused or an
//      expired one, a wrong typed count, or one whose plan no longer
//      matches the fleet (a project changed after the preview) still runs.
//  B5. Execution runs other commands than the preview showed, in another
//      order, or reports results that are not per project; a failure does
//      not stop the batch after three in a row (circuit breaker), or the
//      projects after the breaker are run anyway.
//  B6. Undo: a setting's previous value is not recorded, undo sets the wrong
//      value, runs twice, or overrides a value someone changed since.
//  B7. The audit log misses a field (who, when, what, targets, preview
//      hash, result, undo), is not one line per project, is not under the
//      root's .fleet/, keeps lines older than 90 days, or cannot be
//      filtered.
//  B8. Broadcast: text sent without the "[fleet master, relaying the user]"
//      prefix, typed into a working or blocked coordinator, or into one
//      whose state changed in the last 60 s, instead of queued; "send now"
//      types into a busy one; a queued message is lost.
//  B9. The write guard is skipped: a cross-origin or non-JSON apply runs,
//      or a --read-only dashboard executes (previews may still show).
// B10. The window: no preview dialog before running, no typed count for
//      tier 2, results not shown per project, no undo button, no audit tab
//      or its filter does nothing, no queue with "send now".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifacts, startServer, freePort, waitFor, post } from "./helpers.mjs";
import { fleet, fleetTomlText, NAMES } from "./fleet-fixtures.mjs";

mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
let f, server, url, browser;
const PREFIX = "[fleet master, relaying the user]";
const OLD = new Date(Date.now() - 100 * 86400e3).toISOString().replace(/\.\d+Z$/, "Z");
const RECENT = new Date(Date.now() - 5 * 86400e3).toISOString().replace(/\.\d+Z$/, "Z");

function start(port, extra = [], log = f.log, toml = f.fleetToml) {
  return startServer(port, log, ["--root", f.root, "--herdr", join(f.stubDir, "herdr"), "--proc", f.proc, "--fleet-config", toml, ...extra],
    { HERDR_DASH_HERDR_PROJECTS: join(f.stubDir, "herdr-projects"), STUB_PANES: f.panesFile });
}
const auditPath = () => join(f.root, ".fleet", "audit.jsonl");
const getJSON = async (p, u = url) => (await fetch(u + p)).json();
const getFleet = () => getJSON("/api/fleet");
const rowOf = async (slug) => (await getFleet()).rows.find((r) => r.slug === slug);
const calls = () => readFileSync(f.log, "utf8").split("\n").filter(Boolean);
// Write calls only: the collector's reads (list, thread list, pane list) are
// not the Master window's.
const writes = (from) => calls().slice(from).filter((l) => !/^herdr-projects (--root \S+ )?(list|thread list|progress)|^herdr /.test(l));
const preview = (body, u = url) => post(u, "/api/fleet/preview", body);
const apply = (body, u = url) => post(u, "/api/fleet/apply", body);
async function runBatch(prev, confirm) {
  const r = await apply({ token: prev.token, ...(confirm != null ? { confirm: String(confirm) } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return waitFor(async () => {
    const b = await getJSON(`/api/fleet/batch/${r.json.batch}`);
    return b.status !== "running" && b;
  }, 20_000);
}
const verdicts = (p) => Object.fromEntries(p.steps.map((s) => [s.slug, s.verdict]));
const stepOf = (p, slug) => p.steps.find((s) => s.slug === slug);
const auditLines = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const setting = (slug, key) => readFileSync(join(f.root, slug, "PROJECT.md"), "utf8").match(new RegExp(`^${key} = (.*)$`, "m"))?.[1];
const setPairSince = (slug, iso) => {
  const p = join(f.root, slug, ".state/coordinators.json");
  const c = JSON.parse(readFileSync(p, "utf8"));
  c[0].pair_since = iso;
  writeFileSync(p, JSON.stringify(c));
};
const setCoordStatus = (slug, status) => {
  const panes = JSON.parse(readFileSync(f.panesFile, "utf8"));
  const ws = `f${String(NAMES.indexOf(slug)).padStart(2, "0")}`;
  panes.result.panes.find((x) => x.pane_id === `${ws}:c1`).agent_status = status;
  writeFileSync(f.panesFile, JSON.stringify(panes));
};

before(async () => {
  f = fleet();
  // An audit log with one line past the 90 days and one inside them: the
  // server rotates the old one away.
  mkdirSync(join(f.root, ".fleet"), { recursive: true });
  writeFileSync(auditPath(), [
    { ts: OLD, actor: "user@dash", batch: "b-old", op: "pause", target: "aurora-ledger", result: "ok" },
    { ts: RECENT, actor: "user@dash", batch: "b-recent", op: "pause", target: "birch-notes", result: "ok" },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const port = await freePort();
  // Dash's own write bucket is raised: the suite runs many batches a minute.
  server = start(port, ["--write-burst", "100", "--write-per-min", "1000"]);
  url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await getFleet()).rows.length === 30, 20_000);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
  writeFileSync(join(artifacts, "fleet-actions.json"), JSON.stringify(out, null, 2));
  rmSync(f.tmp, { recursive: true, force: true });
});

test("no tier-3 action exists (B1)", async () => {
  const ops = await getJSON("/api/fleet/ops");
  const names = ops.ops.map((o) => o.op).sort();
  assert.deepEqual(names, ["message", "nudge", "open", "pause", "priority", "resume", "set", "sweep"]);
  assert.ok(ops.ops.every((o) => [0, 1, 2].includes(o.tier)), JSON.stringify(ops.ops));
  assert.deepEqual(ops.limits, { batch_without_confirm: 5, batch_max: 30, actions_per_minute: 1000, broadcast_cooldown_minutes: 10 });
  assert.deepEqual(ops.set_keys, ["max_parallel_threads", "nudge", "mute"]);
  for (const op of ["merge", "resolve", "delete", "rename", "archive", "unarchive", "keys", "safety", "profile", "update", "hibernate", "stop", "restart", "thread-start", "doctor-fix"]) {
    const r = await preview({ op, targets: ["aurora-ledger"] });
    assert.equal(r.status, 400, op);
    assert.match(r.json.error, /not a fleet action/, op);
  }
  // Only the three settings the brief names; profiles and the rest are not.
  for (const key of ["coordinator_profile", "thread_profile", "name", "goal", "repos.add", "auto_resolve_days"]) {
    const r = await preview({ op: "set", key, value: "x", targets: ["aurora-ledger"] });
    assert.equal(r.status, 400, key);
  }
  // Sweep is a report: no --yes in any command it would run.
  const sw = await preview({ op: "sweep", targets: ["iris-index", "jade-queue"] });
  assert.ok(sw.json.steps.every((s) => s.command.endsWith("--dry-run")), JSON.stringify(sw.json.steps));
  out.ops = ops;
});

test("preview: commands, refusals with reasons, undo notes, no command run (B2)", async () => {
  const mark = calls().length;
  const targets = ["nimbus-ops", "kestrel-ml", "tundra-maps", "umber-chat", "lumen-docs", "no-such-project"];
  const r = await preview({ op: "pause", targets });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = r.json;
  assert.equal(p.op, "pause");
  assert.equal(p.tier, 1);
  assert.equal(p.needs_confirm, false);
  assert.match(p.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(p.token, /^c-[0-9a-f]{16,}$/);
  assert.ok(Date.parse(p.expires) > Date.now() + 60_000, p.expires);
  assert.deepEqual(p.steps.map((s) => s.slug), targets, "every target, in order");
  assert.deepEqual(verdicts(p), { "nimbus-ops": "will", "kestrel-ml": "refuse", "tundra-maps": "refuse", "umber-chat": "refuse", "lumen-docs": "refuse", "no-such-project": "refuse" });
  const n = stepOf(p, "nimbus-ops");
  assert.equal(n.command, "herdr-projects pause nimbus-ops");
  assert.match(n.change, /active → paused/);
  assert.equal(n.undo, "herdr-projects resume nimbus-ops");
  assert.match(stepOf(p, "kestrel-ml").reason, /already paused/);
  assert.match(stepOf(p, "tundra-maps").reason, /read-only/);
  assert.match(stepOf(p, "umber-chat").reason, /opted out/);
  assert.match(stepOf(p, "lumen-docs").reason, /archived/);
  assert.match(stepOf(p, "no-such-project").reason, /no such project/);
  assert.deepEqual(p.counts, { will: 1, queue: 0, refuse: 5 });
  // Busy refusals: a nudge never types into a working or blocked coordinator.
  const nu = (await preview({ op: "nudge", targets: ["maple-auth", "aurora-ledger", "ember-cache", "jade-queue"] })).json;
  assert.match(stepOf(nu, "maple-auth").reason, /busy: working/);
  assert.match(stepOf(nu, "aurora-ledger").reason, /busy: blocked/);
  assert.match(stepOf(nu, "ember-cache").reason, /no live coordinator/);
  assert.equal(stepOf(nu, "jade-queue").verdict, "will");
  assert.equal(nu.tier, 0);
  // The same plan has the same hash; a different selection another.
  const again = (await preview({ op: "pause", targets })).json;
  assert.equal(again.hash, p.hash);
  assert.notEqual(again.token, p.token);
  assert.notEqual((await preview({ op: "pause", targets: targets.slice(0, 2) })).json.hash, p.hash);
  assert.deepEqual(writes(mark), [], "a preview runs no command");
  out.preview = p;
});

test("execute: exactly the previewed commands, in order, with per-project results and audit lines (B5, B7)", async () => {
  const mark = calls().length;
  const p = (await preview({ op: "pause", targets: ["nimbus-ops", "onyx-search", "kestrel-ml"] })).json;
  const b = await runBatch(p);
  assert.equal(b.status, "done");
  assert.deepEqual(b.results.map((x) => [x.slug, x.result]), [["nimbus-ops", "ok"], ["onyx-search", "ok"], ["kestrel-ml", "refused"]]);
  assert.match(b.results[0].output, /paused nimbus-ops/);
  assert.deepEqual(writes(mark), [`herdr-projects --root ${f.root} pause nimbus-ops`, `herdr-projects --root ${f.root} pause onyx-search`]);
  await waitFor(async () => (await rowOf("onyx-search")).status === "paused", 10_000);
  // The audit: one line per project, every field.
  const lines = auditLines().filter((l) => l.batch === b.batch);
  assert.equal(lines.length, 3);
  const l = lines.find((x) => x.target === "nimbus-ops");
  assert.equal(l.actor, "user@dash");
  assert.equal(l.op, "pause");
  assert.equal(l.preview, p.hash);
  assert.equal(l.confirm, p.token);
  assert.equal(l.command, "herdr-projects pause nimbus-ops");
  assert.equal(l.result, "ok");
  assert.deepEqual(l.undo, { op: "resume", command: "herdr-projects resume nimbus-ops" });
  assert.ok(Math.abs(Date.parse(l.ts) - Date.now()) < 60_000, l.ts);
  const k = lines.find((x) => x.target === "kestrel-ml");
  assert.equal(k.result, "refused");
  assert.match(k.reason, /already paused/);
  assert.equal(k.undo, undefined);
  // Undo of the pause: a preview of the resumes, then the resumes.
  const u = await preview({ op: "undo", batch: b.batch });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.deepEqual(u.json.steps.map((s) => [s.slug, s.verdict, s.command]), [["nimbus-ops", "will", "herdr-projects resume nimbus-ops"], ["onyx-search", "will", "herdr-projects resume onyx-search"]]);
  const ub = await runBatch(u.json);
  assert.equal(ub.status, "done");
  await waitFor(async () => (await rowOf("onyx-search")).status === "active", 10_000);
  out.execute = { batch: b, audit: lines };
});

test("tier 2: over 5 targets needs the typed count (B3, B4)", async () => {
  const six = ["raven-mail", "saffron-shop", "vega-metrics", "willow-forms", "xenon-build", "zephyr-feeds"];
  const p = (await preview({ op: "pause", targets: six })).json;
  assert.equal(p.tier, 2);
  assert.equal(p.needs_confirm, true);
  assert.match(p.confirm_reason, /more than 5/);
  const mark = calls().length;
  let r = await apply({ token: p.token });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "confirm_count");
  // A wrong count does not burn the token; the right one runs.
  r = await apply({ token: p.token, confirm: "5" });
  assert.equal(r.status, 400);
  assert.deepEqual(writes(mark), []);
  const b = await runBatch(p, 6);
  assert.equal(b.results.filter((x) => x.result === "ok").length, 6);
  // Put them back (tier 2 again).
  await waitFor(async () => (await rowOf("zephyr-feeds")).status === "paused", 10_000);
  const back = (await preview({ op: "resume", targets: six })).json;
  assert.equal(back.tier, 2);
  await runBatch(back, 6);
  await waitFor(async () => (await rowOf("zephyr-feeds")).status === "active", 10_000);
  // Raising a cap is tier 2 even for one project; lowering it tier 1.
  assert.equal((await preview({ op: "set", key: "max_parallel_threads", value: "8", targets: ["harbor-ui"] })).json.tier, 2);
  assert.equal((await preview({ op: "set", key: "max_parallel_threads", value: "2", targets: ["harbor-ui"] })).json.tier, 1);
  // A broadcast is always tier 2.
  assert.equal((await preview({ op: "message", text: "hello", targets: ["jade-queue"] })).json.tier, 2);
});

test("limits: batch max, actions a minute, kill switch (B3)", async () => {
  const r = await preview({ op: "nudge", targets: [...NAMES, "one-more-project"] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /at most 30/);
  // Two actions a minute, on a fresh server (the count is the server's):
  // of four targets two run, two are refused; then none is left.
  const port = await freePort();
  const toml2 = join(f.tmp, "fleet-2pm.toml");
  writeFileSync(toml2, fleetTomlText({ actions_per_minute: 2 }));
  const log2 = join(f.tmp, "calls-rate");
  writeFileSync(log2, "");
  const s3 = start(port, [], log2, toml2);
  const u2 = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await getJSON("/api/fleet", u2)).rows.length === 30, 20_000);
    const four = ["iris-index", "jade-queue", "pebble-cli", "basalt-etl"];
    const p = (await preview({ op: "sweep", targets: four }, u2)).json;
    assert.deepEqual(p.steps.map((s) => s.verdict), ["will", "will", "refuse", "refuse"], JSON.stringify(p.steps));
    assert.match(p.steps[2].reason, /2 actions a minute/);
    const a = await apply({ token: p.token }, u2);
    assert.equal(a.status, 200);
    await waitFor(async () => (await getJSON(`/api/fleet/batch/${a.json.batch}`, u2)).status === "done", 10_000);
    const q = (await preview({ op: "sweep", targets: four }, u2)).json;
    assert.ok(q.steps.every((s) => s.verdict === "refuse"), JSON.stringify(q.steps));
    assert.equal(readFileSync(log2, "utf8").split("\n").filter((l) => / sweep /.test(l)).length, 2);
  } finally {
    s3.kill();
  }
  // The kill switch: previews still show; nothing runs.
  writeFileSync(f.fleetToml, fleetTomlText(undefined, "enabled = false"));
  try {
    await waitFor(async () => (await getJSON("/api/fleet/ops")).enabled === false, 5000);
    const p = (await preview({ op: "sweep", targets: ["iris-index"] })).json;
    const mark = calls().length;
    const a = await apply({ token: p.token });
    assert.equal(a.status, 403);
    assert.match(a.json.error, /enabled = false/);
    assert.deepEqual(writes(mark), []);
  } finally {
    writeFileSync(f.fleetToml, fleetTomlText());
  }
  await waitFor(async () => (await getJSON("/api/fleet/ops")).enabled === true, 5000);
});

test("confirm tokens: unknown, reused, changed plan (B4)", async () => {
  const mark = calls().length;
  let r = await apply({});
  assert.equal(r.status, 400);
  r = await apply({ token: "c-0000000000000000" });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "confirm_unknown");
  // Single use.
  const p = (await preview({ op: "sweep", targets: ["iris-index"] })).json;
  await runBatch(p);
  r = await apply({ token: p.token });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "confirm_used");
  // The fleet changes between preview and apply: refused, nothing runs.
  const q = (await preview({ op: "pause", targets: ["pebble-cli"] })).json;
  const list = join(f.stubDir, "list.tsv");
  const touch = () => { const pm = join(f.root, "pebble-cli", "PROJECT.md"); writeFileSync(pm, readFileSync(pm, "utf8")); };
  writeFileSync(list, readFileSync(list, "utf8").replace(/^pebble-cli\tactive\t/m, "pebble-cli\tpaused\t"));
  touch();
  await waitFor(async () => (await rowOf("pebble-cli")).status === "paused", 10_000);
  const before = calls().length;
  r = await apply({ token: q.token });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "plan_changed");
  assert.deepEqual(writes(before), []);
  writeFileSync(list, readFileSync(list, "utf8").replace(/^pebble-cli\tpaused\t/m, "pebble-cli\tactive\t"));
  await sleep(20);
  touch();
  await waitFor(async () => (await rowOf("pebble-cli")).status === "active", 10_000);
  // The refused applies are in the audit too.
  const refused = auditLines().filter((l) => l.op === "apply" && l.result === "refused");
  assert.ok(refused.some((l) => /used/.test(l.reason)) && refused.some((l) => /changed/.test(l.reason)), JSON.stringify(refused));
  assert.equal(writes(mark).filter((l) => !/sweep iris-index --dry-run/.test(l)).length, 0);
});

test("confirm tokens expire; read-only and cross-origin refused (B4, B9)", async () => {
  const port = await freePort();
  const log2 = join(f.tmp, "calls-ttl");
  writeFileSync(log2, "");
  const s2 = start(port, ["--fleet-confirm-ttl", "1s"], log2);
  const port3 = await freePort();
  const s3 = start(port3, ["--read-only"], log2);
  const u2 = `http://127.0.0.1:${port}`, u3 = `http://127.0.0.1:${port3}`;
  try {
    await waitFor(async () => (await getJSON("/api/fleet", u2)).rows.length === 30 && (await getJSON("/api/fleet", u3)).rows.length === 30, 20_000);
    const p = (await preview({ op: "sweep", targets: ["iris-index"] }, u2)).json;
    await sleep(1500);
    const r = await apply({ token: p.token }, u2);
    assert.equal(r.status, 410);
    assert.equal(r.json.code, "confirm_expired");
    // Read-only: a preview shows, nothing executes.
    const q = await preview({ op: "sweep", targets: ["iris-index"] }, u3);
    assert.equal(q.status, 200);
    const a = await apply({ token: q.json.token }, u3);
    assert.equal(a.status, 403);
    assert.match(a.json.error, /read-only/);
    // Cross-origin and non-JSON applies are refused before the token.
    const p2 = (await preview({ op: "sweep", targets: ["iris-index"] })).json;
    const x = await post(url, "/api/fleet/apply", { token: p2.token }, { Origin: "http://evil.example" });
    assert.equal(x.status, 403);
    const y = await fetch(url + "/api/fleet/apply", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ token: p2.token }) });
    assert.equal(y.status, 415);
    assert.equal(readFileSync(log2, "utf8").split("\n").filter((l) => / sweep /.test(l)).length, 0);
  } finally {
    s2.kill();
    s3.kill();
  }
});

test("circuit breaker: three failures in a row stop the batch (B5)", async () => {
  for (const s of ["basalt-etl", "dune-player", "pebble-cli"]) writeFileSync(join(f.stubDir, `fail-pause-${s}`), "");
  try {
    const mark = calls().length;
    const p = (await preview({ op: "pause", targets: ["amber-wiki", "basalt-etl", "dune-player", "pebble-cli", "quartz-billing"] })).json;
    assert.equal(p.counts.will, 5);
    const b = await runBatch(p);
    assert.equal(b.status, "stopped");
    assert.match(b.note, /3 failures in a row/);
    assert.deepEqual(b.results.map((x) => [x.slug, x.result]), [["amber-wiki", "ok"], ["basalt-etl", "failed"], ["dune-player", "failed"], ["pebble-cli", "failed"], ["quartz-billing", "not-attempted"]]);
    assert.match(b.results[1].error, /stub fails pause for basalt-etl/);
    assert.ok(!writes(mark).some((l) => /quartz-billing/.test(l)), "nothing after the breaker");
    const lines = auditLines().filter((l) => l.batch === b.batch);
    assert.deepEqual(lines.map((l) => l.result), ["ok", "failed", "failed", "failed", "not-attempted"]);
    out.breaker = b;
    // Undo touches only what ran. Preview it once the pause shows: a plan
    // previewed before then changes when it does (plan_changed).
    await waitFor(async () => (await rowOf("amber-wiki")).status === "paused", 10_000);
    const u = (await preview({ op: "undo", batch: b.batch })).json;
    assert.deepEqual(u.steps.map((s) => s.slug), ["amber-wiki"]);
    await runBatch(u);
  } finally {
    for (const s of ["basalt-etl", "dune-player", "pebble-cli"]) rmSync(join(f.stubDir, `fail-pause-${s}`), { force: true });
  }
});

test("undo a setting: previous value recorded and restored once (B6)", async () => {
  assert.equal(setting("cobalt-relay", "max_parallel_threads"), "4");
  const p = (await preview({ op: "set", key: "max_parallel_threads", value: "2", targets: ["cobalt-relay", "harbor-ui"] })).json;
  assert.equal(stepOf(p, "cobalt-relay").command, "herdr-projects set cobalt-relay max_parallel_threads 2");
  assert.match(stepOf(p, "cobalt-relay").change, /max_parallel_threads 4 → 2/);
  assert.equal(stepOf(p, "cobalt-relay").undo, "herdr-projects set cobalt-relay max_parallel_threads 4");
  // A value already in place is refused.
  const same = (await preview({ op: "set", key: "max_parallel_threads", value: "4", targets: ["cobalt-relay"] })).json;
  assert.match(stepOf(same, "cobalt-relay").reason, /already 4/);
  // Booleans: the default (nudge = true) counts as the previous value.
  const nu = (await preview({ op: "set", key: "nudge", value: "false", targets: ["cobalt-relay"] })).json;
  assert.match(stepOf(nu, "cobalt-relay").change, /nudge true → false/);
  assert.equal((await preview({ op: "set", key: "nudge", value: "maybe", targets: ["cobalt-relay"] })).status, 400);
  const b = await runBatch(p);
  assert.equal(b.status, "done");
  assert.equal(setting("cobalt-relay", "max_parallel_threads"), "2");
  const l = auditLines().find((x) => x.batch === b.batch && x.target === "cobalt-relay");
  assert.deepEqual(l.args, ["max_parallel_threads", "2"]);
  assert.equal(l.previous, "4");
  assert.deepEqual(l.undo, { op: "set", args: ["max_parallel_threads", "4"], command: "herdr-projects set cobalt-relay max_parallel_threads 4" });
  // harbor-ui changed by someone else since: its undo is refused.
  writeFileSync(join(f.root, "harbor-ui", "PROJECT.md"), readFileSync(join(f.root, "harbor-ui", "PROJECT.md"), "utf8").replace(/^max_parallel_threads = .*/m, "max_parallel_threads = 3"));
  const u = (await preview({ op: "undo", batch: b.batch })).json;
  assert.equal(stepOf(u, "cobalt-relay").verdict, "will");
  assert.equal(stepOf(u, "cobalt-relay").command, "herdr-projects set cobalt-relay max_parallel_threads 4");
  assert.equal(stepOf(u, "harbor-ui").verdict, "refuse");
  assert.match(stepOf(u, "harbor-ui").reason, /changed since/);
  const mark = calls().length;
  const ub = await runBatch(u);
  assert.equal(ub.status, "done");
  assert.deepEqual(writes(mark), [`herdr-projects --root ${f.root} set cobalt-relay max_parallel_threads 4`]);
  assert.equal(setting("cobalt-relay", "max_parallel_threads"), "4");
  const twice = await preview({ op: "undo", batch: b.batch });
  assert.equal(twice.status, 409);
  assert.match(twice.json.error, /already undone/);
  const ul = auditLines().find((x) => x.batch === ub.batch && x.target === "cobalt-relay");
  assert.equal(ul.op, "set");
  assert.equal(ul.undo_of, b.batch);
});

test("broadcast: prefix, idle coordinators now, the rest queued, cooldown, send now (B8)", async () => {
  // garnet-api's coordinator changed state 5 s ago: not quiet for 60 s.
  setPairSince("garnet-api", new Date(Date.now() - 5000).toISOString());
  await waitFor(async () => Date.now() - Date.parse((await rowOf("garnet-api")).coordinator.state_since) < 60_000, 10_000);
  const text = "Please pause new threads until tomorrow.";
  const targets = ["cobalt-relay", "birch-notes", "aurora-ledger", "delta-forge", "garnet-api", "ember-cache", "tundra-maps", "kestrel-ml"];
  const p = (await preview({ op: "message", text, targets })).json;
  assert.equal(p.text, `${PREFIX} ${text}`);
  assert.equal(p.tier, 2);
  assert.deepEqual(verdicts(p), {
    "cobalt-relay": "will", "birch-notes": "will", "aurora-ledger": "queue", "delta-forge": "queue", "garnet-api": "queue",
    "ember-cache": "refuse", "tundra-maps": "refuse", "kestrel-ml": "refuse",
  });
  assert.match(stepOf(p, "aurora-ledger").reason, /blocked/);
  assert.match(stepOf(p, "delta-forge").reason, /working/);
  assert.match(stepOf(p, "garnet-api").reason, /60 s/);
  assert.match(stepOf(p, "ember-cache").reason, /no live coordinator/);
  assert.match(stepOf(p, "tundra-maps").reason, /read-only/);
  assert.match(stepOf(p, "kestrel-ml").reason, /paused/);
  assert.equal(stepOf(p, "cobalt-relay").command, "herdr-projects coordinator prompt cobalt-relay --text-file -");
  assert.deepEqual(p.counts, { will: 2, queue: 3, refuse: 3 });
  const mark = calls().length;
  const b = await runBatch(p, 5); // the typed count: sent now plus queued
  assert.equal(b.status, "done");
  const w = writes(mark);
  assert.deepEqual(w.filter((l) => !l.startsWith("stdin:")), [`herdr-projects --root ${f.root} coordinator prompt cobalt-relay --text-file -`, `herdr-projects --root ${f.root} coordinator prompt birch-notes --text-file -`]);
  assert.deepEqual(w.filter((l) => l.startsWith("stdin:")), [`stdin: ${PREFIX} ${text}`, `stdin: ${PREFIX} ${text}`]);
  assert.deepEqual(b.results.map((x) => [x.slug, x.result]).filter(([, r]) => r !== "refused"),
    [["cobalt-relay", "ok"], ["birch-notes", "ok"], ["aurora-ledger", "queued"], ["delta-forge", "queued"], ["garnet-api", "queued"]]);
  const q = await getJSON("/api/fleet/queue");
  assert.deepEqual(q.items.map((i) => i.slug).sort(), ["aurora-ledger", "delta-forge", "garnet-api"]);
  assert.equal(q.items[0].text, `${PREFIX} ${text}`);
  // Cooldown: cobalt-relay got a broadcast just now.
  const again = (await preview({ op: "message", text: "Another one.", targets: ["cobalt-relay"] })).json;
  assert.match(stepOf(again, "cobalt-relay").reason, /cooldown/);
  // Send now refuses a coordinator still busy; once idle, it sends.
  const busy = await post(url, "/api/fleet/queue/send", { slug: "delta-forge", batch: b.batch });
  assert.equal(busy.status, 409);
  assert.match(busy.json.error, /working/);
  setCoordStatus("delta-forge", "idle");
  await waitFor(async () => (await rowOf("delta-forge")).coordinator.state === "idle", 10_000);
  const m2 = calls().length;
  const sent = await post(url, "/api/fleet/queue/send", { slug: "delta-forge", batch: b.batch });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.deepEqual(writes(m2), [`herdr-projects --root ${f.root} coordinator prompt delta-forge --text-file -`, `stdin: ${PREFIX} ${text}`]);
  assert.deepEqual((await getJSON("/api/fleet/queue")).items.map((i) => i.slug).sort(), ["aurora-ledger", "garnet-api"]);
  const lines = auditLines().filter((l) => l.batch === b.batch);
  assert.deepEqual(lines.filter((l) => l.target === "delta-forge").map((l) => l.result), ["queued", "ok"]);
  assert.ok(lines.every((l) => l.text === `${PREFIX} ${text}`));
  setCoordStatus("delta-forge", "working");
  out.broadcast = { preview: p, batch: b };
});

test("nudge, open, priority, sweep (B2, B5)", async () => {
  // Nudge: the fixed line; read-only projects get it (tier 0).
  let mark = calls().length;
  const n = (await preview({ op: "nudge", targets: ["jade-queue", "tundra-maps", "umber-chat"] })).json;
  assert.deepEqual(verdicts(n), { "jade-queue": "will", "tundra-maps": "will", "umber-chat": "refuse" });
  assert.match(n.text, /^\[fleet master\] /);
  await runBatch(n);
  const w = writes(mark);
  assert.deepEqual(w.filter((l) => !l.startsWith("stdin:")), [`herdr-projects --root ${f.root} coordinator prompt jade-queue --text-file -`, `herdr-projects --root ${f.root} coordinator prompt tundra-maps --text-file -`]);
  assert.ok(w.filter((l) => l.startsWith("stdin:")).every((l) => l === `stdin: ${n.text}`));
  // Open: only missing or exited coordinators of active projects.
  const o = (await preview({ op: "open", targets: ["ember-cache", "fjord-sync", "cobalt-relay", "kestrel-ml", "tundra-maps"] })).json;
  assert.deepEqual(verdicts(o), { "ember-cache": "will", "fjord-sync": "will", "cobalt-relay": "refuse", "kestrel-ml": "refuse", "tundra-maps": "refuse" });
  assert.match(stepOf(o, "cobalt-relay").reason, /already running/);
  assert.equal(stepOf(o, "ember-cache").command, "herdr-projects open ember-cache");
  mark = calls().length;
  await runBatch(o);
  assert.deepEqual(writes(mark), [`herdr-projects --root ${f.root} open ember-cache`, `herdr-projects --root ${f.root} open fjord-sync`]);
  // Priority: fleet.toml changes, other entries stay.
  const pr = (await preview({ op: "priority", value: "true", targets: ["harbor-ui", "garnet-api"] })).json;
  assert.match(stepOf(pr, "garnet-api").reason, /already/);
  assert.equal(stepOf(pr, "harbor-ui").command, "fleet.toml: projects.harbor-ui.priority = true");
  const pb = await runBatch(pr);
  await waitFor(async () => (await rowOf("harbor-ui")).priority === true, 5000);
  const toml = readFileSync(f.fleetToml, "utf8");
  assert.match(toml, /garnet-api/);
  assert.match(toml, /mode = ['"]read-only['"]/);
  const pu = (await preview({ op: "undo", batch: pb.batch })).json;
  assert.equal(pu.steps[0].command, "fleet.toml: projects.harbor-ui.priority = false");
  await runBatch(pu);
  await waitFor(async () => (await rowOf("harbor-ui")).priority === false, 5000);
  assert.equal((await rowOf("garnet-api")).priority, true);
  // Sweep: a report per project, nothing removed.
  const s = (await preview({ op: "sweep", targets: ["jade-queue", "tundra-maps"] })).json;
  assert.equal(s.tier, 0);
  const sb = await runBatch(s);
  assert.match(sb.results[0].output, /would remove worktree/);
  assert.equal(sb.undoable, false);
});

test("audit: rotation at 90 days, filters (B7)", async () => {
  const all = auditLines();
  assert.ok(!all.some((l) => l.batch === "b-old"), "the 100-day-old line is gone");
  assert.ok(all.some((l) => l.batch === "b-recent"), "the 5-day-old line stays");
  const a = await getJSON("/api/fleet/audit");
  assert.ok(a.lines.length >= 10);
  assert.ok(Date.parse(a.lines[0].ts) >= Date.parse(a.lines.at(-1).ts), "newest first");
  const byProject = await getJSON("/api/fleet/audit?project=cobalt-relay");
  assert.ok(byProject.lines.length > 0 && byProject.lines.every((l) => l.target === "cobalt-relay"));
  const byOp = await getJSON("/api/fleet/audit?op=message");
  assert.ok(byOp.lines.length > 0 && byOp.lines.every((l) => l.op === "message"));
  const byResult = await getJSON("/api/fleet/audit?result=failed");
  assert.equal(byResult.lines.length, 3);
  out.audit = a.lines.slice(0, 20);
});

test("window: preview, typed count, results, undo, audit tab, queue (B10)", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url + "/");
  await page.waitForFunction(() => window.hd?.state().projects.length === 30);
  await page.click("#master-open");
  const W = '.hwin[data-win="master"]';
  await page.waitForSelector(`${W} #fl-table tbody tr[data-slug]`);
  // Tick a project by finding it with the filter (the window may be taller
  // than the viewport).
  const pick = async (slug) => {
    await page.fill(`${W} #fl-q`, slug);
    await page.click(`${W} #fl-table tr[data-slug="${slug}"] input.fl-sel`);
    await page.fill(`${W} #fl-q`, "");
  };
  // Pause two projects through the dialog.
  for (const s of ["cedar-sdk", "yarrow-crm", "kestrel-ml"]) await pick(s);
  // No tier-3 button anywhere in the window.
  const labels = await page.$$eval(`${W} .fl-actions button`, (bs) => bs.map((b) => b.dataset.op));
  assert.deepEqual(labels.sort(), ["message", "nudge", "open", "pause", "priority", "resume", "set", "sweep"]);
  const buttons = (await page.$$eval(`${W} button`, (bs) => bs.map((b) => b.textContent))).join(" ").toLowerCase();
  for (const bad of ["merge", "resolve", "delete", "archive", "hibernate", "keys"]) assert.ok(!buttons.includes(bad), bad);
  await page.click(`${W} .fl-actions button[data-op="pause"]`);
  await page.waitForSelector(`${W} #fl-dlg .fl-plan tr[data-slug]`);
  const plan = await page.$$eval(`${W} #fl-dlg .fl-plan tr[data-slug]`, (rs) => rs.map((r) => [r.dataset.slug, r.dataset.verdict, r.querySelector("code")?.textContent || ""]));
  assert.deepEqual(plan.map(([s, v]) => [s, v]).sort(), [["cedar-sdk", "will"], ["kestrel-ml", "refuse"], ["yarrow-crm", "will"]]);
  assert.ok(plan.some(([, , c]) => c === "herdr-projects pause cedar-sdk"));
  assert.match(await page.textContent(`${W} #fl-dlg`), /already paused/);
  await page.screenshot({ path: join(artifacts, "fleet-actions-preview.png") });
  await page.click(`${W} #fl-dlg #fl-run`);
  await page.waitForSelector(`${W} #fl-dlg .fl-results[data-status="done"]`, { timeout: 20_000 });
  const res = await page.$$eval(`${W} #fl-dlg .fl-results tr[data-slug]`, (rs) => rs.map((r) => [r.dataset.slug, r.dataset.result]));
  assert.deepEqual(res.sort(), [["cedar-sdk", "ok"], ["kestrel-ml", "refused"], ["yarrow-crm", "ok"]]);
  await page.screenshot({ path: join(artifacts, "fleet-actions-results.png") });
  // Undo from the results: its own preview, then run.
  await page.click(`${W} #fl-dlg #fl-undo`);
  await page.waitForSelector(`${W} #fl-dlg .fl-plan tr[data-slug="cedar-sdk"][data-verdict="will"]`);
  assert.match(await page.textContent(`${W} #fl-dlg .fl-plan`), /resume cedar-sdk/);
  await page.click(`${W} #fl-dlg #fl-run`);
  await page.waitForSelector(`${W} #fl-dlg .fl-results[data-status="done"]`, { timeout: 20_000 });
  await page.click(`${W} #fl-dlg #fl-dlg-close`);
  await waitFor(async () => (await rowOf("cedar-sdk")).status === "active", 10_000);
  // Broadcast: the composer shows the exact text and the recipients, and a
  // tier-2 run needs the typed count.
  await page.click(`${W} #fl-clear`);
  for (const s of ["iris-index", "maple-auth"]) await pick(s);
  await page.click(`${W} .fl-actions button[data-op="message"]`);
  await page.fill(`${W} #fl-dlg #fl-text`, "Wrap up for the day.");
  await page.click(`${W} #fl-dlg #fl-preview`);
  await page.waitForSelector(`${W} #fl-dlg .fl-plan tr[data-slug="maple-auth"][data-verdict="queue"]`);
  assert.equal(await page.textContent(`${W} #fl-dlg .fl-sendtext`), `${PREFIX} Wrap up for the day.`);
  assert.equal(await page.isDisabled(`${W} #fl-dlg #fl-run`), true, "tier 2: run is disabled until the count is typed");
  await page.fill(`${W} #fl-dlg #fl-confirm`, "2");
  await page.screenshot({ path: join(artifacts, "fleet-actions-broadcast.png") });
  await page.click(`${W} #fl-dlg #fl-run`);
  await page.waitForSelector(`${W} #fl-dlg .fl-results[data-status="done"]`, { timeout: 20_000 });
  await page.click(`${W} #fl-dlg #fl-dlg-close`);
  // The queue: maple-auth waits with a "send now".
  await page.waitForSelector(`${W} #fl-queue li[data-slug="maple-auth"] button.fl-sendnow`);
  // Audit tab, filtered by operation.
  await page.click(`${W} .fl-tabs button[data-tab="audit"]`);
  await page.waitForSelector(`${W} #fl-audit tr[data-op]`);
  await page.selectOption(`${W} #fl-audit-op`, "message");
  await page.waitForFunction(() => {
    const rs = [...document.querySelectorAll('.hwin[data-win="master"] #fl-audit tbody tr[data-op]')];
    return rs.length > 0 && rs.every((r) => r.dataset.op === "message");
  });
  await page.fill(`${W} #fl-audit-q`, "maple-auth");
  await page.waitForFunction(() => {
    const rs = [...document.querySelectorAll('.hwin[data-win="master"] #fl-audit tbody tr[data-op]')];
    return rs.length > 0 && rs.every((r) => r.dataset.target === "maple-auth");
  });
  await page.screenshot({ path: join(artifacts, "fleet-actions-audit.png") });
  assert.deepEqual(errors, []);
  await ctx.close();
});
