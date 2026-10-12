/**
 * lens-round-cap — the tool-side round budget of `dispatch_lens_review` (#1127).
 *
 * The `/work` driver caps a cycle at MAX_REVIEW_ROUNDS (work-driver-lens-cap.ts)
 * and the #973 merge rule refuses a merge that ran past it, but a hand-run
 * `dispatch_lens_review` had no budget of its own: nothing stopped a PR from
 * being reviewed 13-19 six-lens rounds. This module is the check the tool runs
 * BEFORE any lens is dispatched:
 *
 *   - the branch's recorded lens round is read from the per-clone review ledger
 *     under the ledger lock (fail closed: an unreadable or malformed ledger
 *     refuses rather than restoring unlimited rounds; a missing ledger file is
 *     a first review, round 0);
 *   - the next round is `latest.round + 1` (bumpLensRound's numbering: a
 *     REVIEW_INCOMPLETE entry carries the previous round, so an aborted run
 *     consumes no budget);
 *   - the cap is `PI_ENSEMBLE_LENS_ROUND_CAP` when set to a positive integer,
 *     otherwise MAX_REVIEW_ROUNDS (the driver's single constant, not a copy);
 *   - a CRITICAL finding open in the latest recorded round allows exactly one
 *     round beyond the cap (CRITICAL is never capped away);
 *   - `overrideCap: true` bypasses the check; the override is recorded on the
 *     ledger entry the run writes.
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
  /** The round this run would be (latest round + 1; 1 on a first review). */
  nextRound: number;
  /** The round the latest recorded entry ran as (0 when none recorded). */
  lastRound: number;
  criticalOpen: boolean;
}

export function evaluateRoundBudget(latest: LedgerEntry | undefined, cap: number): RoundBudget {
  // A legacy entry without `round` counts as round 1 (bumpLensRound's rule).
  const lastRound = latest ? (latest.round ?? 1) : 0;
  const nextRound = lastRound + 1;
  const criticalOpen = latest?.hasCritical === true;
  const limit = cap + (criticalOpen ? 1 : 0);
  return { allowed: nextRound <= limit, nextRound, lastRound, criticalOpen };
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
  return [
    `ROUND_CAP_REACHED — round ${budget.nextRound} would exceed the ${cap}-round cap (${ROUND_CAP_ENV}). No lens was dispatched and nothing was recorded.`,
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

/**
 * The round-budget gate for one `dispatch_lens_review` call. Returns the
 * refusal summary when the run must not dispatch, or `undefined` when it may
 * proceed. Runs before the delta/full decision, so an empty delta also
 * passes through here without consuming a round (it writes no entry).
 */
export async function roundBudgetRefusal(opts: {
  cwd?: string;
  head?: string;
  overrideCap?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<LensReviewSummary | undefined> {
  if (opts.overrideCap === true) {
    trace("lens-round-cap: overrideCap set — round budget not enforced for this run");
    return undefined;
  }
  const cwd = opts.cwd ?? process.cwd();
  const { branch } = await resolveLensReviewBranch({ head: opts.head, cwd });
  if (!branch) {
    // Nothing keys the ledger without a branch; the writer skips too, and the
    // review reports its own "disclosure NOT posted" note. Traced, not refused.
    trace("lens-round-cap: no branch resolved — round budget not checked");
    return undefined;
  }
  const recorded = await readRecordedLens(cwd, branch);
  const cap = lensRoundCap(opts.env);
  if (!recorded.ok) {
    trace(`lens-round-cap: ledger unreadable (${recorded.reason}) — refusing (fail closed)`);
    return refusal(
      `ROUND_CAP_REACHED — the round budget could not be verified: the review ledger is unreadable (${recorded.reason}). Refused fail closed so an unreadable ledger cannot restore unlimited rounds. Fix or restore the ledger, or re-run with \`overrideCap: true\` if the operator accepts an unbudgeted round.`,
    );
  }
  const budget = evaluateRoundBudget(recorded.latest, cap);
  if (budget.allowed) return undefined;
  trace(`lens-round-cap: refusing round ${budget.nextRound} on ${branch} (cap ${cap})`);
  return refusal(capNote(budget, cap, recorded.latest));
}
