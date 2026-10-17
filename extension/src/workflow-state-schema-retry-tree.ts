/**
 * #1391 — the per-retry record of the working tree a step retry dispatched
 * into. Split out of `workflow-state-schema.ts` for the 500-line gate
 * (AGENTS.md §12); that module imports the field's type from here. Producer /
 * reader: `work-driver-retry-tree.ts` and `work-driver-retry-context.ts`.
 */

/**
 * What the driver found (and did) about the tree a lost attempt left behind —
 * read BEFORE the retry cleared it, so the retry line can name the only copy.
 */
export type RetryTreeAccounting = {
  outcome: "saved" | "already-clean" | "unreadable";
  /** The dirt the lost attempt left, as `git status --porcelain` reported it. */
  paths: string[];
  /** Where the copy lives — present only when there was something to copy. */
  savedTo?: string;
  /** Why the tree could not be read (`unreadable` only). */
  error?: string;
};

/** The field name `PipelineState` carries the account under, and the schema's
 *  one-line reference to it lives beside `integrateWorktree`. */
export type PipelineRetryTree = RetryTreeAccounting;
