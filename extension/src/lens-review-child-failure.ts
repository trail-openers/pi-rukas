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

import { CONTEXT_LENGTH_HINT, providerTurnCapProblem } from "./lens-provider-cause.ts";
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
 * Everything a failed child left behind that could carry the provider's own
 * words (#2261). The spawn layer resolves `text` as `text || stderr ||
 * "(no output)"` (`spawn-collapse-events.ts`), so a child that died before
 * printing anything has the provider's refusal in `text`; one that died
 * mid-stream may carry it in `errorStop.message` instead. Both are inspected so
 * the caller never has to know which arm it is in — and neither is echoed whole
 * into a report: the reason built below clips what it quotes.
 */
export function providerChildText(result: DispatchResult | undefined): string {
  if (result === undefined) return "";
  return `${result.text ?? ""}\n${result.errorStop?.message ?? ""}`;
}

/** Did the provider refuse this child's prompt as too large for its window? */
export function lensProviderRefusal(result: DispatchResult | undefined): string | undefined {
  return providerTurnCapProblem(providerChildText(result));
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
 * a provider refusal is named whatever the retry path decided, because it is the
 * cause the operator can act on (the bound it hit, and the switch that restores
 * the old prompt shape).
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
  const providerCause = lensProviderRefusal(result);
  // A provider that refused the prompt answered NOTHING — no findings, no
  // review. Whatever prose reached `text` for such a child is the refusal itself
  // (the spawn layer's stderr fallback), so the evidence rule above cannot let it
  // carry the lane: a refusal is not a closing summary, and a lens whose own
  // provider says "maximum context length" has not reviewed the diff however the
  // text reads.
  const hasEvidence =
    findings.length > 0 || (!!summary && textIsReviewOutput && providerCause === undefined);
  return {
    lens,
    ok: false,
    ms: result?.ms ?? 0,
    startMs,
    findings: hasEvidence ? findings : [],
    attempts,
    blocked: !hasEvidence || bounded,
    parseError: bounded
      ? `not reviewed — no verdict within its ${Math.max(1, Math.round(boundMs / 60_000))}-min lens bound (PI_ENSEMBLE_LENS_BOUND_MS, never past the review budget); ended, not retried`
      : providerCause !== undefined
        ? `${CONTEXT_LENGTH_HINT}: the provider refused this lens's prompt and it was NOT retried — the change is too large for the lens prompt to inline whole (PI_ENSEMBLE_LENS_LARGE_DIFF=0 restores the old unbounded prompt): ${providerCause.slice(0, 160)}`
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
    ...(hasEvidence && result ? { model: result.model } : {}),
    ...(hasEvidence && result?.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
    ...(result?.killCause ? { killCause: result.killCause } : {}),
    ...(result?.killCause === "loop" && result.loopEvidence
      ? { loopEvidence: result.loopEvidence }
      : {}),
    ...(result?.killCause === "token-budget" && result.tokenBudget
      ? { tokenBudget: result.tokenBudget }
      : {}),
  };
}
