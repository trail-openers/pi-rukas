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
  // #1005 — a declared path is not a plain repo-relative path: a shell
  // metacharacter (`$(…)`, backtick, `;`, `&`, `|`, `<`, `>`, space, quote)
  // or an absolute / `..`-traversing path. The plan-time coupling merge's
  // rule-3 grep used to build a shell command out of these paths — a
  // metacharacter inside one would execute in that shell (H1); the fence
  // and the consolidation checks compare these paths as strings, so a
  // `..`-traversing or absolute path is not a scope the driver can verify.
  // The corrective steer tells the planner to re-declare the path as a
  // plain repo-relative path.
  | "invalid-path"
  // #849 — the one-shot corrective re-plan (triggered by the first plan's
  // overlapping-paths) dropped a dependsOn edge the first plan had, without
  // merging the two workstreams into one. The cycle CONTINUES with the
  // corrective plan (there is no second re-dispatch per #754's one-shot
  // rule); this is a RECORDED reason, not a re-dispatch trigger, and it is
  // surfaced to the operator through `pipelineState.planQuality.reason`
  // (same channel as every other reason). It is a quality signal, not a
  // block: the planner was told to preserve dependsOn and it didn't, which
  // is exactly the shape the corrective steer exists to correct.
  | "dropped-dependencies"
  // #819 — the plan-to-spec gate (`work-driver-plan-spec-coverage.ts`): no
  // workstream declares any path of a deliverable the spec requires, or the
  // reply carries more than one `## Workstreams` section (so the workstreams
  // the driver parsed are the first block's, and nothing says which issue
  // they are about). Produced by `planSpecMismatchReason`, NOT by
  // `planQualityReason` — the existing reasons check shape and never see the
  // spec, and this reason must not disturb their precedence. The first plan
  // gets the one-shot corrective; the CORRECTIVE halts with the
  // `plan-spec-mismatch` cap, because a wrong corrective must never reach
  // develop (the #818 incident: four developers built a fabricated
  // supply-chain package for 45 minutes). Surfaced through
  // `pipelineState.planQuality.reason` like every other reason.
  | "plan-spec-mismatch"
  // #1167 — a workstream's `outOfScope` fence contradicts its OWN `paths`
  // (the same file declared as both "yours" and "don't touch"), or an
  // `out-of-scope:` entry names a path the SAME workstream also declares.
  // Surfaced at develop as `declared fence violated` — the #776 / #1020
  // shape, where the (correct) change had to be finished by hand. This
  // reason covers contradictions the #1167 plan-time unfence did NOT remove:
  // a fence the issue never named. An issue-named contradiction is repaired
  // silently by `unfenceIssueNamedPaths` before this gate runs, so the
  // re-dispatch is reserved for fences the issue does not speak to.
  // Precedence: fires where `overlapping-paths` cannot — an out-of-scope
  // entry is not a `paths` entry, so no two workstreams' lists can collide.
  | "contradictory-fence";

/**
 * #1167 round-3 — what the plan-time issue-named unfence did, persisted on
 * `pipelineState.planQuality.unfence` for the operator.
 *
 * This exists because the pass's notes and warnings used to go only to
 * `trace()`, which nobody reads mid-cycle. In the state file, "the issue named
 * no fence", "the issue body could not be read", "the identifier cap was hit"
 * and "git failed" were four indistinguishable silences — and an operator
 * deciding whether to trust a plan cannot tell them apart from a line count.
 * The counts are the uncapped truth; the note lists are bounded, because the
 * point is a legible summary, not a transcript. Written by the plan step from
 * `unfenceSummary()`; absent when the unfence is disabled or the plan step
 * never reached it.
 */
export interface PlanUnfenceSummary {
  ran: true;
  /** Fence entries actually gone, having survived the placement rollback. */
  removed: number;
  /** Broader directory fences deliberately kept (the issue named one file). */
  kept: number;
  /** Removals rolled back because no workstream could own the path. */
  rolledBack: number;
  /** Identifiers the pass could not resolve to exactly one file. */
  unresolved: number;
  /**
   * #1250 change 1 — fences the N=1 docs/test rule opened, counted apart from
   * `removed` because the two rules answer to different authorities (an issue
   * that named a path vs. a docs/test shape in a single-workstream plan). An
   * operator reading a plan where fences went needs to know which rule did it.
   * Absent rather than zero, as the fields above.
   */
  docsTests?: number;
  /**
   * The issue body was named by the explore cache but could not be read —
   * distinguishable from an EMPTY body, which is a real "nothing named".
   */
  issueBodyUnreadable?: boolean;
  /** Capped at 10 entries each; the counts above are the uncapped truth. */
  notes?: string[];
  warnings?: string[];
}
