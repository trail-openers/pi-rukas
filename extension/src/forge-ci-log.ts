/**
 * forge-ci-log — the failed-job log reads of the forge adapter (#2160).
 *
 * `Forge` modelled CI at run granularity (`ciRun`, `ciWatch`, `prChecks`) and
 * never modelled the log itself, so a helper that needed to know WHY CI went
 * red had to run `gh`/`glab` with its own login. The read lives here instead,
 * behind the adapter, so the parent can serve it through `forge_read` and the
 * helper never holds a credential.
 *
 * Both arms are two calls: the run's jobs first, then the log of the jobs that
 * actually failed. GitHub takes `gh run view <run> --log-failed`, which needs
 * the run's database id and answers the concatenated log of every failed job;
 * GitLab lists the pipeline's jobs and takes one `glab api
 * /projects/:id/jobs/:id/trace` per failed job, because glab has no
 * whole-pipeline trace command.
 *
 * A run whose jobs all succeeded is an honest empty string — "CI is green,
 * there is nothing to read". A run whose jobs could NOT be listed throws: an
 * unreadable job list looks exactly like a green run if it answers `""`, and a
 * caller that read "no log" from a failed read would conclude the CI was fine.
 */

import * as cmds from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import type { ForgeExecFn } from "./forge-types.ts";

/** The statuses that mean "this job's log is the thing to read", upper-cased. */
const GH_FAILED_STATES = new Set(["FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "CANCELED"]);
const GL_FAILED_STATES = new Set(["FAILED", "CANCELED", "SKIPPED", "MANUAL"]);

function jobState(row: Record<string, unknown>): string {
  // A job's outcome is `conclusion` once it has one; `status` alone is the
  // in-flight state (`queued`, `in_progress`) and says nothing about failure.
  const raw = row.conclusion ?? row.status ?? row.state ?? "";
  return String(raw).toUpperCase();
}

/**
 * The jobs whose log is worth reading. GitHub and GitLab spell the failed
 * states differently AND at different fields (`conclusion: "failure"` versus
 * `status: "failed"`), so the comparison is upper-cased and the sets are
 * per-forge — a shared lower-case set silently matches nothing on GitHub, and
 * a read that finds no failed job answers `""`, which is indistinguishable
 * from "CI is green". That is how a red run reads as nothing to read.
 */
export function failedCiJobs(forge: ForgeType, stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch {
    throw new Error(
      "forge ci log: the job list is not readable JSON — cannot tell a green run from a red one",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "forge ci log: the job list is not an array — cannot tell a green run from a red one",
    );
  }
  const states = forge === "github" ? GH_FAILED_STATES : GL_FAILED_STATES;
  return parsed
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .filter((row) => states.has(jobState(row)));
}

/** The job's id in either forge's payload (`id` for both; glab has no alias). */
function jobId(row: Record<string, unknown>): number | undefined {
  const v = row.id ?? row.database_id;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The failed-job log text for one CI run / pipeline. The caller passes the
 * same `execFn`/`cwd` the adapter runs its other reads with, so the argv goes
 * through the same executor the rest of the parent's forge reads use.
 */
export async function ciRunLog(
  execFn: ForgeExecFn,
  forge: ForgeType,
  cwd: string,
  owner: string,
  repo: string,
  id: number,
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const exec = (cmd: string) =>
    execFn(cmd, { cwd, maxBuffer: 512 * 1024, ...opts }).then(({ stdout }) => stdout);
  if (forge === "github") {
    const stdout = await exec(cmds.ciRunJobsCmd(forge, owner, repo, id));
    if (failedCiJobs(forge, stdout).length === 0) return "";
    return exec(cmds.ciRunLogCmd(forge, id));
  }
  const stdout = await exec(cmds.ciRunJobsCmd(forge, owner, repo, id));
  const rows = failedCiJobs(forge, stdout);
  const logs: string[] = [];
  for (const row of rows) {
    const jobId_ = jobId(row);
    if (jobId_ === undefined) continue;
    // `glab api --output json` answers the API envelope, so the trace is read
    // OUT of it rather than used raw: a payload with no trace field contributes
    // nothing rather than a blob of JSON dressed up as a log.
    logs.push(traceText(await exec(cmds.ciJobTraceCmd(jobId_))));
  }
  return logs.join("\n");
}

/** The trace out of a job-trace payload: a bare string, or the `trace` field. */
function traceText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return body;
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof o.trace === "string" ? o.trace : "";
  } catch {
    return body;
  }
}
