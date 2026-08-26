/**
 * workflow-state-cap — the #543 dispatch-cap types: the evidence a cap
 * kill fired (`CapEvidence`, F4(j)) and the driver-owned checkpoint
 * record (`CapedPartialState`, F5). Split from workflow-state-schema.ts
 * for AGENTS.md §12 file-size hygiene.
 */

import type { RoleName } from "./roles.ts";

/**
 * #543 F4 — the evidence that a dispatch-cap kill fired, rendered by the
 * handoff surfaces so the operator sees WHAT looped (or how much was spent)
 * without opening the transcript. Lives on pipelineState, NOT the event log
 * (#533 tail-invariance rule): it is a snapshot of the most recent kill, and
 * appending a per-kill event instead would change the tail `nextStep()`
 * routes on.
 *
 * Optional; absent until a loop/token-budget kill has happened in this
 * cycle. A discriminated union so the TYPE and `validateDiscriminants`
 * (workflow-state-validate.ts) agree by construction: `kind: 'loop'`
 * REQUIRES `count` (the repeat count is the trigger evidence there) and may
 * carry the tool / fingerprint / turn range; `kind: 'token-budget'` REQUIRES
 * the budget arithmetic (budgetTokens + usedTokens — the arithmetic is the
 * whole story there). The validator stays as the runtime canary for
 * disk-read data (the untyped cast in `readState`).
 */
export type CapEvidence =
  | {
      kind: "loop";
      /** The tool the repeated calls were made with. */
      tool: string;
      /** Repeat count at trigger — required: the count IS the evidence. */
      count: number;
      /** Normalised args fingerprint. */
      fingerprint?: string;
      /** First/last turn of the streak. */
      turnRange?: [number, number];
    }
  | {
      kind: "token-budget";
      /** The configured budget — required: the arithmetic is the evidence. */
      budgetTokens: number;
      /** Cumulative tokens observed at kill. */
      usedTokens: number;
    };

/** #543 F5 — the driver-owned checkpoint taken when a dispatch-cap kill fires.
 *
 * The killed child CAN produce a report (that is its text); it can NEVER
 * commit or write files (lens/adversarial/explore are structurally denied
 * write/edit/multiedit per role-tools.ts #238). So after the kill the
 * DRIVER stages + commits the worktree and authors the status file; this
 * record is what the handoff renderers read to state what was saved and
 * what is still out in the tree.
 */
export interface CapedPartialState {
  /** The cap that fired ("loop-detected" | "token-budget"). */
  cap: string;
  /** The killed child's role ("developer" | "code-review-specialist" | …).
   * Optional: a kill whose role the driver cannot name still gets a record —
   * the driver omits the field rather than force-cast an unknown role. */
  role?: RoleName;
  /**
   * "committed" — the driver staged + committed the tree; `commitSha` is set.
   * "dirty-uncommitted" — the tree was dirty and the driver could not or did
   * not commit (nothing recoverable, or a read-only role with no tree).
   * "clean" — the tree was clean at kill time (nothing to recover).
   */
  tree: "committed" | "dirty-uncommitted" | "clean";
  /** SHA of the driver-authored checkpoint commit (tree: "committed"). */
  commitSha?: string;
  /** Absolute path of the driver-authored `status-<role>.md` in the scratch dir. */
  statusFile?: string;
  /** Dirty paths AFTER the checkpoint commit ("" means none — verified clean). */
  remainingFiles?: string[];
  /** True for structurally write-gated roles — the operator should not
   * expect any committed work, only the child's report. */
  reportOnly?: boolean;
  /**
   * #544 — the checkpoint runs `bunx tsc --noEmit` in the worktree's
   * `extension/` directory BEFORE committing (recovery, not the full gate —
   * that runs on the integrated branch). `false` means the checkpoint
   * commit is known-broken as-is and the handoff surfaces say so. Absent
   * when the check could not run (worktree has no `extension/`).
   */
  typechecked?: boolean;
  at: number;
}
