/**
 * work-driver-verify-aggregate — the develop verify gate's post-run half:
 * reconcile the consolidated result with the per-worktree failures, then
 * attribute a failure against the base commit.
 *
 * Why this seam: `runVerifyCommandGate` in
 * `work-driver-verify-verify-cmd.ts` had grown to 542 lines, past the
 * 500-line cap AGENTS.md §12 enforces. Once the per-worktree loop has run and
 * the consolidated run has reported, what remains is a POST-RECONCILIATION
 * step with no more runs in it — it reads two already-computed values and the
 * caller's `failures`/`notes`, and it is the only place the baseline probe is
 * paid for. Splitting it leaves the two execution legs (per-worktree,
 * consolidated) exactly where they were, which matters: their ordering, the
 * #782 flake-retry precondition and the #1427 hang-report sink are
 * concurrency-sensitive and were not what overflowed the cap.
 *
 * Import chain: work-driver-verify-verify-cmd.ts → this file →
 * work-driver-verify-baseline.ts (acyclic; the caller already imports that
 * module for the same call, so no new dependency edge is introduced).
 *
 * The base-health await: the branch step no longer waits for the base probe, so
 * when THIS seam is about to pay for a base run it first collects the background
 * verdict — the one place the probe is awaited, reached only under the same
 * condition that already pays for `compareWithBaseline`, so a passing cycle never
 * waits for it.
 */

