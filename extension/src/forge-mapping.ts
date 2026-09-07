/**
 * forge-mapping — field mappers between forge-native JSON and the
 * normalized types in `forge-types.ts` (S2 of epic #608).
 *
 * Per-endpoint JSON convention asymmetry (epic #608):
 *   - GitHub GraphQL (`gh … --json`): camelCase — `number`, `body`, `OPEN`,
 *     `headRefName`, `url`.
 *   - GitHub REST (`gh api`): snake_case (CI).
 *   - GitLab (`glab … --output json` / `glab api`): uniform snake_case —
 *     `iid`, `description`, `opened`, `source_branch`, `web_url`.
 *
 * Every mapper is pure and total: a missing optional field yields
 * `undefined`/`null`; a missing REQUIRED field (number/iid, state, …)
 * throws `ForgeFieldError`, which the forge entry points convert into the
 * fail-closed result shape.
 */

import type {
  NormalizedCICheck,
  NormalizedCIRun,
  NormalizedIssue,
  NormalizedLabel,
  NormalizedPullRequest,
  NormalizedRepo,
} from "./forge-types.ts";

/** Thrown by mappers when a required field is missing or malformed. */
export class ForgeFieldError extends Error {
  constructor(field: string, source: string) {
    super(`forge mapping: required field "${field}" missing or malformed in ${source}`);
    this.name = "ForgeFieldError";
  }
}

