import { clipFenceEntry } from "../../src/plan-fence-bound.ts";
/**
 * Shared fixtures for the #1744 fence-bound tests. The two files split the
 * concern in two — `test-plan-outofscope-bound-1744.ts` judges the bound itself
 * (schema ceilings, clipping, splitting, the cap, the widening) and
 * `test-plan-outofscope-visible-1744.ts` judges what the bound LEAVES BEHIND
 * (the record, the fold's carry, the third writer, the prompt rendering) — and
 * both read the same few over-long entries, so the fixtures live here rather
 * than being copied where they could drift.
 */
import type { WorkstreamArgs } from "../../src/plan-workstream-schema.ts";

/** A 700-character prose fence with no comma: one entry, over the bound. */
export const LONG_PROSE = `the legacy compatibility layer for the old report format ${"which must not be touched ".repeat(24)}`;

/** A path-list entry: 30 plain paths, one entry, comma-separated. */
export const THIRTY_PATHS = Array.from({ length: 30 }, (_, i) => `src/mod${i}.ts`).join(",");

/** One prose sentence with a comma AND a character no path may hold: never split. */
export const PROSE_WITH_COMMA = "the public API of foo, not its internals' internals";

/** A prose comma list whose every half IS path-shaped: this one does split. */
export const PROSE_SPLIT = "the docs folder, the public API of foo";

/** A path-shaped entry whose retained prefix still fences `FENCED_FILE`. */
export const LONG_PATH_FENCE = `extension/src/reports/${"widget".repeat(120)} must not change`;

/** The file `LONG_PATH_FENCE` covers once the driver clips it at the `/`. */
export const FENCED_FILE = "extension/src/reports/widget-table.ts";

/** A minimal accepted call — every fixture overrides the field it exercises. */
export const VALID: WorkstreamArgs = {
  id: "task-a",
  scope: "the fix",
  paths: ["src/a.ts"],
  outOfScope: [],
};

/** `LONG_PATH_FENCE` as the driver would store it: the retained prefix alone. */
export function clippedLongPath(): string {
  return clipFenceEntry(LONG_PATH_FENCE);
}

/** N distinct fence entries, for the tests that need a list of a given size. */
export function fenceList(n: number, prefix = "src/fence"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}.ts`);
}