import { awaitInflightBaseHealth } from "./work-driver-base-health-inflight.ts";
import type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify-types.ts";
import type { CycleContext, DriverExecFn } from "./work-driver-context.ts";
import { isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import { baselineExplainsChange, compareWithBaseline } from "./work-driver-verify-baseline.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import { isValidSha, isVerifyTimeoutFailure } from "./work-driver-verify-develop-helpers.ts";
import type { BaseHealthKey, BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";

/** #1765 — reports whether the probe established the base red for the gate's command. */
export type BaselineRedEstablished = (established: boolean) => void;

/**
 * What the develop gate saw when it consulted the background base probe: the
 * verdict's colour and the probe's own measured wall clock. This is the
 * operator-visible record of a probe that used to be a branch-step event, and the
 * gate that consulted it is the only place able to write it — a background task
 * writing state would race the develop step.
 */
export interface BaseHealthConsulted {
  status: "green" | "red";
  /** The base the verdict speaks for, so a reader can name it. */
  baseSha: string;
  /** The probe's measured run time; absent when it ran nothing (a cache answer). */
  ms?: number;
  /** True when the probe ran its own suite (false = a cache or in-state answer). */
  ran?: boolean;
  /** The red came from the timed-out arm — the operator must not be told to fix a test. */
  timedOut?: true;
  /** True when the verdict came from the registry rather than the state or cache. */
  fromRegistry?: boolean;
}

/** The operator's note for a consulted verdict, as the develop gate records it. */
export function baseHealthConsultedNote(baseSha: string, report: BaseHealthConsulted): string {
  const timing =
    report.ms === undefined ? "no suite run of its own" : `its own run measured ${report.ms} ms`;
  const colour =
    report.timedOut === true
      ? `${report.status.toUpperCase()} (probe timed out)`
      : report.status.toUpperCase();
  return `base-health: the develop gate consulted the background probe — base ${(baseSha || report.baseSha).slice(0, 12)} ${colour} (${timing})`;
}

/**
 * #1765 — the develop gate's tail rule, in one call so the two claims travel
 * from the one place that decides them. Both are read off the ONE verdict the
 * baseline probe returned (`aggregateVerifyOutcome` is its only producer):
 * `established` is that verdict's colour — the CAP — and `red` is #1349's
 * excuse question about it. Neither is re-derived from the failure prose: the
 * `red-timed-out` arm leads its entry with `[verify-timeout]`, so matching the
 * `[baseline-red]` marker in the list cannot tell a base the probe proved red
 * from a killed run, and only the structured verdict knows which it judged.
 * `verifyCapFor` still routes a no-verdict entry the gates after the verify
 * command append (a killed run, residue) ahead of both claims.
 */
export function reportBaselineLeg(
  leg: { red: boolean; established: boolean },
  callbacks: { onBaselineRedOnly?: () => void; onBaselineRedEstablished?: () => void },
): void {
  if (leg.established) callbacks.onBaselineRedEstablished?.();
  if (leg.red) callbacks.onBaselineRedOnly?.();
}

/**
 * Consult the background base probe for this gate's key, and report the verdict
 * to the caller so it lands in state. Answers "nothing" — leave the cap exactly as
 * the gate chose it and let `compareWithBaseline` re-probe — when nothing is
 * registered for the key (the shape after a resume in a new process), when the
 * probe did not answer inside its bound, or when its verdict is `unknown`.
 *
 * BOTH colours of an answer are reusable: a GREEN is what a resumed cycle must not
 * pay a second suite run for, and a RED is the `verify-baseline-red:develop`
 * attribution. `unknown` records nothing, which is why it is not passed on.
 *
 * The await is the whole point of this seam: the branch step used to block on the
 * probe for the length of a full verify run (measured median 711 s on a busy
 * mainline, where the green cache is cold on essentially every cycle). Here it is
 * paid for only by a cycle whose own verify has already failed — the same condition
 * that already pays for `compareWithBaseline` — and bounded by the same tier bound.
 */
async function collectBackgroundBaseHealth(
  ctx: CycleContext,
  cmd: string,
  baseSha: string | undefined,
  suiteTimeoutMs: number,
  onConsulted?: (report: BaseHealthConsulted) => void,
): Promise<BaseHealthVerdict | undefined> {
  if (!isValidSha(baseSha)) return undefined;
  const key: BaseHealthKey = { baseSha, command: cmd, tierBoundMs: suiteTimeoutMs };
  const consulted = await awaitInflightBaseHealth(key, suiteTimeoutMs);
  if (consulted === undefined || consulted.verdict.status === "unknown") return undefined;
  // Carried into the record the gate writes: the ms is the probe's own measured
  // wall clock, and it is the number the operator reads to judge what the probe cost.
  onConsulted?.({
    status: consulted.verdict.status,
    baseSha,
    ms: consulted.outcome.ms,
    ran: consulted.outcome.ran,
    ...(consulted.verdict.timedOut === true ? { timedOut: true as const } : {}),
    fromRegistry: true,
  });
  return consulted.verdict;
}

/**
 * Reconcile and attribute. Returns whether the baseline probe ATTRIBUTED the
 * failure — the caller turns that into its `verifyCmdEnd` marker.
 */
export async function aggregateVerifyOutcome(args: {
  execFn: DriverExecFn;
  ctx: CycleContext;
  cmd: string;
  baseSha: string | undefined;
  /** The suite tier's bound, resolved ONCE by the caller and threaded here. */
  suiteTimeoutMs: number;
  /** The consolidated run's outcome, already reported to `failures`/`notes`. */
  cons: ConsolidatedVerifyResult;
  /** Failures the per-worktree leg recorded; kept as failures regardless. */
  perWorktreeVerifyFailures: string[];
  failures: string[];
  notes: string[];
  /** #1349 — the base run fails the way the change's run does (the excuse). */
  onBaselineAttributed?: () => void;
  /**
   * #1765 — the probe ESTABLISHED a red base for `cmd`, whatever the excuse
   * question answered: the excuse ("every failure is the base's") is voided by
   * one foreign entry, and pricing the CAP on it spent three develop rounds on a
   * base nothing could pass (one measured cycle). Position decides nothing — the
   * timed-out arm leads with `[verify-timeout]` — so the rule is attribution to
   * the command the probe re-ran. The no-verdict families keep their precedence
   * inside `verifyCapFor`, so a killed run is still the actionable timeout.
   */
  onBaselineRedEstablished?: BaselineRedEstablished;
  /** #1765 — the cycle's own base verdict, when the cycle holds one. */
  baseHealthProbe?: BaseHealthVerdict;
  /**
   * Reports the verdict this seam collected from the BACKGROUND base probe, so
   * the caller can record it into state — the only path by which a background
   * probe's verdict ever reaches `pipelineState.baseHealthProbe`. Called only
   * when a probe was actually running for this cycle's key, and never on a
   * cycle whose verify passed.
   */
  onBaseHealthCollected?: (verdict: BaseHealthVerdict) => void;
  /** Reports the verdict this gate consulted from the background probe. */
  onBaseHealthConsulted?: (report: BaseHealthConsulted) => void;
}): Promise<boolean> {
  const {
    execFn,
    ctx,
    cmd,
    baseSha,
    suiteTimeoutMs,
    cons,
    perWorktreeVerifyFailures,
    failures,
    notes,
    onBaselineAttributed,
    onBaselineRedEstablished,
    onBaseHealthCollected,
    onBaseHealthConsulted,
    baseHealthProbe,
  } = args;

  // Aggregation: a consolidated FAILURE keeps per-worktree failures as
  // failures. A consolidated PASS does NOT downgrade them (#1005 reverses the
  // #669 downgrade): a workstream that fails in its OWN tree must block, even
  // when the combined tree passes — a combined run that passes does not excuse
  // a workstream that fails on its own (the #933/#996 shape: 0/5 and 1/5
  // workstreams passing their own gate, the split halves coupled). The
  // per-worktree failure is kept as a failure AND the passing consolidated run
  // is still noted (the evidence that the combination is not the cause is
  // preserved in the note; the per-worktree defect is not excused).
  if (perWorktreeVerifyFailures.length > 0) {
    failures.push(...perWorktreeVerifyFailures);
    for (const f of perWorktreeVerifyFailures) {
      notes.push(
        `per-worktree verify (evidence; still a failure — the consolidated pass does not excuse a per-worktree defect, #1005) — ${f}`,
      );
    }
  }

  // Baseline comparison — ONLY once the verify command has already failed
  // (never on the happy path: it costs a full gate run). Not when the host
  // could not fork: the probe cannot run there either, and its "red at base"
  // would be the same environment failure read as a verdict. See
  // work-driver-verify-baseline.ts.
  if (
    (cons.status === "failed" || perWorktreeVerifyFailures.length > 0) &&
    !failures.some(isHostExhaustionFailure)
  ) {
    // The probe that used to stall the branch step is collected HERE, and only
    // here: this is the one point in a cycle that was already going to pay for a
    // run at base, and it is reached only when the change's own verify failed.
    // A cycle that passed never waits for the probe. A verdict the cycle already
    // holds in state wins — it is the same record, and reading the in-flight one
    // over it could answer for a different run than the one the cycle recorded.
    const inflight =
      baseHealthProbe === undefined
        ? await collectBackgroundBaseHealth(ctx, cmd, baseSha, suiteTimeoutMs, (report) => {
            // One report, two consumers: the caller records the verdict into
            // state, and this note is the operator's record of the probe —
            // written by the gate that consulted it, the only channel the probe
            // itself is no longer allowed to touch.
            notes.push(baseHealthConsultedNote(baseSha ?? "", report));
            onBaseHealthConsulted?.(report);
          })
        : undefined;
    // A verdict the cycle already holds wins over the registry's: it is the record
    // this cycle wrote, and a registry entry could answer for a different run.
    const verdictForReuse = baseHealthProbe ?? inflight;
    const changeFailures = [
      ...(cons.status === "failed"
        ? [{ text: cons.rawFailure ?? "", timedOut: cons.timedOut === true }]
        : []),
      ...perWorktreeVerifyFailures.map((f) => ({
        text: f,
        timedOut: isVerifyTimeoutFailure(f),
      })),
    ];
    const verdict = await compareWithBaseline(execFn, {
      repoRoot: ctx.repoRoot,
      baseSha: baseSha as string,
      issue: ctx.issue,
      cmd,
      timeoutMs: suiteTimeoutMs,
      // The base probe runs the project's own command, so it gets the same
      // scrubbed env the change run got (#1642).
      env: verifyChildEnv(),
      changeFailures,
      failures,
      notes,
      // #1765 — the cycle's verdict for this key, in-state or collected from
      // the background probe above: no second suite run pays for a verdict the
      // cycle already holds.
      ...(verdictForReuse !== undefined ? { cachedVerdict: verdictForReuse } : {}),
    });
    if (verdict === undefined) {
      onBaselineRedEstablished?.(false);
      return false;
    }
    // #1765 — the CAP's claim is the verdict's own colour, not a re-derivation
    // from the entry `compareWithBaseline` appended: the returned arm says whether
    // the probe established a red base for the command THIS gate ran (it is built
    // from the same `cmd`), and the `red-timed-out` arm leads its failure entry
    // with `[verify-timeout]`, so prose could never have told it from a killed
    // run. A reused verdict is still the base's colour, so it still raises the cap.
    onBaselineRedEstablished?.(true);
    // #1765 — the excuse question is #1349's and stays its answer; what changed is
    // how the develop gate RAISES the cap on it. It used to require the probe's
    // entry to be the gate's ONLY failure at its own position, so one foreign
    // failure beside it (a scope fence pushed before the verify chain) dropped
    // `verify-baseline-red` to `verify-failed` and one measured cycle burned
    // three develop rounds on a base nothing could pass. A reused verdict
    // states the base's colour only: no stream, so
    // nothing to match the change's failures against, so never an excuse.
    const attributed = verdict.reused !== true && baselineExplainsChange(verdict, changeFailures);
    if (attributed) onBaselineAttributed?.();
    return attributed;
  }
  return false;
}
