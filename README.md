# herdr-dash

Animated web dashboard of every herdr project and thread on this machine:
what is moving, done, stuck, or waiting on you, with a few triage and chat
actions.

- Graph: projects are hubs, threads are nodes. Green pulse = working, amber
  glow = waiting on you, red = blocked, blue = ready for review, cyan =
  landing (PR approved), tan = idle, gray = resolved. Bigger = more recent.
- "Needs you" strip grouped by severity (blocked, waiting, review, landing)
  with counts; groups collapse. Filters (project, state, time window,
  search), and a side panel with task, Next list, PR/branch, copyable jump
  commands and the latest report (sanitized markdown, folded to one line).
  Times are in the viewer's time zone.
- Clicking a project hub opens its coordinator panel: status, goal and
  settings, safety summary, the coordinator's pane, live status and own
  progress line, its live screen and a chat box, the open threads, the
  threads' latest reports (newest first), TASKS.md, the MEMORY.md index and
  the inbox count. Coordinators that are blocked, or that herdr-projects
  marks "needs you", show in the Needs-you strip too.
- Live over SSE; one shared collector, no file watchers.

## Actions

Every write goes through `herdr-projects`, never raw `herdr agent` commands,
so its refusals (blocked agent, text in the input box, trust screens) apply.

| In the page | Runs |
| --- | --- |
| Chat: send a follow-up | `thread prompt SLUG ID --text-file -` (text on stdin) |
| Chat: quick replies / typed answer when the pane is blocked | `thread keys SLUG ID KEY... [--text=TEXT]` |
| Next list: Send | `thread next SLUG ID --line N` |
| Ack, Ack selected, Ack all review (per project / age) | `thread ack SLUG ID` |
| Resolve (after a confirm dialog) | `thread resolve SLUG ID` |
| Coordinator panel: chat | `coordinator prompt SLUG --text-file -` |

- Chat shows the pane's screen, streamed over SSE (every 3s, every 0.7s for
  15s after a send), pinned to the newest line unless you scroll up. The
  coordinator chat is send-only: herdr-projects has no key command for
  coordinators, so a blocked one is answered in its pane. `agent_blocked` and `prompt_unconfirmed` are shown, not
  retried; an unconfirmed prompt gets a manual "Press Enter" button.
- Snooze (1 day) is per browser (localStorage). The strip hides acked and
  snoozed threads by default; its filter shows all or only those.
- Server side: POST with a JSON body only, same-origin, slug/id/keys/line
  validated (keys: `enter esc up down left right tab space backspace y n 0-9`,
  no ctrl chords), text length and control characters checked, one write at
  a time, a token bucket (`--write-burst` 10, `--write-per-min` 30), and every
  action logged. `--read-only` turns all of it off.

## Voice

Dictation into every chat box and voice navigation, both optional
(`static/voice.js`). Press `?` for the keys and commands; the ⚙ button sets
the keys (stored per browser).

- Dictation: a mic next to each chat box, or `Alt+M` (toggle, or hold to
  talk), writes into the box with the live interim transcript shown under it.
  It never sends.
- Voice navigation: `Alt+V` or the floating mic (bottom left, also on phones).
  "open nebula api", "show thread 27 in kaiba cord", "show blocked / waiting /
  review", "next / previous", "search widget", "close panel", "focus chat",
  "dock bottom / left / right", "help", "stop listening". "ack this",
  "resolve this" and "send" ask yes/no first (by voice or click).
- Commands are resolved in the page by a small grammar with fuzzy matching
  against project and thread names. Only phrases it cannot place go to the
  server, which asks a Cloudflare Workers AI decision model
  (`@cf/cloudflare/clef-flash`) to pick one of the page's candidate actions or
  "none" (1.5s timeout, cached, rate limited).
- Speech: the browser's Web Speech API where it exists (Chrome and Edge send
  the audio to Google or Microsoft; Safari may recognize on the device).
  Without it (Firefox), or when chosen in settings, the clip is recorded,
  posted to the server and transcribed by Workers AI Whisper
  (`@cf/openai/whisper-large-v3-turbo`).
- The microphone needs HTTPS (or localhost). On a tailnet, e.g.
  `tailscale serve --bg --https=8793 http://127.0.0.1:8791`.

Server side (env only, it holds a secret; both features are off without it):
`CLOUDFLARE_API_TOKEN` (Workers AI permission), `CLOUDFLARE_ACCOUNT_ID`,
`HERDR_DASH_INTENT_MODEL` and `HERDR_DASH_STT_MODEL` (a model id, or `off`).
The token is only sent to Cloudflare, never to the page.

## Content search

