/**
 * workflow-state-schema-lens-fix — the lens-fix / verify / base-health tail of
 * `PipelineState`, split from `workflow-state-schema.ts` for the AGENTS.md §12
 * 500-line gate.
 *
 * `PipelineState` extends this, so the fields stay first-class members of the
 * state a reader sees (`ps.verifyAttribution`, `ps.gateReuse`, …) and no call
 * site changes. The seam is the same one `workflow-state-schema-gates.ts` and
 * `workflow-state-schema-workstreams.ts` already use: a group of fields with
 * one shared subject moves out, the interface it belongs to extends it, and the
 * doc comments travel with the fields rather than being paraphrased.
 *
 * What lives here is the review-and-verify tail of the cycle: the lens-fix
 * round's plan-time fence (#1852), the write-fence counters (#1655), the verify
 * gate's reuse and attribution records (#1415/#1647), and the branch step's
 * base-health probe (#1765). All of them are optional and all of them are
 * absent-on-old-state-files by the same rule, so moving them is additive — the
 * schema version stays 1.
 */
import type { VerifyAttributionRecord } from "./work-driver-verify-shared.ts";
import type { GatePass, WorkstreamGreen } from "./workflow-state-schema-gate-reuse.ts";
import type { LensFixFenceSnapshot } from "./workflow-state-schema-lens-fix-fence.ts";

/** The review-and-verify tail of `pipelineState` (see the module header). */
export interface PipelineStateReviewTail {
  /**
   * #1852 — the plan-time fence of the lens-fix round that has not yet been
   * gated, written by the lens-fix step before the fixer was dispatched and
   * read by the adversarial step's fence gate BEFORE any landing arm. A record
   * whose `round` is not the current `reviewRound` is stale and ignored; a
   * lens-fix round that has no record (the fence could not be built) parks
   * rather than landing unchecked. Absent = no lens-fix round awaiting its gate.
   */
  lensFixFence?: LensFixFenceSnapshot;
  /**
   * #1655 — writes the write fence refused across this cycle's fenced children,
   * summed from the scratch-dir logs at each step boundary. A count, not an
   * event: appending would change the tail nextStep() routes on. Absent = none.
   */
  writeFenceRefusals?: number;
  /** #1655 — refusal logs the driver could not read. Non-zero means the total is a lower bound. Absent = none. */
  writeFenceUnreadable?: number;
  /**
   * #1415 — the verify gate's reuse records: whole-gate passes this cycle RAN and
   * PASSED (keyed by `<treeHash>\0<cmd>\0<timeoutMs>`) plus each workstream's own
   * per-worktree green. A develop pass whose own triple is present, fresh, cheap
   * enough to skip, and matched by every changed workstream's green runs NOTHING.
   * Grouped so the two travel together; absent = never a pass. Shape + rule:
   * `workflow-state-schema-gate-reuse.ts` / `work-driver-verify-gate-reuse.ts`.
   */
  gateReuse?: {
    /** Whole-gate passes RAN and PASSED, keyed by (tree, command, bound). */
    passes: Record<string, GatePass>;
    /** Per-workstream greens; the whole-gate skip needs every workstream's. */
    workstreamGreens: Record<string, WorkstreamGreen>;
  };
  /**
   * #1647 — tests the selected verify let through without blocking: `flaky`
   * (failed once, passed on the rerun) and `baselineRed` (red on the base commit
   * too). Commit-pr renders both into the PR body and the handoff renders them.
   * Absent = none recorded.
   */
  verifyAttribution?: VerifyAttributionRecord;
  /**
   * #1765 — the branch step's pre-develop base probe (shape and rule:
   * `workflow-state-schema-base-health.ts`). Absent = never probed.
   */
  baseHealthProbe?: import("./workflow-state-schema-base-health.ts").BaseHealthVerdict;
}
