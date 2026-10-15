#!/usr/bin/env bun
/**
 * #1325 — parallelism is sized from the host's CPUs and memory, and the
 * driver's verify commands are bounded by a semaphore.
 *
 *   - cgroup v2 `cpu.max` / `memory.max` (tightest along the own path), the v1
 *     files, or neither, lower `os.availableParallelism()` / `os.totalmem()`.
 *   - The budget lowers the unset group and workstream defaults on a small
 *     host and leaves them alone on a large one; explicit env always wins.
 *   - `withVerifySlot` holds at most `PI_ENSEMBLE_VERIFY_CONCURRENCY` runs at
 *     once, FIFO, and a throwing run frees its slot.
 *   - The budget and limits are reported as data (`resourceReport`, and
 *     `resources` in `--capabilities`).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import {
  type HostBudget,
  __setHostBudget,
  budgetFor,
  readHostResources,
  verifyConcurrency,
  verifySlotStats,
  withVerifySlot,
} from "../src/host-resources.ts";
import { resourceReport } from "../src/resource-budget.ts";
import { effectiveParallelGroups, groupIssues } from "../src/work-driver-grouping.ts";
import { effectiveMaxWorkstreams, parseWorkstreams } from "../src/work-driver-plan-workstreams.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const GIB = 1024 ** 3;
const ENV = [
  "PI_ENSEMBLE_PARALLEL_GROUPS",
  "PI_ENSEMBLE_PARALLEL_WORK",
  "PI_ENSEMBLE_MAX_WORKSTREAMS",
  "PI_ENSEMBLE_VERIFY_CONCURRENCY",
];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV) delete process.env[k];
  }
}
const host = (cpus: number, gib: number): HostBudget =>
  budgetFor({ cpus, cpuSource: "os", memoryBytes: gib * GIB, memorySource: "os", cgroup: "none" });

// ── cgroup readers, against fixture trees.
const root = mkdtempSync(path.join(os.tmpdir(), "pi-host-res-"));
function tree(name: string, files: Record<string, string>): string {
  const r = path.join(root, name);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
    writeFileSync(path.join(r, rel), body);
  }
  return r;
}
try {
  const v2 = tree("v2", {
    "proc/self/cgroup": "0::/box/inner\n",
    "sys/fs/cgroup/cgroup.controllers": "cpu memory pids",
    "sys/fs/cgroup/box/inner/cpu.max": "max 100000",
    "sys/fs/cgroup/box/inner/memory.max": `${4 * GIB}`,
    "sys/fs/cgroup/box/cpu.max": "250000 100000",
    "sys/fs/cgroup/box/memory.max": "max",
  });
  const r2 = readHostResources(v2, 16, 64 * GIB);
  assert(
    r2.cgroup === "v2" && r2.cpus === 2 && r2.cpuSource === "cgroup-v2",
    `v2: a parent slice's 2.5-CPU quota counts, floored (got ${r2.cpus} ${r2.cpuSource})`,
  );
  assert(
    r2.memoryBytes === 4 * GIB && r2.memorySource === "cgroup-v2",
    "v2: the own cgroup's memory.max lowers totalmem",
  );

  const unlimited = tree("v2max", {
    "proc/self/cgroup": "0::/\n",
    "sys/fs/cgroup/cgroup.controllers": "cpu memory",
    "sys/fs/cgroup/cpu.max": "max 100000",
    "sys/fs/cgroup/memory.max": "max",
  });
  const ru = readHostResources(unlimited, 16, 64 * GIB);
  assert(
    ru.cgroup === "v2" && ru.cpus === 16 && ru.cpuSource === "os" && ru.memoryBytes === 64 * GIB,
    "v2 with `max` limits keeps the os values",
  );

  const v1 = tree("v1", {
    "proc/self/cgroup": "4:cpu,cpuacct:/docker/x\n",
    "sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us": "300000",
    "sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us": "100000",
    "sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
  });
  const r1 = readHostResources(v1, 16, 64 * GIB);
  assert(
    r1.cgroup === "v1" && r1.cpus === 3 && r1.cpuSource === "cgroup-v1",
    `v1: cfs quota/period gives 3 CPUs (got ${r1.cpus})`,
  );
  assert(
    r1.memoryBytes === 64 * GIB && r1.memorySource === "os",
    "v1: the 'unlimited' sentinel is ignored",
  );

  const none = readHostResources(tree("none", {}), 8, 16 * GIB);
  assert(
    none.cgroup === "none" && none.cpus === 8 && none.memoryBytes === 16 * GIB,
    "no cgroup files: os values",
  );

  const half = tree("v2half", {
    "proc/self/cgroup": "0::/\n",
    "sys/fs/cgroup/cgroup.controllers": "cpu",
    "sys/fs/cgroup/cpu.max": "50000 100000",
  });
  const rh = readHostResources(half, 16, 64 * GIB);
  assert(
    rh.cpus === 1 && rh.cpuSource === "cgroup-v2",
    `v2: a half-CPU quota clamps to 1 (got ${rh.cpus})`,
  );

  const v1none = tree("v1none", {
    "sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1",
    "sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
  });
  const r1n = readHostResources(v1none, 16, 64 * GIB);
  assert(
    r1n.cgroup === "v1" && r1n.cpus === 16 && r1n.cpuSource === "os",
    "v1: cfs_quota_us -1 (no quota) keeps the os CPUs",
  );

  // Unreadable limit files (a directory where the file should be) are skipped, not fatal.
  const unreadable = tree("v2unreadable", {
    "proc/self/cgroup": "0::/\n",
    "sys/fs/cgroup/cgroup.controllers": "cpu memory",
    "sys/fs/cgroup/cpu.max/x": "",
    "sys/fs/cgroup/memory.max/x": "",
  });
  const rx = readHostResources(unreadable, 8, 16 * GIB);
  assert(
    rx.cgroup === "v2" && rx.cpus === 8 && rx.memoryBytes === 16 * GIB && rx.cpuSource === "os",
    "v2: unreadable cpu.max / memory.max leave the os values",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── budget arithmetic.
{
  const big = host(16, 64);
  assert(
    big.workstreamSlots === 32 && big.verifyConcurrency === 8,
    "16 CPU / 64 GiB → 32 slots, verify 8",
  );
  const small = host(2, 4);
  assert(
    small.workstreamSlots === 4 && small.verifyConcurrency === 1,
    "2 CPU / 4 GiB → 4 slots, verify 1",
  );
  const mid = host(8, 16);
  assert(
    mid.workstreamSlots === 16 && mid.verifyConcurrency === 4,
    "8 CPU / 16 GiB → 16 slots, verify 4",
  );
  const tiny = host(1, 0.5);
  assert(tiny.workstreamSlots === 1 && tiny.verifyConcurrency === 1, "never below 1");
}

// ── a large unconstrained host keeps today's defaults.
__setHostBudget(host(16, 64));
withEnv({}, () => {
  assert(effectiveParallelGroups() === 3, "big host: 3 parallel groups (the default)");
  assert(effectiveMaxWorkstreams() === 6, "big host: 6 workstreams (the default)");
  const r = resourceReport();
  assert(
    r.limits.parallelGroups.source === "default" && r.limits.maxWorkstreams.source === "default",
    "big host: limits report source=default",
  );
});

// ── a mid-size host (8 CPU / 16 GiB) already drops to 2 groups.
__setHostBudget(host(8, 16));
withEnv({}, () => {
  assert(
    effectiveParallelGroups() === 2 && effectiveMaxWorkstreams() === 6 && verifyConcurrency() === 4,
    "8 CPU / 16 GiB: 2 groups, 6 workstreams, verify 4",
  );
});

// ── a constrained host lowers the unset defaults; explicit env wins.
__setHostBudget(host(2, 4));
withEnv({}, () => {
  assert(effectiveMaxWorkstreams() === 4, "2 CPU / 4 GiB: workstreams lowered to 4");
  assert(effectiveParallelGroups() === 1, "2 CPU / 4 GiB: groups lowered to 1");
  assert(verifyConcurrency() === 1, "2 CPU / 4 GiB: verify concurrency 1");
  const ids = Object.keys(
    parseWorkstreams(
      [
        "## Workstreams",
        "",
        ...[0, 1, 2, 3, 4, 5].map((i) => `### w${i} — s\n- paths: src/f${i}.ts\n`),
      ].join("\n"),
    ),
  );
  assert(ids.length === 4, `the plan fold uses the lowered ceiling (${ids.length} workstreams)`);
  assert(
    groupIssues([1, 2], {}).fanout.concurrencyCap === 1,
    "groupIssues' fanout cap is the effective group cap",
  );
  const r = resourceReport();
  assert(
    r.limits.parallelGroups.source === "budget" &&
      r.limits.maxWorkstreams.source === "budget" &&
      r.limits.verifyConcurrency.source === "budget",
    "constrained host: limits report source=budget",
  );
  assert(
    r.host.cpus === 2 && r.budget.workstreamSlots === 4,
    "the report carries the host and budget",
  );
});
withEnv(
  {
    PI_ENSEMBLE_PARALLEL_GROUPS: "3",
    PI_ENSEMBLE_MAX_WORKSTREAMS: "6",
    PI_ENSEMBLE_VERIFY_CONCURRENCY: "5",
  },
  () => {
    assert(effectiveParallelGroups() === 3, "explicit PARALLEL_GROUPS wins over the budget");
    assert(effectiveMaxWorkstreams() === 6, "explicit MAX_WORKSTREAMS wins over the budget");
    assert(verifyConcurrency() === 5, "explicit VERIFY_CONCURRENCY wins over the budget");
    const l = resourceReport().limits;
    assert(
      l.parallelGroups.source === "env" &&
        l.maxWorkstreams.source === "env" &&
        l.verifyConcurrency.source === "env",
      "explicit settings report source=env",
    );
  },
);
withEnv({ PI_ENSEMBLE_MAX_WORKSTREAMS: "2" }, () =>
  assert(
    effectiveParallelGroups() === 2,
    "an explicit workstream ceiling frees budget for groups (4 slots / 2)",
  ),
);
withEnv({ PI_ENSEMBLE_PARALLEL_WORK: "0" }, () =>
  assert(effectiveParallelGroups() === 1, "PARALLEL_WORK=0 still forces 1"),
);
withEnv({ PI_ENSEMBLE_VERIFY_CONCURRENCY: "0" }, () =>
  assert(verifyConcurrency() === 0, "VERIFY_CONCURRENCY=0 is unbounded"),
);
withEnv({ PI_ENSEMBLE_VERIFY_CONCURRENCY: "lots" }, () =>
  assert(verifyConcurrency() === 1, "a garbage VERIFY_CONCURRENCY falls back to the budget"),
);

// ── the verify semaphore.
{
  process.env.PI_ENSEMBLE_VERIFY_CONCURRENCY = "2";
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const job = (n: number, fail = false) =>
    withVerifySlot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      order.push(n);
      if (fail) throw new Error(`job ${n} failed`);
      return n;
    });
  const results = await Promise.allSettled([job(1, true), job(2), job(3), job(4, true), job(5)]);
  assert(peak === 2, `at most 2 verify runs at once (peak ${peak})`);
  assert(order.join(",") === "1,2,3,4,5", `queued runs start FIFO (${order.join(",")})`);
  assert(
    results.filter((r) => r.status === "rejected").length === 2,
    "a failing run rejects to its caller",
  );
  const stats = verifySlotStats();
  assert(stats.active === 0 && stats.queued === 0, "every slot is released, failures included");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_VERIFY_CONCURRENCY");
}

// ── every driver-run verify exec goes through the semaphore.
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const sites = [
    "work-driver-verify-verify-cmd.ts",
    "work-driver-consolidated-verify.ts",
    "work-driver-verify-flake.ts",
    "work-driver-integrate-verify.ts",
    "work-driver-verify-baseline.ts",
    "work-driver-verify-full.ts",
    "work-driver-verify-develop-gates.ts",
  ];
  const bare = sites.filter(
    (f) => !readFileSync(path.join(SRC, f), "utf8").includes("withVerifySlot(() =>"),
  );
  assert(
    bare.length === 0,
    `verify exec sites hold a slot${bare.length ? ` — missing: ${bare.join(", ")}` : ""}`,
  );
}

// ── reported in --capabilities.
{
  __setHostBudget(host(4, 8));
  const caps = withEnv({}, () => buildCapabilities());
  assert(
    caps.resources.host.cpus === 4 && caps.resources.limits.verifyConcurrency.value === 2,
    "--capabilities carries the resource report",
  );
}

__setHostBudget();
for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
process.exit(exit);