function req<T>(obj: Record<string, unknown>, field: string, source: string): T {
  const v = obj[field];
  if (v === undefined || v === null) throw new ForgeFieldError(field, source);
  return v as T;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ── Labels ────────────────────────────────────────────────────────────────

/** gh `--json labels` rows: `{name, id, color, description}` (camelCase). */
export function mapGhIssueLabel(raw: unknown): NormalizedLabel {
  const o = raw as Record<string, unknown>;
  return {
    name: str(o.name) ?? "",
    id: num(o.id),
    color: str(o.color),
    description: str(o.description),
  };
}

/** glab label rows: `{name, color, description}` (snake_case; no numeric id in `labels` field). */
export function mapGlIssueLabel(raw: unknown): NormalizedLabel {
  const o = raw as Record<string, unknown>;
  return {
    name: str(o.name) ?? "",
    id: num(o.id) ?? num(o.iid),
    color: str(o.color),
    description: str(o.description),
  };
}

// ── Issues ────────────────────────────────────────────────────────────────

/** gh `issue view --json …` (camelCase) → NormalizedIssue. */
export function mapGhIssue(raw: Record<string, unknown>): NormalizedIssue {
  const labels = Array.isArray(raw.labels) ? (raw.labels as unknown[]).map(mapGhIssueLabel) : [];
  return {
    number: req<number>(raw, "number", "gh issue view"),
    title: str(raw.title) ?? "",
    body: str(raw.body) ?? "",
    state: req<string>(raw, "state", "gh issue view").toUpperCase() as NormalizedIssue["state"],
    url: str(raw.url) ?? "",
    author: (raw.author as Record<string, unknown> | null | undefined)?.login as string | undefined,
    labels,
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
  };
}

/** glab `issue view --output json` (snake_case) → NormalizedIssue. */
export function mapGlIssue(raw: Record<string, unknown>): NormalizedIssue {
  const labels = Array.isArray(raw.labels) ? (raw.labels as unknown[]).map(mapGlIssueLabel) : [];
  const state = req<string>(raw, "state", "glab issue view").toLowerCase();
  return {
    number: req<number>(raw, "iid", "glab issue view"),
    title: str(raw.title) ?? "",
    body: str(raw.description) ?? "",
    state: (state === "opened"
      ? "OPEN"
      : state === "closed"
        ? "CLOSED"
        : state.toUpperCase()) as NormalizedIssue["state"],
    url: str(raw.web_url) ?? "",
    author: (raw.author as Record<string, unknown> | null | undefined)?.username as
      | string
      | undefined,
    labels,
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

// ── Pull requests / MRs ───────────────────────────────────────────────────

/** gh `pr view --json …` (camelCase) → NormalizedPullRequest. */
export function mapGhPr(raw: Record<string, unknown>): NormalizedPullRequest {
  const labels = Array.isArray(raw.labels) ? (raw.labels as unknown[]).map(mapGhIssueLabel) : [];
  const mergeable = raw.mergeable;
  const mergeState = raw.mergeStateStatus;
  return {
    number: req<number>(raw, "number", "gh pr view"),
    title: str(raw.title) ?? "",
    body: str(raw.body) ?? "",
    state: req<string>(raw, "state", "gh pr view").toUpperCase() as NormalizedPullRequest["state"],
    url: str(raw.url) ?? "",
    headRefName: str(raw.headRefName),
    baseRefName: str(raw.baseRefName),
    author: (raw.author as Record<string, unknown> | null | undefined)?.login as string | undefined,
    mergeable:
      mergeable === "TRUE" || mergeable === "FALSE" || mergeable === "UNKNOWN" ? mergeable : null,
    mergeStateStatus: typeof mergeState === "string" ? mergeState : null,
    labels,
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
  };
}

/** glab `mr view --output json` (snake_case) → NormalizedPullRequest. */
export function mapGlMr(raw: Record<string, unknown>): NormalizedPullRequest {
  const labels = Array.isArray(raw.labels) ? (raw.labels as unknown[]).map(mapGlIssueLabel) : [];
  const state = req<string>(raw, "state", "glab mr view").toLowerCase();
  return {
    number: req<number>(raw, "iid", "glab mr view"),
    title: str(raw.title) ?? "",
    body: str(raw.description) ?? "",
    state: (state === "opened"
      ? "OPEN"
      : state === "merged"
        ? "MERGED"
        : state === "closed"
          ? "CLOSED"
          : state.toUpperCase()) as NormalizedPullRequest["state"],
    url: str(raw.web_url) ?? "",
    headRefName: str(raw.source_branch),
    baseRefName: str(raw.target_branch),
    author: (raw.author as Record<string, unknown> | null | undefined)?.username as
      | string
      | undefined,
    // GitLab's view payload does not carry a mergeable/mergeStateStatus pair
    // — readiness is composed separately (see forge-merge.ts).
    mergeable: null,
    mergeStateStatus: null,
    labels,
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

// ── CI checks ─────────────────────────────────────────────────────────────

/** gh `pr checks --json name,state,bucket,isRequired` rows → NormalizedCICheck. */
export function mapGhChecks(rows: unknown): NormalizedCICheck[] {
  if (!Array.isArray(rows)) throw new ForgeFieldError("checks rows", "gh pr checks");
  return (rows as Record<string, unknown>[]).map((r) => {
    const state = (str(r.state) ?? "").toUpperCase();
    const bucket = str(r.bucket);
    // If the check is completed but the bucket is fail/error, the effective
    // state is FAIL (the state field is the check-run state, the bucket is
    // the pass/fail verdict).
    const effectiveState = state === "COMPLETED" && bucket ? bucket.toUpperCase() : state;
    return {
      name: str(r.name) ?? "(unnamed)",
      state: effectiveState,
      bucket: bucket?.toUpperCase(),
      isRequired: typeof r.isRequired === "boolean" ? r.isRequired : undefined,
    };
  });
}

/**
 * GitLab: `gh pr checks` has no direct equivalent. The forge.ts path lists
 * the MR's open pipeline and maps its jobs. `glab api /projects/:id/merge_requests/:iid`
 * exposes `.open_pipeline.id`, and `/pipelines/:pid` exposes the jobs via
 * `?per_page=100`. This mapper takes the pipeline's `jobs` rows.
 * Job `status` values (snake) → uppercased `state`; GitLab has no per-job
 * "required" concept, so `isRequired` is undefined.
 */
export function mapGlPipelineJobs(rows: unknown): NormalizedCICheck[] {
  if (!Array.isArray(rows)) throw new ForgeFieldError("pipeline jobs", "glab pipeline jobs");
  return (rows as Record<string, unknown>[]).map((j) => ({
    name: str(j.name) ?? "(unnamed)",
    state: (str(j.status) ?? "").toUpperCase(),
  }));
}

/** gh REST `run list` rows (snake_case: `database_id`, `head_branch`) → NormalizedCIRun. */
export function mapGhRun(raw: Record<string, unknown>): NormalizedCIRun {
  return {
    id: req<number>(raw, "database_id", "gh api run list"),
    name: str(raw.name),
    status: (str(raw.status) ?? "").toUpperCase(),
    conclusion: (str(raw.conclusion) ?? null)?.toUpperCase() ?? null,
    url: str(raw.url) ?? "",
    headBranch: str(raw.head_branch),
  };
}

/** glab `pipeline show --output json` / pipeline rows (snake_case) → NormalizedCIRun. */
export function mapGlPipeline(raw: Record<string, unknown>): NormalizedCIRun {
  return {
    id: req<number>(raw, "id", "glab pipeline"),
    name: str(raw.name),
    status: (str(raw.status) ?? "").toUpperCase(),
    conclusion: null,
    url: str(raw.web_url) ?? "",
    headBranch: str(raw.ref),
  };
}

// ── Repo settings ─────────────────────────────────────────────────────────

/** gh `repo view --json …` (camelCase) → NormalizedRepo. */
export function mapGhRepo(raw: Record<string, unknown>): NormalizedRepo {
  return {
    name: str((raw.nameWithOwner as string) ?? "") ?? "",
    owner: str((raw.nameWithOwner as string)?.split("/")[0]) ?? "",
    url: str(raw.url) ?? "",
    defaultBranch: ((raw.defaultBranchRef as Record<string, unknown> | null)?.name as string) ?? "",
    squashMergeAllowed: req<boolean>(raw, "squashMergeAllowed", "gh repo view"),
    mergeCommitAllowed: req<boolean>(raw, "mergeCommitAllowed", "gh repo view"),
    rebaseMergeAllowed: req<boolean>(raw, "rebaseMergeAllowed", "gh repo view"),
  };
}

/**
 * glab project row (snake_case) → NormalizedRepo.
 *
 * GitLab encodes merge capability in TWO enums:
 *   - `merge_method`: `merge_commit` | `fast_forward_merge` | `squash`
 *   - `squash_option`: `squash_and_commit` | `no_fast_forward` | `squash_by_default`
 * The normalized booleans are derived so a caller can ask "can I squash-merge?"
 * uniformly: squash is allowed iff the method is `squash` OR squash is
 * available alongside `merge_commit`/`fast_forward_merge` with a non-
 * `no_fast_forward` squash option.
 */
export function mapGlRepo(raw: Record<string, unknown>): NormalizedRepo {
  const pathWithNs = str(raw.path_with_namespace) ?? "";
  const mergeMethod = str(raw.merge_method) ?? "merge_commit";
  const squashOption = str(raw.squash_option) ?? "squash_and_commit";
  const squashAllowed = mergeMethod === "squash" || squashOption !== "no_fast_forward";
  return {
    name: pathWithNs,
    owner: pathWithNs.split("/")[0] ?? "",
    url: str(raw.web_url) ?? "",
    defaultBranch: str(raw.default_branch) ?? "",
    squashMergeAllowed: squashAllowed,
    mergeCommitAllowed: mergeMethod !== "squash",
    rebaseMergeAllowed: false,
    mergeMethod,
    squashOption,
  };
}
