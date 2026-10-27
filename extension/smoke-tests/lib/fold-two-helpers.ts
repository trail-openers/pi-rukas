/**
 * foldTwo is the ONE fold helper (#1005) and four passes call it (#1862 names
 * them: the MAX_WORKSTREAMS ceiling fold, the plan-time coupling merge, the
 * develop fence merge-and-retry, and the port/contract fold). Since #1862 it
 * returns `{ workstream, selfFenceDrops }` rather than a bare `Workstream`, so
 * every fold can report the fences it removed. Tests that judge the MERGED
 * SHAPE — the union, the clip records, the fence bound — read the half they
 * care about through one of these two, so the shape change is a one-line edit
 * per call site instead of a re-write of the assertion.
 */

import type { UnfenceRecord } from "../../src/work-driver-plan-unfence-notes.ts";
import { foldTwo } from "../../src/workstream-fold.ts";
import type { Workstream } from "../../src/workflow-state-schema.ts";

/** The raw result, for a test that wants both halves of it. */
export function foldTwoForTests(
  a: Workstream,
  b: Workstream,
): { workstream: Workstream; selfFenceDrops: UnfenceRecord[] } {
  return foldTwo(a, b);
}

/** The merged workstream alone. */
export function foldMerged(a: Workstream, b: Workstream): Workstream {
  return foldTwoForTests(a, b).workstream;
}

/** The self-fence removals the fold recorded, as the notes the operator reads. */
export function foldSelfFenceNotes(a: Workstream, b: Workstream): string[] {
  return foldTwoForTests(a, b).selfFenceDrops.map((r) => r.note);
}
