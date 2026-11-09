// A fake /proc tree for the System strip and the Master window: the
// server's --proc reads it, so every CPU share and RSS is known.
import { mkdirSync, writeFileSync, rmSync, chmodSync, renameSync, symlinkSync } from "node:fs";
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
    // The Memory map's extras: page cache, PSI, boot time (process ages).
    this.cache = { cached: 2 * GiB, buffers: 0.25 * GiB, sreclaimable: 0.25 * GiB, shmem: 0.1 * GiB };
    this.psi = "some avg10=12.50 avg60=4.00 avg300=1.00 total=123456\nfull avg10=3.25 avg60=1.00 avg300=0.25 total=4567\n";
    this.btime = Math.floor(Date.now() / 1000) - 7200;
    this.procs = new Map();
    this.last = Date.now();
    this.frozen = false;
    mkdirSync(join(dir, "sys/kernel"), { recursive: true });
  }
  // pss: bytes in smaps_rollup (none: no file, as for another user's
  // process); cwd: the cwd link's target; cgroup: its cgroup v2 path; age:
  // seconds since it started (default about two hours).
  add(pid, comm, { ppid = 1, cpu = 0, rss = 0, env = null, unreadable = false, pss = null, cwd = null, cgroup = null, age = null } = {}) {
    const start = age == null ? 1000 + pid : Math.max(0, Math.round((Date.now() / 1000 - this.btime - age) * 100)); // ticks after boot
    this.procs.set(pid, { comm, ppid, share: cpu, ticks: 5000, rss, env, unreadable, pss, cwd, cgroup, start });
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
    this.put("stat", [line("cpu ", tot), ...this.cpu.map((c, i) => line(`cpu${i}`, c)), "intr 0", "ctxt 0", `btime ${this.btime}`, ""].join("\n"));
    const kb = (b) => Math.round(b / 1024);
    this.put("meminfo", `MemTotal: ${kb(this.mem.total)} kB\nMemFree: 1000 kB\nMemAvailable: ${kb(this.mem.avail)} kB\nBuffers: ${kb(this.cache.buffers)} kB\nCached: ${kb(this.cache.cached)} kB\nShmem: ${kb(this.cache.shmem)} kB\nSReclaimable: ${kb(this.cache.sreclaimable)} kB\nSwapTotal: ${kb(this.swap.total)} kB\nSwapFree: ${kb(this.swap.free)} kB\n`);
    this.put("loadavg", this.load + "\n");
    this.put("sys/kernel/osrelease", this.osrelease + "\n");
    if (this.psi != null) { mkdirSync(join(this.dir, "pressure"), { recursive: true }); this.put("pressure/memory", this.psi); }
    for (const [pid, p] of this.procs) {
      const d = join(this.dir, String(pid));
      mkdirSync(d, { recursive: true });
      // Fields after comm: state ppid pgrp session tty tpgid flags minflt
      // cminflt majflt cmajflt utime stime cutime cstime prio nice threads
      // itreal starttime vsize rss ...
      const u = Math.round(p.ticks * 0.8), s = Math.round(p.ticks * 0.2);
      this.put(`${pid}/stat`, `${pid} (${p.comm}) S ${p.ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 ${u} ${s} 0 0 20 0 1 0 ${p.start} 1000000 ${Math.round(p.rss / PAGE)} 0 0 0\n`);
      const envPath = join(d, "environ");
      if (p.unreadable) { try { chmodSync(envPath, 0o600); } catch {} }
      if (p.env) this.put(`${pid}/environ`, Object.entries({ PATH: "/usr/bin", ...p.env }).map(([k, v]) => `${k}=${v}\0`).join(""));
      else this.put(`${pid}/environ`, "PATH=/usr/bin\0");
      if (p.unreadable) chmodSync(envPath, 0o000);
      if (p.pss != null) this.put(`${pid}/smaps_rollup`, `00400000-7fff00000000 ---p 00000000 00:00 0    [rollup]\nRss: ${Math.round(p.rss / 1024)} kB\nPss: ${Math.round(p.pss / 1024)} kB\nPss_Anon: ${Math.round(p.pss / 1024)} kB\n`);
      else rmSync(join(d, "smaps_rollup"), { force: true });
      if (p.cgroup) this.put(`${pid}/cgroup`, `0::${p.cgroup}\n`);
      if (p.cwd && !p.cwdDone) { rmSync(join(d, "cwd"), { force: true }); symlinkSync(p.cwd, join(d, "cwd")); p.cwdDone = true; }
    }
  }
  put(rel, text) {
    const p = join(this.dir, rel);
    writeFileSync(p + ".tmp", text);
    renameSync(p + ".tmp", p); // whole files, as /proc reads are
  }
}
