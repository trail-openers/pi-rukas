/**
 * lean/ci-forge-gl — one moment's read of a GitLab merge request, for `ci`.
 *
 * GitHub's `gh pr view` hands over `mergeStateStatus` and `headRefOid` from ONE
 * command. GitLab has no such field: readiness is COMPOSED from
 * `detailed_merge_status` plus three cross-checks, and the normalized MR carries no
 * commit oid at all (`mapGlMr` hardcodes `mergeStateStatus: null`). The step cannot
 * ask both forges the same question, so this module shapes the GitLab answer into the
 * verdict `ci.ts` already knows how to route.
 *
 * Four rules the shape is built on:
 *
 *   1. **One moment.** Readiness and head come from the SAME
 *      `glab api /projects/:id/merge_requests/:iid` reply — the only reply carrying
 *      both the composition fields and `diff_refs.head_sha`. A green is never a
 *      composition about one commit with a head from another. The pipeline jobs are
 *      the second read, made ONCE per poll.
 *   2. **A forge fault is never a verdict.** An unreadable read, an absent readiness
 *      field (`ForgeFieldError`), or a head that is not a full 40-hex sha all THROW.
 *      A red spends a build round on the code; none of these are about the code.
 *   3. **A gate that cannot fail is not green.** Job states are graded by
 *      `gradeGlJobState` in `../forge-gl-grade.ts`, the one table saying what a
 *      GitLab job state means. GitLab rows carry no `bucket`, so gh's bucket-first
 *      grading cannot reach them.
 *   4. **The jobs are the head's jobs, and all the jobs there are.** The adapter's
 *      `prChecks` reaches a pipeline through the MR's pipelines LIST, so on a project
 *      that runs tag- or schedule-pipelines its rows can belong to another commit.
 *      The step reads the jobs of the pipeline **the MR reply itself named** and keeps
 *      them only when that pipeline reports the head as its own commit. A list known
 *      to continue is refused, not graded.
 *
 * Both reads are the ADAPTER's (`mergeReadiness`, `glPipelineJobs`), so their argv and
 * the composition stay the adapter's; the MR reply the head and pipeline id come from
 * is handed back by `lastMrRow` — the only way the raw fields the normalized shape
 * drops reach a caller without a second read of a moving MR.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { gradeGlJobState } from "../forge-gl-grade.ts";
import { GL_JOBS_PAGE } from "../forge-pipeline.ts";
import type { MergeReadiness, NormalizedCICheck } from "../forge-types.ts";
import { VerifyInfraError } from "./verify-types.ts";

/** One poll's read of the MR: the composed verdict, the head, and the rows. */
export interface GlRead {
  /** The composed merge readiness — GitLab's answer to `mergeStateStatus`. */
  mergeStateStatus: MergeReadiness;
  /** `diff_refs.head_sha` verbatim, or `undefined` when the read gave none. */
  prHead: string | undefined;
  /** The pipeline's job rows, or `undefined` when the reply was not a list. */
  rows: NormalizedCICheck[] | undefined;
}

/**
 * What `ci` asks the forge for, per GitLab verdict — a structural subset of `Forge`,
 * declared here so the lean step keeps its import graph off the adapter's executor and
 * public-text-check graph. `lastMrRow` hands back the raw MR reply the most recent
 * readiness read consumed, the head's and pipeline's only source; it is REQUIRED
 * because a forge that cannot hand back the reply its verdict was composed from cannot
 * say what commit it graded.
 */
