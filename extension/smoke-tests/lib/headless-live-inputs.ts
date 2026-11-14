/**
 * lib/headless-live-inputs — the roster of `HEADLESS_INPUTS` entries whose
 * listed default is checked against its live reader by
 * `test-headless-inputs.ts`, extracted from that gate the same way
 * `lib/pi-read-sites.ts` and `lib/verify-tier-pin.ts` were, so the gate stays
 * under the AGENTS.md §12 size cap.
 *
 * The gate iterates this roster with the environment cleared and asserts each
 * reader's answer equals the entry's `default`; a name listed here that is
 * missing from `HEADLESS_INPUTS` fails there as loudly as one listed in the
 * gate itself. `SWITCHES` names, per entry, the master switch that would
 * override that dimension's own default, so the same loop clears it too.
 *
 * Adding a knob: add its reader import, its `LIVE_INPUTS` row, and (only when
 * a master switch gates it) a `SWITCHES` row. A boolean switch whose truth
 * table and docs row have their own test file (e.g.
 * `test-lean-issue-prose-switch.ts`) still needs its row here — that file
 * pins the truth table, this roster pins the default.
 */
import { adversarialPhaseBudgetMs } from "../../src/adversarial-retry.ts";
import { childCodemodeEnabled } from "../../src/child-codemode.ts";
import { commentRetentionEnabled } from "../../src/comment-retention.ts";
import { COMMENT_RETENTION_PATHS } from "../../src/comment-retention.ts";
import { hostSpawnCap, hostSpawnWaitMs } from "../../src/host-spawn-slots.ts";
import { claimScanEnabled, evidenceSupplyEnabled } from "../../src/lens-evidence.ts";
import { lensRoundCap } from "../../src/lens-round-cap.ts";
import { loopDetectorEnabled } from "../../src/loop-detector.ts";
import { roundCapMergeEnabled } from "../../src/merge-guard-round-cap.ts";
import { pendingShutdownBoundMs } from "../../src/pending-jobs-signal.ts";
import { planCacheTtlMs } from "../../src/plan-investigation-cache.ts";
import { lensFixBoundMs, reviewCapMs, reviewWallClockMs } from "../../src/review-budget.ts";
import { lensFixLandAheadEnabled } from "../../src/work-driver-lens-fix-bound-land.ts";
import { transcriptRetentionDays } from "../../src/runs-retention.ts";
import { autoSteerEnabled } from "../../src/slow-notice.ts";
import { slowThresholds } from "../../src/slow-notice.ts";
import {
  childBoundGraceMs,
  developChildBoundMs,
  exploreChildBoundMs,
  lensChildBoundMs,
  settledReapMs,
} from "../../src/spawn-child-bound.ts";
import { adversarialChildBoundMs, reviewSkillReadCap } from "../../src/review-bounds.ts";
import { spawnCap } from "../../src/spawn-semaphore.ts";
import {
  inactivityTimeoutMs,
  spawnBackstopMs,
  toolInactivityTimeoutMs,
} from "../../src/spawn-support.ts";
import { capKillGraceMs } from "../../src/spawn-token-budget.ts";
import { acceptanceCoverageEnabled } from "../../src/work-driver-acceptance-coverage.ts";
import { integrationVerifyTimeoutMs } from "../../src/work-driver-commit-title.ts";
import { convergeGateEnabled } from "../../src/work-driver-converge.ts";
import { protectedPathsEnabled } from "../../src/work-driver-doctrine.ts";
import { transientRetryEnabled } from "../../src/work-driver-failure-taxonomy.ts";
import {
  burstThresholdSeconds,
  providerRetryFloorMs,
  providerRetryMaxWaitMs,
  transientRetryBackoffMs,
} from "../../src/work-driver-failure-taxonomy.ts";
import { resolvedParallelGroups } from "../../src/work-driver-grouping.ts";
import { handoffChannel } from "../../src/work-driver-handoff-channel.ts";
import { handoffPostRetryEnabled } from "../../src/work-driver-handoff-post-retry.ts";
import { handoffPostBackoffMs } from "../../src/work-driver-handoff-post-retry.ts";
import { handoffDispatchTimeoutMs } from "../../src/work-driver-handoff.ts";
import { intentCriticalityEnabled } from "../../src/work-driver-intent-criticality.ts";
import { intentResolutionEnabled } from "../../src/work-driver-intent.ts";
import {
  leanBuildIssueProseEnabled,
  leanIssueProseEnabled,
} from "../../src/lean/issue-prose.ts";
import { leanReviewSpecSplitEnabled } from "../../src/lean/review-spec-split.ts";
import { leanRunnerPreflightEnabled } from "../../src/lean/runner-preflight-switch.ts";
import { leanHandbackNoHeadRecordEnabled, leanVerifiedHandbackEnabled } from "../../src/lean/verified-handback-switch.ts";
import { leanDeadlineHandbackEnabled } from "../../src/lean/deadline-handback.ts";
import { issueImagesEnabled } from "../../src/work-driver-issue-images.ts";
import { mergeAuthorityEnabled } from "../../src/work-driver-merge-authority.ts";
import { NET_GIT_TIMEOUT_DEFAULT_MS } from "../../src/work-driver-net-git.ts";
import { crossGroupConflictsEnabled } from "../../src/work-driver-path-claims.ts";
import { planContractEnabled } from "../../src/work-driver-plan-contract.ts";
import { planQualityEnabled } from "../../src/work-driver-plan-helpers.ts";
import { planDispatchTimeoutMs } from "../../src/work-driver-plan-helpers.ts";
import { maxWorkstreams } from "../../src/work-driver-plan-workstreams.ts";
import { policyJudgeEnabled } from "../../src/work-driver-policy.ts";
import { prPreflightEnabled } from "../../src/work-driver-pr-preflight.ts";
import { resumeEnabled, sessionReattachEnabled } from "../../src/work-driver-resume.ts";
import { stepNoticeThresholdMs } from "../../src/work-driver-step-notice.ts";
import { testDeleteTolerance } from "../../src/work-driver-verify-develop-helpers.ts";
import { verifyTimeoutMs } from "../../src/work-driver-verify-budget.ts";
import { queueOrderingEnabled } from "../../src/work-queue-scheduler.ts";
import { queueDeferCapMs, queueHaltOnFailure } from "../../src/work-queue.ts";
import { tierDefaultReader } from "./verify-tier-pin.ts";

