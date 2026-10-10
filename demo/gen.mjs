// Generates the fictional demo dataset (data/, root/, screens/, claude/) next
// to this file. Edit the projects below, then: node demo/gen.mjs
// Every name, org, path and number here is made up; e2e/demo.test.mjs
// checks that nothing real slips in.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const out = dirname(fileURLToPath(import.meta.url));
for (const d of ["data", "root", "screens", "claude"]) rmSync(join(out, d), { recursive: true, force: true });
const w = (p, s) => { mkdirSync(join(out, p, ".."), { recursive: true }); writeFileSync(join(out, p), s); };
const ORG = "acme-labs";
const H = 60, D = 24 * 60;

// ------------------------------------------------------------ screens
const box = (lines, width = 62) => {
  const top = "╭" + "─".repeat(width) + "╮", bot = "╰" + "─".repeat(width) + "╯";
  return [top, ...lines.map((l) => "│ " + l.padEnd(width - 1) + "│"), bot].join("\n");
};
const prompt = box([">"]) + "\n  ⏵⏵ accept edits on (shift+tab to cycle)";
const claudeWorking = (steps, spinner) => steps.join("\n\n") + `\n\n✻ ${spinner}… ({ELAPSED} · ↓ {TOKENS}k tokens · esc to interrupt)\n\n` + prompt;
const claudeBlocked = (steps, kind, cmd, why, again) => steps.join("\n\n") + "\n\n" + box([
  kind, "", "  " + cmd, "  " + why, "", "Do you want to proceed?",
  "❯ 1. Yes", "  2. " + again, "  3. No, and tell Claude what to do differently (esc)",
]);
const claudeIdle = (steps) => steps.join("\n\n") + "\n\n" + prompt;
const codexWorking = (steps, spinner) => steps.join("\n\n") + `\n\n▌ ${spinner} ({ELAPSED} • Esc to interrupt)\n\n▌ Ask Codex to do anything\n  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit`;
const codexIdle = (steps) => steps.join("\n\n") + `\n\n▌ Ask Codex to do anything\n  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit`;

