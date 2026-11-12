/**
 * merge-guard-ledger — the review-ledger half of the merge guard's decision, split
 * out of `merge-guard.ts` for the §12 file cap (AGENTS.md §12).
 *
 * The guard's handler is a sequence of gates; this module holds the two that read
 * the per-clone review ledger (adversarial, then lens/round-cap) and the single CI
 * exit they fall through to. Same seam `merge-guard-protected.ts` and
 * `merge-guard-author.ts` use: the shared predicates answer, this module phrases,
 * and the hook calls one function.
 *
 * ## The one exit rule (#2107)
 *
 * An ALLOW is not taken where it is made. The round-cap path used to `return` at
 * its own allow, which skipped the CI gate entirely: a capped-but-merge-worthy PR
 * with a red check merged without `gh` being asked a single question. So the ledger
 * branch records `allowNote` and falls through to the CI read at the bottom, which
 * every allow path reaches. Refusals still return where they are decided — the
 * diagnostics stay first — and only the forge carve-out in the caller, the one
 * return that is not an agent merge, stays exempt.
 *
 * ## Why the redirected-write diagnostic is read here and not inside the refusal
 *
 * #1449 — "there is no lens entry" has two causes the operator must be able to tell
 * apart from the refusal alone: nobody reviewed the branch, or a review ran and its
 * row landed at an overridden path this guard's read never opens. The guard cannot
 * spot the redirect from inside the redirecting process — it resolves through the
 * same `ledgerPathFor`, so guard and writer agree on the file — so the signal is the
 * write-side provenance the writer persists on the row (`LedgerEntry.writtenTo`),
 * read from the file the override points at. It is resolved ONCE here, above the
 * refusal sites, so the diagnostic makes no git call of its own and keeps its
 * never-throw contract: the guard's hot path has no throw site. The read lives in
 * merge-guard-provenance.ts, which swallows every fs/parse fault internally. Fail-
 * open on the DIAGNOSTIC only — a second read that throws yields no note and the
 * ordinary never-reviewed refusal, never a pass; the strict fail-closed rule below
 * is untouched.
 */

