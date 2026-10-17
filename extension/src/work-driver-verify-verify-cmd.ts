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
  isHostExhaustionFailure,
  isHostForkExhaustion,
  pidLimitSnapshot,
} from "./work-driver-exec-error.ts";
import { captureProcessTree } from "./work-driver-gate-hang.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { compareWithBaseline } from "./work-driver-verify-baseline.ts";
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
  } = opts;
  const VALID_SHA_RE = /^[0-9a-f]{40}$/;
  const isValidSha = (s: string | undefined) => typeof s === "string" && VALID_SHA_RE.test(s);
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
        execFn(cmd, { cwd, timeout: verifyTimeoutMs(), maxBuffer: 4 * 1024 * 1024 }),
      );
    } catch (err) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        timedOutKill?: boolean;
        overflow?: string;
        treePid?: number;
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
            timeoutMs: verifyTimeoutMs(),
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
          verifyHangFailure(ran, `in ${cwd}`, verifyTimeoutMs(), hang),
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
  const consOpts: ConsolidatedVerifyOpts = {
    repoRoot: ctx.repoRoot,
    baseSha: baseSha as string,
    worktrees: state.pipelineState.worktrees ?? {},
    // #794 — own-range selection: a stacked workstream's range is
    // measured against its dependency's tip, so its ancestor commits are
    // not re-picked on top of their content (the #775 replay).
    workstreamBaseShas,
    scratchDir,
    verifyCmd: cmd,
    timeoutMs: verifyTimeoutMs(),
    // #1240 — the N=1 duplicate run: same tree, same verdict.
    ...(alreadyVerifiedTree !== undefined ? { alreadyVerifiedTree } : {}),
    // #1362 — the repoRoot dirty-root preflight inside honours the project's
    // exemption list, so a tool's local file no longer refuses the batch.
    dirtyRootExempt: ctx.dirtyRootExempt,
    // #1427 fix round — the walker is forwarded under the field `ConsolidatedVerifyOpts`
    // actually declares. It used to be spread onto the REPORTING call below under
    // a name that exists nowhere (`onWalk`), so the probe silently fell back to
    // the real `ps` and the report described whatever else was on the host.
    ...(walkProcessTree !== undefined ? { walkProcessTree } : {}),
    retry: {
      canRetry: flakeRetryPrecondition,
      onFirstFailure: (raw) => {
        if (singlePerAssertion === undefined) {
          return { allowed: true, decision: "allowed-no-per-worktree-failure" };
        }
        if (singlePerAssertion === null) {
          return { allowed: true, decision: "allowed-unknown" };
        }
        return sharesAssertion(raw, singlePerAssertion)
          ? { allowed: true, decision: "allowed-shared" }
          : { allowed: false, decision: "suppressed-mismatch" };
      },
      onRecover: (evidenceTail) => {
        // #841 — onRecover fires BEFORE the run result is available, so the
        // log path is not in scope here. The post-run pass below (the
        // `cons.recovered === true` branch) surfaces the run1 log path in
        // its own note, which is the one the operator actually reads when
        // the gate proceeds after recovery.
        notes.push(
          `consolidated verify RECOVERED after one bounded re-run (transient flake) — first-run failure preserved${evidenceTail ? `: ${evidenceTail}` : ""}`,
        );
        // The decision note rides on the recorded `retryDecision` AFTER the
        // consolidated run (below), where the same value also drives the
        // failed-path notes — one read, no closure cell.
        onVerifyFlakeRecovered?.(evidenceTail);
      },
    },
  };
  const cons = await runConsolidatedVerify(execFn, consOpts);
  reportConsolidatedVerifyOutcome(cons, {
    cmd,
    failures,
    notes,
    ctx,
    worktrees,
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
  // Aggregation: a consolidated FAILURE keeps per-worktree failures as
  // failures. A consolidated PASS does NOT downgrade them (#1005 reverses
  // the #669 downgrade): a workstream that fails in its OWN tree must block,
  // even when the combined tree passes — a combined run that passes does not
  // excuse a workstream that fails on its own (the #933/#996 shape: 0/5 and
  // 1/5 workstreams passing their own gate, the split halves coupled). The
  // per-worktree failure is kept as a failure AND the passing consolidated
  // run is still noted (the evidence that the combination is not the cause
  // is preserved in the note; the per-worktree defect is not excused).
  if (perWorktreeVerifyFailures.length > 0) {
    failures.push(...perWorktreeVerifyFailures);
    for (const f of perWorktreeVerifyFailures) {
      notes.push(
        `per-worktree verify (evidence; still a failure — the consolidated pass does not excuse a per-worktree defect, #1005) — ${f}`,
      );
    }
  }
  // Baseline comparison — ONLY once the verify command has already failed
  // (never on the happy path: it costs a full gate run). Not when the host
  // could not fork: the probe cannot run there either, and its "red at base"
  // would be the same environment failure read as a verdict. See
  // work-driver-verify-baseline.ts.
  if (
    (cons.status === "failed" || perWorktreeVerifyFailures.length > 0) &&
    !failures.some(isHostExhaustionFailure)
  ) {
    const attributed = await compareWithBaseline(execFn, {
      repoRoot: ctx.repoRoot,
      baseSha: baseSha as string,
      issue: ctx.issue,
      cmd,
      timeoutMs: verifyTimeoutMs(),
      changeFailures: [
        ...(cons.status === "failed"
          ? [{ text: cons.rawFailure ?? "", timedOut: cons.timedOut === true }]
          : []),
        ...perWorktreeVerifyFailures.map((f) => ({ text: f, timedOut: isVerifyTimeoutFailure(f) })),
      ],
      failures,
      notes,
    });
    if (attributed) opts.onBaselineAttributed?.();
  }
}
