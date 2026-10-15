/**
 * lens-review-auto-delta — the automatic delta base (#973 design decision 6)
 * and the empty-delta carry-forward (#1176), split from lens-review-diff.ts
 * (the 500-line gate).
 *
 * `resolveDeltaSince` picks the commit a follow-up review's delta starts from:
 * the branch's latest lens ledger entry's `headSha`, when it is a strict
 * ancestor of the reviewed head. When that delta is EMPTY after the mainline
 * hunks are excluded (a `merge origin/main` or a no-op commit), no lens
 * review runs. #1176: if the patch-id of the branch is unchanged since the
 * recorded run, the recorded verdict is carried forward onto the current
 * head so the merge guard sees a ledger entry for it. A changed patch-id
 * forces a full review (the caller reads `kind: "full"`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execp } from "./exec.ts";
import type { LensLedgerOutcome } from "./lens-ledger.ts";
import type { LensReviewSummary, Verdict } from "./lens-review-format.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import {
  type LedgerEntry,
  appendLedgerEntry,
  branchPatchId,
  latestEntry,
  ledgerPathFor,
  readLedgerAt,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);

/**
 * #973 — design decision 6: the AUTOMATIC delta base. When no explicit
 * `since` is given, a follow-up review on a branch defaults its `since` to
 * the branch's latest lens ledger entry's `headSha` — the commit the last
 * recorded lens run reviewed — so a confirmation round re-reviews only what
 * changed since then instead of the whole branch diff (the churn #973
 * exists to stop).
 *
 * The default applies ONLY when the stored `headSha` is a STRICT ancestor
 * of the reviewed head (`git merge-base --is-ancestor <sha> <head>` and
 * `sha !== head`). Every other shape is a FULL review: the first review on
 * a branch (no ledger entry), a missing/unreadable ledger, a legacy entry
 * without `headSha`, and a `headSha` that is not an ancestor (e.g. after a
 * rebase — reviewing the delta against a foreign commit would miss history).
 * The caller applies the #973 no-review outcome (decision 4) when the
 * resulting delta is empty.
 */
export async function resolveDeltaSince(
  branch: string | undefined,
  head: string | undefined,
  cwd: string | undefined,
): Promise<string | undefined> {
  if (!branch) return undefined;
  const c = cwd ?? process.cwd();
  let file: string | undefined;
  try {
    file = await ledgerPathFor(execp, c);
  } catch {
    file = undefined;
  }
  if (!file) return undefined;
  const headSha = latestEntry(readLedgerAt(file), branch, "lens")?.headSha;
  if (!headSha) return undefined;
  // #1039 — a legacy entry whose headSha is a branch name (pre-#1039
  // wrote the raw ref) must be treated as UNKNOWN (full review), never
  // matched by string equality or passed to git as a commit ref.
  if (!isFullCommitSha(headSha)) {
    trace(
      `lens-review: auto since skipped — stored headSha "${headSha.slice(0, 20)}" is not a 40-char SHA (legacy/malformed entry; full review)`,
    );
    return undefined;
  }
  let headRef: string;
  if (head) {
    headRef = head;
  } else {
    try {
      const { stdout } = await execFileP("git", ["-C", c, "rev-parse", "HEAD"], {
        maxBuffer: 8 * 1024,
      });
      headRef = stdout.trim();
    } catch {
      return undefined;
    }
  }
  if (headSha === headRef) return undefined;
  let isAncestor: boolean;
  try {
    await execFileP("git", ["-C", c, "merge-base", "--is-ancestor", headSha, headRef], {
      maxBuffer: 8 * 1024,
    });
    isAncestor = true;
  } catch {
    isAncestor = false;
  }
  if (!isAncestor) {
    trace(
      `lens-review: auto since skipped — ${headSha.slice(0, 8)} is not an ancestor of ${headRef.slice(0, 8)} (full review)`,
    );
    return undefined;
  }
  trace(`lens-review: auto since — delta review since ${headSha.slice(0, 8)}`);
  return headSha;
}

/** The verdicts a recorded lens entry can carry (the `detail` of a lens row). */
const VERDICTS: readonly string[] = [
  "APPROVED",
  "ISSUES_FOUND",
  "CRITICAL_ISSUES_FOUND",
  "REVIEW_INCOMPLETE",
];

function isVerdict(value: string | undefined): value is Verdict {
  return value !== undefined && VERDICTS.includes(value);
}

