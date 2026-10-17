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
import type { DispatchResult } from "./types.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import type { DriverHost } from "./work-driver-host.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
// #819 round-2 — the single-block rule lives in the prompt module so the
// planner prompt, this steer and the gate's evidence all quote one string.
import { PLAN_SINGLE_BLOCK_RULE } from "./work-driver-prompts-plan.ts";
// #849 — findDroppedDependencyEdges moved to work-driver-plan-deps.ts (the
// 500-line cap); re-exported so the importers keep their paths.
export { findDroppedDependencyEdges } from "./work-driver-plan-deps.ts";
// #754 — the plan-step timing trio + the corrective prompt builder moved to
// work-driver-plan-timeout.ts (the §12 line cap); re-exported so importers
// keep this module's path.
export {
  correctivePlanTimeoutSteer,
  planCorrectivePrompt,
  planDispatchTimeoutMs,
  planTimeoutCorrective,
  planTimeoutKill,
} from "./work-driver-plan-timeout.ts";
import type { PlanQualityReason } from "./workflow-state-schema.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

import {
  type PathCollision,
  findPathCollisions,
  findTestSubjectSplits,
  isPlainRepoRelativePath,
} from "./work-driver-plan-paths.ts";
// #819 — the plan-to-spec gate (an adjacent pure function, NOT a new branch
// in planQualityReason, which never sees the spec).
import type {
  PlanSpecMismatch,
  SpecCoverageSpec,
  SpecCoverageWorkstream,
} from "./work-driver-plan-spec-coverage.ts";
import { planSpecMismatchReason } from "./work-driver-plan-spec-coverage.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

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

/**
 * #819 — the plan-to-spec gate's verdict, shaped for `planQuality.reason`.
 *
 * Deliberately NOT a branch inside `planQualityReason`: that function is
 * called positionally as `(workstreams, findingsCount)` from four smoke
 * suites and never receives the spec, so threading a spec argument through it
 * would break every caller for no benefit — and it would let the new reason
 * reorder the existing eight, whose precedence is deliberate (a collision is a
 * fixable split; wrong work is not). This is the "adjacent pure function" the
 * issue names: pure over (reply text, workstreams, spec), no dispatch, no I/O.
 */
export function planSpecMismatchPlanQualityReason(
  text: string,
  workstreams: Record<string, SpecCoverageWorkstream>,
  spec: SpecCoverageSpec | undefined,
): PlanSpecMismatch | undefined {
  return planSpecMismatchReason(text, workstreams, spec);
}
/**
 * #819 — the halts both gate sites emit, factored out of `runPlan` so the
 * step handler stays inside its own budget. Same decision from two places: the
 * primary reply when the one-shot corrective budget is already spent, and the
 * corrective reply, which has no budget left to spend.
 *
 * `nextStep: "handoff"`, and NO commits, branch or worktree — the cap fires
 * before the branch step, which is the whole value of placing the gate there.
 *
 * #819 round-2 — the cap alone is not enough for the operator to see WHY this
 * cycle stopped at plan: `lastCapHit` is the only other reader of the gate's
 * verdict, and a state file whose `planQuality.reason` is absent reads as "the
 * shape gate passed, the cycle just happened to stop". So this writes BOTH the
 * cap-hit event and `pipelineState.planQuality.reason = "plan-spec-mismatch"`,
 * preserving whatever `findingsCount` / `redispatched` the step already
 * recorded.
 *
 * The persisted evidence is capped: this string is rendered verbatim into the
 * handoff (and an uncovered-deliverables verdict concatenates EVERY uncovered
 * deliverable with ALL its paths, so a 20-deliverable spec's evidence is
 * kilobytes). `recoveryStepsForCap` already clips the rendered line; capping
 * here keeps the state file — which the driver re-parses on every wake — small.
 */
export function planSpecMismatchCap(
  state: WorkState,
  mismatch: PlanSpecMismatch,
  whyNotReplanned: string,
): WorkState {
  trace(`work-driver: plan to-spec gate — ${mismatch.kind}, halting before branch`);
  const evidence = `${mismatch.evidence} — ${whyNotReplanned}`.slice(0, 500);
  const withReason: WorkState = {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      planQuality: {
        findingsCount: state.pipelineState.planQuality?.findingsCount ?? 0,
        redispatched: state.pipelineState.planQuality?.redispatched ?? false,
        ...(state.pipelineState.planQuality?.droppedEdges
          ? { droppedEdges: state.pipelineState.planQuality.droppedEdges }
          : {}),
        reason: "plan-spec-mismatch",
      },
    },
  };
  return appendEvent(withReason, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "plan-spec-mismatch",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence,
  });
}

