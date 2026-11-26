#!/usr/bin/env bun
/**
 * #2649 (half 3c) — a prepared context is a snapshot of the switch verdict it was built under.
 *
 * `prepareVerifySelection` reads `PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS` once, at build
 * time, and every selection through it is judged by that verdict — the directory form
 * `selectVerifyTests` re-reads the environment per call, so it has no equivalent of this
 * property. The two rows below are what makes the difference observable rather than
 * assumed: the SAME path in the SAME tree answers `full` under a context built while the
 * switch was 0 — after the environment moved back to the shipped value — and `selected`
 * under one built while it was on. If the context re-read the environment, the first row
 * would answer `selected` and the pair would not exist.
 *
 * The rows need two tree reads between them (an OFF context, and the directory form read
 * under the shipped value), which is why they are a file of their own: the per-file timing
 * ceiling (#2449) prices each read at roughly a second and a half, and the suites they were
 * split out of carry their own reads.
 */
import {
  prepareVerifySelection,
  selectVerifyTests,
  selectVerifyTestsFromContext,
} from "../src/work-driver-verify-select.ts";
import { extensionDir } from "./lib/verify-select-agreement.ts";
import { assert, exit } from "./lib/assert-rig.ts";

{
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
