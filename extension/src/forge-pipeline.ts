/**
 * forge-pipeline — the GitLab pipeline-job reads of the forge adapter.
 *
 * GitLab has no per-PR checks endpoint: a pipeline's jobs are read by id, and the
 * two ways the adapter gets to a pipeline must not disagree about the argv they
 * use. `prChecks` reaches one through the MR's pipelines LIST and keeps only the
 * rows; lean's `ci` step reaches the one the MR reply itself named and needs the
 * commit it built as well, because rows graded off a tag or schedule pipeline are
 * a verdict about a commit nobody is merging. Both forms live here so the command
 * string exists once — and so the page size is asked for once too.
 *
 * The page size is load-bearing. `glab api` with no `per_page` answers GitLab's
 * default page of **20**, so a pipeline with more jobs than that had its 21st
 * graded by nobody: a failing job past the page was never read, and a caller that
 * graded "everything I saw" read it as green. So the read asks for a page of
 * {@link GL_JOBS_PAGE}, and a reply that FILLS the page is probed once for a
 * second one.
 *
 * The probe is the one read that answers a question about the LIST rather than
 * about a job, so its failure is the forge not answering — it throws, and the
 * caller decides what an unreadable page means — while a page that comes back with
 * rows means the list continued past what was read. That is reported as
 * `truncated`, never as the shorter list: a caller handed a partial list it could
 * grade as complete is exactly the false green the page size exists to prevent.
 */
import { mapGlPipelineJobs } from "./forge-mapping.ts";
import type { NormalizedCICheck } from "./forge-types.ts";

/** Run one forge command and map its stdout. The adapter's own `run`. */
export type ForgeRun = <T>(cmd: string, map: (stdout: string) => T) => Promise<T>;

/**
 * The page size every jobs read asks for. One number for the read and its probe,
 * because the probe is only meaningful while both pages are the same size: the
 * rule "a reply of exactly this many rows may be truncated" is the same rule the
 * command's own argv states.
 */
export const GL_JOBS_PAGE = 100;

/** The rows of one pipeline, and whether the list ran past the page that was read. */
export interface GlJobsRead {
  rows: NormalizedCICheck[];
  /** True when the page filled AND a second page had rows: the list continues,
   *  so `rows` is NOT the whole pipeline and must not be graded as if it were. */
  truncated: boolean;
}

/** `glab api` for one page of one pipeline's job rows. */
const pipelineJobsCmd = (pipelineId: number, page: number): string =>
  `glab api "/projects/:id/pipelines/${String(pipelineId)}/jobs?per_page=${String(GL_JOBS_PAGE)}&page=${String(page)}" --output json`;

/** One jobs page, mapped. A reply that is not a list is the forge's fault. */
const jobsPage = async (
  run: ForgeRun,
  pipelineId: number,
  page: number,
): Promise<NormalizedCICheck[]> =>
  run(pipelineJobsCmd(pipelineId, page), (stdout) => {
    const parsed = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) throw new Error("forge: jobs not an array");
    return mapGlPipelineJobs(parsed);
  });

/**
 * The job rows of one GitLab pipeline, in the adapter's normalized shape, and
 * whether they are the whole list. A short page is complete by its own row count;
 * a full page earns exactly one probe, and rows beyond it mean `truncated`.
 */
export async function glPipelineJobs(run: ForgeRun, pipelineId: number): Promise<GlJobsRead> {
  const rows = await jobsPage(run, pipelineId, 1);
  if (rows.length < GL_JOBS_PAGE) return { rows, truncated: false };
  const more = await jobsPage(run, pipelineId, 2);
  return { rows, truncated: more.length > 0 };
}

/**
 * One pipeline's job rows plus the commit the pipeline reports it built — the
 * evidence a caller needs to say the rows it graded are the head's. The jobs list
 * itself does not carry a `sha`, which is why this is a second read and not a
 * field of {@link glPipelineJobs}. `truncated` is {@link GlJobsRead.truncated}.
 */
export async function glPipelineJobsAt(
  run: ForgeRun,
  pipelineId: number,
  viewCmd: string,
): Promise<GlJobsRead & { pipelineSha: string | undefined }> {
  const pipeline = await run(viewCmd, (stdout) => {
    return JSON.parse(stdout || "{}") as Record<string, unknown>;
  });
  const sha = pipeline.sha;
  const read = await glPipelineJobs(run, pipelineId);
  return {
    rows: read.rows,
    truncated: read.truncated,
    pipelineSha: typeof sha === "string" ? sha : undefined,
  };
}
