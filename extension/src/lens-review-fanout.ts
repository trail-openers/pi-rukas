/**
 * lens-review-fanout — the fan-out half of `runLensReview` (lens-review.ts owns
 * the run: diff resolution, the roster, the finish path).
 *
 * Pure move: the code here is the body the orchestrator used to carry inline,
 * unchanged apart from the surrounding signature. `lens-review.ts` had grown
 * past the 500-line cap on the back of the coverage accounting, and the fan-out
 * is the natural seam — it is the one block that touches the deck, the lens
 * children, and the two coverage lists, and it has its own inputs and its own
 * output (the repo's convention for this shape is per-concern files, as with
 * `work-driver-<step>.ts`).
 *
 * The split between the two coverage lists is the point of this file; see
 * `runLensFanOut`.
 */

import * as dispatchDeck from "./dispatch-deck.ts";
import {
  accountedFiles,
  expectedFilesOf,
  hasFindingClaimedFile,
  unaccountedFiles,
} from "./lens-review-coverage.ts";
import type { CoverageEvidence } from "./lens-review-coverage.ts";
import { hasReviewEvidence, incompleteLanes } from "./lens-review-incomplete.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import type { RosterEntry } from "./lens-roster.ts";

/** One lens child call, as `runLensReview` receives it through `lensChildFn`
 * (the real `runLensChild`, or a test stub). Structural so neither the real
 * spawner's args type nor a stub's has to be spelled here. */
// The real `runLensChild`'s own args type, so a stub and the real spawner are
// checked against the same contract rather than a hand-written approximation.
type LensChildCall = typeof import("./lens-review-child.ts").runLensChild;

/** The model/lane slot wrapper — `withLensModelSlot`, passed in rather than
 * imported so this module stays a leaf and the slot policy keeps living with
 * its own module. */
type ModelSlot = (
  lens: string,
  fn: () => Promise<LensRunResult>,
  signal?: AbortSignal,
) => Promise<LensRunResult>;

/** What `runLensFanOut` returns: the lens rows the round produced (healthy
 * children first, then one blocked row per blocked roster entry) and the
 * file-level coverage list read off them. */
export interface LensFanOut {
  lensResults: LensRunResult[];
  /** File-level DISCLOSURE: changed files no finding cited and no closing
   * summary named. Empty when the round had no defensible denominator (a
   * caller-pasted diff, or a diff with no readable file section) — which the
   * caller must read as "nothing to report", never as "everything was covered".
   * Never decides a verdict; see `runLensFanOut`. */
  unaccounted: string[];
  /** Whether the round had a denominator at all. `unaccounted` is `[]` both
   * when there was none and when every file was accounted for, and those two
   * are different facts — the first has nothing to say, the second says the
   * round covered everything it could measure. Carried as a field rather than
   * left for the renderer to re-infer from two independent optionals: the
   * producer knows which of the three states happened, the renderer does not.
   */
  hasDenominator: boolean;
  /** Whether at least one denominator file carries a `finding`-class claim (a
   * `report_finding` citation from a lens or from a deterministic extra
   * finding), as opposed to only `summary`-class substring claims. The caller
   * may print the positive "every file was covered" line only with this true:
   * prose that quotes a path is not evidence the lens read it. See
   * `hasFindingClaimedFile`.
   */
  findingClaimedFile: boolean;
}

/**
 * Fan the healthy roster out over `lensChildFn`, fold the blocked entries in as
 * blocked rows, and read the round's file-level coverage list off the result.
 *
 * The deck batch is opened by the caller and cleared here — the same pairing
 * the inline code had (`startPersistentBatch` before, `clearBatchEntry` at the
 * end of the fan-out), kept intact by keeping both ends in one function. The
 * clear runs in a `finally`, not on the line after the await: `Promise.all`
 * rejects on the first rejected child, so a line-after-await release is a
 * success-path-only release and a throwing child leaked the batch row and its
 * ticker for the rest of the run (pinned by
 * `test-lens-fanout-batch-release.ts`).
 *
 * VERDICT-LEVEL vs DISCLOSURE-LEVEL, and why they are split:
 *
 *   - Lens-level liveness IS verdict-bearing. A lane that came back having
 *     emitted neither a finding nor the closing summary the prompt requires is
 *     a lane nobody ran. That rule is `lensProducedEvidence` /
 *     `isReviewIncomplete` (lens-review-incomplete.ts), asked by
 *     `computeVerdict` — this function does not re-implement it and must not
 *     weaken it. `unreviewedLanes` at the call site is the NAMED list, so the
 *     operator knows which lanes to re-run.
 *   - File-level coverage is DISCLOSURE ONLY. It is derivable only from
 *     findings, so a clean round over genuinely good code has no rows and every
 *     file reads unaccounted; a blocking gate there fails exactly the case it
 *     exists to pass. Measured: gating on it refused rounds whose six lenses
 *     all completed. So `unaccounted` is a note, and nothing this function
 *     returns can turn a round into a blocked verdict.
 */