import { misdirectedWriteOf } from "./merge-guard-provenance.ts";
import {
  adversarialRefusal,
  lensNotEvaluatedRefusal,
  readPrCommentBodies,
  refuseUnlessCiGreen,
} from "./merge-guard-reads.ts";
import { evaluateRoundCapMerge } from "./merge-guard-round-cap.ts";
import { compareAdversarialIdentity } from "./merge-identity-compare.ts";
import type { MergeExecFn, MergeTarget } from "./merge-target.ts";
import {
  type LedgerEntry,
  cloneLedgerPathFor,
  latestEntry,
  readLedgerAt,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";

/** What a gate decided: nothing (allow) or the `{ block }` the hook returns. */
export type LedgerGateBlock = { block: true; reason: string };

function block(reason: string): LedgerGateBlock {
  return { block: true, reason };
}

/** The escape hatch named in every default refusal this module renders. */
const HATCH =
  "the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";

/**
 * Adversarial + lens/round-cap + the CI exit, in the order the handler runs them.
 *
 * `fetchedHead` is the OID the caller verified equals the PR's `headOid`: the
 * round-cap head check and the CI pin both use that one value, so a green board for
 * somebody else's commit cannot answer for this merge.
 */
export async function guardMergeLedger(args: {
  execFn: MergeExecFn;
  cwd: string;
  target: MergeTarget;
  prNumber: number;
  repoValue?: string;
  currentPatchId: string;
  fetchedHead: string;
  /** The per-exec timeout the caller uses for every gh/git read in this handler. */
  timeoutMs: number;
}): Promise<LedgerGateBlock | undefined> {
  const { execFn, cwd, target, prNumber, repoValue, currentPatchId, fetchedHead } = args;
  const branch = target.headBranch;

  // Read the ledger.
  const ledgerPath = await (await import("./review-ledger.ts")).ledgerPathFor(execFn, cwd);
  if (!ledgerPath) {
    return block(`no git common dir found — the review ledger is unavailable; ${HATCH}`);
  }
  const entries: LedgerEntry[] = readLedgerAt(ledgerPath);
  // #1449 round 2 — the override-blind path, resolved here rather than inside the
  // refusal so the diagnostic stays synchronous and never-throwing.
  const cloneLedgerPath = await cloneLedgerPathFor(execFn, cwd);
  const redirectedTo = misdirectedWriteOf(ledgerPath, branch, cloneLedgerPath);

  // Adversarial: latest entry must be passed AND match the current patchId.
  // #1360 — a non-passing row's `detail` is quoted in the refusal, so an operator
  // told "no passing review" can see the review DID run and why its row does not
  // count (a narrowed range, a moved head, an edited tree). #1533 — the comparison
  // itself is `compareAdversarialIdentity`, shared with the driver's merged step so
  // the two cannot drift on what "same reviewed patch" means; the refusals below stay
  // the guard's own words.
  const advVerdict = compareAdversarialIdentity(entries, branch, currentPatchId);
  if (!advVerdict.ok) {
    if (advVerdict.cause === "patch-changed") {
      return block(
        `adversarial review is stale: ledger patchId ${advVerdict.reviewedPatchId.slice(0, 8)} ≠ current ${advVerdict.currentPatchId.slice(0, 8)} — the branch changed after the review; re-run adversarial_loop`,
      );
    }
    return block(
      adversarialRefusal(branch, advVerdict.cause === "no-entry" ? undefined : advVerdict.entry),
    );
  }

  // Lens: the strict rule first — the LATEST entry must be `passed` (any patchId).
  // When it refuses, the #973 round-cap path is consulted: an ISSUES_FOUND entry
  // with no CRITICAL, at the round cap (or with nothing at or above the blocking
  // bar), an approving adversarial review (already checked above), and the residual
  // findings disclosed on the PR (marker + matching patch) allows the merge — the
  // same rule AGENTS.md §1 and work-driver-lens-cap.ts apply to the driver's own
  // cycles. A refusal from either path names the failed condition (see
  // evaluateRoundCapMerge for the full matrix).
  let allowNote: string | undefined;
  const lens = latestEntry(entries, branch, "lens");
  if (!lens || !lens.passed) {
    const lensComments = await readPrCommentBodies(execFn, cwd, target, prNumber, repoValue);
    // #973 review — the round-cap path's headSha check (condition 6) uses the PR's
    // current head: the fetched OID, which the guard has already verified equals the
    // PR's `headOid` (a mismatch is the earlier "stale branch" refusal in the
    // caller). A lens review of an older commit cannot satisfy the cap.
    const capDecision = evaluateRoundCapMerge(
      entries,
      branch,
      currentPatchId,
      lensComments,
      fetchedHead,
    );
    if (capDecision.applies && capDecision.allowed) {
      allowNote = `round-cap path: ISSUES_FOUND, no CRITICAL, round ${lens?.round}, disclosed on the PR`;
      trace(
        `merge-guard: PR #${prNumber} ${branch} — round-cap path allows the merge (ISSUES_FOUND, no CRITICAL, round ${lens?.round}, disclosed on the PR)`,
      );
    } else if (capDecision.applies) {
      return block(
        `merge refused: ${capDecision.failedCondition ?? "the round-cap conditions are not met"} — ${HATCH}`,
      );
    }
    // The round-cap path did not apply (no entry, or a legacy entry with no verdict
    // detail): the strict rule's refusal, branch named for the operator; #1449 — a
    // row that went elsewhere is named, with its file.
    if (!allowNote) return lensNotEvaluatedRefusal(branch, lens, { redirectedTo });
  }

  if (!allowNote) {
    trace(`merge-guard: PR #${prNumber} ${branch} — adversarial + lens both pass`);
  }
  // #2106 — the LAST gate, and the ONLY exit: reached by the strict ledger allow and
  // by the round-cap allow alike. GitHub only, and fail-closed. The head pin is the
  // fetched OID the caller verified against the PR's `headOid`: the CI verdict must
  // be the verdict for THAT commit, or it is a green board for somebody else's work.
  return refuseUnlessCiGreen(execFn, cwd, prNumber, target.forge, {
    expectedHeadOid: fetchedHead,
    repoValue,
    timeoutMs: args.timeoutMs,
  });
}
