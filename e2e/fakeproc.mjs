// A fake /proc tree for the System strip and the Master window: the
// server's --proc reads it, so every CPU share and RSS is known.
import { mkdirSync, writeFileSync, rmSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";

export const GiB = 1024 ** 3;
export const PAGE = 4096;

// A fake /proc: counters advance with real time at the configured rates, so
// the server's deltas see the CPU share each core or process is set to.
export class FakeProc {
  constructor(dir) {
    this.dir = dir;
    this.cores = [0.97, 0.5, 0.1, 0.02]; // busy share per core
    this.cpu = this.cores.map(() => ({ user: 1000, system: 500, idle: 100000 }));
    this.mem = { total: 16 * GiB, avail: 3 * GiB }; // 81% used: warning
    this.swap = { total: 4 * GiB, free: 4 * GiB - 0.2 * GiB };
    this.load = "3.10 2.05 1.50 4/321 9999";
    this.osrelease = "6.6.0-microsoft-standard-WSL2";
    this.procs = new Map();
    this.last = Date.now();
    this.frozen = false;
    mkdirSync(join(dir, "sys/kernel"), { recursive: true });
  }
  add(pid, comm, { ppid = 1, cpu = 0, rss = 0, env = null, unreadable = false } = {}) {
    this.procs.set(pid, { comm, ppid, share: cpu, ticks: 5000, rss, env, unreadable });
  }
  remove(pid) {
    this.procs.delete(pid);
    rmSync(join(this.dir, String(pid)), { recursive: true, force: true });
  }
  advance() {
    const now = Date.now();
    const t = this.frozen ? 0 : ((now - this.last) / 1000) * 100; // USER_HZ
    this.last = now;
    this.cpu.forEach((c, i) => { c.user += this.cores[i] * t; c.idle += (1 - this.cores[i]) * t; });
    for (const p of this.procs.values()) p.ticks += p.share * t;
    this.write();
  }
  write() {
    const line = (n, c) => `${n} ${Math.round(c.user)} 0 ${Math.round(c.system)} ${Math.round(c.idle)} 0 0 0 0 0 0`;
    const tot = this.cpu.reduce((a, c) => ({ user: a.user + c.user, system: a.system + c.system, idle: a.idle + c.idle }), { user: 0, system: 0, idle: 0 });
    this.put("stat", [line("cpu ", tot), ...this.cpu.map((c, i) => line(`cpu${i}`, c)), "intr 0", "ctxt 0", "btime 0", ""].join("\n"));
    const kb = (b) => Math.round(b / 1024);
    this.put("meminfo", `MemTotal: ${kb(this.mem.total)} kB\nMemFree: 1000 kB\nMemAvailable: ${kb(this.mem.avail)} kB\nBuffers: 0 kB\nSwapTotal: ${kb(this.swap.total)} kB\nSwapFree: ${kb(this.swap.free)} kB\n`);
    this.put("loadavg", this.load + "\n");
    this.put("sys/kernel/osrelease", this.osrelease + "\n");
    for (const [pid, p] of this.procs) {
      const d = join(this.dir, String(pid));
      mkdirSync(d, { recursive: true });
      // Fields after comm: state ppid pgrp session tty tpgid flags minflt
      // cminflt majflt cmajflt utime stime cutime cstime prio nice threads
      // itreal starttime vsize rss ...
      const u = Math.round(p.ticks * 0.8), s = Math.round(p.ticks * 0.2);
      this.put(`${pid}/stat`, `${pid} (${p.comm}) S ${p.ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 ${u} ${s} 0 0 20 0 1 0 ${1000 + pid} 1000000 ${Math.round(p.rss / PAGE)} 0 0 0\n`);
      const envPath = join(d, "environ");
      if (p.unreadable) { try { chmodSync(envPath, 0o600); } catch {} }
      if (p.env) this.put(`${pid}/environ`, Object.entries({ PATH: "/usr/bin", ...p.env }).map(([k, v]) => `${k}=${v}\0`).join(""));
      else this.put(`${pid}/environ`, "PATH=/usr/bin\0");
      if (p.unreadable) chmodSync(envPath, 0o000);
    }
  }
  put(rel, text) {
    const p = join(this.dir, rel);
    writeFileSync(p + ".tmp", text);
    renameSync(p + ".tmp", p); // whole files, as /proc reads are
  }
}
