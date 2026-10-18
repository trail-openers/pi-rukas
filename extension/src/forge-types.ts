/**
 * forge-types — normalized forge data model for the gh/glab adapter layer
 * (S2 of epic #608).
 *
 * Every operation in `forge.ts` returns these shapes regardless of which
 * forge is in use, so S4 (driver integration) never branches on field names.
 * The mapping between forge-native and normalized fields lives in
 * `forge-mapping.ts`; the types here define only the normalized side.
 */

import type { ForgeType } from "./forge-detect.ts";
import type { LabelListResult } from "./forge-label-ops.ts";

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
 * Options a filing may carry beyond the title and body (#1377).
 *
 * Declared in the types module so `Forge.issueCreate` can name it without an
 * import edge back to the plan layer: `plan-filing.ts` re-exports it for its
 * own callers, and the forge adapter stays free of plan-pipeline imports.
 */
export interface FileIssueOpts {
  /** Labels to create the issue with, in the one forge call. */
  labels?: string[];
}

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
  /** #1292 — a draft PR/MR. `undefined` when the forge's view did not say. */
  isDraft?: boolean;
  labels: NormalizedLabel[];
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

/**
 * A single status check. State is uppercased per the gh convention.
 *
 * There is deliberately no required/optional flag: `gh pr checks --json`
 * does not expose one (`isRequired` is not a field the subcommand supports,
 * and requesting it made every merge-evidence read fail closed — #745), and
 * GitLab has no per-job equivalent. Readiness is decided by the forge's own
 * authoritative signal (GitHub `mergeStateStatus`; GitLab the composed
 * `detailed_merge_status` in `forge-merge.ts`), which already encodes each
 * repo's required-check rules; the per-check rows only name what is
 * failing/pending/skipped.
 */
export interface NormalizedCICheck {
  name: string;
  /** Uppercased state (gh: `COMPLETE/IN_PROGRESS/QUEUED...`, glab pipeline job states uppercased). */
  state: string;
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
 * A normalized issue/PR comment (note). `url` is the web URL of the note
 * (GitHub: the canonical `…#issuecomment-<id>` form, usable as-is; GitLab:
 * the note's `web_url`). `id` is undefined where the forge does not expose
 * a stable numeric id in the list payload.
 */
export interface NormalizedComment {
  id: number | undefined;
  body: string;
  url: string | undefined;
  createdAt: string | undefined;
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

// ── The adapter's operation surface ────────────────────────────────────────
//
// The `Forge` interface moved here from forge.ts (#1398, the 500-line gate) so
// the adapter's data model and its operation surface are documented in one
// place; forge.ts imports it and re-exports it for existing importers.

/**
 * The exec seam — the same shape as the driver's `VerifyExecFn`. Declared here
 * so the interface below is self-contained; forge.ts re-exports it.
 */
export type ForgeExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

export interface CiWatchOpts {
  /** Poll interval in ms (default 30_000). */
  pollMs?: number;
  /** Overall timeout in ms (default 30 min = 1_800_000). */
  timeoutMs?: number;
  /** Injectable clock (default `Date.now`). For tests. */
  now?: () => number;
  /** Injectable sleep (default `setTimeout`-based). For tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type CiWatchResult =
  | { ok: true; run: NormalizedCIRun; terminal: boolean; timedOut: false }
  | { ok: true; run: NormalizedCIRun | undefined; terminal: false; timedOut: true };

/**
 * The adapter's operation surface: one method per forge operation, returning
 * the normalized shapes above regardless of which forge is in use. `unknown`
 * rejects every operation (the forge could not be resolved).
 */
export interface Forge {
  /** The resolved forge type (`unknown` → every operation rejects). */
  forge: ForgeType;
  /** The resolved host (from S1). */
  host: string | undefined;
  /** The owner (first path segment of the remote URL). */
  owner: string;
  /** The repo (last path segment of the remote URL). */
  repo: string;
  /** The repo root the commands run in. */
  cwd: string;

  // Issues
  issueView(number: number): Promise<NormalizedIssue>;
  /**
   * #1377 — labels to create the issue with, passed to the create call so the
   * issue carries them from its first moment. This is the ONLY label channel:
   * the adapter deliberately has no construction-time `labels` field, which
   * would be a second source that could disagree with the per-call one (and
   * quietly win). `opts` is optional and its default is what keeps every
   * existing `issueCreate(title, body)` call site — and every test stub cast to
   * `Forge` — compiling and behaving unchanged.
   */
  issueCreate(title: string, body: string, opts?: FileIssueOpts): Promise<NormalizedIssue>;
  issueEdit(number: number, body: string): Promise<NormalizedIssue>;
  issueComment(number: number, body: string): Promise<string>;
  /** #775 — list the issue's comments (idempotency check before re-posting). */
  issueComments(number: number): Promise<NormalizedComment[]>;
  /** `allStates` (#1471) searches closed issues too; the default is open ones only. */
  issueSearch(query: string, opts?: { allStates?: boolean }): Promise<NormalizedIssue[]>;

  // Pull requests / MRs
  prView(number: number): Promise<NormalizedPullRequest>;
  prList(opts?: { state?: string; sourceBranch?: string }): Promise<NormalizedPullRequest[]>;
  prCreate(
    title: string,
    headBranch: string,
    body: string,
    opts?: { baseBranch?: string; draft?: boolean },
  ): Promise<NormalizedPullRequest>;
  /** #1292 — mark a draft PR/MR ready for review (idempotent on a ready one). */
  prReady(number: number): Promise<void>;
  /**
   * #1398 — put the cycle's own PR/MR back to draft (the inverse of
   * `prReady`, so a review that runs again after the PR was marked ready is
   * never running on a mergeable PR). Rejects on a non-zero exit — the
   * re-arm treats that as a halt, never a no-op.
   */
  prDraft(number: number): Promise<void>;
  prMerge(
    number: number,
    method?: "squash" | "merge" | "rebase",
    subject?: string,
  ): Promise<string>;
  prDiff(number: number): Promise<string>;
  prChecks(number: number): Promise<NormalizedCICheck[]>;
  /** #775 — list the PR/MR's review comments (the seam for PR handoff posts). */
  prComments(number: number): Promise<NormalizedComment[]>;
  /** #775 — post a comment on the PR (the in-process handoff fallback seam). */
  prComment(number: number, body: string): Promise<string>;

  // CI
  ciWatch(runId: number, opts?: CiWatchOpts): Promise<CiWatchResult>;
  ciRun(id: number): Promise<NormalizedCIRun>;

  // Merge readiness (SAFETY-CRITICAL)
  mergeReadiness(number: number, opts?: { maxBuffer?: number }): Promise<MergeReadinessResult>;

  // Labels
  /**
   * #1377 — the repo's label NAMES and whether the read may have stopped at a
   * page boundary, for the pre-filing existence check. Returns `{ names: [],
   * truncated: false }` for a repo with no labels; THROWS when the CLI output is
   * not a JSON array, so an unreadable list can never read as "these labels
   * don't exist". See `LabelListResult` in `forge-label-ops.ts`.
   */
  labelList(): Promise<LabelListResult>;
  labelCreate(name: string, color: string): Promise<NormalizedLabel | undefined>;
  labelAdd(target: "issue" | "mr", number: number, name: string): Promise<void>;
  labelRemove(target: "issue" | "mr", number: number, name: string): Promise<void>;

  // Repo settings
  repoSettings(): Promise<NormalizedRepo>;
}
