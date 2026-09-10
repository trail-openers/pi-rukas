/**
 * work-driver-plan-helpers — plan-quality helpers extracted from work-driver-plan.ts.
 *
 * #679 — the CANONICAL `planQualityReason`, `countEnumeratedFindings`, and
 * the corrective steer builders live here. work-driver-plan.ts re-exports
 * them so the existing importers (runPlan's call site, the smoke tests)
 * keep their paths unchanged. The stale duplicate that used to sit in
 * work-driver-plan.ts (missing the test-subject-split branch, diverging
 * from this copy) was deleted — one function, one module, so the two
 * cannot drift again.
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  type PathCollision,
  findPathCollisions,
  findTestSubjectSplits,
} from "./work-driver-plan-paths.ts";
import type { PlanQualityReason } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * #679 — the workstream shape the plan-quality rules inspect.
 * Superset of `{ paths: string[] }`: the new #679 rules (case 2(a)/3)
 * key off `dependsOn` / `integrationTest`, which the older rules ignore.
 */
export interface PlanQualityWorkstream {
  paths: string[];
  dependsOn?: string[];
  integrationTest?: string;
}

export function planQualityEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_PLAN_QUALITY;
  return v !== "0" && v !== "false";
}

export function planQualityReason(
  workstreams: Record<string, PlanQualityWorkstream>,
  findingsCount: number,
): PlanQualityReason | undefined {
  const ids = Object.keys(workstreams);
  if (findingsCount >= 3 && ids.length === 1) return "under-decomposed";
  if (ids.length > 0 && ids.some((id) => (workstreams[id]?.paths.length ?? 0) === 0))
    return "empty-paths";
  if (findPathCollisions(workstreams).length > 0) return "overlapping-paths";
  // #679 case 2(a) — a self `depends-on` (a workstream declaring itself as
  // its own dependency) is an INVALID reference, not a cycle: cycle
  // detection operates on the graph, a single self-edge is a malformed
  // declaration.
  if (ids.some((id) => (workstreams[id]?.dependsOn ?? []).includes(id)))
    return "invalid-dependency";
  // #679 case 2(a) — a `depends-on` reference to a workstream id the plan
  // did not declare (including an id folded away by the MAX_WORKSTREAMS
  // ceiling) has nothing to defer the referencing worktree against.
  if (ids.some((id) => (workstreams[id]?.dependsOn ?? []).some((d) => !workstreams[d])))
    return "invalid-dependency";
  if (hasDependencyCycle(workstreams)) return "circular-dependency";
  // Pre-existing rule (was in the plan.ts copy before #679; moved here so
  // this module is the single source of truth for all 7 reasons). This runs
  // BEFORE the case-3 check because it is the more specific diagnosis: a
  // test-subject split (one workstream's test file exercises another's file)
  // is always a decomposition error that must be fixed by moving the test
  // into the subject's workstream — an integration-test line does NOT fix
  // it, so the case-3 rule must not absorb it.
  if (findTestSubjectSplits(workstreams).length > 0) return "test-subject-split";
  // #679 case 3 — interdependent workstreams (via DIFFERENT-FILE
  // relationships only: an explicit depends-on with a disjoint file set) must
  // declare an integration test. Deliberately disjoint from overlapping-paths
  // (same file) and test-subject-split (inferred test coupling, which is
  // handled above and cannot be fixed by an integration-test line).
  if (interdependentWithoutIntegrationTest(workstreams))
    return "interdependent-no-integration-test";
  return undefined;
}

/**
 * #679 case 2(a) — does the depends-on graph contain a cycle? Direct
 * (A→B→A) or transitive (A→B→C→A). DFS with a per-visit on-stack marker;
 * `invalid-dependency` already filtered out dangling references upstream, so
 * every `dependsOn` target here resolves to a real workstream.
 */