export type GlForge = {
  mergeReadiness(number: number): Promise<{
    ok: boolean;
    readiness?: MergeReadiness;
    reason?: string;
  }>;
  /** The MR reply the most recent `mergeReadiness` consumed, or `undefined` when
   *  this adapter never read that number. */
  lastMrRow(number: number): unknown;
  /**
   * The GitLab job rows of one pipeline, in the adapter's normalized shape, plus the
   * commit the pipeline row itself reported. Optional: only the GitLab adapter
   * implements it, and `readForge` asks for it only on that arm.
   *
   * This is the head pin's evidence AND the poll's single jobs read: the step grades
   * these rows and nothing else. `pipelineSha` is `undefined` when the pipeline named
   * no commit; `rows` is `undefined` when the list ran past the page asked for — a
   * refusal rather than a short list.
   */
  glPipelineJobs?(pipelineId: number): Promise<{
    rows: NormalizedCICheck[];
    /** True when the jobs list ran past the page the read asked for: the rows
     *  graded are not the whole pipeline (see `GlJobsRead`, `forge-pipeline.ts`). */
    truncated: boolean;
    pipelineSha: string | undefined;
  }>;
};

/**
 * The MR's head, from `diff_refs.head_sha`. A missing value is an absent field
 * and a malformed one is a different fault, so each names itself rather than
 * both reading as blank; either way the step throws — a green about an unnamed
 * commit is no evidence about this one.
 */
function headFromMr(mr: unknown): string | undefined {
  const refs = (mr as { diff_refs?: unknown } | null | undefined)?.diff_refs;
  if (refs === undefined || refs === null) return undefined;
  const sha = (refs as Record<string, unknown>).head_sha;
  if (sha === undefined || sha === null) return undefined;
  if (typeof sha !== "string" || !isFullCommitSha(sha)) {
    const shown = typeof sha === "string" ? sha.slice(0, 40) : typeof sha;
    throw new VerifyInfraError(
      `could not read the MR head: diff_refs.head_sha is "${shown}", not a full 40-char commit SHA`,
    );
  }
  return sha;
}

/**
 * The pipeline the readiness was made from, out of the SAME MR reply:
 * `head_pipeline` when GitLab named one, else `open_pipeline` — the embedded rows
 * that carry both an `id` and a `sha`.
 */
function mrPipelineRow(
  mr: Record<string, unknown> | undefined,
): { id?: number; sha?: string } | undefined {
  if (mr === undefined) return undefined;
  for (const field of ["head_pipeline", "open_pipeline"] as const) {
    const row = mr[field];
    if (row !== null && typeof row === "object") return row as { id?: number; sha?: string };
  }
  return undefined;
}

/**
 * The job rows of the pipeline the MR reply named, and the commit that pipeline
 * reported for itself — the head pin's two pieces of evidence, both from the
 * adapter's own argv, and the ONE jobs read this poll makes.
 *
 * The `/pipelines/:id` row carries `sha`, the commit the jobs actually built (the
 * jobs list itself carries none). Absent or malformed, the pipeline says nothing
 * about which rows are the head's, and absence is never a pass: the caller gets
 * `undefined` and refuses to grade.
 */
async function pipelineJobs(
  forge: GlForge,
  pipelineId: number,
): Promise<{ rows: NormalizedCICheck[]; truncated: boolean; pipelineSha: string | undefined }> {
  if (forge.glPipelineJobs === undefined)
    throw new VerifyInfraError(
      "this forge adapter cannot report which commit a pipeline's jobs were built at, so ci cannot say the rows it read are the head's",
    );
  const read = await Promise.resolve(forge.glPipelineJobs(pipelineId)).catch((err: unknown) => {
    throw new VerifyInfraError(
      `could not read the MR pipeline's jobs: ${String((err as Error)?.message ?? err)}`,
    );
  });
  const sha = read.pipelineSha;
  return {
    rows: Array.isArray(read.rows) ? read.rows : [],
    truncated: read.truncated === true,
    pipelineSha: typeof sha === "string" && isFullCommitSha(sha) ? sha : undefined,
  };
}

/**
 * One read of the MR and its pipeline.
 *
 * `mergeReadiness` runs first because it consumes the MR reply the head and pipeline id
 * are then taken from, and `lastMrRow` is read before anything else touches the MR: any
 * later read would cache a reply describing a commit the readiness never saw. Its
 * `ok: false` is an infrastructure throw rather than a red — an absent or unmapped
 * composition field is the forge not answering, nobody's verdict about the code.
 *
 * The rows then come from the pipeline **the readiness named**, in ONE read, kept only
 * when that pipeline reports the head as its own commit. `[]` — no pipeline, a head the
 * forge never named, or a pipeline that would not say its commit — is what `ci.ts`
 * already refuses as absent evidence, reached WITHOUT reading jobs. A truncated list is
 * the other refusal, and it throws: rows past the page could hold a failure nobody saw.
 */
