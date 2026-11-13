/**
 * forge-commands-gl-evidence — the three `glab api` reads the GitLab arm of the
 * merge-evidence gate is allowed to issue (#2226).
 *
 * Split from `forge-commands.ts` along the seam that file already had (the §12
 * size cap): the forge-wide builders stay there and these live beside the one
 * consumer that grades their answers. That proximity is the point — the shape of
 * each read and the verdict drawn from it are one decision, and the argv pins in
 * `test-gh-argv.ts` still name them individually.
 *
 * Pure builders, like every other in this family: the offline tests assert the
 * EXACT command string the production path executes.
 */

/**
 * The page size {@link mergeEvidenceGlJobsCmd} asks for, and the row count that
 * means "the page was full, so the list may continue". Exported so the argv pin
 * and the gatherer's truncation refusal quote one number rather than two that
 * can drift.
 */
export const GL_JOB_PAGE_SIZE = 100;

/**
 * #2226 — the GitLab twin of `mergeEvidenceViewCmd`: the ONE read that answers
 * both questions the evidence gate asks of an MR. `detailed_merge_status`
 * composes (with its three cross-check fields) into the readiness that
 * `mergeStateStatus` carries on GitHub, and `sha` / `diff_refs.head_sha` are the
 * head that verdict describes — so a head that moved between the readiness read
 * and the head read cannot be papered over by two calls that disagree.
 *
 * No field list: `glab api` answers with the MR's whole REST row, which is how
 * #745 happened on the gh side when a field set was invented here.
 */
export function mergeEvidenceGlMrCmd(number: number): string {
  return `glab api /projects/:id/merge_requests/${number}`;
}

/**
 * #2226 — the MR's pipelines, newest first. A pipeline-less MR is a CI verdict
 * ("no checks reported"), so the caller must be able to tell "the read answered
 * an empty list" from "the read never answered", which is why this is a read of
 * the list rather than the MR's `head_pipeline` field alone: the list is what
 * proves the named head pipeline belongs to this MR.
 *
 * `per_page=100` is load-bearing for the same reason it is on the jobs read:
 * the endpoint's own default is 20, and a first-page-only read cannot establish
 * what it is being used to prove. A merge-train MR, or one that has been
 * force-pushed on a busy project, accumulates more pipelines than that, and then
 * the row the MR designates as its head pipeline can sit beyond the rows the
 * read received — the gate would report the forge's own two rows as disagreeing
 * about a disagreement it invented. Same rule as the jobs list: a full page is
 * answered by the probe below, so the pin buys reach rather than a false refusal.
 */
export function mergeEvidenceGlPipelinesCmd(number: number): string {
  return `glab api "${pipelinesEndpoint(number)}?${listPageQuery(1)}" --output json`;
}

/**
 * #2226 — the second pipelines page: the same read as
 * {@link mergeEvidenceGlPipelinesCmd} with `page=2`.
 *
 * The jobs read is not the only paginated read this gate depends on. The
 * pipelines list decides WHICH pipeline's jobs are graded, and its rows are
 * ordered newest-first by a server this gate does not control: on a busy MR the
 * row the MR designates as its head pipeline can sit past row 100, and a gate
 * that read one page would report the forge's own two rows as disagreeing about
 * a disagreement the pagination invented. Same question as the jobs probe — "is
 * there a second page?" — and the same answer shapes: a non-empty page 2 means
 * the list the gate holds is a subset, so it refuses rather than attributing.
 */
export function mergeEvidenceGlPipelinesPage2Cmd(number: number): string {
  return `glab api "${pipelinesEndpoint(number)}?${listPageQuery(2)}" --output json`;
}

/** The pipelines endpoint, shared by both reads so the probe cannot drift. */
function pipelinesEndpoint(number: number): string {
  return `/projects/:id/merge_requests/${number}/pipelines`;
}

/**
 * #2226 — the jobs of one pipeline, the rows the gate grades.
 *
 * `per_page=100` is load-bearing, not a tuning knob: GitLab paginates this
 * endpoint at **20 rows per page by default** (its own Jobs API docs say so, and
 * `X-Total-Pages` on a real pipeline confirms it), so an unpinned read grades
 * the first 20 jobs and reports a verdict about a subset as if it were the whole
 * pipeline. 100 is the largest page the API serves; the gatherer treats a
 * response that fills it as "ask the second page whether anything follows" —
 * see {@link mergeEvidenceGlJobsPage2Cmd}, which is what turns that question
 * into a verdict instead of a permanent refusal.
 */
export function mergeEvidenceGlJobsCmd(pipelineId: number): string {
  return `glab api "/projects/:id/pipelines/${pipelineId}/jobs?${listPageQuery(1)}" --output json`;
}
/**
 * #2226 — the second jobs page: the same read as
 * {@link mergeEvidenceGlJobsCmd} with `page=2`.
 *
 * It exists because a page that FILLS the requested size proves nothing on its
 * own: with `per_page=100`, both a 356-job pipeline and a pipeline of exactly
 * 100 jobs answer with 100 rows — observed on gitlab-org/gitlab MR pipelines
 * whose `x-total` is 77, 90, 116, 344, 347 (so both shapes are routine). The
 * gatherer asks this one question of a full first page — "is there a second
 * page?" — and reads its row count. `X-Total-Pages` would answer it in one
 * round trip but glab does not surface response headers, and a truncated read
 * that had to *refuse* rather than ask would park every MR of exactly that
 * size, which is the pilot-stall class this issue exists to remove.
 */
export function mergeEvidenceGlJobsPage2Cmd(pipelineId: number): string {
  return `glab api "/projects/:id/pipelines/${pipelineId}/jobs?${listPageQuery(2)}" --output json`;
}

/** The query of one page of a list read — the shape both paginated reads ask for. */
function listPageQuery(page: number): string {
  return `per_page=${GL_JOB_PAGE_SIZE}${page > 1 ? `&page=${page}` : ""}`;
}
