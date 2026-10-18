/**
 * work-driver-verify-verify-cmd — the verify-command gate of the develop
 * verify (per-worktree run + consolidated run + classification), extracted
 * from work-driver-verify-develop.ts by #794 (500-line gate).
 *
 * #669/#750/#782 semantics live here, with one #1005 change: per-worktree
 * failures are UNCONDITIONALLY kept as failures (the pre-#1005 downgrade of
 * per-worktree failures to notes on a consolidated pass is gone). #782's
 * single bounded flake re-run is caller-gated (every per-worktree verify
 * passed + a genuine N>1 consolidation) and happens inside
 * runConsolidatedVerify. #794 threads `workstreamBaseShas` into the
 * consolidated run so a stacked workstream's OWN range is picked against
 * its dependency's tip (no ancestor replay — the #775 shape).
 */
import path from "node:path";
import { withVerifySlot } from "./host-resources.ts";
import { describeSiblingFenceViolations } from "./work-develop-fence-verdicts.ts";
import { reportConsolidatedVerifyOutcome } from "./work-driver-consolidated-verify-report.ts";
import type { ConsolidatedVerifyOpts } from "./work-driver-consolidated-verify-types.ts";
import { runConsolidatedVerify } from "./work-driver-consolidated-verify.ts";
import {
  NO_SPECIFIC_ASSERTION,
  buildPerWorktreeFailuresByWs,
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
  extractSpecificAssertion,
  sharesAssertion,
} from "./work-driver-consolidation-classify.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { missingDepsFailure } from "./work-driver-deps-gate.ts";
import { provisionDepsHint } from "./work-driver-deps-hint.ts";
import {
  extractAttributedTail,
  hostExhaustionFailure,
  isHostForkExhaustion,
  pidLimitSnapshot,
} from "./work-driver-exec-error.ts";
import { captureProcessTree } from "./work-driver-gate-hang.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { aggregateVerifyOutcome } from "./work-driver-verify-aggregate.ts";
import {
  TIER_KNOB,
  fastTierTimeoutMs as resolveFastTierTimeoutMs,
} from "./work-driver-verify-budget.ts";
import {
  buildConsolidatedRetry,
  buildConsolidatedVerifyOpts,
} from "./work-driver-verify-consolidated-opts.ts";
import {
  type KilledGateRun,
  formatExecError,
  isTimedOutKill,
  isVerifyTimeoutFailure,
  verifyHangFailure,
  verifyTimeoutMs,
} from "./work-driver-verify-develop-helpers.ts";
import { developVerifiedTree } from "./work-driver-verify-eligibility.ts";
import { failedVerifyCmd } from "./work-driver-verify-fast.ts";
import { rawOutputClause, slugName, writeGateHangLog } from "./work-driver-verify-flake.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import { execp } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

/**
 * #826 — the three-state per-worktree assertion for the flake-retry gate.
 * The RAW extracted assertion (a specific `✗`/error line found in the
 * failure text) or `null` when nothing assertion-shaped could be extracted
 * (honest absence, the NO_SPECIFIC_ASSERTION sentinel is NOT a known
 * assertion). Known-and-mismatching suppresses the re-run (the #821 defect);
 * unknown ALLOWS it (the pre-#826 behaviour for that case): absence on the
 * per-worktree side is not evidence the consolidated failure is an
 * independent defect.
 */
function gatePerAssertion(failureText: string | undefined): string | null {
  if (failureText === undefined) return null;
  const extracted = extractSpecificAssertion(failureText);
  return extracted === NO_SPECIFIC_ASSERTION ? null : extracted;
}

