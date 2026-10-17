/**
 * work-driver-explain-develop-crash — the cap-hit explanation for the
 * develop child-crash family (#1403), split from work-driver-explain.ts so
 * that file stays under the §12 500-line cap with headroom for new caps.
 * Same seam as work-driver-explain-detect-caps.ts: one cap family, one module,
 * and the `explainCap` switch keeps a one-line case for it.
 */

import { crashTreeSentence, developCrashes } from "./work-develop-crash.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * #1403 — the dead-child shape. Which pass died, and what it left behind,
 * comes from that workstream's `branch-completed.crash` record (exit code,
 * tree state, the paths it left uncommitted), so the operator sees what the
 * crash COST rather than merely that a child stopped. The work is NOT lost —
 * it is in the worktree — which is exactly why this parks as a handoff and is
 * not terminalized as `aborted`.
 */
export function explainDevelopCrash(state: WorkState): string {
  const crashes = developCrashes(state.eventLog);
  const hit = lastCapHit(state, "develop-child-crash");
  if (crashes.length === 0) {
    return `a develop child's engine died mid-pass and the driver could not read back which workstream crashed — ${hit?.evidence ?? "the state file's event log carries the dispatch tail"}. Inspect each worktree (\`git -C <worktree> status\`) before re-running: a dead pass leaves its work uncommitted, and the safety net deliberately never commits a failed attempt's partial work`;
  }
  const detail = crashes.map((c) => `[${c.id}] ${crashTreeSentence(c)}`).join("; ");
  return `a develop child's engine stopped unexpectedly mid-pass, so its pass is NOT counted as done — ${detail}. The step halted here instead of reporting done and spending its remaining review rounds on a tree the driver cannot describe: a pass whose engine died is never ok, and the safety net does not commit a failed attempt's partial work. Recover it from the worktree named above (\`git -C <worktree> status\`, then \`git -C <worktree> diff\`), commit or salvage it, and re-run \`/work <issue> --restart\``;
}