export function hasDependencyCycle(workstreams: Record<string, PlanQualityWorkstream>): boolean {
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const cur = state.get(id);
    if (cur === "visiting") return true;
    if (cur === "done") return false;
    state.set(id, "visiting");
    for (const dep of workstreams[id]?.dependsOn ?? []) {
      if (visit(dep)) return true;
    }
    state.set(id, "done");
    return false;
  };
  return Object.keys(workstreams).some((id) => visit(id));
}

/**
 * #679 case 3 — workstreams interdependent via DIFFERENT-FILE relationships
 * (an explicit depends-on, or a test-subject split) where NO workstream in
 * the plan declares a `- integration-test: <path>` line. The corrective
 * steer then names the offending pair and the required line, and the
 * re-dispatch is the existing one-shot pattern.
 *
 * Deliberately NOT a pairwise "does this specific pair have an integration
 * test" check: `integrationTest` lives on ONE workstream's shape (the
 * dependent's, per the spec), and a plan can only ever be re-dispatched
 * once. If the plan declares an integration test anywhere, the pair it
 * covers is the planner's call — the gate's job is to require the DECLARATION
 * exists, not to audit which pair it belongs to.
 */
export function interdependentWithoutIntegrationTest(
  workstreams: Record<string, PlanQualityWorkstream>,
): boolean {
  const anyDeclared = Object.values(workstreams).some(
    (ws) => (ws.integrationTest ?? "").trim().length > 0,
  );
  if (anyDeclared) return false;
  // Explicit depends-on between different-file workstreams. (The inferred
  // test-subject-split case is handled by the earlier, more specific
  // test-subject-split rule in planQualityReason — an integration-test line
  // does not fix a test/subject split, so that rule runs first.)
  for (const ws of Object.values(workstreams)) {
    for (const dep of ws.dependsOn ?? []) {
      const depWs = workstreams[dep];
      if (!depWs) continue;
      const shared = ws.paths.some((p) => depWs.paths.includes(p));
      if (!shared) return true;
    }
  }
  return false;
}

