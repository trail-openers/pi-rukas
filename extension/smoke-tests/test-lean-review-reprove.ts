/**
 * lean/review — the re-review must be able to CLEAR what it was bought to clear.
 *
 *  (a) a carried CRITICAL could never retire: `reviewedPass` refuses on a carried
 *      row at or above the bar, and the re-review was always a `since` delta — the
 *      one kind `rowFate` never retires a CRITICAL on. Now a pass-1 CRITICAL buys
 *      the re-review whole-branch (no `since`, plus the layer's `full`), and that arm
 *      is guarded by the stamp's ABSENCE rather than its presence. HIGH-only keeps the
 *      delta and its stamp.
 *  (b) a `REVIEW_INCOMPLETE` re-review threw with no retry. Now it is re-bought ONCE,
 *      behind a FRESH clock read (a step past its bound routes `fixed`, disclosed — a
 *      pushed fix is never stranded by a throw), for exactly `LENSES_PER_PASS` more
 *      lens rows and no extra gate pass. `ROUND_CAP_REACHED` is another component's
 *      budget and buys nothing.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */
import { LENSES_PER_PASS } from "../src/lean/review-waves.ts";
import type { HandlerCtx } from "../src/lean/engine.ts";
import type { LensArgs, LensRound } from "../src/lean/review-args.ts";
import type { Finding } from "../src/lens-review-types.ts";
import {
  type DispatchUsageRow,
  LENS_ROLE,
  REVIEW_CHILD_BUDGET,
  REVIEW_PASSES,
  type ReviewDeps,
  ReviewInfraError,
  carriedFinding,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  lensRoundFor,
  lensRoundWith,
  makeRepo,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { MIN, cfg, ctxWithClock } from "./lib/lean-review-bound-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** What the step asked each re-review call for, and what it paid for. */
type Wave = {
  threw?: Error;
  outcome?: Awaited<ReturnType<typeof runStep>>["outcome"];
  /** The args of every `wave: "fix"` call on `deps.lens`, in order. */
  reReviews: LensArgs[];
  lensRounds: number;
  gateCalls: number;
  fixerCalls: number;
  rows: DispatchUsageRow[];
};

/**
 * One wave: pass 1 reports `carriedRows` (and any `pass1Advisory` rows in the tier
 * the discount moved them to), and the re-review answers per attempt however
 * `reReview` says. Stubs stamp a delta only when handed a `since` — the layer's own
 * rule — so an arm that stopped naming its range fails the step's guard rather than
 * quietly passing.
 */
async function wave(
  tag: string,
  carriedRows: readonly Finding[],
  reReview: (args: LensArgs, attempt: number) => LensRound,
  makeCtx: (repoRoot: string, baseSha: string) => HandlerCtx = (repoRoot, baseSha) =>
    ctxFor(repoRoot, baseSha, "lean/issue-7"),
  over: Partial<ReviewDeps> = {},
  /** Rows `splitAdvisory` moved OUT of pass 1's `reported` — the tier the discount hid. */
  pass1Advisory: readonly Finding[] = [],
): Promise<Wave> {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: "lean/issue-7", feature: "export const f = 1;\n" });
  const commit = fixerThatCommits(tag);
  const reReviews: LensArgs[] = [];
  const counts = { lens: 0, gate: 0, fixer: 0 };
  const { outcome, threw } = await runStep(
    makeCtx(repoRoot, baseSha),
    depsWith({
      adversarial: async (a) => {
        counts.gate++;
        return result({
          loopOutcome: a.wave === "full" ? "rejected" : "approved",
          text: "1. the finding the wave must answer",
          adversarialRounds: [
            {
              round: 1,
              status: a.wave === "full" ? "CRITICAL_ISSUES_FOUND" : "APPROVED",
              verdictParsed: true,
            },
          ],
        });
      },
      lens: async (a) => {
        counts.lens++;
        if (a.wave !== "fix")
          return lensRoundWith("ISSUES_FOUND", [...carriedRows], [...pass1Advisory]);
        reReviews.push(a);
        return reReview(a, reReviews.length);
      },
      dispatch: async (spec) => {
        counts.fixer++;
        return commit(spec);
      },
      ...over,
    }),
  );
  return {
    threw,
    outcome,
    reReviews,
    lensRounds: counts.lens,
    gateCalls: counts.gate,
    fixerCalls: counts.fixer,
    rows: outcome?.dispatches ?? (threw as ReviewInfraError | undefined)?.dispatches ?? [],
  };
}

/** A whole-branch round: no stamp — the layer stamps only a `since..head` delta. */
const clearedFull = (): LensRound => lensRoundWith("APPROVED", []);
/** The same answer on the delta arm — stamped with the range the step named. */
const clearedDelta = (a: LensArgs): LensRound => lensRoundFor(a, "APPROVED", []);
/** A round that judged nothing: a lost lens child, or the operator's round cap. */
const didNotRun = (a: LensArgs, verdict: "REVIEW_INCOMPLETE" | "ROUND_CAP_REACHED"): LensRound =>
  lensRoundFor(a, verdict, []);