export async function runLensFanOut(args: {
  healthy: RosterEntry[];
  blocked: RosterEntry[];
  lensChildFn: LensChildCall;
  runId: string;
  skillsDir: string;
  context: string;
  roster: RosterEntry[];
  opts: Record<string, unknown> & { diff: string };
  bumpBatch: () => void;
  batchKey: string;
  signal?: AbortSignal;
  modelSlot: ModelSlot;
  /** The parent pi for the inner children's slow-run watch; absent on the
   * paths that have no pi of their own. */
  pi?: import("./async-jobs-lifecycle.ts").DispatchHost;
  /** The diff the review resolved itself, handed in so the denominator is the
   * change set the children were actually shown. `expectedFilesOf` refuses a
   * caller-pasted diff, which is the whole fail-open rule. */
  resolved: { kind: string; diffSource?: string; diff?: string } | undefined;
  /** Deterministic findings the caller merges separately (e.g. `CLAIM_SCAN`).
   * They are findings, so they account for the files they cite exactly as a
   * lens's own do — omitting them would give a grep-backed witness that DID
   * look less standing than model prose that merely quotes a path.
   */
  extraFindings?: readonly Finding[];
}): Promise<LensFanOut> {
  // THE DECK BATCH IS RELEASED IN `finally`, NOT AFTER THE AWAIT. The caller
  // (`runLensReview`) opened it with `startPersistentBatch` and this function is
  // the only place that clears it, so on the line after the await the release
  // was reachable only by the SUCCESS path: `Promise.all` rejects on the FIRST
  // rejected child, and a `lensChildFn` that threw skipped the clear and left
  // the batch row — and its 1s render ticker — in the deck for the rest of the
  // run, with no error anywhere to explain the dangling `code-review-specialist×N`.
  let results: LensRunResult[];
  try {
    results = await Promise.all(
      args.healthy.map((lens) =>
        args.modelSlot(
          lens.name,
          () =>
            args.lensChildFn({
              lens,
              runId: args.runId,
              skillsDir: args.skillsDir,
              context: args.context,
              roster: args.roster,
              opts: args.opts,
              bumpBatch: args.bumpBatch,
              ...(args.pi ? { pi: args.pi } : {}),
            }),
          args.signal,
        ),
      ),
    );
  } finally {
    dispatchDeck.clearBatchEntry(args.batchKey);
  }
  const blockedRows = args.blocked.map(
    (e): LensRunResult => ({
      lens: e.name,
      ok: false,
      ms: 0,
      startMs: Date.now(),
      findings: [],
      attempts: 0,
      blocked: true,
      parseError: e.error ?? "",
    }),
  );
  const lensResults = [...results, ...blockedRows];
  // The round's denominator, read from the diff the review itself resolved —
  // never from a caller-pasted string (`expectedFilesOf` refuses one). Absent
  // means "nothing to check", a different fact from "nothing covered", so it is
  // carried as `hasDenominator` rather than folded into the list.
  const expectedFiles = expectedFilesOf(args.resolved);
  // Deterministic extra findings account for files exactly as a lens's own
  // rows do (see the field docs) — one evidence list for both coverage
  // questions, so the disclosure and the positive claim cannot disagree about
  // what was cited.
  // The two evidence lists are deliberately DIFFERENT, and the asymmetry is
  // the whole point of each:
  //
  //   ACCOUNTING (`accounted`, `claimed`) — lens rows PLUS the deterministic
  //   extra findings. A CLAIM_SCAN row that cites a changed file shows the
  //   change was looked at, so it accounts for that file exactly as a lens's
  //   own finding does. Excluding it gave a grep-backed witness that DID look
  //   less standing than model prose that merely quotes a path.
  //
  //   LIVENESS (`allLanesProducedEvidence`) — the HEALTHY rows ONLY (`results`,
  //   never `lensResults`). A deterministic extra finding is not a lane: it is a
  //   grep result the caller merged, with no findings array of its own shape and
  //   no summary, so folding it into a liveness test would read every CLAIM_SCAN
  //   as a silent reviewer. And a BLOCKED lane contributed nothing to the round,
  //   so its row cannot make the liveness test true either. The predicate that
  //   answers this and the one `computeVerdict` refuses the round with (#1105)
  //   are the same FUNCTION over DIFFERENT sets — this one over `results`,
  //   `lensProducedEvidence` over `lensResults` (healthy + blocked). Today the
  //   two agree because a blocked row carries neither finding nor summary and so
  //   fails the predicate from both sides; they would diverge silently if either
  //   list changed, which is why each reads a named list and not "the rows".
  const extraFindings = args.extraFindings ?? [];
  // Harness rows join the accounting ONLY when at least one healthy lane
  // actually ran (`results.length > 0`): on a zero-healthy round nobody read
  // anything, and merged CLAIM_SCAN rows must not fill the denominator by
  // themselves — that would report "no gap" for a round that reviewed nothing.
  const accountedEvidence: readonly CoverageEvidence[] = [
    ...lensResults,
    ...(results.length > 0 ? extraFindings.map((f) => ({ findings: [f] })) : []),
  ];
  // The SAME `results.length > 0` gate as the accounting list: an ungated merge
  // let one caller-supplied row satisfy `hasFindingClaimedFile` on a round where
  // no lane ran, which is the ✓ for a review that reviewed nothing.
  const claimedEvidence: readonly CoverageEvidence[] = [
    ...results,
    ...(results.length > 0 ? extraFindings.map((f) => ({ findings: [f] })) : []),
  ];
  const accounted = accountedFiles(accountedEvidence, expectedFiles ?? new Set());
  // `results.length > 0` is load-bearing: `[].every(...)` is TRUE, so without it
  // a roster with ZERO healthy lanes (everything blocked) would sail the
  // liveness test and a single merged `extraFindings` row would satisfy
  // `hasFindingClaimedFile` — a round that reviewed nothing would earn the ✓.
  // Same reason it gates the accounting list above: it is the fan-out's only
  // witness that a lane ran at all, and the same expression must not mean "a
  // lane ran" in one place and "every lane spoke" in the other.
  const allLanesProducedEvidence =
    results.length > 0 && results.every((r) => hasReviewEvidence(r.findings, r.summary));
  return {
    lensResults,
    unaccounted:
      expectedFiles === undefined ? [] : unaccountedFiles(expectedFiles, accounted ?? new Map()),
    hasDenominator: expectedFiles !== undefined,
    // Two ways a round may NOT claim coverage positively: no healthy lane
    // cited a denominator file in a STRUCTURED finding (prose that quotes the
    // paths is not reading them — `hasFindingClaimedFile`), or some lane left
    // no evidence at all, in which case the round admits it did not review its
    // own denominator and cannot simultaneously claim to have covered it.
    // `hasReviewEvidence` here is the same FUNCTION `lensProducedEvidence` /
    // `computeVerdict` refuse the round with (#1105), read over the HEALTHY
    // rows (`results`) rather than their set (`lensResults`, healthy + blocked):
    // nothing here blocks, and the healthy rows are the ones that could have
    // read anything. See the ACCOUNTING/LIVENESS note above for why the two
    // lists differ and what would make them diverge.
    findingClaimedFile: coverageClaimEarned(
      expectedFiles,
      claimedEvidence,
      allLanesProducedEvidence,
    ),
  };
}

