/**
 * work-driver-merge-evidence-gl — the GitLab half of the merge evidence gate
 * (#2226).
 *
 * `work-driver-merge-evidence.ts` is GitHub-only by construction: both of its
 * reads are spelled with gh argv builders, and its rows expect a `bucket` or a
 * `state` per check. A GitLab MR answers neither, so on a GitLab project the
 * driver's merged step, the stepback ci step, the merge guard and lean land
 * could never present passing evidence — a pilot's work-lean run parked at
 * `land` on an MR that was green.
 *
 * This module answers the same `MergeEvidence` question through the GitLab
 * adapter's own reads, and keeps the same contract: fail closed, name what it
 * saw, and never let silence read as a pass. The shape of `MergeEvidence` is
 * unchanged (binding resolution E1) — on GitLab `mergeStateStatus` carries the
 * COMPOSED readiness (`CLEAN` / `DIRTY` / `UNKNOWN`), because that is what
 * GitHub's own `mergeStateStatus` is: the forge's answer to "would a merge
 * succeed right now". The author is not an evidence field; it comes from the
 * identity read `readGlTarget` already supplies on `MergeTarget`.
 *
 * Three reads, each with a distinct kind of failure:
 *   1. the MR row (`mergeEvidenceGlMrCmd`) — readiness and head from ONE read,
 *      so the verdict and the pin describe one moment (E2);
 *   2. the MR's pipelines — an EMPTY list is a CI verdict ("no checks
 *      reported"), a failed read is tooling (E4);
 *   3. that pipeline's jobs — graded by the one table in `forge-gl-grade.ts`
 *      (E3), which is the whole reason this arm exists: GitLab's status words
 *      are not gh's buckets, and grading them with GitHub's sets files every
 *      GitLab row as "no verdict".
 *
 * Which rows a verdict may be drawn from — the pipelines list read, its page
 * probe, and the attribution of the MR's `head_pipeline` to this head — lives in
 * `work-driver-merge-evidence-gl-reads.ts`. A jobs list for a commit that is not
 * the head is not a verdict about this merge, and neither is a page of rows the
 * endpoint's pagination may have cut short. The rows that are graded are the
 * current attempt of each job — `currentJobAttempts` in `forge-gl-grade.ts` —
 * because the endpoint keeps the history of every retry.
 *
 * A pipeline-less MR never reaches read 3, so the "no checks reported" refusal
 * can only be reached on a pipelines read that actually answered (E4).
 */

import {
  GL_JOB_PAGE_SIZE,
  mergeEvidenceGlJobsCmd,
  mergeEvidenceGlJobsPage2Cmd,
  mergeEvidenceGlMrCmd,
  mergeEvidenceGlPipelinesCmd,
  mergeEvidenceGlPipelinesPage2Cmd,
} from "./forge-commands-gl-evidence.ts";
import { FORGE_EXEC_TIMEOUT_MS } from "./forge-detect.ts";
import { type GlJobGrade, currentJobAttempts, gradeGlJobRow } from "./forge-gl-grade.ts";
import { composeGlReadiness } from "./forge-merge.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import {
  pickPipelineForHead,
  probeSecondPage,
  readGlList,
} from "./work-driver-merge-evidence-gl-reads.ts";
import type { MergeEvidence } from "./work-driver-merge-evidence.ts";

/** Shell executor, matching `DriverContext.verifyExecFn`. */
type ExecFn = VerifyExecFn;

/** The head fields, spread onto every return so a refusal still reports what it saw. */
function headFields(headOid?: string, headOidError?: string) {
  return {
    ...(headOid ? { headOid } : {}),
    ...(headOidError ? { headOidError } : {}),
  };
}

/** A refusal that says which read failed, and why, in the operator's words. */
function toolingRefusal(mrIid: number, what: string, detail: string): MergeEvidence {
  return {
    ok: false,
    failureKind: "tooling",
    reason: `could not read ${what} for MR !${mrIid}: ${detail.slice(0, 160)}`,
    failing: [],
    inconclusive: [],
  };
}

/** A non-zero exit and an exit-0-but-unparseable answer are different faults. */
function execDetail(err: unknown): string {
  const e = err as Error & { killed?: boolean };
  if (e?.killed) return `the glab invocation timed out (${FORGE_EXEC_TIMEOUT_MS}ms)`;
  return e?.message ?? "the glab invocation failed";
}

