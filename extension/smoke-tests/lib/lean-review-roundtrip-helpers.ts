/**
 * lib/lean-review-roundtrip-helpers — the fixtures the two fix-run-id suites share.
 *
 * `test-lean-review-row-roundtrip.ts` asserts that ONE grammar governs the fixer
 * row's `runId` across the write, the fold and the load;
 * `test-lean-review-run-id-rules.ts` asserts the two rules about that field that
 * must NOT be merged (the fold skips a bad row, the loader refuses the whole record)
 * and the reader that decides which tree a resumed attempt re-enters. Both need the
 * same three things: a step run that buys exactly one fixer, a record whose `review`
 * step carries given rows, and a `loadRun` that reports its throw instead of dying.
 *
 * They live here, and not duplicated in either file, because the two suites were
 * split along the ratchet and a copy of `runWithRows` in each is a second definition
 * of "the shape the engine persists" — the exact class of drift these suites exist to
 * catch. Lives in `lib/` and never executes on its own.
 */

import { createRun, loadRun } from "../../src/lean/state.ts";
import type { DispatchUsageRow } from "../../src/lean/step-budget.ts";
import { put } from "./lean-build-fixture.ts";
import {
  BRANCH,
  FIXER_ROLE,
  ctxFor,
  depsWith,
  git,
  rejectsThenClears,
  result,
  runStep as run,
} from "./lean-review-fixtures.ts";
import type { ReviewInfraError } from "../../src/lean/review.ts";

/** What one fix round costs, and the tree it was worked in. */
export const FIXER_MS = 4_321;
export const FIXER_USAGE = { input: 900, output: 90, cacheRead: 0, cacheWrite: 0, cost: 0.75, turns: 12 };

/**
 * Run the step once through a fix round, and hand back the rows it billed.
 *
 * The adversarial gate refuses once and then clears, so the step buys exactly one
 * fixer: the same shape `test-lean-review-tree.ts` (s) drives. What is added here
 * is the child's own usage — a row that costs nothing cannot demonstrate that it
 * went unbilled.
 */
export async function fixRoundRows(
  repoRoot: string,
  baseSha: string,
): Promise<DispatchUsageRow[]> {
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: rejectsThenClears("1. silent catch"),
      dispatch: async (spec) => {
        const wt = spec.cwd as string;
        put(wt, "fix.ts", "export const x = 1;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE, ms: FIXER_MS, usage: FIXER_USAGE });
      },
    }),
  );
  // The step's own accumulated rows, which on this path arrive on the `done`
  // outcome — the same array the engine writes into the durable record. A throw
  // carries them on the error instead, and either is what the record gets.
  return outcome?.dispatches ?? (threw as ReviewInfraError | undefined)?.dispatches ?? [];
}

/** The one fixer row among `rows`, or undefined. */
export function fixerOf(rows: readonly DispatchUsageRow[]): DispatchUsageRow | undefined {
  return rows.find((r) => r.role === FIXER_ROLE);
}

/**
 * A run record whose `review` step carries `rows` — the shape the engine persists
 * after `settle` folds the handler's outcome. `kind: "done"` is the only kind the
 * review state may record (`review: ["done"]` in `machine.ts`).
 */
export function runWithRows(rows: DispatchUsageRow[], baseSha: string) {
  const rec = createRun({ issue: 7, version: "test", models: {}, baseSha, branch: BRANCH });
  return {
    ...rec,
    steps: [
      {
        key: "7:review:0",
        state: "review" as const,
        startedAt: 1,
        endedAt: 2,
        outcome: { kind: "done", reason: "reviewed", dispatches: rows },
      },
    ],
  };
}

/** `loadRun`, with the throw captured so a case can assert on its absence. */
export function tryLoad(
  repoRoot: string,
  issue: number,
): { loaded?: ReturnType<typeof loadRun>; thrown?: unknown } {
  try {
    return { loaded: loadRun(repoRoot, issue) };
  } catch (err) {
    return { thrown: err };
  }
}
