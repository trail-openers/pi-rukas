/**
 * workflow-state-schema-gate-reuse — #1415: the shapes behind
 * `pipelineState.gateReuse` (`passes` and `workstreamGreens`).
 *
 * Same fragment pattern as the sibling `workflow-state-schema-*.ts` modules: a
 * pure type module with no value imports, composed into `PipelineState` by name
 * so the schema file — which sits 16 lines under the AGENTS.md §12 cap — keeps
 * its size while the reuse records stay next to the verify-evidence shapes they
 * belong to. The runtime rule over these values
 * (`work-driver-verify-gate-reuse.ts`) imports the types, so producer and
 * reader cannot drift on the shape they share.
 */

/**
 * The record of ONE passing gate run — the whole develop verify, per-worktree
 * commands and the consolidated probe alike.
 *
 * **The key is the TRIPLE (tree, command, bound), never the tree alone.** The
 * project's gate is a shell string read from `.pi/verify-cmd`, and that file is
 * untracked in most projects — `verifyTreeId` deliberately does not count an
 * untracked `.pi/verify-cmd` as dirt, so git's tree object id cannot see an
 * operator editing the gate mid-cycle. An entry whose `cmd` differs from the
 * command the gate is about to run is a miss, which is the run. The bound
 * belongs there for the same reason: a verdict reached close to a generous
 * bound is not a verdict under a tight one, and an operator who tightens
 * `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` must get the gate back without a stale record
 * to invalidate.
 */
export interface GatePass {
  /** The git tree object id the whole gate judged (every worktree in agreement). */
  treeHash: string;
  /**
   * The verify command that judged it, verbatim — the fast tier included.
   * `withFastTier` fails with the fast command's own name and `failedVerifyCmd`
   * reports it, so a fast-tier verdict is filed under the fast command and is
   * never reused for a full run: two commands, two verdicts.
   */
  cmd: string;
  /**
   * The wall-clock bound (`PI_ENSEMBLE_VERIFY_TIMEOUT_MS`) every run in the
   * pass actually received. Part of the identity, not metadata: read once per
   * pass so the record cannot name a bound no command ran under.
   */
  timeoutMs: number;
  /** Epoch ms of the pass. */
  at: number;
  /**
   * Wall-clock ms the run took. Retained for the operator and the handoff, and
   * used as a cheapness screen: a pass that consumed more than half the bound it
   * faced is not reused, because the run being skipped is the run the bound
   * exists to cap. Absent = never measured, which is never reused.
   */
  lastDurationMs?: number;
}

/**
 * One workstream's recorded per-worktree verify green.
 *
 * The consolidated probe's tree is the cherry-pick of every workstream's own
 * range onto the cycle's base, so the whole gate may be reused only when each
 * workstream has its own green for the content it now holds — a green for one
 * workstream and no record for another describes a combination nothing tested.
 */
export interface WorkstreamGreen {
  /** The tree `verifyTreeId` reported for the worktree when its command passed. */
  treeHash: string;
  /** The command that passed there, verbatim (fast tier included). */
  cmd: string;
  /** The bound that run received — part of the identity, as on `GatePass`. */
  timeoutMs: number;
  /** Epoch ms of the pass. */
  at: number;
}
