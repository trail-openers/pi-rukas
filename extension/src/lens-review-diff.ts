/**
 * lens-review-diff — the #859 ref-range diff resolution for the lens review,
 * split from lens-review.ts (the 500-line gate headroom).
 *
 * When `dispatch_lens_review` is called with `base` + `head` (no pasted
 * `diff` string), the diff is computed ONCE via `computeRangeDiff`
 * (review-diff.ts — execFile, no shell; the same positive-empty rule as
 * #384) and that single value is threaded to every lens child. An error
 * (invalid ref naming the ref, confirmed-empty range, cap overflow, nothing
 * supplied) blocks the whole review as a failed result — a computed diff is
 * never silently empty and never read as "nothing to review" (an approval).
 *
 * Blocked rows use the EXPECTED (installed + bundled) roster the caller
 * already built — a diff error is a review-level failure, so the blocked
 * rows name the lenses the review would have run. The skills-dir problem
 * case uses `installBlockRowsForRoster` (lens-review-skills.ts) instead,
 * which derives its rows from the BUNDLED `LENS_ROSTER` (falling back to a
 * single "LENSES" row when the bundled set is unreadable) and carries the
 * install-oriented message as `parseError`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as dispatchDeck from "./dispatch-deck.ts";
import { execp } from "./lens-exec.ts";
import { bySeverityCounts, computeVerdict, dedupeFindings } from "./lens-review-format.ts";
import type { LensRunResult, Severity, Verdict } from "./lens-review.ts";
import type { Finding } from "./lens-review.ts";
import type { RosterEntry } from "./lens-roster.ts";
import { computeDeltaDiff, computeRangeDiff } from "./review-diff.ts";
import { latestEntry, ledgerPathFor, readLedgerAt } from "./review-ledger.ts";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);
/**
 * Resolve the review's diff from either a pasted string or a ref range.
 *
 * - `diff` present → wins (even when base+head are also present; the
 *   "diff string wins" rule, traced by the caller).
 * - no `diff`, base+head present → `computeRangeDiff(cwd ?? process.cwd(),
 *   base, head)`; an error becomes a problem (never an empty-string
 *   approval).
 * - neither → a problem (a caller error, not an approval).
 */
export async function resolveLensDiff(opts: {
  diff?: string;
  base?: string;
  head?: string;
  cwd?: string;
}): Promise<{ diff?: string; problem?: string }> {
  if (opts.diff) return { diff: opts.diff };
  if (opts.base && opts.head) {
    const range = await computeRangeDiff(opts.cwd ?? process.cwd(), opts.base, opts.head);
    if (!range.ok) {
      return {
        problem: `lens review: cannot compute diff for ${opts.base}...${opts.head}: ${range.reason}`,
      };
    }
    return { diff: range.diff };
  }
  return {
    problem: "lens review: no diff supplied (pass `diff`, or both `base` and `head`)",
  };
}

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

/**
 * #973 — the delta review's diff resolution (see `computeDeltaDiff` for the
 * empty-delta contract).
 *
 * The `head` defaults to the current HEAD (the commit the review is run
 * against); a caller naming an explicit `head` reviews that commit.
 *
 * `noReview` is the #973 "empty delta" outcome: `since` IS a valid commit
 * AND the range `since..head` is empty — nothing changed since the last
 * recorded lens run, which is the churn the delta path exists to stop. It is
 * deliberately distinct from an error: the caller returns the no-review
 * result (no fan-out, no ledger entry) rather than blocking the review or
 * reading emptiness as an approval (the #384 rule, which applies to a
 * confirmed-empty FULL diff and is untouched here).
 */
export async function resolveDeltaDiff(
  since: string,
  head: string | undefined,
  cwd: string | undefined,
): Promise<
  | { noReview: true; since: string; head: string; reason: string }
  | { noReview: false; since: string; head: string; diff: string; problem?: undefined }
  | { noReview: false; since: string; head: string; problem: string; diff?: undefined }