// ------------------------------------------------------------ projects
// state: working waiting blocked review landing idle resolved
const projects = [
  {
    slug: "nebula-api", name: "Nebula API", goal: "Ship the v2 public API: cursor pagination, rate limits and an OpenAPI 3.1 spec",
    coord: { status: "working", sub: "working · ~55%", activity: "Reviewing PRs", percent: 55 },
    threads: [
      { title: "Cursor pagination for /invoices", state: "working", agent: "claude", ago: 1, created: 3 * H, percent: 60, activity: "Testing changes",
        task: "Replace offset pagination on `GET /v2/invoices` with opaque cursors.\n\n- Cursor encodes `(created_at, id)`, base64url\n- `limit` capped at 200\n- Keep `?page=` working for v1 clients\n\n## Done when\n\n- Contract tests for both styles pass\n- OpenAPI spec updated",
        next: ["Wire the cursor into the SDK generator", "Remove ?page= after v1 sunset"],
        screen: claudeWorking(["● Read(src/routes/invoices.ts)\n  ⎿  Read 214 lines", "● Update(src/routes/invoices.ts)\n  ⎿  Updated src/routes/invoices.ts with 18 additions\n     and 4 removals", "● Bash(npm test -- invoices)\n  ⎿  PASS  test/invoices.test.ts (4.2 s)\n     ✓ paginates with an opaque cursor (38 ms)\n     ✓ rejects a malformed cursor (5 ms)\n     ✓ keeps ?page= for v1 clients (12 ms)\n     … +11 lines (ctrl+r to expand)"], "Running the contract suite") },
      { title: "Rate limiting middleware", state: "blocked", agent: "claude", ago: 4, created: 5 * H, percent: 70, activity: "Waiting for you",
        task: "Add a token-bucket rate limiter in front of every `/v2` route, keyed by API key, backed by Redis.\n\nReturn `429` with `Retry-After` and the `RateLimit-*` headers.",
        report: "## Report\n\nLimiter is in and unit tests pass. It needs the staging Redis to run the load test, which needs your OK.\n\n## Next\n- Approve the staging load test",
        next: ["Approve the staging load test"],
        screen: claudeBlocked(["● Update(src/middleware/ratelimit.ts)\n  ⎿  Updated with 64 additions", "● Bash(npm test -- ratelimit)\n  ⎿  PASS  12 tests"], "Bash command", "k6 run load/ratelimit.js --env TARGET=staging", "Load-test the limiter against staging Redis", "Yes, and don't ask again for k6 commands") },
      { title: "OpenAPI 3.1 spec generation", state: "review", agent: "codex", ago: 50, created: 9 * H, percent: 100, activity: "Done", pr: 142,
        task: "Generate `openapi.yaml` from the route schemas at build time and publish it at `/v2/openapi.json`.",
        report: "PR: https://github.com/acme-labs/nebula-api/pull/142\n\n## Report\n\n### OpenAPI 3.1 from route schemas\n\n- `npm run spec` writes `openapi.yaml`; CI fails if it drifts\n- Served at `/v2/openapi.json` with an ETag\n- 41 routes covered, 0 hand-written schemas left\n\n## Next\n- Review and merge the PR\n- Point the docs site at the new spec",
        next: ["Review and merge the PR", "Point the docs site at the new spec"] },
      { title: "Deprecate v1 /users endpoints", state: "waiting", agent: "claude", ago: 22, created: 26 * H, percent: 40, activity: "Waiting for you",
        task: "Add `Deprecation` and `Sunset` headers to every v1 `/users` route and draft the customer notice.",
        report: "## Report\n\nHeaders are in. One question before I write the notice: should the sunset date be **2027-03-31** (6 months) or **2027-06-30** (9 months, matches the enterprise contract)?\n\n## Next\n- Pick the sunset date",
        next: ["Pick the sunset date"],
        screen: claudeIdle(["● Update(src/v1/users.ts)\n  ⎿  Added Deprecation + Sunset headers", "● Which sunset date should the notice use?\n\n  1. 2027-03-31 (six months)\n  2. 2027-06-30 (matches the enterprise contract)\n\n  I'll draft the customer notice once you pick."]) },
      { title: "Fix N+1 query in /projects listing", state: "landing", agent: "claude", ago: 95, created: 2 * D, percent: 100, activity: "Done", pr: 139,
        task: "`GET /v2/projects` runs one query per project for owners. Batch it.",
        report: "PR: https://github.com/acme-labs/nebula-api/pull/139\n\n## Report\n\nOne `IN` query instead of N; p95 from 410 ms to 38 ms on the seed data. Approved, waiting for the merge queue.\n\n## Next\n- Merge when CI is green",
        next: ["Merge when CI is green"] },
      { title: "Request ID propagation", state: "resolved", agent: "claude", ago: 3 * D, created: 4 * D, percent: 100, activity: "Done", pr: 131,
        task: "Propagate `X-Request-Id` into logs and downstream calls.", report: "## Report\n\nMerged in #131.", next: [] },
      { title: "Idempotency keys for POST /charges", state: "working", agent: "codex", ago: 2, created: 70, percent: 25, activity: "Reading code",
        task: "Accept an `Idempotency-Key` header on `POST /v2/charges`; replay the stored response for 24h.",
        next: [],
        screen: codexWorking(["• Explored\n  └ Read src/routes/charges.ts, src/db/schema.sql\n    Search Idempotency in src", "• Proposed plan\n  └ □ add idempotency_keys table\n    □ middleware: lookup, lock, store response\n    □ tests for replay + conflicting body"], "Working") },
    ],
  },
  {
    slug: "pixel-forge", name: "Pixel Forge", goal: "GPU image pipeline: AVIF/WebP output, smart crops and a 3x faster tiler",
    coord: { status: "idle", sub: "idle", activity: "Idle", percent: null },
    threads: [
      { title: "AVIF encoder support", state: "working", agent: "claude", ago: 0, created: 2 * H, percent: 45, activity: "Writing code",
        task: "Add AVIF output via libavif with a quality knob matching the WebP one.",
        next: [],
        screen: claudeWorking(["● Write(src/encode/avif.rs)\n  ⎿  Wrote 132 lines to src/encode/avif.rs", "● Bash(cargo build --release)\n  ⎿     Compiling pixel-forge v0.9.0\n        Finished `release` profile in 41.2s", "● Bash(./bench.sh avif)\n  ⎿  avif q=60  1.84 MB/s  ssim 0.981\n     webp q=75  3.10 MB/s  ssim 0.976"], "Tuning encoder speed") },
      { title: "Smart crop with saliency map", state: "review", agent: "claude", ago: 3 * H, created: 1 * D, percent: 100, activity: "Done", pr: 88, acked: true,
        task: "Crop to the most salient region instead of the center.",
        report: "PR: https://github.com/acme-labs/pixel-forge/pull/88\n\n## Report\n\nSaliency via a small ONNX model (1.2 MB). On the 500-image eval set, 87% of crops keep the subject vs 61% for center crop.\n\n## Next\n- Merge the PR",
        next: ["Merge the PR"] },
      { title: "Tiler rewrite (rayon)", state: "blocked", agent: "claude", ago: 9, created: 7 * H, percent: 80, activity: "Waiting for you",
        task: "Rewrite the tiler on rayon; target 3x on 8 cores.",
        report: "## Report\n\n2.9x on 8 cores. It wants to delete the old tiler module, which needs your OK.\n\n## Next\n- Approve removing src/tiler_legacy/",
        next: ["Approve removing src/tiler_legacy/"],
        screen: claudeBlocked(["● Bash(cargo bench -- tiler)\n  ⎿  tiler/rayon   time: [118.2 ms 119.0 ms 119.9 ms]\n     tiler/legacy  time: [342.7 ms 344.1 ms 345.8 ms]"], "Bash command", "git rm -r src/tiler_legacy/", "Remove the legacy tiler now that rayon is 2.9x faster", "Yes, and don't ask again for git rm commands") },
      { title: "EXIF orientation bug on iOS uploads", state: "resolved", agent: "codex", ago: 2 * D, created: 3 * D, percent: 100, activity: "Done", pr: 84,
        task: "Rotated photos from iOS come out sideways.", report: "## Report\n\nFixed in #84.", next: [] },
      { title: "Benchmark harness in CI", state: "idle", agent: "opencode", ago: 2 * D + 5 * H, created: 3 * D, percent: 30, activity: "Paused",
        task: "Run `cargo bench` on every PR and comment the diff.", next: ["Decide on a runner with a stable CPU"] },
    ],
  },
  {
    slug: "docs-site", name: "Docs Site", goal: "Move docs to Astro with versioned API reference and full-text search",
    coord: { status: "working", sub: "working · ~70%", activity: "Planning threads", percent: 70 },
    threads: [
      { title: "Migrate to Astro Starlight", state: "review", agent: "claude", ago: 35, created: 2 * D, percent: 100, activity: "Done", pr: 57,
        task: "Port the Docusaurus site to Astro Starlight, keep every URL.",
        report: "PR: https://github.com/acme-labs/docs-site/pull/57\n\n## Report\n\n- 214 pages ported, 0 broken links (lychee)\n- Redirect map for the 9 renamed pages\n- Lighthouse 100/100/100/100\n\n## Next\n- Review the preview deploy\n- Merge the PR",
        next: ["Review the preview deploy", "Merge the PR"] },
      { title: "Versioned API reference", state: "working", agent: "claude", ago: 3, created: 4 * H, percent: 55, activity: "Writing code",
        task: "Render the Nebula OpenAPI spec per version (v1, v2) with a version switcher.",
        next: [],
        screen: claudeWorking(["● Bash(npm run build)\n  ⎿  ✓ 231 page(s) built in 18.4s", "● Read(src/components/VersionSwitch.astro)\n  ⎿  Read 58 lines", "● Update(src/components/VersionSwitch.astro)\n  ⎿  Updated with 22 additions and 9 removals"], "Building the v1 reference") },
      { title: "Algolia → Pagefind search", state: "waiting", agent: "codex", ago: 2 * H, created: 1 * D, percent: 60, activity: "Waiting for you",
        task: "Replace Algolia with Pagefind so search works offline and costs nothing.",
        report: "## Report\n\nPagefind index is 1.1 MB for the whole site. Should search cover the API reference pages too? It doubles the index.\n\n## Next\n- Decide whether to index the API reference",
        next: ["Decide whether to index the API reference"],
        screen: codexIdle(["• Ran npx pagefind --site dist\n  └ Indexed 214 pages, 18,402 words, 1.1 MB", "Question: include the API reference pages in the index?\nIt doubles the index size (2.3 MB)."]) },
      { title: "Fix dark mode code blocks", state: "landing", agent: "claude", ago: 4 * H, created: 1 * D, percent: 100, activity: "Done", pr: 55,
        task: "Code blocks are unreadable in dark mode.", report: "PR: https://github.com/acme-labs/docs-site/pull/55\n\n## Report\n\nSwitched to Shiki dual themes. Approved.", next: ["Merge the PR"] },
      { title: "Typo sweep", state: "resolved", agent: "claude", ago: 5 * D, created: 5 * D, percent: 100, activity: "Done", pr: 49,
        task: "Run a spell-check over all pages.", report: "## Report\n\n63 typos fixed in #49.", next: [] },
    ],
  },
  {
    slug: "payments-svc", name: "Payments Service", goal: "Ledger-backed payments with SCA, refunds and daily reconciliation",
    coord: { status: "idle", sub: "needs you · ~60%", activity: "Waiting for you", percent: 60 },
    threads: [
      { title: "Ledger index migration", state: "blocked", agent: "claude", ago: 1, created: 3 * H, percent: 65, activity: "Waiting for you",
        task: "Add a covering index for ledger lookups by `(account_id, posted_at)`; run it concurrently on staging first.",
        report: "## Report\n\nMigration is written and passes locally. Running it on staging needs your OK.\n\n## Next\n- Approve the staging migration",
        next: ["Approve the staging migration"],
        screen: claudeBlocked(["● Write(migrations/0042_ledger_index.sql)\n  ⎿  Wrote 6 lines", "● Bash(make test-migrations)\n  ⎿  ok  0042_ledger_index (0.8s)"], "Bash command", "psql \"$STAGING_DB_URL\" -f migrations/0042_ledger_index.sql", "Apply the ledger index migration to staging", "Yes, and don't ask again for psql commands") },
      { title: "3-D Secure 2 challenge flow", state: "working", agent: "claude", ago: 2, created: 6 * H, percent: 75, activity: "Testing changes",
        task: "Support SCA challenges for EU cards end to end.",
        next: [],
        screen: claudeWorking(["● Bash(go test ./internal/sca/...)\n  ⎿  ok   payments/internal/sca        2.114s\n     ok   payments/internal/sca/acs    0.902s", "● Update(internal/sca/challenge.go)\n  ⎿  Updated with 31 additions and 12 removals"], "Running the sandbox card matrix") },
      { title: "Partial refunds", state: "review", agent: "codex", ago: 80, created: 1 * D, percent: 100, activity: "Done", pr: 311,
        task: "Allow refunding part of a charge, multiple times, up to the captured amount.",
        report: "PR: https://github.com/acme-labs/payments-svc/pull/311\n\n## Report\n\n- `POST /refunds` takes an `amount`\n- Ledger entries balance to zero across 10k fuzzed sequences\n\n## Next\n- Review and merge the PR",
        next: ["Review and merge the PR"] },
      { title: "Daily reconciliation report", state: "waiting", agent: "claude", ago: 40, created: 2 * D, percent: 50, activity: "Waiting for you",
        task: "Email finance a daily CSV of settled vs ledger totals.",
        report: "## Report\n\nCSV is ready. Which address should it go to? There is no finance alias in the config.\n\n## Next\n- Give the finance email alias",
        next: ["Give the finance email alias"],
        screen: claudeIdle(["● The CSV generator is done (cmd/recon).", "● Which address should receive the daily report?\n  There is no finance alias in config/recon.yaml yet."]) },
      { title: "Webhook signature v2", state: "landing", agent: "claude", ago: 2 * H, created: 2 * D, percent: 100, activity: "Done", pr: 308,
        task: "Sign webhooks with HMAC-SHA256 and a timestamp.", report: "PR: https://github.com/acme-labs/payments-svc/pull/308\n\n## Report\n\nApproved; landing after the partner heads-up.", next: ["Merge after Monday's partner email"] },
      { title: "PCI scope review notes", state: "resolved", agent: "claude", ago: 6 * D, created: 7 * D, percent: 100, activity: "Done",
        task: "Write down what is in PCI scope.", report: "## Report\n\nNotes in docs/pci-scope.md.", next: [] },
      { title: "Currency rounding audit", state: "idle", agent: "codex", ago: 1 * D + 3 * H, created: 2 * D, percent: 20, activity: "Paused",
        task: "Audit every place that rounds money.", next: ["Resume after partial refunds lands"] },
    ],
  },
  {
    slug: "ml-pipeline", name: "ML Pipeline", goal: "Nightly training on fresh data, tracked experiments and one-click rollback",
    coord: { status: "working", sub: "working · ~40%", activity: "Starting threads", percent: 40 },
    threads: [
      { title: "Feature store backfill", state: "working", agent: "codex", ago: 1, created: 5 * H, percent: 35, activity: "Running backfill",
        task: "Backfill 90 days of features into the new store.",
        next: [],
        screen: codexWorking(["• Ran python -m pipeline.backfill --days 90 --dry-run\n  └ 90 partitions, 41.2M rows, est. 38 min", "• Ran python -m pipeline.backfill --days 90\n  └ [=========>          ] 41/90 partitions"], "Working") },
      { title: "Experiment tracking with MLflow", state: "review", agent: "claude", ago: 5 * H, created: 2 * D, percent: 100, activity: "Done", pr: 23,
        task: "Log params, metrics and artifacts of every training run.",
        report: "PR: https://github.com/acme-labs/ml-pipeline/pull/23\n\n## Report\n\nEvery run logs to MLflow; the nightly job tags the winner.\n\n## Next\n- Merge the PR",
        next: ["Merge the PR"] },
      { title: "GPU node pool for training", state: "blocked", agent: "opencode", ago: 15, created: 4 * H, percent: 50, activity: "Waiting for you",
        task: "Add an autoscaling GPU node pool (0–4 nodes) for the training jobs.",
        report: "## Report\n\nTerraform plan is clean: +1 node pool, 0 changes elsewhere. Applying it needs your OK.",
        next: ["Approve terraform apply"],
        screen: "$ terraform plan -out tf.plan\n\nPlan: 1 to add, 0 to change, 0 to destroy.\n\n" + box(["Permission required", "", "  terraform apply tf.plan", "  Create the gpu-training node pool (0–4 x L4)", "", "Do you want to proceed?", "❯ 1. Allow once", "  2. Allow always", "  3. Reject"]) },
      { title: "Model card template", state: "idle", agent: "claude", ago: 3 * D, created: 4 * D, percent: 10, activity: "Paused",
        task: "Template for model cards.", next: [] },
      { title: "Drift alerts", state: "working", agent: "claude", ago: 5, created: 2 * H, percent: 20, activity: "Reading code",
        task: "Alert when feature distributions drift (PSI > 0.2).",
        next: [],
        screen: claudeWorking(["● Search(pattern: \"psi|population stability\", path: \"pipeline/\")\n  ⎿  Found 3 files", "● Read(pipeline/monitoring/metrics.py)\n  ⎿  Read 143 lines"], "Reading the monitoring code") },
      { title: "Pin CUDA base image", state: "resolved", agent: "codex", ago: 4 * D, created: 4 * D, percent: 100, activity: "Done", pr: 19,
        task: "Pin the CUDA base image digest.", report: "## Report\n\nPinned in #19.", next: [] },
    ],
  },
  {
    slug: "mobile-app", name: "Mobile App", goal: "Offline-first React Native app with push and a 2-second cold start",
    coord: { status: "blocked", sub: "needs you", activity: "Waiting for you", percent: null },
    threads: [
      { title: "Offline sync queue", state: "working", agent: "claude", ago: 0, created: 4 * H, percent: 70, activity: "Testing changes",
        task: "Queue writes while offline and replay them in order when back online.",
        next: [],
        screen: claudeWorking(["● Bash(npx jest sync)\n  ⎿  PASS  src/sync/queue.test.ts\n     ✓ replays in order after reconnect (22 ms)\n     ✓ drops a write the server rejected (9 ms)\n     ✓ survives an app restart (31 ms)", "● Update(src/sync/queue.ts)\n  ⎿  Updated with 12 additions and 3 removals"], "Running the Detox flow") },
      { title: "Push notification opt-in screen", state: "review", agent: "claude", ago: 2 * H, created: 1 * D, percent: 100, activity: "Done", pr: 402,
        task: "Ask for push permission after the first completed task, not on launch.",
        report: "PR: https://github.com/acme-labs/mobile-app/pull/402\n\n## Report\n\nOpt-in screen after the first completed task; screenshots for iOS and Android in the PR.\n\n## Next\n- Review the screenshots\n- Merge the PR",
        next: ["Review the screenshots", "Merge the PR"] },
      { title: "Cold start under 2s", state: "waiting", agent: "codex", ago: 1 * H, created: 1 * D, percent: 55, activity: "Waiting for you",
        task: "Get the Android cold start under 2 s on a mid-range device.",
        report: "## Report\n\nHermes + lazy screens: 2.6 s → 1.9 s. Going further means dropping the animated splash. OK to drop it?\n\n## Next\n- Decide on the animated splash",
        next: ["Decide on the animated splash"],
        screen: codexIdle(["• Ran ./scripts/coldstart.sh --device pixel-6a\n  └ median 1.91 s (n=20), was 2.62 s", "Dropping the animated splash saves another ~250 ms.\nShould I drop it?"]) },
      { title: "Dark theme polish", state: "review", agent: "claude", ago: 1 * D, created: 2 * D, percent: 100, activity: "Done", pr: 398, acked: true,
        task: "Fix contrast issues in dark mode.", report: "PR: https://github.com/acme-labs/mobile-app/pull/398\n\n## Report\n\nAll screens pass WCAG AA.", next: ["Merge the PR"] },
      { title: "Crash on Android 15 share sheet", state: "resolved", agent: "claude", ago: 2 * D, created: 2 * D, percent: 100, activity: "Done", pr: 395,
        task: "Crash when sharing from the gallery.", report: "## Report\n\nFixed in #395.", next: [] },
    ],
  },
  {
    slug: "infra-ops", name: "Infra Ops", goal: "Boring, cheap, observable infrastructure",
    coord: null,
    threads: [
      { title: "Rotate TLS certificates", state: "resolved", agent: "claude", ago: 6 * D, created: 6 * D, percent: 100, activity: "Done",
        task: "Rotate the wildcard certificate.", report: "## Report\n\nRotated; expiry alerts added.", next: [] },
      { title: "Grafana dashboards as code", state: "resolved", agent: "codex", ago: 5 * D, created: 6 * D, percent: 100, activity: "Done", pr: 77,
        task: "Move dashboards to Jsonnet.", report: "## Report\n\nMerged in #77.", next: [] },
    ],
  },
];

