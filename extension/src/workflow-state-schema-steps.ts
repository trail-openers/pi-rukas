/**
 * #1403 — the WorkStep vocabulary as a runtime value, split from
 * workflow-state-schema.ts (AGENTS.md §12 file-size limit) using the same
 * fragment pattern as workflow-state-schema-converge.ts. Re-exported from
 * workflow-state-schema.ts so every existing importer keeps its path.
 *
 * The union type in workflow-state-events.ts is the source of truth for TS
 * callers; this tuple exists so runtime readers (the #533 unknown-step guard
 * in work-driver.ts, and readState's validation) can tell a step the writer
 * invented from one the vocabulary actually has. Keeping them in sync is the
 * union's job: a step added to one and not the other is a tsc error.
 */
import type { WorkStep } from "./workflow-state-events.ts";

export const WORK_STEPS: readonly WorkStep[] = [
  "explore",
  "plan",
  "branch",
  "develop",
  "adversarial",
  "commit-pr",
  "lens-review",
  "lens-fix",
  "step-back",
  "handoff",
  "ci",
  "merged",
];
