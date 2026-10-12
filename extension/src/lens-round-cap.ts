/**
 * lens-round-cap — the tool-side round budget of `dispatch_lens_review` (#1127).
 *
 * The `/work` driver caps a cycle at MAX_REVIEW_ROUNDS (work-driver-lens-cap.ts)
 * and the #973 merge rule refuses a merge that ran past it, but a hand-run
 * `dispatch_lens_review` had no budget of its own: nothing stopped a PR from
 * being reviewed 13-19 six-lens rounds. This module is the check the tool runs
 * BEFORE any lens is dispatched (`admitLensRound`):
 *
 *   - the branch's recorded lens round is read from the per-clone review ledger
 *     under the ledger lock (fail closed: an unreadable or malformed ledger
 *     refuses rather than restoring unlimited rounds; a missing ledger file is
 *     a first review, round 0);
 *   - the next round is `latest.round + 1 + inFlight` (bumpLensRound's
 *     numbering: a REVIEW_INCOMPLETE entry carries the previous round, so an
 *     aborted run does not advance the round; `inFlight` counts runs this
 *     process has admitted but not yet settled, so concurrent calls cannot
 *     both claim the same round);
 *   - a streak of REVIEW_INCOMPLETE runs (`incompleteRuns`, bumpLensRound) at
 *     the cap refuses too — without it a lens that keeps failing would be
 *     re-run forever at the same round;
 *   - the cap is `PI_ENSEMBLE_LENS_ROUND_CAP` when set to a positive integer,
 *     otherwise MAX_REVIEW_ROUNDS (the driver's single constant, not a copy);
 *   - a CRITICAL finding open in the latest recorded round allows exactly one
 *     round beyond the cap (CRITICAL is never capped away);
 *   - a run with no resolvable branch is refused (nothing keys the ledger, so
 *     nothing could be counted) unless `overrideCap: true`;
 *   - `overrideCap: true` bypasses the check; the override is recorded on the
 *     ledger entry the run writes.
 *
 * Known limit: the in-flight reservation is per Pi process. Across processes,
 * and against a previous run's fire-and-forget ledger write that has not
 * landed yet, the check is best-effort.
 *
 * A refused run returns a `ROUND_CAP_REACHED` summary: no lens child is
 * spawned, no ledger entry is written (so the refusal consumes no round), and
 * the note names the last round's verdict, whether CRITICAL is open, and the
 * residuals-marker status (see `capNote`).
 */

import { existsSync, readFileSync } from "node:fs";
import { execp } from "./lens-exec.ts";
import { resolveLensReviewBranch } from "./lens-review-branch-resolve.ts";
import type { LensReviewSummary } from "./lens-review-format.ts";
import { acquireLedgerLock } from "./review-ledger-lock.ts";
import { ledgerPathFor } from "./review-ledger-path.ts";
import { type LedgerEntry, latestEntry, validEntries } from "./review-ledger.ts";
import { trace } from "./trace.ts";
import { MAX_REVIEW_ROUNDS } from "./work-driver-context.ts";

export const ROUND_CAP_ENV = "PI_ENSEMBLE_LENS_ROUND_CAP";

/**
 * The effective per-branch round cap. A non-integer, non-positive or empty
 * value falls back to the driver's constant: a typo must never silently
 * disable the budget (or set it to zero and refuse every review).
 */
export function lensRoundCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ROUND_CAP_ENV]?.trim();
  if (!raw) return MAX_REVIEW_ROUNDS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : MAX_REVIEW_ROUNDS;
}

/** Pure budget decision over the branch's latest recorded lens entry. */
export interface RoundBudget {
  allowed: boolean;
  /** The round this run would be (latest round + 1 + in-flight; 1 on a first review). */
  nextRound: number;
  /** The round the latest recorded entry ran as (0 when none recorded). */
  lastRound: number;
  criticalOpen: boolean;
  /** Consecutive REVIEW_INCOMPLETE runs since the last completed round. */
  incompleteStreak: number;
  /** True when the incomplete streak alone refuses the run. */
  streakCapped: boolean;
}

/**
 * `inFlight` is the number of runs admitted in this process and not yet
 * settled; each is counted as if it will complete (conservative: an aborted
 * one over-refuses a concurrent call, which is the safe direction).
 */
export function evaluateRoundBudget(
  latest: LedgerEntry | undefined,
  cap: number,
  inFlight = 0,
): RoundBudget {
  // A legacy entry without `round` counts as round 1 (bumpLensRound's rule).
  const lastRound = latest ? (latest.round ?? 1) : 0;
  const nextRound = lastRound + 1 + inFlight;
  const criticalOpen = latest?.hasCritical === true;
  const incompleteStreak = latest?.incompleteRuns ?? 0;
  const streakCapped = incompleteStreak >= cap;
  const limit = cap + (criticalOpen ? 1 : 0);
  return {
    allowed: nextRound <= limit && !streakCapped,
    nextRound,
    lastRound,
    criticalOpen,
    incompleteStreak,
    streakCapped,
  };
}

export type RecordedLens =
  | { ok: true; latest: LedgerEntry | undefined }
  | { ok: false; reason: string };

/**
 * Read the branch's latest lens entry under the ledger lock. Never throws:
 * every fault is returned as `ok: false` so the caller refuses (fail closed).
 */
