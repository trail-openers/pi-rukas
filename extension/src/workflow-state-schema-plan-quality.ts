/**
 * workflow-state-schema-plan-quality — the PlanQualityReason type
 * (split from workflow-state-schema.ts for the AGENTS.md §12 500-line cap).
 */

export type PlanQualityReason =
  | "under-decomposed"
  | "empty-paths"
  | "overlapping-paths"
  | "test-subject-split"
  // #679 — case 2(a): a `depends-on` reference naming a workstream the plan
  // did not declare (including a self-reference, or a reference to an id
  // folded away by the MAX_WORKSTREAMS ceiling).
  | "invalid-dependency"
  // #679 — case 2(a): the depends-on graph has a cycle (A→B→A, or the
  // transitive A→B→C→A shape). Cycle detection lives ONLY in the
  // plan-quality gate — once it passes, runDevelop's scheduler is guaranteed
  // a DAG and needs no cycle handling of its own.
  | "circular-dependency"
  // #679 — case 3: workstreams are interdependent via DIFFERENT-FILE
  // relationships (an explicit depends-on, or the #479 test-subject split) but
  // the dependent workstream declares no `- integration-test: <path>` line
  // naming a consolidated-tree test exercising both halves. Deliberately
  // disjoint from overlapping-paths, which fires on the SAME file.
  | "interdependent-no-integration-test";
