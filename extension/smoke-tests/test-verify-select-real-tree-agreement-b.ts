#!/usr/bin/env bun
/**
 * #2649 (half 3a-ii) — the prepared context answers like the directory form, rows 3 and 4.
 *
 * Companion to `test-verify-select-real-tree-agreement.ts`, which owns rows 1 and 2 of the
 * same table. THIS file owns rows 3 and 4: a `src/` module and a configuration file. Those
 * are the two classified classes the first file does not cover, and each is a different
 * code path through the selector — the contract under test is that a selection through a
 * prepared context returns byte-identical answers to the directory form, row for row.
 *
 * The rows are split across two files for cost and nothing else: each directory-form
 * selection re-reads and re-lexes ~1,900 files, so four rows in one file measured ~12 s
 * locally and ~3.4× that on CI, over the per-file timing ceiling (#2449). The rows the
 * table cannot place, and the empty set, are in
 * `test-verify-select-real-tree-agreement-unclassified.ts`.
 */
import { prepareVerifySelection, selectVerifyTestsFromContext } from "../src/work-driver-verify-select.ts";
import {
  CLASSIFIED_ROWS_B,
  directoryShapes,
  extensionDir,
  shape,
} from "./lib/verify-select-agreement.ts";
import { assert, exit } from "./lib/assert-rig.ts";

/** The rows this file judges: the last two of the classified table. */
const CLASSIFIED = CLASSIFIED_ROWS_B;

{
  const ctx = prepareVerifySelection(extensionDir);
  const dir = directoryShapes(CLASSIFIED);
  const differ: string[] = [];
  CLASSIFIED.forEach((changed, i) => {
    if (dir[i] !== shape(selectVerifyTestsFromContext(ctx, changed)))
      differ.push(changed[0] ?? "(empty)");
  });
  assert(
    differ.length === 0,
    `a selection through the prepared context returns the same answer as the directory form for every class of path (${CLASSIFIED.length} rows)${differ.length ? ` — differs on ${differ.join(", ")}` : ""}`,
  );
}

console.log(exit === 0 ? "\nAll select-form agreement checks passed." : "\nFAILED");
process.exit(exit);
