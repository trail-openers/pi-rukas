/**
 * /work workflow state — the `retry-tree-clean` event (#1391), split out of
 * `workflow-state-events.ts` for the AGENTS.md §12 size limit. The composed
 * union references it by name.
 */
import type { WorkStep } from "./workflow-state-events.ts";

/**
 * #1391 — what the driver did with the tree a LOST step attempt left behind,
 * before it re-dispatched the step. Written by `work-driver-step-clean.ts`
 * only when there was work in the tree; a clean tree records nothing.
 *
 *  - `cleaned` — the work was saved (`ref` + `patch`) and the tree reset, so
 *    the retry starts clean.
 *  - `kept` — the tree carries commits, so nothing was touched; `detail` says why.
 *  - `failed` — the save did not land and the tree was NOT touched; the cycle
 *    parks with `detail` as the reason.
 *
 * `ref` and `patch` are the operator's recovery handles: `/work-status` and the
 * handoff render both, so the work is findable without reading the state file.
 */
export type RetryTreeCleanEvent = {
  kind: "retry-tree-clean";
  at: number;
  step: WorkStep;
  /** The attempt that was lost (1-based). */
  attempt: number;
  outcome: "cleaned" | "kept" | "failed";
  worktree: string;
  /** Work paths found before anything was touched (bounded). */
  files: string[];
  /** Total work paths, which `files` may truncate. */
  fileCount: number;
  ref?: string;
  patch?: string;
  detail?: string;
};
