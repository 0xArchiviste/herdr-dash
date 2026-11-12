// Fixtures for the Agent filter E2E (agent-filter.test.mjs): two projects
// whose threads and coordinators run several harnesses and models, one
// thread whose live agent differs from the one herdr-projects recorded, and
// a fake /proc so the Landscape's CPU and RAM are known. Fictional data only.
import { mkdtempSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { td, stub } from "./helpers.mjs";

const iso = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");

function thread(slug, id, title, o) {
  return {
    id, title, group_token: o.group, group: o.group, last_state: o.live || "idle", pane_id: o.pane || "", tab_id: o.pane ? o.pane.replace(":p", ":t") : "",
    workspace_id: o.pane ? o.pane.split(":")[0] : "", agent: o.agent, pr: "", pr_state: "", branch: `hp/${slug}/${id}`, origin: `https://github.com/acme/${slug}.git`,
    status: o.group === "resolved" ? "resolved" : "open", activity: o.activity || "", percent: 30, kind: "worktree", created: iso(7200), updated: iso(600),
    last_state_change: iso(600), last_report_change: "", next: [], note: "", state_line: "", machine: "", agent_name: `hp-${slug}-${id}`, resolved_reason: "",
    report_hash: "", acked_report_hash: "", repo: `/fixture/repos/${slug}`, cwd: `/fixture/wt/${slug}-${id}`, profile: o.profile || "", thread_dir: "",
  };
}

// What each thread runs. live: the pane's agent and status (herdr's view);
// agent/profile: what herdr-projects recorded at launch.
export const THREADS = {
  alpha: [
    thread("alpha", "t-0101", "Opus pipeline", { group: "working", agent: "claude", profile: "claude", pane: "wA1:p1", live: "working" }),
    thread("alpha", "t-0102", "Sol refactor", { group: "idle", agent: "codex", profile: "codex", pane: "wA2:p1", live: "idle" }),
    // Recorded as codex, but claude runs in its pane now: shown as claude, marked.
    thread("alpha", "t-0103", "Swapped harness", { group: "working", agent: "codex", profile: "codex", pane: "wA3:p1", live: "working" }),
    thread("alpha", "t-0104", "Old claude work", { group: "resolved", agent: "claude", profile: "claude" }),
  ],
  beta: [
    thread("beta", "t-0201", "Flash docs", { group: "waiting-on-you", agent: "opencode", profile: "opencode", pane: "wB1:p1", live: "idle", activity: "Waiting for you" }),
    thread("beta", "t-0202", "GLM sweep", { group: "working", agent: "opencode", profile: "opencode-glm", pane: "wB2:p1", live: "working" }),
    thread("beta", "t-0203", "Sonnet notes", { group: "idle", agent: "claude", profile: "claude-sonnet", pane: "wB3:p1", live: "idle" }),
    thread("beta", "t-0204", "Grok probe", { group: "idle", agent: "grok", profile: "", pane: "wB4:p1", live: "idle" }),
  ],
};

const pane = (id, agent, status, tokens) => ({ agent, agent_status: status, cwd: tokens ? "/projects/" + tokens.hp_project : "/x", pane_id: id, tab_id: id.replace(":p", ":t"), workspace_id: id.split(":")[0], ...(tokens ? { tokens } : {}) });
export const PANES = [
  pane("wA1:p1", "claude", "working"),
  pane("wA2:p1", "codex", "idle"),
  pane("wA3:p1", "claude", "working"),
  pane("wB1:p1", "opencode", "idle"),
  pane("wB2:p1", "opencode", "working"),
  pane("wB3:p1", "claude", "idle"),
  pane("wB4:p1", "grok", "idle"),
  // The coordinators: alpha's claude (needs you), beta's codex (blocked).
  pane("w1Z:p1", "claude", "done", { hp_group: "alpha!0!w1Z:p1", hp_project: "alpha", hp_rank: "1", hp_sub: "needs you" }),
  pane("w2Z:p1", "codex", "blocked", { hp_group: "beta!0!w2Z:p1", hp_project: "beta", hp_rank: "1", hp_sub: "needs you" }),
];

export const PROFILES = `[profiles.claude]
agent = "claude"
model = "claude-opus-5-5"
[profiles.claude-sonnet]
agent = "claude"
model = "claude-sonnet-5-5"
[profiles.codex]
agent = "codex"
model = "gpt-6.1-sol"
[profiles.opencode]
agent = "opencode"
model = "gateway/qwen3.8-flash"
[profiles.opencode-glm]
agent = "opencode"
model = "gateway/glm53"
`;

// The options the filter must offer, with active threads and coordinators.
// key -> { threads, coords, projects, working, waiting, idle }
export const LANDSCAPE = {
  claude: { threads: 3, coords: 1, projects: 2, working: 2, waiting: 0, idle: 1 },
  "claude:opus-5-5": { threads: 1, coords: 1, projects: 1, working: 1, waiting: 0, idle: 0 },
  "claude:sonnet-5-5": { threads: 1, coords: 0, projects: 1, working: 0, waiting: 0, idle: 1 },
  codex: { threads: 1, coords: 1, projects: 2, working: 0, waiting: 0, idle: 1 },
  "codex:gpt-6.1-sol": { threads: 1, coords: 0, projects: 1, working: 0, waiting: 0, idle: 1 },
  opencode: { threads: 2, coords: 0, projects: 1, working: 1, waiting: 1, idle: 0 },
  "opencode:qwen3.8-flash": { threads: 1, coords: 0, projects: 1, working: 0, waiting: 1, idle: 0 },
  "opencode:glm53": { threads: 1, coords: 0, projects: 1, working: 1, waiting: 0, idle: 0 },
  grok: { threads: 1, coords: 0, projects: 1, working: 0, waiting: 0, idle: 1 },
};
// Open thread keys per harness (the effective, observed-first agent).
export const BY_AGENT = {
  claude: ["alpha/t-0101", "alpha/t-0103", "beta/t-0203"],
  codex: ["alpha/t-0102"],
  opencode: ["beta/t-0201", "beta/t-0202"],
  grok: ["beta/t-0204"],
};
export const COORDS = { claude: ["alpha"], codex: ["beta"] };

export function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "dash-agents-"));
  const root = join(tmp, "root"), stubDir = join(tmp, "stub"), log = join(tmp, "calls"), proc = join(tmp, "proc");
  cpSync(join(td, "root"), root, { recursive: true });
  cpSync(stub, stubDir, { recursive: true });
  for (const [slug, ts] of Object.entries(THREADS)) writeFileSync(join(stubDir, `thread-list-${slug}.json`), JSON.stringify(ts));
  writeFileSync(join(stubDir, "panes.json"), JSON.stringify({ id: "cli:pane:list", result: { panes: PANES } }));
  writeFileSync(join(tmp, "profiles.toml"), PROFILES);
  writeFileSync(log, "");
  mkdirSync(proc);
  return { tmp, root, stubDir, log, proc, profiles: join(tmp, "profiles.toml") };
}
