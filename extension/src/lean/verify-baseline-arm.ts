/**
 * lean/verify-baseline-arm — what `verify` does with a tier the BASE commit already fails.
 *
 * The step has established that one project tier is red at HEAD twice and that a probe of the run's
 * `baseSha` answered `red` for the same command. Three outcomes are possible and only one of them is the
 * ordinary red:
 *
 *   - **the run is graded GREEN for that tier**, with its failures recorded, when every failure line the
 *     head run printed also appears among the base run's and the run's own frozen contract passes here — a
 *     gate the mainline authored, which no build round can fix (the rule itself is `baselineExcuse`);
 *   - **a RED that hands the run back**: any other answer from the excuse, or a re-run that observed
 *     nothing;
 *   - **a RED whose first clause is the frozen contract**, which is the case this module exists for.
 *
 * The frozen verdict is asked FIRST, on purpose: the ordinary `firstFailure` in the step never sees it once
 * this arm returns, so a run whose own acceptance tests are red must not be graded green on the strength of
 * a tier the base also fails. A RED the step already observed before the tiers ran is REUSED rather than
 * re-run — re-running the contract would pay the per-file wall clock a second time in one verify. A GREEN
 * `tests` is no evidence about the contract here, so that case re-runs it.
 *
 * The reason a red comes back with is composed by `verify-red-reason.ts`.
 *
 * The PROJECT ROSTER has precedence over the whole-line excuse, and `arbitrate` is how
 * the step hands that judgement in: it is asked BEFORE `baselineExcuse`, and a `red` from it ends
 * the arm. An `uninvolved` answer — the roster could not read this tier's report — leaves the line
 * rule in charge, which is what the arm did before the roster existed. The two judgements are
 * never combined: a roster red is never made green by a line match, and a roster excuse is recorded
 * rather than re-argued.
 */

import { PREEXISTING_NAME_MAX_CHARS } from "./state-outcome-maps.ts";
import type { PreexistingTierRecord } from "./state-outcome-maps.ts";
import { baselineExcuse, failureLinesOf } from "./verify-baseline-excuse.ts";
import { baselineProbeWorktreePath } from "./verify-baseline.ts";
import { type BaseProbe, baselineRedReason, tierObserved } from "./verify-baseline.ts";
import { type FrozenClause, composedBaselineRed } from "./verify-red-reason.ts";
import type { RosterArbitration } from "./verify-roster.ts";
import { FROZEN_TIMEOUT_HEAD, frozenTestFailure } from "./verify-steps.ts";
import type { Executed } from "./verify-steps.ts";
import type { VerifyExec } from "./verify-types.ts";

/**
 * How many of the head's failing lines one red reason names. Past it the reason says how many it
 * left out rather than dropping them without a word.
 */
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
 * Settle a tier that is red at HEAD twice and red at the base.
 *
 * `tests` is the contract's verdict from the pass that ran BEFORE the tiers; when it was green the
 * contract is re-run here.
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
   * The roster's answer about this tier, asked before the line excuse. Optional because the arm is
   * also reached on the roster switch's off arm, where there is no roster to ask; the step passes a
   * function that answers `uninvolved` in that case rather than making the hook optional at the call
   * site, so no caller can forget it.
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
  // The roster before the line excuse: where it saw a name passing at base now failing, no line
  // match may excuse it. It comes AFTER the observation question because both its answers are read
  // from the re-run's stream, and a killed or un-startable run still prints text that can name those
  // tests — grading one would read bytes nobody saw produced.
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

/**
 * The head's failing lines this step READ, bounded, with the count it left off the list. Empty for
 * an output whose lines the classifier could not read; a refusal still has to say something then.
 */
function headFailureNames(stream: string): string[] {
  const all = failureLinesOf(stream).map((line) =>
    line.length > PREEXISTING_NAME_MAX_CHARS ? line.slice(0, PREEXISTING_NAME_MAX_CHARS) : line,
  );
  if (all.length === 0) return [];
  const kept = all.slice(0, BASELINE_RED_NAMES_CAP);
  // The count of what was left out rides on the sentence rather than being silent: the reader of
  // the reason sees `omitted 5 more` beside the names that ARE listed.
  return all.length > kept.length
    ? [...kept, `omitted ${String(all.length - kept.length)} more`]
    : kept;
}
