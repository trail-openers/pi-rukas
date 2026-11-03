/**
 * work-driver-lens-cap-comment — the PR comment a capped review leaves behind,
 * and how each cap route words it.
 *
 * `work-driver-lens-cap.ts` decides where a capped review goes; that decision is
 * licensed by a comment the PR actually carries, and the comment is the half an
 * operator reads. It lives apart from the routing because the two change for
 * different reasons: the route changes when the conditions for carrying on
 * change, the wording changes when the prose a human must act on changes.
 *
 * The two routes (`round-cap`, `owed-round`) share every mechanic — patch
 * identity, marker, the recorded fact — and differ only in prose, so the union
 * is discriminated on `kind` and every field of a route is derived in ONE place
 * (`routeShape`): a field cannot arrive on the wrong route.
 */

import { renderLensFindings } from "./lens-findings-render.ts";
import type { PatchIdentity } from "./work-driver-draft-pr.ts";

/**
 * The PR comment a round-capped cycle leaves behind.
 *
 * Deliberately the same renderer the handoff surfaces use: the operator reading
 * this on the PR and the operator reading a handoff comment should be looking
 * at the same list in the same order, worst first. Empty string when the stored
 * findings blob yields nothing renderable — the caller treats that as a failed
 * disclosure, because an empty comment discloses nothing.
 *
 * #1398 round 3 — the caller passes the patch identity in and the marker goes on
 * the END of the body, exactly as `lens-review-residuals.ts` appends it. The
 * disclosure is only a disclosure if the PR carries the identity the guard and
 * the draft gate both compare: a body without the marker is prose that reads
 * like a disclosure and is invisible to both readers, and the round-cap route
 * used to post precisely that while recording the `lens-residuals-posted` fact.
 * The fact then licensed a ready the PR itself could not show.
 */
export function renderResidualFindings(
  findingsBlob: string | undefined,
  round: number,
  verdict: string,
  marker?: string,
  wording?: { owedRound: true; budgetLeftMin: number },
): string {
  const rendered = renderLensFindings(findingsBlob, verdict);
  if (rendered.length === 0) return "";
  return [
    // #1742 — the owed-round route says what actually happened. A round-cap
    // text on this route told the operator the fix LOOP had stopped, when it
    // was the re-review that never started, and named the wrong round.
    ...(wording?.owedRound
      ? [
          `## Six-pass review — findings from round ${round} unverified against the current head`,
          "",
          `The re-review of round ${round}'s fix was refused with ${wording.budgetLeftMin}m of review`,
          `budget left; these findings from round ${round} are unverified against the current`,
          "head. None is CRITICAL and the adversarial gate passed the diff, so the cycle carried",
          "on to CI instead of parking — but nothing listed here has been verified since the fix.",
          "Decide them before merging.",
        ]
      : [
          "## Six-pass review — findings still open at the round cap",
          "",
          `The lens review ran its ${round}-round fix loop and stopped with these`,
          "outstanding. None is CRITICAL and the adversarial gate passed the diff, so the",
          "cycle carried on to CI instead of parking — but nothing listed here has been",
          "fixed. Decide them before merging.",
        ]),
    "",
    ...rendered,
    // The marker is the renderer's own line (never passed through the
    // neutraliser, never sourced from a finding) and is what
    // `prCarriesDisclosure` / `mergeGuardRoundCap` substring-match.
    ...(marker ? ["", marker, ""] : []),
  ].join("\n");
}

/**
 * The round cap's undisclosed-disclosure plumb line, as one constant: the
 * event body and the `plumbReports` row are the same string, and the dedupe
 * compares against it. Kept prefix + reason so a test can pin the prefix while
 * the reason stays whatever the post actually reported.
 */
export const ROUND_CAP_DISCLOSURE_PREFIX =
  "Round cap with non-critical findings: could not post them to the PR (";

/**
 * #1742 — the owed round's own prefix. The step that was refused is the
 * re-review a fix owed, not the round cap, so the plumb report the handoff
 * renders must name the gate that actually refused it (a "Round cap" line on a
 * wall-clock refusal sends the operator to the wrong gate — the #398 class of
 * bug).
 */
export const OWED_ROUND_DISCLOSURE_PREFIX =
  "Refused lens re-review with non-critical findings: could not post them to the PR (";

/**
 * How one disclosure route words its comment, its trace lines and its plumb
 * report. Both routes share the mechanics (identity, marker, fact, decline);
 * only the prose differs, and the prose is what the operator reads. #1774 —
 * a DISCRIMINATED union: `kind` selects every wording/label/suffix in one
 * derivation (`routeShape`), so a field cannot arrive on the wrong route and
 * no caller can assemble a half-owed route by omission.
 */
export type ResidualDisclosureRoute =
  | {
      kind: "round-cap";
      /** #1774 — the round the comment names and the fact records. On BOTH arms
       *  now: the round used to be a positional argument beside the route, so
       *  the loop counter and the round the findings came from could disagree
       *  between the posted comment and the recorded fact. */
      round: number;
      /** The identity already computed by the caller's own gate, so the
       *  disclosure is keyed on the SAME string the route was licensed on
       *  rather than a second git read that could disagree with the first
       *  (#1742). Absent ⇒ computed here. */
      identity?: PatchIdentity;
    }
  | {
      kind: "owed-round";
      /** Minutes of review budget left at the refusal — the owed-round wording
       *  names it, so it must not be omissible. */
      budgetLeftMin: number;
      /** The round whose findings are disclosed: the comment names it, so the
       *  route carries it rather than trusting a positional argument. */
      round: number;
      /** Required: the owed route is only reachable after
       *  `owedVerdictOnCurrentHead` computed it — the disclosure keys on the
       *  SAME string the head gate licensed on (#1742). */
      identity: PatchIdentity;
    };

/** Everything the two routes differ on, derived from `kind` in ONE place
 *  (#1774): prefix, trace label, comment wording, scratch-file suffix, and the
 *  round both the comment and the fact name. A new route-shape field is added
 *  here or not at all. */
export function routeShape(route: ResidualDisclosureRoute): {
  prefix: string;
  traceLabel: string;
  scratchSuffix: string;
  commentRound: number;
  wording?: { owedRound: true; budgetLeftMin: number };
} {
  if (route.kind === "owed-round") {
    return {
      prefix: OWED_ROUND_DISCLOSURE_PREFIX,
      traceLabel: "lens-review-timeout",
      // The owed-round post is a different comment on a different subject (one
      // round's unverified findings, not the loop's residuals) — it must not
      // overwrite the round-cap file of the same round number.
      scratchSuffix: "-owed",
      commentRound: route.round,
      wording: { owedRound: true, budgetLeftMin: route.budgetLeftMin },
    };
  }
  return {
    prefix: ROUND_CAP_DISCLOSURE_PREFIX,
    traceLabel: "round-cap",
    scratchSuffix: "",
    commentRound: route.round,
  };
}