/** The MR row's head, from the same read that answered readiness (E2). */
function readMrHead(raw: Record<string, unknown>): string | undefined {
  const diffRefs = raw.diff_refs as Record<string, unknown> | null | undefined;
  const candidates = [raw.sha, diffRefs?.head_sha];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (value === "") continue;
    if (isFullCommitSha(value)) return value;
    // A malformed first field is not a verdict: `diff_refs.head_sha` is still
    // worth reading, and `headError` below names every candidate it looked at.
  }
  return undefined;
}

function headError(raw: Record<string, unknown>, mrIid: number): string {
  const diffRefs = raw.diff_refs as Record<string, unknown> | null | undefined;
  const got = [raw.sha, diffRefs?.head_sha].find((v) => typeof v === "string" && v !== "");
  return got === undefined
    ? `the MR-state read returned no head OID for MR !${mrIid}`
    : `the MR-state read returned a head OID that is not a full 40-char SHA for MR !${mrIid} (got ${String(got).slice(0, 48)})`;
}

/** The job states that mean the row EXECUTED — everything else never ran. */
const RAN_STATES = new Set(["success", "failed", "canceled"]);

/** Whether any row the gate graded is one that actually ran. */
function anyRowExecuted(rows: unknown[]): boolean {
  return rows.some((r) => {
    const s = (r as Record<string, unknown> | null)?.status;
    return typeof s === "string" && RAN_STATES.has(s.toLowerCase());
  });
}

