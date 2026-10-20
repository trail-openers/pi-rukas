/**
 * work-driver-integrate-verify-probe — the #1404 baseline probe of the
 * commit-pr consolidated gate: re-run the project's OWN verify command at the
 * cycle's base commit in a throwaway detached worktree, and when every failing
 * test name the change run printed also fails there, excuse the park as
 * pre-existing.
 *
 * Extracted from `work-driver-integrate-verify.ts` under the §12 500-line cap,
 * along the seam its siblings already draw (`-flake.ts`, `-hang.ts`, `-log.ts`,
 * `-result.ts`, `-skip.ts`): the gate's own file keeps the runs, the flake
 * retry and the child env it scrubs, and this module owns the one question
 * asked AFTER a failure has been classified. The caller still decides whether
 * to probe at all (`baselineProbeEnabled` + the `timedOut` guard stay there)
 * and still owns the push, so the shape of the escape hatch is unchanged.
 *
 * The probe can only EXCUSE, never pass: it returns the `preExistingOnly`
 * result — still `ok: false`, because the probe has no authority to turn the
 * gate's verdict into a pass — or `undefined`, and the caller parks. Only the
 * caller treats `preExistingOnly` as a reason to continue, and the caller keeps
 * the two guards that decide whether to probe at all (the like-for-like
 * `ranCmd` comparison and the report-channel check) because both read state
 * this seam does not own.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import type { ConsolidationFailureVerdict } from "./work-driver-consolidation-classify.ts";
import type { VerifyChannel } from "./work-driver-integrate-verify-flake.ts";
import type {
  CommitPrConsolidatedVerifyResult,
  CommitPrVerifyOpts,
} from "./work-driver-integrate-verify-result.ts";
import { attributeAgainstBase } from "./work-driver-verify-attribution.ts";
import type { BaselineProbeOutcome } from "./work-driver-verify-attribution.ts";
import type { ExecFn } from "./worktree.ts";

/** Everything the probe needs that the gate has already decided. */
export interface CommitPrProbeParams {
  execFn: NonNullable<ExecFn>;
  opts: CommitPrVerifyOpts;
  /** The command the failing run ACTUALLY executed (fast tier or full). */
  ranCmd: string;
  /** The report channel — present, or the caller would not have probed. */
  channel: VerifyChannel;
  /** The base run's env, with ITS report path; `undefined` = no channel env. */
  probeEnv: NodeJS.ProcessEnv | undefined;
  classifiedMessage: string;
  failureTail: string;
  attributed: boolean;
  verdict: ConsolidationFailureVerdict;
  /** The unclipped stream of the run that failed (the #1064 evidence). */
  failure: string;
  /** The persisted run-log path, when one was written. */
  logPath?: string;
  done: <T>(value: T) => T;
}

/**
 * Ask the #1404 question: does the SAME command fail WITHOUT the change? It
 * runs at most once per call, in a throwaway detached worktree the probe
 * removes, under the SAME bound the failed run got.
 */
