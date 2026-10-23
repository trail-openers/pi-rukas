/**
 * work-driver-integrate-verify — #777 commit-pr twin: run the project's
 * verify command against the CONSOLIDATED tree after the branch has the
 * cherry-picked commit, and — on failure — classify it instead of parking
 * on the generic "the consolidated tree fails the project's verify command".
 *
 * The develop-time twin lives in `work-driver-consolidated-verify.ts` and
 * returns a structured `{status, detail}`; this module runs on the
 * commit-pr path, where the consolidated tree IS the branch at repoRoot
 * (not a scratch probe) and the caller (`integrate()` step 4) needs a
 * fail-closed verdict plus the classification to name the handoff.
 *
 * The classification is delegated to the shared classifier
 * (`work-driver-consolidation-classify.ts`) — the same one the develop
 * seam uses — so the two call sites cannot drift. The `failureTail` we
 * hand to it is the raw stderr/stdout of the verify run, bounded to the
 * same 800 chars the develop seam uses via `extractAttributedTail`; the
 * classifier re-extracts the specific assertion from that tail, which is
 * the same contract the develop path relies on.
 *
 * The N=1 invariant is honoured by the classifier itself (it takes the
 * workstream count and refuses `consolidation-created` at N=1) — this
 * module just threads the count through.
 *
 * The restore claim is NOT mixed into `failureTail`:
 * `consolidateCommitPrVerifyFailure` composes the final `reason` from the
 * classified message + the claim, so the assertion the classifier parses is
 * the one the verify command emitted, not the restore post-condition.
 */

import { withVerifySlot } from "./host-resources.ts";
import { trace } from "./trace.ts";
import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "./work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import { type HangProcess, NO_TREE_CAPTURED, captureProcessTree } from "./work-driver-gate-hang.ts";
import { createVerifyChannel, runFlakeRetry } from "./work-driver-integrate-verify-flake.ts";
import { commitPrBaselineProbe } from "./work-driver-integrate-verify-probe.ts";
import type { CommitPrConsolidatedVerifyResult } from "./work-driver-integrate-verify-result.ts";
import type { CommitPrVerifyOpts } from "./work-driver-integrate-verify-result.ts";
import { commitPrSkipDecision } from "./work-driver-integrate-verify-skip.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import { UNATTRIBUTED_NOTE } from "./work-driver-verify-develop-helpers.ts";
import {
  VERIFY_REPORT_FILE_ENV,
  createVerifyReportDir,
  createVerifyReportFile,
  removeVerifyReportDir,
  verifyReportEnv,
} from "./work-driver-verify-report-path.ts";

/**
 * Escape hatch for #1404's baseline probe. `0` skips the probe entirely, so
 * every consolidated verify failure parks as it did before the feature — the
 * probe can only ever EXCUSE a failure, so turning it off can only ever make
 * the seam stricter, never looser.
 */
