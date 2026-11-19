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
 * `blocking_discussions_resolved`, and `approvals_left` — the last optional:
 * the single-MR reply does not carry it, and pending approvals reach us through
 * the status as `not_approved` (see {@link composeGlReadiness}):
 *
 *   - `mergeable`                          → CLEAN
 *   - `checking`, `unchecked`, `preparing`,
 *     `approvals_syncing`, `ci_still_running` → UNKNOWN (retryable, capped)
 *   - every other documented value          → DIRTY, naming the value
 *   - anything outside the documented set   → FAIL CLOSED (`ok: false`)
 *
 * The set is GitLab's own documented enum, taken as a whole. An earlier table
 * was written in GitHub's vocabulary (`can_be_merged`, `blocked_by_*`) and
 * matched nothing the API emits, which is how a ready MR came to fail closed.
 * The retryable group is what "the forge has not finished deciding" means on
 * GitLab, and it is the readiness value — not any one status word — that every
 * caller keys its retry on. The cadence is the caller's own concern: lean's
 * `ci` step polls on its `ci` budget (`lean/ci-tier.ts:checksRedReason`), and
 * each caller bounds its own wait.
 *
 * Four of the DIRTY values name a cause a cross-check also reads — `conflict`,
 * `discussions_not_resolved`, `draft_status`, `not_open` — and the two readings
 * of such a row are answered differently, on purpose (see
 * {@link composeGlReadiness}): a row whose field reports the SAME block composes
 * DIRTY naming the value, while a field that reports a block outright (an
 * unresolved discussion, a non-open state) is refused naming the FIELD. A
 * fixture for one of these values therefore has to say which reading it is.
 *
 * FAIL CLOSED: any unreadable field, API error, or value outside the table
 * yields `{ ok: false }`. A readiness of UNKNOWN is NOT a failure — it is a
 * legitimate "not yet determinable" verdict that the caller may retry; a
 * `detailed_merge_status` of some other value IS a failure, because
 * composing a guess would be exactly the class of defect this project
 * removes.
 */

import { prChecksCmd, prViewCmd } from "./forge-commands.ts";
import { ForgeFieldError, mapGhChecks, mapGhPr } from "./forge-mapping.ts";
import type { MergeReadiness, MergeReadinessResult, NormalizedCICheck } from "./forge-types.ts";

/**
 * The `detailed_merge_status` → readiness mapping. Exported for the suite that
 * pins it value-by-value: a table nobody can enumerate is a table nobody can
 * prove complete, and an incomplete table is the defect this one replaced.
 *
 * The keys are exactly the values GitLab documents for that field, so every
 * reply the API can send has a verdict and none of them is a guess.
 *
 * The three groups:
 *   - `mergeable` — the forge's own "yes", and the only CLEAN it can say;
 *   - the five UNKNOWN values — the forge is still deciding (`checking`,
 *     `unchecked`, `preparing`, `approvals_syncing`, `ci_still_running`). These
 *     are retryable: a status that resolves on its own says nothing about this
 *     MR, and a caller that reddens one spends a fix round on code nobody
 *     changed. Every one of them is waited by every caller — the retry keys on
 *     the readiness value, so widening this set cannot leave a value stranded;
 *   - every other documented value — DIRTY, with the value named in the detail.
 *     These are decisions the project's own rules made (approvals, rebase,
 *     draft, security policy, title), and naming which one is the actionable
 *     part of the handoff.
 *
 * Values outside the documented set fail closed below: they would only appear
 * after a GitLab server-side change, and a guess about a merge is worse than a
 * stop. Note that four of the DIRTY values name a field the cross-checks below
 * also read (`conflict`/`has_conflicts`, `discussions_not_resolved`,
 * `not_open`/`state`): such a reply is a REDUNDANT agreement and composes
 * DIRTY, while a reply whose status and cross-check field DISAGREE is an
 * inconsistent server answer and throws — see {@link composeGlReadiness}.
 */
