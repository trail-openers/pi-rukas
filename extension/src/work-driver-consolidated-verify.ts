// #669 — consolidated develop-time verify: all workstreams' commits
// cherry-picked onto the integration branch at repoRoot, then ONE verify
// run against the combined tree. The develop-time twin of the commit-pr
// verify in `integrate()`: same `orchestrateCherryPick` machinery, same
// restore-on-failure contract. Differences: NO push, NO worktree advance
// (#453 invariant — worktrees are only advanced after a successful push,
// which commit-pr owns); `requireAllNonEmpty: false` (a workstream with no
// commit simply contributes nothing); repoRoot is ALWAYS restored
// afterwards (the combined tree is a transient probe; leaving it on a
// scratch ref would break the next integration's dirty-preflight).

import { withVerifySlot } from "./host-resources.ts";
import { trace } from "./trace.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.js";
import { readRepoRootPreflight } from "./work-driver-consolidated-verify-preflight.ts";
import { consolidatedVerifySkip } from "./work-driver-consolidated-verify-skip.ts";
import type {
  ConsolidatedVerifyOpts,
  ConsolidatedVerifyResult,
} from "./work-driver-consolidated-verify-types.ts";
import type { DriverContext } from "./work-driver-context.js";
import { extractAttributedTail, isHostForkExhaustion } from "./work-driver-exec-error.ts";
import { writeGateHangReport } from "./work-driver-gate-hang-report-write.ts";
import type { HangProcess } from "./work-driver-gate-hang.ts";
import { NO_TREE_CAPTURED, captureProcessTree } from "./work-driver-gate-hang.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import { isTimedOutKill } from "./work-driver-verify-develop-helpers.ts";
import {
  combinedExecFailureStream,
  rawOutputClause,
  rerunConsolidatedVerifyOnce,
  writeConsolidatedVerifyLog,
} from "./work-driver-verify-flake.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";

/**
 * #826 — the recorded outcome of the flake-retry decision, computed ONCE in
 * `onFirstFailure` (inside `runConsolidatedVerify`) and reported on the
 * result as `retryDecision` so the caller renders its notes from the value
 * instead of a second `sharesAssertion` call:
 *
 * - `"allowed-no-per-worktree-failure"` — the re-run was allowed because
 *   there was no per-worktree failure to compare against (the #782 shape).
 * - `"allowed-shared"` — the per-worktree assertion is KNOWN and shared by
 *   the first consolidated run's RAW failure (one unstable test).
 * - `"allowed-unknown"` — the per-worktree assertion was NOT extractable
 *   (honest absence); the re-run was allowed, preserving pre-#826 behaviour
 *   for that case — absence is not evidence of a mismatch.
 * - `"suppressed-mismatch"` — the per-worktree assertion is KNOWN and the
 *   first consolidated run did NOT share it; the re-run was withheld (a
 *   single per-worktree failure with a different assertion is a genuine
 *   defect the re-run could mask — the #821 shape).
 */
export type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify-types.ts";

export type ConsolidatedVerifyRetryDecision =
  | "allowed-no-per-worktree-failure"
  | "allowed-shared"
  | "allowed-unknown"
  | "suppressed-mismatch";

export async function runConsolidatedVerify(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  opts: ConsolidatedVerifyOpts,
) {
  return withIntegrationLock(opts.repoRoot, () => runConsolidatedVerifyUnlocked(execFn, opts));
}

/**
 * #861 — the shared result shape of the consolidated verify (the wrapper
 * and its unlocked body return the same type; the body computes it, the
 * wrapper only adds the lock).
 */
/**
 * #861 — the unlocked body of the consolidated verify. The ONLY production
 * caller is `runConsolidatedVerify` (the `withIntegrationLock` wrapper);
 * this export exists so the smoke-test harness can prove the wrapper is what
 * serialises (the anti-vacuity control calls this directly).
 *
 * #861 (decision 5) — the wrapper takes the integration lock around the
 * WHOLE repoRoot section (dirty-root preflight read, checkout -B,
 * cherry-pick, verify, the single flake re-run, restoreRoot and branch -D),
 * exactly like every other repoRoot-mutating path (integrate(), runCommitPr,
 * handoff-consolidate, merged teardown). The only production caller chain
 * — runVerifyCommandGate → verifyDevelopOutcome →
 * verifyStepOutcome("develop") — runs at step boundaries with no ancestor
 * holding the lock (the develop/commit-pr step handlers never hold it while
 * running the outcome gate), so the take is exactly once; nesting would
 * deadlock the in-process chain (the same call waiting on itself).
 */