> {
  const c = cwd ?? process.cwd();
  let resolvedHead: string;
  if (head) {
    resolvedHead = head;
  } else {
    // No explicit head: the current HEAD of the cwd's repo (the commit the
    // review runs against). Resolved before the diff so the no-review
    // outcome can name it in its reason.
    try {
      const { stdout } = await execFileP("git", ["-C", c, "rev-parse", "HEAD"], {
        maxBuffer: 8 * 1024,
      });
      resolvedHead = stdout.trim();
    } catch (err) {
      return {
        noReview: false,
        since,
        head: "HEAD",
        problem: `lens review: cannot resolve the current HEAD in ${c}: ${(err as Error).message?.slice(0, 200) ?? "unknown error"}`,
      };
    }
  }
  const d = await computeDeltaDiff(c, since, resolvedHead);
  if (!d.ok) {
    return {
      noReview: false,
      since,
      head: resolvedHead,
      problem: `lens review: ${d.reason}`,
      diff: undefined,
    };
  }
  if (d.empty) {
    return {
      noReview: true,
      since,
      head: resolvedHead,
      reason: `no changes since ${since.slice(0, 8)} (nothing to review — the delta path exists to stop the churn)`,
    };
  }
  return { noReview: false, since, head: resolvedHead, diff: d.diff, problem: undefined };
}

/**
 * #973 — the unified review-diff resolver. Single entry point for
 * `runLensReview` (lens-review.ts): resolves which mode the review runs in
 * (full, delta, or no-review) and returns either the diff + delta flag, a
 * block (with the named problem), or the no-review outcome (decision 4).
 *
 * Precedence: explicit `diff` string wins; then explicit `since`; then the
 * AUTOMATIC delta base (design decision 6 — the latest lens ledger entry's
 * headSha, when the branch is named, `full` is not set, and the stored
 * SHA is a strict ancestor of the reviewed head); then base+head full
 * range. An empty delta is the no-review outcome (decision 4 — no fan-out,
 * no ledger entry); a problem is a block.
 */
export async function resolveReviewDiff(opts: {
  diff?: string;
  since?: string;
  full?: boolean;
  base?: string;
  head?: string;
  branch?: string;
  cwd?: string;
}): Promise<
  | { kind: "ok"; diff: string; delta?: { since: string; head: string; auto?: boolean } }
  | { kind: "blocked"; problem: string }
  | { kind: "noReview"; since: string; head: string; reason: string }
> {
  const hasDiffString = typeof opts.diff === "string" && opts.diff.length > 0;
  if (hasDiffString) {
    return { kind: "ok", diff: opts.diff as string };
  }
  // #973 — the automatic delta base (design decision 6): without an
  // explicit `since`, a named branch, and no `full: true` opt-out, `since`
  // defaults to the branch's latest lens ledger entry's `headSha` when that
  // SHA is a strict ancestor of the reviewed head. Every other shape
  // (first review, missing ledger, legacy entry without headSha, non-ancestor)
  // resolves to undefined and the review is full.
  const autoSince =
    !opts.full && !opts.since && opts.branch
      ? await resolveDeltaSince(opts.branch, opts.head, opts.cwd)
      : undefined;
  const since = opts.since ?? autoSince;
  if (since) {
    const d = await resolveDeltaDiff(since, opts.head, opts.cwd);
    if (d.noReview) {
      return { kind: "noReview", since: d.since, head: d.head, reason: d.reason };
    }
    if (d.problem) {
      return { kind: "blocked", problem: d.problem };
    }
    return {
      kind: "ok",
      diff: d.diff ?? "",
      delta: { since: d.since, head: d.head, ...(autoSince ? { auto: true } : {}) },
    };
  }
  const resolution = await resolveLensDiff(opts);
  if (resolution.problem) {
    return { kind: "blocked", problem: resolution.problem };
  }
  return { kind: "ok", diff: resolution.diff ?? "" };
}

/**
 * Build the blocked rows for an unresolvable diff from the EXPECTED roster
 * (one blocked row per lens the review would have run). Feeds the
 * REVIEW_INCOMPLETE verdict — the review is incomplete, not approved.
 */
