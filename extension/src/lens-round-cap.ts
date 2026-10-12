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
 *     re-run forever at the same round; a streak at the cap is refused as the
 *     distinct REVIEW_INCOMPLETE_STREAK outcome, a refused call does not count,
 *     and only the operator's override clears it (an outage is the operator's
 *     call, not a retry loop's);
 *   - the cap is `PI_ENSEMBLE_LENS_ROUND_CAP` when set to a positive integer,
 *     otherwise MAX_REVIEW_ROUNDS (the driver's single constant, not a copy);
 *   - a CRITICAL finding open in the latest recorded round allows exactly one
 *     round beyond the cap (CRITICAL is never capped away);
 *   - a run with no resolvable branch is admitted UNBUDGETED with a visible
 *     note (nothing keys the ledger, so no round can be counted);
 *   - the only bypass is the operator's environment variable
 *     `PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1`, read at call time. The tool schema
 *     has no parameter for it, so a model cannot set it; the override is
 *     recorded on the ledger entry the run writes.
 *
 * Known limit: the in-flight reservation is per Pi process. Across processes,
 * and against a previous run's fire-and-forget ledger write that has not
 * landed yet, the check is best-effort. Within a process the reservation is
 * held until the run's ledger write settles (`release`), so the next call
 * cannot claim the round the previous run is still recording.
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
import {
  type LedgerEntry,
  latestEntry,
  validEntries,
  workingTreePatchId,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";
import { MAX_REVIEW_ROUNDS } from "./work-driver-context.ts";

export const ROUND_CAP_ENV = "PI_ENSEMBLE_LENS_ROUND_CAP";
/** The operator's bypass. Set by the operator in the environment only (#1127). */
export const OVERRIDE_ENV = "PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE";

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
    ? `${budget.incompleteStreak} consecutive run(s) ended REVIEW_INCOMPLETE — the ${cap}-run limit for incomplete runs is reached; only the operator can clear it (PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1)`
    : `round ${budget.nextRound} would exceed the ${cap}-round cap (${ROUND_CAP_ENV})`;
  return [
    `${budget.streakCapped ? "REVIEW_INCOMPLETE_STREAK" : "ROUND_CAP_REACHED"} — ${why}. No lens was dispatched and nothing was recorded.`,
    `Last recorded round: ${budget.lastRound} — verdict ${last}. CRITICAL in that round: ${crit}.`,
    "Residuals marker: not verified by this tool — the merge guard checks the PR's disclosure marker at merge time (condition 5).",
    "Only the operator can authorise another round: PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1 in the environment (recorded in the ledger). The tool has no parameter for it.",
  ].join("\n");
}

function refusal(
  note: string,
  verdict: "ROUND_CAP_REACHED" | "REVIEW_INCOMPLETE_STREAK" = "ROUND_CAP_REACHED",
): LensReviewSummary {
  return {
    verdict,
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

/**
 * Reserve one in-flight slot for `branch`. The returned release is idempotent.
 * Given the run's ledger-write promise, it frees the slot only once that write
 * settles: until then the run's round is not on the ledger, so a concurrent
 * call would otherwise be admitted to the same round. A rejected write is
 * traced (never dropped) and still frees the slot.
 */
function reserve(branch: string): (ledgerWrite?: Promise<void>) => void {
  inFlight.set(branch, (inFlight.get(branch) ?? 0) + 1);
  let settled = false;
  const free = (): void => {
    const left = (inFlight.get(branch) ?? 1) - 1;
    if (left > 0) inFlight.set(branch, left);
    else inFlight.delete(branch);
  };
  return (ledgerWrite) => {
    if (settled) return;
    settled = true;
    if (!ledgerWrite) return free();
    ledgerWrite.then(free, (err: unknown) => {
      trace(
        `lens-round-cap: ledger write for ${branch} rejected (${(err as Error)?.message ?? String(err)}) — slot released`,
      );
      free();
    });
  };
}

export type RoundAdmission =
  | {
      admitted: true;
      /** True only when the operator's env override admitted the run. */
      overrideCap: boolean;
      /** A visible note the caller must surface (e.g. no branch → unbudgeted). */
      note?: string;
      release: (ledgerWrite?: Promise<void>) => void;
    }
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
  env?: NodeJS.ProcessEnv;
}): Promise<RoundAdmission> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const { branch } = await resolveLensReviewBranch({ head: opts.head, cwd });
  // The ONLY bypass: the operator's environment, read at call time. The tool
  // schema has no such parameter, so a model cannot set it.
  if (env[OVERRIDE_ENV] === "1") {
    trace(
      "lens-round-cap: operator override (PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1) — round budget not enforced",
    );
    return { admitted: true, overrideCap: true, release: branch ? reserve(branch) : NOOP };
  }
  if (!branch) {
    // Nothing keys the ledger without a branch, so no round can be counted.
    // Admitted UNBUDGETED with a visible note (no ledger row), not refused:
    // a branchless review (e.g. /do step 6) must still be able to run.
    trace("lens-round-cap: no branch resolved — round budget not applied (no ledger row)");
    return {
      admitted: true,
      overrideCap: false,
      note: "No branch resolved — round budget not applied (no ledger row). This review is not counted against the per-branch round cap; name the branch (`branch`, or a branch-named `head`) or run from the branch's checkout to have it budgeted.",
      release: NOOP,
    };
  }
  // #1127 review — the ledger writer records a round only when it can compute a
  // patch id (mainline, remote, merge-base, patch-id). Admission runs the same
  // computation and refuses when it cannot, so an admitted run always lands an
  // entry and cannot be re-admitted indefinitely at the same round.
  const patch = await workingTreePatchId(execp, cwd);
  if (!patch.patchId) {
    trace(`lens-round-cap: no patch id (${patch.warning ?? "unknown"}) — refusing (fail closed)`);
    return {
      admitted: false,
      refusal: refusal(
        `ROUND_CAP_REACHED — the round cannot be recorded: ${patch.warning ?? "no patch id could be computed for the working tree"}. A run that cannot be recorded would not consume a round, so it is refused fail closed. Resolve the mainline/remote state, or have the operator set PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1 if an unbudgeted round is accepted.`,
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
        `ROUND_CAP_REACHED — the round budget could not be verified: the review ledger is unreadable (${recorded.reason}). Refused fail closed so an unreadable ledger cannot restore unlimited rounds. Fix or restore the ledger, or have the operator set PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1 if an unbudgeted round is accepted.`,
      ),
    };
  }
  // Check and reserve in ONE synchronous step (no await between them), so a
  // concurrent call in this process sees this run's slot as soon as it is taken.
  const budget = evaluateRoundBudget(recorded.latest, cap, inFlight.get(branch) ?? 0);
  if (!budget.allowed) {
    const verdict = budget.streakCapped ? "REVIEW_INCOMPLETE_STREAK" : "ROUND_CAP_REACHED";
    trace(
      `lens-round-cap: refusing (${verdict}) round ${budget.nextRound} on ${branch} (cap ${cap})`,
    );
    return { admitted: false, refusal: refusal(capNote(budget, cap, recorded.latest), verdict) };
  }
  return { admitted: true, overrideCap: false, release: reserve(branch) };
}
