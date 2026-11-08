/**
 * lean/verify-baseline-arm — what `verify` does with a tier the BASE commit already
 * fails.
 *
 * The step has established, by this point, that one project tier is red at HEAD twice
 * and that a probe of the run's `baseSha` answered `red` for the same command. Three
 * outcomes are possible and only one of them is the ordinary red:
 *
 *   - **the run is graded GREEN for that tier**, with its failures recorded, when every
 *     failure line the head run printed also appears among the base run's and the run's
 *     own frozen contract passes here — a gate the mainline authored, which no build
 *     round can fix (the rule itself is `baselineExcuse`);
 *   - **a RED that hands the run back**: any other answer from the excuse, or a
 *     re-run that observed nothing;
 *   - **a RED whose first clause is the frozen contract**, which is the case this
 *     module exists for.
 *
 * The frozen verdict is asked FIRST, on purpose: the ordinary `firstFailure` in the
 * step never sees it once this arm returns, so a run whose own acceptance tests are red
 * must not be graded green on the strength of a tier the base also fails. A RED the
 * step already observed before the tiers ran is REUSED rather than re-run — this arm is
 * only reached with that verdict in hand, and re-running the contract would pay the
 * per-file wall clock a second time in one verify, which for a hang is a whole extra
 * bound spent on an answer already in a variable. A GREEN `tests` is no evidence about
 * the contract here (a tier may have rewritten the tree since it ran, and this arm asks
 * what the contract says NOW), so that case re-runs it.
 *
 * The reason a red comes back with is composed by `verify-red-reason.ts`: the
 * contract's clause leads and the arm's `baseline red:` sentence rides beside it, so
 * the next build child reads both defects in its brief instead of being sent to find
 * one at a time.
 */

import type { PreexistingTierRecord } from "./state-outcome-maps.ts";
import { baselineExcuse } from "./verify-baseline-excuse.ts";
import { baselineProbeWorktreePath } from "./verify-baseline.ts";
import { type BaseProbe, baselineRedReason, tierObserved } from "./verify-baseline.ts";
import { type FrozenClause, composedBaselineRed } from "./verify-red-reason.ts";
import { FROZEN_TIMEOUT_HEAD, frozenTestFailure } from "./verify-steps.ts";
import type { Executed } from "./verify-steps.ts";
import type { VerifyExec } from "./verify-types.ts";

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
 * `tests` is the contract's verdict from the pass that ran BEFORE the tiers; when it
 * was green the contract is re-run here, which is why `frozen`, `verifyTest`, `wt`,
 * `exec` and `timeoutMs` are all passed through rather than a single colour.
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
    );
    return { red: reason ?? baselineRedReason(name, cmd, baseSha) };
  }
  if (frozenRan.kind === "infra") return { throwReason: frozenRan.reason };
  // The excuse reads the re-run's OUTPUT, so the re-run must have OBSERVED the work.
  // `confirmTierRedFrom` already refused to call an unobserved re-run a flake, but a
  // kill, an overflow or an un-startable command still arrives with a `stdout` — the
  // text the tier printed before the signal — and that text can name the very tests the
  // base printed. An excuse built from it would grade a green over a tier nobody saw
  // fail twice, which is the outcome this arm exists to refuse.
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
  if (excuse.kind === "refused") return { red: baselineRedReason(name, cmd, baseSha) };
  return { preexisting: excuse.record };
}
