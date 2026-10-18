/**
 * workflow-state-cap — the #543 dispatch-cap types: the evidence a cap
 * kill fired (`CapEvidence`, F4(j)) and the driver-owned checkpoint
 * record (`CapedPartialState`, F5), plus the shared `lastCapHit()`
 * event-log scan (#830). Split from workflow-state-schema.ts for AGENTS.md
 * §12 file-size hygiene.
 */

import type { RoleName } from "./roles.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state-schema.ts";

/**
 * #1137 — the `evidence` prefix a fix-pass park writes on its cap-hit
 * (`fix-pass-park`; `verify-failed:develop` before #1349). The explain
 * renderer keys on it to prefer that evidence over the gate's failure
 * bullets; the fix pass writes it. One constant, both sides.
 */
export const FIX_PASS_EVIDENCE_PREFIX = "adversarial fix pass: ";

/** Leads the failure string of a commit-pr re-entry refused on a PR that is not open. */
export const PR_NOT_OPEN_MARKER = "[pr-not-open]";

export type CapHitEvent = Extract<WorkEvent, { kind: "cap-hit" }>;

/**
 * The most recent `cap-hit` event with the given `cap`, or `undefined`.
 * #830 — the handoff surfaces used to each write their own
 * `[...state.eventLog].reverse().find(…)` scan; this is the shared one.
 */
export function lastCapHit(state: WorkState, cap: string): CapHitEvent | undefined {
  return [...state.eventLog]
    .reverse()
    .find((e): e is CapHitEvent => e.kind === "cap-hit" && e.cap === cap);
}

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

/**
 * #745 — why the merge-evidence gate's refusal was not a CI verdict.
 * Declared here (a neutral module both `workflow-state-schema.ts` and
 * `work-driver-merge-authority.ts` already import) so the persisted
 * `mergeHold.evidenceFailureKind` field and the runtime type cannot drift:
 * one literal, one name. `tooling` means the gate's own `gh` invocation
 * failed before any check data was read; `ci` means an actual check verdict
 * blocked the merge.
 */
export type EvidenceFailureKind = "tooling" | "ci";

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
   * #544 — the checkpoint runs `CHECKPOINT_TYPECHECK_CMD` (see
   * work-driver-cap-checkpoint.ts) in the worktree's `extension/` directory
   * BEFORE committing (recovery, not the full gate — that runs on the
   * integrated branch).
   *
   * #1414 round 2 — the three states are NOT interchangeable, and `false` is
   * the only one that indicts the code:
   *
   *   - `true`  — tsc exited 0. The tree typechecked.
   *   - `false` — tsc RAN and reported diagnostics (non-zero exit carrying
   *     `TSxxxx` output). The checkpoint commit is known-broken as-is and the
   *     handoff surfaces say so.
   *   - absent — the check never got to judge anything: no `extension/` to
   *     check, the executor could not be forked / the binary was not found,
   *     or the run was killed at its bound. A no-verdict is not a verdict on
   *     the code, so the handoff names the reason and never claims the code
   *     is broken. Pre-fix, all three landed as `false`.
   *
   * The command here is named by reference, not spelled: this module is
   * type-only, so importing the constant would invert the dependency, and
   * spelling it would be a second source of truth the no-bare-alias gate
   * (#1414) would have to keep in step by hand.
   */
  typechecked?: boolean;
  /**
   * #1414 round 2 — why the typecheck reached NO verdict, alongside the field
   * being absent. Three causes share the absent state (no `extension/`, the
   * command could not be run, killed at its bound) and the operator cannot act
   * on "absent": "add a \`.pi/worktree-setup\`" is the fix for one of them and
   * nonsense for the other two. Recorded when the checkpoint's typecheck
   * returned no verdict; absent whenever `typechecked` is present.
   */
  typecheckReason?: string;
  at: number;
}
