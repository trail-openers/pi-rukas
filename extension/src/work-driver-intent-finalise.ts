/**
 * work-driver-intent-finalise — the spec's final verdict at the explore step (#1151).
 *
 * Kept apart from work-driver-intent-criticality.ts: work-driver-intent.ts imports
 * the criticality module, so calling reconcileVerdict from there made a runtime
 * import cycle. This module imports both sides; nothing imports it back.
 *
 * The order is the contract: reconcile the resolver's verdict first, then apply
 * the filed issue's open points. Reconciliation can lift an `underspecified`
 * park, and the open-point gate must still park an authorization point after that.
 * The open-point gate is reached only through `finaliseSpecVerdict`.
 */

import { redactClip } from "./decision-log.ts";
import type { DecisionWhere } from "./decision-seam.ts";
import { shadowDecide } from "./decision-shadow.ts";
import { matchSecurityTerm } from "./security-class.ts";
import { flattenAndClip, flattenIssueText } from "./text-flatten.ts";
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

/** #1308 S4: at most this many open points per issue are asked about in shadow. */
const MAX_SHADOW_POINTS = 5;

/** #1151: the assumption text for one CRITICAL point is capped at this many characters. */
const OPEN_POINT_ASSUMPTION_MAX = 300;

/**
 * Code-span quoting for untrusted issue text: keeps it inert in the PR body.
 * Flatten-and-clip is shared with fetchFailureReason (text-flatten.ts).
 */
function quotedIssueText(text: string): string {
  return `\`${flattenAndClip(text.replace(/`/g, "'"), OPEN_POINT_ASSUMPTION_MAX)}\``;
}

/**
 * The security term a point names. Invisible format characters are removed first,
 * so `pass\u200Bword` reads as `password` (#1171).
 */
function securityTermOf(text: string) {
  return matchSecurityTerm(flattenIssueText(text));
}

/**
 * The spec's final verdict at the explore step.
 *
 * `primaryBody` is the primary issue body as read; `undefined` or blank means
 * the gate could not run, which is recorded rather than silently skipped.
 * A blank body parks a proceed as underspecified, so it cannot pass as a clean read;
 * an existing park keeps its reason and gains the note.
 */
export function finaliseSpecVerdict(
  spec: NormalisedSpec,
  primaryBody: string | undefined,
  /** #1308 S4 — where the security seam's shadow decisions are logged; omitted, none are asked. */
  shadow?: DecisionWhere,
): NormalisedSpec {
  const reconciled = reconcileVerdict(spec);
  if (primaryBody === undefined || primaryBody.trim() === "") {
    trace(
      "open-point-gate-unchecked: the filed issue body was blank; its open points were not checked",
    );
    // Recorded even when the spec is already parked: an unchecked body is a fact the PR body must carry.
    // Applied after reconcileVerdict, so no reconciliation can lift this park.
    return parkUnchecked(reconciled, {
      text: "Open-point gate did not run: issue body blank",
      basis:
        "open-point-gate-unchecked — the driver could not check the issue for CRITICAL open points",
    });
  }
  return applyOpenPointGate(reconciled, readOpenPoints(primaryBody), shadow);
}

/**
 * #1308 S4 — ask the `security-open-point` seam about one unresolved CRITICAL
 * point, in shadow: the term rule's answer (`isSecurity`) is what gates, and
 * the model's answer is only logged, fired without awaiting so the verdict
 * stays synchronous. The model sees the point's own text, bounded — never the
 * rest of the issue — and not the rule's answer, so S5 measures two
 * independent readings.
 */
function askSecuritySeam(text: string, isSecurity: boolean, where: DecisionWhere): void {
  void shadowDecide(
    "security-open-point",
    {
      question: "Is this open point a security decision?",
      state: { openPoint: redactClip(text, 1000) },
      rule: isSecurity ? "true" : "false",
    },
    where,
  );
}

