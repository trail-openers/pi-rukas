/**
 * forge-types — normalized forge data model for the gh/glab adapter layer
 * (S2 of epic #608).
 *
 * Every operation in `forge.ts` returns these shapes regardless of which
 * forge is in use, so S4 (driver integration) never branches on field names.
 * The mapping between forge-native and normalized fields lives in
 * `forge-mapping.ts`; the types here define only the normalized side.
 */

/** Issue state, normalized across forges (gh `OPEN/CLOSED`, glab `opened/closed`). */
export type IssueState = "OPEN" | "CLOSED";

/** PR/MR state, normalized across forges (gh `OPEN/MERGED/CLOSED`, glab `opened/merged/closed`). */
export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";

/**
 * Merge readiness, composed per forge (see `checkMergeReadiness` in
 * `forge-merge.ts`). `UNKNOWN` means "not yet determinable" — the caller
 * decides whether to retry; unreadable fields never map to UNKNOWN here,
 * they surface as `{ ok: false }`.
 */
export type MergeReadiness = "CLEAN" | "DIRTY" | "UNKNOWN";

/**
 * A normalized issue. Field names follow the GitHub `gh --json` convention
 * (which is also git-pkgs/forge's normalized vocabulary); the GitLab side
 * maps `iid → number`, `description → body`, `web_url → url`.
 */
export interface NormalizedIssue {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  url: string;
  author: string | undefined;
  labels: NormalizedLabel[];
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

/**
 * A normalized pull/MR. `headRefName` is the normalized head branch name
 * (gh GraphQL field; GitLab maps `source_branch` into it).
 */
export interface NormalizedPullRequest {
  number: number;
  title: string;
  body: string;
  state: PullRequestState;
  url: string;
  headRefName: string | undefined;
  baseRefName: string | undefined;
  author: string | undefined;
  /** GitHub: `mergeable` (TRUE/FALSE/UNKNOWN). GitLab: null (unavailable on list/view). */
  mergeable: "TRUE" | "FALSE" | "UNKNOWN" | null;
  /** GitHub: `mergeStateStatus` (CLEAN/DIRTY/BLOCKED/...). GitLab: null (composed instead). */
  mergeStateStatus: string | null;
  labels: NormalizedLabel[];
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

/** A single status check. State is uppercased per the gh convention. */
export interface NormalizedCICheck {
  name: string;
  /** Uppercased state (gh: `COMPLETE/IN_PROGRESS/QUEUED...`, glab pipeline job states uppercased). */
  state: string;
  /** Whether the check is required (gh `isRequired`). GitLab: undefined when unknown. */
  isRequired?: boolean;
  /** Bucket when the forge reports one (gh: `pass/fail/pending/warning...`). */
  bucket?: string;
  url?: string;
}

/**
 * A normalized CI run/pipeline. `conclusion` is undefined while the run is
 * still in flight; `status` is the forge's run-level state, uppercased.
 */
export interface NormalizedCIRun {
  id: number;
  name: string | undefined;
  /** Upper status: RUNNING, SUCCESS, FAILURE, CANCELED, SKIPPED, PENDING, QUEUED, MANUAL... */
  status: string;
  /** Terminal outcome, once decided: SUCCESS, FAILURE, CANCELED, NEUTRAL, SKIPPED, TIMED_OUT... */
  conclusion: string | null;
  url: string;
  headBranch: string | undefined;
}

/** A normalized label. `id` is undefined on GitLab (labels are keyed by name there). */
export interface NormalizedLabel {
  name: string;
  id: number | undefined;
  color: string | undefined;
  description: string | undefined;
}

/**
 * Normalized repository settings relevant to merging. GitHub exposes three
 * independent booleans; GitLab exposes a merge-method enum plus a separate
 * squash enum. Both are surfaced here so callers can be forge-agnostic.
 */
export interface NormalizedRepo {
  name: string;
  owner: string;
  url: string;
  defaultBranch: string;
  squashMergeAllowed: boolean;
  mergeCommitAllowed: boolean;
  rebaseMergeAllowed: boolean;
  /**
   * GitLab-only: the merge-method enum value from the project
   * (`merge_method`: merge_commit / fast_forward_merge / squash).
   * undefined on GitHub.
   */
  mergeMethod?: string;
  /** GitLab-only: squash_option (squash_by_default / squash_and_commit / no_fast_forward). */
  squashOption?: string;
}

/**
 * Merge-readiness result. FAIL-CLOSED contract: any unreadable field, API
 * error, or unknown `detailed_merge_status` value yields `ok: false` —
 * never a guess. `ok: true` means every input field was read AND mapped.
 */
export type MergeReadinessResult =
  | { ok: true; readiness: MergeReadiness; detail: string; checks: NormalizedCICheck[] }
  | { ok: false; reason: string; checks: NormalizedCICheck[] };
