/**
 * forge-merge — merge-readiness composition (S2 of epic #608,
 * SAFETY-CRITICAL section).
 *
 * GitHub: `gh pr view --json mergeStateStatus,mergeable,state` +
 * `gh pr checks`. GitHub has already applied the repo's own rules, so the
 * `mergeStateStatus` value is authoritative; the checks pass supplies the
 * failing/pending list for the handoff.
 *
 * GitLab: no single mergeStateStatus — it is composed from
 * `detailed_merge_status` (a finite enum), `has_conflicts`,
 * `blocking_discussions_resolved`, and `approvals_left`:
 *
 *   - `can_be_merged`, `succeeding`        → CLEAN
 *   - `has_conflicts`, `blocked_by_*`      → DIRTY
 *   - `checking`                           → UNKNOWN (retryable, capped)
 *   - anything else                         → FAIL CLOSED (`ok: false`)
 *
 * The ellipsis in the epic's mapping table is resolved here, with the
 * decision recorded per value (see the table below). `checking` is the
 * only retryable state; the retry loop lives in `forge.ts:watchMergeReadiness`
 * with a 5–10s cap, because the polling cadence is the caller's concern.
 *
 * FAIL CLOSED: any unreadable field, API error, or value outside the table
 * yields `{ ok: false }`. A readiness of UNKNOWN is NOT a failure — it is a
 * legitimate "not yet determinable" verdict that the caller may retry; a
 * `detailed_merge_status` of some other value IS a failure, because
 * composing a guess would be exactly the class of defect this project
 * removes.
 */

import { prChecksCmd, prViewCmd } from "./forge-commands.ts";
import { ForgeFieldError, mapGhChecks, mapGhPr, mapGlPipelineJobs } from "./forge-mapping.ts";
import type { MergeReadiness, MergeReadinessResult, NormalizedCICheck } from "./forge-types.ts";

/**
 * The `detailed_merge_status` → readiness mapping. Every GitLab value in
 * the documented set has an explicit entry; unmapped values fail closed
 * below (they would only appear after a GitLab server-side change, in
 * which case a guess is worse than a stop).
 */
const GL_STATUS_TO_READINESS: Record<string, MergeReadiness> = {
  can_be_merged: "CLEAN",
  succeeding: "CLEAN",
  has_conflicts: "DIRTY",
  blocked_by_pipeline_status: "DIRTY",
  blocked_by_discussions: "DIRTY",
  blocked_by_approval_rules: "DIRTY",
  blocked_by_missing_required_status_check: "DIRTY",
  blocked_by_required_status_check: "DIRTY",
  blocked_by_outdated_commit: "DIRTY",
  blocked_by_single_approver_rule: "DIRTY",
  blocked_by_two_factor_requirements: "DIRTY",
  blocked_by_two_factor_requirements_for_commit: "DIRTY",
  blocked_by_two_factor_requirements_for_merge_request: "DIRTY",
  blocked_by_two_factor_requirements_for_merge_request_commit: "DIRTY",
  blocked_by_two_factor_requirements_for_merge_request_commit_push: "DIRTY",
  blocked_by_two_factor_requirements_for_merge_request_commit_push_and_pipeline: "DIRTY",
  blocked_by_two_factor_requirements_for_merge_request_commit_push_and_pipeline_status: "DIRTY",
  blocked_by_two_factor_requirements_for_merge_request_commit_push_and_pipeline_status_and_approval:
    "DIRTY",
  checking: "UNKNOWN",
};

export interface GlMrFields {
  detailed_merge_status?: string | null;
  has_conflicts?: boolean | null;
  blocking_discussions_resolved?: boolean | null;
  approvals_left?: number | null;
  state?: string | null;
}

/**
 * Compose GitLab merge readiness from the four fields.
 *
 * Pure and total — the CLI is the caller's concern (forge.ts passes the
 * `glab api /projects/:id/merge_requests/:iid` row). Every input must be
 * present AND typed; a missing field is a failure, not an assumption.
 */
