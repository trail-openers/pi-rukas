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
import type {
  BaseHealthConsulted,
  BaseHealthReport,
} from "./work-driver-verify-base-health-channels.ts";
import { baseHealthConsultedNote } from "./work-driver-verify-base-health-channels.ts";
import { compareWithBaseline } from "./work-driver-verify-baseline-compare.ts";
import { baselineExplainsChange } from "./work-driver-verify-baseline.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import { isValidSha, isVerifyTimeoutFailure } from "./work-driver-verify-develop-helpers.ts";
import type { BaseHealthKey, BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";

/** #1765 — reports whether the probe established the base red for the gate's command. */
export type BaselineRedEstablished = (established: boolean) => void;

/**
 * The consultation record and its operator note are declared ONCE, in
 * `work-driver-verify-base-health-channels.ts` — the one shape every layer of the
 * develop gate carries. The types are re-exported so the recorder and the gate
 * results keep the name they already read, and so a second copy cannot grow in
 * this module. The note function itself is NOT re-exported: every caller imports
 * it from the channels leaf beside the shape it renders, and a re-export nobody
 * imports is a second name for one thing.
 */
export type {
  BaseHealthConsulted,
  BaseHealthReport,
} from "./work-driver-verify-base-health-channels.ts";

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
  onConsulted?: (report: BaseHealthConsulted, secondRun?: BaseHealthVerdict["secondRun"]) => void,
): Promise<BaseHealthVerdict | undefined> {
  if (!isValidSha(baseSha)) return undefined;
  const key: BaseHealthKey = { baseSha, command: cmd, tierBoundMs: suiteTimeoutMs };
  const consulted = await awaitInflightBaseHealth(key, suiteTimeoutMs);
  // Nothing registered is not an error and not a verdict: it is the shape after a
  // resume in a new process, or when the probe's switches were off. The gate then
  // answers for the base on its own evidence, exactly as it did before #1765.
  if (consulted === undefined) return undefined;
  if (consulted.verdict.status === "unknown") return undefined;
  // Carried into the record the gate writes: the ms is the probe's own measured
  // wall clock, and it is the number the operator reads to judge what the probe
  // cost. `ran` and "did this come from the registry" are NOT reported — the only
  // producer of this record is the registry read, so the latter was a constant, and
  // no renderer ever showed the former. Both were dead fields wearing documentation.
  //
  // #1826 — and the second base run's colour travels with it, because a red that
  // came back green on the confirmation is a FLAKY base: the record of that is
  // otherwise the probe's local `notes`, which reach no operator. The colour is
  // read off the VERDICT the probe wrote (its one durable statement about the
  // second run), never off the consultation, so the two halves of the report
  // cannot disagree about what the probe saw.
  onConsulted?.(
    {
      status: consulted.verdict.status,
      baseSha,
      ...(consulted.outcome.ms === undefined ? {} : { ms: consulted.outcome.ms }),
      ...(consulted.verdict.timedOut === true ? { timedOut: true as const } : {}),
    },
    consulted.verdict.secondRun,
  );
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
   * The ONE channel this seam reports on (#1809 fix round): the collected verdict
   * and the consultation record travel as the two optional halves of one
   * `BaseHealthReport`, declared in
   * `work-driver-verify-base-health-channels.ts` and carried unchanged through
   * every layer above. Called once per consultation; a receiver that keeps both
   * halves must fold them (`mergeBaseHealthReport`), never assign.
   *
   * #1809 fix round — a RED the gate read out of the registry is NOT carried in
   * `collected`. A red is never cached across rounds, and
   * `pipelineState.baseHealthProbe` is exactly the field that survives a round (and
   * a resume), so persisting a consulted red would let the next develop pass reuse
   * a verdict it never ran for. Only a GREEN is collected.
   */
  onBaseHealth?: (report: BaseHealthReport) => void;
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
    onBaseHealth,
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
    let inFlightRed = false;
    let inFlightTimedOut = false;
    // #1809 fix round — the ONE channel's payload. Both halves are optional
    // properties and the callback fires ONCE, at the end, so no receiver on any
    // layer can lose a half to a later `undefined`.
    const report: BaseHealthReport = {};
    const inflight =
      baseHealthProbe === undefined
        ? await collectBackgroundBaseHealth(
            ctx,
            cmd,
            baseSha,
            suiteTimeoutMs,
            (consulted, secondRun) => {
              // One consultation, one record: the note is the operator's record of
              // the probe — written by the gate that consulted it, the only channel
              // the probe itself is no longer allowed to touch — and the consultation
              // record rides on the report below. A RED is the note exception:
              // `compareWithBaseline` leads `notes` with the finding that names the
              // base and its assertion, and a second line saying the same colour
              // would be two records of one consultation. The consultation record
              // still carries the red's colour and measured ms for the event log.
              if (consulted.status !== "red" || secondRun === "green") {
                // A RED whose confirmation came back green is the note exception's
                // exception: it is a FLAKY base, and the only operator-visible
                // record of that is this consultation line, so the colour and the
                // second run's colour are reported rather than swallowed (#1826).
                notes.push(baseHealthConsultedNote(baseSha ?? "", consulted, secondRun));
              }
              report.consulted = {
                ...consulted,
                ...(secondRun === undefined ? {} : { secondRun }),
              };
              // #1809 fix round — a consulted RED is kept OUT of the report's
              // `collected` half (the only writer of `pipelineState.baseHealthProbe`).
              // Two locks, one field: a red is never cached across rounds, AND a
              // consulted red is a single run until the confirmation ran, so
              // persisting it would hand the next develop pass a colour it never
              // earned twice. It still answers for THIS gate pass, which is what
              // `fromInFlightProbe` on the reuse below says — without it
              // `compareWithBaseline` would read this as an ordinary in-state verdict,
              // an in-state red is unreusable there by design, and this cycle would
              // silently pay for a second suite run it has already had judged.
              // `baseSha` is non-null: the consultation only happens after
              // `collectBackgroundBaseHealth` accepted the sha.
              if (consulted.status === "red") {
                inFlightRed = true;
                inFlightTimedOut = consulted.timedOut === true;
              }
            },
          )
        : undefined;
    // The report's `collected` half is what `recordDevelopGateEvents` writes to
    // `pipelineState.baseHealthProbe`, so it carries a GREEN only: the
    // consultation's own record already names a red's colour and cost, and the
    // field it would land in survives a develop round, which is exactly where a
    // red must not survive. The colour is read back from the consultation record,
    // never from `inflight?.status`, so the two halves of one report cannot
    // disagree about what the probe said.
    if (!inFlightRed && inflight !== undefined) report.collected = inflight;
    if (report.collected !== undefined || report.consulted !== undefined) {
      onBaseHealth?.(report);
    }

    // A verdict the cycle already holds wins over the registry's: it is the record
    // this cycle wrote, and a registry entry could answer for a different run. The
    // registry's own RED is flagged as this gate pass's, which is the only channel
    // `compareWithBaseline` accepts a red through.
    //
    // #1826 — and it carries `secondRun` verbatim. Without this projection the
    // reuse arm was rebuilt from the consultation's three fields, so a record the
    // probe had confirmed by watching BOTH base runs reached the comparison
    // looking like a single unconfirmed run: the gate paid to re-ask a question
    // that had been answered, its name rule then had no trees to anchor in (the
    // probe's throwaway checkouts are gone by now), and every legitimate red base
    // this path carried came back "names-disagree" — the defect that would have
    // made the two-run rule refuse every real red base.
    const verdictForReuse =
      baseHealthProbe ??
      (inflight === undefined
        ? undefined
        : inFlightRed
          ? {
              status: "red" as const,
              baseSha: baseSha as string,
              command: cmd,
              tierBoundMs: suiteTimeoutMs,
              ...(inFlightTimedOut ? { timedOut: true as const } : {}),
              ...(inflight.secondRun === undefined ? {} : { secondRun: inflight.secondRun }),
              fromInFlightProbe: true as const,
            }
          : inflight);
    const changeFailures = [
      ...(cons.status === "failed"
        ? [{ text: cons.rawFailure ?? "", timedOut: cons.timedOut === true }]
        : []),
      ...perWorktreeVerifyFailures.map((f) => ({
        text: f,
        timedOut: isVerifyTimeoutFailure(f),
      })),
    ];
    const comparison = await compareWithBaseline(execFn, {
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
    if (comparison === undefined) {
      onBaselineRedEstablished?.(false);
      return false;
    }
    // #1765 — the CAP's claim is the verdict's own colour, not a re-derivation
    // from the entry `compareWithBaseline` appended: the returned arm says whether
    // the probe established a red base for the command THIS gate ran (it is built
    // from the same `cmd`), and the `red-timed-out` arm leads its failure entry
    // with `[verify-timeout]`, so prose could never have told it from a killed
    // run. A reused verdict is still the base's colour, so it still raises the cap.
    // #1826 — and `established` is the two-run answer beneath it: a base red twice
    // (or a reuse whose record states a confirmed second run). A single red run
    // never reaches here, so neither claim channel can fire on one.
    onBaselineRedEstablished?.(comparison.established);
    // #1765 — the excuse question is #1349's and stays its answer; what changed is
    // how the develop gate RAISES the cap on it. It used to require the probe's
    // entry to be the gate's ONLY failure at its own position, so one foreign
    // failure beside it (a scope fence pushed before the verify chain) dropped
    // `verify-baseline-red` to `verify-failed` and one measured cycle burned
    // three develop rounds on a base nothing could pass. A reused verdict
    // states the base's colour only: no stream, so
    // nothing to match the change's failures against, so never an excuse.
    const attributed =
      comparison.established &&
      comparison.verdict.reused !== true &&
      baselineExplainsChange(comparison.verdict, changeFailures);
    if (attributed) onBaselineAttributed?.();
    return attributed;
  }
  return false;
}
