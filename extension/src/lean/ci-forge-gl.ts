/**
 * lean/ci-forge-gl — one moment's read of a GitLab merge request, for `ci`.
 *
 * Lives beside `ci-deps.ts` rather than inside `ci.ts` for the §12 size cap, and
 * because the two forges answer different questions. GitHub's `gh pr view` hands
 * over `mergeStateStatus` and `headRefOid` from ONE command. GitLab has no such
 * field: readiness is COMPOSED from `detailed_merge_status` plus three
 * cross-checks, and the normalized MR carries no commit oid at all (`mapGlMr`
 * hardcodes `mergeStateStatus: null`). The step cannot ask both forges the same
 * question, so this module is where the GitLab answer is shaped into the verdict
 * `ci.ts` already knows how to route.
 *
 * Four rules the shape is built on:
 *
 *   1. **One moment.** Readiness and head come from the SAME
 *      `glab api /projects/:id/merge_requests/:iid` reply — the single read the
 *      adapter's readiness path runs, and the only reply carrying both the four
 *      composition fields and `diff_refs.head_sha`. A green is never a
 *      composition about one commit with a head taken from another. The pipeline
 *      jobs are the second read, exactly as `gh pr checks` is separate from the
 *      view read.
 *   2. **A forge fault is never a verdict.** An unreadable read, an absent
 *      readiness field (the composition's `ForgeFieldError`), or a head that is
 *      not a full 40-hex sha all THROW. A red spends a build round on the code;
 *      none of these are about the code.
 *   3. **A gate that cannot fail is not green.** Job states are graded by
 *      `gradeGlJobState` in `../forge-gl-grade.ts`, the one table that says what
 *      a GitLab job state means: a blocking job's `success` passes and nothing
 *      else does, `skipped`, `manual` and an `allow_failure: true` job are all
 *      refused, and a state the table has never seen waits rather than passing.
 *      GitLab rows carry no `bucket`, so gh's bucket-first grading cannot reach
 *      them, and `glRowGrade` is the one place this step asks the table.
 *   4. **The jobs are the head's jobs.** The adapter's `prChecks` reaches a
 *      pipeline through the MR's pipelines LIST and keeps only the job rows, so on
 *      a project that runs tag- or schedule pipelines its rows can belong to a
 *      different commit than the one the readiness was composed at — and a verdict
 *      about a foreign pipeline is a verdict about a commit nobody is merging. The
 *      step therefore reads the jobs of the pipeline **the MR reply itself named**,
 *      and keeps them only when that pipeline reports the head as its own commit.
 *
 * Both reads are the ADAPTER's (`mergeReadiness` and `glPipelineJobs`), so their
 * argv stays the adapter's pinned form and the composition stays the adapter's;
 * the MR reply the head and the pipeline id come from is handed back by
 * `lastMrRow`, the only way the raw fields the normalized shape drops can reach a
 * caller without a second read of a moving MR.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { gradeGlJobState } from "../forge-gl-grade.ts";
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
 * What `ci` asks the forge for, per GitLab verdict — a structural subset of
 * `Forge`, declared here rather than imported from `forge.ts` so the lean step
 * keeps its import graph off the adapter's executor and public-text-check
 * graph. `lastMrRow` hands back the raw MR reply the most recent readiness read
 * consumed, which is the head's and the pipeline's only source; it is REQUIRED
 * (not optional) because a forge that cannot hand back the reply its verdict was
 * composed from cannot be asked what commit it graded, and that is the adapter's
 * fault, not the MR's — so it says so in its own name rather than merging into
 * "the forge gave no head".
 */
