/**
 * resource-budget — the host budget and the limits a cycle runs with, as data
 * (#1325). Reported in the headless `--json` result and `--capabilities`, and
 * traced at cycle start, so a host can see what the cycle chose and why.
 *
 * Each limit carries its `source`: `env` when an explicit setting decided it,
 * `budget` when the host budget lowered the default, `default` otherwise.
 */

import { type HostBudget, envCount, hostBudget, verifyConcurrency } from "./host-resources.ts";
import { trace } from "./trace.ts";
import { effectiveParallelGroups, resolvedParallelGroups } from "./work-driver-grouping.ts";
import { effectiveMaxWorkstreams, maxWorkstreams } from "./work-driver-plan-workstreams.ts";

type Source = "env" | "budget" | "default";

export interface Limit {
  value: number;
  source: Source;
}

export interface ResourceReport {
  host: Omit<HostBudget, "workstreamSlots" | "verifyConcurrency">;
  budget: { workstreamSlots: number; verifyConcurrency: number };
  limits: {
    parallelGroups: Limit;
    maxWorkstreams: Limit;
    /** `0` = unbounded (explicit `PI_ENSEMBLE_VERIFY_CONCURRENCY=0`). */
    verifyConcurrency: Limit;
  };
}

function limit(value: number, explicit: boolean, staticDefault: number): Limit {
  return { value, source: explicit ? "env" : value < staticDefault ? "budget" : "default" };
}

/** The host budget and the effective limits, read from the live resolvers. */
export function resourceReport(): ResourceReport {
  const { workstreamSlots, verifyConcurrency: verifyDefault, ...host } = hostBudget();
  const groupsExplicit =
    process.env.PI_ENSEMBLE_PARALLEL_WORK === "0" ||
    Number(process.env.PI_ENSEMBLE_PARALLEL_GROUPS) > 0;
  return {
    host,
    budget: { workstreamSlots, verifyConcurrency: verifyDefault },
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
    },
  };
}

/** One trace line naming the budget and the limits it produced. */
export function traceResourceBudget(issue: number): void {
  const r = resourceReport();
  const gib = (r.host.memoryBytes / 1024 ** 3).toFixed(1);
  const l = r.limits;
  trace(
    `work-driver: #${issue} resource budget — ${r.host.cpus} cpu (${r.host.cpuSource}), ${gib} GiB (${r.host.memorySource}), cgroup ${r.host.cgroup}; groups ${l.parallelGroups.value} (${l.parallelGroups.source}), workstreams ${l.maxWorkstreams.value} (${l.maxWorkstreams.source}), verify ${l.verifyConcurrency.value || "unbounded"} (${l.verifyConcurrency.source})`,
  );
}
