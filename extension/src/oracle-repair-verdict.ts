/**
 * oracle-repair-verdict — the two sentences and the rows key a repair step writes into its record. Pure over
 * the round's own result, so it lives outside `src/lean/` with the round's other readers: the engine calls in,
 * it never calls out.
 */
import type { Outcome, Step } from "./lean/state.ts";
import type { DispatchUsageRow } from "./lean/step-budget.ts";
import { joinNotes } from "./lean/text-fence.ts";
import { newestDecided } from "./lean/state.ts";
import { traceWarn } from "./trace.ts";

/** The newest decided `build` step whose blocked report the driver honoured. */
export function blockedStep(steps: Step[]): Step | undefined {
  const b = newestDecided(steps, "build");
  return b?.outcome?.kind === "blocked" ? b : undefined;
}

/** Rows only when the step paid for a child: an absent key means "not a step that dispatches". */
export function rowsKey(rows: DispatchUsageRow[]): { dispatches?: DispatchUsageRow[] } {
  return rows.length === 0 ? {} : { dispatches: rows };
}

/** The verdict a refused round leaves: the builder goes again against the same contract. */
export function refusedRepair(r: { why: string; rows: DispatchUsageRow[] }, blocked: Step): Outcome {
  return {
    kind: "refused",
    reason: joinNotes([
      `the repair round was refused: ${r.why}`,
      // Kept visible so the handback names which oracle the run argued about.
      blocked.outcome?.reason ?? "",
    ]),
    ...rowsKey(r.rows),
  };
}

/** What the run now holds: the files, and whether each passes where the builder's code stands. */
export function repairedSentence(r: {
  paths: string[];
  passedAtHead: Record<string, boolean>;
}): string {
  const list = r.paths
    .slice(0, 8)
    .map((p) => `${p} (${r.passedAtHead[p] === true ? "passes at head" : "does NOT pass at head"})`)
    .join(", ");
  traceWarn(`lean repair: ${list}`);
  return `repaired ${String(r.paths.length)} frozen test file(s): ${list}`;
}
