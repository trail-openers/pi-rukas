/**
 * review-threshold — how serious a review finding must be before it blocks.
 *
 * The lens decides a finding's severity; that is its judgment. Which severity
 * is serious *enough to stop a merge* is a different question and it belongs to
 * the project. `AGENTS.md §1` in this repo states the bar in prose: HIGH
 * severity and above. For longer than that nothing read the sentence, so it was
 * decorative, and a project wanting a different bar had no way to express one.
 *
 * **Configuration fails differently from authority, and the distinction is the
 * whole design.** `resolveMergeAuthority` fails closed: no answer means deny,
 * because the act it guards is irreversible. A blocking threshold has no such
 * asymmetry. A project with no `AGENTS.md`, an unreadable one, or one that
 * simply never mentions code review is the *normal* case — the overwhelming
 * majority of repositories — and it must get the shipped default rather than an
 * error, a refusal, or a review that blocks on nothing.
 *
 * **The shipped default is HIGH**, which is also this repo's own bar, so the
 * common case — a repository whose doctrine says nothing — judges ordinary
 * best-practice findings as disclosable rather than as fix orders. A project
 * states a different bar with a citation-verified sentence, or the operator
 * moves it for one run with `PI_ENSEMBLE_REVIEW_THRESHOLD`.
 */

import type { DecisionWhere } from "./decision-seam.ts";
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
export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type ReviewSeverity = (typeof SEVERITIES)[number];

/**
 * How serious a finding must be before it blocks, for a project that says
 * nothing. ONE definition, imported by every path that needs a bar: a second
 * literal is a second rule that can drift from the one that produced the
 * verdict beside it.
 *
 * HIGH, because most repositories state no bar anywhere, and at a MEDIUM bar
 * that majority got ordinary best-practice findings turned into fix orders.
 * Lowering is the project's decision — through a citation-verified sentence or
 * the operator's env override, never through silence here.
 */
export const DEFAULT_REVIEW_THRESHOLD: ReviewSeverity = "HIGH";

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
 *   - absent, unreadable, or silent doctrine → `DEFAULT_REVIEW_THRESHOLD`, the
 *     shipped HIGH default. "Silent" includes a quote that verifies but states
 *     no readable bar: an unparseable sentence falls to the default too, which
 *     over-tightens rather than over-loosens
 *   - a project may **loosen** the bar only with a verified citation
 *   - a project may **tighten** it freely — a stricter answer needs no proof,
 *     since being cautious on someone else's behalf is never the failure mode
 *     worth guarding against
 *   - **the verified quote decides the severity, not the judge's label.** On
 *     the `policy-judge` seam a non-passing answer (`forbidden`) is honoured by
 *     composition with no evidence check at all, so `permitted` is false for a
 *     perfectly good citation and gating the bar on the label flips it run to
 *     run. A judge that quotes this repo's own "blocking at HIGH severity and
 *     above" verbatim has told us the bar, whatever it labelled that sentence.
 *   - the operator's env override beats both, as everywhere else
 */
export async function resolveReviewThreshold(
  judge: PolicyJudgeFn,
  docs: readonly DoctrineDoc[],
  defaultSeverity: ReviewSeverity = DEFAULT_REVIEW_THRESHOLD,
  where?: DecisionWhere,
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

  const decision = await askPolicy(judge, REVIEW_THRESHOLD_QUESTION, docs, where);
  // The citation, not the label: `quoteVerified` is the seam's own evidence
  // check, so nothing is read off `quote` unless it survived it — which is also
  // why a project can only loosen the bar with a citation that verifies.
  const named =
    decision.quoteVerified && decision.quote ? severityFromQuote(decision.quote) : undefined;
  if (!named) {
    return {
      severity: defaultSeverity,
      source: "default",
      reason: `the documents do not verifiably state a blocking severity (${decision.reason}) — using the default ${defaultSeverity}`,
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

/**
 * Is `severity` at or above the blocking `bar`? (Most severe first, so HIGH
 * blocks at a HIGH bar and MEDIUM does not.)
 *
 * Takes `unknown` because callers read severities off serialised JSON, where a
 * missing or malformed value is NOT a severity and must never be treated as a
 * pass: a row the caller cannot rank is never evidence that nothing blocks.
 *
 * `bar` is required. An optional bar would have to carry a default, and a
 * default here is a bar the caller never chose — every caller knows which bar
 * it is scoring at (the resolved threshold, or the bar recorded on the row),
 * and inventing one silently moves the gate for whoever forgot to pass it.
 */
export function isBlockingSeverity(severity: unknown, bar: ReviewSeverity): boolean {
  const rank = SEVERITIES.indexOf(severity as ReviewSeverity);
  return rank === -1 || rank <= SEVERITIES.indexOf(bar);
}
