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
  type VerifySelection,
} from "../src/work-driver-verify-select.ts";
import type { VerifySelectionContext } from "../src/work-driver-verify-select-context.ts";
import { extensionDir } from "./lib/verify-select-agreement.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./lib/assert-rig.ts";

{
  // An OFF context built while the switch is pinned to 0, then read while the pin is
  // still held: the point of the row is that the context answers by the verdict it
  // recorded, not the one the environment carries now.
  let offCtx: VerifySelectionContext | undefined;
  let off: VerifySelection | undefined;
  await withEnv({ PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS: "0" }, async () => {
    offCtx = prepareVerifySelection(extensionDir);
    off = selectVerifyTestsFromContext(offCtx, ["docs/troubleshooting.md"]);
  });
  assert(
    off !== undefined &&
      off.mode === "full" &&
      off.fallbackReason === "outside-graph:docs/troubleshooting.md",
    `a context built under the OFF switch keeps answering with the OFF rules after the environment changed (got ${off?.mode}/${off?.fallbackReason ?? "-"})`,
  );
  // The directory form under the shipped value — the variable is absent here, which is
  // the ON arm (`withEnv` deletes an `undefined` override rather than assigning it).
  let on: VerifySelection | undefined;
  await withEnv({ PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS: undefined }, async () => {
    on = selectVerifyTests(extensionDir, ["docs/troubleshooting.md"]);
  });
  assert(
    on !== undefined && on.mode === "selected",
    `and the same path selects on a context built under the ON value (got ${on?.mode}/${on?.fallbackReason ?? "-"}) — the difference is the recorded verdict, not the tree`,
  );
}

console.log(exit === 0 ? "\nAll select-form agreement checks passed." : "\nFAILED");
process.exit(exit);
