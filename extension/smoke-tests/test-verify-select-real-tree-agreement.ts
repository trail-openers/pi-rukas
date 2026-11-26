#!/usr/bin/env bun
/**
 * #2649 (half 3a-i) — the prepared context answers like the directory form, rows 1 and 2.
 *
 * `prepareVerifySelection` reads a tree once so a caller that asks many questions of it
 * pays for one read; the develop gate keeps the directory form, `selectVerifyTests`, which
 * reads per call. Two entries, one contract: the answers must be identical, row for row —
 * otherwise the fast form is a second selector wearing the first one's name.
 *
 * THIS file owns rows 1 and 2 of the classified table — a docs file (whose selection is
 * built from literal namers) and a `smoke-tests/lib/` helper. Rows 3 and 4 — a `src/`
 * module and a configuration file, each a different code path through the selector — are
 * the same comparison in `test-verify-select-real-tree-agreement-b.ts`. The paths the
 * table cannot place, and the empty set — the two rows whose answer comes from before the
 * classifier runs — are compared in
 * `test-verify-select-real-tree-agreement-unclassified.ts`.
 *
 * The cost is asymmetric and is why the rows are split at all: the context side answers
 * from one read, the directory side re-reads and re-lexes ~1,900 files per row, and the
 * per-file timing ceiling (#2449) is what a suite of this shape trips on CI. Four rows sat
 * at ~12 s locally and ~3.4× that on CI, over the ceiling; two rows each keep both files
 * under it.
 */
import { prepareVerifySelection, selectVerifyTestsFromContext } from "../src/work-driver-verify-select.ts";
import {
  CLASSIFIED_ROWS_A,
  directoryShapes,
  extensionDir,
  shape,
} from "./lib/verify-select-agreement.ts";
import { assert, exit } from "./lib/assert-rig.ts";

/** The rows this file judges: the first two of the classified table. */
const CLASSIFIED = CLASSIFIED_ROWS_A;

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
