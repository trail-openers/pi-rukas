/**
 * work-driver-deps-hint — missing-deps diagnostic for the develop verify gate.
 *
 * Split from work-driver-verify-develop.ts (AGENTS.md §12 file-size cap,
 * #669 consolidation made the verify file exceed 500 lines). Builds a
 * missing-deps hint message tailored to what the provisioner actually did
 * for a worktree, using the `worktree-provisioned` event the branch step
 * emitted. Falls back to the generic hint when no event exists (e.g. the
 * branch step predates this event).
 */

import type { WorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * Build a missing-deps hint message tailored to what the provisioner
 * actually did for this worktree, using the `worktree-provisioned` event
 * the branch step emitted. Falls back to the generic hint when no event
 * exists (e.g. the branch step predates this event).
 */
export function provisionDepsHint(state: WorkState, cwd: string): string {
  const event = state.eventLog
    .filter((e): e is WorktreeProvisionedEvent => e.kind === "worktree-provisioned")
    .find((e) => e.worktreePath === cwd);
  if (!event) {
    return (
      " — this looks like missing dependencies in the worktree rather than a defect" +
      " in the diff. Provisioning discovers `node_modules` at `repoRoot` and in" +
      " depth-1 package dirs with a manifest/lockfile; if the tree is elsewhere or" +
      " empty, add or fix `.pi/worktree-setup`"
    );
  }
  switch (event.outcome) {
    case "hook-ran":
      return (
        " — provisioning ran via `.pi/worktree-setup` (hook succeeded) but" +
        " dependencies are still missing; the hook may not install all needed packages"
      );
    case "hook-failed":
      return ` — the \`.pi/worktree-setup\` hook failed during provisioning${event.problem ? `: ${event.problem.slice(0, 200)}` : ""} — fix the hook and re-run`;
    case "symlink":
      return (
        " — provisioning symlinked dependency directories but the needed package may" +
        " not be present in the symlinked tree; check the symlink targets with" +
        " `ls -la` in the worktree"
      );
    case "none":
      return ` — provisioning found no usable dependency directory to link${event.problem ? ` (${event.problem.slice(0, 200)})` : ""}; add or fix \`.pi/worktree-setup\``;
    case "ops-fallback-unprovisioned":
      return (
        " — the ops-dispatch branch-step fallback was used and does not run" +
        " `provisionWorktree`; the worktree contains only tracked files." +
        " Run `.pi/worktree-setup` manually in the worktree, or fix the SSH/env" +
        " issue that caused the mechanized branch step to fall back"
      );
    default:
      // Cross-version state file: outcome value written by a newer build.
      // Return the generic hint rather than falling off the end and returning
      // undefined, which would corrupt the failure message.
      return (
        " — this looks like missing dependencies in the worktree rather than a defect" +
        " in the diff. Provisioning discovers `node_modules` at `repoRoot` and in" +
        " depth-1 package dirs with a manifest/lockfile; if the tree is elsewhere or" +
        " empty, add or fix `.pi/worktree-setup`"
      );
  }
}