export async function readRecordedLens(cwd: string, branch: string): Promise<RecordedLens> {
  try {
    const file = await ledgerPathFor(execp, cwd);
    if (!file) return { ok: false, reason: "no review-ledger path for this checkout" };
    const release = await acquireLedgerLock(file);
    try {
      if (!existsSync(file)) return { ok: true, latest: undefined };
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown } | null;
      if (!parsed || !Array.isArray(parsed.entries)) {
        return { ok: false, reason: "review ledger has no entries array" };
      }
      return { ok: true, latest: latestEntry(validEntries(parsed.entries), branch, "lens") };
    } finally {
      release();
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message ?? "unknown read error" };
  }
}

/** The text a refused run carries: last verdict, CRITICAL state, marker status. */
function capNote(budget: RoundBudget, cap: number, latest: LedgerEntry | undefined): string {
  const last = latest?.detail ?? "no verdict recorded";
  const crit = budget.criticalOpen ? "open (one extra round is allowed)" : "not open";
  const why = budget.streakCapped
    ? `${budget.incompleteStreak} consecutive run(s) ended REVIEW_INCOMPLETE — the ${cap}-run limit for incomplete runs is reached`
    : `round ${budget.nextRound} would exceed the ${cap}-round cap (${ROUND_CAP_ENV})`;
  return [
    `ROUND_CAP_REACHED — ${why}. No lens was dispatched and nothing was recorded.`,
    `Last recorded round: ${budget.lastRound} — verdict ${last}. CRITICAL in that round: ${crit}.`,
    "Residuals marker: not verified by this tool — the merge guard checks the PR's disclosure marker at merge time (condition 5).",
    "After the cap: fix only CRITICAL/HIGH and confirmed-real MEDIUM bugs, file the rest as one follow-up issue, and merge under the #973 round-cap rule. To force another round anyway, re-run with `overrideCap: true` (recorded in the ledger).",
  ].join("\n");
}

function refusal(note: string): LensReviewSummary {
  return {
    verdict: "ROUND_CAP_REACHED",
    totalFindings: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [],
    findings: [],
    usage: undefined,
    note,
  };
}

/** In-process reservations: branch → runs admitted and not yet settled. */
const inFlight = new Map<string, number>();
const NOOP = (): void => {};

/** Reserve one in-flight slot for `branch`; the returned release is idempotent. */
function reserve(branch: string): () => void {
  inFlight.set(branch, (inFlight.get(branch) ?? 0) + 1);
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    const left = (inFlight.get(branch) ?? 1) - 1;
    if (left > 0) inFlight.set(branch, left);
    else inFlight.delete(branch);
  };
}

export type RoundAdmission =
  | { admitted: true; release: () => void }
  | { admitted: false; refusal: LensReviewSummary };

/**
 * The round-budget gate for one `dispatch_lens_review` call. On admission the
 * caller MUST call `release()` once the run settles (the tool does so in a
 * `finally`). Runs before the delta/full decision, so an empty delta also
 * passes through here without consuming a round (it writes no entry).
 */
export async function admitLensRound(opts: {
  cwd?: string;
  head?: string;
  overrideCap?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<RoundAdmission> {
  const cwd = opts.cwd ?? process.cwd();
  const { branch } = await resolveLensReviewBranch({ head: opts.head, cwd });
  if (opts.overrideCap === true) {
    trace("lens-round-cap: overrideCap set — round budget not enforced for this run");
    return { admitted: true, release: branch ? reserve(branch) : NOOP };
  }
  if (!branch) {
    // Nothing keys the ledger without a branch, so this run could not be
    // counted against any budget. Refused rather than run unbudgeted.
    trace("lens-round-cap: no branch resolved — refusing (fail closed)");
    return {
      admitted: false,
      refusal: refusal(
        "ROUND_CAP_REACHED — no branch could be resolved for this review (detached head and no branch-named `head`), so its round cannot be counted. Pass `branch` or run from the branch's checkout, or re-run with `overrideCap: true` if the operator accepts an unbudgeted round.",
      ),
    };
  }
  const recorded = await readRecordedLens(cwd, branch);
  const cap = lensRoundCap(opts.env);
  if (!recorded.ok) {
    trace(`lens-round-cap: ledger unreadable (${recorded.reason}) — refusing (fail closed)`);
    return {
      admitted: false,
      refusal: refusal(
        `ROUND_CAP_REACHED — the round budget could not be verified: the review ledger is unreadable (${recorded.reason}). Refused fail closed so an unreadable ledger cannot restore unlimited rounds. Fix or restore the ledger, or re-run with \`overrideCap: true\` if the operator accepts an unbudgeted round.`,
      ),
    };
  }
  // Check and reserve in ONE synchronous step (no await between them), so a
  // concurrent call in this process sees this run's slot as soon as it is taken.
  const budget = evaluateRoundBudget(recorded.latest, cap, inFlight.get(branch) ?? 0);
  if (!budget.allowed) {
    trace(`lens-round-cap: refusing round ${budget.nextRound} on ${branch} (cap ${cap})`);
    return { admitted: false, refusal: refusal(capNote(budget, cap, recorded.latest)) };
  }
  return { admitted: true, release: reserve(branch) };
}
