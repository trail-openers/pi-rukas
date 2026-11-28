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
import { adversarialVerdictReaskEnabled } from "../../src/adversarial-verdict-reask.ts";
import { childCodemodeEnabled, childCodemodeWorkersEnv } from "../../src/child-codemode.ts";
import { commentRetentionEnabled } from "../../src/comment-retention.ts";
import { COMMENT_RETENTION_PATHS } from "../../src/comment-retention.ts";
import { leanFixerTruncationReaskEnabled } from "../../src/fixer-truncation.ts";
import { forgeReadOffGuardEnabled } from "../../src/forge-read-off-switch.ts";
import { glabMrCreateArgvEnabled } from "../../src/gl-mr-create-switch.ts";
import { hostSpawnCap, hostSpawnWaitMs } from "../../src/host-spawn-slots.ts";
import { leanStepDeadlineBoundEnabled } from "../../src/lean-step-deadline-bound-switch.ts";
// #2661 — a wasted build turn's one re-ask. Its truth table is pinned by
// test-lean-build-reask-pure.ts, its dispatch arms by test-lean-build-reask.ts and its off-arm
// byte-identity by test-lean-build-reask-off-arm.ts.
import { leanBuildReaskEnabled } from "../../src/build-reask.ts";
import { leanDetectVerifyEnabled } from "../../src/lean/config-detect.ts";
import { leanFullTierOperandEnabled } from "../../src/lean/full-tier-operand-switch.ts";
import { leanPreVerifySharePercent } from "../../src/lean/pre-verify-share-switch.ts";
import { leanPreflightProbeContainEnabled } from "../../src/lean/preflight-probe-switch.ts";
import { leanProjectRosterEnabled } from "../../src/lean/project-roster-switch.ts";
import { leanPrefixHeadEnabled } from "../../src/lean/review-log.ts";
import { leanRunnerPreflightEnabled } from "../../src/lean/runner-preflight-switch.ts";
import { leanSpecifyGapHandbackEnabled } from "../../src/lean/specify-gap-switch.ts";
import { leanSpecifyPreservesEnabled } from "../../src/lean-specify-preserves-switch.ts";
import { leanOracleRepairEnabled } from "../../src/lean-oracle-repair-switch.ts";
import { leanSpecifyReaskEnabled } from "../../src/lean/specify-reask.ts";
import { claimScanEnabled, evidenceSupplyEnabled } from "../../src/lens-evidence.ts";
import { lensLargeDiffEnabled } from "../../src/lens-large-diff-switch.ts";
import { lensIncompleteForcesFull } from "../../src/lens-review-incomplete-switch.ts";
import { lensRoundCap } from "../../src/lens-round-cap.ts";
import { loopDetectorEnabled } from "../../src/loop-detector.ts";
import { roundCapMergeEnabled } from "../../src/merge-guard-round-cap.ts";
import { pendingShutdownBoundMs } from "../../src/pending-jobs-signal.ts";
import { planCacheTtlMs } from "../../src/plan-investigation-cache.ts";
// #2644 — the bound on ONE model request inside a lean step; the reader sits at `src/`'s top level
// because the lever is spawn policy, not engine state.
import { leanRequestStallEnabled } from "../../src/request-stall-policy.ts";
import { leanReviewIncompleteHeadEnabled } from "../../src/lean-review-incomplete-head-switch.ts";
import {
  developerBashBoundSeconds,
  reviewBashBoundSeconds,
} from "../../src/review-bash-timeout.ts";
import { adversarialChildBoundMs, reviewSkillReadCap } from "../../src/review-bounds.ts";
import { lensFixBoundMs, reviewCapMs, reviewWallClockMs } from "../../src/review-budget.ts";
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
import { spawnCap } from "../../src/spawn-semaphore.ts";
import {
  inactivityTimeoutMs,
  spawnBackstopMs,
  toolInactivityTimeoutMs,
} from "../../src/spawn-support.ts";
import { capKillGraceMs } from "../../src/spawn-token-budget.ts";
import { changedPathRulesEnabled } from "../../src/verify-select-changed-paths-switch.ts";
import { acceptanceCoverageEnabled } from "../../src/work-driver-acceptance-coverage.ts";
import { integrationVerifyTimeoutMs } from "../../src/work-driver-commit-title.ts";
import { convergeGateEnabled } from "../../src/work-driver-converge.ts";
import { protectedPathsEnabled } from "../../src/work-driver-doctrine.ts";
import { exploreReaskBoundMs } from "../../src/work-driver-explore-reask.ts";
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
import { issueImagesEnabled } from "../../src/work-driver-issue-images.ts";
import { lensFixLandAheadEnabled } from "../../src/work-driver-lens-fix-bound-land.ts";
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
import { timeoutFlagPrecedenceEnabled } from "../../src/work-driver-timeout-flag-precedence-switch.ts";
import { verifyTimeoutMs } from "../../src/work-driver-verify-budget.ts";
import { verifyPytestDisabled } from "../../src/work-driver-verify-cmd.ts";
import { verifyCommandCriteriaEnabled } from "../../src/work-driver-verify-develop-command-criteria.ts";
import { testDeleteTolerance } from "../../src/work-driver-verify-develop-helpers.ts";
import {
  verifyProvenanceEnabled,
  verifyProvenanceProseEnabled,
} from "../../src/work-driver-verify-develop-provenance.ts";
import { verifyHeartbeatMs } from "../../src/work-driver-verify-heartbeat.ts";
import { queueOrderingEnabled } from "../../src/work-queue-scheduler.ts";
import { queueDeferCapMs, queueHaltOnFailure } from "../../src/work-queue.ts";
import { tierDefaultReader } from "./verify-tier-pin.ts";

