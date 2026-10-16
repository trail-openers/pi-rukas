#!/usr/bin/env bun
/**
 * #875 — dirty-flag rendering for verifyConsolidation's handoff text.
 * Split from test-work-driver-verify-consolidation-875.ts (AGENTS.md §12
 * file-size limit). Pure: no git fixtures, no verifyConsolidation call.
 *
 * Covers:
 *   F5.15: dirty-flag rendering — explainCap reads ONLY the persisted
 *          per-verdict `dirty` flag (no git calls at render time)
 */

import { tmpdir } from "node:os";
import path from "node:path";
import { explainCap } from "../src/work-driver-explain.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// F5.15 — dirty-flag rendering: explainCap reads ONLY the persisted
// per-verdict `dirty` flag. dirty=false → no "uncommitted on disk"
// claim (cherry-pick recovery offered). dirty=true → the claim is
// present. Legacy verdicts (no flag) keep the old wording.
{
  const mkState = (verdicts: unknown) => {
    let s = initialState(875, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        worktrees: { b: path.join(tmpdir(), "f5-fake-b-unreadable") },
        incompleteConsolidation: { verdicts, filesPresent: [] },
      },
    };
    return s;
  };
  const cap = "commit-pr-incomplete-consolidation" as const;
  const uncovered = (dirty?: boolean) => [
    {
      id: "b",
      status: "uncovered",
      uncoveredPaths: ["src/keep-green.ts"],
      ...(dirty !== undefined ? { dirty } : {}),
    },
  ];
  const dirtyFalse = explainCap(cap, mkState(uncovered(false)));
  assert(!dirtyFalse.includes("uncommitted on disk"), "F5.15: dirty=false → no claim present");
  assert(dirtyFalse.includes("cherry-pick"), "F5.15: dirty=false → cherry-pick recovery offered");
  const dirtyTrue = explainCap(cap, mkState(uncovered(true)));
  assert(dirtyTrue.includes("uncommitted on disk"), "F5.15: dirty=true → the claim is present");
  const legacy = explainCap(cap, mkState(uncovered()));
  assert(
    legacy.includes("uncommitted on disk"),
    "F5.15: legacy verdict (no dirty flag) keeps the old wording",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