export function blockedRowsForRoster(roster: RosterEntry[], problem: string): LensRunResult[] {
  // #966 — an empty roster must NEVER yield zero blocked rows: `computeVerdict`
  // over zero rows returns APPROVED (the silent-approval this guard closes).
  // A review whose expected set is unknown (roster unavailable) or empty still
  // produces one named blocked row so the verdict is REVIEW_INCOMPLETE.
  if (roster.length === 0) {
    return [
      {
        lens: "LENSES",
        ok: false,
        ms: 0,
        startMs: Date.now(),
        findings: [],
        attempts: 0,
        blocked: true,
        parseError: problem,
      },
    ];
  }
  return roster.map((e) => ({
    lens: e.name,
    ok: false,
    ms: 0,
    startMs: Date.now(),
    findings: [],
    attempts: 0,
    blocked: true,
    parseError: problem,
  }));
}

/**
 * The single blocked-review summary for an unresolvable diff: dedup the
 * extra findings against the expected roster, score the verdict with the
 * resolved threshold, and bump the deck's batch row once per blocked lens so
 * the pass shows as finished (no spawn happened — the lens "completed" as a
 * block). Keeping the shape here (rather than in runLensReview) is what keeps
 * lens-review.ts under the 500-line gate.
 */
export function blockedReviewSummary(
  runId: string,
  extraFindings: Finding[] | undefined,
  roster: RosterEntry[],
  blockRows: LensRunResult[],
  threshold: Severity,
): {
  verdict: ReturnType<typeof computeVerdict>;
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  lenses: LensRunResult[];
  findings: Finding[];
  usage: undefined;
} {
  const batchKey = `${runId}/batch`;
  dispatchDeck.startBatchEntry(batchKey, {
    label: `code-review-specialist×${blockRows.length}`,
    size: blockRows.length,
  });
  for (let i = 1; i <= blockRows.length; i++) {
    dispatchDeck.updateBatchProgress(batchKey, i);
  }
  dispatchDeck.clearBatchEntry(batchKey);
  const all = [...(extraFindings ?? [])];
  const deduped = dedupeFindings(all, roster);
  return {
    verdict: computeVerdict(deduped, blockRows, threshold),
    totalFindings: deduped.length,
    bySeverity: bySeverityCounts(deduped),
    lenses: blockRows,
    findings: deduped,
    usage: undefined,
  };
}

/**
 * #973 review — the full-branch context for a delta review. When a delta
 * review is also given an explicit base + head, the full `git diff
 * <base>...<head>` range is appended to the lens context for orientation.
 * The context is bounded: an unbounded full-branch diff appended to every
 * lens prompt would blow the child's context window on large branches, so it
 * is capped at 100 KB with a truncation notice (the findings below still
 * cover the delta; this is orientation only). Returns the CONTEXT STRING
 * (the caller replaces its context with the result) so the truncation
 * budget applies to the whole context, not just the appended block.
 */
export async function buildDeltaFullContext(
  context: string,
  cwd: string | undefined,
  base: string,
  head: string,
  since: string,
): Promise<string> {
  const full = await computeRangeDiff(cwd ?? process.cwd(), base, head);
  if (!full.ok) return context;
  const FULL_CONTEXT_CAP = 100 * 1024;
  const fullDiff =
    full.diff.length > FULL_CONTEXT_CAP
      ? `${full.diff.slice(0, FULL_CONTEXT_CAP)}\n… (truncated — the full branch diff exceeds ${FULL_CONTEXT_CAP} bytes; the findings below cover the delta only)`
      : full.diff;
  return `${context}\n\nFULL BRANCH DIFF (context only — the findings below cover the delta since ${since} (auto: latest lens ledger headSha)):\n${fullDiff}`;
}

/**
 * The persistent batch summary row (#139): the "X/6 done" deck entry that
 * lets the user watch the pass throughout the run even as fast lenses drop
 * out at 0s linger. Registered BEFORE the per-lens entries so its seq sorts
 * first on Pi's footer (moved here from runLensReview for the 500-line cap).
 */
export function startPersistentBatch(
  runId: string,
  size: number,
): { batchKey: string; bumpBatch: () => void } {
  const batchKey = `${runId}/batch`;
  dispatchDeck.startBatchEntry(batchKey, {
    label: `code-review-specialist×${size}`,
    size,
  });
  let completedLenses = 0;
  return {
    batchKey,
    bumpBatch: () => {
      completedLenses += 1;
      dispatchDeck.updateBatchProgress(batchKey, completedLenses);
    },
  };
}
