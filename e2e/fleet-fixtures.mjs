// A generated fake fleet of 30 fictional projects for the Master window's
// E2E: a herdr-projects root (PROJECT.md, .state/coordinators.json, inbox),
// a copy of the stubs serving `list`, `thread list` and `pane list` for it,
// a fleet.toml with a priority project, and the agent processes for a fake
// /proc. Every project is in a known state, so the test can assert the
// table, the chips and the Attention ranking exactly. Every name is made up.
import { mkdirSync, writeFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stub } from "./helpers.mjs";

export const NAMES = [
  "aurora-ledger", "birch-notes", "cobalt-relay", "delta-forge", "ember-cache", "fjord-sync",
  "garnet-api", "harbor-ui", "iris-index", "jade-queue", "kestrel-ml", "lumen-docs",
  "maple-auth", "nimbus-ops", "onyx-search", "pebble-cli", "quartz-billing", "raven-mail",
  "saffron-shop", "tundra-maps", "umber-chat", "vega-metrics", "willow-forms", "xenon-build",
  "yarrow-crm", "zephyr-feeds", "amber-wiki", "basalt-etl", "cedar-sdk", "dune-player",
];
const title = (slug) => slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const iso = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const M = 60, H = 3600, D = 86400;

// Each project: status, coordinator (state + seconds since its last
// activity, or null for none), threads as [state, extra] pairs. Thread
// states: working waiting blocked review (unacked) acked (review, report
// acked) landing idle resolved failed stuck.
export const SPEC = {
  "aurora-ledger": { coord: ["blocked", 20 * M], threads: [["working"], ["idle"]] },
  "birch-notes": { coord: ["waiting", 40 * M], threads: [["waiting", { ago: 3 * H }], ["waiting", { ago: 2 * H }], ["working"]] },
  "cobalt-relay": { coord: ["idle", 2 * H], threads: [["failed", { error: "agent name already used" }], ["failed", { error: "agent name already used" }], ["working"]] },
  "delta-forge": { coord: ["working", 5 * M], threads: [["blocked", { ago: 50 * M }], ["working"], ["working"]] },
  "ember-cache": { coord: null, threads: [["working"], ["idle"]] },
  "fjord-sync": { coord: ["exited", 6 * H], threads: [["idle"]] },
  "garnet-api": { coord: ["idle", 30 * M], priority: true, threads: [["waiting", { ago: 10 * M }], ["working"]] },
  "harbor-ui": { coord: ["idle", 1 * H], threads: [["stuck"], ["working"]] },
  "iris-index": { coord: ["idle", 3 * H], threads: [...Array(24)].map((_, i) => ["review", { ago: (i + 1) * H }]).concat([["acked"], ["acked"]]) },
  "jade-queue": { coord: ["idle", 4 * H], threads: [...Array(12)].map((_, i) => ["review", { ago: (i + 2) * D }]) },
  "kestrel-ml": { status: "paused", coord: null, threads: [["idle"]] },
  "lumen-docs": { status: "archived", coord: null, threads: [] },
  "maple-auth": { coord: ["working", 2 * M], threads: [["working"], ["landing"], ["review"]] },
};
// The other 17: quiet projects, alternating idle and working coordinators.
NAMES.forEach((slug, i) => {
  if (SPEC[slug]) return;
  const k = i % 4;
  SPEC[slug] = {
    coord: [k === 0 ? "working" : "idle", (i + 1) * 7 * M],
    threads: k === 0 ? [["working"], ["idle"], ["resolved"]] : k === 1 ? [["idle"], ["resolved"]] : k === 2 ? [["working"]] : [],
  };
});

// What the Attention list must say first, in order (see ranking in
// internal/fleet): coordinator blocked, coordinator waiting, threads
// blocked, threads waiting (the priority project first), repeated launch
// failures, stuck launch, missing coordinator with work, exited coordinator
// with work, then the review piles, biggest first.
export const ATTENTION = [
  ["aurora-ledger", "coordinator-blocked"],
  ["birch-notes", "coordinator-waiting"],
  ["delta-forge", "threads-blocked"],
  ["garnet-api", "threads-waiting"],
  ["birch-notes", "threads-waiting"],
  ["cobalt-relay", "launch-failed"],
  ["harbor-ui", "launch-stuck"],
  ["ember-cache", "coordinator-missing"],
  ["fjord-sync", "coordinator-exited"],
  ["iris-index", "review-pile"],
  ["jade-queue", "review-pile"],
];

const GROUP = { working: ["working", "Working"], waiting: ["waiting-on-you", "Waiting on you"], blocked: ["waiting-on-you", "Waiting on you"],
  review: ["ready-for-review", "Ready for review"], acked: ["ready-for-review", "Ready for review"], landing: ["landing", "Landing"],
  idle: ["idle", "Idle"], resolved: ["resolved", "Resolved"], failed: ["idle", "Idle"], stuck: ["working", "Working"] };

// The fleet's opt-outs (stage 1b): one read-only project (standing in for a
// production one) and one opted out of bulk actions.
export const MODES = { "tundra-maps": "read-only", "umber-chat": "off" };

// fleetTomlText is the fixture's fleet.toml; limits overrides [limits]. The
// E2E raises actions_per_minute so many batches can run in one minute; the
// rate-limit test lowers it.
export function fleetTomlText(limits = { actions_per_minute: 1000 }, extra = "") {
  const lim = Object.entries(limits).map(([k, v]) => `${k} = ${v}`).join("\n");
  const proj = NAMES.filter((s) => SPEC[s].priority || MODES[s]).map((slug) =>
    `[projects.${slug}]\n` + (SPEC[slug].priority ? "priority = true\n" : "") + (MODES[slug] ? `mode = "${MODES[slug]}"\n` : "")).join("\n");
  return `version = 1\n${extra}\n[limits]\n${lim}\n\n${proj}`;
}

