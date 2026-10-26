/**
 * work-driver-verify-base-park — #1765: the prose rules that read a probe
 * entry, and the record a probe leaves for the develop gate.
 *
 * Split out of `work-driver-verify-base-health.ts` for the AGENTS.md §12
 * 500-line cap. It is a LEAF: the probe imports it and nothing here imports the
 * probe, so the module graph the round-1 import cycle was made of stays closed.
 *
 * The park on a red base no longer happens at the branch step. A red base is
 * attributed at the develop gate as `verify-baseline-red:develop`, which already
 * carries correct handoff prose, so this module builds no cap-hit event: the
 * probe keeps the `red` arm it earned (via `BaseHealthProbeOutcome.park`'s
 * replacement, `BaseHealthRedEvidence`) so the verdict's own colour and tally
 * survive to the seam that does the attributing.
 */
import {
  type BaseRedConfirmationResult,
  baseRunsProse,
} from "./work-driver-verify-base-confirm.ts";
import { type RedBaselineVerdict, baselineRedMessage } from "./work-driver-verify-baseline.ts";
import { summaryCount } from "./work-driver-verify-names.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";

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

/**
 * The evidence an established RED carries out of the probe: the message the
 * develop gate's handoff renders, and the gate's own tally when it printed one
 * (so the operator sees which suite broke rather than only that it did). Built
 * from the arm the probe itself earned, which is why a verdict cannot be
 * attributed to a run nobody performed.
 */
export interface BaseHealthRedEvidence {
  /** The `[baseline-red]` prose, as the cap's evidence renders it. */
  message: string;
  /** The loop's own `FAILED: <n> test(s)` tally, when the stream carried one. */
  tally?: number;
  /**
   * #1826 — the two base runs the red rests on, as one clause naming each
   * run and its outcome. The single-arm prose could not say whether one run or
   * two said "red", which is the whole question this issue exists to answer.
   */
  baseRuns?: string;
}

/** The red evidence a probe hands to the develop gate, or nothing for no red. */
export function baseHealthRedEvidence(
  verdict: BaseHealthVerdict,
  arm: RedBaselineVerdict,
  confirmation?: BaseRedConfirmationResult,
): BaseHealthRedEvidence {
  // The arm decides the sentence, so a killed base is never dressed as a plain red:
  // `baselineRedMessage` writes the bound's line for `red-timed-out` and an
  // assertion's line for `red`, and rebuilding one from the other is the #1765
  // lens-round-1 defect that told an operator to fix a test nobody ran.
  const tally = arm.status === "red" ? summaryCount(arm.rawStream) : undefined;
  const baseRuns = confirmation === undefined ? "" : baseRunsProse(confirmation);
  return {
    message: `${baselineRedMessage(arm, {
      cmd: verdict.command,
      baseSha: verdict.baseSha,
      timeoutMs: verdict.tierBoundMs,
      changeFailure: "",
    })}${baseRuns === "" ? "" : ` — ${baseRuns}`}`,
    ...(tally === undefined ? {} : { tally }),
    ...(baseRuns === "" ? {} : { baseRuns }),
  };
}