/** Each entry's name and the live reader its listed default must equal. */
export const LIVE_INPUTS: [string, () => unknown][] = [
  ["PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS", adversarialPhaseBudgetMs],
  ["PI_ENSEMBLE_CAP_KILL_GRACE_MS", capKillGraceMs],
  ["PI_ENSEMBLE_CHILD_BOUND_GRACE_MS", childBoundGraceMs],
  ["PI_ENSEMBLE_DEVELOP_BOUND_MS", developChildBoundMs],
  ["PI_ENSEMBLE_EXPLORE_BOUND_MS", exploreChildBoundMs],
  ["PI_ENSEMBLE_SETTLED_REAP_MS", settledReapMs],
  ["PI_ENSEMBLE_LENS_BOUND_MS", lensChildBoundMs],
  // #1742 — the per-lens-fix-dispatch caller ceiling.
  ["PI_ENSEMBLE_LENS_FIX_BOUND_MS", () => lensFixBoundMs()],
  // #1779 — the escape hatch for the lens-fix partial-fix conversion (a bound
  // kill that committed HALTs instead of converting to a partial fix).
  ["PI_ENSEMBLE_LENS_FIX_LAND_AHEAD", () => lensFixLandAheadEnabled()],
  ["PI_ENSEMBLE_COMMENT_RETENTION_PATHS", () => COMMENT_RETENTION_PATHS.join(",")],
  ["PI_ENSEMBLE_GIT_NET_TIMEOUT_MS", () => NET_GIT_TIMEOUT_DEFAULT_MS],
  ["PI_ENSEMBLE_HANDOFF_CHANNEL", handoffChannel],
  ["PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS", handoffPostBackoffMs],
  ["PI_ENSEMBLE_HANDOFF_TIMEOUT_MS", handoffDispatchTimeoutMs],
  ["PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS", inactivityTimeoutMs],
  ["PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS", integrationVerifyTimeoutMs],
  ["PI_ENSEMBLE_LENS_ROUND_CAP", () => lensRoundCap()],
  ["PI_ENSEMBLE_MAX_WORKSTREAMS", maxWorkstreams],
  ["PI_ENSEMBLE_PARALLEL_GROUPS", resolvedParallelGroups],
  ["PI_ENSEMBLE_PENDING_SHUTDOWN_MS", pendingShutdownBoundMs],
  ["PI_ENSEMBLE_PLAN_CACHE_TTL_MS", planCacheTtlMs],
  ["PI_ENSEMBLE_PLAN_TIMEOUT_MS", planDispatchTimeoutMs],
  // #1243 — the provider-class backoff floor and its total bound.
  ["PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS", providerRetryFloorMs],
  ["PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS", providerRetryMaxWaitMs],
  ["PI_ENSEMBLE_RATE_LIMIT_BURST_MAX_S", burstThresholdSeconds],
  ["PI_ENSEMBLE_SLOW_NOTICE_MS", () => slowThresholds().ms],
  ["PI_ENSEMBLE_SLOW_NOTICE_TOKENS", () => slowThresholds().tokens],
  ["PI_ENSEMBLE_SLOW_NOTICE_TURNS", () => slowThresholds().turns],
  ["PI_ENSEMBLE_SPAWN_CAP", spawnCap],
  ["PI_ENSEMBLE_HOST_SPAWN_CAP", hostSpawnCap],
  ["PI_ENSEMBLE_HOST_SPAWN_WAIT_MS", hostSpawnWaitMs],
  ["PI_ENSEMBLE_SPAWN_TIMEOUT_MS", spawnBackstopMs],
  ["PI_ENSEMBLE_STEP_NOTICE_MS", stepNoticeThresholdMs],
  ["PI_ENSEMBLE_TEST_DELETE_TOLERANCE", testDeleteTolerance],
  ["PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS", toolInactivityTimeoutMs],
  ["PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS", transcriptRetentionDays],
  ["PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS", transientRetryBackoffMs],
  ["PI_ENSEMBLE_VERIFY_TIMEOUT_MS", verifyTimeoutMs],
  // #1509 — each tier's documented default is checked against the live reader
  // with the environment cleared, so a default that drifts from
  // `work-driver-verify-budget.ts` fails here rather than in the handoff of
  // some later cycle.
  ["PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS", tierDefaultReader("suite")],
  ["PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS", tierDefaultReader("fast")],
  ["PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS", tierDefaultReader("smoke")],
  ["PI_ENSEMBLE_ACCEPTANCE_COVERAGE", acceptanceCoverageEnabled],
  ["PI_ENSEMBLE_AUTO_STEER", autoSteerEnabled],
  ["PI_ENSEMBLE_CHILD_CODEMODE", childCodemodeEnabled],
  ["PI_ENSEMBLE_CLAIM_SCAN", claimScanEnabled],
  ["PI_ENSEMBLE_COMMENT_RETENTION", commentRetentionEnabled],
  ["PI_ENSEMBLE_CONVERGE", convergeGateEnabled],
  ["PI_ENSEMBLE_CROSS_GROUP_CONFLICTS", crossGroupConflictsEnabled],
  ["PI_ENSEMBLE_HANDOFF_POST_RETRY", handoffPostRetryEnabled],
  ["PI_ENSEMBLE_INTENT", intentResolutionEnabled],
  ["PI_ENSEMBLE_INTENT_CRITICALITY", intentCriticalityEnabled],
  // #2171 — the oracle seat's issue-prose section. The reader is `v !== "0"`,
  // so the gate's LIVE loop (env deleted) pins "unset means on".
  ["PI_ENSEMBLE_LEAN_ISSUE_PROSE", leanIssueProseEnabled],
  // #2228 — the builder seat's issue-prose section. The reader is `v !== "0"`, so
  // the gate's LIVE loop (env deleted) pins "unset means on".
  ["PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE", leanBuildIssueProseEnabled],
  // The lean review seats' spec split. The reader is `v !== "0"`, so the LIVE
  // assertion in the gate (env deleted) pins "unset means on".
  ["PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT", leanReviewSpecSplitEnabled],
  // #2212 — #2179's preflight/submodule behaviour. The reader is `v !== "0"`, so
  // the gate's LIVE loop (env deleted) pins "unset means on".
  ["PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT", leanRunnerPreflightEnabled],
  // The verified-handback rule. The reader is `v !== "0"`, so the gate's LIVE
  // loop (env deleted) pins "unset means on".
  ["PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK", leanVerifiedHandbackEnabled],
  ["PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK", leanDeadlineHandbackEnabled],
  ["PI_ENSEMBLE_LEAN_HANDBACK_NOHEAD_RECORD", leanHandbackNoHeadRecordEnabled],
  ["PI_ENSEMBLE_ISSUE_IMAGES", () => issueImagesEnabled()],
  ["PI_ENSEMBLE_LENS_EVIDENCE", evidenceSupplyEnabled],
  ["PI_ENSEMBLE_LENS_ROUND_CAP_MERGE", roundCapMergeEnabled],
  ["PI_ENSEMBLE_LOOP_DETECTOR", loopDetectorEnabled],
  ["PI_ENSEMBLE_MERGE_AUTHORITY", mergeAuthorityEnabled],
  ["PI_ENSEMBLE_PLAN_CONTRACT", planContractEnabled],
  ["PI_ENSEMBLE_PLAN_QUALITY", planQualityEnabled],
  ["PI_ENSEMBLE_POLICY_JUDGE", policyJudgeEnabled],
  ["PI_ENSEMBLE_PR_PREFLIGHT", prPreflightEnabled],
  ["PI_ENSEMBLE_PROTECTED_PATHS", protectedPathsEnabled],
  ["PI_ENSEMBLE_QUEUE_DEFER_CAP_MS", () => queueDeferCapMs()],
  ["PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE", queueHaltOnFailure],
  ["PI_ENSEMBLE_QUEUE_ORDERING", queueOrderingEnabled],
  ["PI_ENSEMBLE_RESUME", resumeEnabled],
  ["PI_ENSEMBLE_REVIEW_CAP_MS", () => reviewCapMs()],
  // #1827 — the two reviewer bounds. Both are gated on the dispatch-caps master
  // switch, so SWITCHES clears that too: a headless run must resolve the same
  // numbers the live readers do with the caps on, not the ones it sees with them
  // off.
  ["PI_ENSEMBLE_REVIEW_SKILL_READS", reviewSkillReadCap],
  ["PI_ENSEMBLE_ADVERSARIAL_BOUND_MS", adversarialChildBoundMs],
  ["PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS", () => reviewWallClockMs()],
  ["PI_ENSEMBLE_SESSION_REATTACH", sessionReattachEnabled],
  ["PI_ENSEMBLE_TRANSIENT_RETRY", transientRetryEnabled],
];

/** The switch that would override a dimension's own default is cleared too. */
export const SWITCHES: Record<string, string> = {
  PI_ENSEMBLE_LOOP_DETECTOR: "PI_ENSEMBLE_DISPATCH_CAPS",
  PI_ENSEMBLE_REVIEW_SKILL_READS: "PI_ENSEMBLE_DISPATCH_CAPS",
  PI_ENSEMBLE_ADVERSARIAL_BOUND_MS: "PI_ENSEMBLE_DISPATCH_CAPS",
  PI_ENSEMBLE_PARALLEL_GROUPS: "PI_ENSEMBLE_PARALLEL_WORK",
  PI_ENSEMBLE_SLOW_NOTICE_MS: "PI_ENSEMBLE_SLOW_NOTICE",
  PI_ENSEMBLE_SLOW_NOTICE_TOKENS: "PI_ENSEMBLE_SLOW_NOTICE",
  PI_ENSEMBLE_SLOW_NOTICE_TURNS: "PI_ENSEMBLE_SLOW_NOTICE",
};