export type GlForge = {
  mergeReadiness(number: number): Promise<{
    ok: boolean;
    readiness?: MergeReadiness;
    reason?: string;
  }>;
  prChecks(number: number): Promise<NormalizedCICheck[]>;
  /** The MR reply the most recent `mergeReadiness` consumed, or `undefined` when
   *  this adapter never read that number. */
  lastMrRow(number: number): unknown;
  /**
   * The GitLab job rows of one pipeline, in the adapter's normalized shape, plus
   * the commit the pipeline row itself reported. Optional: only the GitLab adapter
   * implements it, and the step's `readForge` asks for it only on that arm.
   *
   * This is the head pin's evidence. `prChecks` reaches the pipeline through
   * `/merge_requests/:iid/pipelines` and keeps only the job rows, so its caller
   * cannot say which commit they ran at; a project whose pipelines list leads with
   * a tag or schedule pipeline would otherwise have those rows graded as this MR's
   * verdict. `pipelineSha` is `undefined` when the pipeline named no commit.
   */
  glPipelineJobs?(pipelineId: number): Promise<{
    rows: NormalizedCICheck[];
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
 * adapter's own argv.
 *
 * `prChecks` reaches a pipeline through `/merge_requests/:iid/pipelines` and keeps
 * only the job rows, so its caller cannot say which commit they ran at. The
 * `/pipelines/:id` row GitLab answers with carries `sha`, and that is the commit
 * the jobs actually built. Absent or malformed, it says nothing — and absence is
 * never a pass, so the caller gets `undefined` and refuses to grade.
 */
async function pipelineJobs(
  forge: GlForge,
  pipelineId: number,
): Promise<{ rows: NormalizedCICheck[]; pipelineSha: string | undefined }> {
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
    pipelineSha: typeof sha === "string" && isFullCommitSha(sha) ? sha : undefined,
  };
}

/**
 * One read of the MR and its pipeline.
 *
 * `mergeReadiness` runs first because it is the read that consumes the MR reply
 * the head and the pipeline id are then taken from, and `lastMrRow` is read before
 * anything else touches the MR: `prChecks` re-issues the MR read of its own, so a
 * reply cached after it could describe a commit the readiness never saw. Its
 * `ok: false` is an infrastructure throw rather than a red: an absent or unmapped
 * composition field is the forge not answering, which is nobody's verdict about the
 * code.
 *
 * The rows then come from the pipeline **the readiness named**, not from the newest
 * row of the MR's pipelines list, and are kept only when that pipeline reports the
 * head as its own commit. `[]` — the MR with no pipeline at all, or one whose
 * commit the forge would not say — is what `ci.ts` already refuses as the absence
 * of evidence.
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
  if (pipeline === undefined || typeof pipeline.id !== "number")
    return { mergeStateStatus: readiness.readiness, prHead: head, rows: [] };
  const jobs = await pipelineJobs(forge, pipeline.id);
  if (jobs.pipelineSha === undefined || head === undefined)
    return { mergeStateStatus: readiness.readiness, prHead: head, rows: [] };
  if (jobs.pipelineSha !== head)
    throw new VerifyInfraError(
      `the MR pipeline ${String(pipeline.id)} built ${jobs.pipelineSha.slice(0, 12)}, not the head ${head.slice(0, 12)} the readiness was read at: refusing to grade a pipeline about another commit`,
    );
  return { mergeStateStatus: readiness.readiness, prHead: head, rows: jobs.rows };
}

/** What to do with a row that is not a pass. `undefined` means the row passed. */
export type GlRowGrade = "pending" | "red" | "not-passing" | "unknown";

/**
 * One pipeline row's grade, from the shared GitLab table.
 *
 * The step's GitHub grading reads `bucket ?? state` and a GitLab job row has no
 * bucket at all — its only words are the uppercased `status` and the `blocking`
 * flag the adapter's mapper carried off `allow_failure`. So the shared table
 * decides here, in the step's own `RowGrade` words, which is what lets a GitLab
 * row travel the same wait/red/not-green arms as a gh row without a second
 * verdict list to keep in step. A row that carries no `blocking` at all is read
 * as blocking: absence is never the optimistic answer.
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
