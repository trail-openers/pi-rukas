/**
 * work-driver-intent-finalise — the spec's final verdict at the explore step (#1151).
 *
 * Kept apart from work-driver-intent-criticality.ts: work-driver-intent.ts imports
 * the criticality module, so calling reconcileVerdict from there made a runtime
 * import cycle. This module imports both sides; nothing imports it back.
 *
 * `finaliseSpecVerdict` is the only export of the open-point gate. The order is
 * the contract: reconcile the resolver's verdict first, then apply the filed
 * issue's open points. Reconciliation can lift an `underspecified` park, and the
 * gate must still park an authorization point after that.
 */

import { matchSecurityTerm } from "./open-points-contract.ts";
import { trace } from "./trace.ts";
import {
  type OpenPoint,
  type OpenPointReading,
  openPointText,
  readOpenPoints,
} from "./work-driver-intent-criticality.ts";
import {
  type NormalisedSpec,
  type SpecAssumption,
  reconcileVerdict,
} from "./work-driver-intent.ts";

/** #1151: the assumption text for one CRITICAL point is capped at this many characters. */
const OPEN_POINT_ASSUMPTION_MAX = 300;

/** Clip by code point, so a surrogate pair is never split into a lone half. */
function clipTo(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * Issue text quoted into the PR body or handoff. Each run of control characters
 * (`\p{Cc}`) and U+2028/U+2029 becomes one space, whitespace is collapsed, then
 * the text is code-span quoted and clipped so it stays inert in Markdown.
 */
function quotedIssueText(text: string): string {
  const flat = text
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `\`${clipTo(flat.replace(/`/g, "'"), OPEN_POINT_ASSUMPTION_MAX)}\``;
}

/**
 * The spec's final verdict at the explore step.
 *
 * `primaryBody` is the primary issue body as read. A body with no open-points
 * section yields no open points, so the spec passes through the gate unchanged.
 */
export function finaliseSpecVerdict(spec: NormalisedSpec, primaryBody: string): NormalisedSpec {
  return applyOpenPointGate(reconcileVerdict(spec), readOpenPoints(primaryBody));
}

/** A resolved point is recorded as an assumption, so the answer reaches the PR body. */
function resolvedAssumption(point: OpenPoint): SpecAssumption {
  const text = openPointText(point);
  if (matchSecurityTerm(text)) {
    return {
      text: `security open point self-resolved in the issue body: ${quotedIssueText(text)}`,
      basis:
        "the filed issue marks this security-class CRITICAL point resolved; recorded, not authenticated",
    };
  }
  return {
    text: `Resolved open point (marked [RESOLVED] in the issue body): ${quotedIssueText(text)}`,
    basis: "the filed issue marks this CRITICAL point resolved",
  };
}

/**
 * Apply the filed issue's CRITICAL open points to the spec (#1151).
 *
 * - Resolved bullets (`[RESOLVED]` after the tag) are traced and recorded as
 *   assumptions, so the answer reaches the PR body. They never gate.
 * - No unresolved or unparsed CRITICAL lines: the spec is otherwise unchanged.
 * - A security-class point, parsed or unparsed: park as `security-open-point`
 *   (the driver will not choose that policy). An existing park is kept and the
 *   security points join its open questions. Either way each one is recorded as
 *   an open question, prefixed `Security open point (unresolved):`, so the handoff
 *   names it.
 * - Any other unresolved point, or a CRITICAL line that did not parse: a
 *   `proceed` is capped at `proceed-with-assumptions`, each named as an
 *   assumption. An existing park is never rewritten here.
 */
function applyOpenPointGate(spec: NormalisedSpec, reading: OpenPointReading): NormalisedSpec {
  for (const point of reading.resolved) {
    trace(
      `work-driver: intent — resolved open point skipped: ${clipTo(openPointText(point), OPEN_POINT_ASSUMPTION_MAX)}`,
    );
  }
  const base: NormalisedSpec =
    reading.resolved.length === 0
      ? spec
      : {
          ...spec,
          assumptions: [...spec.assumptions, ...reading.resolved.map(resolvedAssumption)],
        };
  const { points, unparsed } = reading;
  if (unparsed.length > 0) {
    trace(
      `open-point-unparsed: ${unparsed.length} CRITICAL line(s) in the Open points section did not parse`,
    );
  }
  if (points.length === 0 && unparsed.length === 0) return base;

  const securityPoints = [...points.map(openPointText), ...unparsed].filter((text) =>
    matchSecurityTerm(text),
  );
  const securityQuestions = securityPoints.map(
    (text) => `Security open point (unresolved): ${quotedIssueText(text)}`,
  );
  if (base.verdict === "park") {
    trace(
      `work-driver: intent — open-point gate skipped: spec already parked (${points.length} CRITICAL point(s), ${securityPoints.length} security-class)`,
    );
    return { ...base, openQuestions: [...base.openQuestions, ...securityQuestions] };
  }
  if (securityPoints.length > 0) {
    const term = matchSecurityTerm(securityPoints[0] ?? "");
    trace(
      `work-driver: intent — unresolved CRITICAL open point concerns ${term?.label ?? "authorization"}, parking`,
    );
    return {
      ...base,
      verdict: "park",
      parkReason: "security-open-point",
      parkReasonSource: "default",
      openQuestions: [...base.openQuestions, ...securityQuestions],
    };
  }
  trace(
    `work-driver: intent — ${points.length} unresolved CRITICAL open point(s), ${unparsed.length} unparsed line(s) carried as assumptions`,
  );
  return {
    ...base,
    verdict: "proceed-with-assumptions",
    assumptions: [
      ...base.assumptions,
      ...points.map((point) => ({
        text: `unresolved CRITICAL open point in the filed issue: ${quotedIssueText(openPointText(point))}`,
        basis: "named by the intent gate; proceeding on it as an assumption",
      })),
      ...unparsed.map((line) => ({
        text: `Open-point gate could not parse a CRITICAL line: ${quotedIssueText(line)}`,
        basis:
          "open-point-unparsed — the gate could not read this line; proceeding on it as an assumption",
      })),
    ],
  };
}