/** The evidence for a GitLab MR, or the named reason it cannot merge. */
export async function gatherGitlabMergeEvidence(
  execFn: ExecFn,
  repoRoot: string,
  mrIid: number,
): Promise<MergeEvidence> {
  // ── Read 1: the MR row — readiness AND head, one read, one moment (E2). ──
  let raw: Record<string, unknown>;
  try {
    const { stdout } = await execFn(mergeEvidenceGlMrCmd(mrIid), {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
      timeout: FORGE_EXEC_TIMEOUT_MS,
    });
    raw = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    return toolingRefusal(mrIid, "MR state", execDetail(err));
  }

  let composed: { readiness: "CLEAN" | "DIRTY" | "UNKNOWN"; detail: string };
  try {
    composed = composeGlReadiness(raw);
  } catch (err) {
    // An unreadable or unmapped field is the composition failing closed — the
    // forge answered and its answer cannot be trusted, which is a CI verdict
    // (the gate refuses) rather than a claim that glab itself is broken.
    return {
      ok: false,
      reason: `could not compose MR readiness: ${(err as Error).message?.slice(0, 160)}`,
      failing: [],
      inconclusive: [],
    };
  }

  const headOid = readMrHead(raw);
  const headOidError = headOid === undefined ? headError(raw, mrIid) : undefined;

  // ── Read 2: the MR's pipelines, read before the readiness verdict is
  // returned. An empty list is a CI verdict; a read that never answered is
  // tooling (E4), and the two are told apart HERE, not downstream. Reading it
  // even for a non-CLEAN MR is deliberate: the refusal then reports the state of
  // the checks it read rather than a check state it never asked about. ──
  const pipelines = await readGlList(
    execFn,
    repoRoot,
    mergeEvidenceGlPipelinesCmd(mrIid),
    512 * 1024,
  );
  if ("failed" in pipelines) {
    return toolingRefusal(mrIid, "MR pipelines", pipelines.failed);
  }
  if ("malformed" in pipelines) {
    return {
      ok: false,
      failureKind: "tooling",
      reason: `the MR pipelines read returned data the gate could not read as a pipeline list${
        pipelines.malformed.startsWith("(") ? "" : ` — got: ${pipelines.malformed.slice(0, 160)}`
      }. Fix the glab setup or the pipelines configuration, then re-run.`,
      mergeStateStatus: composed.readiness,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }
  // A pipelines list that FILLED its page may be a subset, and unlike the jobs
  // list the risk here is not a red row left unread but the row that PROVES the
  // head pipeline belongs to this MR sitting beyond what was read: the gate
  // would then report the forge contradicting itself. Ask the one question that
  // separates "exactly a page" from "there is more", only on a full page.
  if (pipelines.rows.length >= GL_JOB_PAGE_SIZE) {
    const probe = await probeSecondPage(execFn, repoRoot, mergeEvidenceGlPipelinesPage2Cmd(mrIid));
    if ("failed" in probe) {
      return toolingRefusal(mrIid, `the second page of MR ${mrIid}'s pipelines`, probe.failed);
    }
    if ("more" in probe) {
      return {
        ok: false,
        reason: `the pipelines list of MR ${mrIid} filled the requested page (${GL_JOB_PAGE_SIZE} pipelines) and a second page followed, so the list the gate read is truncated and may omit the head pipeline — refusing to merge on a partial pipeline list`,
        mergeStateStatus: composed.readiness,
        failing: [],
        inconclusive: [],
        ...headFields(headOid, headOidError),
      };
    }
  }

  // The composed readiness is the authoritative verdict, exactly as
  // `mergeStateStatus` is on GitHub: DIRTY and UNKNOWN are not mergeable, and
  // the check rows below only ever NAME what is wrong (the unrecognised-state
  // refusal is the one exception — an ungraded row is no verdict at all).
  if (composed.readiness !== "CLEAN") {
    return {
      ok: false,
      reason: `merge readiness is ${composed.readiness} (${composed.detail})`,
      mergeStateStatus: composed.readiness,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }

  const chosen = pickPipelineForHead(raw, pipelines.rows, headOid);
  if ("noPipeline" in chosen) {
    // The pipelines read ANSWERED and said this MR has no pipeline. That is the
    // absence of evidence, and this step is irreversible (the GitHub gatherer
    // refuses on zero rows for the same reason).
    return {
      ok: false,
      reason: "no checks reported — refusing to merge on the absence of evidence",
      mergeStateStatus: composed.readiness,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }
  if ("refusal" in chosen) {
    // A pipeline that cannot be attributed to this head is not a verdict about
    // this merge — and it is the forge's own two rows that disagree, which is a
    // CI-side fault rather than a broken glab.
    return {
      ok: false,
      reason: `the pipeline for this MR's head could not be identified: ${chosen.refusal}`,
      mergeStateStatus: composed.readiness,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }
  const pipelineId = chosen.pipelineId;

  // ── Read 3: the jobs of that pipeline, graded by the one table (E3). ──
  const jobs = await readGlList(execFn, repoRoot, mergeEvidenceGlJobsCmd(pipelineId), 512 * 1024);
  if ("failed" in jobs) {
    return toolingRefusal(mrIid, "pipeline jobs", jobs.failed);
  }
  if ("malformed" in jobs) {
    return {
      ok: false,
      failureKind: "tooling",
      reason: `the pipeline jobs read returned data the gate could not read as a job list${
        jobs.malformed.startsWith("(") ? "" : ` — got: ${jobs.malformed.slice(0, 160)}`
      }. Fix the glab setup or the pipelines configuration, then re-run.`,
      mergeStateStatus: composed.readiness,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }
  // The jobs endpoint is paginated, and the requested page is the largest the
  // API serves. A response that FILLS it says nothing on its own about whether
  // the pipeline has more jobs, so the gate asks the one question that
  // separates "exactly a page" from "there is more": read page 2. The branches
  // below are named rather than folded into one expression because the refusal
  // shapes differ: a tooling refusal carries `failureKind`, a partial-list one
  // is a CI verdict.
  const gradedRows = jobs.rows;
  if (jobs.rows.length >= GL_JOB_PAGE_SIZE) {
    const probe = await probeSecondPage(execFn, repoRoot, mergeEvidenceGlJobsPage2Cmd(pipelineId));
    if ("failed" in probe) {
      return toolingRefusal(
        mrIid,
        `the second page of pipeline ${pipelineId}'s jobs`,
        probe.failed,
      );
    }
    if ("more" in probe) {
      return {
        ok: false,
        reason: `the jobs read for pipeline ${pipelineId} filled the requested page (${GL_JOB_PAGE_SIZE} jobs) and a second page followed, so the pipeline has jobs the gate did not read — refusing to merge on a partial check list`,
        mergeStateStatus: composed.readiness,
        failing: [],
        inconclusive: [],
        ...headFields(headOid, headOidError),
      };
    }
  }

  // The rows the gate grades are the CURRENT attempt of each job, not the
  // endpoint's whole history — see `currentJobAttempts`. A retried job is one
  // job to GitLab and two rows here, and grading both refuses a pipeline the
  // forge calls green on a failure somebody already retried away.
  //
  // `named`/`byGrade` live here rather than beside the reads above because the
  // set they name is this one, and every refusal below reports from it.
  const attempts = currentJobAttempts(gradedRows);

  const named = (rows: Array<Record<string, unknown>>) =>
    // `?.` and not a bare `r.name`: a row the endpoint left as `null` survives
    // `currentJobAttempts` on purpose (see its header), and reading a field off
    // it here would throw out of the gatherer instead of refusing.
    rows.map((r) => (typeof r?.name === "string" ? r.name : "(unnamed)"));
  const byGrade = (grade: GlJobGrade) =>
    attempts.filter((r) => gradeGlJobRow(r as Record<string, unknown>) === grade) as Array<
      Record<string, unknown>
    >;

  const failing = named(byGrade("fail"));
  const pending = named(byGrade("pending"));
  const inconclusive = named(byGrade("not-green"));
  // An ungraded row is no verdict, so it is refused below rather than reported
  // and left to the caller — but it is counted HERE, so the refusal that lists
  // it can also say the gate read every row it received. On the GitHub side
  // `bucket` is a CLOSED set, so a row outside it is no verdict while
  // `mergeStateStatus` still carries the forge's own answer; here the readiness
  // was composed by THIS process from the MR's fields, so a job state the table
  // does not know is a state nobody vouched for. Rows are still named on every
  // refusal below so the caller that grades them again (the merge guard) can say
  // which ones it could not read.
  const unrecognised = named(byGrade("unknown"));

  if (unrecognised.length > 0) {
    return {
      ok: false,
      reason: `check rows reported a job state this gate does not recognise: ${unrecognised.join(", ")}`,
      mergeStateStatus: composed.readiness,
      failing,
      inconclusive,
      unrecognised,
      ...headFields(headOid, headOidError),
    };
  }

  if (failing.length > 0) {
    return {
      ok: false,
      reason: `required checks failing: ${failing.join(", ")}`,
      mergeStateStatus: composed.readiness,
      failing,
      inconclusive,
      ...headFields(headOid, headOidError),
    };
  }
  if (pending.length > 0) {
    return {
      ok: false,
      reason: `required checks still running: ${pending.join(", ")}`,
      mergeStateStatus: composed.readiness,
      failing: [],
      inconclusive,
      ...headFields(headOid, headOidError),
    };
  }
  if (inconclusive.length > 0) {
    return {
      ok: false,
      reason: `required checks reported skipped/manual: ${inconclusive.join(", ")} — a job that never ran has said nothing about this code, and this gate does not count it as passing. A job the pipeline is allowed to fail (\`allow_failure: true\`) is not refused; if this job is required, it must run`,
      mergeStateStatus: composed.readiness,
      failing: [],
      inconclusive,
      ...headFields(headOid, headOidError),
    };
  }
  // A pipeline in which NOTHING EXECUTED says nothing about the code, which is
  // the same absence as the empty jobs list and gets the same words. The empty
  // case alone was not enough: `allow_failure` exempts `manual` and `skipped`
  // from the refusal above, and the grade table reads such a row as `pass`
  // (GitLab's own commit-status machine does), so a pipeline of nothing but
  // never-run jobs had no row left to refuse on and none that had run either.
  // "Executed" therefore cannot mean `pass` — an exemption's reading of a row is
  // not evidence that the row happened. GitHub's empty-checks refusal is the
  // precedent: a gate that passes on jobs that never ran cannot fail.
  if (attempts.length === 0 || !anyRowExecuted(attempts)) {
    return {
      ok: false,
      reason: "no checks reported — refusing to merge on the absence of evidence",
      mergeStateStatus: composed.readiness,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }
  return {
    ok: true,
    mergeStateStatus: composed.readiness,
    failing: [],
    inconclusive: [],
    ...headFields(headOid, headOidError),
  };
}
