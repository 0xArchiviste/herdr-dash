// E2E: --read-model go. The real herdr-dash binary reads a projects root in
// process (internal/projects) instead of running `herdr-projects list` and
// `thread list --json`, and the page state must come out the same. When a
// herdr-projects 0.2.35 binary is found (HP_RUST_BIN, else the installed
// plugin), the same root is also served with --read-model cli through it
// and the two /api/state snapshots are compared; otherwise only the Go
// side's expected groups are checked, and the artifact says so.
// Artifact: e2e/artifacts/readmodel.json.
//
// Ways it could fail, written before it existed:
//  R1. The flag is ignored: Dash still runs herdr-projects (the stub log
//      shows `list` or `thread list` calls in go mode).
//  R2. Thread groups or notes differ from the CLI's for the same root and
//      panes: working, blocked a long time, a closed pane after a report,
//      resolved, a young starting thread, an unreachable session.
//  R3. Project rows differ: status, summary counts, archived projects shown.
//  R4. Next lines from the home report and .next.md are lost.
//  R5. A bad --read-model value starts the server anyway.
//  R6. The read model writes into the root.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repo, stub, artifacts, freePort, startServer, waitFor } from "./helpers.mjs";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hd-readmodel-")));
const root = join(dir, "root");
const log = join(dir, "stub.log");
const old = "2026-10-01T12:00:00Z";
const young = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z");

function w(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function rec(slug, id, fields) {
  const lines = Object.entries({ id, created: old, updated: old, ...fields }).map(([k, v]) =>
    `${k} = ${typeof v === "string" ? JSON.stringify(v) : v}`);
  w(join(root, slug, "threads", `${id}.toml`), lines.join("\n") + "\n");
}

function buildRoot() {
  const alpha = join(root, "alpha");
  w(join(alpha, "PROJECT.md"), '+++\nname = "Alpha Project"\ngoal = "Ship the alpha thing"\nmax_parallel_threads = 4\n+++\n\nInstructions.\n');
  w(join(dir, "sock"), "");
  w(join(alpha, ".state", "coordinator.json"), JSON.stringify({ socket: join(dir, "sock"), cwd: alpha, pane_id: "w1Z:p1", workspace_id: "w1Z", tab_id: "w1Z:t1" }));
  const base = { kind: "worktree", cwd: "/x", agent: "claude", status: "open" };
  rec("alpha", "t-0001", { ...base, title: "Widget pipeline", pane_id: "w1A:p1", tab_id: "w1A:t1", workspace_id: "w1A", last_state: "working", last_state_change: old, percent: 40, activity: "Testing changes" });
  rec("alpha", "t-0002", { ...base, title: "Needs approval", pane_id: "w1B:p1", last_state: "blocked", last_state_change: old });
  rec("alpha", "t-0003", { ...base, title: "Report in, pane gone", pane_id: "w9:p9", report_hash: "aa", acked_report_hash: "aa" });
  rec("alpha", "t-0004", { ...base, title: "Merged", status: "resolved", resolved_reason: "merged" });
  rec("alpha", "t-0005", { ...base, title: "Just started", status: "starting", prompt_pending: true, created: young });
  rec("alpha", "t-0006", { ...base, title: "Unread report", pane_id: "w2A:p1", report_hash: "r6" });
  w(join(alpha, "threads", "t-0006.md"), "## Report\n\nDone.\n\n## Next\n\n- Merge the PR\n1. Remove the worktree\n");
  w(join(alpha, "threads", "t-0006.next.md"), "- Coordinator's own line\n");
  // beta: nobody works in it and it has no record: session unreachable.
  w(join(root, "beta", "PROJECT.md"), '+++\nname = "Beta"\n+++\n');
  rec("beta", "t-0001", { title: "Recorded working", status: "open", last_group: "working" });
  // gamma: archived, so not listed.
  w(join(root, "gamma", "PROJECT.md"), "+++\n+++\n");
  w(join(root, "gamma", ".state", "project.json"), '{"status":"archived"}');
  rec("gamma", "t-0001", { title: "Hidden", status: "open" });
}

function treeSig(p) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const f = join(d, n);
      const s = statSync(f);
      out.push(`${f} ${s.size} ${s.mtimeMs}`);
      if (s.isDirectory()) walk(f);
    }
  };
  walk(p);
  return out.join("\n");
}

