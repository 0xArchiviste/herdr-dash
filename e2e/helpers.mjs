// Shared E2E helpers: start the real herdr-dash binary against the fixtures
// with stubbed herdr-projects / herdr / gh.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

export const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, "..");
export const td = join(repo, "testdata");
export const stub = join(td, "stub");
export const artifacts = join(here, "artifacts");

export function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

// startServer runs bin/herdr-dash on port. Cloudflare settings never leak in
// from the caller's environment: only `env` sets them.
export function startServer(port, stubLog, extra = [], env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(CLOUDFLARE_|HERDR_DASH_)/.test(k)) delete base[k];
  return spawn(join(repo, "bin/herdr-dash"), [
    "--root", join(td, "root"),
    "--herdr", join(stub, "herdr"),
    "--gh", join(stub, "gh"),
    "--claude-dir", join(td, "claude"),
    "--codex-dir", join(td, "codex"),
    "--poll", "1s",
    ...extra,
  ], {
    env: { ...base, STUB_LOG: stubLog, HERDR_DASH_ADDR: `127.0.0.1:${port}`, HERDR_DASH_HERDR_PROJECTS: join(stub, "herdr-projects"), ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

export async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw last ?? new Error("timed out");
}

export async function post(url, path, body, headers = {}) {
  const r = await fetch(url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// Stub-log lines since mark(), without the read-only polling.
export function stubLogger(path) {
  const lines = () => readFileSync(path, "utf8").split("\n").filter(Boolean);
  return {
    lines,
    mark: () => lines().length,
    since: (m) => lines().slice(m).filter((l) => !/ (list|pane read|pr list|progress --pane|safety show)( |$)/.test(l)),
  };
}