export function correctivePlanSteer(
  reason: PlanQualityReason,
  findingsCount: number,
  workstreamCount: number,
  collisions: PathCollision[] = [],
): string {
  if (reason === "overlapping-paths") {
    return [
      "## Corrective re-dispatch",
      "",
      "Two workstreams in your previous plan declared the same file:",
      ...collisions.map((c) => `- \`${c.a}\` and \`${c.b}\` both claim ${c.path}`),
      "",
      "Each workstream gets its own worktree and its own developer, running in parallel, so two",
      "workstreams sharing a file means two developers editing it at once — which surfaces later as a",
      "merge conflict the driver cannot resolve. Re-plan so every file belongs to exactly ONE workstream:",
      "either move the shared file into whichever workstream genuinely owns it, or merge the two",
      "workstreams if they cannot be separated.",
    ].join("\n");
  }
  if (reason === "under-decomposed") {
    return [
      "## Corrective re-dispatch",
      "",
      `Your previous plan produced ${workstreamCount} workstream(s) for an issue body containing ${findingsCount} enumerated findings.`,
      "That is under-decomposed. Two findings share a workstream ONLY when they require edits to THE SAME FILES —",
      "conceptual relatedness is not a reason. Re-plan: map each finding to its own workstream unless the file sets",
      "genuinely overlap, and list anything you are deliberately not doing under `Deferred:`.",
    ].join("\n");
  }
  if (reason === "invalid-dependency") {
    return [
      "## Corrective re-dispatch",
      "",
      "Your previous plan declared a `- depends-on: <id>` line that references a workstream id the plan",
      "did not declare — either a non-existent id, or the workstream referencing ITSELF.",
      "A `depends-on` reference is load-bearing: the develop step defers the referencing workstream's",
      "worktree until the referenced one commits, so a dangling reference has nothing to wait on.",
      "Re-plan: every `- depends-on: <id>` must name a `### <id>` workstream declared in the same plan,",
      "and no workstream may declare itself as its own dependency.",
    ].join("\n");
  }
  if (reason === "circular-dependency") {
    return [
      "## Corrective re-dispatch",
      "",
      "Your previous plan's `- depends-on:` declarations form a cycle (e.g. A depends on B and B on A,",
      "or A→B→C→A transitively). A cycle has no topological order: the develop step would wait on a",
      "workstream that is itself waiting, and the dispatch could never start.",
      "Re-plan: the depends-on graph must be a DAG — if two workstreams genuinely need each other's",
      "output, they are not independently decomposable and should be merged into one workstream.",
    ].join("\n");
  }
  if (reason === "interdependent-no-integration-test") {
    return [
      "## Corrective re-dispatch",
      "",
      "Your previous plan has two workstreams that are interdependent through DIFFERENT files — one",
      "declares `- depends-on: <other>` (or one's test file exercises the other's file) — but no",
      "workstream declares a `- integration-test: <path>` line naming a consolidated-tree test that",
      "exercises both halves together. Each workstream passes its own develop gate in isolation; without",
      "a declared integration test, the combined behaviour is verified nowhere in the cycle.",
      "Re-plan: on the DEPENDENT workstream (the one declaring `depends-on`, or either in the inferred",
      "coupling case) add `- integration-test: <path>` naming the consolidated-tree test.",
      "Scope note: the line is a plan-quality DECLARATION only — the develop step does not execute it;",
      "executing the declared integration test is a separate concern (issue #669's territory).",
    ].join("\n");
  }
  return [
    "## Corrective re-dispatch",
    "",
    "At least one workstream in your previous plan declared no `paths:`.",
    "Every workstream MUST list the files it will touch — the driver uses that list to verify the committed diff",
    "actually contains each workstream's slice, and an empty list silently disables that check.",
    "Re-plan with a non-empty `paths:` and `out-of-scope:` for every workstream.",
  ].join("\n");
}

export function correctiveTestSubjectSplitSteer(
  splits: { test: string; testPath: string; subjectPath: string; subject: string }[],
): string {
  const pairs =
    splits.length > 0
      ? splits.map(
          (s) =>
            `- \`${s.test}\` declared test \`${s.testPath}\`, which exercises \`${s.subjectPath}\` owned by \`${s.subject}\``,
        )
      : [];
  return [
    "## Corrective re-dispatch",
    "",
    "Your previous plan separated a test from the file it exercises:",
    ...(pairs.length > 0
      ? [...pairs, ""]
      : [
          "The plan has a workstream that is only test file(s) whose subject(s) live in another workstream.",
          "",
        ]),
    "Each workstream gets its own worktree and its own developer, so a test and its subject in",
    "different worktrees can never meet: each workstream passes its own develop gate against its own",
    "tree, and the consolidated verify fails at commit-pr for the same reason the test was split.",
    "Re-plan so every test stays in the SAME workstream as the file it exercises. A workstream that is",
    "only test file(s) has no legitimate reading — move the test to its subject's workstream, or make",
    "the test file's subject part of the same workstream.",
  ].join("\n");
}

export async function countFindingsForCycle(ctx: DriverContext, state: WorkState): Promise<number> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!artifact) return 0;
  try {
    return countEnumeratedFindings(await fs.readFile(artifact, "utf8"));
  } catch (err) {
    trace(
      `work-driver: plan quality could not read issue body artifact: ${(err as Error).message?.slice(0, 120)}`,
    );
    return 0;
  }
}

export function countEnumeratedFindings(body: string): number {
  let n = 0;
  for (const line of body.split("\n")) {
    if (/^\s{2,}/.test(line)) continue; // indented → sub-point of a finding
    if (/^\s*(?:\d+[.)]\s+\S|[-*]\s+\[[ xX]\]\s*\S)/.test(line)) n += 1;
  }
  return n;
}
