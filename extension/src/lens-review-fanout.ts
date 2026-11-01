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
 * the inline code had (`startPersistentBatch` before, `clearBatchEntry` after
 * the fan-out), kept intact by keeping both ends in one function.
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
  const results = await Promise.all(
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
  dispatchDeck.clearBatchEntry(args.batchKey);
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
  //   LIVENESS (`allLanesProducedEvidence`) — the LENS rows ONLY. A deterministic
  //   extra finding is not a lane: it is a grep result the caller merged, with
  //   no findings array of its own shape and no summary, so folding it into a
  //   liveness test would read every CLAIM_SCAN as a silent reviewer.
  const extraFindings = args.extraFindings ?? [];
  const accountedEvidence: readonly CoverageEvidence[] = [
    ...lensResults,
    ...extraFindings.map((f) => ({ findings: [f] })),
  ];
  const claimedEvidence: readonly CoverageEvidence[] = [
    ...results,
    ...extraFindings.map((f) => ({ findings: [f] })),
  ];
  const accounted = accountedFiles(accountedEvidence, expectedFiles ?? new Set());
  const allLanesProducedEvidence = results.every((r) => hasReviewEvidence(r.findings, r.summary));
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
    // `hasReviewEvidence` is the SAME predicate `lensProducedEvidence` /
    // `computeVerdict` refuse the round with (#1105), restated here only for
    // the positive claim: nothing here blocks, and the healthy rows are the
    // ones that could have read anything (a blocked lane contributed nothing).
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