// The Rust binary to compare with, or null.
function rustBinary() {
  const candidates = [process.env.HP_RUST_BIN];
  const plugins = join(homedir(), ".config/herdr/plugins");
  if (existsSync(plugins)) {
    for (const host of readdirSync(plugins)) {
      for (const p of existsSync(join(plugins, host)) ? readdirSync(join(plugins, host)) : []) {
        if (p.startsWith("herdr-projects-")) candidates.push(join(plugins, host, p, "target/release/herdr-projects"));
      }
    }
  }
  for (const c of candidates) {
    if (!c || !existsSync(c)) continue;
    const v = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (v.status === 0 && v.stdout.startsWith("herdr-projects 0.2.35")) return { path: c, version: v.stdout.trim() };
  }
  return null;
}

// Only what herdr-projects decides (groups, notes, counts, Next lines).
function picture(state) {
  return {
    projects: state.projects.map((p) => ({ slug: p.slug, status: p.status, summary: p.summary, counts: p.counts, error: p.error ?? "" })),
    threads: state.threads.map((t) => ({ key: t.key, title: t.title, group: t.group, note: t.note, next: t.next, kind: t.kind, pane_id: t.pane_id, percent: t.percent })),
  };
}

async function serve(mode, hp) {
  const port = await freePort();
  writeFileSync(log, "");
  const env = { HERDR_BIN_PATH: join(stub, "herdr"), HOME: dir };
  if (hp) env.HERDR_DASH_HERDR_PROJECTS = hp;
  const proc = startServer(port, log, ["--root", root, "--read-model", mode, "--threads-every", "1s"], env);
  const url = `http://127.0.0.1:${port}`;
  try {
    const state = await waitFor(async () => {
      const s = await (await fetch(url + "/api/state")).json();
      return s.threads.length >= 7 && s.projects.length >= 2 ? s : null;
    }, 20_000);
    return { state, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  } finally {
    proc.kill();
  }
}

let goRun, cliRun, rust;
const sigBefore = () => treeSig(root);
let before0;

before(async () => {
  buildRoot();
  before0 = sigBefore();
  rust = rustBinary();
  goRun = await serve("go");
  if (rust) cliRun = await serve("cli", rust.path);
});

after(() => {
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "readmodel.json"), JSON.stringify({
    rust: rust?.version ?? "not found: only the Go side was checked",
    go: goRun && picture(goRun.state),
    same_as_cli: cliRun ? JSON.stringify(picture(cliRun.state)) === JSON.stringify(picture(goRun.state)) : null,
  }, null, 2));
  rmSync(dir, { recursive: true, force: true });
});

test("R1: go mode never runs herdr-projects", () => {
  const hp = goRun.calls.filter((l) => l.startsWith("herdr-projects "));
  assert.deepEqual(hp, []);
  assert.ok(goRun.calls.some((l) => l.startsWith("herdr agent list")), "the read model asks herdr for agents");
});

test("R2/R3/R4: groups, notes, counts and Next lines", () => {
  const p = picture(goRun.state);
  const by = Object.fromEntries(p.threads.map((t) => [t.key, t]));
  assert.equal(by["alpha/t-0001"].group, "Working");
  assert.equal(by["alpha/t-0002"].group, "Waiting on you");
  assert.equal(by["alpha/t-0003"].note, "pane closed");
  assert.equal(by["alpha/t-0004"].group, "Resolved");
  assert.equal(by["alpha/t-0005"].group, "Working");
  assert.equal(by["alpha/t-0006"].group, "Ready for review");
  assert.deepEqual(by["alpha/t-0006"].next, ["Merge the PR", "Remove the worktree", "Coordinator's own line"]);
  assert.equal(by["beta/t-0001"].note, "session unreachable");
  assert.ok(!p.projects.some((x) => x.slug === "gamma"), "archived projects are not listed");
  const alpha = p.projects.find((x) => x.slug === "alpha");
  assert.equal(alpha.summary, "Waiting on you: 1, Ready for review: 1, Working: 2, Idle: 1, Resolved: 1");
});

test("R2/R3: the same picture as herdr-projects 0.2.35", { skip: rust ? false : "no herdr-projects 0.2.35 binary (HP_RUST_BIN)" }, () => {
  assert.deepEqual(picture(goRun.state), picture(cliRun.state));
});

test("R5: a bad --read-model is refused", () => {
  const r = spawnSync(join(repo, "bin/herdr-dash"), ["--read-model", "rust", "--root", root], { encoding: "utf8", timeout: 10_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--read-model "rust"/);
});

test("R6: nothing under the root changed", () => {
  assert.equal(sigBefore(), before0);
});
