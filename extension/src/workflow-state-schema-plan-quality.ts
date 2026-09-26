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
  | "interdependent-no-integration-test"
  // #849 — the one-shot corrective re-plan (triggered by the first plan's
  // overlapping-paths) dropped a dependsOn edge the first plan had, without
  // merging the two workstreams into one. The cycle CONTINUES with the
  // corrective plan (there is no second re-dispatch per #754's one-shot
  // rule); this is a RECORDED reason, not a re-dispatch trigger, and it is
  // surfaced to the operator through `pipelineState.planQuality.reason`
  // (same channel as every other reason). It is a quality signal, not a
  // block: the planner was told to preserve dependsOn and it didn't, which
  // is exactly the shape the corrective steer exists to correct.
  | "dropped-dependencies";
