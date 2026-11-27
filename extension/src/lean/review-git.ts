/**
 * lean/review-git — the ref-moving half of the review step's git surface, and
 * the fix round that produces the ref.
 *
 * `review.ts` is the decision procedure (WHEN the loop runs); `review-gates.ts`
 * adapts the two frozen review layers; `review-deps.ts` wires the outside world
 * and composes the briefs. This file owns the three things none of them can do
 * from where they sit: reading origin as the commit the gates review, reading
 * the diff they range over, and moving the run's branch onto the fixer's commits
 * — the only place in the whole step that touches origin.
 *
 * Two invariants the caller depends on and cannot re-check:
 *
 * - **No read returns an empty string for "there is nothing."** A missing branch
 *   is a throw, never `""`, because `""` is also what a clean diff looks like and
 *   a review step that confuses the two approves code nobody looked at. "git could
 *   not run" and "git found no such ref" are answered DIFFERENTLY, via
 *   `resolveHeadShaOutcome` — the resolver the frozen driver's own review path
 *   uses — because they are different facts for an operator.
 * - **Nothing here is forced.** The fixer's tree is disposable and detached (see
 *   `review-tree.ts`); the run's own tree is only the vehicle for a ref update. A
 *   concurrent push is refused by git rather than overwritten by us.
 *
 * All of it takes `ReviewDeps.exec`, so a test drives these claims against a real
 * temp repo without a model in the loop — which is the only way a claim like "the
 * frozen blob still hashes to its record" is a test rather than a comment.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import { resolveHeadShaOutcome } from "../review-head-sha.ts";
import { type ReviewDeps, ReviewInfraError } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { ContractSource } from "./state-derived-spec.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * The commit this round reviews: origin's branch, as a full sha.
 *
 * A read that could not run and a branch that does not exist are both fatal and
 * are stated DIFFERENTLY: the first says the review cannot approve a head it
 * cannot resolve, the second says there is nothing to review. Neither reads as
 * "an empty diff, nothing to change" — that is an approval with no bytes behind
 * it, and it is the failure this step's whole shape exists to make impossible.
 * The split comes from `resolveHeadShaOutcome`, the resolver the frozen driver's
 * review path already uses, rather than a local `rev-parse` whose stderr and exit
 * code were discarded and both answers collapsed into one.
 */
export async function reviewedHead(
  deps: ReviewDeps,
  repoRoot: string,
  branch: string,
  rows: DispatchUsageRow[],
): Promise<string> {
  const ref = `origin/${branch}`;
  const outcome = await resolveHeadShaOutcome(repoRoot, ref, deps.exec);
  // Narrowed on `sha` first, so `failed` is only read on the arm that has it.
  if (outcome.sha !== undefined) {
    if (isFullCommitSha(outcome.sha)) return outcome.sha;
    // A resolver that printed something which is not an oid is "git found no such
    // commit", not "git could not be asked" — the shape rule is this step's.
    return await refused(ref, false, rows);
  }
  return await refused(ref, outcome.failed, rows);
}

/** The refusal for a head this step cannot review, worded by WHY it cannot. */
async function refused(ref: string, failed: boolean, rows: DispatchUsageRow[]): Promise<never> {
  throw new ReviewInfraError(
    failed
      ? `could not ask git what ${ref} is, so the review cannot approve a head it cannot resolve`
      : `${ref} is not a commit this clone has, so there is nothing to review — and nothing to review is not a pass`,
    rows,
  );
}

/**
 * The diff `base...head` as text.
 *
 * The step needs it for two reasons and pays for it once: the evidence builders
 * (`buildEvidence`, `runClaimScan`) cannot answer "could not read the branch"
 * differently from "found nothing", so the caller has to establish that the branch
 * is readable BEFORE asking them — and the way it establishes that is to read the
 * diff itself, which is the same range the lenses range over. `undefined` is the
 * only honest answer for a read that failed, and the caller turns it into a throw.
 */
export async function rangeDiff(
  deps: ReviewDeps,
  repoRoot: string,
  base: string,
  head: string,
  rows: DispatchUsageRow[],
): Promise<string | undefined> {
  // Both bounds are resolved to commits before the range is asked for. `base` and
  // `head` reach here as strings the step did not mint (a ledger-resolved delta
  // base, a head the layer recorded), and a range whose bound does not name a
  // commit is indistinguishable, in this read, from a range with no changes — so
  // the ambiguity is removed here rather than passed down: an unresolvable bound
  // is a failed read, and the caller turns a failed read into a throw.
  const from = await resolveCommitArg(deps, repoRoot, base);
  const to = await resolveCommitArg(deps, repoRoot, head);
  if (from === undefined || to === undefined)
    throw new ReviewInfraError(
      `could not resolve the range ${base.slice(0, 12)}...${head.slice(0, 12)} for the six-lens pass (${from === undefined ? `\`${base}\`` : `\`${head}\``} is not a commit this clone has) — a range nobody can name is not a diff to review`,
      rows,
    );
  const diff = await gitQuiet(deps.exec, repoRoot, ["diff", `${from}...${to}`]);
  if (diff === undefined) {
    throw new ReviewInfraError(
      `could not read the diff ${base}...${head.slice(0, 12)} for the six-lens pass`,
      rows,
    );
  }
  return diff.stdout;
}

/** One range bound as a commit this clone has, or undefined when it is not one. */
async function resolveCommitArg(
  deps: ReviewDeps,
  repoRoot: string,
  rev: string,
): Promise<string | undefined> {
  if (rev.trim() === "") return undefined;
  const out = await gitQuiet(deps.exec, repoRoot, ["rev-parse", "--verify", `${rev}^{commit}`]);
  const sha = (out?.stdout ?? "").trim();
  return isFullCommitSha(sha) ? sha : undefined;
}

/** Fold the integration's submodule clause into the `fixed` reason — the run record, PR and
 *  handoff carry it, where a trace line reaches only whoever already opened the log. */
export function noteFixDisclosure<R extends { reason?: string }>(
  pass: R,
  clause: string | undefined,
): R {
  return clause === undefined || pass.reason === undefined
    ? pass
    : { ...pass, reason: `${pass.reason}; ${clause}` };
}

/** The contract's provenance as the review gates' args want it: the KEY is present only
 *  when the record carries a contract. A `derivedSpec: undefined` is not the same object
 *  as one without the key, and every brief decides whether to print a contract section by
 *  whether the field is there — so the guard lives here, once, where no call site can drop
 *  it. */
export function derivedArg(run: ContractSource): ContractSource {
  return run.derivedSpec === undefined ? {} : { derivedSpec: run.derivedSpec };
}
