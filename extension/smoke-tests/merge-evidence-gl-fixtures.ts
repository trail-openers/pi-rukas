/**
 * merge-evidence-gl-fixtures.ts — the one fixture set the GitLab merge-evidence
 * suites share (#2226; split from the oversized suite for the §12 size cap).
 *
 * Two files drive the GitLab arm of the evidence gate — the verdicts
 * (`test-merge-evidence-gitlab.ts`) and the pagination/retry behaviour
 * (`test-merge-evidence-gl-pagination.ts`) — and both must build the SAME reads,
 * because what those arms assert is the exact argv the gatherer issues. A copy of
 * `glReads` in each file is the half of that split that could fail silently: a key
 * that drifted in one copy would answer a read the gatherer no longer issues, and
 * the arm would pass against an empty fixture.
 *
 * `mkExec` matches with `cmd.includes(key)`, which decides two things here:
 *   - the jobs page-2 key comes BEFORE the page-1 key, whose argv is its prefix;
 *     let the shorter key win and the probe is handed page 1's rows again, which
 *     reports "there are more jobs" about a pipeline that has none;
 *   - the MR-state key stays a literal, because `mergeEvidenceGlMrCmd`'s endpoint
 *     is a prefix of the pipelines endpoint and a builder-derived key would let
 *     the MR row answer the pipelines read.
 */

import {
  GL_JOB_PAGE_SIZE,
  mergeEvidenceGlJobsPage2Cmd,
  mergeEvidenceGlPipelinesCmd,
  mergeEvidenceGlPipelinesPage2Cmd,
} from "../src/forge-commands-gl-evidence.ts";
import { GL_MR } from "./forge-fixtures.ts";

/** The MR the arms describe. */
export const MR = 17;
/** The head the one MR read carries — the OID every verdict must describe. */
export const HEAD = "a".repeat(40);
/** A second full OID, for an MR whose head differs from the fixture's. */
export const OTHER_HEAD = "b".repeat(40);
/** The pipeline the MR row designates as the head's, and the jobs read for it. */
export const PIPELINE = 5001;

export const JOB_PAGE_SIZE = GL_JOB_PAGE_SIZE;

/** The jobs read of the head pipeline, as the builder spells it. */
export const JOBS_CMD = `glab api "/projects/:id/pipelines/${PIPELINE}/jobs?per_page=${GL_JOB_PAGE_SIZE}" --output json`;

/** The probe that decides whether a full jobs page is the whole pipeline. */
export const JOBS_PAGE2_CMD = mergeEvidenceGlJobsPage2Cmd(PIPELINE);

/** The pipelines read, as the builder spells it (its page pin is load-bearing). */
export const PIPELINES_CMD = mergeEvidenceGlPipelinesCmd(MR);

/**
 * The probe that decides whether a full pipelines page is the whole list — the
 * pipelines twin of {@link JOBS_PAGE2_CMD}, and the reason a busy MR whose head
 * pipeline sits past row 100 is graded rather than refused for good.
 */
export const PIPELINES_PAGE2_CMD = mergeEvidenceGlPipelinesPage2Cmd(MR);

/** The MR row every arm starts from: green, carrying the head and its pipeline. */
export const mrRow = (over: Record<string, unknown> = {}) => ({
  ...GL_MR,
  sha: HEAD,
  diff_refs: { head_sha: HEAD },
  head_pipeline: { id: PIPELINE, sha: HEAD, status: "success" },
  ...over,
});

/** One pipeline-list row, as the pipelines endpoint answers it. */
export const pipelineRow = (id: number, sha: string) => ({ id, sha, status: "success" });

/** One job row, the shape `glab api …/jobs` gives (`allow_failure` is on every row). */
export const jobRow = (name: string, status: string, allowFailure = false, id?: number) => ({
  name,
  status,
  allow_failure: allowFailure,
  ...(id === undefined ? {} : { id }),
});

/** The fixture map `mkExec` answers from: MR row, pipelines list, jobs pages. */
export type GlReads = Record<string, { stdout?: string; error?: boolean; stderr?: string }>;

/** Every read the gatherer is allowed to issue for one MR.
 *
 * KEY ORDER IS LOAD-BEARING. `mkExec` answers the FIRST key the command
 * contains, and each page-2 probe command is a prefix-superset of its page-1
 * read (`…pipelines?per_page=100` is inside `…pipelines?per_page=100&page=2`),
 * so a probe key listed BEFORE its read answers the read instead of the probe —
 * a pipelines list of `[]` handed to the attribution branch, which reads as a
 * pipeline-less MR rather than as the truncated read the arm meant to build.
 * Page 2 keys therefore come after their page 1 key, and the MR-state literal
 * comes first of all (its endpoint is a prefix of the pipelines endpoint).
 */
export function glReads(mr: unknown, pipelines: unknown, jobs: unknown): GlReads {
  const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return {
    "glab api /projects/:id/merge_requests/17": { stdout: json(mr) },
    [PIPELINES_CMD]: { stdout: json(pipelines) },
    [JOBS_CMD]: { stdout: json(jobs) },
    // An empty second page is the answer that means "that page was the whole
    // list", so both probes default to it and an arm has to go out of its way to
    // claim truncation.
    [PIPELINES_PAGE2_CMD]: { stdout: "[]" },
    [JOBS_PAGE2_CMD]: { stdout: "[]" },
  };
}

/** `glReads` with the jobs page-2 probe's answer replaced (the pagination arms). */
export function glReadsWithPage2(
  mr: unknown,
  pipelines: unknown,
  jobs: unknown,
  page2: { stdout?: string; error?: boolean; stderr?: string },
): GlReads {
  return { ...glReads(mr, pipelines, jobs), [JOBS_PAGE2_CMD]: page2 };
}
