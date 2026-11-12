/**
 * forge-pipeline — the GitLab pipeline-job reads of the forge adapter.
 *
 * GitLab has no per-PR checks endpoint: a pipeline's jobs are read by id, and the
 * two ways the adapter gets to a pipeline must not disagree about the argv they
 * use. `prChecks` reaches one through the MR's pipelines LIST and keeps only the
 * rows; lean's `ci` step reaches the one the MR reply itself named and needs the
 * commit it built as well, because rows graded off a tag or schedule pipeline are
 * a verdict about a commit nobody is merging. Both forms live here so the command
 * string exists once.
 */
import { mapGlPipelineJobs } from "./forge-mapping.ts";
import type { NormalizedCICheck } from "./forge-types.ts";

/** Run one forge command and map its stdout. The adapter's own `run`. */
export type ForgeRun = <T>(cmd: string, map: (stdout: string) => T) => Promise<T>;

/** `glab api` for one pipeline's job rows. */
const pipelineJobsCmd = (pipelineId: number): string =>
  `glab api /projects/:id/pipelines/${String(pipelineId)}/jobs --output json`;

/** The job rows of one GitLab pipeline, in the adapter's normalized shape. */
export function glPipelineJobs(run: ForgeRun, pipelineId: number): Promise<NormalizedCICheck[]> {
  return run(pipelineJobsCmd(pipelineId), (stdout) => {
    const parsed = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) throw new Error("forge: jobs not an array");
    return mapGlPipelineJobs(parsed);
  });
}

/**
 * One pipeline's job rows plus the commit the pipeline reports it built — the
 * evidence a caller needs to say the rows it graded are the head's. The jobs list
 * itself does not carry a `sha`, which is why this is a second read and not a
 * field of {@link glPipelineJobs}.
 */
export async function glPipelineJobsAt(
  run: ForgeRun,
  pipelineId: number,
  viewCmd: string,
): Promise<{ rows: NormalizedCICheck[]; pipelineSha: string | undefined }> {
  const pipeline = await run(viewCmd, (stdout) => {
    return JSON.parse(stdout || "{}") as Record<string, unknown>;
  });
  const sha = pipeline.sha;
  return {
    rows: await glPipelineJobs(run, pipelineId),
    pipelineSha: typeof sha === "string" ? sha : undefined,
  };
}