/** Each entry's name and the live reader its listed default must equal. */
export const LIVE_INPUTS: [string, () => unknown][] = [
  ["PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS", adversarialPhaseBudgetMs],
  ["PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK", adversarialVerdictReaskEnabled],
  ["PI_ENSEMBLE_CAP_KILL_GRACE_MS", capKillGraceMs],
  ["PI_ENSEMBLE_CHILD_BOUND_GRACE_MS", childBoundGraceMs],
  ["PI_ENSEMBLE_DEVELOP_BOUND_MS", developChildBoundMs],
  // #2377 — the per-call bash bound a developer child carries. The reader returns
  // SECONDS (Pi's bash schema unit) while the entry lists MILLISECONDS, and the
  // gate compares them for equality, so the reader is adapted here the way the
  // `() => NET_GIT_TIMEOUT_DEFAULT_MS` row adapts a ms constant: the value it
  // returns IS what an unset/empty knob yields, in the entry's own unit.
  ["PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS", () => developerBashBoundSeconds()! * 1000],
  ["PI_ENSEMBLE_EXPLORE_BOUND_MS", exploreChildBoundMs],
  // #2611 — the bound on the ONE same-session explore re-ask.
  ["PI_ENSEMBLE_EXPLORE_REASK_BOUND_MS", exploreReaskBoundMs],
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
  // The verify gate's heartbeat interval: pinned against its own reader with the
  // environment cleared, so a documented default that drifts from the resolver
  // fails here rather than in a host whose stall rule stopped trusting the line.
  ["PI_ENSEMBLE_VERIFY_HEARTBEAT_MS", verifyHeartbeatMs],
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
  [
    "PI_ENSEMBLE_CHILD_CODEMODE_MAX_WORKERS",
    () => Number(childCodemodeWorkersEnv().PI_CODEMODE_MAX_WORKERS),
  ],
  ["PI_ENSEMBLE_CLAIM_SCAN", claimScanEnabled],
  ["PI_ENSEMBLE_COMMENT_RETENTION", commentRetentionEnabled],
  ["PI_ENSEMBLE_CONVERGE", convergeGateEnabled],
  ["PI_ENSEMBLE_CROSS_GROUP_CONFLICTS", crossGroupConflictsEnabled],
  ["PI_ENSEMBLE_HANDOFF_POST_RETRY", handoffPostRetryEnabled],
  ["PI_ENSEMBLE_INTENT", intentResolutionEnabled],
  ["PI_ENSEMBLE_INTENT_CRITICALITY", intentCriticalityEnabled],
  // #2202 — the probe parent's containment check. The reader is `v !== "0"`, so the
  // gate's LIVE loop (env deleted) pins "unset means on". (#2439 retired the probe's
  // COLLECTABLE switch, keeping its default: `preflight-probe-switch.ts`.)
  ["PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_CONTAIN", leanPreflightProbeContainEnabled],
  // The lean review seats' spec split. The reader is `v !== "0"`, so the LIVE
  // assertion in the gate (env deleted) pins "unset means on".
  ["PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT", leanRunnerPreflightEnabled],
  // The specify re-ask for unsubmitted criteria; its arms are pinned by test-lean-specify-reask.ts.
  ["PI_ENSEMBLE_LEAN_SPECIFY_REASK", leanSpecifyReaskEnabled],
  // Default OFF: the reader is `v === "1"`, so the LIVE loop pins "unset means off".
  ["PI_ENSEMBLE_LEAN_DETECT_VERIFY", leanDetectVerifyEnabled],
  // The specify gap's handback. The reader is `v !== "0"`, so the gate's LIVE loop (env
  // deleted) pins "unset means on"; the truth table, docs row and both arms' goldens are
  // pinned by test-lean-specify-gap-handback.ts.
  ["PI_ENSEMBLE_LEAN_SPECIFY_GAP_HANDBACK", leanSpecifyGapHandbackEnabled],
  // The specify preservation declaration: its default is pinned here, its truth table, its off-arm
  // byte-identity and its docs row by `test-lean-specify-preserves.ts`.
  ["PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES", leanSpecifyPreservesEnabled],
  // The oracle repair round: its default is pinned here, its truth table and both arms by
  // `test-lean-build-blocked-repair.ts`. Read at run creation, so the gate's LIVE loop pins "unset means on".
  ["PI_ENSEMBLE_LEAN_ORACLE_REPAIR", leanOracleRepairEnabled],
  // The truncated-fixer continuation: its default is pinned here, its truth table by
  // `test-lean-review-fix-reask-pure.ts` and its off arm by
  // `test-lean-review-fixer-truncation-off-arm.ts`.
  // #2428 — `verify` judges the project's own pre-existing tests. The reader is
  // `v !== "0"`, so the gate's LIVE loop (env deleted) pins "unset means on"; the truth
  // table, the off arm's bytes and the docs row are pinned by
  // test-AC5-project-roster-switch.ts and test-AC7-project-roster-docs.ts.
  // The pre-verify share: its default is pinned here, its truth table, its inert arms and its
  // docs row by `test-lean-pre-verify-share-switch.ts`.
  ["PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE", leanPreVerifySharePercent],
  ["PI_ENSEMBLE_LEAN_PROJECT_ROSTER", leanProjectRosterEnabled],
  ["PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK", leanFixerTruncationReaskEnabled],
  ["PI_ENSEMBLE_LEAN_BUILD_REASK", leanBuildReaskEnabled],
  // The full-tier skip's trailing operand. The reader is `v !== "0"`, so the gate's LIVE loop (env
  // deleted) pins "unset means on"; the arms, the off-arm golden and the docs row are pinned by
  // test-2633-full-tier-relative-operand.ts.
  ["PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND", leanFullTierOperandEnabled],
  // #2199 — the review fix wave's saved pre-fix head; truth table and off arm in
  // test-lean-prefix-head.ts.
  ["PI_ENSEMBLE_LEAN_PREFIX_HEAD", leanPrefixHeadEnabled],
  // #2644 — the hung-request lever. The reader is `v !== "0"`, so the gate's LIVE loop (env deleted)
  // pins "unset means on"; the truth table, the docs row and the off arm are pinned by
  // test-lean-request-stall-switch.ts and test-lean-request-stall-off-arm.ts.
  ["PI_ENSEMBLE_LEAN_REQUEST_STALL", leanRequestStallEnabled],
  // #2660 — the deadline-derived lean child bound. The reader is `v !== "0"`, so the
  // gate's LIVE loop (env deleted) pins "unset means on"; the truth table, the docs row
  // and the byte-identity of `0` are pinned by test-lean-deadline-step-bound.ts.
  ["PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND", leanStepDeadlineBoundEnabled],
  // #2667 — a review that threw over a certified head hands that head back. The reader is
  // `v !== "0"`, so the gate's LIVE loop (env deleted) pins "unset means on"; the truth
  // table, the panel of throw sites and the off-arm bytes are pinned by
  // test-lean-review-incomplete-head.ts and test-lean-review-incomplete-head-off-arm.ts.
  ["PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD", leanReviewIncompleteHeadEnabled],
  ["PI_ENSEMBLE_ISSUE_IMAGES", () => issueImagesEnabled()],
  ["PI_ENSEMBLE_LENS_EVIDENCE", evidenceSupplyEnabled],
  // #2223 — the delta reader's incomplete-row rule. The reader is `v !== "0"`, so
  // the gate's LIVE loop (env deleted) pins "unset means on".
  ["PI_ENSEMBLE_LENS_INCOMPLETE_FULL", lensIncompleteForcesFull],
  // #2261 — the large-diff reads and the bounded lens prompt. The reader is
  // `v !== "0"`, so the gate's LIVE loop (env deleted) pins "unset means on"; the
  // truth table and the docs row are pinned by `test-lens-large-diff-switch.ts`.
  ["PI_ENSEMBLE_LENS_LARGE_DIFF", lensLargeDiffEnabled],
  ["PI_ENSEMBLE_LENS_ROUND_CAP_MERGE", roundCapMergeEnabled],
  // #2284 — the broker's forge-off refusal. The reader is `v !== "0"`, so the
  // gate's LIVE loop (env deleted) pins "unset means on"; the truth table, the
  // docs row and the call-time read are pinned by
  // test-forge-read-off-guard-switch.ts.
  ["PI_ENSEMBLE_FORGE_READ_OFF_GUARD", forgeReadOffGuardEnabled],
  // The `glab mr create` transport. The reader is `v !== "0"`, so the gate's LIVE
  // loop (env deleted) pins "unset means on"; the truth table, the off arm's
  // byte-identity and the docs row are pinned by test-glab-mr-create-argv.ts.
  ["PI_ENSEMBLE_GLAB_MR_CREATE", glabMrCreateArgvEnabled],
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
  // #2377 — the two per-call bash bounds, both arms of one `tool_call` hook.
  // Both read `PI_ENSEMBLE_DISPATCH_CAPS`, so SWITCHES clears it: a headless run
  // must resolve the same numbers the live readers do with the caps on.
  ["PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS", () => reviewBashBoundSeconds()! * 1000],
  ["PI_ENSEMBLE_ADVERSARIAL_BOUND_MS", adversarialChildBoundMs],
  ["PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS", () => reviewWallClockMs()],
  ["PI_ENSEMBLE_SESSION_REATTACH", sessionReattachEnabled],
  ["PI_ENSEMBLE_TRANSIENT_RETRY", transientRetryEnabled],
  // #2362 — whether `work-lean`'s `--timeout` outranks the host's exported budget. The
  // reader is `v !== "0"`, so the gate's LIVE loop (env deleted) pins "unset means on";
  // the truth table, both arms' arms, the one warning and the docs rows are pinned by
  // test-work-driver-timeout-flag-precedence-switch.ts.
  ["PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE", timeoutFlagPrecedenceEnabled],
  // #2283 — the two develop-gate tiers. Both readers are `v !== "0"`, so the gate's LIVE
  // loop (env deleted) pins "unset means on"; the truth tables and the docs rows are pinned
  // by test-verify-develop-switches.ts.
  ["PI_ENSEMBLE_VERIFY_PROVENANCE", verifyProvenanceEnabled],
  // #2295 — the prose arm of the same gate. Same reader shape (`!== "0"`), same reason for the
  // row: the LIVE loop deletes the env and pins that unset means on.
  ["PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE", verifyProvenanceProseEnabled],
  ["PI_ENSEMBLE_VERIFY_COMMAND_CRITERIA", verifyCommandCriteriaEnabled],
  // #2282 — the Python verify arm. The reader is `=== "0"`, so the gate's LIVE
  // loop (env deleted) pins "unset means on"; the truth table, the docs row and
  // the off-arm byte-identity are pinned by test-verify-pytest-switch.ts.
  ["PI_ENSEMBLE_VERIFY_PYTEST", () => !verifyPytestDisabled()],
  // #2649 — the changed-path classification table. Same reader shape (`!== "0"`), so
  // the LIVE loop's deleted env pins "unset means on"; the truth table and the off
  // arm's byte-identity are pinned by test-verify-select-changed-paths-off-arm.ts.
  ["PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS", () => changedPathRulesEnabled()],
];

