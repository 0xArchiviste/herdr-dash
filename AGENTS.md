# AGENTS.md: herdr-dash

Animated web dashboard showing progress across all herdr projects and threads, with allow-listed triage/chat actions through herdr-projects.

Test command: `make check` (go vet + `node --check` + Playwright E2E in `e2e/` against `testdata/` fixtures with stubbed herdr-projects/herdr/gh; artifacts in `e2e/artifacts/`).

## Shared herdr SDLC — PR merging and agentic testing

Pull requests, tests-before-done, local-first gates and conflict resolution. Only the test command above is project-specific.

### PR merging

1. **Pull requests only.** Branch per change. Never commit or push to `main`. Never force-push `main`. Open a PR and return the URL; **do not merge unless asked**. When the PR fully completes an issue, put `Fixes #N` or `Closes #N` in the PR body so merge closes it. Do not `gh issue close` from a feature branch.
2. **Draft until merge-ready.** Keep in-progress PRs as drafts while implementation or review fixes continue. Mark ready for review only when scope and docs are complete, the branch is committed and clean, `origin/main` is merged, open-PR conflicts are resolved, and local tests are green. If more code is needed after ready, convert back to draft **before pushing**. Never merge because draft/partial checks or local tests alone passed when a required CI lane was skipped.
3. **Resolve PR conflicts on the feature branch.** List every open PR against `main` (`gh pr list --state open --base main --json number,title,headRefName,mergeable,mergeStateStatus,files`). Compare planned files with every open PR before branching, editing a shared file, or push. If any is `CONFLICTING` / `DIRTY` with `main`, merge `origin/main` into that feature branch — not only the PR this session already has open. Keep both sides' intended behavior. Do not rebase unless asked. Do not resolve shared doc hubs by concatenating both sides (duplicate headings or table rows).
4. **Concise PR text.** Never itemize passed checks, commands, counts, or routine evidence in PR bodies or comments. Keep PR text concise and reviewer-relevant. Mention validation only when a failure, omission, or unusual manual verification materially affects review or merge safety.

### Agentic testing

5. **Tests before done.**
   - NEVER write unit tests after you write code.
   - Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
   - If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.

   Integration tests stay for core parts that connect other core parts and other mission-critical paths. Run local tests **first**. CI is confirmation, not the first gate.
6. **Local-first gate.** Before push/PR, run: `make check`. Do not wait for GitHub Actions to find a failure you could have caught locally.
7. **Resolve failing tests before proceeding.** If local tests or CI go red, stop other planned work and fix the failure best-effort on the feature branch. Read the log. Do not skip or quarantine a required test to make a gate green. Superfluous tests may be deleted deliberately when they are not the proof for a core connection or a safety invariant. Do not start the next plan todo or PR while a required check is red.
