#!/usr/bin/env bun
/**
 * #2649 (half 4) — the escape hatch answers with the pre-#2649 rules, on the real tree.
 *
 * `PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS=0` puts every classification rule back to the
 * bytes that shipped before #2649. On the real tree that means a docs file, an
 * ignore-like file, a workflow file and a `smoke-tests/lib/` shell helper all fall back to
 * the FULL suite, each under its own reason — the answers the ON arm replaced with sound
 * subsets. `test-verify-select-changed-paths-off-arm.ts` asserts the switch over fixtures;
 * this pins the four rows whose reason names a path in THIS repository, so the escape hatch
 * is an assertion about the tree the develop gate actually runs against rather than about a
 * directory someone typed out.
 *
 * The row owns its own tree read: a context records the switch verdict it was built under,
 * and `listNodes` consults that switch for whether `smoke-tests/lib/` is in the node set
 * at all — so an OFF context is genuinely a different read of the tree, not the same read
 * judged differently, and it cannot share the ON suite's prepared context. That read is
 * also why this file stands alone: the OFF-arm context build costs what an ON-arm one
 * costs, and folding it back into the real-tree suite puts a second whole-tree read on
 * that file's clock (the per-file ceiling, #2449).
 */
import path from "node:path";
import {
  selectVerifyTestsFromContext,
  prepareVerifySelection,
} from "../src/work-driver-verify-select.ts";
import { assert, exit } from "./lib/assert-rig.ts";

const extensionDir = path.resolve(import.meta.dirname, "..");

{
  const OFF: readonly [readonly string[], string][] = [
    [["docs/troubleshooting.md"], "outside-graph:docs/troubleshooting.md"],
    [["agents.json"], "outside-graph:agents.json"],
    [[".github/workflows/ci.yml"], "outside-graph:.github/workflows/ci.yml"],
    [["smoke-tests/lib/verify-loop.sh"], "smoke-test-helper:smoke-tests/lib/verify-loop.sh"],
  ];
  const prior = process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
  process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = "0";
  try {
    // The off arm's own read: a context records the switch verdict it was built under,
    // so this one is built inside the pin and answers with the pre-#2649 rules.
    const offCtx = prepareVerifySelection(extensionDir);
    for (const [changed, reason] of OFF) {
      const r = selectVerifyTestsFromContext(offCtx, changed);
      assert(
        r.mode === "full" && r.fallbackReason === reason,
        `with the switch at 0 ${changed[0]} still falls back to the full suite with ${reason} (got ${r.mode}/${r.fallbackReason ?? "-"})`,
      );
    }
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
    else process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = prior;
  }
}

console.log(exit === 0 ? "\nAll real-tree off-arm checks passed." : "\nFAILED");
process.exit(exit);
