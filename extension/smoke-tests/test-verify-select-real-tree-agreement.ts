#!/usr/bin/env bun
/**
 * #2649 (half 3) — the two forms of the selector answer the same question.
 *
 * `prepareVerifySelection` reads a tree once so a caller that asks many questions of it
 * pays for one read; the develop gate keeps the directory form, `selectVerifyTests`, which
 * reads per call. Two entries, one contract: the answers must be identical, row for row,
 * over the classes the selector answers differently — otherwise the fast form is a second
 * selector wearing the first one's name.
 *
 * A prepared context is also a SNAPSHOT of the switch verdict it was built under, so the
 * second half of this file pins that too: a context built while
 * `PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS=0` must keep answering with the OFF rules after
 * the environment has moved back to ON. The comparison — not the tree — is what differs,
 * which is why the same path is selected under both values in one block.
 *
 * Split out of the real-tree suite by #2649 for cost, not subject: each directory-form
 * selection re-reads and re-lexes ~1,900 files, and the six rows here are six such reads
 * (~9.5 s on their own) on top of the context suite's own read. The per-file ceiling
 * (#2449) is what a suite of that size eventually trips on CI.
 */
import {
  prepareVerifySelection,
  selectVerifyTests,
  selectVerifyTestsFromContext,
} from "../src/work-driver-verify-select.ts";
import {
  AGREEMENT_ROWS,
  directoryShapes,
  extensionDir,
  shape,
} from "./lib/verify-select-agreement.ts";
import { assert, exit } from "./lib/assert-rig.ts";

// --- a prepared context answers exactly what the directory form answers ----------
// The context is the selector's own read of this tree, so the assertion is between the
// two forms of the same question over the classes the selector answers differently.
{
  const ctx = prepareVerifySelection(extensionDir);
  const differ: string[] = [];
  const dir = directoryShapes();
  AGREEMENT_ROWS.forEach((changed, i) => {
    const b = shape(selectVerifyTestsFromContext(ctx, changed));
    if (dir[i] !== b) differ.push(changed[0] ?? "(empty)");
  });
  assert(
    differ.length === 0,
    `a selection through the prepared context returns the same answer as the directory form for every class of path (${AGREEMENT_ROWS.length} rows)${differ.length ? ` — differs on ${differ.join(", ")}` : ""}`,
  );

  const prior = process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
  process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = "0";
  const offCtx = prepareVerifySelection(extensionDir);
  // Back to the ON value while the off context is still held: the point of the row is
  // that the context answers by the verdict it recorded, not the one the environment
  // carries now.
  process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = undefined;
  try {
    const r = selectVerifyTestsFromContext(offCtx, ["docs/troubleshooting.md"]);
    assert(
      r.mode === "full" && r.fallbackReason === "outside-graph:docs/troubleshooting.md",
      `a context built under the OFF switch keeps answering with the OFF rules after the environment changed (got ${r.mode}/${r.fallbackReason ?? "-"})`,
    );
    const on = selectVerifyTests(extensionDir, ["docs/troubleshooting.md"]);
    assert(
      on.mode === "selected",
      `and the same path selects on a context built under the ON value (got ${on.mode}/${on.fallbackReason ?? "-"}) — the difference is the recorded verdict, not the tree`,
    );
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
    else process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = prior;
  }
}

console.log(exit === 0 ? "\nAll select-form agreement checks passed." : "\nFAILED");
process.exit(exit);