export function baselineProbeEnabled(): boolean {
  return process.env.PI_ENSEMBLE_INTEGRATION_VERIFY_BASELINE_PROBE !== "0";
}
import { commitPrHangResult } from "./work-driver-integrate-verify-hang.ts";
import { createCommitPrVerifyLogSink } from "./work-driver-integrate-verify-log.ts";
import { isTimedOutKill } from "./work-driver-verify-develop-helpers.ts";
import { failedVerifyCmd, fastVerifyCmdFor, withFastTier } from "./work-driver-verify-fast.ts";
import { combinedExecFailureStream } from "./work-driver-verify-flake.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Run the project's verify command against the CONSOLIDATED tree at
 * repoRoot (which `integrate()` has already put on the integration
 * branch with the cherry-picked commit). On failure, classify via the
 * shared classifier and return the structured result.
 *
 * The caller is responsible for the restore claim — it composes the
 * final `reason` string from `classifiedMessage` + its own claim, which
 * keeps the restore concern (this module has no knowledge of the
 * original ref) out of the classification input.
 *
 * @param execFn — shell executor (injection seam for tests).
 * @param verifyCmd — the project's verify command (from `.pi/verify-cmd`).
 * @param repoRoot — the repoRoot the consolidated tree is checked out at.
 * @param workstreamCount — the number of workstreams in the cycle (N).
 * @param workstreamIds — all workstream ids in order.
 * @param perWorktreeFailuresByWs — per-worktree verify failure texts
 *   keyed by workstream id. In the commit-pr seam this is always `{}` —
 *   the develop gate ran per-worktree verify in a previous step and the
 *   results live in the state file's `verifyEvidence`, not here — the
 *   classifier's per-workstream-defect branch simply does not fire,
 *   which is correct: at commit-pr, a per-workstream defect would have
 *   been caught (or parked) in the develop step and never reach the
 *   push. The N=1 invariant is still honoured by the classifier.
 *
 * #782 — single bounded flake retry. On the FIRST consolidated run at
 * commit-pr (ciRetryCount unset), if every per-worktree verify passed
 * (perWorktreeFailuresByWs is empty) and there are multiple workstreams
 * (N>1), a transient flake (the #777/#296 watchdog-timing class under
 * parallel-fanout load) is classified and parked before the re-run gets
 * a chance. We now re-run the SAME verify command ONCE in the SAME still-
 * checked-out integration tree BEFORE classifying. If the re-run passes,
 * the caller proceeds (the flake was a false alarm); if it fails too,
 * classification proceeds as today. A test that fails twice is not a
 * flake — it still parks. The retry is exactly one re-run, never a
 * loop; the precondition (first run, N>1, no per-worktree failures) is
 * checked here so a later ci-retry (ciRetryCount set) re-enters the
 * single-run path without a second re-run.
 */
