import { newestDecidedWorkStep } from "./lean/handback-heads.ts";
/**
 * oracle-repair-disclose — the handback line for a run that spent its repair round and still cannot meet the
 * contract. Both facts it prints are the record's own: the hash of the file that was replaced, and whether the
 * replacement passed where the builder's code stands. Outside `src/lean/` with the round's other readers.
 */
import { BLOCKED_PATH_CAP } from "./lean/state-outcome-maps.ts";
import type { Step } from "./lean/state.ts";
import { oneLine } from "./lean/text-fence.ts";
import type { RepairRecord } from "./oracle-repair-fields.ts";

/** The handback's cause line for a run whose repair round did not save it, or `undefined` when none ran.
 *  It counts only at the newest WORK step, the same position the other causes hold. */
export function repairCause(steps: Step[]): string | undefined {
  const step = newestDecidedWorkStep(steps);
  const r = step?.state === "repair" ? step.outcome?.repair : undefined;
  if (r === undefined) return undefined;
  return `the frozen oracle was repaired and the run still needs work:\n${lines(r).join("\n")}`;
}

/** One bullet per replaced file: what it was, and whether the replacement holds against the code. */
function lines(r: RepairRecord): string[] {
  return Object.entries(r.originalHashes).map(([path, hash]) => {
    const verdict = r.passedAtHead[path] === true ? "passes at head" : "does NOT pass at head";
    return `- ${oneLine(path, BLOCKED_PATH_CAP)} (was ${hash.slice(0, 12)}, now ${verdict})`;
  });
}
