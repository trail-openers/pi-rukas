#!/usr/bin/env bun
/**
 * #1809 — shared scaffolding for the base-health channel test
 * (`test-verify-base-health-channels.ts`), the only file that imports it.
 *
 * One file needs this: a real git fixture whose project verify command
 * fails, a background probe registered under the key the develop gate will build,
 * and the two channel callbacks captured rather than asserted on from prose. That
 * setup is 90 lines of fixture work with three anti-vacuity requirements baked in,
 * and a case that gets any one of them wrong does not fail — it passes while
 * testing nothing:
 *
 *  - the fixture must DECLARE a `.pi/verify-cmd`, or the chain notes "no verify
 *    command" and consults nothing;
 *  - the probe must be registered BEFORE the gate runs, because the entry is
 *    deleted when a reader takes it;
 *  - `gateRuns` must be counted so "the consultation reported X" cannot be a
 *    report from a gate that never executed the project's command.
 *
 * Offline: temp git repos only, no dispatch, no spawn, no model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startBaseHealthProbe } from "../../src/work-driver-base-health-inflight.ts";
import type { DriverExecFn } from "../../src/work-driver-context.ts";
import { aggregateVerifyOutcome } from "../../src/work-driver-verify-aggregate.ts";
import type {
  BaseHealthConsulted,
  BaseHealthReport,
} from "../../src/work-driver-verify-base-health-channels.ts";
import type { BaseHealthProbeOutcome } from "../../src/work-driver-verify-base-health.ts";
import { recordDevelopGateEvents } from "../../src/work-driver-verify-events.ts";
import type {
  BaseHealthKey,
  BaseHealthVerdict,
} from "../../src/workflow-state-schema-base-health.ts";
import type { WorkState } from "../../src/workflow-state.ts";
import { RED_GATE, branchState, keyFor } from "./base-health-probe-fixture.ts";
import { realExec } from "./restore-start-ref-fixtures.ts";
import { redGateFixture } from "./verify-baseline-probe-harness.ts";

/** The command the fixture's project declares as its verify. */
export const CMD = "sh gate.sh";

/** The failure list a gate reports when the change's own verify failed. */
export const changeFailure = (cmd: string) =>
  `verify command \`${cmd}\` failed in worktree a: 1 failed`;

/** A verdict for a given base, so a probe speaks for the commit the gate judges. */
export const verdict = (
  baseSha: string,
  status: "green" | "red",
  bound: number,
): BaseHealthVerdict => ({
  status,
  baseSha,
  command: CMD,
  tierBoundMs: bound,
});

export interface AggregateRun {
  collected: BaseHealthVerdict | undefined;
  consulted: BaseHealthConsulted | undefined;
  failures: string[];
  notes: string[];
  state: WorkState;
  /** `state` after the real recorder consumed the one report both halves came in on. */
  recorded: WorkState;
  /** 1 when the aggregate leg consulted the registry, 0 when it never got there. */
  probeStarted: number;
  /** Gate executions the fixture's command actually ran — the anti-vacuity count. */
  gateRuns: number;
}

/**
 * Drive the REAL develop gate's aggregate leg (`aggregateVerifyOutcome`) with a
 * background probe registered for the gate's own key, and hand back both channels
 * the gate reports plus the state the caller would record them into.
 *
 * `aggregateVerifyOutcome` is the single producer of both channels and
 * `recordDevelopGateEvents` the single writer of `pipelineState.baseHealthProbe`,
 * so a case that stops short of either pins a callback nobody calls.
 */
export async function aggregateWithProbe(
  root: string,
  name: string,
  /** Built AFTER the fixture, so the verdict speaks for the base the gate judges. */
  outcomeFor: (baseSha: string, tierBoundMs: number) => BaseHealthProbeOutcome,
): Promise<AggregateRun> {
  const f = await redGateFixture(root, name, RED_GATE, { "notes.md": "x\n" });
  // The gate's command is discovered from the project, so the fixture has to
  // declare one; without it the chain notes "no verify command" and consults
  // nothing, which would leave every assertion below vacuously satisfied.
  mkdirSync(path.join(f.repo, ".pi"), { recursive: true });
  writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${CMD}\n`);
  const bound = (await keyFor(f.repo, f.baseSha, CMD)).tierBoundMs;
  const key: BaseHealthKey = { baseSha: f.baseSha, command: CMD, tierBoundMs: bound };
  let gateRuns = 0;
  let probeStarted = 0;
  const execFn: DriverExecFn = async (cmd, o) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    // The probe tree is the gate's own throwaway checkout of the base; counting it
    // would make "the gate ran the command" mean two different runs.
    if (!line.includes("git ") && !line.includes("baseline-verify-")) gateRuns += 1;
    return await realExec(cmd, o);
  };
  // The branch step's shape: the probe is registered by a different step and the
  // gate only reads it — so it is registered here, before the gate runs.
  const registered = startBaseHealthProbe(key, async () => {
    probeStarted += 1;
    return outcomeFor(f.baseSha, bound);
  });
  const state = branchState(f.baseSha);
  const failures = [changeFailure(CMD)];
  const notes: string[] = [];
  let collected: BaseHealthVerdict | undefined;
  let consulted: BaseHealthConsulted | undefined;
  await aggregateVerifyOutcome({
    execFn,
    ctx: { host: {}, repoRoot: f.repo, issue: 1809 } as never,
    cmd: CMD,
    baseSha: f.baseSha,
    suiteTimeoutMs: bound,
    // The shape a failed per-worktree run reaches the aggregate leg with: the
    // consolidated run could not build, so `cons` passed and the per-worktree
    // failures are the verdict. Either arm reaches the consultation.
    cons: { status: "passed" } as never,
    perWorktreeVerifyFailures: failures,
    failures,
    notes,
    onBaseHealth: (report: BaseHealthReport) => {
      collected = report.collected;
      consulted = report.consulted;
    },
  });
  await registered;
  return {
    collected,
    consulted,
    failures,
    notes,
    state,
    recorded: recordDevelopGateEvents(state, {
      ...(collected === undefined ? {} : { baseHealthProbe: collected }),
      ...(consulted === undefined ? {} : { baseHealthConsulted: consulted }),
    } as never),
    gateRuns,
    probeStarted,
  };
}
