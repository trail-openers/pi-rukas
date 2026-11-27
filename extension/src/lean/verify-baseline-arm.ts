/**
 * lean/verify-baseline-arm — what `verify` does with a tier the BASE commit already fails.
 *
 * The step has established that one project tier is red at HEAD twice and a probe of the run's `baseSha`
 * answered `red` for the same command. Three outcomes, only one the ordinary red:
 *
 *   - **GREEN for that tier**, its failures recorded, when every failure line the head printed also appears
 *     among the base run's and the run's frozen contract passes here — a gate the mainline authored (the
 *     rule is `baselineExcuse`);
 *   - **a RED that hands the run back**: any other answer from the excuse, or a re-run that observed
 *     nothing;
 *   - **a RED whose first clause is the frozen contract**, which is the case this module exists for.
 *
 * The frozen verdict is asked FIRST, on purpose: the step's ordinary `firstFailure` never sees it once this
 * arm returns, so a run whose own acceptance tests are red cannot be graded green on the strength of a tier
 * the base also fails. A RED the step observed before the tiers ran is REUSED — a second contract run would
 * pay the per-file wall clock twice in one verify. A GREEN `tests` proves nothing here, so that case re-runs
 * it. `verify-red-reason.ts` composes the reason.
 *
 * The PROJECT ROSTER has precedence over the whole-line excuse: `arbitrate` is asked BEFORE
 * `baselineExcuse` and a `red` from it ends the arm. `uninvolved` — the roster could not read this
 * tier's report — leaves the line rule in charge. The two judgements are never combined: a roster
 * red is never made green by a line match, and a roster excuse is recorded rather than re-argued.
 */

import { PREEXISTING_NAME_MAX_CHARS, type PreexistingTierRecord } from "./state-outcome-maps.ts";
import { baselineExcuse, failureLinesOf } from "./verify-baseline-excuse.ts";
import { baselineProbeWorktreePath } from "./verify-baseline.ts";
import { type BaseProbe, baselineRedReason, tierObserved } from "./verify-baseline.ts";
import { type FrozenClause, composedBaselineRed } from "./verify-red-reason.ts";
import type { RosterArbitration } from "./verify-roster.ts";
import { FROZEN_TIMEOUT_HEAD, frozenTestFailure } from "./verify-steps.ts";
import type { Executed } from "./verify-steps.ts";
import type { VerifyExec } from "./verify-types.ts";

/** How many of the head's failing lines one red reason names; past it it says how many it left out. */
export const BASELINE_RED_NAMES_CAP = 20;

/** What the arm decided; exactly one field is set. */
export interface BaselineRedArm {
  /** The red reason, already composed. */
  red?: string;
  /** The tier's excuse record, for the green the step may then record. */
  preexisting?: PreexistingTierRecord;
  /** Why this is infrastructure rather than a verdict — the step turns it into a throw. */
  throwReason?: string;
}

/**
 * Settle a tier red at HEAD twice and red at the base. `tests` is the contract's verdict from the pass
 * that ran BEFORE the tiers; when it was green, the contract is re-run here.
 */
export async function baselineRedArm(opts: {
  frozen: Record<string, string>;
  frozenClause: FrozenClause;
  tests: Executed;
  name: string;
  cmd: string;
  rerun: { ran: unknown; stream: string };
  probe: BaseProbe & { stream?: string };
  verifyTest: string | undefined;
  wt: string;
  repoRoot: string;
  baseSha: string;
  exec: VerifyExec;
  timeoutMs: number;
  /** Identifies the probe's throwaway tree, which the excuse's two-tree test reads. */
  issue: number;
  /**
   * The roster's answer about this tier, asked before the line excuse. Required even on the roster
   * switch's off arm, where the step passes a function answering `uninvolved` — so no caller can
   * forget it.
   */
  arbitrate: () => RosterArbitration;
}): Promise<BaselineRedArm> {
  const { name, cmd, baseSha, tests } = opts;
  const frozenRan =
    tests.kind === "fail"
      ? tests
      : await frozenTestFailure(opts.frozen, opts.verifyTest, opts.wt, opts.exec, opts.timeoutMs);
  if (frozenRan.kind === "fail") {
    const reason = composedBaselineRed(
      { ...opts.frozenClause, judgedBeforeTiers: frozenRan === tests },
      name,
      cmd,
      baseSha,
      frozenRan.reason.startsWith(FROZEN_TIMEOUT_HEAD),
      headFailureNames(opts.rerun.stream),
    );
    return {
      red: reason ?? baselineRedReason(name, cmd, baseSha, headFailureNames(opts.rerun.stream)),
    };
  }
  if (frozenRan.kind === "infra") return { throwReason: frozenRan.reason };
  // The roster before the line excuse: a name it saw passing at base and failing now admits no line
  // match. It is asked only of an OBSERVED re-run — its answers come from that stream, and bytes
  // nobody saw produced grade nothing.
  const arbitration = tierObserved(opts.rerun.ran)
    ? opts.arbitrate()
    : { kind: "uninvolved" as const };
  if (arbitration.kind === "red") return { red: arbitration.reason };
  if (arbitration.kind === "excused") return { preexisting: arbitration.record };
  // The excuse reads the re-run's OUTPUT, so the re-run must have OBSERVED the work. A kill, an overflow
  // or an un-startable command still arrives with a `stdout` — the text the tier printed before the signal
  // — and that text can name the very tests the base printed.
  if (!tierObserved(opts.rerun.ran)) return {};
  const excuse = baselineExcuse({
    tierName: name,
    cmd,
    baseSha,
    probe: opts.probe,
    headStream: opts.rerun.stream,
    baseStream: opts.probe.stream,
    headRoot: opts.wt,
    probeRoot: baselineProbeWorktreePath(opts.repoRoot, opts.issue),
  });
  if (excuse.kind === "refused")
    return { red: baselineRedReason(name, cmd, baseSha, headFailureNames(opts.rerun.stream)) };
  return { preexisting: excuse.record };
}

/** A name past the disclosure's per-row bound is clipped so one row cannot crowd out the rest. The roster
 * bounds a name by this ceiling, one shorter than the record reader's own (`ROSTER_PATH_MAX_CHARS`): a
 * roster name is a test name, so it is bounded by the rule for names, while the wider ceiling stays the
 * reader's backstop for any roster it is handed. Exported so the roster and the excuse arm clip once. */
export const clipName = (line: string) =>
  line.length > PREEXISTING_NAME_MAX_CHARS ? line.slice(0, PREEXISTING_NAME_MAX_CHARS) : line;

/**
 * The head's failing lines this step READ: the bounded list, plus a separate count sentence for what
 * the cap left off. The count is NOT a list item — every item is a failing line — and it is a sentence
 * THIS step wrote, which is what tells it apart from project bytes saying the same words.
 */
function headFailureNames(stream: string): [names: readonly string[], omitted?: string] {
  const all = failureLinesOf(stream);
  const kept = all.slice(0, BASELINE_RED_NAMES_CAP).map(clipName);
  const omitted =
    all.length > kept.length ? `omitted ${String(all.length - kept.length)} more` : undefined;
  return omitted === undefined ? [kept] : [kept, omitted];
}