// ------------------------------------------------------------ build
const token = { working: "working", waiting: "waiting-on-you", blocked: "waiting-on-you", review: "ready-for-review", landing: "landing", idle: "idle", resolved: "resolved" };
const group = { working: "Working", "waiting-on-you": "Waiting on you", "ready-for-review": "Ready for review", landing: "Landing", idle: "Idle", resolved: "Resolved" };
const paneStatus = { working: "working", waiting: "idle", blocked: "blocked", review: "done", landing: "idle", idle: "idle" };
const at = (m) => `@-${m}m`;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28).replace(/-$/, "");
const panes = [];
const list = [];
let sess = 0;
const uuid = () => `00000000-0000-4000-8000-${(++sess).toString(16).padStart(12, "0")}`;

projects.forEach((p, pi) => {
  const ws = `w${pi + 3}${"KMQRTVX"[pi]}`;
  const dir = `root/${p.slug}`;
  const repo = `https://github.com/${ORG}/${p.slug}.git`;
  const profile = pi % 3 === 1 ? "codex" : "claude";
  w(`${dir}/PROJECT.md`, `+++\nname = "${p.name}"\ngoal = "${p.goal}"\ncoordinator_profile = "claude"\nthread_profile = "${profile}"\nmax_parallel_threads = ${pi % 2 ? 3 : 4}\nauto_resolve_days = 7\nnudge = true\nmute = false\n\n[[repos]]\npath = "/home/demo/src/${p.slug}"\norigin = "${repo}"\n+++\n\n# Instructions\n\nWork on a branch per change and open a draft PR. Run the test suite before reporting done.\n`);
  const counts = {};
  const rows = p.threads.map((t, i) => {
    const id = `t-${String(i + 1).padStart(4, "0")}`;
    const tok = token[t.state];
    counts[group[tok]] = (counts[group[tok]] || 0) + 1;
    const live = t.state !== "resolved";
    const pane = `${ws}:p${i + 2}`, tab = `${ws}:t${i + 2}`;
    const branch = t.state === "idle" && !t.pr ? "" : `hp/${p.slug}/${id}-${slugify(t.title)}`;
    if (live) panes.push({ agent: t.agent, agent_status: paneStatus[t.state], cwd: `/home/demo/.herdr/worktrees/${p.slug}/${id}`, pane_id: pane, tab_id: tab, workspace_id: ws });
    w(`${dir}/threads/${id}.task.md`, t.task + "\n");
    if (t.report) w(`${dir}/threads/${id}.md`, t.report + "\n");
    if (t.screen) w(`screens/${pane.replace(":", "_")}.txt`, t.screen + "\n");
    const hash = t.report && (t.state === "review" || t.state === "landing") ? `demo-${p.slug}-${id}` : "";
    return {
      id, title: t.title, group_token: tok, group: group[tok], last_state: t.state === "working" ? "working" : t.state === "blocked" ? "blocked" : t.state === "review" ? "done" : "idle",
      pane_id: pane, tab_id: tab, workspace_id: ws, agent: t.agent, profile: t.agent,
      pr: t.pr ? `https://github.com/${ORG}/${p.slug}/pull/${t.pr}` : "",
      pr_state: t.pr ? (t.state === "resolved" ? "MERGED" : "OPEN") : "", pr_review: t.state === "landing" ? "APPROVED" : "",
      branch, origin: repo, status: t.state === "resolved" ? "resolved" : "open",
      activity: t.activity, percent: t.percent, kind: "worktree",
      created: at(t.created), updated: at(t.ago), last_state_change: at(t.ago), last_report_change: t.report ? at(t.ago) : "",
      next: t.next, note: "", state_line: "", error: "", machine: "", agent_name: `hp-${p.slug}-${id}`,
      resolved_reason: t.state === "resolved" ? "merged" : "", report_hash: hash, acked_report_hash: t.acked ? hash : "",
      worktree_path: "",
    };
  });
  w(`data/thread-list-${p.slug}.json`, JSON.stringify(rows, null, 1) + "\n");
  list.push(`${p.slug}\tactive\t${Object.entries(counts).sort((a, b) => Object.values(group).indexOf(a[0]) - Object.values(group).indexOf(b[0])).map(([k, v]) => `${k}: ${v}`).join(", ")}`);

  // Tasks, memory, inbox, coordinator.
  const open = rows.filter((r) => r.status === "open");
  w(`${dir}/TASKS.md`, `# Tasks\n\n## Doing\n${open.filter((r) => r.group_token === "working").map((r) => `- [ ] ${r.title} (${r.id})`).join("\n") || "- [ ] (nothing running)"}\n\n## Review\n${open.filter((r) => /ready|landing/.test(r.group_token)).map((r) => `- [ ] ${r.title} (${r.id}, PR)`).join("\n") || "- [ ] (nothing to review)"}\n\n## Backlog\n- [ ] Tidy the README\n- [ ] Bump dependencies\n`);
  w(`${dir}/MEMORY.md`, `# Memory\n\n- [Conventions](memory/conventions.md): branch names, PR style, test command\n- [Decisions](memory/decisions.md): what the user decided and why\n`);
  open.filter((r) => r.group_token === "waiting-on-you").forEach((r, k) => w(`${dir}/inbox/20261010T0${k}0000Z-thread-state-${r.id}-${k}.md`, `---\nkind: thread-state\n---\n${r.id} needs you\n`));
  if (p.coord) {
    const pane = `${ws}:p1`, s = uuid();
    const tokens = { hp_group: `${p.slug}!0!${pane}`, hp_project: p.slug, hp_rank: "1", hp_sub: p.coord.sub };
    panes.push({ agent: "claude", agent_session: { agent: "claude", kind: "id", value: s }, agent_status: p.coord.status, cwd: `/home/demo/.herdr-projects/${p.slug}`, pane_id: pane, tab_id: `${ws}:t1`, workspace_id: ws, tokens });
    w(`${dir}/.state/coordinators.json`, JSON.stringify([{ pane_id: pane, tab_id: `${ws}:t1`, workspace_id: ws, name: `hpc-${p.slug}`, agent: "claude", agent_status: p.coord.status, state_change_seq: 7, pair_since: "2026-10-09T08:00:00Z", agent_session: s }], null, 1) + "\n");
    w(`claude/-home-demo--herdr-projects-${p.slug}/${s}.jsonl`, "{}\n");
    if (p.coord.percent != null || p.coord.activity) w(`data/progress-${pane.replace(":", "_")}.json`, JSON.stringify({ pane_id: pane, agent: "claude", activity: p.coord.activity, percent: p.coord.percent, reported_at: "@now" }, null, 1).replace('"@now"', "@now") + "\n");
    const working = open.filter((r) => r.group_token === "working");
    const waiting = open.filter((r) => r.group_token === "waiting-on-you");
    const review = open.filter((r) => r.group_token === "ready-for-review");
    const listed = `● Bash(herdr-projects thread list ${p.slug})\n  ⎿  ${open.length} open: ${working.length} working, ${waiting.length} waiting on you,\n     ${review.length} ready for review`;
    const pr = open.find((r) => r.pr && r.group_token === "ready-for-review");
    const prStep = pr ? [`● Bash(gh pr view ${pr.pr.split("/").pop()} --repo ${ORG}/${p.slug})\n  ⎿  ${pr.title}\n     checks: 7/7 passing · review: pending`] : [];
    let coordScreen;
    if (p.coord.status === "blocked") {
      coordScreen = claudeBlocked(["● Read(TASKS.md)\n  ⎿  Read 14 lines", "● The backlog has a release checklist item. Starting a thread for it."], "Bash command", `herdr-projects thread start ${p.slug} --title "Release checklist"`, "Start a worktree thread for the release checklist", "Yes, and don't ask again for herdr-projects commands");
    } else if (p.coord.sub.startsWith("needs you")) {
      coordScreen = claudeIdle([listed, ...prStep, `● Over to you:\n${waiting.map((r) => `  - ${r.id} ${r.title}: ${r.next[0] || "needs an answer"}`).join("\n")}${pr ? `\n  - PR #${pr.pr.split("/").pop()} is green and ready to merge` : ""}`]);
    } else if (p.coord.status === "working") {
      coordScreen = claudeWorking([listed, ...prStep, `● ${working.length} thread(s) moving. Checking reports as they land.`], p.coord.activity);
    } else {
      coordScreen = claudeIdle([listed, "● All quiet: nothing needs a decision right now."]);
    }
    w(`screens/${pane.replace(":", "_")}.txt`, coordScreen + "\n");
  }
});
w("data/list.tsv", list.join("\n") + "\n");
w("data/panes.json", JSON.stringify({ id: "cli:pane:list", result: { panes } }) + "\n");
w("data/safety.txt", `Safety settings (yours; no agent may change them):\n  yolo                     off   [built-in]\n  start_threads            ask   [built-in]\n  trust_screens            ask   [built-in]\n  coordinator_agent_args   (none)   [built-in]\n  thread_agent_args        (none)   [built-in]\n  routine_commands         off   [built-in]\n`);
console.log(list.join("\n"));
console.log("threads:", projects.reduce((a, p) => a + p.threads.length, 0));
