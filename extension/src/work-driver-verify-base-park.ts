/**
 * work-driver-verify-base-park — #1765: the branch step's park on a red base,
 * and the failure-list rules that read a probe entry's prose.
 *
 * Split out of `work-driver-verify-base-health.ts` for the AGENTS.md §12
 * 500-line cap. It is a LEAF: the probe imports it and nothing here imports the
 * probe, so the module graph the round-1 import cycle was made of stays closed.
 *
 * `baseHealthPark` is the park itself: `verify-baseline-red:branch`, cause class
 * environment (the cause table routes on the marker in the evidence), and NO
 * develop dispatch. The probe builds it and `probeBaseAtBranch` returns it as
 * the step's state, so the router reads the trailing cap-hit as its own routing
 * to `handoff`. The probe tree is already gone — `probeBaselineVerify` removes
 * it in its own `finally`. The evidence carries the gate's own tally when the
 * loop printed one, so the operator sees which suite broke rather than only
 * that it did.
 */
import { type RedBaselineVerdict, baselineRedMessage } from "./work-driver-verify-baseline.ts";
import { summaryCount } from "./work-driver-verify-names.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Leads a probe entry that attributes a failure to the base commit. */
const BASELINE_RED_MARKER = "[baseline-red]";

/**
 * Whether a probe entry attributes to `cmd`: it LEADS with the `[baseline-red]`
 * marker AND names the verify command the probe re-ran, in backticks, from
 * either arm of `baselineRedMessage`. The marker is required, not decorative:
 * the `red-timed-out` arm leads with `[baseline-red] [verify-timeout]`, so a
 * bare `[verify-timeout]` entry — a fast-tier, smoke or consolidated run the gate
 * itself killed at its bound — names no base at all and must not read as the base
 * being red. Position of the COMMAND decides nothing (the timed-out arm puts it
 * after both labels); position of the MARKER decides everything.
 *
 * This is the RENDERER's contract, pinned by `test-verify-baseline-attribution`
 * and used by the explain/cause seams that read a cap's failure prose; the
 * develop gate's CAP claim is NOT read this way since #1765 lens round 3 — it
 * comes from the `RedBaselineVerdict` the probe returned, because the timed-out
 * arm leads its entry with the timeout label and prose cannot name it.
 */
export function baselineRedForCommand(failure: string, cmd: string): boolean {
  return failure.startsWith(BASELINE_RED_MARKER) && failure.includes(`\`${cmd}\``);
}

/**
 * The develop gate's mixed-set rule, over the whole failure list: at least one
 * `[baseline-red]` entry names `cmd`. Position decides nothing; the entries beside
 * it are the caller's business (secondary evidence), and `verifyCapFor` still
 * routes a timeout, host-exhaustion or residue entry ahead of this one — so a
 * `[baseline-red]` beside a `[verify-timeout]` stays `verify-timeout`.
 */
export function baselineRedForCmd(failures: readonly string[], cmd: string): boolean {
  return failures.some((f) => baselineRedForCommand(f, cmd));
}

/** The branch step's park on an established red base, as the step's own state. */
export function baseHealthPark(
  state: WorkState,
  verdict: BaseHealthVerdict,
  arm: RedBaselineVerdict,
): WorkState {
  const message = baselineRedMessage(arm, {
    cmd: verdict.command,
    baseSha: verdict.baseSha,
    timeoutMs: verdict.tierBoundMs,
    changeFailure: "",
  });
  const tally = arm.status === "red" ? summaryCount(arm.rawStream) : undefined;
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "verify-baseline-red:branch",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: `${message}${tally === undefined ? "" : `\nFailing at base: ${tally} test(s)`}`,
  });
}