The search box has two modes; the button next to it or **Alt+C** switches
(remembered per browser), **/** focuses it.

- **Title**: filters the graph by thread titles as you type, in the page.
- **Content**: finds threads by what was said or done in them: their task,
  report and Next files, a project's `PROJECT.md`, `TASKS.md` and
  `MEMORY.md`, and, when `memex` is
  installed, agent transcripts and memories. Results list the thread or
  project, the source, the time and a highlighted snippet; matching nodes
  light up in the graph and a click opens the panel.

Content search runs only on Enter or after a 400 ms pause with 3+ characters.
The file index lives in memory and is refreshed by mtime on search, never in
the background. memex runs lexical searches only (`memex search
--non-interactive --mode lexical`), one process at a time (a newer search
cancels the older one), with a 2 s limit, a per-query cache and a rate limit.
Transcript hits are mapped to threads by the live pane's session, then by
working directory (a thread's worktree or folder, a project folder); hits
from a project's repo show under the project, others are dropped. Pages and
add-ons can call `hd.search(text, { mode: "content" | "title" })`.

`--memex` / `HERDR_DASH_MEMEX` names the binary (default `memex` on `PATH`;
`off` disables; missing means off), `--memex-timeout` (2s) and
`--memex-per-min` (30) bound it. Note that `memex search` itself ingests new
transcripts unless `auto_index_on_search = false` is set in
`~/.memex/config.toml`.

## Data sources (reads)

| Source | Used for | Cadence |
| --- | --- | --- |
| `herdr-projects --root R list` | projects, counts | 15s |
| `herdr-projects --root R thread list SLUG --json` | threads, group, activity, PR | 15s (5m for all-resolved projects) |
| `PROJECT.md` front matter | project name, goal | with the list |
| `herdr pane list` | live agent status, session id | 5s |
| `~/.claude/projects/*/ID.jsonl`, `~/.codex/sessions/Y/M/D/*ID.jsonl` mtime | last activity | 5s (stat only, paths cached) |
| `herdr pane read PANE --source recent --lines 40` | screen (not `visible`: that is the pane's viewport, which misses the newest lines when the pane is scrolled up) | while a panel is open: 3s, 0.7s after a send |
| `.state/coordinators.json`, `.state/coordinator.json` | coordinator pane: a listed pane still in `herdr pane list` with the same session, else the recorded pane if it still runs in the project folder; otherwise "no live pane" | with the list |
| `herdr pane list` tokens (`hp_sub`) | coordinator "needs you" | 5s |
| `herdr-projects --root R progress --pane PANE` | coordinator progress line | coordinator panel open: 10s |
| `herdr-projects --root R safety show SLUG` | safety summary | coordinator panel open, cached 1m |
| `TASKS.md`, `MEMORY.md`, `inbox/*.md`, `threads/t-NNNN.md` | coordinator panel | coordinator panel open: 10s |
| `threads/t-NNNN.md`, `.task.md` | report, task | on panel open |
| `gh pr list --repo R --state all` | PRs herdr-projects has not recorded yet | 10m, only repos with such threads |

The state colors follow herdr-projects' own grouping (`group_token`), split
into blocked vs waiting by the live pane status.

## Run

    make build && ./bin/herdr-dash     # http://127.0.0.1:8791

It listens on `127.0.0.1:8791` by default. It has no authentication and shows
task text, reports and pane screens and can prompt agents, so only use `--addr 0.0.0.0:8791` on a
trusted network (e.g. a tailnet). `--herdr-projects` defaults to
`herdr-projects` on `PATH`, else the herdr plugin build under
`~/.config/herdr/plugins/`.

Flags: `--addr`, `--root`, `--herdr-projects`, `--herdr`, `--gh`, `--claude-dir`,
`--codex-dir`, `--poll`, `--threads-every`, `--quiet-every`, `--gh-every`,
`--read-only`, `--write-burst`, `--write-per-min`, `--memex`,
`--memex-timeout`, `--memex-per-min`, `--auth` (placeholder:
only `none` exists; the network is trusted).

Environment defaults (a flag wins): `HERDR_DASH_ADDR`, `HERDR_DASH_ROOT`
(then `HERDR_PROJECTS_ROOT`), `HERDR_DASH_HERDR_PROJECTS`, `HERDR_DASH_AUTH`,
`HERDR_DASH_READ_ONLY`, `HERDR_DASH_MEMEX`.

## Install as a systemd --user service

    make install     # copies to ~/.local/bin, installs deploy/herdr-dash.service, enables + restarts

Extra flags go in `~/.config/herdr-dash/env`, e.g.
`HERDR_DASH_ARGS=--addr 0.0.0.0:8791`, and so do the voice settings
(`CLOUDFLARE_API_TOKEN=...`; keep the file mode 600). Logs: `journalctl --user -u herdr-dash -f`. Needs lingering
(`loginctl enable-linger $USER`) to start without a login session. The unit
caps CPU at 25% and memory at 256M.

## Test

    make check

Runs `go vet`, `node --check`, and the Playwright E2E in `e2e/` against the
fixtures in `testdata/` with stubbed `herdr-projects`, `herdr` and `gh`. It
asserts the API, sanitization, SSE, the page (graph, strip, panel, filters,
phone layout), the exact `herdr-projects` command each action runs, that
injection attempts, GET, non-JSON and cross-origin writes are refused, the
rate limit, and that nothing outside the allow-list ran. `e2e/voice.test.mjs`
drives voice with a mocked `SpeechRecognition`, Chromium's fake microphone
and a fake Workers AI: dictation, the commands, the confirmations, the
intent fallback and that the token never reaches the page. Screenshots and the API
snapshot land in `e2e/artifacts/`. `node e2e/screenshot.mjs URL DIR`
screenshots a running instance.
