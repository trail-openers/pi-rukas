/**
 * lib/verify-select-agreement — the directory form of the selector, timed once per row.
 *
 * `test-verify-select-real-tree-agreement.ts` asserts that a selection through a prepared
 * context returns byte-identical answers to the directory form over a list of changed
 * sets. The comparison has two sides and they are not equally expensive: the context
 * side answers from one tree read, the directory side re-reads and re-lexes ~1,900 files
 * per row. So the two sides are measured separately and the reading is kept here, beside
 * the row shape, so the suite that judges the answers and the code that pays for them are
 * one file.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */
import path from "node:path";
import {
  type VerifySelection,
  selectVerifyTests,
} from "../../src/work-driver-verify-select.ts";
/** The extension directory these rows select on — the real checkout, one level up. */
export const extensionDir = path.resolve(import.meta.dirname, "..", "..");

/** The classes the selector answers differently: literal namers, a TS helper, a src
 * module, configuration, a path the table cannot place, and the empty set. */
export const AGREEMENT_ROWS: readonly (readonly string[])[] = [
  ["docs/troubleshooting.md"],
  ["smoke-tests/lib/adversarial-reviewer-harness.ts"],
  ["src/lean/config.ts"],
  ["agents.json"],
  ["weird/unplaceable.bin"],
  [],
];

/** The classified half of the table, split across two files by row range so each file
 * pays only its own directory reads. The table is positional, so the ranges are named by
 * index over `AGREEMENT_ROWS` — the single literal — and the two halves together are the
 * whole classified set. `AGREEMENT_ROWS.slice()` is not re-exported: a caller that wants
 * rows takes one of these two, so no file gets to invent its own slice. */
export const CLASSIFIED_ROWS_A: readonly (readonly string[])[] = AGREEMENT_ROWS.slice(0, 2);
export const CLASSIFIED_ROWS_B: readonly (readonly string[])[] = AGREEMENT_ROWS.slice(2, 4);

/** The comparable half of a verdict: what a caller would act on, and nothing else. */
export const shape = (r: VerifySelection): string =>
  JSON.stringify({
    mode: r.mode,
    tests: r.tests,
    alwaysRun: r.alwaysRun,
    fallbackReason: r.fallbackReason ?? null,
  });

/** The directory form's answer for each row, in order — the expensive side, read once. */
export const directoryShapes = (
  rows: readonly (readonly string[])[] = AGREEMENT_ROWS,
): string[] => rows.map((changed) => shape(selectVerifyTests(extensionDir, changed)));