export async function runCommitPrConsolidatedVerify(
  execFn: NonNullable<ExecFn>,
  opts: CommitPrVerifyOpts,
): Promise<CommitPrConsolidatedVerifyResult> {
  // The single flake retry is allowed only when: (a) this is the first
  // consolidated run at commit-pr (isCiRetry unset), (b) there are multiple
  // workstreams (N>1 — N=1 is a no-op consolidation, its failure is a
  // per-workstream defect), and (c) every per-worktree verify passed
  // (perWorktreeFailuresByWs is empty — at this seam it is always {}, but
  // the check is defensive and makes the precondition explicit).
  const canRetry =
    opts.isCiRetry !== true &&
    opts.workstreamCount > 1 &&
    Object.keys(opts.perWorktreeFailuresByWs ?? {}).length === 0;

  // #1324 — `.pi/verify-cmd-fast` runs first on the consolidated tree too.
  const fastCmd = await fastVerifyCmdFor(opts.repoRoot);
  const verifyExec = withFastTier(execFn, opts.verifyCmd, fastCmd);

  // #1404 — the report channel is the probe's ONLY name source: a private 0700
  // dir under TMPDIR, created by the driver, holding the change run's report and
  // the base probe's report, set up before ANY run so every exec path (including
  // the #1240 skip) tears it down. Nothing the project controls
  // (`.pi/verify-cmd` is a project file) contributes either path, so neither the
  // project nor a test can point the reader at a file of its own.
  //
  // #1404 fix round 3 — the setup is GUARDED and the body sits in a `finally`
  // that always removes the dir. A temp dir the OS refuses (disk full,
  // `TMPDIR` gone, a restrictive umask on the chmod) must not turn into a failed
  // verify step: with no channel there is no report, so the probe reads
  // nothing, excuses nothing, and the cycle parks exactly as it did before
  // #1404 — the fail-closed direction, and the same outcome a project whose
  // verify command is not this loop already gets. A broken channel costs an
  // excuse, never a merge.
  const channel = createVerifyChannel();
  try {
    // #1404 fix round 3 — the report env is built from a SNAPSHOT of
    // `process.env` taken once here, never from a mutated global. `VERIFY_REPORT_FILE`
    // reaches the env object handed to the ONE gate exec below and nowhere else:
    // no `process.env` assignment exists in this module, so no other child the
    // driver spawns (an ops `git push`, a `gh` call, a developer's worktree
    // provisioning) can inherit a report path and write a verdict the driver
    // would read. A test that ever sets the variable on the real env is also
    // excluded here — the driver's own path always wins.
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv[VERIFY_REPORT_FILE_ENV];
    const changeEnv =
      channel === undefined
        ? undefined
        : verifyReportEnv(verifyChildEnv(baseEnv), channel.changeReportFile);
    const probeEnv =
      channel === undefined
        ? undefined
        : verifyReportEnv(verifyChildEnv(baseEnv), channel.probeReportFile);
    // `done` is the per-exit cleanup point; the `finally` is the guarantee.
    const done = <T>(value: T): T => {
      if (channel !== undefined) removeVerifyReportDir(channel.reportDir);
      return value;
    };
    return await runBody(done, changeEnv, probeEnv);
  } finally {
    // Cleanup on EVERY exit, including a throw out of an executor or the
    // classifier. `removeVerifyReportDir` is best-effort and idempotent, so a
    // second call after a `done()` costs nothing. A leak per verify call under a
    // long-lived driver is a disk story with no upside.
    if (channel !== undefined) removeVerifyReportDir(channel.reportDir);
  }

  async function runBody(
    done: <T>(value: T) => T,
    /** The change run's env, with the report path; `undefined` = no channel. */
    changeEnv: NodeJS.ProcessEnv | undefined,
    /** The base probe's env, with the report path; `undefined` = no channel. */
    probeEnv: NodeJS.ProcessEnv | undefined,
  ): Promise<CommitPrConsolidatedVerifyResult> {
    // #1240 — the duplicate-run check (`commitPrSkipDecision`): why the tree is
    // read here, after the caller committed the integration, and why residue in
    // the index forbids the skip. Every non-skip outcome falls through to the
    // run below.
    const skip = await commitPrSkipDecision(execFn, opts.repoRoot, opts.alreadyVerifiedTree);
    if (skip !== undefined) {
      return done({ ok: true, skipped: skip });
    }
    let timedOut = false;
    let ranCmd = opts.verifyCmd;
    // #1427 — the killed run's stream and the tree captured at its kill. The
    // capture happens in the catch, not after: the nessie #1054 case is children
    // that outlive their leader, and a walk after the settle would report nothing
    // about the processes the report exists to name.
    let killedOutput = "";
    let killedTree: { processes: HangProcess[]; treeUnavailable?: string } | undefined;
    // #1702 — the run-log sink (its module owns the contract: one timestamp per pair, and
    // only the write's own return reaches `logPath`).
    const logs = createCommitPrVerifyLogSink(opts.scratchDir, opts.onConsolidatedLogPath);
    const runOnce = async (): Promise<string | undefined> => {
      try {
        await withVerifySlot(() =>
          verifyExec(opts.verifyCmd, {
            cwd: opts.repoRoot,
            maxBuffer: 8 * 1024 * 1024,
            timeout: opts.timeoutMs,
            // #1404 — the loop writes its own verdict here; a test child never
            // sees the variable (the loop `env -u`s it at its single spawn).
            // A missing channel means no `env` key at all, which is the shape the
            // executor's own ambient env produces — no report, no excuse.
            ...(changeEnv === undefined ? {} : { env: changeEnv }),
          }),
        );
        return undefined;
      } catch (err) {
        // #841 — classify on stdout AND stderr (the shared helper), not on
        // stderr-with-stdout-dropped: a failure that prints its assertion on
        // stdout and a warning on stderr must still classify on the assertion.
        const e = err as Error & {
          stderr?: string;
          stdout?: string;
          killed?: boolean;
          timedOutKill?: boolean;
          overflow?: string;
          treePid?: number;
        };
        // #1427 fix round — a maxBuffer overflow is a kill but not a hang; only
        // the wall-clock kill earns the hang clause.
        timedOut = isTimedOutKill(e);
        ranCmd = failedVerifyCmd(err, opts.verifyCmd);
        const stream = combinedExecFailureStream(e);
        if (timedOut) {
          killedOutput = stream;
          // #1427 round 4 — ONE capture, made in this catch while the group's
          // stragglers can still be alive, and handed to the clause. The clause
          // can no longer walk (`treePid`/`walk` are gone from `KilledGateRun`),
          // so a seam that does not capture here gets `no tree was captured`.
          killedTree =
            typeof e.treePid === "number"
              ? captureProcessTree(e.treePid)
              : { processes: [] as HangProcess[], treeUnavailable: NO_TREE_CAPTURED };
        }
        return stream;
      }
    };

    // The project's gate can run for minutes; without this line the step is
    // silent from its start to its end.
    trace(
      `work-driver: commit-pr — verifying the consolidated tree before the push: ${opts.verifyCmd.slice(0, 120)}`,
    );
    let firstFailure = await runOnce();
    if (firstFailure === undefined) return done({ ok: true });
    // #1702 — run1's log, written before the flake retry may replace the stream the
    // operator would otherwise reconstruct. Same name and 0600 mode as the develop side.
    logs.persist(1, firstFailure);

    // #782 — on the first run, with every per-worktree verify passed and N>1,
    // re-run the SAME command ONCE in the SAME still-checked-out integration
    // tree BEFORE classifying. A transient flake (the #777/#296 watchdog-
    // timing class) passes on the second run; a genuine consolidated defect
    // fails both times and is classified below exactly as today. The recipe
    // lives in `work-driver-integrate-verify-flake.ts` (the §12 cap); the
    // precondition stays here because it reads this step's own state, and the
    // trace stays here because it describes the run the caller owns.
    if (canRetry) {
      trace(
        `work-driver: commit-pr verify failed on the first run — re-running the verify command once (flake retry, N=${opts.workstreamCount})`,
      );
    }
    const settled = await runFlakeRetry(
      // The fast-tier wrapper, not the raw executor: the re-run must go through
      // the same tiered command the first run did, or the two runs are different
      // gates and the comparison below cannot be made like with like.
      verifyExec,
      {
        cmd: opts.verifyCmd,
        fastCmd,
        repoRoot: opts.repoRoot,
        timeoutMs: opts.timeoutMs ?? 30 * 60_000,
        canRetry,
        firstFailure,
        firstTimedOut: timedOut,
        ...(killedTree === undefined ? {} : { firstTree: killedTree }),
        ranCmd,
        ...(changeEnv === undefined ? {} : { changeEnv }),
      },
    );
    if (settled.recovered === true) {
      trace(
        "work-driver: commit-pr verify re-run PASSED — the first-run failure was a flake; proceeding without classifying",
      );
      // The caller's onRecover callback is where the `verify-flake-recovered`
      // step event is appended, so it happens BEFORE the caller appends
      // `verify-failed:commit-pr` + its verifyEvidence (eventLog is append-only;
      // the recovered path appends no cap).
      opts.onRecover?.(firstFailure);
      return done({ ok: true, recovered: true });
    }
    firstFailure = settled.failure;
    ranCmd = settled.ranCmd;
    timedOut = settled.timedOut;
    killedOutput = settled.killedOutput;
    killedTree = settled.killedTree;
    // The re-run failed and its tail is what is classified below, so its own stream is the
    // one the operator needs (run1's log keeps the transient case recoverable too).
    logs.persist(2, firstFailure);

    const failure = firstFailure;

    // The tail we hand to the classifier: anchored at the FAILED: marker when
    // present, last 800 chars otherwise (the biome/tsc shape emits no marker).
    // The same `extractAttributedTail` the develop seam uses, so the assertion
    // extraction path is identical across both seams.
    const { tail, attributed } = extractAttributedTail(failure, 800);
    // The restore claim is NOT in this tail — the caller composes it from
    // the classified message + its own claim. Passing the raw tail (with
    // the unattributed marker when applicable) keeps the classifier's
    // assertion extraction clean.
    const failureTail = tail || "verify command exited non-zero";
    const verdict = classifyConsolidatedVerifyFailure(
      opts.workstreamCount,
      opts.workstreamIds,
      failureTail + (attributed ? "" : ` ${UNATTRIBUTED_NOTE}`),
      opts.perWorktreeFailuresByWs ?? {},
      // #1064 — the unclipped stream, so the test names the 800-char window elided are
      // recovered into `namedFailures` instead of the message printing the sentinel over
      // a run that had named every failing test.
      failure,
    );
    // #1324 — a killed run's stream stops wherever the kill landed: report
    // the bound, never a classification of the code.
    if (timedOut) {
      return done(
        commitPrHangResult({
          ranCmd,
          repoRoot: opts.repoRoot,
          bound: opts.timeoutMs ?? 30 * 60_000,
          output: killedOutput,
          ...(killedTree === undefined ? {} : { tree: killedTree }),
          failureTail,
          attributed,
          verdict,
          ...(logs.written !== undefined ? { logPath: logs.written } : {}),
        }),
      );
    }
    const classifiedMessage = consolidatedFailureMessage(verdict, ranCmd);

    // #1404 — before this parks, ask the question the commit-pr seam never
    // asked: does the SAME command fail WITHOUT the change? The probe runs
    // exactly here — after the #782 flake retry, on the classified (second)
    // failure, never on a run already known `timedOut` (a killed base run
    // would tell us nothing about test names) — and at most once per call.
    // It re-runs the project's own command under the SAME bound the failed
    // run got, in a throwaway detached worktree the probe removes. The probe
    // can only EXCUSE failures, never turn this verdict into a pass: only the
    // caller — which alone owns the push — treats `preExistingOnly` as a
    // reason to continue.
    if (opts.baseSha !== undefined && !timedOut && baselineProbeEnabled()) {
      // #1404 fix round — the probe must re-run the command the change run
      // ACTUALLY executed (`ranCmd`: the fast tier when that tier is what
      // failed, the full command otherwise), under the same cwd and executor.
      // Probing `opts.verifyCmd` instead would compare two different gates and
      // attribute one run's names to the other's verdict, so the whole
      // comparison — including its continue path — is refused when they differ.
      if (ranCmd !== opts.verifyCmd) {
        trace(
          `work-driver: commit-pr verify — the failing run executed \`${ranCmd.slice(0, 80)}\`, not the configured verify command, so the baseline probe cannot compare like with like; the consolidated failure parks as before`,
        );
      } else if (channel === undefined) {
        // #1404 fix round 3 — no channel, no report, so the probe has no name
        // source at all. Skipping it outright is the honest shape: paying for a
        // full base run that cannot attribute anything is worse than not running
        // it, and the outcome is identical (the park the seam had before #1404).
        trace(
          "work-driver: commit-pr verify — no out-of-band report channel exists for this run, so failing-test names cannot be attributed and the baseline probe is skipped; the consolidated failure parks as before",
        );
      } else {
        // The probe itself (its `attributeAgainstBase` call, the continue gate,
        // and the two parks it can produce) lives in
        // `work-driver-integrate-verify-probe.ts` — the §12 cap, and the same
        // per-concern seam as `-flake.ts` / `-hang.ts` / `-log.ts` / `-skip.ts`.
        // `undefined` means it excused nothing and this parks below.
        const excused = await commitPrBaselineProbe({
          execFn,
          opts,
          ranCmd,
          channel,
          probeEnv,
          classifiedMessage,
          failureTail,
          attributed,
          verdict,
          failure,
          ...(logs.written === undefined ? {} : { logPath: logs.written }),
          done,
        });
        if (excused !== undefined) return excused;
      }
    }
    return done({
      ok: false,
      failureTail,
      attributed,
      verdict,
      classifiedMessage,
      // #1064 — the raw stream the classifier saw, on the result so the terminal cap
      // can name the failing tests. It is bounded at the cap site
      // (`boundJoinFailures`), never here: bounding it at this height is what made the
      // `FAILED:` summary fall outside the window in the first place.
      failures: [failure],
      ...(logs.written !== undefined ? { logPath: logs.written } : {}),
    });
  }
}
