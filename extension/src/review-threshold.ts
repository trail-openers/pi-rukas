/**
 * review-threshold — how serious a review finding must be before it blocks.
 *
 * The lens decides a finding's severity; that is its judgment. Which severity
 * is serious *enough to stop a merge* is a different question and it belongs to
 * the project. `AGENTS.md §1` in this repo has always said "blocking at MEDIUM
 * severity and above" — but nothing read that sentence, so it was decorative,
 * and a project wanting a different bar had no way to express one.
 *
 * **Configuration fails differently from authority, and the distinction is the
 * whole design.** `resolveMergeAuthority` fails closed: no answer means deny,
 * because the act it guards is irreversible. A blocking threshold has no such
 * asymmetry. A project with no `AGENTS.md`, an unreadable one, or one that
 * simply never mentions code review is the *normal* case — the overwhelming
 * majority of repositories — and it must get the shipped default rather than an
 * error, a refusal, or a review that blocks on nothing.
 */

import { type DoctrineDoc, type PolicyJudgeFn, askPolicy } from "./work-driver-policy.ts";

/** The question asked before a code review's verdict is computed. */
export const REVIEW_THRESHOLD_QUESTION =
  "At what code-review finding severity do these documents say a change should be blocked from merging until it is fixed? Answer 'permitted' with the sentence that states the severity, or 'unstated' if the documents do not say.";

/**
 * Which severities a project may name, most severe first.
 *
 * Read out of the judge's quote rather than asked for as a separate field: the
 * quote is the thing that gets verified against the file, so anything derived
 * from it inherits that verification. A severity mentioned in a sentence that
 * does not exist cannot be honoured.
 */
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type ReviewSeverity = (typeof SEVERITIES)[number];

export interface ReviewThreshold {
  severity: ReviewSeverity;
  /** The sentence relied on, when a project set it. */
  quote?: string;
  source: "doctrine" | "operator" | "default";
  reason: string;
}

/**
 * Resolve the severity at which a review finding blocks a merge.
 *
 * **This is configuration, not authority, and the two fail in opposite
 * directions.** Merge authority fails closed — no answer means deny, because
 * the act it guards is irreversible. A blocking threshold has no such
 * asymmetry: a project with no `AGENTS.md`, an unreadable one, or one that
 * simply never discusses code review is the *normal* case, and it must get the
 * default rather than an error or a refusal to review.
 *
 * So the rules are:
 *   - absent, unreadable, or silent doctrine → `MEDIUM`, the shipped default
 *   - a project may **loosen** the bar only with a verified citation
 *   - a project may **tighten** it freely — a stricter answer needs no proof,
 *     since being cautious on someone else's behalf is never the failure mode
 *     worth guarding against
 *   - the operator's env override beats both, as everywhere else
 */
export async function resolveReviewThreshold(
  judge: PolicyJudgeFn,
  docs: readonly DoctrineDoc[],
  defaultSeverity: ReviewSeverity = "MEDIUM",
): Promise<ReviewThreshold> {
  const env = process.env.PI_ENSEMBLE_REVIEW_THRESHOLD?.trim().toUpperCase();
  if (env && (SEVERITIES as readonly string[]).includes(env)) {
    return {
      severity: env as ReviewSeverity,
      source: "operator",
      reason: `PI_ENSEMBLE_REVIEW_THRESHOLD=${env}`,
    };
  }
  if (docs.length === 0) {
    return {
      severity: defaultSeverity,
      source: "default",
      reason: `no doctrine documents — using the default blocking severity ${defaultSeverity}`,
    };
  }

  const decision = await askPolicy(judge, REVIEW_THRESHOLD_QUESTION, docs);
  const named = decision.quote ? severityIn(decision.quote) : undefined;
  if (!decision.permitted || !named) {
    return {
      severity: defaultSeverity,
      source: "default",
      reason: `the documents do not state a blocking severity (${decision.reason}) — using the default ${defaultSeverity}`,
    };
  }

  // A citation that loosens must have survived verification; one that tightens
  // is honoured either way. `decision.permitted` already implies a verified
  // quote, so the distinction only matters if that ever changes — state it
  // explicitly rather than relying on the coupling.
  const loosens = SEVERITIES.indexOf(named) < SEVERITIES.indexOf(defaultSeverity);
  if (loosens && !decision.permitted) {
    return {
      severity: defaultSeverity,
      source: "default",
      reason: `a looser blocking severity (${named}) was claimed but not verifiably cited — keeping ${defaultSeverity}`,
    };
  }
  return {
    severity: named,
    quote: decision.quote,
    source: "doctrine",
    reason: `the project sets the blocking severity to ${named} ("${decision.quote?.slice(0, 160)}")`,
  };
}

/** The most severe level named in a sentence, if any. */
function severityIn(quote: string): ReviewSeverity | undefined {
  const upper = quote.toUpperCase();
  return SEVERITIES.find((s) => upper.includes(s));
}