// fleet() writes the whole fleet to a temp dir: { tmp, root, stubDir, log,
// panesFile, fleetToml, procs: [[pid, comm, {cpu, rss, env}]] }.
export function fleet() {
  const tmp = mkdtempSync(join(tmpdir(), "dash-fleet-"));
  const root = join(tmp, "root"), stubDir = join(tmp, "stub"), log = join(tmp, "calls"), proc = join(tmp, "proc");
  cpSync(stub, stubDir, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(proc, { recursive: true });
  writeFileSync(log, "");
  const panes = [], list = [], procs = [];
  let pid = 1000;
  NAMES.forEach((slug, n) => {
    const s = SPEC[slug], ws = `f${String(n).padStart(2, "0")}`;
    const dir = join(root, slug);
    mkdirSync(join(dir, ".state"), { recursive: true });
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeFileSync(join(dir, "PROJECT.md"), `+++\nname = "${title(slug)}"\ngoal = "Fictional project ${n + 1}"\ncoordinator_profile = "claude"\nthread_profile = "claude"\nmax_parallel_threads = 4\n+++\n\n# Instructions\n`);
    if (s.coord) {
      const [cs, ago] = s.coord, pane = `${ws}:c1`;
      writeFileSync(join(dir, ".state/coordinators.json"), JSON.stringify([{ pane_id: pane, tab_id: `${ws}:t0`, agent: "claude", state_change_seq: 1, pair_since: iso(ago), agent_session: "" }]));
      const p = { agent: "claude", agent_status: { blocked: "blocked", working: "working", waiting: "idle", idle: "idle", exited: "unknown" }[cs], cwd: "/fleet/" + slug, pane_id: pane, tab_id: `${ws}:t0`, workspace_id: ws,
        tokens: { hp_project: slug, hp_sub: cs === "waiting" ? "needs you · ~40%" : cs === "working" ? "working · ~50%" : "idle" } };
      if (cs === "exited") delete p.agent;
      panes.push(p);
      if (cs !== "exited") procs.push([pid++, "claude", { cpu: 0.05, rss: 300e6, env: { HERDR_PANE_ID: pane } }]);
    }
    const threads = s.threads.map(([st, x = {}], i) => {
      const id = `t-${String(i + 1).padStart(4, "0")}`, pane = `${ws}:p${i + 1}`;
      const [tok, group] = GROUP[st];
      const ago = x.ago ?? (i + 1) * 11 * M;
      const t = {
        id, title: `${title(slug)} task ${i + 1}`, status: st === "resolved" ? "resolved" : st === "failed" ? "failed" : "open", group, group_token: tok, last_state: tok,
        pane_id: ["failed", "resolved"].includes(st) ? "" : pane, tab_id: `${ws}:t${i + 1}`, workspace_id: ws, agent: "claude", pr: "", pr_state: "",
        branch: `hp/${slug}/${id}`, origin: "", activity: st === "waiting" ? "Waiting for you" : st === "working" ? "Writing code" : "", percent: st === "working" ? 40 : 0,
        kind: "worktree", created: iso(ago + H), updated: iso(ago), last_state_change: iso(ago), last_report_change: "", next: [], note: "", state_line: "",
        machine: "", agent_name: `hp-${slug}-${id}`, resolved_reason: "", report_hash: ["review", "acked", "landing"].includes(st) ? "h" + i : "",
        acked_report_hash: st === "acked" ? "h" + i : "", repo: "/fleet/repos/" + slug, cwd: "", profile: "claude", thread_dir: "",
        prompt_pending: st === "stuck" || st === "failed", launch_attempts: st === "failed" ? 3 : st === "stuck" ? 1 : 0, launched_at: "",
        brief_stuck: st === "stuck", error: x.error || "",
      };
      if (t.pane_id) {
        panes.push({ agent: "claude", agent_status: { working: "working", blocked: "blocked", stuck: "idle" }[st] || "idle", cwd: "/fleet/wt", pane_id: pane, tab_id: t.tab_id, workspace_id: ws });
        if (st === "working") procs.push([pid++, "claude", { cpu: 0.25, rss: 500e6, env: { HERDR_PANE_ID: pane } }]);
      }
      return t;
    });
    writeFileSync(join(stubDir, `thread-list-${slug}.json`), JSON.stringify(threads));
    const counts = {};
    for (const t of threads) counts[t.group] = (counts[t.group] || 0) + 1;
    list.push(`${slug}\t${s.status || "active"}\t${Object.entries(counts).map(([g, c]) => `${g}: ${c}`).join(", ")}`);
    // A few unhandled inbox items in the review piles' projects.
    if (slug === "iris-index") for (let i = 0; i < 3; i++) writeFileSync(join(dir, "inbox", `20261101T00000${i}Z-thread-state-t-000${i + 1}-${i}.md`), `+++\nid = "x${i}"\nkind = "thread-state"\nsubject = "t-000${i + 1}"\ncreated = "${iso(H)}"\nsummary = 'new report'\nevent = "new report"\n+++\n`);
  });
  writeFileSync(join(stubDir, "list.tsv"), list.join("\n") + "\n");
  const panesFile = join(tmp, "panes.json");
  writeFileSync(panesFile, JSON.stringify({ id: "cli:pane:list", result: { panes } }));
  const fleetToml = join(tmp, "fleet.toml");
  writeFileSync(fleetToml, fleetTomlText());
  return { tmp, root, stubDir, log, proc, panesFile, fleetToml, procs };
}
