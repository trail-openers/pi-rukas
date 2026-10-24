/**
 * work-driver-verify-gate-record — the one place the consolidated gate's verdict
 * is recorded, with the rule for what a REUSED or a FAILED pass records.
 *
 * Extracted from `work-driver-verify-verify-cmd.ts` (AGENTS.md §12 file-size cap).
 * It lives apart because the decision is three-armed and each arm's shape closes a
 * real bug: a caller that had to thread the record outward could drop it, and the
 * only symptom of a dropped record is "the cycle is slow again"; a reused pass that
 * refreshed `at` would keep a stale verdict permanently fresh; and a failed pass
 * must still retire the greens its own run just refuted.
 */
import { execp } from "./exec.ts";
import type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify-types.ts";
import {
  type GateRecorded,
  combinedWorktreeTree,
  gatePassRecord,
} from "./work-driver-verify-gate-reuse.ts";
import type { WorkstreamGreen } from "./workflow-state-schema-gate-reuse.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Record what this consolidated pass established, in the seam that decided it.
 *
 * `reusedWholeGate` records NOTHING: a reused pass measured no duration, and
 * refreshing a record's `at` every round would keep a stale verdict permanently
 * "fresh" — which is the whole point of the freshness screen. The combined tree is
 * re-read AFTER the probe (whose checkout the probe has since restored) with the
 * same function the reuse check used, so the record and the decision cannot
 * describe different content; an unreadable tree records nothing (no record, no
 * reuse). A failed pass records no verdict either, but a green the command just
 * refuted must not survive to license the next round's skip.
 */
export async function recordConsolidatedGateVerdict(opts: {
  cons: ConsolidatedVerifyResult;
  reusedWholeGate: boolean;
  /** The executor the gate's git reads go through (its own, or the process default). */
  execFn: ExecFn;
  state: WorkState;
  cmd: string;
  passTimeoutMs: number;
  consolidatedDurationMs: number | undefined;
  greensRecorded: Array<[string, WorkstreamGreen]>;
  greensRefuted: string[];
  onGateRecorded?: GateRecorded;
}): Promise<void> {
  const {
    cons,
    reusedWholeGate,
    execFn,
    state,
    cmd,
    passTimeoutMs,
    consolidatedDurationMs,
    greensRecorded,
    greensRefuted,
    onGateRecorded,
  } = opts;
  if (cons.status === "passed" && !reusedWholeGate) {
    const combined = await combinedWorktreeTree(execFn, state.pipelineState.worktrees ?? {});
    // A passing pass whose combined tree could not be read records no verdict:
    // an entry needs a tree, and one guessed from a partial read is the record
    // a later skip would stand on. Its greens are still recorded — each was
    // read from its own worktree at the moment its command passed.
    onGateRecorded?.(
      combined === undefined
        ? undefined
        : gatePassRecord(combined, cmd, passTimeoutMs, consolidatedDurationMs),
      greensRecorded,
      greensRefuted,
    );
  } else if (reusedWholeGate) {
    // A reused pass records nothing: it measured no duration, and refreshing a
    // record's `at` every round would keep a stale verdict permanently "fresh".
    onGateRecorded?.(undefined, [], []);
  } else if (greensRefuted.length > 0) {
    // A failed pass records no verdict, but a green the command just refuted
    // must not survive to license the next round's skip.
    onGateRecorded?.(undefined, [], greensRefuted);
  }
}