/** A resolved point is recorded as an assumption, so the answer reaches the PR body. */
function resolvedAssumption(point: OpenPoint): SpecAssumption {
  const text = openPointText(point);
  if (securityTermOf(text)) {
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
 * The unread-body cap (#1171): a proceed the open-point gate never checked is parked
 * as underspecified, because the driver cannot say the issue is clean. An existing
 * park keeps its reason and only gains the note.
 */
function parkUnchecked(spec: NormalisedSpec, note: SpecAssumption): NormalisedSpec {
  const withNote = { ...spec, assumptions: [...spec.assumptions, note] };
  if (spec.verdict === "park") return withNote;
  return {
    ...withNote,
    verdict: "park",
    parkReason: "underspecified",
    parkReasonSource: "default",
  };
}

/**
 * The open-point gate's verdict cap: a park is final and passes through unchanged;
 * anything else becomes proceed-with-assumptions with `assumptions` appended.
 * `assumptions` are appended even to a park, so the note still reaches the PR body.
 */
function capToAssumptions(spec: NormalisedSpec, assumptions: SpecAssumption[]): NormalisedSpec {
  const withNotes = { ...spec, assumptions: [...spec.assumptions, ...assumptions] };
  if (spec.verdict === "park") return withNotes;
  return { ...withNotes, verdict: "proceed-with-assumptions" };
}

/**
 * Apply the filed issue's CRITICAL open points to the spec (#1151).
 *
 * - Resolved bullets (`[RESOLVED]` after the tag) are traced and recorded as
 *   assumptions, so the answer reaches the PR body. They never gate.
 * - No unresolved or unparsed CRITICAL lines: the spec is otherwise unchanged.
 * - A security-class point, parsed or unparsed (authentication/authorization, credentials and keys,
 *   secrets, input validation/injection, sandboxing, data deletion): park as
 *   `security-open-point` — the driver will not choose that policy. The #397
 *   complete-spec override lifts only `underspecified`, so this park stands.
 *   The class itself is the term list in security-class.ts; the parenthetical is a summary.
 *   An existing park is kept and the security points join its `securityOpenPoints`. Either
 *   way each one is recorded there (quoted and clipped), so the handoff names it.
 * - Any other unresolved point, or a CRITICAL line that did not parse: a
 *   `proceed` is capped at `proceed-with-assumptions`, each named as an
 *   assumption. An existing park is never rewritten here.
 */
function applyOpenPointGate(
  spec: NormalisedSpec,
  reading: OpenPointReading,
  shadow: DecisionWhere | undefined,
): NormalisedSpec {
  for (const point of reading.resolved) {
    trace(
      `work-driver: intent — resolved open point skipped: ${flattenAndClip(openPointText(point), OPEN_POINT_ASSUMPTION_MAX)}`,
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

  const texts = [...points.map(openPointText), ...unparsed];
  const securityMatches = texts.flatMap((text) => {
    const term = securityTermOf(text);
    return term ? [{ text, term }] : [];
  });
  if (shadow) {
    // A long Open points list must not become a burst of model calls.
    for (const text of texts.slice(0, MAX_SHADOW_POINTS)) {
      askSecuritySeam(
        text,
        securityMatches.some((m) => m.text === text),
        shadow,
      );
    }
    if (texts.length > MAX_SHADOW_POINTS) {
      trace(
        `security-open-point: ${texts.length - MAX_SHADOW_POINTS} point(s) not asked in shadow`,
      );
    }
  }
  const securityPoints = securityMatches.map(({ text }) => quotedIssueText(text));
  if (base.verdict === "park") {
    trace(
      `work-driver: intent — open-point gate skipped: spec already parked (${points.length} CRITICAL point(s), ${securityMatches.length} security-class)`,
    );
    return {
      ...base,
      securityOpenPoints: [...(base.securityOpenPoints ?? []), ...securityPoints],
    };
  }
  const [first] = securityMatches;
  if (first !== undefined) {
    trace(
      `work-driver: intent — unresolved CRITICAL open point concerns ${first.term.label}, parking`,
    );
    return {
      ...base,
      verdict: "park",
      parkReason: "security-open-point",
      parkReasonSource: "default",
      securityOpenPoints: [...(base.securityOpenPoints ?? []), ...securityPoints],
    };
  }
  trace(
    `work-driver: intent — ${points.length} unresolved CRITICAL open point(s), ${unparsed.length} unparsed line(s) carried as assumptions`,
  );
  return capToAssumptions(base, [
    ...points.map((point) => ({
      text: `unresolved CRITICAL open point in the filed issue: ${quotedIssueText(openPointText(point))}`,
      basis: "named by the intent gate; proceeding on it as an assumption",
    })),
    ...unparsed.map((line) => ({
      text: `Open-point gate could not parse a CRITICAL line: ${quotedIssueText(line)}`,
      basis:
        "open-point-unparsed — the gate could not read this line; proceeding on it as an assumption",
    })),
  ]);
}
