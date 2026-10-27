/**
 * #1852 — the COMPILE-TIME half of the promise in
 * `workflow-state-schema-lens-fix-fence.ts`: `LensFixFenceSnapshot["fence"]` and
 * `FixPassFence` are the same shape, spelled twice.
 *
 * The schema fragment cannot import `FixPassFence` — `work-driver-fix-pass-admission.ts`
 * pulls in value imports, and a schema module that imported it would put a value
 * import back into the workflow-state cycle the #1362 split exists to keep out. So
 * the fence is spelled field-for-field in the schema, and the only thing standing
 * between a field added on one side and not the other and a silently widened fence
 * is this file.
 *
 * Two total conversions, one per direction, with the SET-vs-ARRAY difference
 * carried explicitly (`helperDirs` is a `ReadonlySet` on the live fence and a JSON
 * array on the persisted record — the record has to survive a JSON round trip).
 * They are not behaviour: they are type relations, and the direction that
 * catches real drift is persisted → live. `lensFixPlanFromSnapshot` builds the
 * fence the gate judges with as `{ ...snap.fence, helperDirs: new Set(...) }` — a
 * spread, so TypeScript checks it against `FixPassFence` and refuses an unknown
 * extra field — but a field `FixPassFence` GAINS while the record does not is
 * exactly what a spread hides, and that is the drift this file exists to catch:
 * `fenceFromSnapshot` names every persisted field and assigns the result to
 * `LiveFence`, so a live-only field is a missing-property error here. In the
 * other direction `fenceToSnapshot`'s return type is spelled out field for
 * field, so a field the record gained and the live fence lacks is an
 * excess-property error. Either way `tsc -p tsconfig.smoke-tests.json` fails
 * rather than the drift surviving to a gate that judges a fence it never read.
 *
 * Not a test itself (no `test-` prefix, so the suite glob does not run it); the
 * assertions that USE it live in `test-lens-fix-fence-shape.ts`.
 */

import type { FixPassFence } from "../../src/work-driver-fix-pass-admission.ts";
import type { LensFixFenceSnapshot } from "../../src/workflow-state-schema.ts";

/** The persisted spelling of the fence — the snapshot's own `fence` field. */
export type PersistedFence = LensFixFenceSnapshot["fence"];

/** The live fence, as `fixPassFence` builds it and `gateFenceView` widens it. */
export type LiveFence = FixPassFence;

/**
 * Live → persisted. `Set` becomes an array; nothing else may differ, and the
 * return type is written out rather than inferred so an extra live field is an
 * excess-property error instead of something the record quietly drops.
 */
export function fenceToSnapshot(fence: LiveFence): {
  id: string;
  admits: string[];
  declared: string[];
  helperDirs: string[];
  passChanged: string[];
  outOfScope: string[];
  ceiling: number;
  ceilingBasis: string;
  admittingSlots: number;
} {
  return {
    id: fence.id,
    admits: [...fence.admits],
    declared: [...fence.declared],
    helperDirs: [...fence.helperDirs],
    passChanged: [...fence.passChanged],
    outOfScope: [...fence.outOfScope],
    ceiling: fence.ceiling,
    ceilingBasis: fence.ceilingBasis,
    admittingSlots: fence.admittingSlots,
  };
}

/**
 * Persisted → live. This direction is the one `lensFixPlanFromSnapshot` relies
 * on (`new Set(snap.fence.helperDirs)`), and the argument type is the snapshot's
 * own — so a field the record does not carry is an error here, not an
 * `undefined` reaching the admission ladder.
 */
export function fenceFromSnapshot(fence: PersistedFence): LiveFence {
  // Destructure rather than spread: a spread would silently carry a live-only
  // field across and the return-type check would never see it missing. Naming
  // every persisted field is what makes `fence: LiveFence` fail when the two
  // shapes diverge.
  const {
    id,
    admits,
    declared,
    helperDirs,
    passChanged,
    outOfScope,
    ceiling,
    ceilingBasis,
    admittingSlots,
  } = fence;
  return {
    id,
    admits: [...admits],
    declared: [...declared],
    // The record's array is what `lensFixPlanFromSnapshot` turns back into a
    // Set; the two spellings differ ONLY here.
    helperDirs: new Set(helperDirs),
    passChanged: [...passChanged],
    outOfScope: [...outOfScope],
    ceiling,
    ceilingBasis,
    admittingSlots,
  };
}
