/**
 * resource-budget — the host budget and the limits a cycle runs with, as data
 * (#1325). Reported in the headless `--json` result and `--capabilities`, and
 * traced at cycle start, so a host can see what the cycle chose and why.
 *
 * Each limit carries its `source`: `env` when an explicit setting decided it,
 * `budget` when the host budget lowered the default, `default` otherwise.
 * Every limit is per process except `hostSpawnCap`, which bounds the children
 * of every process sharing its slot directory (#1528); the two spawn caps say
 * which they are in `scope`.
 */

import {
  type HostBudget,
  envCount,
  hostBudget,
  lensConcurrency,
  verifyConcurrency,
} from "./host-resources.ts";
import { hostSpawnCap } from "./host-spawn-slots.ts";
import { spawnCap } from "./spawn-semaphore.ts";
import { trace } from "./trace.ts";
import { effectiveParallelGroups, resolvedParallelGroups } from "./work-driver-grouping.ts";
import { effectiveMaxWorkstreams, maxWorkstreams } from "./work-driver-plan-workstreams.ts";

type Source = "env" | "budget" | "default";

export interface Limit {
  value: number;
  source: Source;
}

export interface ResourceReport {
  host: Omit<HostBudget, "workstreamSlots" | "verifyConcurrency" | "lensSlots">;
  budget: { workstreamSlots: number; verifyConcurrency: number; lensSlots: number };
  limits: {
    parallelGroups: Limit;
    maxWorkstreams: Limit;
    /** `0` = unbounded (explicit `PI_ENSEMBLE_VERIFY_CONCURRENCY=0`). */
    verifyConcurrency: Limit;
    /** Concurrent lens children (#1591). `0` = unbounded (explicit `PI_ENSEMBLE_LENS_CONCURRENCY=0`). */
    lensConcurrency: Limit;
    /** Concurrent children of this process. `0` = unbounded (the semaphore is off). */
    spawnCap: Limit & { scope: "process" };
    /** Concurrent children host-wide (#1528). `0` = unbounded (the host bound is off). */
    hostSpawnCap: Limit & { scope: "host" };
  };
}

function limit(value: number, explicit: boolean, staticDefault: number): Limit {
  return { value, source: explicit ? "env" : value < staticDefault ? "budget" : "default" };
}

/** `env` only when the setting was valid and is the value in force. */
function fromEnv(key: string, value: number): Source {
  return process.env[key] !== undefined && Number(process.env[key]) === value ? "env" : "default";
}

/** The host budget and the effective limits, read from the live resolvers. */
export function resourceReport(): ResourceReport {
  const { workstreamSlots, verifyConcurrency: verifyDefault, lensSlots, ...host } = hostBudget();
  const groupsExplicit =
    process.env.PI_ENSEMBLE_PARALLEL_WORK === "0" ||
    Number(process.env.PI_ENSEMBLE_PARALLEL_GROUPS) > 0;
  return {
    host,
    budget: { workstreamSlots, verifyConcurrency: verifyDefault, lensSlots },
    limits: {
      parallelGroups: limit(effectiveParallelGroups(), groupsExplicit, resolvedParallelGroups()),
      maxWorkstreams: limit(
        effectiveMaxWorkstreams(),
        Number(process.env.PI_ENSEMBLE_MAX_WORKSTREAMS) >= 1,
        maxWorkstreams(),
      ),
      verifyConcurrency: {
        value: verifyConcurrency(),
        source: envCount("PI_ENSEMBLE_VERIFY_CONCURRENCY", 0) !== undefined ? "env" : "budget",
      },
      lensConcurrency: {
        value: lensConcurrency(),
        source: envCount("PI_ENSEMBLE_LENS_CONCURRENCY", 0) !== undefined ? "env" : "budget",
      },
      spawnCap: {
        value: spawnCap(),
        source: fromEnv("PI_ENSEMBLE_SPAWN_CAP", spawnCap()),
        scope: "process",
      },
      hostSpawnCap: {
        value: hostSpawnCap(),
        source: fromEnv("PI_ENSEMBLE_HOST_SPAWN_CAP", hostSpawnCap()),
        scope: "host",
      },
    },
  };
}

/** One trace line naming the budget and the limits it produced. */
export function traceResourceBudget(issue: number): void {
  const r = resourceReport();
  const gib = (r.host.memoryBytes / 1024 ** 3).toFixed(1);
  const l = r.limits;
  const pids = r.host.pidsMax ?? "unlimited";
  trace(
    `work-driver: #${issue} resource budget — ${r.host.cpus} cpu (${r.host.cpuSource}), ${gib} GiB (${r.host.memorySource}), pids ${pids}, cgroup ${r.host.cgroup}; groups ${l.parallelGroups.value} (${l.parallelGroups.source}), workstreams ${l.maxWorkstreams.value} (${l.maxWorkstreams.source}), verify ${l.verifyConcurrency.value || "unbounded"} (${l.verifyConcurrency.source}), lenses ${l.lensConcurrency.value || "unbounded"} (${l.lensConcurrency.source}), children ${l.spawnCap.value || "unbounded"} per process / ${l.hostSpawnCap.value || "unbounded"} host-wide`,
  );
}