export function planQualityReason(
  workstreams: Record<string, PlanQualityWorkstream>,
  findingsCount: number,
): PlanQualityReason | undefined {
  const ids = Object.keys(workstreams);
  // #1005 — the findings-count rule for a single workstream is gone: the
  // driver no longer steers the planner toward MORE workstreams (the split
  // pressure is what put coupled halves — a type change and its consumers —
  // in separate worktrees that could not each pass the quality gates), and a
  // findings count is not evidence about file-set independence. The rule that
  // actually protects the per-workstream invariant, `overlapping-paths` below,
  // catches the coupled halves the count rule was a proxy for. The
  // `under-decomposed` literal + steer remain for the empty-paths precedence
  // shape: a single workstream with an EMPTY paths list cannot be judged by
  // file-set comparison, and the count is the only signal left for that shape.
  // A non-empty single workstream never fires it.
  if (
    findingsCount >= 3 &&
    ids.length === 1 &&
    ids.every((id) => (workstreams[id]?.paths.length ?? 0) === 0)
  ) {
    return "under-decomposed";
  }
  if (ids.length > 0 && ids.some((id) => (workstreams[id]?.paths.length ?? 0) === 0))
    return "empty-paths";
  // #1005 — path shape validation: a declared path must be a plain
  // repo-relative path. A shell metacharacter inside a path is not merely
  // an aesthetic defect: the plan-time coupling merge's rule-3 grep
  // builds a shell command out of these paths, and a `$(…)` / backtick /
  // `;` inside one would execute in that shell (H1). A `..`-traversing or
  // absolute path is a scope the fence and the consolidation checks cannot
  // verify (they compare these strings as-is). The check runs on the
  // NORMALISED path (trailing-parenthetical annotations stripped — real
  // state files carry "src/foo.ts (new)" shapes, which are prose, not
  // shell): a legitimate annotation never trips the rule.
  if (
    ids.some((id) =>
      (workstreams[id]?.paths ?? []).some(
        (p) => !isPlainRepoRelativePath(normaliseDeclaredPath(p) ?? p),
      ),
    )
  )
    return "invalid-path";
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
  // #819 — the plan-to-spec steer names WHAT is missing rather than how to
  // split, because this reason's whole point is that the corrective must not
  // re-decide what gets built. On #818 the corrective was steered by "map each
  // finding to its own workstream" and came back with a decomposition of a
  // different problem entirely.
  if (reason === "plan-spec-mismatch") {
    return [
      "## Corrective re-dispatch",
      "",
      "Your previous plan left at least one deliverable with no workstream declaring any of its",
      "paths, and/or declared files that belong to none of this issue's deliverables:",
      "",
      "Re-plan against the spec in front of you, and ONLY the spec. Every workstream's `- paths:`",
      "entry must be a file this issue's deliverables actually name, and every deliverable that",
      "declares paths must be declared by at least one workstream. Do NOT invent new work — a file",
      "that reaches your context through prior-context prose, a memory row, or another issue's",
      "history is not a deliverable. Do NOT change WHAT is built: re-splitting is the only thing",
      "this re-dispatch is for.",
      PLAN_SINGLE_BLOCK_RULE,
    ].join("\n");
  }
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
      "",
      "#849 — dependencies survive the re-plan: where one workstream CONSUMES an artifact another",
      "workstream CREATES (a function, a type, a migration, a config value), keep the `- depends-on:`",
      "line (or ADD one) so the develop step defers the consumer's worktree until the creator commits —",
      "two parallel developers editing around a not-yet-created artifact is the #814 shape that",
      "duplicated a migration at commit-pr. And where BOTH workstreams would CREATE the same artifact",
      "(the shared file above), MERGE them into one workstream rather than splitting ownership:",
      "merging is what the overlap fix is for; preserving the file boundary and dropping the dependency",
      "edge leaves the two halves semantically coupled but structurally independent, which is the",
      "worse outcome of the two.",
    ].join("\n");
  }
  if (reason === "invalid-path") {
    return [
      "## Corrective re-dispatch",
      "",
      "Your previous plan declared a path that is not a plain repo-relative path (it contains a",
      "shell metacharacter, starts with `/`, or has a `..` segment). Every declared path must be a",
      "plain repo-relative path (e.g. `src/foo.ts` or `src/foo`) — no shell metacharacters, no",
      "absolute paths, no `..` traversal. Re-plan with every `paths:` entry as a plain",
      "repo-relative path.",
    ].join("\n");
  }
  // #849 — dropped-dependencies is a RECORDED reason, not a re-dispatch
  // trigger: the one-shot corrective has ALREADY run (it is what dropped
  // the edge), and there is no second re-dispatch per #754's one-shot rule.
  // The steer body below is unreachable by construction — it exists only so
  // this reason never falls through to the empty-paths prose if a future
  // bug re-dispatches on it.
  if (reason === "dropped-dependencies") {
    return [
      "## Corrective re-dispatch (not issued)",
      "",
      "Record-only: the previous corrective re-plan dropped a `- depends-on:` edge the",
      "first plan had. The cycle continues with the corrective plan — this reason is",
      "recorded on pipelineState.planQuality so the operator can see the drop; it is",
      "never re-dispatched.",
    ].join("\n");
  }
  if (reason === "under-decomposed") {
    return [
      "## Corrective re-dispatch",
      "",
      `Your previous plan produced ${workstreamCount} workstream(s) for an issue body containing ${findingsCount} enumerated findings, and the workstream(s) declared no paths.`,
      "Re-plan: give every workstream a non-empty `paths:` and list anything you are deliberately not doing under `Deferred:`. Do NOT split work just to raise the workstream count — workstreams that share a file or a compile/runtime dependency are ONE workstream (the consumer cannot build without the producer's commit); only genuinely independent file sets get their own workstream.",
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

export async function countFindingsForCycle(ctx: CycleContext, state: WorkState): Promise<number> {
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