export function composeGlReadiness(mr: GlMrFields): { readiness: MergeReadiness; detail: string } {
  const status = mr.detailed_merge_status;
  if (typeof status !== "string" || status === "") {
    throw new ForgeFieldError("detailed_merge_status", "glab mr view");
  }
  const readiness = GL_STATUS_TO_READINESS[status];
  if (!readiness) {
    // Fail closed: unknown enum value (server added a state we don't know).
    throw new Error(`forge mapping: unmapped detailed_merge_status "${status}"`);
  }

  const parts: string[] = [`detailed_merge_status=${status}`];

  // Cross-checks. Each is independent of the primary mapping: has_conflicts
  // must agree with a DIRTY/CLEAN verdict, unresolved discussions must force
  // DIRTY, and a pending approval count must force DIRTY. Any disagreement
  // fails closed rather than picking a side — the fields come from the
  // same API call, so disagreement means an inconsistent server response.
  if (typeof mr.has_conflicts === "boolean") {
    if (mr.has_conflicts && readiness === "CLEAN") {
      throw new Error(`forge mapping: has_conflicts=true contradicts ${status}`);
    }
    parts.push(`has_conflicts=${mr.has_conflicts}`);
  } else {
    throw new ForgeFieldError("has_conflicts", "glab mr view");
  }

  if (typeof mr.blocking_discussions_resolved === "boolean") {
    if (!mr.blocking_discussions_resolved) {
      // Unresolved discussions block the merge regardless of the status.
      throw new Error(`forge mapping: blocking_discussions_resolved=false overrides ${status}`);
    }
    parts.push(`blocking_discussions_resolved=${mr.blocking_discussions_resolved}`);
  } else {
    throw new ForgeFieldError("blocking_discussions_resolved", "glab mr view");
  }

  if (typeof mr.approvals_left === "number") {
    if (mr.approvals_left > 0 && readiness === "CLEAN") {
      // Pending approvals block the merge regardless of the status.
      throw new Error(`forge mapping: approvals_left=${mr.approvals_left} overrides ${status}`);
    }
    parts.push(`approvals_left=${mr.approvals_left}`);
  } else {
    throw new ForgeFieldError("approvals_left", "glab mr view");
  }

  // An MR that is not open cannot merge cleanly regardless of status.
  if (typeof mr.state === "string" && mr.state !== "" && mr.state.toLowerCase() !== "opened") {
    throw new Error(`forge mapping: MR state is "${mr.state}", not opened`);
  }

  return { readiness, detail: parts.join(", ") };
}

// ── Entry points (CLI-backed, one per forge) ─────────────────────────────

/**
 * Bounded wait for every merge-readiness `gh`/`glab` call. gh/glab REST
 * calls are normally sub-second to a few seconds, so 30s gives generous
 * headroom for a slow network while still catching a hung CLI (network
 * stall, an interactive auth prompt the child cannot answer, a wedged
 * credential helper). Mirrors `DEFAULT_TIMEOUT_MS` in vipune.ts.
 *
 * Without this bound a hang on this path — which gates the one
 * irreversible act in a /work cycle — never returns: the driver does not
 * fail closed, it fails to finish.
 */
export const READINESS_TIMEOUT_MS = 30_000;

/**
 * Name the failure of a readiness exec. Node's exec timeout kills the
 * child with SIGTERM and rejects with `killed: true` and a frequently
 * EMPTY message — `(err as Error).message` would render an empty tail in
 * the reason. Detect `killed` first, mirroring vipune.ts.
 */
function readinessErrorReason(err: unknown, context: string): string {
  const e = err as Error & { killed?: boolean; signal?: string | null };
  if (e?.killed) {
    return `${context} timed out after ${READINESS_TIMEOUT_MS}ms (SIGTERM)`;
  }
  return `${context}: ${e?.message?.slice(0, 160) ?? "unknown error"}`;
}

export interface ReadinessOpts {
  /** MaxBuffer for the underlying exec calls (default 256 KB, matching the driver). */
  maxBuffer?: number;
}

/**
 * GitHub merge readiness. Fails closed on any unreadable field.
 *
 * `gh pr view` must return a parseable JSON with `mergeStateStatus`,
 * `mergeable`, and `state`. `gh pr checks` must return a JSON array.
 * A non-OPEN state is a failure (a closed/merged PR cannot be "ready").
 */