/** The switch that would override a dimension's own default is cleared too. */
export const SWITCHES: Record<string, string> = {
  PI_ENSEMBLE_LOOP_DETECTOR: "PI_ENSEMBLE_DISPATCH_CAPS",
  PI_ENSEMBLE_REVIEW_SKILL_READS: "PI_ENSEMBLE_DISPATCH_CAPS",
  PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "PI_ENSEMBLE_DISPATCH_CAPS",
  PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "PI_ENSEMBLE_DISPATCH_CAPS",
  PI_ENSEMBLE_ADVERSARIAL_BOUND_MS: "PI_ENSEMBLE_DISPATCH_CAPS",
  PI_ENSEMBLE_PARALLEL_GROUPS: "PI_ENSEMBLE_PARALLEL_WORK",
  PI_ENSEMBLE_SLOW_NOTICE_MS: "PI_ENSEMBLE_SLOW_NOTICE",
  PI_ENSEMBLE_SLOW_NOTICE_TOKENS: "PI_ENSEMBLE_SLOW_NOTICE",
  PI_ENSEMBLE_SLOW_NOTICE_TURNS: "PI_ENSEMBLE_SLOW_NOTICE",
  PI_ENSEMBLE_CHILD_CODEMODE_MAX_WORKERS: "PI_ENSEMBLE_CHILD_CODEMODE",
};
