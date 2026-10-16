# Session details

Every thread and project coordinator panel displays provider, model, effort,
and context-window capacity. `/api/state` includes the same `session` object on
threads and coordinators. Each field identifies its source: session, profile,
harness configuration, or unknown. OpenCode variants are labeled explicitly.

| Harness | Observed session fields | Configured fallbacks |
| --- | --- | --- |
| Codex | `session_meta.model_provider`, latest `turn_context.model` / `effort`, `token_count.info.model_context_window` | Selected herdr-projects profile, then user `config.toml` model, provider, reasoning effort |
| Claude Code | Latest nonsynthetic assistant `message.model`, `perTurnEffort` (then `effort`) | Selected herdr-projects profile, then user `settings.json` model / effortLevel |
| OpenCode | Selected session's latest SQLite message modelID / providerID; matching latest user selection's variant | Selected herdr-projects profile's provider/model and effort; user OpenCode model and exact provider/model limit.context metadata |

Profile selection uses the thread's recorded profile, then the project's
thread/coordinator profile setting, then herdr-projects' global default. A
profile for a different live harness is never used as a fallback. Resolved
threads display configured fallbacks rather than a potentially reused pane.
A coordinator without an identified pane displays its configured profile.

Configuration values are explicitly labeled as fallbacks: CLI overrides,
project configuration, environment, and interactive changes can make actual
runtime values differ. Claude provider routing is unknown without runtime
metadata; a Claude model name does not establish the provider. Missing fields
remain unknown. No remote provider calls or model-name capacity estimates are
used. Token usage and plan limits are never presented as context-window size.
A Codex configured capacity is shown only with its configured model, and never
attached to a session-observed model.

`--session-profiles` selects the herdr-projects TOML configuration (default:
`~/.config/herdr-projects/config.toml`). `--claude-dir` and `--codex-dir` locate
transcripts; harness configuration is read from their parent directories.
`--opencode-db` selects the OpenCode database (default:
`~/.local/share/opencode/opencode.db`). OpenCode inspection requires the optional
`sqlite3` executable, uses read-only mode and a one-second timeout, and caches
metadata for five seconds. Missing tools, databases, inaccessible sessions, or
unsupported schemas leave fields unknown. OpenCode capacity requires explicit matching model metadata in the user config;
Claude capacity is currently unsupported by these local sources.

Transcript reads cache by file size and modification time. Large transcripts
read at most a 64 KiB metadata prefix and a 4 MiB recent tail; older settings
outside that tail may be unknown. A Codex model switch clears earlier capacity
until a new capacity event arrives. Only allow-listed metadata reaches the API;
message contents, credentials, and transcript paths are excluded.

Run `make check` to reproduce parser, API and browser verification. The session
E2E produces `e2e/artifacts/session-*.png` at desktop, narrow, and phone widths,
and `session-state.json` with the resulting fixture API state.
