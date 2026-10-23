/**
 * work-driver-verify-verify-cmd — the verify-command gate of the develop
 * verify (per-worktree run + consolidated run + classification), extracted
 * from work-driver-verify-develop.ts by #794 (500-line gate). #669/#750/#782
 * semantics live here: per-worktree failures are UNCONDITIONALLY kept as
 * failures (the pre-#1005 downgrade to notes on a consolidated pass is gone).
 * #782's single bounded flake re-run is caller-gated, every per-worktree verify passing plus a genuine N>1
 * consolidation, and it happens inside runConsolidatedVerify. #794 threads
 * `workstreamBaseShas` into the consolidated run so a stacked workstream's OWN
 * range is picked against its dependency's tip (no ancestor replay — #775).
 * #1765 adds one callback per base-probe claim, reported by `reportBaselineLeg`.
 */
import path from "node:path";
import { reportConsolidatedVerifyOutcome } from "./work-driver-consolidated-verify-report.ts";
import type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify-types.ts";
import { runConsolidatedVerify } from "./work-driver-consolidated-verify.ts";
import { buildPerWorktreeFailuresByWs } from "./work-driver-consolidation-classify.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { aggregateVerifyOutcome } from "./work-driver-verify-aggregate.ts";
import type { BaselineRedEstablished } from "./work-driver-verify-aggregate.ts";
import {
  buildConsolidatedRetry,
  buildConsolidatedVerifyOpts,
} from "./work-driver-verify-consolidated-opts.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
import { developVerifiedTree } from "./work-driver-verify-eligibility.ts";
import {
  type GatePass,
  type GateRecorded,
  combinedWorktreeTree,
  gatePassPlan,
  gatePassRecord,
  reusableGatePass,
} from "./work-driver-verify-gate-reuse.ts";
import { runPerWorktreeVerify } from "./work-driver-verify-per-worktree.ts";
import {
  type RanVerifyRecord,
  type VerifyRecordSlot,
  gatePerAssertion,
} from "./work-driver-verify-record.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import { execp } from "./work-driver-verify.ts";
import type { WorkstreamGreen } from "./workflow-state-schema-gate-reuse.ts";
import type { WorkState } from "./workflow-state.ts";

// #794 — the per-worktree + consolidated verify gate of the develop step
// (moved from work-driver-verify-develop.ts to keep that file under the
// 500-line gate; behaviour is a pure move, no logic change).
export type VerifyCommandGateOpts = {
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
   * #1415 — called once per gate pass with the reuse records this pass produced:
   * the whole-gate verdict it established (absent when the pass reused one, ran
   * no command, failed, or could not read its combined tree), the per-workstream
   * greens it established, and the workstream ids whose greens it refuted.
   *
   * One callback, not three: the three writes land on two fields of one state
   * object, and a caller that stored the greens and lost the verdict to a stale
   * state reference would leave the cycle permanently un-reusable with no
   * symptom beyond a slow cycle. The gate decides reuse AND produces the record,
   * so a caller that ignores this callback loses memoisation, never correctness.
   */
  onGateRecorded?: GateRecorded;
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
  /** #1349 — the base run fails the way the change's run does (the excuse). */
  onBaselineAttributed?: () => void;
  /** #1765 — the probe established a red base (the CAP's claim). */
  onBaselineRedEstablished?: BaselineRedEstablished;
  /**
   * #1427 — injectable process-tree walker, so a smoke test can assert the
   * report's shape without forking `ps`. Production omits it.
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
  /** #1667 — this run's record: what it ran and how each run failed. */
  verifyRecord?: VerifyRecordSlot;
};

/**
 * #1667 — the gate's one exit for its run record. `failures` is what the
 * verify block appended, and it is set here, once, after the body returns:
 * every return inside the body (the early per-worktree-only path included)
 * leaves the record to this line, so no path can forget it or set it early.
 */
export async function runVerifyCommandGate(opts: VerifyCommandGateOpts): Promise<void> {
  const record: RanVerifyRecord = {
    status: "ran",
    command: opts.cmd,
    failures: [],
    perWorktree: [],
  };
  if (opts.verifyRecord) opts.verifyRecord.current = record;
  const failuresAtEntry = opts.failures.length;
  await runVerifyCommandGateBody(opts, record);
  record.failures = opts.failures.slice(failuresAtEntry);
}