export const GL_STATUS_TO_READINESS: Record<string, MergeReadiness> = {
  // The forge's own "yes".
  mergeable: "CLEAN",
  // Still deciding: retried on the caller's bound, never graded red.
  checking: "UNKNOWN",
  unchecked: "UNKNOWN",
  preparing: "UNKNOWN",
  approvals_syncing: "UNKNOWN",
  ci_still_running: "UNKNOWN",
  // The forge has decided and the answer is no — each names the rule of the
  // project's that blocked it, which is what the operator reads in the handoff.
  ci_must_pass: "DIRTY",
  commits_status: "DIRTY",
  conflict: "DIRTY",
  discussions_not_resolved: "DIRTY",
  draft_status: "DIRTY",
  jira_association_missing: "DIRTY",
  locked_lfs_files: "DIRTY",
  locked_paths: "DIRTY",
  merge_request_blocked: "DIRTY",
  merge_time: "DIRTY",
  need_rebase: "DIRTY",
  not_approved: "DIRTY",
  not_open: "DIRTY",
  requested_changes: "DIRTY",
  security_policy_pipeline_check: "DIRTY",
  security_policy_violations: "DIRTY",
  status_checks_must_pass: "DIRTY",
  title_regex: "DIRTY",
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
 * present AND typed; a missing field is a failure, not an assumption — except
 * `approvals_left`, which the single-MR reply has never carried: absent or null
 * is skipped, and a value of any other type is still malformed.
 *
 * The status decides (`GL_STATUS_TO_READINESS`) and the three cross-checks can
 * only ever make the answer more conservative or refuse it outright: a CLEAN
 * that reports conflicts or outstanding approvals is a server contradicting
 * itself, and unresolved discussions or a non-`opened` state block the merge
 * whatever the status claims. A reply that AGREES with its own fields composes
 * The four values whose cause a cross-check also reads — `conflict`,
 * `discussions_not_resolved`, `draft_status`, `not_open` — are the ones a test
 * must state carefully, because the same value arrives in two shapes and the two
 * are answered differently, on purpose:
 *
 *   - a blocked status whose cross-check field reports no such block (`conflict`
 *     with `has_conflicts: false`, `not_open` on a row still reporting
 *     `state: opened`) composes DIRTY and names the status. The forge said this
 *     MR cannot merge, and a cross-check is not allowed to overrule that and
 *     grant a merge the status refused;
 *   - a row whose field reports a block of its own is refused outright, naming
 *     the FIELD rather than the status, because the field is the thing the reader
 *     has to go and change. That is what GitLab sends for
 *     `discussions_not_resolved` (`blocking_discussions_resolved: false`) and for
 *     `not_open` (`state: closed`), and it is also how a `mergeable` that reports
 *     conflicts or outstanding approvals is stopped — the one disagreement that
 *     would otherwise be a false CLEAN, which is why it throws instead of
 *     composing.
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

  // Cross-checks, each independent of the primary mapping. They can only ever
  // make the answer more conservative or refuse it, never grant a merge the
  // status did not: a CLEAN that reports conflicts or outstanding approvals is
  // the server contradicting itself, and an unresolved discussion or a non-open
  // state blocks the merge whatever the status claims. Each refusal names the
  // FIELD rather than the status, because the field is the thing the reader has
  // to go and change. (The reverse — a blocked status on a row whose field
  // reports no such block — is NOT a refusal: the forge said the MR cannot
  // merge, and the cross-checks do not get to overrule that and green-light it.)
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

  if (mr.approvals_left === undefined || mr.approvals_left === null) {
    // Optional. The single-MR reply (`glab mr view`, and the same payload over
    // `glab api /projects/:id/merge_requests/:iid`) has never carried this
    // number — it lives on `/merge_requests/:iid/approvals` — so requiring it
    // failed EVERY real MR closed at `ci`. `detailed_merge_status` is the
    // authoritative field, and pending approvals already reach us through it as
    // `not_approved`, DIRTY. A present number stays a cross-check below, able to
    // refuse a CLEAN it contradicts; a present non-number is malformed there.
  } else if (typeof mr.approvals_left === "number") {
    if (mr.approvals_left > 0 && readiness === "CLEAN") {
      // Pending approvals block the merge regardless of the status.
      throw new Error(`forge mapping: approvals_left=${mr.approvals_left} overrides ${status}`);
    }
    parts.push(`approvals_left=${mr.approvals_left}`);
  } else {
    // Present but not a number is a malformed reply, not an absent field: the
    // difference is what a reader goes and fixes. (The other two cross-checks
    // stay required — the API does send them on this endpoint.)
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

  // The pass/not-pass verdict is `mergeStateStatus` — it already encodes the
  // repo's own required-check rules; the rows only name what is failing or
  // pending (`gh pr checks` cannot say which of them are required; #745).
  const failing = checks.checks.filter((c) =>
    ["FAIL", "FAILURE", "CANCELED", "CANCELLED", "TIMED_OUT", "ERROR"].includes(
      c.bucket?.toUpperCase() ?? c.state,
    ),
  );
  const pending = checks.checks.filter((c) =>
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
 * `has_conflicts` and `blocking_discussions_resolved` must all be present and
 * typed, or the call fails. `approvals_left` is the optional cross-check: the
 * single-MR reply has never carried it (it lives on
 * `/merge_requests/:iid/approvals`), so absence is skipped and only a value of
 * the wrong type is malformed — see {@link composeGlReadiness}.
 *
 * CI checks on GitLab are the MR's open pipeline jobs. This read does NOT
 * fetch them: it answers the merge question, and the jobs are the pipeline
 * read's own answer (see `forge-pipeline.ts`). The one caller that needs both
 * — lean's `ci` step — reads the jobs once, through the pipeline the MR reply
 * itself named, and refuses rows belonging to any other commit; reading them
 * here as well asked the forge for the same page twice per poll. `checks` is
 * therefore always empty on this path, and no caller reads it: the readiness
 * verdict is the composition, and the composition is the whole answer.
 *
 * `onMrRow` is handed the parsed MR row before composition. The normalized
 * shapes drop every commit oid and every composition field, so a caller that
 * must name the commit its verdict is about can only get it from the reply this
 * read already consumed — a second read of a moving MR is a second moment. It is
 * called only for a reply that PARSED, and never on the error paths: a caller
 * must not be able to read a row the readiness verdict was not made of.
 */
export async function checkGitlabReadiness(
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr?: string }>,
  repoRoot: string,
  mrIid: number,
  opts: ReadinessOpts = {},
  onMrRow?: (mr: Record<string, unknown>) => void,
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
    onMrRow?.(raw);
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

  // No jobs read: the composition above is the whole readiness answer, and the
  // pipeline rows are the caller's own read to make (`glPipelineJobsAt`).
  return { ok: true, readiness: composed.readiness, detail: composed.detail, checks: [] };
}

// Re-export the prViewCmd for callers that want the raw view command.
export { prViewCmd };
