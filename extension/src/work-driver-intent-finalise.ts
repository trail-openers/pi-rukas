/**
 * work-driver-intent-finalise — the spec's final verdict at the explore step (#1151, #1187).
 *
 * Kept apart from work-driver-intent-criticality.ts and open-points-reader.ts:
 * work-driver-intent.ts imports the criticality module, so calling reconcileVerdict from
 * there made a runtime import cycle. This module imports both sides; nothing imports it back.
 *
 * The order is the contract: reconcile the resolver's verdict first, then apply
 * the filed issue's open points. Reconciliation can lift an `underspecified`
 * park, and the open-point gate must still park after that. The gate is topic-neutral:
 * every unresolved CRITICAL point parks, so there is no classification to get wrong.
 * The open-point gate is reached only through `finaliseSpecVerdict`.
 */

import { redactClip } from "./decision-log.ts";
import {
  OPEN_POINT_CHAR_CAP,
  type OpenPointReading,
  blockingOpenPointTexts,
  readOpenPoints,
  resolvedOpenPointTexts,
} from "./open-points-reader.ts";
import { flattenIssueText, redactThenBound } from "./text-flatten.ts";
import { trace } from "./trace.ts";
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
    // Distinguishes "nobody wrote an issue" from "the fetch returned nothing": a raw body
    // with characters in it that flattenIssueText reduced to nothing is invisible/control
    // text. The RAW LENGTH is the diagnostic — a boolean would say "non-empty" for a body
    // of one zero-width character and for a megabyte of them, which is the case this trace
    // exists to tell apart (#1187 fix round 2).
    trace(
      `open-point-gate-unchecked: the filed issue body was blank (raw body ${
        primaryBody === undefined
          ? "unread (undefined)"
          : `raw length ${primaryBody.length}, flattened empty`
      }); its open points were not checked`,
    );
    // Recorded even when the spec is already parked: an unchecked body is a fact the PR body must carry.
    // Applied after reconcileVerdict, so no reconciliation can lift this park.
    return boundAssumptions(
      parkUnchecked(reconciled, {
        text: "Open-point gate did not run: issue body blank",
        basis: "blank-issue-body — the driver could not check the issue for CRITICAL open points",
      }),
    );
  }
  return boundAssumptions(applyOpenPointGate(reconciled, readOpenPoints(primaryBody)));
}

/**
 * Redact and bound every assumption the FINAL spec carries (#1187 fix round 4).
 *
 * `applyOpenPointGate` bounds the open-point texts it writes itself, and the artifact
 * reader bounds what it restores — but neither covers the assumptions the RESOLVER authored
 * and the parser put straight into `spec.assumptions`. Those are rendered verbatim into the
 * PR body by `renderAssumptions`, so an `sk-ant-api03-…` token quoted in a resolver's own
 * assumption used to reach a public surface untouched. One pass at the last moment the spec
 * is assembled, through the same `redactThenBound` the writer uses, so every assumption
 * reaching the PR body has been through the one normaliser whatever wrote it.
 */
function boundAssumptions(spec: NormalisedSpec): NormalisedSpec {
  if (spec.assumptions.length === 0) return spec;
  return {
    ...spec,
    assumptions: spec.assumptions.map((a) => ({
      text: redactThenBound(a.text, OPEN_POINT_CHAR_CAP).text,
      basis: redactThenBound(a.basis, OPEN_POINT_CHAR_CAP).text,
    })),
  };
}

/**
 * A resolved point is recorded as an assumption, so the answer reaches the PR body.
 *
 * The text is prefixed (`resolved open point: `) because `renderAssumptions` renders every
 * assumption as a bolded bullet with the basis beside it: bare issue text there reads as an
 * open question the developer chose to ignore, and the prefix survives any rendering that
 * drops the basis.
 */
function resolvedAssumption(text: string): SpecAssumption {
  return {
    text: `resolved open point: ${text}`,
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
    trace(`work-driver: intent — resolved open point skipped: ${redactClip(point, 300)}`);
  }
  const base: NormalisedSpec =
    reading.resolved.length === 0
      ? spec
      : {
          ...spec,
          assumptions: [
            ...spec.assumptions,
            ...resolvedOpenPointTexts(reading).map(resolvedAssumption),
          ],
        };
  if (reading.unparsed.length > 0) {
    trace(
      `open-point-unparsed: ${reading.unparsed.length} line(s) in the Open points section did not parse`,
    );
  }
  // Bounded and redacted at the one place `openPoints` is written: these lines are copied
  // verbatim into the handoff and posted to a public PR comment (#1187 fix round 2). One
  // combined cap covers points and unparsed lines together.
  const blocking = blockingOpenPointTexts(reading);
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
