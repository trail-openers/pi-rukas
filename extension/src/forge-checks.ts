/**
 * forge-checks — the CI-checks reads of the forge adapter.
 *
 * Split from `forge.ts` at the `// ── CI checks ──` seam (AGENTS.md §12) in the
 * shape `forge-label-ops.ts` and `forge-ci.ts` already take: a module that
 * receives the adapter's `run` seam and returns the methods the Forge object
 * spreads in, so the argv still goes through the one executor.
 *
 * Two shapes of the same question live here. `prChecks` answers "how is this
 * PR/MR doing" and must not answer "the pipeline I found" when it found
 * nothing; `glPipelineJobs` answers "the jobs of THIS pipeline, and which
 * commit they ran at" for lean's `ci` step, which refuses to grade a foreign
 * pipeline. They are separate members because the second one exists precisely
 * for the case the first one cannot express: `prChecks` picks the newest row of
 * the MR's pipelines list and keeps only the rows, so it can neither say which
 * commit those rows built nor be told which pipeline to read.
 */

import * as cmds from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import { mapGhChecks, mapGlPipelineJobs } from "./forge-mapping.ts";
import { glPipelineJobs, glPipelineJobsAt } from "./forge-pipeline.ts";
import type { ForgeRun } from "./forge-pipeline.ts";
import type { NormalizedCICheck } from "./forge-types.ts";

/** The adapter seam these checks need — the `run` the Forge object closes over. */
export interface ForgeChecksDeps {
  forge: ForgeType;
  run: ForgeRun;
}

/** The CI-checks methods, built once and spread into the Forge object. */
export function forgeChecks(deps: ForgeChecksDeps) {
  const { forge, run } = deps;
  return {
    prChecks: async (number: number): Promise<NormalizedCICheck[]> => {
      if (forge === "github") {
        return run(cmds.prChecksCmd(forge, number), (stdout) => {
          const parsed = JSON.parse(stdout || "[]");
          if (!Array.isArray(parsed)) throw new Error("forge: checks not an array");
          return mapGhChecks(parsed);
        });
      }
      // GitLab: list the MR's pipelines, take the most recent, list its jobs.
      // A list that ran past the page it read is reported as the empty set rather
      // than as the page it saw: a caller must never receive a partial job list it
      // could grade as complete, and every caller already refuses "no checks
      // reported" as the absence of evidence.
      const pipelines = await run(
        `glab api /projects/:id/merge_requests/${number}/pipelines`,
        (s) => {
          const parsed = JSON.parse(s || "[]");
          if (!Array.isArray(parsed)) throw new Error("forge: pipelines not an array");
          return parsed as Record<string, unknown>[];
        },
      );
      const latest = pipelines[0];
      if (!latest || typeof latest.id !== "number") return [];
      const read = await glPipelineJobs(run, latest.id);
      return read.truncated ? [] : read.rows;
    },

    // The job rows of ONE named pipeline, plus the commit that pipeline says it
    // built. `truncated` says the list ran past its page: the caller refuses
    // rather than grading an incomplete list.
    glPipelineJobs: (pipelineId: number) =>
      glPipelineJobsAt(run, pipelineId, cmds.pipelineViewCmd(pipelineId)),
  };
}
