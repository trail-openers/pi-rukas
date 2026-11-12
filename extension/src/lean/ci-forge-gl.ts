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
 * Three rules the shape is built on:
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
 *      `gradeGlJobState` in `../forge-gl-grade.ts`, the table this step and the
 *      merge-evidence gate share: `success` passes and nothing else does,
 *      `skipped` and `manual` are refused, and a state the table has never seen
 *      waits rather than passing. GitLab rows carry no `bucket`, so gh's
 *      bucket-first grading cannot reach them, and `glRowGrade` is the one place
 *      this step asks the table.
 *
 * Both reads are the ADAPTER's (`mergeReadiness` and `prChecks`), so their argv
 * stays the adapter's pinned form and the composition stays the adapter's; the
 * MR reply the head comes from is handed back by `lastMrRow`, the only way the
 * raw fields the normalized shape drops can reach a caller without a second read
 * of a moving MR.
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
 * consumed, which is the head's only source; a forge without that seam answers
 * `undefined` and the step refuses as "the forge gave no head" rather than
 * guessing one.
 */
export type GlForge = {
  mergeReadiness(number: number): Promise<{
    ok: boolean;
    readiness?: MergeReadiness;
    reason?: string;
  }>;
  prChecks(number: number): Promise<NormalizedCICheck[]>;
  lastMrRow?(number: number): unknown;
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
 * One read of the MR and its pipeline.
 *
 * `mergeReadiness` runs first because it is the read that consumes the MR reply
 * the head is then taken from. Its `ok: false` is an infrastructure throw rather
 * than a red: an absent or unmapped composition field is the forge not
 * answering, which is nobody's verdict about the code. `prChecks` then supplies
 * the pipeline's job rows, and `[]` for an MR with no pipeline is what `ci.ts`
 * already refuses as the absence of evidence.
 */
export async function glRead(forge: GlForge, number: number): Promise<GlRead> {
  const readiness = await Promise.resolve(forge.mergeReadiness(number)).catch((err: unknown) => {
    throw new VerifyInfraError(
      `could not read the MR's merge readiness: ${String((err as Error)?.message ?? err)}`,
    );
  });
  if (!readiness.ok || readiness.readiness === undefined)
    throw new VerifyInfraError(
      `could not read the MR's merge readiness: ${readiness.reason ?? "no reason given"}`,
    );
  const rows = await Promise.resolve(forge.prChecks(number)).catch((err: unknown) => {
    throw new VerifyInfraError(
      `could not read the MR pipeline's jobs: ${String((err as Error)?.message ?? err)}`,
    );
  });
  return {
    mergeStateStatus: readiness.readiness,
    prHead: headFromMr(forge.lastMrRow?.(number)),
    rows: Array.isArray(rows) ? rows : undefined,
  };
}

/** What to do with a row that is not a pass. `undefined` means the row passed. */
export type GlRowGrade = "pending" | "red" | "not-passing" | "unknown";

/**
 * One pipeline row's grade, from the shared GitLab table.
 *
 * The step's GitHub grading reads `bucket ?? state` and a GitLab job row has no
 * bucket at all — its only word is the uppercased `status` the adapter's mapper
 * produced. So the shared table decides here, in the step's own `RowGrade`
 * words, which is what lets a GitLab row travel the same wait/red/not-green arms
 * as a gh row without a second verdict list to keep in step.
 */
export function glRowGrade(row: { state?: unknown }): GlRowGrade | undefined {
  const grade = gradeGlJobState(String(row.state ?? ""));
  if (grade === "pass") return undefined;
  if (grade === "fail") return "red";
  if (grade === "pending") return "pending";
  if (grade === "not-green") return "not-passing";
  return "unknown";
}
