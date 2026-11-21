/**
 * lib/lean-verify-handback-log — the step LOGS a handback case drives with.
 *
 * Separate from `lean-verify-fixture.ts` because it answers a different question: the fixture builds
 * a TREE the gate runs against, and this builds the RECORD a handback case hands its step. A case
 * that only needs a log should not have to provision a repo to get one. The frozen-test path the
 * `specify` row names is the same one the fixture freezes, imported rather than restated so the two
 * cannot drift apart.
 */

import type { HandlerCtx } from "../../src/lean/engine.ts";
import { type Outcome, type Step, createRun } from "../../src/lean/state.ts";
import { FROZEN_FILE } from "./lean-verify-frozen.ts";

export interface HandbackPost {
  repoRoot: string;
  issue: number;
  body: string;
}

/** A HandlerCtx for a handback case, carrying the log the case asked for. */
export function handbackCtx(
  issue: number,
  steps: Step[],
  repoRoot = "/tmp/lean-handback-repo",
): HandlerCtx {
  const run = createRun({
    issue,
    version: "test",
    models: {},
    baseSha: "a".repeat(40),
    branch: `lean/issue-${issue}`,
  });
  const withSteps = { ...run, steps };
  return {
    repoRoot,
    issue,
    run: withSteps,
    steps: withSteps.steps,
    stepKey: `${issue}:handback:0`,
    now: () => 5,
  };
}

/** A decided step for the handback cases. */
export function decided(state: Step["state"], outcome: Outcome, n = 0): Step {
  return { key: `7:${state}:${n}`, state, startedAt: 1, endedAt: 2, outcome };
}

/**
 * A publish step that recorded its PR the only sanctioned way: `prUrl`.
 * `url`/`htmlUrl` are the fields the old guess list read, and a step that
 * reaches for one of them is refused by `state.ts` on load.
 *
 * `issue` names the branch the step belongs to, so a hand-built log can carry a
 * publish step whose `prUrl` the handback under test would print for that run.
 */
export function publishStep(
  url: string,
  field: "prUrl" | "url" | "htmlUrl" = "prUrl",
  issue?: number,
): Step {
  const outcome = { kind: "ok", ...(field === "prUrl" ? { prUrl: url } : { [field]: url }) };
  return decided("publish", outcome as Outcome, issue ?? 7);
}

/** The log a run carries when it reaches handback after its gate said red. */
export function redLog(prUrl?: string): Step[] {
  const steps: Step[] = [
    decided("ready", { kind: "ok" }),
    decided("specify", {
      kind: "ok",
      frozen: { [FROZEN_FILE]: "a".repeat(64) },
      tests: { AC1: [FROZEN_FILE] },
    }),
    decided("build", { kind: "ok", reason: "1 file(s) changed" }),
    decided("verify", {
      kind: "red",
      reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
    }),
  ];
  if (prUrl !== undefined) steps.push(decided("publish", { kind: "ok", prUrl } as Outcome));
  return steps;
}
