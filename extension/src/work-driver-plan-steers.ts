/**
 * work-driver-plan-steers — #1167 (size split): the corrective re-dispatch
 * steers, split out of work-driver-plan-helpers.ts for the AGENTS.md §12
 * 500-line cap.
 *
 * One function per plan-quality reason, and the exhaustive `if` chain is the
 * contract: a reason with no branch here silently inherits the empty-paths
 * prose at the bottom and steers the planner at the wrong defect. That is why
 * `test-plan-overlapping-paths.ts` and `test-plan-test-subject-coupling.ts`
 * iterate EVERY `PlanQualityReason` rather than a sample — the compiler cannot
 * catch a missing branch in an `if` chain that ends in a default.
 *
 * Re-exported from work-driver-plan-helpers.ts so importers keep their paths.
 */

import { neutraliseFenceEntry } from "./plan-workstream-schema.ts";
import type { RefusedWorkstreamCall } from "./work-driver-plan-calls.ts";
import type { PathCollision } from "./work-driver-plan-paths.ts";
import type { FenceContradiction } from "./work-driver-plan-paths.ts";
import { PLAN_WORKSTREAM_CALL_RULE } from "./work-driver-prompts-plan.ts";
import type { PlanQualityReason } from "./workflow-state-schema.ts";

export function correctivePlanSteer(
  reason: PlanQualityReason,
  findingsCount: number,
  workstreamCount: number,
  collisions: PathCollision[] = [],
  fenceContradictions: FenceContradiction[] = [],
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
      PLAN_WORKSTREAM_CALL_RULE,
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
  if (reason === "contradictory-fence") {
    return [
      "## Corrective re-dispatch",
      "",
      "A workstream in your previous plan fenced a file it also declared as its own:",
      ...(fenceContradictions.length > 0
        ? fenceContradictions.map(
            (f) =>
              `- \`${f.workstream}\` lists \`${f.path}\` in its paths and \`${f.entry}\` in its out-of-scope`,
          )
        : [
            "- at least one workstream's `out-of-scope:` line names a file its own `paths:` line declares.",
          ]),
      "",
      "That is a contradiction, not a boundary: the develop scope gate reads the fence literally and parks",
      "the correct change with `declared fence violated`, so the work has to be finished by hand. Remove",
      "the entry from `out-of-scope:` for a file the workstream genuinely owns, or remove it from `paths:`",
      "for a file it genuinely must not touch — and if a sibling owns it, declare it in exactly ONE",
      "workstream's `paths:` so the cross-declaration contract puts the fence in the right place.",
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
  // trigger: the one-shot corrective has ALREADY run (it is what dropped the
  // edge), and there is no second re-dispatch per #754's one-shot rule.
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
  splits: {
    test: string;
    testPath: string;
    subjectPath: string;
    subject: string;
  }[],
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

/**
 * #1652 — the corrective for a plan dispatch that made no accepted
 * `report_workstream` call. The driver has no plan at all, so the steer is
 * about the channel, not the decomposition: re-plan, and report through the
 * tool. Refusal reasons are repeated so the planner can see why its calls
 * failed.
 */
export function correctiveNoWorkstreamCallsSteer(refused: RefusedWorkstreamCall[]): string {
  return [
    "## Corrective re-dispatch",
    "",
    refused.length === 0
      ? "Your previous reply made NO `report_workstream` tool call, so the driver has no plan."
      : `Your previous reply's \`report_workstream\` calls were ALL refused (${refused.length}), so the driver has no plan:`,
    // Both fields are the planner's text (an id it chose, a reason that may echo
    // its own call), so they are neutralised before they reach the prompt.
    ...refused.map(
      (r) =>
        `- ${r.id ? `\`${neutraliseFenceEntry(r.id)}\`: ` : ""}${neutraliseFenceEntry(r.reason)}`,
    ),
    "",
    "Re-plan the SAME work against the issue, and report every workstream through one",
    "`report_workstream` call each. Prose and markdown sections are not read for workstreams.",
    PLAN_WORKSTREAM_CALL_RULE,
  ].join("\n");
}
