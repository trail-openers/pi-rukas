import type { Seam } from "./seams-registry.ts";

/**
 * #1454 — the seams the stale-path-claim fix registered, split from
 * `seams-registry.ts` for the 500-line gate (AGENTS.md §12).
 * `test-seams-wired.ts` concatenates this with `SEAMS`; the assertions are
 * unchanged and still live in the test.
 */
export const SEAMS_1454: Seam[] = [
  {
    // #1454 — the cross-group claim registry. `checkAndRegisterClaims` is the
    // production entry the plan step calls; the exports below are the registry
    // operations that module calls internally (the gate has no other caller —
    // this module owns the claims file) or that the suite pins directly.
    // Declared rather than left to rot into "unwired": each is the subject of
    // a test in test-work-driver-cross-group-conflicts.ts or
    // test-work-driver-stale-path-claims.ts.
    file: "work-driver-path-claims.ts",
    pending: {},
    testOnly: {
      claimStaleReason:
        "the one staleness predicate, exported so the suite pins the age bound and the claimant-terminal rule against an injected `now` and state reader (readClaims calls it in production)",
      CLAIM_STALE_MS:
        "the named age bound; the suite asserts the default and drives the rule at the boundary (the old `_STALE_MS` was declared and read nowhere)",
      CLAIM_STALE_MIN_FLOOR_MS:
        "the 5-minute floor on the age bound; the suite pins it so a hand-edited PI_ENSEMBLE_CLAIM_STALE_MS cannot expire every claim on write",
      readClaims:
        "the liveness-filtered read; the suite asserts prune-on-read reaches the raw file",
      checkCrossGroupClaimsSync:
        "the pure overlap core; pinned by the overlap / normalisation / same-issue cases",
      registerClaim: "the atomic writer; pinned by the register / re-register / prune cases",
    },
    canary: { symbol: "checkAndRegisterClaims", importer: "work-driver-plan.ts" },
    selfCall: { symbol: "claimStaleReason", by: "readClaims" },
  },
  {
    // #1454 — the dead-owner sweep's ownership resolution. `runWorktreeSweep`
    // used to guess `.pi/work-state/<basename>.json`, which never matches a
    // multi-workstream tree; `findOwningCycleState` resolves the owner through
    // `pipelineState.worktrees` instead, and the sweep's own loop is its caller.
    file: "work-driver-worktree-sweep.ts",
    pending: {},
    testOnly: {
      findOwningCycleState:
        "worktree-path → owning cycle state; the sweep calls it in production, exported so the suite asserts the multi-workstream name mismatch resolves and path escapes are refused",
      resolveSweepTarget:
        "the path-validation gate; pinned by the traversal / not-our-worktree cases",
      decideSweepAction:
        "the 6-rule ladder; pinned by the live-owner / live-issue / purge / remove cases",
      executeSweepAction: "the purge-vs-remove executor; pinned by the artifact-purge case",
    },
    canary: { symbol: "runWorktreeSweep", importer: "work-driver.ts" },
    // The sweep's own loop is findOwningCycleState's only caller, so the seam
    // additionally asserts the internal call survives inside this module.
    selfCall: { symbol: "findOwningCycleState", by: "runWorktreeSweep" },
  },
  {
    // #1454 — the cross-group park's operator action, split from work-queue.ts
    // for the 500-line gate. humanActionFor is its only production caller.
    file: "work-queue-parks-claims.ts",
    pending: {},
    testOnly: {},
    canary: { symbol: "crossGroupAction", importer: "work-queue.ts" },
  },
];
