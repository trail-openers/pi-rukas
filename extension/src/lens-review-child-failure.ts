/**
 * lens-review-child-failure — how one lens child that did NOT succeed is
 * classified: blocked or kept, and what the lane says about why (#2261).
 *
 * `runLensChild` owns the spawn, the retry loop and the run bound; this module
 * owns the single judgement made once the loop gives up. The rule lives here
 * rather than inline because the classes it separates arrive looking alike: a
 * lens killed at its bound, a lens the provider refused for its prompt size, a
 * cap-killed lens that had already written half a review, and a lens that
 * returned silence are four different operator stories that all reach the caller
 * as `!ok`.
 *
 * Two of them were mis-told before this split. A child-bound lens was reported
 * as "failed every retry" when it was never retried. A provider refusal — six
 * children, HTTP 400 "maximum context length", ~0.6 s each — was reported as
 * `exit 1`, so the review looked like flaky infrastructure while the real cause
 * (a prompt too large for the model's window) was nowhere in the output.
 */

import {
  CONTEXT_LENGTH_HINT,
  isProviderContextLengthFailure,
  providerContextProblem,
} from "./lens-provider-cause.ts";
import { NO_TEXT_PLACEHOLDER } from "./lens-review-incomplete.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import type { DispatchResult } from "./types.ts";

/** What the caller owes this module to render one failed lane. */
export interface LensFailureInput {
  lens: string;
  /** The last spawn's result, or nothing when every spawn threw. */
  result: DispatchResult | undefined;
  /** Spawns the retry loop made — 0 means the child never ran. */
  attempts: number;
  /** Findings already extracted from `result` (the caller owns extraction). */
  findings: Finding[];
  startMs: number;
  /** This lens's armed run bound, for the bound row's minute figure. */
  boundMs: number;
  /** The retry loop's last recorded error, used only when nothing better is known. */
  lastError?: string;
}

/**
 * The lane's provider cause, decided by the SAME predicate the retry loop uses.
 *
 * This is the second half of one rule. `runLensChild` breaks its loop on
 * `isProviderContextLengthFailure` — the provider's own `errorStop` carrying an
 * HTTP 400 AND unambiguous size wording and no rate vocabulary — so the lane that
 * ends must tell the operator about the same event, read from the same channel.
 * Reading the cause off `text` instead (as this module did) let a line of reviewed
 * source — a test fixture asserting a 400, an error string, a README snippet — stamp
 * a lane "the provider refused this lens's prompt", and because `hasEvidence`
 * discounts a refused child, it then DISCARDED that lane's real findings and turned
 * the lane into blocked / REVIEW_INCOMPLETE while the loop had correctly spent all
 * four attempts. Two channels, two stories about one child.
 *
 * `providerContextProblem` is then applied to the same `errorStop` message only to
 * render the quoted reason, so the sentence's wording and the decision behind it
 * cannot disagree.
 */
function laneProviderCause(result: DispatchResult | undefined): string | undefined {
  if (!isProviderContextLengthFailure(result)) return undefined;
  return providerContextProblem(result?.errorStop?.message);
}

/**
 * The clause naming what the loop did with this lane, worded from the attempts it
 * actually made. A provider refusal of the prompt is a never-retried class, so a row
 * for one says so — but only when the attempt count agrees, because the count is the
 * evidence: a row that claims "not retried" over four attempts is describing a loop
 * that ran, and the operator stops trusting the row that misreports it.
 */
function retryClause(attempts: number): string {
  if (attempts <= 1) return "and it was not retried";
  return `and the loop made ${String(attempts)} attempts before giving up`;
}

/**
 * A mid-turn stop of a child that WAS working: its prose is the partial review
 * the caller preserves rather than discards. A timeout / inactivity / abort kill
 * is not in this class — pre-kill narration from a child that hung is not
 * evidence, and treating it as such is the all-failed-review-renders-APPROVED
 * shape (#966).
 */
function selfInflictedCap(killCause: DispatchResult["killCause"]): boolean {
  return (
    killCause === "loop" ||
    killCause === "token-budget" ||
    // #1827 — `review-skill-reread` belongs HERE, not with the timeout / abort
    // kills: it fires only in a child that was actively working (it opened its
    // own SKILL.md too many times), so its prose is the same partial review a
    // loop kill preserves.
    killCause === "review-skill-reread"
  );
}

/**
 * The failed lane's row: what it kept, whether the lane counts as unreviewed,
 * and the one-line reason the operator reads.
 *
 * The reason is chosen in the order a reader would ask about it — was it bound-
 * ended? did the provider refuse it? was there anything to retry at all? — and
 * a provider refusal is named whatever the retry path decided, from the SAME
 * predicate and the SAME channel the loop read, because it is the cause the
 * operator can act on (the bound it hit, and the switch that restores the old
 * prompt shape). The row's own attempt count is what says whether the lane was
 * retried — never a fixed sentence about a loop that ran.
 */