export async function runConsolidatedVerifyUnlocked(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  opts: ConsolidatedVerifyOpts,
): Promise<ConsolidatedVerifyResult> {
  const { repoRoot, baseSha, worktrees, scratchDir, verifyCmd, timeoutMs } = opts;
  // #1362 — the configured exemptions, threaded from the cycle context. An
  // untracked file under one of its prefixes is not dirt here either, so a
  // tool's own local file no longer refuses the consolidated verify.
  const exempt = opts.dirtyRootExempt;
  // #794 — the pick scope: each workstream's own range is measured against
  // its effective base (the dependency's tip for a stacked workstream), so
  // a dependent's ANCESTOR commits are not re-picked on top of their
  // content. `workstreamBaseShas` entries are resolved per workstream inside
  // `orchestrateCherryPick`; a missing entry falls back to `baseSha`.
  const pickScope = { globalBaseSha: baseSha, workstreamBaseShas: opts.workstreamBaseShas };
  const retry = opts.retry;
  // A scratch branch name no other step of the cycle ever creates. Deleted
  // on the restore path below (a leftover branch costs nothing, but noise
  // is noise; the worktrees are untouched either way).
  const branchName = "pi-rukas-dev-verify";
  let originalRef: string | undefined;
  // #750 — the restore is verified, not assumed: preserves the discarded
  // state, resets, restores the checkout, and reports success only when the
  // porcelain read confirms the root is clean. The caller emits that
  // post-condition — it no longer asserts an unverified "restored".
  const restoreRoot = async (): Promise<VerifiedRestoreResult> => {
    if (!originalRef) return { restored: true };
    const result = await verifiedRestoreRoot(execFn, {
      repoRoot,
      originalRef,
      scratchDir,
      label: "consolidated verify",
      dirtyRootExempt: exempt,
    });
    // Delete the scratch branch so it does not accumulate on every develop
    // re-entry. Failure is non-fatal (a leftover branch costs nothing).
    await execFn(`git branch -D ${JSON.stringify(branchName)}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined);
    return result;
  };
  // The verified post-condition for the operator, via the shared claim
  // builder (the not-restored variant carries the preserved-diff location and
  // the still-dirty detail — the loud failure, never a bare "restored").
  const restoreClaimFor = (r: VerifiedRestoreResult) =>
    restoreClaim(r, { label: "the batch was aborted and" });
  try {
    // Preflight — same as integrate(): repoRoot must be clean before we touch
    // its checkout, or a dirty root would carry operator residue onto the probe
    // branch. Refuse to consolidate rather than guess; a root holding nothing
    // but a tool's output is a DECLINE the caller reports, not a refusal.
    const preflight = await readRepoRootPreflight(execFn, repoRoot, exempt);
    if (preflight !== undefined) return preflight;
    originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    })
      .then((r) => r.stdout.trim())
      .catch(async () =>
        (await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })).stdout.trim(),
      );

    await execFn(`git checkout -B ${JSON.stringify(branchName)} ${JSON.stringify(baseSha)}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });

    const orchResult = await orchestrateCherryPick(execFn, {
      repoRoot,
      branchName,
      worktrees: { ids: Object.keys(worktrees), worktrees, commitShas: {} },
      baseSha,
      scratchDir,
      requireAllNonEmpty: false,
      pickScope,
    });

    if (orchResult._conflict === "conflict") {
      const restore = await restoreRoot();
      return {
        status: "conflict",
        kind: "conflict",
        detail: `cherry-pick conflict — the batch aborted; ${restoreClaimFor(restore)}`,
        ...(orchResult._conflictedWorkstream !== undefined
          ? { conflictedWorkstream: orchResult._conflictedWorkstream }
          : {}),
        ...(orchResult._conflictAppliedBefore !== undefined
          ? { appliedBeforeConflict: orchResult._conflictAppliedBefore }
          : {}),
        ...(orchResult._conflictedFile !== undefined
          ? { conflictedFile: orchResult._conflictedFile }
          : {}),
      };
    }
    if (orchResult._applyConflict !== undefined) {
      const { id, reason, patchFile } = orchResult._applyConflict;
      const restore = await restoreRoot();
      return {
        status: "conflict",
        kind: "conflict",
        detail: `patch-apply failed for workstream '${id}': ${reason}. Conflict patch preserved at ${patchFile}. ${restoreClaimFor(restore)}`,
        conflictedWorkstream: id,
      };
    }

    // #841 — ONE ISO timestamp per verify cycle: the run1 and run2 log
    // files share the same prefix (the ticket names them
    // `consolidated-verify-<ISO timestamp>-run<1|2>.log`), so the pair is
    // unambiguous to an operator inspecting scratchDir. The timestamp is
    // captured here, BEFORE the run1 attempt, so both runs of one cycle
    // carry the same value even if the flake retry fires milliseconds later.
    //
    // #1240 — the skip decision. Why it is taken HERE and not before the
    // picks, and why both sides must read as real hashes, is argued in
    // `consolidatedVerifySkip` (work-driver-consolidated-verify-skip.ts).
    const skip = await consolidatedVerifySkip(execFn, repoRoot, opts.alreadyVerifiedTree);

    const runTimestamp = new Date().toISOString();
    let run1LogPath: string | undefined;
    // #841 — the run2 log path is NOT precomputed here: it comes from the
    // actual return of the run2 write (inside `rerunConsolidatedVerifyOnce`),
    // so a failed run2 write is reported as "unavailable" rather than
    // naming a file that does not exist on disk.
    let run2LogPath: string | undefined;
    // Run the verify command against the combined tree.
    let verifyFailure: string | undefined;
    let timedOut = false;
    // #1427 — the tree captured at the kill, before the flake re-run replaces
    // the failure it describes. The report is written once, for the run that
    // ENDED the run (the flake re-run overwrites both `timedOut` and
    // `rawFailure` below), so a hung first run that the re-run superseded does
    // not produce a report about processes that are already gone.
    let hangTree: { processes: HangProcess[]; treeUnavailable?: string } | undefined;
    let hangLeaderPid: number | undefined;
    let hang: string | undefined;
    // #1240 — same tree, same verdict: the per-worktree run already executed
    // `verifyCmd` against this exact content, so the probe is not re-run.
    // The restore below still happens (the probe checkout is transient
    // either way) and the result still reports `applied` verbatim.
    if (skip === undefined) {
      try {
        await withVerifySlot(() =>
          execFn(verifyCmd, {
            cwd: repoRoot,
            timeout: timeoutMs,
            maxBuffer: 8 * 1024 * 1024,
            // The driver's knobs never reach the project's gate.
            env: verifyChildEnv(),
          }),
        );
      } catch (err) {
        const e = err as Error & {
          stderr?: string;
          stdout?: string;
          killed?: boolean;
          timedOutKill?: boolean;
          overflow?: string;
          treePid?: number;
        };
        verifyFailure = combinedExecFailureStream(e);
        // #1427 fix round — a maxBuffer overflow is also a `killed` run; only
        // the wall-clock kill is a hang, and only a hang earns a report.
        timedOut = isTimedOutKill(e);
        // #1427 — a run killed at its bound gets a hang report alongside the
        // raw log: the runner's own slow-test names, the gate's process tree
        // taken BEFORE the kill, and the output tail. Written only for a killed
        // run, so an ordinary failure writes one file and not two. The tree is
        // walked HERE, before the kill has settled, and carried to the write.
        if (timedOut) {
          // ONE capture per killed run, made HERE — in the window between the
          // kill and its settle where the group's stragglers can still be alive
          // (the lantern #1054 case is children that outlive their leader) — and
          // handed to BOTH the written report and the failure-string clause.
          // #1427 round 4 removed the clause's ability to walk at all, so this
          // line is the only thing that produces process rows for this seam.
          if (typeof e.treePid === "number") {
            hangTree = (opts.walkProcessTree ?? captureProcessTree)(e.treePid);
            hangLeaderPid = e.treePid;
          } else {
            hangTree = { processes: [] as HangProcess[], treeUnavailable: NO_TREE_CAPTURED };
            hangLeaderPid = undefined;
          }
        }
        // #841 — persist the RAW run1 stream before the bounded tail is
        // computed: the run1 log is the operator's only record of what the
        // first attempt printed, including the stdout that the pre-#841 `||`
        // shape dropped. The write never fails the step — a write error
        // leaves run1LogPath undefined and the caller's evidence string says
        // the log is unavailable.
        run1LogPath = writeConsolidatedVerifyLog(scratchDir, runTimestamp, 1, verifyFailure);
      }
    }
    // #782/#826 — the single bounded flake re-run. It happens on the SAME
    // still-checked-out scratch tree, BEFORE `restoreRoot` (a re-run after
    // the restore would test the restored mainline, not the combination).
    // The retry decision (allow / suppress) is made ONCE in onFirstFailure
    // against the RAW first-run failure and reported on the result as
    // `retryDecision`; the caller renders its notes from that recorded
    // value, not from a second comparator call.
    let recovered = false;
    let retried = false;
    let retryDecision: ConsolidatedVerifyRetryDecision | undefined;
    // #841 — the raw stream of the run that ended the run, carried
    // structurally on the result (see the `rawFailure` field): run1 unless
    // the re-run below replaces it.
    let rawFailure: string | undefined = verifyFailure;
    if (verifyFailure !== undefined && retry?.canRetry) {
      const verdict = retry.onFirstFailure?.(verifyFailure);
      // One decision, one re-run: no callback (or no result from it) means
      // there was no per-worktree failure to compare against — the re-run
      // is allowed (the #782 shape).
      const { allowed, decision } =
        verdict === undefined
          ? { allowed: true as const, decision: "allowed-no-per-worktree-failure" as const }
          : { allowed: verdict.allowed, decision: verdict.decision };
      retryDecision = decision;
      if (allowed) {
        retried = true;
        // #841 — thread scratchDir + the SAME timestamp into the re-run so the
        // run2 log is written next to run1 with the matching prefix. (The
        // commit-pr twin seam in work-driver-integrate-verify.ts passes neither
        // argument and keeps its pre-#841 behaviour per the ticket's scope.)
        // #1427 round 4 — no walker argument: the re-run captures its own tree
        // in its own catch from the executor's `treePid`, which is the only
        // snapshot that can describe a group that run killed.
        const secondRun = await rerunConsolidatedVerifyOnce(
          execFn,
          verifyCmd,
          repoRoot,
          timeoutMs,
          scratchDir,
          runTimestamp,
        );
        if (secondRun === undefined) {
          recovered = true;
          // #841 — on recovery the run2 re-run passed, so it persisted no
          // log of its own (a pass has no raw stream); run1's log is the
          // only record of the transient failure and is what the caller
          // surfaces in the recovery note.
        } else {
          // #841 — the re-run also failed; `rerunConsolidatedVerifyOnce`
          // returned its RAW stream (not the bounded tail) so the
          // classification below sees the same shape a single-run failure
          // sees, and the run2 log was written inside the helper (same
          // scratchDir + timestamp + run=2). `logPath` is the write's own
          // return — `undefined` when the run2 write failed, which the
          // failure shape below reports as an unavailable log.
          verifyFailure = secondRun.raw;
          rawFailure = secondRun.raw;
          run2LogPath = secondRun.logPath;
          timedOut = secondRun.timedOut;
          // The re-run's own tree replaces the first run's: the report is about
          // the run that ended the run, and the re-run walked its own before
          // its kill.
          if (secondRun.tree !== undefined) {
            hangTree = secondRun.tree;
            hangLeaderPid = secondRun.treeLeaderPid;
          } else {
            hangTree = undefined;
            hangLeaderPid = undefined;
          }
        }
      }
    }
    const restore = await restoreRoot();
    const applied =
      orchResult.cherryApplied.length > 0 ? orchResult.cherryApplied : orchResult.patchApplied;
    if (recovered) {
      retry?.onRecover(verifyFailure);
      return {
        status: "passed",
        applied,
        recovered: true,
        retryDecision,
        // #841 — the caller (runVerifyCommandGate) names the run1 log in
        // the recovery note; the run2 re-run passed, so run1 is the
        // interesting record.
        logPath: run1LogPath,
      };
    }
    if (verifyFailure !== undefined) {
      // #723 — same attribution anchor as formatExecError: a bare `.slice(-800)`
      // can splice a passing sub-command's tail onto a later failure.
      const { tail, attributed } = extractAttributedTail(verifyFailure, 800);
      if (!attributed && tail) {
        trace("work-driver: consolidated verify tail is unattributed (no FAILED: marker found)");
      }
      const detail = tail
        ? attributed
          ? tail
          : `${tail} (unattributed — best-effort tail)`
        : "verify command exited non-zero";
      // #841 — the log that matters for THIS failure is run2 when a retry
      // fired (run2 is the run the classifier reads), run1 otherwise.
      // The log path rides on the result so the caller can include it in
      // the failure string (which lands in `verifyEvidence.failures` and
      // renders in the handoff) without regexing `detail`.
      const finalLogPath = retried ? run2LogPath : run1LogPath;
      // #841 — the shared rawOutputClause helper (single home for the
      // sentence so the develop gate and the handoff cannot drift).
      const logClause = rawOutputClause(finalLogPath);
      // #1427 — the hang report is written here, once, for the run that ended
      // the run: the tree was walked at its kill (above), and a report written
      // at the catch would describe the first run after the re-run superseded
      // it. Written only when the run that decided this outcome was killed.
      // #1427 fix round — written ONCE here, for the run that ENDED the run
      // (the flake re-run overwrites `timedOut` / `rawFailure` above), from the
      // tree that run's catch captured: one walk feeds both this report and the
      // failure-string clause, so the two cannot describe different snapshots
      // for one kill.
      if (timedOut) {
        hang = writeGateHangReport({
          scratchDir,
          timestamp: runTimestamp,
          rawFailure: rawFailure ?? verifyFailure ?? "",
          verifyCmd,
          repoRoot,
          timeoutMs,
          tree: hangTree,
          leaderPid: hangLeaderPid,
        });
        // The path rides on the result (`hangLogPath`), which is how the caller
        // records it structurally on the per-gate-call sink and thence the cap
        // event. #1427 round 4 — the old comment here claimed the develop gate
        // recorded it "on the cycle context"; that accumulator is gone, and the
        // result field is the only channel, so this line cannot drift from the
        // caller again without the two disagreeing loudly.
        if (hang !== undefined) opts.onGateHangLogPath?.(hang);
      }
      // #750 — the verified post-condition rides with every outcome of the
      // probe run (the root is transient either way; an unverified claim
      // about it is exactly the incident).
      return {
        status: "failed",
        detail: `${detail}${logClause} ${restoreClaimFor(restore)}`,
        retried,
        recovered: false,
        retryDecision,
        logPath: finalLogPath,
        rawFailure,
        ...(timedOut ? { timedOut } : {}),
        // #1427 — the persisted hang report, carried structurally for the same
        // reason `logPath` is: the cap emit site records it on the event, and a
        // reader never has to find the path in prose.
        ...(hang !== undefined ? { hangLogPath: hang } : {}),
      };
    }
    if (!restore.restored) {
      trace(
        `work-driver: consolidated verify — root not restored after a passing run: ${restore.detail}`,
      );
    }
    // #1240 — the skipped probe reports as a pass carrying the identity that
    // justified it, so the caller records WHY no command ran.
    return skip === undefined
      ? { status: "passed", applied }
      : { status: "passed", applied, skipped: skip };
  } catch (err) {
    const restore = await restoreRoot();
    trace(
      `work-driver: consolidated verify — unexpected error: ${(err as Error).message?.slice(0, 200)}`,
    );
    const e = err as Error & { stderr?: string; stdout?: string };
    return {
      status: "conflict",
      kind: isHostForkExhaustion(`${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`)
        ? "host"
        : "conflict",
      detail: `consolidation could not be performed: ${(err as Error).message?.slice(0, 200)}. ${restoreClaimFor(restore)}`,
    };
  }
}