export async function checkGithubReadiness(
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr?: string }>,
  repoRoot: string,
  prNumber: number,
  opts: ReadinessOpts = {},
): Promise<MergeReadinessResult> {
  const maxBuffer = opts.maxBuffer ?? 256 * 1024;

  let pr: ReturnType<typeof mapGhPr>;
  try {
    const { stdout } = await execFn(prViewCmd("github", prNumber), {
      cwd: repoRoot,
      maxBuffer,
      timeout: READINESS_TIMEOUT_MS,
    });
    pr = mapGhPr(JSON.parse(stdout) as Record<string, unknown>);
  } catch (err) {
    return {
      ok: false,
      reason: readinessErrorReason(err, "could not read PR state"),
      checks: [],
    };
  }

  if (pr.state !== "OPEN") {
    return {
      ok: false,
      reason: `PR is ${pr.state}, not OPEN`,
      checks: [],
    };
  }

  const blocking = ["BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"];
  if (pr.mergeStateStatus && blocking.includes(pr.mergeStateStatus)) {
    // Still collect the checks for the handoff — the failing list is the
    // actionable part of a blocked PR.
    const checks = await safeGhChecks(execFn, repoRoot, prNumber, maxBuffer);
    if (checks.ok === false) {
      return {
        ok: false,
        reason: `mergeStateStatus is ${pr.mergeStateStatus}; checks unreadable: ${checks.reason}`,
        checks: [],
      };
    }
    return {
      ok: false,
      reason: `mergeStateStatus is ${pr.mergeStateStatus}`,
      checks: checks.checks,
    };
  }

  const checks = await safeGhChecks(execFn, repoRoot, prNumber, maxBuffer);
  if (checks.ok === false) {
    return {
      ok: false,
      reason: `could not read PR checks: ${checks.reason}`,
      checks: [],
    };
  }

  const required = checks.checks.filter((c) => c.isRequired !== false);
  const failing = required.filter((c) =>
    ["FAIL", "FAILURE", "CANCELED", "CANCELLED", "TIMED_OUT", "ERROR"].includes(
      c.bucket?.toUpperCase() ?? c.state,
    ),
  );
  const pending = required.filter((c) =>
    ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING"].includes(c.state),
  );

  const readiness: MergeReadiness =
    failing.length > 0
      ? "DIRTY"
      : pending.length > 0
        ? "UNKNOWN"
        : pr.mergeStateStatus === "CLEAN" || pr.mergeable === "TRUE"
          ? "CLEAN"
          : "UNKNOWN";

  const detail = [
    pr.mergeStateStatus ? `mergeStateStatus=${pr.mergeStateStatus}` : null,
    pr.mergeable ? `mergeable=${pr.mergeable}` : null,
    failing.length ? `failing=[${failing.map((c) => c.name).join(",")}]` : null,
    pending.length ? `pending=[${pending.map((c) => c.name).join(",")}]` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return { ok: true, readiness, detail, checks: checks.checks };
}

type SafeChecks = { ok: true; checks: NormalizedCICheck[] } | { ok: false; reason: string };

async function safeGhChecks(
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr?: string }>,
  repoRoot: string,
  prNumber: number,
  maxBuffer: number,
): Promise<SafeChecks> {
  try {
    const { stdout } = await execFn(prChecksCmd("github", prNumber), {
      cwd: repoRoot,
      maxBuffer,
      timeout: READINESS_TIMEOUT_MS,
    });
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) return { ok: false, reason: "checks rows not an array" };
    return { ok: true, checks: mapGhChecks(parsed) };
  } catch (err) {
    return {
      ok: false,
      reason: readinessErrorReason(err, "could not read PR checks"),
    };
  }
}

/**
 * GitLab merge readiness. Fails closed on any unreadable field.
 *
 * The single API call is `glab api /projects/:id/merge_requests/:iid`
 * (the same payload `glab mr view` returns, via the REST door so the
 * caller can add fields explicitly). `detailed_merge_status`,
 * `has_conflicts`, `blocking_discussions_resolved`, and `approvals_left`
 * must all be present and typed, or the call fails.
 *
 * CI checks on GitLab are the MR's open pipeline jobs; they are attached
 * to the result for parity with the GitHub path, but readiness is decided
 * by the composition above (a pipeline failure surfaces as
 * `blocked_by_pipeline_status` in the detailed status).
 */
export async function checkGitlabReadiness(
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr?: string }>,
  repoRoot: string,
  mrIid: number,
  opts: ReadinessOpts = {},
): Promise<MergeReadinessResult> {
  const maxBuffer = opts.maxBuffer ?? 256 * 1024;

  let raw: Record<string, unknown>;
  try {
    const { stdout } = await execFn(`glab api /projects/:id/merge_requests/${mrIid}`, {
      cwd: repoRoot,
      maxBuffer,
      timeout: READINESS_TIMEOUT_MS,
    });
    raw = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      reason: readinessErrorReason(err, "could not read MR state"),
      checks: [],
    };
  }

  let composed: ReturnType<typeof composeGlReadiness>;
  try {
    composed = composeGlReadiness(raw);
  } catch (err) {
    return {
      ok: false,
      reason: (err as Error).message,
      checks: [],
    };
  }

  // Attach the pipeline checks (best-effort: a missing pipeline is not a
  // readiness failure — the composition above is authoritative).
  let checks: NormalizedCICheck[] = [];
  try {
    const pipelineId = (raw as Record<string, unknown>).open_pipeline as Record<
      string,
      unknown
    > | null;
    if (pipelineId && typeof (pipelineId as Record<string, unknown>).id === "number") {
      const pid = (pipelineId as Record<string, unknown>).id as number;
      const { stdout } = await execFn(
        `glab api /projects/:id/pipelines/${pid}/jobs --output json`,
        {
          cwd: repoRoot,
          maxBuffer,
          timeout: READINESS_TIMEOUT_MS,
        },
      );
      const jobs: unknown = JSON.parse(stdout || "[]");
      checks = mapGlPipelineJobs(jobs);
    }
  } catch {
    // No open pipeline, or jobs unreadable — composition is authoritative.
  }

  return { ok: true, readiness: composed.readiness, detail: composed.detail, checks };
}

// Re-export the prViewCmd for callers that want the raw view command.
export { prViewCmd };
