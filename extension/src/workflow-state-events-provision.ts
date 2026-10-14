/**
 * /work workflow state — worktree provisioning event fragment.
 *
 * Records what `provisionWorktree` did for a given worktree so the develop-
 * gate failure message can name the ACTUAL provisioning outcome rather than
 * giving generic advice about a hook the ops-fallback path never called.
 *
 * Same seam pattern as `workflow-state-events-memory.ts` and
 * `workflow-state-events-widening.ts`: a pure event-type fragment referenced
 * by name in the composed `WorkEvent` union in `workflow-state-events.ts`.
 */

/**
 * What happened during worktree provisioning.
 *
 * - "hook-ran":                 `.pi/worktree-setup` was found and exited 0. May still
 *                               carry a `problem`: the hook ran, but an expected
 *                               dependency tree is absent from the worktree.
 * - "hook-failed":              `.pi/worktree-setup` was found but exited non-zero.
 * - "symlink":                  No hook; at least one dep directory was symlinked in.
 * - "none":                     No hook; nothing linkable was found (worktree is bare).
 * - "ops-fallback-unprovisioned": The ops-dispatch branch path was taken;
 *                               `provisionWorktree` was never called — the worktree
 *                               holds only the tracked files from `git worktree add`.
 */
export type WorktreeProvisionOutcome =
  | "hook-ran"
  | "hook-failed"
  | "symlink"
  | "none"
  | "ops-fallback-unprovisioned";

/**
 * Emitted once per worktree immediately after the branch step creates it.
 *
 * Absent when the worktree was created by a code path that predates this
 * event (back-compat: callers that read the log filter on `e.kind ===
 * "worktree-provisioned"` and treat absence as unknown/unprovisioned).
 *
 * The type is a discriminated union: `problem` is required when
 * `outcome === "hook-failed"` (the factory function `provisionOutcome`
 * enforces this at runtime; the type encodes it at compile time), and
 * optional for all other outcomes.
 */
export type WorktreeProvisionedEvent = {
  kind: "worktree-provisioned";
  at: number;
  /** Workstream id, e.g. "default" or "task-a". */
  worktreeId: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
} & (
  | {
      outcome: "hook-failed";
      /**
       * Required when `outcome === "hook-failed"`: the hook's exit message.
       * Makes the hook-failed → problem invariant a compile-time guarantee.
       */
      problem: string;
    }
  | {
      outcome: Exclude<WorktreeProvisionOutcome, "hook-failed">;
      /**
       * Populated on "none" when a dependency manifest was found but no
       * usable tree was linkable, and on "hook-ran" when the hook exited 0
       * but left an expected tree absent. The detail lets the operator tell
       * a broken hook from a merely absent one.
       */
      problem?: string;
    }
);

/**
 * Map a ProvisionResult to the event outcome, then build
 * a typed WorktreeProvisionedEvent. Moved here from work-driver-branch-develop
 * because the factory is the authority on the hook-failed → problem invariant
 * that the discriminated union encodes.
 *
 * "hook-failed" is the hook's EXIT STATUS, not "a problem was recorded": a
 * hook that exited 0 is "hook-ran" whatever verification found afterwards.
 * Deriving the outcome from `problem` made "failed" mean "nothing to do", so
 * a real hook failure was indistinguishable from a no-op.
 */
export function makeWorktreeProvisionedEvent(
  worktreeId: string,
  worktreePath: string,
  via: "hook" | "symlink" | "none",
  problem: string | undefined,
  hookFailed = false,
): WorktreeProvisionedEvent {
  if (via === "hook") {
    return hookFailed
      ? {
          kind: "worktree-provisioned",
          at: Date.now(),
          worktreeId,
          worktreePath,
          outcome: "hook-failed",
          problem: problem ?? "",
        }
      : {
          kind: "worktree-provisioned",
          at: Date.now(),
          worktreeId,
          worktreePath,
          outcome: "hook-ran",
          problem,
        };
  }
  return {
    kind: "worktree-provisioned",
    at: Date.now(),
    worktreeId,
    worktreePath,
    outcome: via === "symlink" ? "symlink" : "none",
    problem,
  };
}
