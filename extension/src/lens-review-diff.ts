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
import { neutraliseEvidence } from "./comment-evidence.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { execp } from "./exec.ts";
import type { LensLedgerOutcome } from "./lens-ledger.ts";
import {
  type CarriedEntry,
  decideEmptyDelta,
  resolveDeltaSince,
  writeCarriedEntry,
} from "./lens-review-auto-delta.ts";
import { bySeverityCounts, computeVerdict, dedupeFindings } from "./lens-review-format.ts";
import type { LensRunResult, Severity, Verdict } from "./lens-review.ts";
import type { Finding } from "./lens-review.ts";
import type { RosterEntry } from "./lens-roster.ts";
import { resolveAutoHunkDelta, resolveMainlineBase } from "./review-delta-hunks.ts";
import { computeDeltaDiff, computeRangeDiff } from "./review-diff.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
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
 * Resolve the delta's head to a full SHA (or the cwd's current HEAD when none
 * is named). #1039 — a branch name is a valid ref to git but not a 40-char
 * SHA; storing it as headSha corrupts the round-cap comparison and the
 * auto-delta base, so it is resolved through the shared resolver. A leading
 * dash is rejected before git sees it.
 */
export async function resolveDeltaHead(
  head: string | undefined,
  c: string,
): Promise<{ head: string } | { problem: string }> {
  if (!head) {
    try {
      const { stdout } = await execFileP("git", ["-C", c, "rev-parse", "HEAD"], {
        maxBuffer: 8 * 1024,
      });
      return { head: stdout.trim() };
    } catch (err) {
      return {
        problem: `lens review: cannot resolve the current HEAD in ${c}: ${(err as Error).message?.slice(0, 200) ?? "unknown error"}`,
      };
    }
  }
  if (head.startsWith("-")) {
    return {
      problem: `lens review: head ref "${head}" is rejected: ref names must not start with '-'`,
    };
  }
  return { head: (await resolveHeadSha(c, head, execp)) ?? head };
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
  const h = await resolveDeltaHead(head, c);
  if ("problem" in h) {
    return { noReview: false, since, head: "HEAD", problem: h.problem };
  }
  const resolvedHead = h.head;
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

/** The delta a review ran against. `fallback` is set when an automatic delta
 * could not use its hunk-level method and reviewed the two-dot range instead
 * (the reason is disclosed in the context, the summary and the residuals). */
export interface AutoDeltaInfo {
  since: string;
  head: string;
  auto?: boolean;
  fallback?: string;
}

/** The fallback sentence, built once for every surface that discloses it (the
 * lens context, the review summary, the PR residuals). The reason is
 * neutralised here, so a marker-like token in it cannot forge a verdict on any
 * surface. */
export function deltaFallbackText(delta: { since: string; fallback: string }): string {
  return `this delta review covers the full two-dot range since ${delta.since.slice(0, 8)} because ${neutraliseEvidence(delta.fallback)}`;
}

/** The DELTA FALLBACK note appended to the lens context when an automatic delta
 * fell back to the two-dot range; empty when there is no fallback. */
export function deltaFallbackNote(delta: AutoDeltaInfo | undefined): string {
  if (!delta?.fallback) return "";
  return `\n\nDELTA FALLBACK: ${deltaFallbackText({ since: delta.since, fallback: delta.fallback })}. Main's hunks merged into the branch since then may be included; do not report them as branch-authored defects.`;
}

/** The `deltaReview` field of the review summary; carries the fallback when set. */
export function deltaReviewOf(delta: AutoDeltaInfo): {
  since: string;
  head: string;
  fallback?: string;
} {
  return {
    since: delta.since,
    head: delta.head,
    ...(delta.fallback ? { fallback: delta.fallback } : {}),
  };
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
  | { kind: "ok"; diff: string; delta?: AutoDeltaInfo }
  | { kind: "blocked"; problem: string }
  | { kind: "noReview"; since: string; head: string; reason: string }
  | {
      kind: "carry";
      from: string;
      head: string;
      prev: CarriedEntry;
      verdict: Verdict;
      /** #1176 \u2014 the carried entry, already written and awaited by the resolver. */
      written: LensLedgerOutcome & { recorded: true };
    }
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
  // #1128 — the automatic delta resolves its hunk-level patch first.
  if (autoSince) return resolveAutoDelta(opts, autoSince);
  if (since) {
    const d = await resolveDeltaDiff(since, opts.head, opts.cwd);
    if (d.noReview) {
      return { kind: "noReview", since: d.since, head: d.head, reason: d.reason };
    }
    if (d.problem) {
      return { kind: "blocked", problem: d.problem };
    }
    return { kind: "ok", diff: d.diff ?? "", delta: { since: d.since, head: d.head } };
  }
  const resolution = await resolveLensDiff(opts);
  if (resolution.problem) {
    return { kind: "blocked", problem: resolution.problem };
  }
  // #384 — the explicit-full path gets the same guard as the auto path: an
  // undefined diff is unreadable, never an empty (approving) one.
  if (resolution.diff === undefined) {
    return {
      kind: "blocked",
      problem: "lens review: the full diff returned no content; it is not treated as empty (#384)",
    };
  }
  return { kind: "ok", diff: resolution.diff };
}

type ReviewDiffOutcome = Awaited<ReturnType<typeof resolveReviewDiff>>;

/**
 * #1128 — the automatic delta's diff. The hunk-level reviewed patch
 * (review-delta-hunks.ts) is tried FIRST; the two-dot range is computed only
 * when that method falls back, so the large range is never built for nothing.
 * The base is the explicit `base`, else the mainline (the same resolution the
 * ledger uses). Every fallback is recorded on the delta, never silent.
 */
async function resolveAutoDelta(
  opts: { base?: string; head?: string; cwd?: string; branch?: string },
  since: string,
): Promise<ReviewDiffOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const h = await resolveDeltaHead(opts.head, cwd);
  if ("problem" in h) return { kind: "blocked", problem: h.problem };
  const base = opts.base ?? (await resolveMainlineBase(cwd));
  let fallback: string | undefined;
  if (!base) {
    fallback = "no mainline base resolves (origin/HEAD, origin/<main|master>, local <main|master>)";
  } else {
    const r = await resolveAutoHunkDelta({ since, head: h.head, base, cwd });
    if (r.kind === "problem" && opts.base) return { kind: "blocked", problem: r.problem };
    if (r.kind === "empty") return emptyAutoDelta(opts, base, since, h.head, r.reason);
    if (r.kind === "diff") {
      return { kind: "ok", diff: r.diff, delta: { since, head: h.head, auto: true } };
    }
    fallback = r.kind === "problem" ? r.problem : r.reason;
  }
  const d = await resolveDeltaDiff(since, h.head, cwd);
  if (d.noReview) return emptyAutoDelta(opts, base, d.since, d.head, d.reason);
  if (d.problem) return { kind: "blocked", problem: d.problem };
  return {
    kind: "ok",
    diff: d.diff ?? "",
    delta: { since: d.since, head: d.head, auto: true, fallback },
  };
}

