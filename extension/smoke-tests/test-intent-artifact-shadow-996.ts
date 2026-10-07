#!/usr/bin/env bun
/**
 * #996 — the artifact-shadow invariant (synthetic shadow only).
 *
 * The driver persists the RESOLVED spec to .pi/work-state/<issue>/spec.txt
 * AFTER reconciliation (persistSpecArtifact in runExplore). A shadow written
 * from a parser-default park therefore carries the provenance
 * {verdict: "park", verdictSource: "default", parkReasonSource: "default"} —
 * the same shape the parser synthesises when the resolver omits its verdict
 * token. That shape is not a decision the resolver made, and it must not
 * license the proceed path.
 *
 * The shadow is constructed as a SYNTHETIC in-memory object, never sourced
 * from the on-disk .pi/work-state/984/spec.txt (which holds
 * verdict: "proceed-with-assumptions" with no provenance fields — a
 * different shape, and it must not be quoted as evidence of a park).
 *
 * This test pins the boundary between the #397 rescue (complete spec body +
 * default provenance → proceed-with-assumptions) and the #378 rule
 * (incomplete spec body → still park, no rescue). The rescue is justified
 * by the spec body, not by the shadow's provenance alone.
 */

import { resolveIntentVerdict } from "../src/work-driver-intent-artifact.ts";
import {
  type NormalisedSpec,
  reconcileVerdict,
} from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// The synthetic shadow: what persistSpecArtifact would write if the winner
// of resolveIntentVerdict had been the parser's default park.
// ---------------------------------------------------------------------------
const syntheticDefaultParkShadow: NormalisedSpec = {
  intent: "Do the thing",
  deliverables: [{ id: "d1", description: "Do the thing", paths: ["src/a.ts"] }],
  acceptanceCriteria: ["it works"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [{ claim: "it is true", source: "src/a.ts:1", verdict: "confirmed" }],
  verdict: "park",
  parkReason: "underspecified",
  verdictSource: "default",
  parkReasonSource: "default",
  rationale: "the resolver omitted its verdict token",
};

// Sanity: the synthetic object IS the parser-default-park shape.
assert(
  syntheticDefaultParkShadow.verdict === "park" &&
    syntheticDefaultParkShadow.verdictSource === "default" &&
    syntheticDefaultParkShadow.parkReasonSource === "default",
  "#996 shadow: the synthetic object is the parser-default-park shape (park + default provenance)",
);

// ---------------------------------------------------------------------------
// Case A: default-park shadow with INCOMPLETE spec → still parks (#378).
//
// The shadow has the default provenance but its spec body is incomplete
// (no deliverables, no confirmed evidence), so specIsComplete is false and
// reconcileVerdict cannot override the park. The #378 rule: a reply with
// no verdict and an incomplete spec still parks.
// ---------------------------------------------------------------------------
{
  const incompleteShadow: NormalisedSpec = {
    ...syntheticDefaultParkShadow,
    deliverables: [],
    evidence: [],
  };
  const reconciled = reconcileVerdict(incompleteShadow);
  assert(
    reconciled.verdict === "park",
    "#996 shadow A: default-park shadow with INCOMPLETE spec → still park (#378: no rescue)",
  );
  assert(
    reconciled.parkReason === "underspecified",
    "#996 shadow A: parkReason preserved as underspecified",
  );
}

// ---------------------------------------------------------------------------
// Case B: default-park shadow with COMPLETE spec → the #397 override applies.
//
// This is the rescue path: the resolver wrote a complete spec but omitted
// its verdict token, the parser synthesised a default park, and the driver
// persisted that default park as the shadow. reconcileVerdict sees a
// complete spec with default provenance and promotes to
// proceed-with-assumptions. This is CORRECT — the rescue is justified by
// the spec body, not by the shadow's provenance alone.
// ---------------------------------------------------------------------------
{
  const reconciled = reconcileVerdict(syntheticDefaultParkShadow);
  assert(
    reconciled.verdict === "proceed-with-assumptions",
    "#996 shadow B: default-park shadow with COMPLETE spec → #397 override to proceed-with-assumptions",
  );
  assert(
    reconciled.assumptions.some((a) => /underspecified/.test(a.text)),
    "#996 shadow B: the override assumption is present (the driver inferred, the resolver didn't say)",
  );
}

// ---------------------------------------------------------------------------
// Case C: explicit prose park (verdictSource === "parsed") + INCOMPLETE
// spec → the prose park wins and stays parked (#378: no rescue).
//
// The resolver explicitly wrote INTENT-VERDICT: park / PARK-REASON:
// underspecified. resolveIntentVerdict gives the prose (explicit park,
// verdictSource === "parsed") over the shadow (default park). The spec body
// is INCOMPLETE (no deliverables, no confirmed evidence), so specIsComplete
// is false and the #397 override cannot fire: reconcileVerdict keeps the
// explicit park parked. (With a complete body, the stated `underspecified`
// IS deliberately overridable — that is the second row of the #404 table —
// which is exactly what case B pins for default provenance. Pinning a
// complete-body explicit park as "never overridden" here would contradict
// reconcileVerdict's documented #397 rescue.)
// ---------------------------------------------------------------------------
{
  const explicitProsePark: NormalisedSpec = {
    ...syntheticDefaultParkShadow,
    deliverables: [],
    evidence: [],
    verdictSource: "parsed",
    parkReasonSource: "parsed",
  };
  const { spec: winner, source } = resolveIntentVerdict(
    explicitProsePark,
    syntheticDefaultParkShadow,
  );
  assert(
    winner === explicitProsePark && source === "prose",
    "#996 shadow C: explicit prose park (parsed provenance) wins over the default-park shadow",
  );
  const reconciled = reconcileVerdict(winner);
  assert(
    reconciled.verdict === "park",
    "#996 shadow C: the explicit prose park with an INCOMPLETE spec is NOT overridden (no #397 rescue without a complete body)",
  );
}

// ---------------------------------------------------------------------------
// Case D: no prose (undefined) + default-park shadow → the shadow is the
// winner (it's the only signal). reconcileVerdict either rescues it (if
// the spec body is complete) or leaves it (if incomplete). Either way,
// the shadow does NOT introduce a NEW proceed verdict — it can only carry
// the park the parser synthesised, or a rescue justified by the spec body.
// ---------------------------------------------------------------------------
{
  const { spec: winner } = resolveIntentVerdict(undefined, syntheticDefaultParkShadow);
  assert(
    winner === syntheticDefaultParkShadow,
    "#996 shadow D: no prose + default-park shadow → the shadow is the winner (it's the only signal)",
  );
  const reconciled = reconcileVerdict(winner);
  assert(
    reconciled.verdict === "proceed-with-assumptions" || reconciled.verdict === "park",
    `#996 shadow D: the reconciled verdict is either a justified rescue or a park, never a bare proceed (got ${reconciled.verdict})`,
  );
}

// ---------------------------------------------------------------------------
// Case E: the #996 acceptance criterion, stated directly.
//
// A default-park prose spec plus a spec.txt artifact whose verdictSource is
// "default" does NOT license the proceed path via the artifact channel —
// unless the artifact's spec body is complete (the #397 rescue), in which
// case the rescue is justified by the spec body, not by the shadow's
// provenance.
// ---------------------------------------------------------------------------
{
  const defaultParkProse: NormalisedSpec = { ...syntheticDefaultParkShadow };
  const { spec: winner } = resolveIntentVerdict(defaultParkProse, syntheticDefaultParkShadow);
  assert(
    winner === syntheticDefaultParkShadow,
    "#996 shadow E: default-park prose + default-park artifact → the artifact wins (neither is a decision)",
  );
  const reconciled = reconcileVerdict(winner);
  assert(
    reconciled.verdict === "proceed-with-assumptions",
    "#996 shadow E: the complete spec body justifies the #397 rescue (the shadow's provenance alone is not the license)",
  );
}

// ---------------------------------------------------------------------------
// Case F: anti-vacuity for the synthetic shadow.
//
// The shadow object must NOT be sourced from the on-disk spec.txt. We
// verify this by checking that the synthetic object has the EXACT shape
// the parser synthesises (park + default + default + parkReason:
// underspecified), which is distinct from the on-disk shape
// (proceed-with-assumptions, no provenance fields). If someone replaced
// the synthetic object with a read from the on-disk file, the provenance
// fields would be absent and this assert would fail.
// ---------------------------------------------------------------------------
assert(
  syntheticDefaultParkShadow.verdictSource === "default" &&
    syntheticDefaultParkShadow.parkReasonSource === "default" &&
    syntheticDefaultParkShadow.parkReason === "underspecified",
  "#996 shadow F: the synthetic shadow carries default provenance + underspecified (the parser's shape, NOT the on-disk spec.txt shape)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
