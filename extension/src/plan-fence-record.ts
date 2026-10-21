/**
 * plan-fence-record — reading the `outOfScopeClipped` record a bounded fence
 * list carries (#1744).
 *
 * Split out of plan-fence-bound.ts by the section 12 file-size cap, along the
 * seam that already existed inside it: that module WRITES the record while a
 * fence list is built; this one READS it afterwards — counting what was dropped,
 * deciding which records still mean something after the list changed, and
 * shaping the field a workstream spread should carry. The dependency runs ONE
 * way (`plan-fence-bound.ts` imports the count reader from here; nothing here
 * imports a value from the bound), so neither module drags the other's graph.
 *
 * Why the reads are the strict ones: the record round-trips through
 * `<project>/.pi/work-state/<issue>.json`, a file a person can open and edit,
 * and it is re-read by the fold, the unfence pass, and both develop prompts. A
 * count of `null`, `"3"`, `-1` or `NaN` is not a count and a reason this build
 * never wrote is not a reason — each is IGNORED rather than repeated as a
 * disclosure that reads as fact. Being wrong in the pessimistic direction is the
 * point: a disclosure the developer acts on must be one the driver actually made.
 */

import type { OutOfScopeClip } from "./workflow-state-schema-workstreams.ts";

/** The two record shapes, named once so the reads below stay readable. */
export type ClippedRecord = Extract<OutOfScopeClip, { kind: "clipped" }>;
export type DroppedRecord = Extract<OutOfScopeClip, { kind: "dropped" }>;

/**
 * The reasons a `dropped` record may carry, spelled once. A `Record` keyed by
 * the union is the exhaustiveness gate: adding a reason to
 * `OutOfScopeClip["dropped"]["reason"]` without naming it here is a type error,
 * so a read site can never quietly forget a reason (#1744 review).
 */
const KNOWN_DROP_REASONS: Record<DroppedRecord["reason"], true> = {
  cap: true,
  empty: true,
  duplicate: true,
};

/**
 * A `dropped` record's count, or undefined when the record is not one the
 * driver wrote — an unknown reason, or a count that is not a finite
 * non-negative integer (#1744 review: the state file is editable).
 */
export function dropCountOf(record: DroppedRecord): number | undefined {
  if (!(record.reason in KNOWN_DROP_REASONS)) return undefined;
  if (!Number.isInteger(record.count) || record.count < 0) return undefined;
  return record.count;
}

/** How many entries one record list says were dropped for one reason. */
export function fenceDropCount(
  clipped: readonly OutOfScopeClip[],
  reason: DroppedRecord["reason"],
): number {
  let n = 0;
  for (const r of clipped) {
    if (r.kind !== "dropped") continue;
    const count = dropCountOf(r);
    if (count !== undefined && r.reason === reason) n += count;
  }
  return n;
}

/**
 * The clip records for a fence list an entry was REMOVED from (the unfence
 * pass, #1744): a record whose entry is gone goes with it and the rest need no
 * change at all, because a record is keyed by its ENTRY TEXT. Carrying a record
 * for an entry that no longer exists would hang the ` …[clipped]` marker on
 * nothing, and re-keying by index was the defect this shape removes.
 */
export function keepClippedRecords(
  entries: readonly string[],
  clipped: readonly OutOfScopeClip[],
): OutOfScopeClip[] {
  const present = new Set(entries);
  return clipped.filter((r) =>
    r.kind === "dropped" ? dropCountOf(r) !== undefined : present.has(r.entry),
  );
}

/**
 * The `outOfScopeClipped` field as a workstream spread should carry it: absent
 * when nothing was bounded, so a plan the driver never touched keeps the
 * pre-#1744 shape. The three writers of a fence list (the tool boundary, the
 * fold, the deferred-protected append) all spread this, so none can leave a key
 * holding `undefined` behind.
 */
export function clippedField(clipped: readonly OutOfScopeClip[]): {
  outOfScopeClipped?: OutOfScopeClip[];
} {
  return clipped.length > 0 ? { outOfScopeClipped: [...clipped] } : {};
}
