#!/usr/bin/env bun
/**
 * host_job_count (lib/verify-pool.sh) lowers the pool width by the cgroup CPU
 * quota, because inside a container getconf reports the host's CPU count.
 *
 * Each case builds a fixture /proc + /sys/fs/cgroup tree under a temp root and
 * points VERIFY_CGROUP_ROOT at it, with a stub getconf reporting 16 CPUs, so
 * the developer's real cgroup never decides the answer. The reading rule is
 * the one src/host-resources.ts uses: walk /proc/self/cgroup up to the root,
 * tightest wins; v1 cfs files otherwise; the quota only ever lowers the width.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const POOL = path.join(import.meta.dirname, "lib", "verify-pool.sh");
const tmp = mkdtempSync(path.join(tmpdir(), "verify-cgroup-quota-"));
const bin = path.join(tmp, "bin");
mkdirSync(bin);
writeFileSync(bin + "/getconf", "#!/bin/sh\necho 16\n", { mode: 0o755 });
chmodSync(bin + "/getconf", 0o755);

type Tree = Record<string, string>;
let n = 0;
/** Build a root from `{ "relative/path": contents }` and return host_job_count's answer. */
function widthFor(tree: Tree): { width: string; trace: string } {
  const root = path.join(tmp, `root${n++}`);
  mkdirSync(root);
  for (const [rel, body] of Object.entries(tree)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  const r = spawnSync("bash", ["-c", `. "${POOL}"; host_job_count`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, VERIFY_CGROUP_ROOT: root },
  });
  return { width: r.stdout.trim(), trace: r.stderr };
}

const V2 = { "proc/self/cgroup": "0::/a/b\n", "sys/fs/cgroup/cgroup.controllers": "cpu\n" };
try {
  const quota2 = widthFor({ ...V2, "sys/fs/cgroup/a/b/cpu.max": "200000 100000\n" });
  assert(quota2.width === "2", `v2 cpu.max 200000 100000 on 16 CPUs sizes the pool to 2 (got ${quota2.width})`);
  assert(quota2.trace.includes("quota=2"), `the trace names the quota (${JSON.stringify(quota2.trace.trim())})`);

  const unlimited = widthFor({ ...V2, "sys/fs/cgroup/a/b/cpu.max": "max 100000\n" });
  assert(unlimited.width === "14", `v2 cpu.max "max 100000" leaves the width at 14 (got ${unlimited.width})`);

  const parent = widthFor({
    ...V2,
    "sys/fs/cgroup/a/b/cpu.max": "max 100000\n",
    "sys/fs/cgroup/a/cpu.max": "800000 100000\n",
  });
  assert(parent.width === "6", `a limit on a parent slice counts: 8 CPUs gives width 6 (got ${parent.width})`);

  const wide = widthFor({ ...V2, "sys/fs/cgroup/a/b/cpu.max": "3200000 100000\n" });
  assert(wide.width === "14", `a quota above the online count never raises the width (got ${wide.width})`);

  const v1 = widthFor({
    "sys/fs/cgroup/cpu/cpu.cfs_quota_us": "400000\n",
    "sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
  });
  assert(v1.width === "2", `v1 cfs quota 4 CPUs gives width 2 (got ${v1.width})`);

  const none = widthFor({});
  assert(none.width === "14", `no cgroup files leaves the width at 14 (got ${none.width})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(exit);
