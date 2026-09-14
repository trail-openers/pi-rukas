/**
 * #500/#728 — the `commitPrRoot` pipeline-state record type, split from
 * workflow-state-schema.ts (AGENTS.md §12 file-size limit). Re-exported from
 * workflow-state-schema.ts so existing importers keep their paths.
 */
export interface CommitPrRootState {
  /** Current branch (`git rev-parse --abbrev-ref HEAD`); placeholder when unreadable. */
  branch: string;
  /** Porcelain column-1/2 status codes (`UU`, `AA`, `DD` — the unmerged set). */
  unmergedPaths: string[];
  /** Entries staged on BOTH columns (`MM`, ` M`, `A `, …) — untracked (`??`) excluded. */
  stagedCount: number;
  /** Total porcelain entries (staged + unstaged + untracked). */
  totalEntries: number;
  /** Epoch ms of the inspection. */
  capturedAt: number;
}
