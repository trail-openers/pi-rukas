/**
 * workflow-state-events-leftover — #730 worktree-leftover-handled event.
 *
 * The branch step's same-issue residue pass (worktree-leftover.ts) records,
 * per leftover worktree, WHAT it did: adopted (reused a clean leftover at
 * the cycle's own target path) or removed (after preservation: salvage
 * patch and/or a durable HEAD tag). The acceptance criterion is explicit —
 * "the branch step either reuses an existing worktree knowingly or removes
 * it first, and reports which it did" — so the report is a first-class
 * event, not just a plumb-report string the operator has to parse.
 *
 * Same seam pattern as workflow-state-events-provision.ts: a pure
 * event-type fragment composed into the closed `WorkEvent` union by name.
 */

export type WorktreeLeftoverHandledEvent = {
  /** #730 — the branch step's disposition of one same-issue leftover. */
  kind: "worktree-leftover-handled";
  at: number;
  /** Absolute worktree path (`.worktrees/issue-<N>-<id>`). */
  path: string;
  /** "adopt" (reused in place) or "removed" (preserved, then removed). */
  action: "adopt" | "removed";
  /** Durable references created for the removed work (tags), empty when clean. */
  refs: string[];
  /** Scratch salvage dir when the removed tree held uncommitted work. */
  salvageDir?: string;
  /**
   * True when the leftover's dirty state was preserved by THIS event's
   * handling (vs. the #545 salvage path, which preserves but keeps the
   * worktree on disk). Observational — the removal above already proves it.
   */
  preserved?: boolean;
};
