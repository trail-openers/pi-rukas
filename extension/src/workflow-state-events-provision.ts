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
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

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

/**
 * The branch step's whole success record, in one call: the #844 reset event, the
 * `driver:branch` completion, one #536 provision event per workstream, and the
 * `pipelineState` fields the setup established.
 *
 * Lives beside `makeWorktreeProvisionedEvent` because that is the event whose
 * shape it has to know, and the branch step's job is to REPORT a setup it did not
 * perform — a step that rebuilt these events itself could drift from the provision
 * payload without any test noticing which workstream lost its `depsHint`.
 */
export function recordMechanizedBranchSetup(
  state: WorkState,
  setup: BranchSetupRecord,
  now: number,
): WorkState {
  return recordSetup(state, setup, now);
}

/** The shape `mechanizedBranchSetup` returns, narrowed to what the record reads. */
export interface BranchSetupRecord {
  branchName: string;
  baseSha: string;
  mainline: string;
  worktrees: Record<string, string>;
  provisions: Record<
    string,
    { via: "hook" | "symlink" | "none"; problem?: string; hookFailed?: boolean } | undefined
  >;
  resetFromSha?: string | undefined;
  workstreamBaseShas: Record<string, string> | undefined;
}

function recordSetup(state: WorkState, setup: BranchSetupRecord, now: number): WorkState {
  // #844 — the reset of a stale local branch is recorded in the event log (the
  // recovery handle) so the audit trail carries the old tip even if a later step
  // fails.
  let baseState = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "branch" } },
    { kind: "step-started", step: "branch", at: now },
  );
  if (setup.resetFromSha !== undefined) {
    baseState = appendEvent(baseState, {
      kind: "branch-reset",
      at: Date.now(),
      branch: setup.branchName,
      oldSha: setup.resetFromSha,
      newSha: setup.baseSha,
    });
  }
  // Via the shared builder (work-driver-events.ts): unique jobId — the old inline
  // literal "mechanized" appeared twice per fan-out cycle, making jobId useless as
  // a correlation key.
  let withProvisions = appendEvent(
    baseState,
    synthesizeDriverCompletion({
      step: "branch",
      label: "driver:branch",
      summary: `Mechanized branch setup: ${setup.branchName} @ ${setup.baseSha.slice(0, 8)} off origin/${setup.mainline}; ${Object.keys(setup.worktrees).length} worktree(s).`,
      startedAt: now,
      now: Date.now(),
    }),
  );
  // #536 — per-workstream provision event for targeted depsHint in verify-develop.
  for (const [id, cwd] of Object.entries(setup.worktrees)) {
    const pr = setup.provisions[id];
    if (pr) {
      withProvisions = appendEvent(
        withProvisions,
        makeWorktreeProvisionedEvent(id, cwd, pr.via, pr.problem, pr.hookFailed),
      );
    }
  }
  return {
    ...withProvisions,
    pipelineState: {
      ...withProvisions.pipelineState,
      branchName: setup.branchName,
      baseSha: setup.baseSha,
      worktrees: setup.worktrees,
      // #679 — record the per-workstream effective base as of the branch step.
      // Every independent workstream maps to the global baseSha; dependent
      // workstreams (deferred) are NOT in this map yet — their entry is added by
      // runDevelop at deferred-creation time, when the dependency's post-commit
      // SHA is known. Readers (applySafetyNet, verifyDevelopOutcome) fall back to
      // the global baseSha for any workstream id absent from the map.
      workstreamBaseShas: setup.workstreamBaseShas,
    },
  };
}