export async function glRead(forge: GlForge, number: number): Promise<GlRead> {
  if (typeof forge.lastMrRow !== "function")
    throw new VerifyInfraError(
      "this forge adapter offers no way to read back the MR reply its readiness was composed from, so the commit the verdict is about cannot be named",
    );
  const readiness = await Promise.resolve(forge.mergeReadiness(number)).catch((err: unknown) => {
    throw new VerifyInfraError(
      `could not read the MR's merge readiness: ${String((err as Error)?.message ?? err)}`,
    );
  });
  if (!readiness.ok || readiness.readiness === undefined)
    throw new VerifyInfraError(
      `could not read the MR's merge readiness: ${readiness.reason ?? "no reason given"}`,
    );
  const mr = forge.lastMrRow(number) as Record<string, unknown> | undefined;
  const head = headFromMr(mr);
  const pipeline = mrPipelineRow(mr);
  // A head the forge never named, or a pipeline it never named, means there is
  // nothing to pin the rows to: the step reads NO jobs at all and `ci.ts` refuses
  // the absence as green. Asking the forge for rows nobody could attribute to a
  // commit would be a read that buys no evidence.
  if (pipeline === undefined || typeof pipeline.id !== "number" || head === undefined)
    return { mergeStateStatus: readiness.readiness, prHead: head, rows: [] };
  const jobs = await pipelineJobs(forge, pipeline.id);
  // The commit the pipeline says it built is asked for FIRST: rows nobody can
  // attribute to this head are not graded, whether or not the list was complete,
  // and a foreign pipeline must be refused on the same read either way.
  if (jobs.pipelineSha === undefined)
    return { mergeStateStatus: readiness.readiness, prHead: head, rows: [] };
  if (jobs.pipelineSha !== head)
    throw new VerifyInfraError(
      `the MR pipeline ${String(pipeline.id)} built ${jobs.pipelineSha.slice(0, 12)}, not the head ${head.slice(0, 12)} the readiness was read at: refusing to grade a pipeline about another commit`,
    );
  // And every job the head ran must have been read: a list that continued past
  // the page holds rows nobody graded, and a failing job among them is a false
  // green.
  if (jobs.truncated)
    throw new VerifyInfraError(
      `the MR pipeline ${String(pipeline.id)} has more jobs than one page of ${String(GL_JOBS_PAGE)}: its job list is truncated at the page boundary, so ci cannot read every job it ran and refuses to grade what it did not see`,
    );
  return { mergeStateStatus: readiness.readiness, prHead: head, rows: jobs.rows };
}

/** What to do with a row that is not a pass. `undefined` means the row passed. */
export type GlRowGrade = "pending" | "red" | "not-passing" | "unknown";

/**
 * One pipeline row's grade, from the shared GitLab table.
 *
 * The step's GitHub grading reads `bucket ?? state` and a GitLab job row has no bucket —
 * its only words are the uppercased `status` and the `blocking` flag the adapter carried
 * off `allow_failure`. The shared table decides here, in the step's own `RowGrade`
 * words, so a GitLab row travels the same wait/red/not-green arms as a gh row without a
 * second verdict list to keep in step. A row with no `blocking` is read as blocking:
 * absence is never the optimistic answer.
 */
export function glRowGrade(row: { state?: unknown; blocking?: unknown }): GlRowGrade | undefined {
  const blocking = typeof row.blocking === "boolean" ? row.blocking : true;
  const grade = gradeGlJobState(String(row.state ?? ""), blocking);
  if (grade === "pass") return undefined;
  if (grade === "fail") return "red";
  if (grade === "pending") return "pending";
  if (grade === "not-green") return "not-passing";
  return "unknown";
}
