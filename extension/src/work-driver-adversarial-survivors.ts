/**
 * work-driver-adversarial-survivors — the workstreams a fix pass does NOT run,
 * rendered as the outcomes the caller reports as though they had been
 * (v0.12.x; split from `work-driver-adversarial-fix.ts`, which owns the pass).
 *
 * A workstream whose loop already reached a terminal verdict before this pass is
 * not re-run: re-dispatching a developer at a workstream the reviewer approved
 * would re-open settled work. It still has to appear in the caller's result, so
 * its prior verdict is rebuilt from the log — which is the only record a
 * single-workstream cycle keeps (it writes no per-workstream outcome event).
 */

import { actionFor } from "./work-driver-adversarial-fix.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** A workstream id as the event log keys it (N=1 rounds carry no workstreamId). */
const keyOf = (workstreamId: string | undefined): string => workstreamId ?? "default";

export function survivorsOf(
  state: WorkState,
  ids: readonly string[],
  runSet: readonly string[],
  priorOutcomes: ReadonlyMap<string, string>,
): AdversarialOutcome[] {
  return ids
    .filter((id) => !runSet.includes(id))
    .flatMap((id) => {
      const prev =
        priorOutcomes.get(id) ??
        (ids.length === 1 ? lastReviewVerdict(state.eventLog, id) : undefined);
      if (prev !== "approved" && prev !== "rejected" && prev !== "skipped-empty-diff") return [];
      const findings = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
            e.kind === "adversarial-workstream-outcome" && e.workstreamId === id,
        )?.findings;
      return [
        {
          id,
          ok: prev === "approved" || prev === "skipped-empty-diff",
          rounds: 0,
          records: [],
          infra: false,
          threw: false,
          skipped: prev === "skipped-empty-diff",
          priorInfra: false,
          priorVerdict: prev,
          ...(prev === "approved" && findings ? { passFindings: findings } : {}),
        },
      ];
    });
}

/**
 * The verdict a single-workstream cycle's last parsed review reached. Such a
 * cycle keeps no per-workstream outcome event, so the log is the only record.
 */
function lastReviewVerdict(
  eventLog: readonly WorkEvent[],
  workstreamId: string,
): "approved" | "rejected" | undefined {
  const last = [...eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "adversarial-round" }> =>
        e.kind === "adversarial-round" && e.verdictParsed && keyOf(e.workstreamId) === workstreamId,
    );
  if (!last) return undefined;
  const action = actionFor(last.status, last.round);
  if (action === "pass") return "approved";
  if (action === "reject") return "rejected";
  return undefined;
}
