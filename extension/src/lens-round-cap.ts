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
 *     the cap is flagged too — without it a lens that keeps failing would be
 *     re-run silently at the same round; a streak at the cap carries the
 *     distinct REVIEW_INCOMPLETE_STREAK warning (#1140);
 *   - the cap is `PI_ENSEMBLE_LENS_ROUND_CAP` when set to a positive integer,
 *     otherwise MAX_REVIEW_ROUNDS (the driver's single constant, not a copy);
 *   - a CRITICAL finding open in the latest recorded round allows exactly one
 *     round beyond the cap (CRITICAL is never capped away);
 *   - every run is keyed (lens-budget-key.ts): its branch, else the PR's head
 *     branch, else the one branch at the head commit, else
 *     `detached:<head SHA>`. A head that resolves to no commit is refused — no
 *     run is admitted without a key, so none is unbudgeted;
 *   - a round whose ledger write did not land still consumes its number for
 *     the rest of the process (the note says so), so a failed write can never
 *     hand the same round to the next run;
 *   - #1449 — a round whose row landed OUTSIDE the per-clone ledger (an
 *     inherited `PI_ENSEMBLE_REVIEW_LEDGER_FILE`) is reported too, and
 *     deliberately NOT counted as unrecorded: the row exists, the guard just
 *     cannot see it. The note names the file it wrote to, and says plainly that
 *     this round is invisible to the next run's budget and delta base.
 *   - a corrupt `round` or `incompleteRuns` on the latest entry refuses, naming
 *     the field (fail closed);
 *   - the operator's environment variable `PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1`,
 *     read at call time, skips the budget (no warning) and is recorded on the
 *     ledger entry the run writes. The tool schema has no parameter for it.
 *
 * Known limit: the in-flight reservation is per Pi process. Across processes,
 * and against a previous run's fire-and-forget ledger write that has not
 * landed yet, the check is best-effort. Within a process the reservation is
 * held until the run's ledger write settles (`release`), so the next call
 * cannot claim the round the previous run is still recording.
 *
 * #1140 — a run past the round cap or at the incomplete-streak cap is NOT
 * refused: refusing made the cap an operator-only dead end (a fix commit after
 * the last round left the PR's head unreviewable). The run is admitted exactly
 * like an in-cap run (round, key, ledger write) and carries a visible warning
 * naming the round, the cap, the last verdict, whether CRITICAL is open, and
 * the residuals-marker status (see `capWarning`). Only the fail-closed faults
 * above (no key, no patch id, unreadable ledger, corrupt counter) still refuse
 * with a `ROUND_CAP_REACHED` summary: no lens child, no ledger entry.
 */

import { existsSync, readFileSync } from "node:fs";
import { execp } from "./exec.ts";
import { resolveBudgetKey } from "./lens-budget-key.ts";
import type { LensLedgerOutcome } from "./lens-ledger.ts";
import type { LensReviewSummary } from "./lens-review-format.ts";
import { acquireLedgerLock } from "./review-ledger-lock.ts";
import {
  MISDIRECTED_LEDGER_NOTE,
  ledgerPathFor,
  misdirectedLedgerWrite,
} from "./review-ledger-path.ts";
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
  /** The round this run would be (latest round + 1 + in-flight + unrecorded; 1 on a first review). */
  nextRound: number;
  /** The round the latest recorded entry ran as (0 when none recorded). */
  lastRound: number;
  criticalOpen: boolean;
  /** Consecutive REVIEW_INCOMPLETE runs since the last completed round. */
  incompleteStreak: number;
  /** True when the incomplete streak alone refuses the run. */
  streakCapped: boolean;
  /** A counter on the latest entry that is not a non-negative integer (fail closed). */
  corrupt?: { field: "round" | "incompleteRuns" };
}

const isCount = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

/**
 * `inFlight` is the number of runs admitted in this process and not yet
 * settled; each is counted as if it will complete (conservative: an aborted
 * one over-refuses a concurrent call, which is the safe direction).
 * `unrecordedRounds` counts rounds in this process whose ledger write did not
 * land — each consumed its round number (#1127).
 *
 * An absent `round` / `incompleteRuns` is a legacy entry (round 1, streak 0).
 * A present one that is not a non-negative integer is corrupt and refuses.
 */
export function evaluateRoundBudget(
  latest: LedgerEntry | undefined,
  cap: number,
  inFlight = 0,
  unrecordedRounds = 0,
): RoundBudget {
  const corruptField: "round" | "incompleteRuns" | undefined =
    latest && latest.round !== undefined && !isCount(latest.round)
      ? "round"
      : latest && latest.incompleteRuns !== undefined && !isCount(latest.incompleteRuns)
        ? "incompleteRuns"
        : undefined;
  if (corruptField) {
    return {
      allowed: false,
      nextRound: 0,
      lastRound: 0,
      criticalOpen: false,
      incompleteStreak: 0,
      streakCapped: false,
      corrupt: { field: corruptField },
    };
  }
  // A legacy entry without `round` counts as round 1 (bumpLensRound's rule).
  const lastRound = latest ? (latest.round ?? 1) : 0;
  const nextRound = lastRound + 1 + inFlight + unrecordedRounds;
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
    // #1449 — the budget reads the file the WRITE went to, so when that is not
    // the clone's own ledger the operator is told: the round it is about to
    // count is invisible to this read, which is why a redirected run keeps
    // looking like a first review. Still `ok: true` — the read succeeded, and
    // refusing a review because an env var points elsewhere would be a new
    // failure mode, not a fix.
    const misdirected = await misdirectedLedgerWrite(execp, cwd, file);
    if (misdirected) {
      trace(
        `lens-round-cap: the round budget reads ${misdirected} (an overridden path), not the per-clone ledger — the recorded round there is invisible to this check`,
      );
    }
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

/** The warning a run past the budget carries: last verdict, CRITICAL state, marker status (#1140). */
function capWarning(budget: RoundBudget, cap: number, latest: LedgerEntry | undefined): string {
  const last = latest?.detail ?? "no verdict recorded";
  const crit = budget.criticalOpen ? "open (one extra round is allowed)" : "not open";
  const why = budget.streakCapped
    ? `REVIEW_INCOMPLETE_STREAK — ${budget.incompleteStreak} consecutive run(s) ended REVIEW_INCOMPLETE, reaching the ${cap}-run limit for incomplete runs; the lenses keep failing, which points at infrastructure rather than the round budget`
    : `ROUND_CAP_REACHED — round ${budget.nextRound} exceeds the ${cap}-round cap (${ROUND_CAP_ENV})`;
  return [
    `⚠ WARNING: ${why}. The review ran anyway and this round is recorded as round ${budget.nextRound}.`,
    `Last recorded round before this one: ${budget.lastRound} — verdict ${last}. CRITICAL in that round: ${crit}.`,
    "Residuals marker: not verified by this tool — the merge guard checks the PR's disclosure marker at merge time (condition 5).",
    `The operator can silence this warning with ${OVERRIDE_ENV}=1 in the environment.`,
  ].join("\n");
}

/** A fail-closed refusal (#1140: the round and streak caps warn instead). */
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

/** In-process reservations: ledger key → runs admitted and not yet settled. */
const inFlight = new Map<string, number>();
/**
 * In-process count of rounds whose ledger write did NOT land, per key (#1127).
 * Each such round still consumed its round number, so it is added to the next
 * admission (fail open on the write, never on the budget: a later run cannot
 * be handed the unrecorded round). Process-local: a restart forgets it.
 */
const unrecorded = new Map<string, number>();

/** Settles a run: optionally waits for its ledger write; resolves to a note when the round was not recorded. */
export type RoundRelease = (
  ledgerWrite?: Promise<LensLedgerOutcome | undefined>,
) => Promise<string | undefined>;
const NOOP_RELEASE: RoundRelease = () => Promise.resolve(undefined);

/** Count an unrecorded round for `key`; returns the note the run's summary carries. */
function noteUnrecorded(key: string, round: number | undefined, reason: string): string {
  unrecorded.set(key, (unrecorded.get(key) ?? 0) + 1);
  trace(`lens-round-cap: round ${round ?? "?"} on ${key} was not recorded: ${reason}`);
  return round !== undefined
    ? `round ${round} was not recorded: ${reason}. The round is counted against the budget for this session so the next run cannot reuse it.`
    : `a round was not recorded: ${reason}.`;
}

/**
 * #1449 — the note a run carries when its row landed OUTSIDE the per-clone
 * ledger.
 *
 * The round is NOT counted as unrecorded: the row genuinely exists (a redirect
 * is `recorded: true` with a `landedAtPath`), it simply sits in a file the #912
 * guard will never open. Double-counting it would hand the next run a round
 * number the ledger already consumed, and the #1127 invariant the unrecorded
 * counter exists to protect — "a failed write can never hand the same round to
 * the next run" — would be broken in the other direction.
 *
 * The reason and the path are both named so the operator reading only the tool
 * text can tell this apart from the by-design no-writes (which say nothing at
 * all, or say "no branch to key the ledger entry on" / "no patch id").
 */
function noteMisdirected(key: string, round: number | undefined, landedAtPath: string): string {
  trace(
    `lens-round-cap: round ${round ?? "?"} on ${key} wrote to ${landedAtPath}, not the clone ledger`,
  );
  return [
    MISDIRECTED_LEDGER_NOTE,
    `Wrote to: ${landedAtPath}`,
    `Round ${round ?? "?"} on \`${key}\` is recorded only in that file — the next run's round budget and delta base will not see it, because they read the per-clone ledger.`,
  ].join("\n");
}

/**
 * Reserve one in-flight slot for `key`. The returned release is idempotent.
 * Given the run's ledger-write promise, it frees the slot only once that write
 * settles: until then the run's round is not on the ledger, so a concurrent
 * call would otherwise be admitted to the same round. A write that did not
 * record (or rejected) is counted as an unrecorded round and reported.
 */
function reserve(key: string, round?: number): RoundRelease {
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let settled = false;
  const free = (): void => {
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) inFlight.set(key, left);
    else inFlight.delete(key);
  };
  return (ledgerWrite) => {
    if (settled) return Promise.resolve(undefined);
    settled = true;
    if (!ledgerWrite) {
      free();
      return Promise.resolve(undefined);
    }
    return ledgerWrite.then(
      (outcome) => {
        free();
        if (!outcome) return undefined;
        if (outcome.recorded === false) return noteUnrecorded(key, round, outcome.reason);
        // #1449 — a recorded write to a redirected path is reportable
        // infrastructure, not an unrecorded round: see `noteMisdirected`.
        return outcome.landedAtPath ? noteMisdirected(key, round, outcome.landedAtPath) : undefined;
      },
      (err: unknown) => {
        const reason = (err as Error)?.message ?? String(err);
        free();
        return noteUnrecorded(key, round, reason);
      },
    );
  };
}

export type RoundAdmission =
  | {
      admitted: true;
      /** True only when the operator's env override admitted the run. */
      overrideCap: boolean;
      /** The ledger key the run is budgeted and recorded under (absent only on the override path). */
      key?: string;
      /** The round this run is (absent on the override path). */
      round?: number;
      /** A visible note the caller must surface (e.g. a fallback budget key). */
      note?: string;
      release: RoundRelease;
    }
  | { admitted: false; refusal: LensReviewSummary };

/** Why the budget key fell back from the branch — the note's wording. */
const KEY_SOURCE_TEXT = {
  pr: "the PR's head branch",
  "points-at": "the one local branch at the head commit",
  detached: "the detached head commit (no branch names it)",
} as const;

/**
 * The round-budget gate for one `dispatch_lens_review` call. On admission the
 * caller MUST call `release()` once the run settles (the tool does so in a
 * `finally`). Runs before the delta/full decision, so an empty delta also
 * passes through here without consuming a round (it writes no entry).
 */
export async function admitLensRound(opts: {
  cwd?: string;
  head?: string;
  pr?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<RoundAdmission> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  // Every run is keyed (#1127): the branch, or a fallback key (lens-budget-key.ts).
  const keyed = await resolveBudgetKey({ cwd, head: opts.head, pr: opts.pr });
  const note =
    keyed.key !== undefined && keyed.source !== "branch"
      ? `Round budget keyed on \`${keyed.key}\` (${KEY_SOURCE_TEXT[keyed.source]}): the branch did not resolve directly. The round is recorded under this key.`
      : undefined;
  // The ONLY bypass: the operator's environment, read at call time. The tool
  // schema has no such parameter, so a model cannot set it.
  if (env[OVERRIDE_ENV] === "1") {
    trace(
      "lens-round-cap: operator override (PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1) — round budget not enforced",
    );
    return {
      admitted: true,
      overrideCap: true,
      key: keyed.key,
      note,
      release: keyed.key ? reserve(keyed.key) : NOOP_RELEASE,
    };
  }
  if (keyed.key === undefined) {
    // No key means no ledger row and no round to count: refuse rather than run
    // unbudgeted (a bare or unknown head must not restore unlimited rounds).
    trace(`lens-round-cap: no budget key (${keyed.reason}) — refusing (fail closed)`);
    return {
      admitted: false,
      refusal: refusal(
        `ROUND_CAP_REACHED — the round budget could not be keyed: ${keyed.reason}. Refused fail closed: a run with no ledger key would be unbudgeted. Pass a \`head\` that names a commit, a branch-named \`head\`, or a \`pr\` number, or have the operator set PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1 if an unbudgeted round is accepted.`,
      ),
    };
  }
  const key = keyed.key;
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
  const recorded = await readRecordedLens(cwd, key);
  const cap = lensRoundCap(env);
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
  const budget = evaluateRoundBudget(
    recorded.latest,
    cap,
    inFlight.get(key) ?? 0,
    unrecorded.get(key) ?? 0,
  );
  if (budget.corrupt) {
    const shown = JSON.stringify(recorded.latest?.[budget.corrupt.field]);
    trace(`lens-round-cap: corrupt ledger field ${budget.corrupt.field} on ${key} — refusing`);
    return {
      admitted: false,
      refusal: refusal(
        `ROUND_CAP_REACHED — the round budget could not be verified: the \`${budget.corrupt.field}\` field of the latest ledger entry for ${key} is ${shown}, not a non-negative integer. Refused fail closed so a corrupt counter cannot restore unlimited rounds. Repair the ledger, or have the operator set PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1 if an unbudgeted round is accepted.`,
      ),
    };
  }
  // #1140 — past the cap the review still RUNS: the cap is a visible warning,
  // not an operator-only dead end. The round, key and ledger write are the
  // same as an in-cap run, so the #973 merge rule can see this head reviewed.
  const warning = budget.allowed ? undefined : capWarning(budget, cap, recorded.latest);
  if (warning)
    trace(
      `lens-round-cap: round ${budget.nextRound} on ${key} is past the cap (${cap}) — running with a warning`,
    );
  return {
    admitted: true,
    overrideCap: false,
    key,
    round: budget.nextRound,
    note: [warning, note].filter(Boolean).join("\n\n") || undefined,
    release: reserve(key, budget.nextRound),
  };
}