// ── (a1) a carried CRITICAL buys a FULL re-review, and the run lands ─────────
// Before the fix this is the field handback: the re-review carried the row because a
// delta round cannot retire a CRITICAL, and `reviewedPass` refused on it.
{
  const w = await wave(
    "a1",
    [carriedFinding({ severity: "CRITICAL", title: "sql injection" })],
    clearedFull,
  );
  assert(
    w.reReviews.length === 1 && w.reReviews[0]?.since === undefined,
    `(a1) a carried CRITICAL makes the re-review buy NO range bound — it ranges over the branch (captured since=${JSON.stringify(w.reReviews[0]?.since)}, ${String(w.reReviews.length)} call(s))`,
  );
  assert(
    w.reReviews[0]?.full === true,
    `(a1) and it names the layer's own full opt-out, without which the automatic delta base makes the round a delta again (captured full=${JSON.stringify(w.reReviews[0]?.full)})`,
  );
  assert(
    (w.threw === undefined && w.outcome?.kind === "fixed") || w.outcome?.kind === "done",
    `(a1) and when that round no longer reports the row the step passes — the CRITICAL retired on the round that can retire it (${w.threw?.message ?? `kind ${String(w.outcome?.kind)}`})`,
  );
  // R2: the full re-review REPLACES the delta round, so the counts do not move.
  assert(
    w.lensRounds === REVIEW_PASSES && w.gateCalls === REVIEW_PASSES && w.fixerCalls === 1,
    `(a1) and it is no extra round — ${String(REVIEW_PASSES)} lens rounds, ${String(REVIEW_PASSES)} gate passes, ${String(REVIEW_CHILD_BUDGET.fixerWaves)} fixer (got ${String(w.lensRounds)}, ${String(w.gateCalls)}, ${String(w.fixerCalls)})`,
  );
  // The brief must tell the six children what they actually judge. The delta section
  // still prints on this arm as orientation, so a wording that read the section rather
  // than the arm would send six lenses after a delta verdict the step did not buy.
  assert(
    (w.reReviews[0]?.context ?? "").includes("full review of the branch") &&
      !(w.reReviews[0]?.context ?? "").includes("re-review of the fix wave's commits"),
    `(a1) and the whole-branch re-review's own brief says whole-branch (captured ${JSON.stringify((w.reReviews[0]?.context ?? "").slice(0, 60))})`,
  );
}

// ── (a2) a wave carrying only HIGH rows keeps the delta, stamp and all ───────
{
  const w = await wave("a2", [carriedFinding({ title: "unbounded read" })], clearedDelta);
  assert(
    w.reReviews.length === 1 &&
      typeof w.reReviews[0]?.since === "string" &&
      w.reReviews[0]?.full === undefined,
    `(a2) a HIGH-only wave still hands the layer the pre-fix head as \`since\` and no \`full\` — the focused round is kept where it can do its job (captured since=${JSON.stringify(w.reReviews[0]?.since?.slice(0, 12))}, full=${JSON.stringify(w.reReviews[0]?.full)})`,
  );
  assert(
    w.threw === undefined,
    `(a2) and that wave clears (${w.threw?.message ?? `kind ${String(w.outcome?.kind)}`})`,
  );
  assert(
    (w.reReviews[0]?.context ?? "").includes("re-review of the fix wave's commits"),
    `(a2) and its brief still says the fix's commits — the wording follows the arm (captured ${JSON.stringify((w.reReviews[0]?.context ?? "").slice(0, 60))})`,
  );
}

// ── (a3) a carried CRITICAL the discount hid in pass 1's `advisory` still buys the arm ─
// `splitAdvisory` moves a row whose cited line sits outside the PR's changed lines out
// of `reported`, so a trigger that read only `reported` would buy the delta round — the
// one arm that can never retire a CRITICAL — on a row the layer still holds open.
{
  const w = await wave(
    "a3",
    [],
    clearedFull,
    (repoRoot, baseSha) => ctxFor(repoRoot, baseSha, "lean/issue-7"),
    {},
    [carriedFinding({ severity: "CRITICAL", title: "sql injection, discounted" })],
  );
  assert(
    w.reReviews.length === 1 && w.reReviews[0]?.since === undefined && w.reReviews[0]?.full === true,
    `(a3) a CRITICAL that sat only in pass 1's advisory set still buys the whole-branch arm (captured since=${JSON.stringify(w.reReviews[0]?.since)}, full=${JSON.stringify(w.reReviews[0]?.full)})`,
  );
  assert(
    w.threw === undefined,
    `(a3) and the round that can retire it retires it (${w.threw?.message ?? `kind ${String(w.outcome?.kind)}`})`,
  );
}