export function failedLensRow(input: LensFailureInput): LensRunResult {
  const { lens, result, attempts, findings, startMs, boundMs, lastError } = input;
  const summary = result?.text?.trim() || undefined;
  const capKill = selfInflictedCap(result?.killCause);
  // #966 — one source for the placeholder: NO_TEXT_PLACEHOLDER
  // (lens-review-incomplete.ts, where `collapseEvents` declares it).
  const textIsReviewOutput =
    !!summary && summary !== NO_TEXT_PLACEHOLDER && (result?.thinkingOnly === true || capKill);
  // #1564 — a lens ended at its run bound never gave a verdict: its lane is not
  // reviewed (blocked → REVIEW_INCOMPLETE) even when it reported some findings
  // first, which are kept.
  const bounded = result?.killCause === "child-bound";
  // Read from the provider's structured refusal, on the same predicate the retry
  // loop broke on — never from `result.text`, which is the child's prose and can
  // carry diff-authored bytes (see `laneProviderCause`).
  const providerCause = laneProviderCause(result);
  const refused = providerCause !== undefined;
  // A provider that refused the prompt answered NOTHING — no findings, no
  // review. For a child the provider really did refuse, the prose that reached
  // `text` is the refusal the spawn layer fell back to (stderr), so the evidence
  // rule below cannot let it carry the lane: a refusal is not a closing summary,
  // and a lens whose own provider says "maximum context length" has not reviewed
  // the diff however the text reads. Because the cause is now the loop's own
  // predicate, this discount applies to exactly the children that were refused —
  // and no longer to a lane whose prose merely SOUNDS like a refusal, whose
  // findings are evidence and stay in the round.
  //
  // So `hasEvidence` asks the question the verdict needs — would this row, on its
  // own, count as a reviewed lane — and a refusal can never answer yes, whatever
  // else killed the child. That is the case this clause exists for: a lane refused
  // by its provider AND killed by one of its own caps AND holding a finding used to
  // come back `blocked:false` with no reason, because the cap-kill arm treated the
  // findings as a closing summary. `laneReason` then never reached the provider
  // clause, `isReviewIncomplete` called the round covered, and the summary printed
  // a provider refusal beside "(killed: token-budget)" for a prompt that was never
  // answered.
  const hasEvidence = !refused && (findings.length > 0 || (!!summary && textIsReviewOutput));
  // Disclosure is a separate question from whether the lane was reviewed. A refused
  // child's findings are real `report_finding` calls it made before the refusal, so
  // they are handed to the round rather than thrown away with the lane's claim to
  // have reviewed it; `model`/`transcriptPath` travel with them for the same reason
  // (#2040: a HIGH's reproduction is checked against the child that filed it).
  const kept = refused || hasEvidence ? findings : [];
  // What the row shows as evidence of this child having worked: a reviewed lane
  // always, a refused one only once it has findings to disclose.
  const showsEvidence = hasEvidence || (refused && kept.length > 0);
  return {
    lens,
    ok: false,
    ms: result?.ms ?? 0,
    startMs,
    findings: kept,
    attempts,
    blocked: !hasEvidence || bounded,
    parseError: bounded
      ? `not reviewed — no verdict within its ${Math.max(1, Math.round(boundMs / 60_000))}-min lens bound (PI_ENSEMBLE_LENS_BOUND_MS, never past the review budget); ended, not retried`
      : providerCause !== undefined
        ? `${CONTEXT_LENGTH_HINT}: the provider refused this lens's prompt ${retryClause(attempts)} — the change is too large for the lens prompt to inline whole (PI_ENSEMBLE_LENS_LARGE_DIFF=0 restores the old unbounded prompt): ${providerCause.slice(0, 160)}`
        : hasEvidence
          ? undefined
          : (lastError ?? "unknown failure"),
    summary: hasEvidence ? summary : undefined,
    usage: result?.usage,
    // #2040 — the calls this child made travel with its findings: a HIGH's
    // reproduction is checked against THIS child, and a row that keeps none
    // reads as a child that ran nothing.
    toolUses: result?.toolUses ?? [],
    ...(result?.toolResults ? { toolResults: result.toolResults } : {}),
    ...(showsEvidence && result ? { model: result.model } : {}),
    ...(showsEvidence && result?.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
    ...(result?.killCause ? { killCause: result.killCause } : {}),
    ...(result?.killCause === "loop" && result.loopEvidence
      ? { loopEvidence: result.loopEvidence }
      : {}),
    ...(result?.killCause === "token-budget" && result.tokenBudget
      ? { tokenBudget: result.tokenBudget }
      : {}),
  };
}
