/**
 * work-driver-plan-helpers — plan-quality helpers extracted from work-driver-plan.ts.
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { type PathCollision, findPathCollisions } from "./work-driver-plan-paths.ts";
import type { PlanQualityReason } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

export function planQualityEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_PLAN_QUALITY;
  return v !== "0" && v !== "false";
}

export function planQualityReason(
  workstreams: Record<string, { paths: string[] }>,
  findingsCount: number,
): PlanQualityReason | undefined {
  const ids = Object.keys(workstreams);
  if (findingsCount >= 3 && ids.length === 1) return "under-decomposed";
  if (ids.length > 0 && ids.some((id) => (workstreams[id]?.paths.length ?? 0) === 0))
    return "empty-paths";
  if (findPathCollisions(workstreams).length > 0) return "overlapping-paths";
  return undefined;
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
    if (/^\s{2,}/.test(line)) continue;
    if (/^\s*(?:\d+[.)]\s+\S|[-*]\s+\[[ xX]\]\s*\S)/.test(line)) n += 1;
  }
  return n;
}