// #794 — the per-worktree + consolidated verify gate of the develop step
// (moved from work-driver-verify-develop.ts to keep that file under the
// 500-line gate; behaviour is a pure move, no logic change).
export async function runVerifyCommandGate(opts: {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  cmd: string;
  ctx: CycleContext;
  state: WorkState;
  worktrees: Record<string, string>;
  baseSha: string | undefined;
  changedWorktrees: string[];
  workstreamBaseShas: Record<string, string> | undefined;
  failures: string[];
  notes: string[];
  onVerifyFlakeRecovered?: (evidenceTail?: string) => void;
  /**
   * #841 — out-parameter for the consolidated run's persisted raw-output log
   * path (called with the log the gate actually wrote — `logPath` is
   * undefined when the write failed, so the caller never records a path
   * that does not exist on disk).
   */
  onConsolidatedLogPath?: (logPath: string) => void;
  /**
   * #1240 — called with the identity that justified skipping the consolidated
   * run, so the caller can record the `consolidated-verify-skipped` event.
   */
  onConsolidatedVerifySkipped?: (skipped: AlreadyVerifiedTree) => void;
  /** #1509 — the fast tier's own bound, resolved by the caller (the only site
   *  that knows which repoRoot to read `.pi/verify-cmd-fast-timeout-ms` from)
   *  and threaded into the fast-tier exec. Absent, the fast run keeps the
   *  pre-#1509 shared-bound shape. */
  fastTierTimeoutMs?: number;
  /** #1509 — the knob the consolidated run's timeout failure names. Defaults
   *  to the suite tier's; the commit-pr seam passes its own. */
  suiteTimeoutKnob?: string;
  /**
   * #1509 — the bound this run is bounded by, resolved by the caller.
   *
   * An OPT-IN, deliberately not defaulted to the suite tier: callers that
   * migrated pass their tier, and callers that did not keep the bound they were
   * written against. Defaulting it would let a run that used to be killed at 10
   * minutes run for 30 while its own failure text still reported "10-min
   * timeout". Absent, the gate falls back to the shared `verifyTimeoutMs()`.
   */
  suiteTierTimeoutMs?: number;
  /**
   * #814 — structured fence violations recorded by the scope gate earlier
   * in this same develop verify (the gate runs BEFORE the consolidated
   * verify, so the records already exist when the conflict branch fires).
   * When a sibling-declared violation exists, the conflict is the fence
   * materialising at consolidation, not an incoherent decomposition — the
   * failure string attributes it accordingly (workstream, file, declaring
   * sibling) and the "incoherent" claim is not asserted.
   */
  fenceViolations?: FenceViolationRecord[];
  /** #1349 — the base run demonstrably fails the way the change's run does. */
  onBaselineAttributed?: () => void;
  /**
   * #1427 — injectable process-tree walker, so a smoke test can assert the
   * report's shape without forking `ps`. Production omits it and the real
   * walker runs.
   */
  walkProcessTree?: (leaderPid: number) => {
    processes: import("./work-driver-gate-hang.ts").HangProcess[];
    treeUnavailable?: string;
  };
  /**
   * #1427 round 3 — the sink this gate call's hang reports are recorded on,
   * created per `verifyStepOutcome` call and threaded back down: that is what
   * scopes a cap's `logPaths` to the run that produced it (the old shape
   * recorded on `ctx`, cycle scope, so a later call capped with an earlier
   * call's reports attached). Absent = reports are still written.
   */
  hangSink?: import("./work-driver-gate-hang.ts").GateHangPathSink;
  /**
   * #1421 fix round — the consolidated gate declined on nothing but build
   * residue (forwarded from the reporting layer, which reads the structured
   * field on the result). The develop gate turns this into the gate result's
   * `buildResidueOnly`, which is what `verifyCapFor` routes on.
   */
  onBuildResidueOnly?: () => void;
}): Promise<void> {
  const {
    execFn,
    cmd,
    ctx,
    state,
    worktrees,
    baseSha,
    changedWorktrees,
    workstreamBaseShas,
    failures,
    notes,
    onVerifyFlakeRecovered,
    fenceViolations,
    onConsolidatedLogPath,
    walkProcessTree,
    hangSink,
    // #1240 review r2 — the callback must be destructured AND forwarded:
    // `reportConsolidatedVerifyOutcome` is the only caller, and until now it
    // was never passed `onConsolidatedVerifySkipped`, so the skip identity
    // died here. The note still printed (it renders from `cons.skipped` on
    // its own), which is exactly how the gap hid — every develop caller's
    // `consolidatedVerifySkipped` stayed undefined and no skip event was ever
    // appended, while the state file looked explained.
    onConsolidatedVerifySkipped,
    onBuildResidueOnly,
    fastTierTimeoutMs: fastTimeoutMs,
    suiteTimeoutKnob,
    suiteTierTimeoutMs: suiteTierTimeoutMsOpt,
  } = opts;
  const VALID_SHA_RE = /^[0-9a-f]{40}$/;
  const isValidSha = (s: string | undefined) => typeof s === "string" && VALID_SHA_RE.test(s);
  // #1509 — the bound is resolved ONCE per gate call, for the suite tier, and
  // threaded to every exec and every failure string below. Two reads of the
  // resolver (one for exec, one for the message) could name a bound other than
  // the one the run was bounded by, and N per-worktree runs each re-reading the
  // environment could disagree with each other about which bound fired.
  const suiteTimeoutMs = suiteTierTimeoutMsOpt ?? (await verifyTimeoutMs());
  const perWorktreeVerifyFailures: string[] = [];
  // #1427 — the scratch dir a killed run's hang report is persisted to, created
  // lazily by the write. Named once here so the per-worktree loop and the
  // consolidated run below share one location (the consolidated run's own logs
  // already live there).
  const hangScratchDir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
  const hangTimestamp = new Date().toISOString();
  // The walker every hang report of this run uses — the injected one in tests,
  // the real `ps` walk in production. Read once so both seams below take the
  // same branch.
  const walker = opts.walkProcessTree ?? captureProcessTree;
  // The per-run discriminator in the report's filename: the workstream whose
  // worktree this gate ran in. `changedWorktrees` are worktree paths, so the
  // basename is the nearest stable identity, with the cwd's own slug as the
  // fallback when the map is sparse.
  const slugFor = (cwd: string): string => {
    const id = Object.keys(worktrees).find((k) => worktrees[k] === cwd);
    return slugName(id ?? path.basename(cwd));
  };
  for (const cwd of changedWorktrees) {
    const depsMissing = await missingDepsFailure(execFn, state, ctx.repoRoot, cwd, cmd); // #1146
    if (depsMissing !== undefined) {
      perWorktreeVerifyFailures.push(depsMissing);
      continue;
    }
    try {
      await withVerifySlot(() =>
        execFn(cmd, { cwd, timeout: suiteTimeoutMs, maxBuffer: 4 * 1024 * 1024 }),
      );
    } catch (err) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        timedOutKill?: boolean;
        overflow?: string;
        treePid?: number;
        /** #1324 — set by `withFastTier` on a fast-tier rejection. */
        fastTier?: string;
      };
      // A missing `node_modules` looks like a real defect; in a fresh worktree say so.
      // #1005 — per-worktree failures stay failures; the consolidated run adds its own.
      const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
      const depsHint = looksLikeMissingDeps(output) ? provisionDepsHint(state, cwd) : "";
      const ran = failedVerifyCmd(e, cmd); // #1324 — the fast tier, when it is the one that failed
      const cwdSlug = slugFor(cwd);
      // #1427 — a run the wall clock killed gets a hang report: the test names
      // the runner had already flagged, the gate's process tree, and its output
      // tail. Built ONLY for a timeout kill — an ordinary failing run pays
      // nothing, and a maxBuffer overflow (also a `killed` run) claims nothing
      // about processes it never stalled on.
      const hung = isTimedOutKill(e);
      // ONE walk per killed run: the snapshot is captured here, in the window
      // where the group may still be alive, and handed to BOTH the report and
      // the failure-string clause so they cannot disagree (#1427 fix round —
      // they used to walk separately and could report different process sets
      // for one kill).
      const killedTree = hung && typeof e.treePid === "number" ? walker(e.treePid) : undefined;
      const hang: KilledGateRun | undefined = hung
        ? {
            output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
            cmd: ran,
            cwd,
            timeoutMs: suiteTimeoutMs,
            ...(killedTree !== undefined ? { tree: killedTree } : {}),
          }
        : undefined;
      if (hang !== undefined) {
        const logPath = writeGateHangLog(
          hangScratchDir,
          hangTimestamp,
          {
            output: hang.output,
            cmd: hang.cmd,
            cwd: hang.cwd,
            timeoutMs: hang.timeoutMs,
            ...(typeof e.treePid === "number" ? { leaderPid: e.treePid } : {}),
            ...(killedTree !== undefined
              ? { processes: killedTree.processes, treeUnavailable: killedTree.treeUnavailable }
              : {}),
          },
          // The name says WHICH run this report belongs to: a fan-out kills one
          // gate run per workstream and they must not overwrite each other.
          { tag: cwdSlug },
        );
        if (logPath !== undefined) {
          // #1427 round 3/4 — recorded on THIS gate call's sink, not on `ctx`:
          // the context is cycle-scoped and the three cap sites are three
          // separate gate CALLS, which is what let a late cap name an early
          // run's file. Pushed directly — the recorder it used to call had one
          // reader, a test, and no other caller.
          if (hangSink !== undefined) {
            hangSink.gateHangLogPaths = [...(hangSink.gateHangLogPaths ?? []), logPath];
          }
        }
      }
      perWorktreeVerifyFailures.push(
        formatExecError(
          e,
          // #1427 round 3 — `verifyHangFailure` APPENDS the clause after the
          // whole #1324 sentence, so a wide clause costs the names rather than
          // the `[verify-timeout]` marker the cap router keys on.
          verifyHangFailure(
            ran,
            `in ${cwd}`,
            suiteTimeoutMs,
            hang,
            // #1509 — name the knob that governs the tier that actually timed
            // out. `ran` is the fast tier when the fast run is what hung, and
            // the caller resolved that tier's bound; the knob travels with the
            // tier rather than being guessed from the command string.
            e.fastTier === undefined
              ? (suiteTimeoutKnob ?? TIER_KNOB.suite)
              : fastTimeoutMs === undefined
                ? (suiteTimeoutKnob ?? TIER_KNOB.suite)
                : TIER_KNOB.fast,
          ),
          `verify command \`${ran}\` failed in ${cwd}${depsHint}`,
        ),
      );
    }
  }
  // #1005 — per-worktree failures are the verdict when the consolidated run
  // cannot run (no valid baseSha or nothing to combine); otherwise the
  // CONSOLIDATED tree is the verdict AND the per-worktree failures are kept
  // as failures too — a workstream that fails in its OWN tree must block,
  // even when the combined tree passes (#1005 reverses the #669 downgrade:
  // a combined run that passes does not excuse a workstream that fails on
  // its own). #782's single bounded flake re-run is caller-gated (every
  // per-worktree verify passed + a genuine N>1 consolidation) and happens
  // inside runConsolidatedVerify. #794 threads `workstreamBaseShas` into
  // the consolidated run so a stacked workstream's OWN range is picked
  // against its dependency's tip (no ancestor replay — the #775 shape).
  // #750 — the develop gate reads the CONSOLIDATED tree, not the isolated
  // worktrees: a per-worktree verify cannot see a file a sibling's commit
  // supplies (or deletes), and the #750 regression proves the combined
  // state is the only state worth testing. The combined tree is built from
  // every worktree that has commits ahead of baseSha, so the gate runs
  // when any committed worktree is non-trivial to consolidate — i.e. any
  // worktree with committed work exists and the root itself is not the
  // only worktree (N=1 with the root as the worktree is the combined tree).
  const consolidationNeeded = changedWorktrees.length > 0;
  // #750 — the consolidated run (which owns the dirty-root refusal at its
  // preflight) must run whenever there is ANY committed worktree: the
  // refusal fires even for the N=1 case where the only worktree is the
  // root itself, because operator residue on the root must not be swept
  // into the PR just because the combined tree is trivially the root.
  if (!consolidationNeeded || !isValidSha(baseSha)) {
    // No consolidation possible: the per-worktree results are the verdict.
    // The only reachable skip is "changed work exists but no valid baseSha"
    // (without it the combined tree cannot be built); with no changed
    // worktrees there is nothing to combine, so no note is recorded.
    failures.push(...perWorktreeVerifyFailures);
    if (consolidationNeeded && !isValidSha(baseSha)) {
      notes.push(
        "consolidated verify skipped — no valid baseSha to build the combined tree against, so the per-worktree evidence is the verdict",
      );
    }
    return;
  }
  const scratchDir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
  // #807 — the retry gate and the Case-2 root-cause match below must read
  // the SAME per-worktree failure map: if the retry fires on one view of
  // the failures and the classifier later compares a different, filtered
  // view, a "shared assertion" decision can diverge between the gate and
  // the verdict (the #798 class of marker-vs-marker mismatch). Both now
  // read `perWorktreeFailuresByWs`.
  const perWorktreeFailuresByWs = buildPerWorktreeFailuresByWs(
    worktrees,
    changedWorktrees,
    perWorktreeVerifyFailures,
  );
  // #782/#807/#826 — the consolidated-verify flake retry, two-phase gate:
  // (1) a length-only precondition admits the FIRST consolidated run — it
  // fires when this is a genuine consolidation (N>1) AND the per-worktree
  // failures are at most one (zero = the #782 shape; one = a possible
  // flake, the #798 shape where a timing-flaky test failed in a worktree
  // AND on the combined tree — one unstable test, not two independent
  // defects). The consolidated assertion is not known before the run, so
  // nothing more can be checked up front.
  // (2) the RE-RUN is decided by onFirstFailure against the RAW first-run
  // failure (deliberately raw: the elided detail can drop the ✗ line —
  // see #827 — while the classifier compares the elided detail): a KNOWN
  // per-worktree assertion that the first run does NOT share is suppressed
  // (a single per-worktree failure with a different assertion is a genuine
  // defect — the re-run would burn a full verify run and could mask it,
  // the #821 defect); a SHARED assertion or an UNKNOWN (unextractable) one
  // ALLOWS the re-run (pre-#826 behaviour for the unknown case). The
  // decision is computed ONCE in onFirstFailure and reported on the result
  // as `retryDecision` — the post-run notes are rendered from it, not from
  // a second comparator call.
  const singlePerWorktreeFailure = perWorktreeVerifyFailures.length === 1;
  const flakeRetryPrecondition =
    (!singlePerWorktreeFailure || Object.keys(perWorktreeFailuresByWs).length === 1) &&
    Object.keys(worktrees).length > 1;
  // The #807 invariant: the per-worktree assertion is extracted BEFORE the
  // consolidated run so the post-run note reads the same value the
  // classifier will compare. `null` = honest absence (nothing extractable),
  // which the gate treats as unknown, not as a mismatch.
  const singlePerWs = singlePerWorktreeFailure
    ? Object.keys(perWorktreeFailuresByWs)[0]
    : undefined;
  const singlePerAssertion: string | null | undefined =
    singlePerWs !== undefined ? gatePerAssertion(perWorktreeFailuresByWs[singlePerWs]) : undefined;
  // #1240 — the N=1 duplicate run: with ONE workstream whose per-worktree
  // verify just passed, the consolidated probe cherry-picks that workstream's
  // own commits onto baseSha and verifies the result — the same content the
  // run above already judged. The eligibility rule (and why the identity is
  // read here but compared inside the probe) is in `developVerifiedTree`.
  // Any failure yields `undefined` and the consolidated verify runs as before.
  const alreadyVerifiedTree = await developVerifiedTree(execp, ctx, {
    changedWorktrees,
    worktrees: state.pipelineState.worktrees ?? {},
    perWorktreeVerifyFailures,
  });
  // #1427 fix round — the consolidated call is a TYPED literal, so a key that
  // does not exist on `ConsolidatedVerifyOpts` is a compile error rather than a
  // silently dropped option (the `{ onWalk: … }` forwarding defect: the walker
  // never reached the consolidated probe and the real `ps` walked the host).
  // The literal itself lives in work-driver-verify-consolidated-opts.ts
  // (AGENTS.md §12 file-size cap) and stays typed there for the same reason.
  const consOpts: ConsolidatedVerifyOpts = buildConsolidatedVerifyOpts({
    repoRoot: ctx.repoRoot,
    baseSha: baseSha as string,
    stateWorktrees: state.pipelineState.worktrees ?? {},
    workstreamBaseShas,
    scratchDir,
    verifyCmd: cmd,
    timeoutMs: suiteTimeoutMs,
    ...(suiteTimeoutKnob !== undefined ? { suiteTimeoutKnob } : {}),
    ...(fastTimeoutMs === undefined ? {} : { fastTierTimeoutMs: fastTimeoutMs }),
    ...(alreadyVerifiedTree !== undefined ? { alreadyVerifiedTree } : {}),
    dirtyRootExempt: ctx.dirtyRootExempt,
    ...(walkProcessTree !== undefined ? { walkProcessTree } : {}),
    retry: buildConsolidatedRetry({
      canRetry: flakeRetryPrecondition,
      singlePerAssertion,
      onRecover: (evidenceTail) => {
        notes.push(
          `consolidated verify RECOVERED after one bounded re-run (transient flake) — first-run failure preserved${evidenceTail ? `: ${evidenceTail}` : ""}`,
        );
        onVerifyFlakeRecovered?.(evidenceTail);
      },
    }),
  });
  const cons = await runConsolidatedVerify(execFn, consOpts);
  reportConsolidatedVerifyOutcome(cons, {
    cmd,
    failures,
    notes,
    // #1509 — the bound and knob this gate resolved, not one the reporter
    // re-reads from the environment.
    timeoutMs: suiteTimeoutMs,
    timeoutKnob: suiteTimeoutKnob,
    ctx,
    worktrees,
    // #813 — the plan's declared paths let the no-fence conflict text say
    // "likely coupled" when the failure names a file a sibling declared.
    workstreams: state.pipelineState.workstreams,
    perWorktreeFailuresByWs,
    singlePerWs,
    singlePerAssertion,
    fenceViolations,
    onConsolidatedLogPath: opts.onConsolidatedLogPath,
    onVerifyFlakeRecovered: opts.onVerifyFlakeRecovered,
    // #1240 review r2 — forwarded, or the skip is invisible to the caller.
    ...(opts.onConsolidatedVerifySkipped !== undefined
      ? { onConsolidatedVerifySkipped: opts.onConsolidatedVerifySkipped }
      : {}),
    // #1421 fix round — same forwarding rule: without it the structured
    // decline dies here and the cap router falls back to the prose label.
    ...(onBuildResidueOnly !== undefined ? { onBuildResidueOnly } : {}),
    // #1427 round 3/4 — the consolidated probe writes its own hang report; its
    // path lands on the same per-call sink as the per-worktree seam's, so the
    // one reader (the cap emit site) sees both legs of THIS gate call and
    // nothing from an earlier one. `runConsolidatedVerify` already reports the
    // path on its result (`hangLogPath`), which is what this callback carries —
    // so the sink is the only channel a caller needs, and the extra
    // `onGateHangLogPath` hop (whose sole reader was a test's local variable)
    // is gone.
    onGateHangLogPath: (logPath) => {
      if (hangSink !== undefined) {
        hangSink.gateHangLogPaths = [...(hangSink.gateHangLogPaths ?? []), logPath];
      }
    },
  });
  // Post-run reconciliation and base attribution — extracted to
  // work-driver-verify-aggregate.ts (§12 size cap). Moved as-is: the #1005
  // aggregation rule and the condition for paying for the baseline probe both
  // travel with their comments, which sit on the code in the new module.
  await aggregateVerifyOutcome({
    execFn,
    ctx,
    cmd,
    baseSha,
    suiteTimeoutMs,
    cons,
    perWorktreeVerifyFailures,
    failures,
    notes,
    onBaselineAttributed: () => opts.onBaselineAttributed?.(),
  });
}
