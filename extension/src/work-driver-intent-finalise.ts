/**
 * work-driver-intent-finalise — the spec's final verdict at the explore step (#1151, #1187).
 *
 * Kept apart from work-driver-intent-criticality.ts: work-driver-intent.ts imports
 * the criticality module, so calling reconcileVerdict from there made a runtime
 * import cycle. This module imports both sides; nothing imports it back.
 *
 * The order is the contract: reconcile the resolver's verdict first, then apply
 * the filed issue's open points. Reconciliation can lift an `underspecified`
 * park, and the open-point gate must still park after that. The gate is topic-neutral:
 * every unresolved CRITICAL point parks, so there is no classification to get wrong.
 * The open-point gate is reached only through `finaliseSpecVerdict`.
 */

import { flattenAndClip, flattenIssueText } from "./text-flatten.ts";
import { trace } from "./trace.ts";
import { type OpenPointReading, readOpenPoints } from "./work-driver-intent-criticality.ts";
import {
  type NormalisedSpec,
  type SpecAssumption,
  reconcileVerdict,
} from "./work-driver-intent.ts";

/**
 * The spec's final verdict at the explore step.
 *
 * `primaryBody` is the primary issue body as read; `undefined` or blank (after
 * flattening, so zero-width characters alone count as blank) means the gate could
 * not run, which is recorded rather than silently skipped. An existing park keeps
 * its reason and gains the note.
 */
export function finaliseSpecVerdict(
  spec: NormalisedSpec,
  primaryBody: string | undefined,
): NormalisedSpec {
  const reconciled = reconcileVerdict(spec);
  if (primaryBody === undefined || flattenIssueText(primaryBody) === "") {
    trace(
      "open-point-gate-unchecked: the filed issue body was blank; its open points were not checked",
    );
    // Recorded even when the spec is already parked: an unchecked body is a fact the PR body must carry.
    // Applied after reconcileVerdict, so no reconciliation can lift this park.
    return parkUnchecked(reconciled, {
      text: "Open-point gate did not run: issue body blank",
      basis: "blank-issue-body — the driver could not check the issue for CRITICAL open points",
    });
  }
  return applyOpenPointGate(reconciled, readOpenPoints(primaryBody));
}

/** A resolved point is recorded as an assumption, so the answer reaches the PR body. */
function resolvedAssumption(text: string): SpecAssumption {
  return {
    text,
    basis: "the filed issue marks this CRITICAL point resolved",
  };
}

/**
 * The blank-body cap (#1187): a blank issue body parks with its own reason, so the
 * #397 override (which lifts only `underspecified`) cannot lift it. An existing park
 * keeps its reason and only gains the note.
 */
function parkUnchecked(spec: NormalisedSpec, note: SpecAssumption): NormalisedSpec {
  const withNote = { ...spec, assumptions: [...spec.assumptions, note] };
  if (spec.verdict === "park") return withNote;
  return {
    ...withNote,
    verdict: "park",
    parkReason: "blank-issue-body",
    parkReasonSource: "default",
  };
}

/**
 * Apply the filed issue's Open points section to the spec (#1151, #1187).
 *
 * - A point answered with an unemphasised `[RESOLVED]` after its tag is recorded as an
 *   assumption (its text is the flattened point), so the answer reaches the PR body.
 *   It does not gate.
 * - Every unresolved CRITICAL point, and every line the reader could not classify,
 *   parks the cycle as `unresolved-critical-open-point`, whatever its topic. The text
 *   of each goes into `openPoints` for the handoff. The #397 override lifts only
 *   `underspecified`, so this park stands.
 * - A park that already exists keeps its reason; the blocking texts are appended to
 *   `openPoints` and its provenance becomes `default`.
 */
function applyOpenPointGate(spec: NormalisedSpec, reading: OpenPointReading): NormalisedSpec {
  for (const point of reading.resolved) {
    trace(`work-driver: intent — resolved open point skipped: ${flattenAndClip(point, 300)}`);
  }
  const base: NormalisedSpec =
    reading.resolved.length === 0
      ? spec
      : {
          ...spec,
          assumptions: [...spec.assumptions, ...reading.resolved.map(resolvedAssumption)],
        };
  if (reading.unparsed.length > 0) {
    trace(
      `open-point-unparsed: ${reading.unparsed.length} line(s) in the Open points section did not parse`,
    );
  }
  const blocking = [...reading.points, ...reading.unparsed];
  if (blocking.length === 0) return base;
  if (base.verdict === "park") {
    trace(
      `work-driver: intent — open-point gate skipped: spec already parked (${blocking.length} blocking open point(s) recorded)`,
    );
    return {
      ...base,
      parkReasonSource: "default",
      openPoints: [...(base.openPoints ?? []), ...blocking],
    };
  }
  trace(
    `work-driver: intent — ${reading.points.length} unresolved CRITICAL open point(s), ${reading.unparsed.length} unparsed line(s), parking`,
  );
  return {
    ...base,
    verdict: "park",
    parkReason: "unresolved-critical-open-point",
    parkReasonSource: "default",
    openPoints: blocking,
  };
}
