#!/usr/bin/env bun
/**
 * #2649 (half 3b) — the two forms agree for what the classifier cannot place.
 *
 * Companion to `test-verify-select-real-tree-agreement.ts`, which compares the rows the
 * classification table places. These are the two rows whose answer comes from BEFORE that
 * table engages: a path the table cannot place, and the empty change set. Each still
 * compares one directory read against one context read — the comparison is between the two
 * FORMS of the same question, never between two answers from one form.
 *
 * Split from its companion, and from the snapshot file beside it, for cost: each
 * directory-form selection re-reads and re-lexes ~1,900 files, and the per-file timing
 * ceiling (#2449) is what a suite carrying several of them trips on CI. The snapshot rows
 * — the same path under a context built on each side of the switch — are in
 * `test-verify-select-real-tree-context-snapshot.ts`.
 */
import { prepareVerifySelection, selectVerifyTestsFromContext } from "../src/work-driver-verify-select.ts";
import {
  AGREEMENT_ROWS,
  directoryShapes,
  extensionDir,
  shape,
} from "./lib/verify-select-agreement.ts";
import { assert, exit } from "./lib/assert-rig.ts";

/** The rows whose answer comes from before the classification table engages. The table is
 * positional, so these are named by index; `AGREEMENT_ROWS` is a fixed literal. */
const UNCLASSIFIED: readonly (readonly string[])[] = [
  AGREEMENT_ROWS[4] ?? [],
  AGREEMENT_ROWS[5] ?? [],
];

{
  const ctx = prepareVerifySelection(extensionDir);
  const dir = directoryShapes(UNCLASSIFIED);
  const differ: string[] = [];
  UNCLASSIFIED.forEach((changed, i) => {
    if (dir[i] !== shape(selectVerifyTestsFromContext(ctx, changed)))
      differ.push(changed[0] ?? "(empty)");
  });
  assert(
    differ.length === 0,
    `a selection through the prepared context returns the same answer as the directory form for every class of path (${UNCLASSIFIED.length} rows)${differ.length ? ` — differs on ${differ.join(", ")}` : ""}`,
  );
}

console.log(exit === 0 ? "\nAll select-form agreement checks passed." : "\nFAILED");
process.exit(exit);