/** What an EMPTY automatic delta resolves to (#1176). */
export type EmptyDeltaOutcome =
  /** Same head as the recorded run — nothing to record, no review. */
  | { kind: "noReview" }
  /** Patch-id unchanged: the recorded verdict is carried onto `head`. */
  | { kind: "carry"; from: string; prev: LedgerEntry; verdict: Verdict }
  /** Anything else (patch-id changed or unreadable): a full review runs. */
  | { kind: "full"; reason: string };

/**
 * #1176 — decide what an empty automatic delta means. The carry is only
 * granted when the branch's current patch-id (against `base`, the same
 * `<remote>/<base>` shape the merge guard uses) equals the recorded entry's
 * patch-id; every undecidable case fails closed to a full review.
 */
export async function decideEmptyDelta(opts: {
  cwd: string;
  branch: string;
  head: string;
  base: string;
}): Promise<EmptyDeltaOutcome> {
  let prev: LedgerEntry | undefined;
  try {
    const file = await ledgerPathFor(execp, opts.cwd);
    prev = file ? latestEntry(readLedgerAt(file), opts.branch, "lens") : undefined;
  } catch {
    prev = undefined;
  }
  if (!prev?.headSha || !prev.patchId) {
    return { kind: "full", reason: "no recorded lens entry with a headSha and patch-id" };
  }
  if (prev.headSha === opts.head) return { kind: "noReview" };
  if (!isFullCommitSha(opts.head)) {
    return { kind: "full", reason: "the reviewed head is not a full commit SHA" };
  }
  if (!isVerdict(prev.detail)) {
    return { kind: "full", reason: "the recorded verdict is unreadable" };
  }
  const current = await branchPatchId(execp, opts.cwd, opts.head, opts.base);
  if (!current) {
    return { kind: "full", reason: "the current patch-id could not be computed (fail closed)" };
  }
  if (current !== prev.patchId) {
    return {
      kind: "full",
      reason: `the patch-id changed since ${prev.headSha.slice(0, 8)} (${prev.patchId.slice(0, 8)} → ${current.slice(0, 8)})`,
    };
  }
  return { kind: "carry", from: prev.headSha, prev, verdict: prev.detail };
}

/**
 * #1176 — record the carried verdict for `head`. The entry keeps the previous
 * verdict, `passed`, `round` and `hasCritical` (a carry adds no review round,
 * and a non-passed or CRITICAL verdict stays blocking). It goes through
 * `appendLedgerEntry`, so the per-(branch, kind) dedupe still applies.
 */
export async function writeCarriedEntry(
  cwd: string,
  prev: LedgerEntry,
  head: string,
): Promise<LensLedgerOutcome> {
  const entry: LedgerEntry = {
    branch: prev.branch,
    kind: "lens",
    patchId: prev.patchId,
    passed: prev.passed,
    at: Date.now(),
    detail: prev.detail,
    round: prev.round ?? 1,
    headSha: head,
    ...(prev.hasCritical !== undefined ? { hasCritical: prev.hasCritical } : {}),
    ...(prev.incompleteRuns !== undefined ? { incompleteRuns: prev.incompleteRuns } : {}),
  };
  const failure = await appendLedgerEntry(entry, execp, cwd);
  return failure ? { recorded: false, reason: failure } : { recorded: true };
}

/** The summary of a carried verdict: `noReview` (never an approval of the
 * new head) with the carried-from verdict, shown by renderSummary. */
export function carriedSummary(
  from: string,
  head: string,
  prev: LedgerEntry,
  verdict: Verdict,
): LensReviewSummary {
  return {
    verdict,
    totalFindings: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [],
    findings: [],
    usage: undefined,
    deltaReview: { since: from, head },
    noReview: true,
    carriedFrom: { sha: from, verdict, round: prev.round ?? 1 },
  };
}

/** The no-review summary for an empty automatic delta (#973 decision 4). */
export function noReviewSummary(since: string, head: string, reason: string): LensReviewSummary {
  trace(`lens-review: delta review skipped — no changes since ${since} (${reason})`);
  // #980 — the noReview path bypasses `finish()`'s ledger write and #973
  // disclosure post, so nothing is recorded — the generic NOT_RECORDED_NOTE
  // is deliberately not appended.
  const noReviewNote = `No changes since the last lens review (${since.slice(0, 8)}) — no re-review needed (nothing to review).`;
  return {
    verdict: "APPROVED",
    totalFindings: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [],
    findings: [],
    usage: undefined,
    // #973 review — noReview: this is NOT an approval (the summary renders
    // "NO REVIEW — …", never "APPROVED"); every consumer branches on it.
    note: noReviewNote,
    deltaReview: { since, head },
    noReview: true,
  };
}