async function runVerifyCommandGateBody(
  opts: VerifyCommandGateOpts,
  record: RanVerifyRecord,
): Promise<void> {
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
    onGateRecorded,
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
  // #1667 — each failure with the cwd it ran in; the flat failure list is derived from these.
  const perWorktreeRecords = record.perWorktree;
  // The tier-resolved bound is also part of the reuse identity.
  const passTimeoutMs = suiteTimeoutMs;
  // #1415 — the whole-gate reuse, decided BEFORE a single command runs. When
  // the cycle's combined tree, the verify command and the bound are all
  // unchanged since a pass the driver itself recorded, AND every changed
  // workstream holds a current green for that same triple, this pass has a
  // verdict already: the per-worktree loop is skipped and the consolidated
  // probe is not built. Anything short of that conjunction — no record, a moved
  // tree, an edited `.pi/verify-cmd`, a tightened bound, an unreadable tree id,
  // a workstream without a green — falls through and runs, exactly as before.
  // The join of the two halves, and why one missing green collapses reuse to a
  // full run, is `gatePassPlan`, kept beside the rest of the reuse rule.
  const gateReuseState = state.pipelineState.gateReuse;
  const reuseDecision = await reusableGatePass(ctx.verifyExecFn ?? execp, {
    cmd,
    timeoutMs: passTimeoutMs,
    worktrees: state.pipelineState.worktrees ?? {},
    changedWorktrees,
    recorded: gateReuseState?.passes,
    greens: gateReuseState?.workstreamGreens,
  });
  const plan = await gatePassPlan(ctx.verifyExecFn ?? execp, {
    wholeGate: reuseDecision.reuse,
    cmd,
    timeoutMs: passTimeoutMs,
    worktrees: state.pipelineState.worktrees ?? {},
    changedWorktrees,
    greens: gateReuseState?.workstreamGreens,
  });
  const reusedWholeGate = plan.wholeGateHeld !== undefined;
  // Greens this pass establishes (a worktree whose command ran and passed) and
  // refutes (a worktree whose command failed). Mutated in place, like
  // `failures`/`notes` — the caller persists them alongside the step's other
  // gate evidence.
  const greensRecorded: Array<[string, WorkstreamGreen]> = [];
  const greensRefuted: string[] = [];
  for (const cwd of plan.reuse) {
    notes.push(
      `per-worktree verify reused — worktree ${cwd} already passed \`${cmd}\` under a ${passTimeoutMs}ms bound at this tree, so the command was not run there (Set PI_ENSEMBLE_VERIFY_GATE_REUSE=0 to run every develop round)`,
    );
  }
  // The per-worktree runs — extracted to work-driver-verify-per-worktree.ts
  // (§12 size cap); moved as-is, with their #1427 hang-report seam.
  await runPerWorktreeVerify({
    run: plan.run,
    execFn,
    cmd,
    ctx,
    state,
    worktrees,
    suiteTimeoutMs,
    passTimeoutMs,
    walkProcessTree: opts.walkProcessTree,
    hangSink,
    suiteTimeoutKnob,
    fastTimeoutMs,
    perWorktreeRecords,
    greensRecorded,
    greensRefuted,
  });
  const perWorktreeVerifyFailures = perWorktreeRecords.map((r) => r.text);
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
    // No whole-gate verdict without a consolidated run, but a green a worktree
    // just refuted must not survive to license the next round's skip.
    if (greensRecorded.length > 0 || greensRefuted.length > 0) {
      onGateRecorded?.(undefined, greensRecorded, greensRefuted);
    }
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
  // Wall-clock of the consolidated COMMAND, measured only when it runs. The
  // record the pass leaves behind carries it so the next round can tell a
  // 30-second gate from a 9-minute one — the difference between a verdict worth
  // reusing and one whose run the bound exists to cap.
  const consolidatedStartedAt = Date.now();
  const cons: ConsolidatedVerifyResult = reusedWholeGate
    ? { status: "passed", applied: [], reused: plan.wholeGateHeld }
    : await runConsolidatedVerify(
        execFn,
        buildConsolidatedVerifyOpts({
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
        }),
      );
  if (cons.status === "failed") record.consolidatedRaw = cons.rawFailure;
  // The consolidated run's wall-clock: measured, not estimated, because it is
  // the number the next round's reuse decision is screened against — and a
  // reused pass has no duration, because it ran nothing.
  const consolidatedDurationMs = reusedWholeGate ? undefined : Date.now() - consolidatedStartedAt;
  // #1415 — record the verdict the moment it exists, in the seam that decided
  // it: a caller that had to thread the result outward could drop it, and the
  // symptom of a dropped record is only "the cycle is slow again". A pass that
  // reused records NOTHING — refreshing `at` every round would keep a stale
  // verdict permanently "fresh", and no new duration was measured to record.
  // The combined tree is re-read AFTER the probe (whose checkout the probe has
  // since restored) with the same function the reuse check used, so the record
  // and the decision cannot describe different content; an unreadable tree
  // records nothing (no record, no reuse).
  if (cons.status === "passed" && !reusedWholeGate) {
    const combined = await combinedWorktreeTree(
      ctx.verifyExecFn ?? execp,
      state.pipelineState.worktrees ?? {},
    );
    // A passing pass whose combined tree could not be read records no verdict:
    // an entry needs a tree, and one guessed from a partial read is the record
    // a later skip would stand on. Its greens are still recorded — each was
    // read from its own worktree at the moment its command passed.
    onGateRecorded?.(
      combined === undefined
        ? undefined
        : gatePassRecord(combined, cmd, passTimeoutMs, consolidatedDurationMs),
      greensRecorded,
      greensRefuted,
    );
  } else if (reusedWholeGate) {
    // A reused pass records nothing: it measured no duration, and refreshing a
    // record's `at` every round would keep a stale verdict permanently "fresh".
    onGateRecorded?.(undefined, [], []);
  } else if (greensRefuted.length > 0) {
    // A failed pass records no verdict, but a green the command just refuted
    // must not survive to license the next round's skip.
    onGateRecorded?.(undefined, [], greensRefuted);
  }
  reportConsolidatedVerifyOutcome(cons, {
    cmd,
    failures,
    notes,
    // #1509 — the bound and knob this gate resolved, not re-read from env.
    timeoutMs: suiteTimeoutMs,
    timeoutKnob: suiteTimeoutKnob,
    ctx,
    worktrees,
    // #813 — declared paths let the conflict text say "likely coupled".
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
    // #1765 — reuse the branch step's verdict for this key; see verify-baseline.
    ...(state.pipelineState.baseHealthProbe !== undefined
      ? { baseHealthProbe: state.pipelineState.baseHealthProbe }
      : {}),
    onBaselineAttributed: opts.onBaselineAttributed,
    onBaselineRedEstablished: opts.onBaselineRedEstablished,
  });
}