// ── (b1) an incomplete re-review is re-bought once, and the run lands ────────
{
  const w = await wave("b1", [], (a, attempt) =>
    attempt === 1 ? didNotRun(a, "REVIEW_INCOMPLETE") : clearedDelta(a),
  );
  const noRetry = await wave("b1b", [], clearedDelta);
  assert(
    w.reReviews.length === 2,
    `(b1) a REVIEW_INCOMPLETE re-review is re-bought exactly once (${String(w.reReviews.length)} re-review call(s))`,
  );
  assert(
    w.threw === undefined && (w.outcome?.kind === "fixed" || w.outcome?.kind === "done"),
    `(b1) and the complete round ends the step rather than throwing (${w.threw?.message ?? `kind ${String(w.outcome?.kind)}`})`,
  );
  // One round bought per `deps.lens` call on the fix wave. The rows are clipped to
  // `DISPATCHES_MAX_ROWS` keeping the tail, so the calls are the fact and the rows are
  // only its bill — hence the call count here, not a row total.
  assert(
    w.lensRounds === REVIEW_PASSES + 1 && w.reReviews.length === 2,
    `(b1) and the retry bought exactly one extra round of ${String(LENSES_PER_PASS)} lens children (${String(w.lensRounds)} rounds, ${String(w.reReviews.length)} re-reviews)`,
  );
  assert(
    w.gateCalls === REVIEW_PASSES,
    `(b1) and the retry buys NO gate pass: it replays the round, not the step (${String(w.gateCalls)} adversarial call(s), ${String(w.fixerCalls)} fixer)`,
  );
  assert(
    w.reReviews[0]?.since === w.reReviews[1]?.since && w.reReviews[0]?.full === w.reReviews[1]?.full,
    `(b1) and the retry replays the SAME arm — same since, same full/delta kind (${JSON.stringify([w.reReviews[0]?.since?.slice(0, 12), w.reReviews[1]?.since?.slice(0, 12)])})`,
  );
  // The no-retry shape, from the same fixture: the retry is the only thing that
  // moves the lens-row count, and it moves it by one roster.
  assert(
    noRetry.reReviews.length === 1 &&
      noRetry.lensRounds === REVIEW_PASSES &&
      noRetry.rows.filter((r) => r.role === LENS_ROLE).length ===
        REVIEW_PASSES * LENSES_PER_PASS,
    `(b1) and a wave whose re-review completed keeps today's exact counts — ${String(REVIEW_PASSES)} rounds, ${String(REVIEW_PASSES * LENSES_PER_PASS)} lens rows (got ${String(noRetry.lensRounds)} rounds, ${String(noRetry.rows.filter((r) => r.role === LENS_ROLE).length)} lens rows)`,
  );
}

// ── (b2) a second incomplete round throws today's text, after two calls ──────
{
  const w = await wave("b2", [], (a) => didNotRun(a, "REVIEW_INCOMPLETE"));
  assert(
    w.threw instanceof ReviewInfraError &&
      /the re-review of the fix did not complete \(REVIEW_INCOMPLETE\)/.test(w.threw.message),
    `(b2) a second incomplete round is today's throw, in today's words (${w.threw?.message ?? `kind ${String(w.outcome?.kind)}`})`,
  );
  assert(
    w.reReviews.length === 2,
    `(b2) and the retry is capped at one attempt — never a loop buying lens rounds (${String(w.reReviews.length)} re-review call(s))`,
  );
}

// ── (b3) ROUND_CAP_REACHED is the operator's budget, so nothing is re-bought ─
{
  const w = await wave("b3", [], (a) => didNotRun(a, "ROUND_CAP_REACHED"));
  assert(
    w.threw instanceof ReviewInfraError && /ROUND_CAP_REACHED/.test(w.threw.message),
    `(b3) a round-cap re-review throws at once (${w.threw?.message ?? `kind ${String(w.outcome?.kind)}`})`,
  );
  assert(
    w.reReviews.length === 1,
    `(b3) and it buys no retry — only the operator named that budget (${String(w.reReviews.length)} re-review call(s))`,
  );
}

// ── (b4) a live clock at the retry point routes `fixed`, it does not throw ───
// The fix is already on origin when the retry would be bought. The clock must be read
// FRESH here: the pre-fix reading was not live, so a step that reused it would
// dispatch six children past the ceiling it had just passed.
{
  // Crossed at the 5th read (R1, pre-fix, R2, the per-child arms, then the retry's
  // fresh read) — earlier than that and the step never reaches the re-review at all.
  const liveAtRetry = (repoRoot: string, baseSha: string) => {
    let reads = 0;
    return ctxWithClock(repoRoot, baseSha, "lean/issue-7", {
      startedAt: 0,
      now: () => (++reads >= 5 ? 31 * MIN : 1 * MIN),
    });
  };
  const w = await wave(
    "b4",
    [],
    (a, attempt) => (attempt === 1 ? didNotRun(a, "REVIEW_INCOMPLETE") : clearedDelta(a)),
    liveAtRetry,
    { loadConfig: async () => cfg(30) },
  );
  assert(
    w.reReviews.length === 1,
    `(b4) a live step clock buys NO retry (${String(w.reReviews.length)} re-review call(s))`,
  );
  assert(
    w.threw === undefined && w.outcome?.kind === "fixed" && w.outcome.reviewBound !== undefined,
    `(b4) and the pushed fix routes \`fixed\` with its unjudged lanes recorded, rather than throwing (${w.threw?.message ?? `kind ${String(w.outcome?.kind)}, bound ${JSON.stringify(w.outcome?.reviewBound)}`})`,
  );
}

cleanupRoots();
process.exit(failures());
