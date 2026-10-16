/**
 * lens-review-delta-disclose — what a delta review TELLS its surfaces
 * (#973/#1128), split from lens-review-diff.ts (the 500-line gate; the resolver
 * that produces these values is load-bearing and stays there).
 *
 * A delta review reviews less than the branch, so every surface it touches must
 * say so: the lens prompt (so a lens does not report main's hunks as
 * branch-authored defects), the review summary (so the operator sees the pass was
 * narrow), and the PR residuals (so a disclosed finding is disclosed against the
 * right range). One `fallback` reason, one sentence, three surfaces — which is
 * why the three builders sit together: a fourth surface is meant to reuse them,
 * not paraphrase them.
 *
 * The reason is NEUTRALISED here, at the one place it is rendered, so a
 * marker-like token inside a fallback reason cannot forge a verdict on the
 * surface that prints it.
 */

import { neutraliseEvidence } from "./comment-evidence.ts";

/** The delta a review ran against. `fallback` is set when an automatic delta
 * could not use its hunk-level method and reviewed the two-dot range instead
 * (the reason is disclosed in the context, the summary and the residuals). */
export interface AutoDeltaInfo {
  since: string;
  head: string;
  auto?: boolean;
  fallback?: string;
}

/** The fallback sentence, built once for every surface that discloses it (the
 * lens context, the review summary, the PR residuals). The reason is
 * neutralised here, so a marker-like token in it cannot forge a verdict on any
 * surface. */
export function deltaFallbackText(delta: { since: string; fallback: string }): string {
  return `this delta review covers the full two-dot range since ${delta.since.slice(0, 8)} because ${neutraliseEvidence(delta.fallback)}`;
}

/** The DELTA FALLBACK note appended to the lens context when an automatic delta
 * fell back to the two-dot range; empty when there is no fallback. */
export function deltaFallbackNote(delta: AutoDeltaInfo | undefined): string {
  if (!delta?.fallback) return "";
  return `\n\nDELTA FALLBACK: ${deltaFallbackText({ since: delta.since, fallback: delta.fallback })}. Main's hunks merged into the branch since then may be included; do not report them as branch-authored defects.`;
}

/** The `deltaReview` field of the review summary; carries the fallback when set. */
export function deltaReviewOf(delta: AutoDeltaInfo): {
  since: string;
  head: string;
  fallback?: string;
} {
  return {
    since: delta.since,
    head: delta.head,
    ...(delta.fallback ? { fallback: delta.fallback } : {}),
  };
}
