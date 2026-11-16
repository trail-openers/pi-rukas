/**
 * lean/verify-red-reason — what a RED tells the builder when two gates broke.
 *
 * `verify` reports the FIRST failure among the frozen contract and the project tiers. That order
 * is right for a verdict, but a reason is also pasted into the next developer's prompt: a run
 * whose frozen tests were red AND whose `verify.full` was red at head names only the contract, the
 * builder fixes the frozen files, the next verify finds the tier, and a whole build round goes to
 * learn one fact the first pass had already observed. So every red at head is named.
 *
 * The composition rule is one sentence of prose with three arms:
 *
 *   - **frozen green** — nothing changes; whatever `firstFailure` picked stands;
 *   - **frozen red, tier red at head** — the frozen clause first, then `" — and "` and the tier's
 *     own failure clause. The frozen clause leads because the contract is the run's own gate, and
 *     the one thing a builder may never edit to get a green;
 *   - **frozen red, tier red at the base too** — the frozen clause first, then `" — and "` and the
 *     arm's `baseline red:` sentence.
 *
 * This does NOT compose a tier that went GREEN on its re-run (a flake is not evidence about the
 * work), nor an infra tier result — the caller throws before composing. Only the step's own reason
 * passes through here.
 */

import { baselineRedReason } from "./verify-baseline.ts";

/** The joiner between the two clauses of one red reason. */
const JOINER = " — and ";

/**
 * What the step's own pass over the frozen contract said, beside the tiers.
 *
 * `reason` is the frozen tests' failure text (empty for a green contract, which composes nothing);
 * `red` is the contract's own colour, the only state in which a second clause is composed.
 * `judgedBeforeTiers` is identity against the main pass's result — the only one whose verdict
 * describes the tree the tiers started on. The baseline arm re-runs the contract AFTER a tier may
 * have touched the tree, so a red it observes there is not a fact about the tiers' input; only that
 * arm's hang still composes.
 */
export interface FrozenClause {
  reason: string;
  red: boolean;
  judgedBeforeTiers: boolean;
}

/** A green contract composes nothing; a red one carries its own text. */
export function frozenClause(tests: { kind: string; reason?: string }): FrozenClause {
  return {
    reason: tests.reason ?? "",
    red: tests.kind === "fail",
    judgedBeforeTiers: true,
  };
}

/**
 * A plain red whose frozen tests are red AND whose tier is red at head. `undefined` when there is
 * nothing to compose — the frozen tests passed, or the contract's colour was decided after the
 * tier ran — and the caller keeps the single clause `firstFailure` chose.
 */
export function composedTierRed(frozen: FrozenClause, tierReason: string): string | undefined {
  if (!frozen.red || !frozen.judgedBeforeTiers) return undefined;
  return `${frozen.reason}${JOINER}${tierReason}`;
}

/**
 * The baseline arm's red: the contract is red and the tier is red at the base commit.
 *
 * `undefined` means keep the arm's own hand-back, so every existing pin on the `baseline red:`
 * prefix stays valid. A hang composes even when the arm re-ran the contract, because the timeout
 * wording lives or dies on this line.
 */
export function composedBaselineRed(
  frozen: FrozenClause,
  tierName: string,
  cmd: string,
  baseSha: string,
  timeoutWording: boolean,
): string | undefined {
  if (!frozen.red) return undefined;
  if (!frozen.judgedBeforeTiers && !timeoutWording) return undefined;
  return `${frozen.reason}${JOINER}${baselineRedReason(tierName, cmd, baseSha)}`;
}
