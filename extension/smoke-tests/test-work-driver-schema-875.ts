#!/usr/bin/env bun
/**
 * #875 — dirty flag validation for consolidation verdicts.
 * The per-workstream `dirty` flag is OPTIONAL (pre-#875 state files lack it)
 * and must be a boolean when present.
 *
 * Extracted from test-work-driver-schema.ts (AGENTS.md §12 file-size limit).
 */

import { initialState } from "../src/workflow-state.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_VERIFY = "0";

{
  const ic = (o: Record<string, unknown>) =>
    validateDiscriminants({
      ...initialState(875, 1000),
      pipelineState: {
        ...initialState(875, 1000).pipelineState,
        incompleteConsolidation: { verdicts: [o], filesPresent: [] },
      },
    } as unknown as Record<string, unknown>);
  assert(ic({ id: "a", status: "uncovered", uncoveredPaths: ["src/a.ts"], dirty: true }).length === 0, "#875: dirty=true accepted");
  assert(ic({ id: "a", status: "uncovered", uncoveredPaths: ["src/a.ts"], dirty: false }).length === 0, "#875: dirty=false accepted");
  assert(ic({ id: "a", status: "uncovered", uncoveredPaths: ["src/a.ts"] }).length === 0, "#875: legacy (no dirty) stays valid");
  assert(ic({ id: "a", status: "uncovered", uncoveredPaths: ["src/a.ts"], dirty: "yes" }).some((x: string) => x.includes("dirty") && x.includes("not a boolean")), "#875: non-boolean dirty refuses");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