/**
 * #1176 — an EMPTY automatic delta (nothing but mainline hunks, or no change).
 * Outcomes, in order:
 *   - no recorded run with a matching identity, or no mainline base: the empty
 *     outcome stands — `noReview`, which runs no re-review and writes NO ledger
 *     entry for the new head. The merge guard then judges the branch against the
 *     entries it already has. (The no-base case is not a carry: the identity
 *     cannot be computed without a mainline to diff against.)
 *   - recorded run, identity unchanged (patch-id AND digest): the verdict is
 *     written onto the head FIRST and awaited; only a recorded write becomes a
 *     `carry`.
 *   - anything else (identity changed or undecidable, write not recorded): a
 *     full review of the branch (no `since`).
 */
async function emptyAutoDelta(
  opts: { cwd?: string; branch?: string },
  base: string | undefined,
  since: string,
  head: string,
  reason: string,
): Promise<ReviewDiffOutcome> {
  const noReview: ReviewDiffOutcome = { kind: "noReview", since, head, reason };
  if (!opts.branch || !base) return noReview;
  const cwd = opts.cwd ?? process.cwd();
  const e = await decideEmptyDelta({ cwd, branch: opts.branch, head, base });
  if (e.kind === "noReview") return noReview;
  if (e.kind === "carry") {
    const written = await writeCarriedEntry(cwd, e.prev, head, e.from);
    if (written.recorded) {
      return { kind: "carry", from: e.from, head, prev: e.prev, verdict: e.verdict, written };
    }
    trace(`lens-review: carry not recorded (${written.reason}) — full review`);
  } else {
    trace(`lens-review: empty automatic delta not carried (${e.reason}) — full review`);
  }
  const full = await resolveLensDiff({ base, head, cwd });
  if (full.problem) return { kind: "blocked", problem: full.problem };
  // #384 — an undefined diff is an unreadable result, never an empty one.
  if (full.diff === undefined) {
    return {
      kind: "blocked",
      problem: "lens review: the full diff returned no content; it is not treated as empty (#384)",
    };
  }
  return { kind: "ok", diff: full.diff };
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
 *
 * `auto` labels the banner accurately (design decision 6): the delta base
 * is EITHER the automatic one (the latest lens ledger entry's `headSha`)
 * OR an operator-supplied `since` — the banner must say which.
 */
export async function buildDeltaFullContext(
  context: string,
  cwd: string | undefined,
  base: string,
  head: string,
  since: string,
  auto: boolean,
): Promise<string> {
  const full = await computeRangeDiff(cwd ?? process.cwd(), base, head);
  if (!full.ok) return context;
  const FULL_CONTEXT_CAP = 100 * 1024;
  const fullDiff =
    full.diff.length > FULL_CONTEXT_CAP
      ? `${full.diff.slice(0, FULL_CONTEXT_CAP)}\n… (truncated — the full branch diff exceeds ${FULL_CONTEXT_CAP} bytes; the findings below cover the delta only)`
      : full.diff;
  const sinceLabel = auto ? "auto: latest lens ledger headSha" : "operator-supplied since";
  return `${context}\n\nFULL BRANCH DIFF (context only — the findings below cover the delta since ${since} (${sinceLabel})):\n${fullDiff}`;
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
