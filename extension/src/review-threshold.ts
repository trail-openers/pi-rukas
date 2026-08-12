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
  const named = decision.quote ? severityFromQuote(decision.quote) : undefined;
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

/**
 * The blocking bar a sentence sets, if it sets one.
 *
 * This used to be `SEVERITIES.find((s) => upper.includes(s))` — the most severe
 * level *named*, which is the LOOSEST bar. On this repo's own AGENTS.md §1 that
 * made the gate depend on how much of the passage the judge chose to quote:
 *
 *   "…blocking at MEDIUM severity and above."                        → MEDIUM
 *   …plus "until all MEDIUM, HIGH, and CRITICAL findings are resolved" → CRITICAL
 *
 * Both are honest citations that verify against the file, and the second
 * silently moved the bar two levels so HIGH and MEDIUM findings stopped
 * blocking. Scanning for the *least* severe token is not the fix either: the
 * same passage ends "Only LOW findings may be deferred", which would resolve to
 * LOW and over-tighten.
 *
 * The relation carries the meaning, so read the relation. "at X and above",
 * "X or higher", "X and up" name X as the bar. A bare list of severities that
 * block ("CRITICAL and HIGH findings block the merge") sets the bar at its
 * least severe member, because that is the lowest thing named as blocking.
 * Anything else is unreadable, and the caller applies the default.
 */
export function severityFromQuote(quote: string): ReviewSeverity | undefined {
  const upper = quote.toUpperCase();

  // "blocking at MEDIUM severity and above" / "block at MEDIUM or higher"
  const relational = upper.match(
    /\b(CRITICAL|HIGH|MEDIUM|LOW)\b[^.]{0,40}?\b(?:AND ABOVE|OR ABOVE|AND UP|OR HIGHER|AND HIGHER|OR GREATER)\b/,
  );
  if (relational?.[1]) return relational[1] as ReviewSeverity;

  // A sentence that says which severities block, without a relation. The bar is
  // the least severe of them — everything named is blocking, so the lowest one
  // is where blocking starts.
  if (/\bBLOCK/.test(upper)) {
    const named = SEVERITIES.filter((s) => new RegExp(`\\b${s}\\b`).test(upper));
    // Ignore a trailing "only LOW may be deferred"-style exemption: a severity
    // named as NOT blocking is not the bar.
    const blocking = named.filter(
      (s) =>
        !new RegExp(
          `\\b${s}\\b[^.]{0,40}?\\b(?:MAY BE DEFERRED|ARE DEFERRED|MAY BE OVERRIDDEN|NON-?BLOCKING)`,
        ).test(upper),
    );
    const last = blocking[blocking.length - 1];
    if (last) return last;
  }
  return undefined;
}
