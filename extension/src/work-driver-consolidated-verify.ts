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
import { consolidatedVerifySkip } from "./work-driver-consolidated-verify-skip.ts";
import type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify-types.ts";
import type { DriverContext } from "./work-driver-context.js";
import {
  buildResidueFailure,
  classifyRootDirt,
  probeIgnored,
  readIgnoredPaths,
} from "./work-driver-dirty-root-classify.ts";
import { extractAttributedTail, isHostForkExhaustion } from "./work-driver-exec-error.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
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

/**
 * The options for the consolidated verify (the locked wrapper and the
 * unlocked body share this shape; the wrapper only adds the integration
 * lock, the body does the work). Defined ONCE so the two signatures
 * cannot drift.
 */
export interface ConsolidatedVerifyOpts {
  repoRoot: string;
  baseSha: string;
  branchName?: string;
  worktrees: Record<string, string>;
  scratchDir: string;
  verifyCmd: string;
  timeoutMs: number;
  /**
   * #1362 — the cycle's `.pi/dirty-root-exempt` list. Applied to the repoRoot
   * dirty-root preflight below only: the cherry-pick and staging that follow
   * run on the driver's own integration branch and are unchanged.
   */
  dirtyRootExempt?: readonly string[];
  workstreamBaseShas?: Record<string, string>;
  /**
   * #1240 — the tree that just PASSED the per-worktree verify, established
   * by the caller (`verifyTreeId(worktree)`), plus the worktree it came from
   * (the skip note names it). When the cherry-picked probe turns out to be
   * that SAME tree, running the verify command again at repoRoot proves
   * nothing, so it is skipped and the equality is reported as `skipped`.
   * The caller passes this only for the shape where the duplication exists —
   * one workstream with every per-worktree verify green; absent otherwise.
   * Read failure on either side means no skip (fail closed toward running).
   */
  alreadyVerifiedTree?: AlreadyVerifiedTree;
  retry?: {
    canRetry: boolean;
    onRecover: (evidenceTail?: string) => void;
    onFirstFailure?: (
      rawFailure: string,
    ) => { allowed: boolean; decision: ConsolidatedVerifyRetryDecision } | undefined;
  };
}

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
    // Preflight — same as integrate(): repoRoot must be clean before we
    // touch its checkout, or a dirty root would carry operator residue
    // onto the probe branch. Refuse to consolidate rather than guess.
    // `.worktrees/` and `.pi/` scaffolding are not dirt; untracked `??` IS
    // dirt (see the integrate() preflight comment for the reasoning).
    // #746 AC5 — `-uall`, same as the branch-step early gate's read
    // (readRepoRootDirt): plain --porcelain collapses an untracked
    // directory tree to its top-level entry, so an operator would see a
    // bare `?? extension/` and have to go hunting; -uall names the
    // exact files, which is what the dirty-root message is for.
    const { stdout: rootStatus } = await execFn("git status --porcelain -uall", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const candidateLines = rootStatus.split("\n");
    // #1421 — git's own opinion about which of these paths are ignored output.
    // `undefined` (the read failed) classifies every path as dirt, so a gate
    // that cannot tell still refuses: the fail-closed direction is the pre-
    // #1421 behaviour, never "nothing is ignored".
    const classified = classifyRootDirt(
      candidateLines,
      await readIgnoredPaths(execFn, repoRoot),
      exempt,
      await probeIgnored(execFn, repoRoot, candidateLines),
    );
    if (classified.dirt.length > 0) {
      trace("work-driver: consolidated verify — repoRoot dirty, refusing to consolidate");
      const residueNote =
        classified.residue.length > 0
          ? `; ${classified.residue.length} ignored build artifact(s) also present and not counted`
          : "";
      return {
        status: "conflict",
        kind: "dirty-root",
        detail: `repoRoot is dirty (${classified.dirt
          .slice(0, 5)
          .map((l) => l.slice(3))
          .join(
            ", ",
          )}${residueNote}; consolidated verify skipped — the combination is unverifiable until the root is clean`,
      };
    }
    // Nothing left but build output: the batch runs anyway, and the outcome is
    // reported so the cycle's gate can tell "the root was dirty" from "the
    // root held a tool's output" — before #1421 both were
    // `verify-failed:develop`, and a complete, reviewed change parked on five
    // cargo lock files (janit/tehas#248 cycle 248).
    //
    // Reported HERE, before the checkout, for the same reason the reads are:
    // everything below mutates repoRoot, and a decline is not a verdict on the
    // code, so it must not cost a checkout, a cherry-pick or a verify run.
    if (classified.residue.length > 0) {
      trace(
        `work-driver: consolidated verify — repoRoot held ${classified.residue.length} ignored build artifact(s), not dirt: ${classified.residue
          .slice(0, 5)
          .map((r) => r.line.slice(3))
          .join(", ")}`,
      );
      const residuePaths = classified.residue.map((r) => r.line.slice(3).trim());
      return {
        status: "conflict",
        kind: "build-residue",
        residuePaths,
        residueReasons: classified.residue.map((r) => r.reason),
        detail: buildResidueFailure(
          residuePaths,
          "the consolidated verify was declined because the repo root is not clean",
        ),
      };
    }

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
        detail: `cherry-pick conflict — two workstreams edited the same lines; ${restoreClaimFor(restore)}`,
      };
    }
    if (orchResult._applyConflict !== undefined) {
      const { id, reason, patchFile } = orchResult._applyConflict;
      const restore = await restoreRoot();
      return {
        status: "conflict",
        kind: "conflict",
        detail: `patch-apply failed for workstream '${id}': ${reason}. Conflict patch preserved at ${patchFile}. ${restoreClaimFor(restore)}`,
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
    // #1240 — same tree, same verdict: the per-worktree run already executed
    // `verifyCmd` against this exact content, so the probe is not re-run.
    // The restore below still happens (the probe checkout is transient
    // either way) and the result still reports `applied` verbatim.
    if (skip === undefined) {
      try {
        await withVerifySlot(() =>
          execFn(verifyCmd, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }),
        );
      } catch (err) {
        const e = err as Error & { stderr?: string; stdout?: string; killed?: boolean };
        verifyFailure = combinedExecFailureStream(e);
        timedOut = e.killed === true;
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
        // #841 — thread scratchDir + the SAME timestamp into the re-run so
        // the run2 log is written next to run1 with the matching prefix.
        // (The commit-pr twin seam in work-driver-integrate-verify.ts passes
        // neither argument and keeps its pre-#841 behaviour per the ticket's
        // scope.)
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
