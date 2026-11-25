/**
 * lean/verify-red-reason — what a RED tells the builder when two gates broke.
 *
 * `verify` reports the FIRST failure among the frozen contract and the project tiers. That order is right
 * for a verdict, but the reason is also pasted into the next developer's prompt: a run whose frozen tests
 * were red AND whose `verify.full` was red at head names only the contract, the builder fixes the frozen
 * files, the next verify finds the tier, and a build round is spent learning one fact the first pass already
 * observed. So every red at head is named. The rule has three arms:
 *
 *   - **frozen green** — nothing changes; whatever `firstFailure` picked stands;
 *   - **frozen red, tier red at head** — the frozen clause, `" — and "`, the tier's own failure clause: the
 *     contract leads, being the run's own gate and the one thing a builder may never edit to get a green;
 *   - **frozen red, tier red at the base too** — the same join, with the arm's `baseline red:` sentence.
 *
 * A tier GREENed by its re-run composes nothing (a flake says nothing about the work), and nor does an
 * infra result — the caller throws before composing.
 */

import { baselineRedReason } from "./verify-baseline.ts";

/** The joiner between the two clauses of one red reason. */
const JOINER = " — and ";

/**
 * What the step's own pass over the frozen contract said, beside the tiers.
 *
 * `judgedBeforeTiers` is identity against the main pass's result — the only one whose verdict describes the
 * tree the tiers started on. The baseline arm re-runs the contract AFTER a tier may have touched the tree.
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
 * nothing to compose, and the caller keeps the single clause `firstFailure` chose.
 */
export function composedTierRed(frozen: FrozenClause, tierReason: string): string | undefined {
  if (!frozen.red || !frozen.judgedBeforeTiers) return undefined;
  return `${frozen.reason}${JOINER}${tierReason}`;
}

/**
 * The baseline arm's red: the contract is red and the tier is red at the base commit. `undefined` means keep
 * the arm's own hand-back. A hang composes even when the arm re-ran the contract, because the timeout wording
 * lives or dies on this line.
 */
export function composedBaselineRed(
  frozen: FrozenClause,
  tierName: string,
  cmd: string,
  baseSha: string,
  timeoutWording: boolean,
  failing: readonly string[] = [],
): string | undefined {
  if (!frozen.red) return undefined;
  if (!frozen.judgedBeforeTiers && !timeoutWording) return undefined;
  return `${frozen.reason}${JOINER}${baselineRedReason(tierName, cmd, baseSha, failing)}`;
}
