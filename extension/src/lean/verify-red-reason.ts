/**
 * lean/verify-red-reason — what a RED tells the builder when two gates broke.
 *
 * `verify` runs the frozen contract first and the project tiers after it, and it
 * reports the FIRST failure among them. That order is right for a verdict — one red
 * is one red — but a reason is not only a verdict: `build`'s re-entry reads it back
 * out of the step log and pastes it into the next developer's prompt under "Why this
 * round exists". A run whose frozen tests were red AND whose `verify.full` was red at
 * head names only the contract, the builder fixes the frozen files, the next verify
 * finds the tier, and a whole build round goes to learn one fact the first pass had
 * already observed. So every red at head is named.
 *
 * So the composition rule here is one sentence of prose with three arms:
 *
 *   - **frozen green** — nothing changes. Whatever `firstFailure` picked stands, and
 *     every reason the step has always produced is byte-identical;
 *   - **frozen red, tier red at head** (the base probe did not excuse it) — the frozen
 *     clause first, then `" — and "` and the tier's own failure clause. The frozen
 *     clause leads because the contract is the run's own gate, and the one thing a
 *     builder may never edit to get a green;
 *   - **frozen red, tier red at the base too** — the frozen clause first, then
 *     `" — and "` and the arm's `baseline red:` sentence. That is what a timed-out
 *     contract already did; a plain red now says the same thing, so the next build
 *     child is never told only "fix the contract" when the contract was not the only
 *     thing that broke.
 *
 * Two things this deliberately does NOT compose:
 *
 *   - a tier that went GREEN on its re-run contributes nothing. A flake is not
 *     evidence about the work, and a clause inviting the builder to "fix" it is a
 *     round spent on a test that just passed;
 *   - an infra tier result never arrives here at all — the caller throws before
 *     composing, because a killed, overflowed or un-startable tier observed nothing.
 *
 * Only the step's own reason passes through here. The handback comment and the PR
 * body clip the record's tail for their own readers and are unchanged.
 */

import { baselineRedReason } from "./verify-baseline.ts";

/** The joiner between the two clauses of one red reason. */
const JOINER = " — and ";

/**
 * What the step's own pass over the frozen contract said, beside the tiers.
 *
 * `reason` is the frozen tests' failure text (empty for a green contract, which
 * composes nothing); `red` is the contract's own colour, the only state in which a
 * second clause is composed. `judgedBeforeTiers` is identity against the main pass's
 * result: that pass is the only one whose verdict describes the tree the tiers
 * started on. The baseline arm re-runs the contract AFTER a tier may have touched the
 * tree, so a red it observes there is not a fact about the tiers' input — only that
 * arm's hang (which the reason itself names) still composes, because the hint would
 * otherwise be lost when the arm returns.
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
 * A plain red whose frozen tests are red AND whose tier is red at head.
 *
 * `undefined` when there is nothing to compose — the frozen tests passed, or the
 * contract's colour was decided after the tier ran — and the caller then keeps the
 * single clause `firstFailure` chose.
 */
export function composedTierRed(frozen: FrozenClause, tierReason: string): string | undefined {
  if (!frozen.red || !frozen.judgedBeforeTiers) return undefined;
  return `${frozen.reason}${JOINER}${tierReason}`;
}

/**
 * The baseline arm's red: the contract is red and the tier is red at the base commit.
 *
 * `undefined` means keep the arm's own hand-back — `baseline red:` leads, so every
 * existing pin on that prefix stays valid. A hang composes even when the arm re-ran
 * the contract, because the timeout wording lives or dies on this line.
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