/**
 * The one place the POSITIVE coverage claim is decided, kept separate from the
 * fan-out so the rule is assertable without spawning anything.
 *
 * A round may claim "every file in this round's denominator was covered" only
 * when ALL THREE hold:
 *
 *   1. it HAD a denominator (`expectedFiles` defined — a caller-pasted diff or
 *      an unreadable diff earns nothing, positive or negative);
 *   2. at least one denominator file was cited by a STRUCTURED finding
 *      (`hasFindingClaimedFile`) — a closing summary that merely QUOTES the
 *      paths is `summary.includes(file)` and proves nobody read them; and
 *   3. no healthy lane came back silent (`allLanesProducedEvidence`) — a round
 *      that admits one of its own reviewers produced nothing cannot also
 *      certify that everything got reviewed.
 *
 * Everything here is DISCLOSURE: none of it blocks. It only decides whether the
 * ✓ line is allowed to print, which is the field an adversarial review
 * reproduced lying — `coverageComplete: true` beside a round whose evidence was
 * prose quoting paths, and beside one carrying `REVIEW_INCOMPLETE`.
 */
export function coverageClaimEarned(
  expectedFiles: ReadonlySet<string> | undefined,
  claimedEvidence: readonly CoverageEvidence[],
  allLanesProducedEvidence: boolean,
): boolean {
  if (expectedFiles === undefined) return false;
  return allLanesProducedEvidence && hasFindingClaimedFile(claimedEvidence, expectedFiles);
}

/**
 * The lens-level list: every lane that left the round without evidence, named
 * with what actually happened to it. Delegates to `incompleteLanes`
 * (lens-review-incomplete.ts) so the reason strings — blocked vs silent vs
 * cap-killed vs skill-reread — exist once instead of a third time.
 */
export function unreviewedLanesOf(lensResults: readonly LensRunResult[]): string[] {
  return incompleteLanes(lensResults);
}