export async function commitPrBaselineProbe(
  params: CommitPrProbeParams,
): Promise<CommitPrConsolidatedVerifyResult | undefined> {
  const { execFn, opts, ranCmd, channel, probeEnv, classifiedMessage } = params;
  // The probe needs a base commit to compare against; with none there is
  // nothing to attribute and the caller parks as it did before #1404.
  if (opts.baseSha === undefined) return undefined;
  const { failureTail, attributed, verdict, failure, logPath, done } = params;
  // The run's own stream is the evidence the park carries, and its persisted
  // log path (when one was written) is what makes the park reconstructable.
  const outcome = await attributeAgainstBase(execFn, {
    repoRoot: opts.repoRoot,
    verifyCmd: ranCmd,
    timeoutMs: opts.timeoutMs,
    baseSha: opts.baseSha,
    // The change run ran in the integration checkout; the probe ran in
    // its own worktree. Names are compared by path RELATIVE to the tree
    // each run executed in, so a name outside every known tree can never
    // excuse anything. The workstream worktrees are included because a
    // gate that resolves its own script path prints names under the tree
    // the script lives in, not the cwd it was run from.
    ...(opts.changeRoots !== undefined ? { changeRoots: opts.changeRoots } : {}),
    // #1404 — the out-of-band names. The change run wrote its report to
    // `changeReportFile`; the base run is given `probeEnv` so the loop writes ITS
    // report to `probeReportFile`. All three paths live in the driver's private 0700
    // dir, and `attributeAgainstBase` refuses any path that does not resolve inside
    // it. The `channel === undefined` branch in the caller already returned for a
    // missing channel, so the three paths are always present here.
    reportDir: channel.reportDir,
    changeReportFile: channel.changeReportFile,
    probeReportFile: channel.probeReportFile,
    ...(probeEnv === undefined ? {} : { probeEnv }),
  });
  if (!outcome) return undefined;
  const continued = continueOnPreExisting(outcome, classifiedMessage, done, {
    failureTail,
    attributed,
    verdict,
  });
  if (continued !== undefined) return continued;
  // The park reason names ONLY what the change caused. A cycle where three
  // tests are red and two were red at base is a defect in one test, and an
  // operator told to "fix the consolidated tree" for all three would waste
  // two of those inspections on gate rot the base commit already owns.
  // Names are run through `neutraliseMarkdownField` — they are printed
  // into the cap evidence, the handoff and the PR body, and a test name is
  // data a fixture (or an upstream test) controls.
  const pre = outcome.preExistingFailures;
  const caused = outcome.changeCausedFailures;
  const shown = (names: readonly string[]) => names.map(neutraliseMarkdownField).join(", ");
  const message =
    caused.length > 0
      ? `${classifiedMessage} — ${pre.length + caused.length} test(s) fail; ${pre.length} also fail at the cycle's base commit (${shown(pre)}) and are pre-existing; the failures this change CAUSED are: ${shown(caused)}`
      : classifiedMessage;
  return done({
    ok: false,
    failureTail,
    attributed,
    verdict,
    classifiedMessage: message,
    // #1064 — same raw stream as the plain park below; the probe's own
    // attribution is in `message`, not a substitute for the test output.
    failures: [failure],
    ...(logPath === undefined ? {} : { logPath }),
    ...(pre.length > 0 ? { preExistingFailures: pre } : {}),
    ...(caused.length > 0 ? { changeCausedFailures: caused } : {}),
  });
}

/**
 * The continue gate, and because it is the one branch in this seam that lets a
 * cycle PUSH with a red gate, it reads as a unit rather than as twenty lines
 * inside a probe block.
 *
 * Three conditions, and every one of them has to hold:
 *
 *   - `changeRunNames.length > 0` — the change run FAILED, so a report that
 *     names nothing does not describe this failure (a `FAILED-TESTS: 0` trailer
 *     written by an all-pass half, a loop that counted its names differently
 *     from the run that exited non-zero). "No names" and "no failures" are
 *     different facts and only the second is evidence of anything, so an empty
 *     change report is UNATTRIBUTABLE — never an absence of failures.
 *   - `preExisting.length === changeRunNames.length` — every name the change run
 *     printed is accounted for at base, with no slack for a duplicate spelling.
 *   - `changeCaused.length === 0` — nothing is left over as the change's own.
 *
 * Returns the `preExistingOnly` result when all three hold, else `undefined`
 * (the caller parks). It still reports `ok: false` — the probe has no authority
 * to turn the gate's verdict into a pass.
 */
function continueOnPreExisting(
  outcome: BaselineProbeOutcome,
  classifiedMessage: string,
  done: <T>(value: T) => T,
  evidence: { failureTail: string; attributed: boolean; verdict: ConsolidationFailureVerdict },
) {
  const pre = outcome.preExistingFailures;
  const caused = outcome.changeCausedFailures;
  const changeNames = outcome.changeRunNames;
  if (!(changeNames.length > 0 && pre.length === changeNames.length && caused.length === 0)) {
    return undefined;
  }
  const shown = pre.map(neutraliseMarkdownField).join(", ");
  return done({
    ok: false as const,
    ...evidence,
    classifiedMessage: `${classifiedMessage} — ${pre.length} test(s) fail; all ${pre.length} also fail at the cycle's base commit (${shown}) and are pre-existing`,
    preExistingOnly: true,
    preExistingFailures: pre,
  });
}
