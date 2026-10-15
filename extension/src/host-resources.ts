/**
 * host-resources — what this host can run at once (#1325).
 *
 * Parallelism used to be sized from constants alone: 3 parallel groups × up
 * to 6 workstreams, each running a full verify suite, whatever the machine.
 * In a CPU-limited container that became verify timeouts and fork
 * exhaustion. This module reads the machine once and derives a budget:
 *
 *   - CPUs: `os.availableParallelism()`, lowered by a cgroup CPU quota
 *     (v2 `cpu.max`, v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us`).
 *   - Memory: `os.totalmem()`, lowered by a cgroup memory limit
 *     (v2 `memory.max`, v1 `memory.limit_in_bytes`).
 *
 * The cgroup v2 limits are read along the process's own cgroup path up to the
 * root, so a limit set on a parent slice counts. No cgroup files (macOS, an
 * unlimited host) leaves the os values.
 *
 * The budget only LOWERS the static defaults; it never raises them. The group
 * and workstream defaults (3 × 6) survive only from about 9 CPUs and 18 GiB
 * up (16 / 32 GiB comfortably): an 8-CPU / 16 GiB host runs 2 groups and 4
 * concurrent verifies, and a 2-3 CPU host serialises verify. Verify runs had
 * no bound before, so any host can now queue them. An explicit env setting
 * always wins over the budget (the callers check the env first):
 * `PI_ENSEMBLE_VERIFY_CONCURRENCY=0`, `PI_ENSEMBLE_PARALLEL_GROUPS`,
 * `PI_ENSEMBLE_MAX_WORKSTREAMS` restore the old behaviour.
 *
 * Also owns the verify semaphore: a FIFO ceiling on concurrent driver-run
 * verify commands (`PI_ENSEMBLE_VERIFY_CONCURRENCY`), which are the
 * CPU-heavy part of a cycle and were bounded by nothing.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const GIB = 1024 ** 3;

export interface HostResources {
  cpus: number;
  cpuSource: "os" | "cgroup-v2" | "cgroup-v1";
  memoryBytes: number;
  memorySource: "os" | "cgroup-v2" | "cgroup-v1";
  cgroup: "v2" | "v1" | "none";
}

export interface HostBudget extends HostResources {
  /**
   * Concurrent workstreams (developer children, each running its own tests)
   * the host carries: two per CPU (a developer spends most of its time waiting
   * on the model) and one per GiB of memory, whichever is lower.
   */
  workstreamSlots: number;
  /** Default verify concurrency: one run per 2 CPUs and per 2 GiB, at least 1. */
  verifyConcurrency: number;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** A positive number from a cgroup file, or undefined for `max`, -1, absent or garbage. */
function readLimit(file: string): number | undefined {
  const n = Number(readText(file));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** CPUs a quota allows: `quota / period`, floored, at least 1. */
const quotaCpus = (quota: number | undefined, period: number | undefined) =>
  quota !== undefined && period !== undefined ? Math.max(1, Math.floor(quota / period)) : undefined;

/**
 * Read the host's CPU and memory limits. `root` is the filesystem root the
 * `/proc` and `/sys` paths resolve under — a test points it at a fixture tree.
 */
export function readHostResources(
  root = "/",
  osCpus: number = os.availableParallelism(),
  osMemory: number = os.totalmem(),
): HostResources {
  const out: HostResources = {
    cpus: osCpus,
    cpuSource: "os",
    memoryBytes: osMemory,
    memorySource: "os",
    cgroup: "none",
  };
  const cgRoot = path.join(root, "sys", "fs", "cgroup");
  const lower = (
    cpus: number | undefined,
    mem: number | undefined,
    src: "cgroup-v2" | "cgroup-v1",
  ) => {
    if (cpus !== undefined && cpus < out.cpus) Object.assign(out, { cpus, cpuSource: src });
    if (mem !== undefined && mem < out.memoryBytes)
      Object.assign(out, { memoryBytes: mem, memorySource: src });
  };
  const own = (readText(path.join(root, "proc", "self", "cgroup")) ?? "")
    .split("\n")
    .find((l) => l.startsWith("0::"));
  if (own !== undefined && readText(path.join(cgRoot, "cgroup.controllers")) !== undefined) {
    out.cgroup = "v2";
    // Walk from the process's own cgroup up to the root: the tightest limit wins.
    let dir = path.join(cgRoot, own.slice(3));
    for (;;) {
      const [quota, period] = (readText(path.join(dir, "cpu.max")) ?? "").split(/\s+/);
      lower(
        quotaCpus(Number(quota) || undefined, Number(period) || undefined),
        readLimit(path.join(dir, "memory.max")),
        "cgroup-v2",
      );
      if (path.relative(cgRoot, dir) === "" || !dir.startsWith(cgRoot)) break;
      dir = path.dirname(dir);
    }
    return out;
  }
  const v1Cpu = ["cpu", "cpu,cpuacct"]
    .map((d) => path.join(cgRoot, d))
    .find((d) => readText(path.join(d, "cpu.cfs_period_us")) !== undefined);
  const v1Mem = readLimit(path.join(cgRoot, "memory", "memory.limit_in_bytes"));
  if (v1Cpu !== undefined || v1Mem !== undefined) {
    out.cgroup = "v1";
    const cpus = v1Cpu
      ? quotaCpus(
          readLimit(path.join(v1Cpu, "cpu.cfs_quota_us")),
          readLimit(path.join(v1Cpu, "cpu.cfs_period_us")),
        )
      : undefined;
    lower(cpus, v1Mem, "cgroup-v1");
  }
  return out;
}

/** Derive the budget from the host's resources. Pure. */
export function budgetFor(r: HostResources): HostBudget {
  const memGib = r.memoryBytes / GIB;
  return {
    ...r,
    workstreamSlots: Math.max(1, Math.min(r.cpus * 2, Math.floor(memGib))),
    verifyConcurrency: Math.max(1, Math.min(Math.floor(r.cpus / 2), Math.floor(memGib / 2))),
  };
}

let cached: HostBudget | undefined;

/** The budget for this process's host, read once. */
export function hostBudget(): HostBudget {
  cached ??= budgetFor(readHostResources());
  return cached;
}

/** Test seam: replace (or with no argument, re-read) the cached budget. */
export function __setHostBudget(b?: HostBudget): void {
  cached = b;
}

/** A positive integer env value, or undefined when unset / garbage. */
export function envCount(name: string, min = 1): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : undefined;
}

/**
 * Concurrent driver-run verify commands allowed. `PI_ENSEMBLE_VERIFY_CONCURRENCY`
 * wins (`0` = unbounded, the pre-#1325 behaviour); otherwise the budget's.
 */
export function verifyConcurrency(): number {
  return envCount("PI_ENSEMBLE_VERIFY_CONCURRENCY", 0) ?? hostBudget().verifyConcurrency;
}

let active = 0;
const waiting: Array<() => void> = [];

/** Observability for tests. */
export function verifySlotStats(): { active: number; queued: number } {
  return { active, queued: waiting.length };
}

/**
 * Run one verify command holding a slot, queueing FIFO at the ceiling. Wrap
 * only the leaf exec of the command — a slot holder must never wait on
 * anything else (a lock, another slot), or a full pool could deadlock.
 */
export async function withVerifySlot<T>(fn: () => Promise<T>): Promise<T> {
  const cap = verifyConcurrency();
  if (cap === 0) return fn();
  if (active >= cap) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter (active stays the same), so a
    // late arrival cannot overtake the queue between release and wake-up.
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}
