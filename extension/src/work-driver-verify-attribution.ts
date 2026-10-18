/**
 * work-driver-verify-attribution — #1404: per-test baseline attribution for
 * the commit-pr consolidated verify.
 *
 * The commit-pr gate (`runCommitPrConsolidatedVerify`) ran the project's
 * verify command against the consolidated tree and parked ANY failure as
 * `integration-verify-failed` — terminal, no PR, handoff blames the diff.
 * On this host every one of those parks was a gate that was already red at
 * the cycle's base commit (queue census 2026-10-16: 4 groups, #1043/#1111/
 * #1114/#1105, zero code defects). The develop step learned this lesson in
 * #1349 and got `compareWithBaseline`; the commit-pr seam never did.
 *
 * This module answers the commit-pr seam's question — WHICH failing tests did
 * the change cause? — by diffing the failing-test-name SETS of the change run
 * and a base-commit run. It is deterministic by design: no model, no decision
 * seam, just set difference over names parsed from verify-loop.sh's `FAILED:`
 * markers.
 *
 * Two deliberate departures from the develop step's `baselineExplainsChange`
 * (which stays that step's ONLY attribution path, untouched):
 *
 * - It is all-or-nothing over ONE extracted assertion; this is per-name over
 *   two parsed sets, so a mixed run excuses the names that fail at base and
 *   still parks the ones that do not.
 * - Absence of names is NOT "all pre-existing". A tsc/biome failure prints no
 *   `FAILED:` marker; a truncated `… and N more` hides names; a killed run's
 *   stream ends wherever the kill landed. In every such shape the verdict is
 *   `unattributable` and the caller parks with a named reason — a wrong
 *   "the change is not implicated" is worse than none.
 *
 * Because the continue path PUSHES with a red gate, every rule here is
 * fail-closed: the only shapes that excuse a test are ones whose evidence is
 * complete and anchored (see `compareNames` for the anchoring, `summaryCount`
 * for what a summary is allowed to claim).
 */

import { trace } from "./trace.ts";
import { baselineProbeWorktreePath, probeBaselineVerify } from "./work-driver-verify-baseline.ts";
import {
  type NameRoots,
  compareNames,
  emptyBaseReason,
  isContradictoryTally,
} from "./work-driver-verify-names.ts";
import { readVerifyReport } from "./work-driver-verify-report-file.ts";
import {
  createVerifyReportFile,
  isInsideReportDir,
  isRegularReportFile,
  verifyReportEnv,
} from "./work-driver-verify-report-path.ts";
import type { ExecFn } from "./worktree.ts";

/** The three-way per-test verdict over the change run's failing test names. */
export interface FailureAttribution {
  /**
   * Failing tests that ALSO failed at base — the change did not cause them.
   * Empty whenever `unattributable` is set.
   */
  preExisting: string[];
  /**
   * Failing tests that PASSED at base — caused by this change. These are the
   * only failures that may park the cycle as `integration-verify-failed`.
   */
  changeCaused: string[];
  /**
   * Why no per-test verdict could be reached, naming the evidence that is
   * missing. Set = `preExisting` and `changeCaused` are empty and the caller
   * parks (fail closed), never continues.
   */
  unattributable?: string;
}

/**
 * What `attributeFailuresByName` has already resolved through the filesystem.
 *
 * `compareNames` re-resolves every root and every name with `realpathSync` on
 * EVERY comparison (the macOS `/var` → `/private/var` case `asPath` exists
 * for), so a run with C change names and B base names costs 2·C·B + O(C+B)
 * stat-heavy walks. One memo per call takes it to O(C+B) — and the memo is
 * scoped to the call, never to the module, because the probe deletes its own
 * worktree before this runs and a cache that outlived the call would pin a
 * path whose disk state is about to change under a later call.
 *
 * The shape is the structural one `work-driver-verify-names.ts` declares, so a
 * plain `Map` is the memo and no import cycle appears for the shared type.
 */
export type NameResolution = Map<string, string | null>;

/** Fresh memo for one `attributeFailuresByName` call. */
export function createNameResolution(): NameResolution {
  return new Map();
}

/**
 * The one rule: a failing test name in BOTH runs' sets is pre-existing; a
 * name in the change run's set only is change-caused. Neither empty set is
 * ever a pass:
 *
 * - no change-run names → a failure the parser produced no names for cannot be
 *   excused per-test (a tsc/biome failure prints no `FAILED:` marker at all);
 * - no base-run names → nothing has been shown to be red without this change,
 *   which is the exact opposite of an excuse. A base that named NOTHING is
 *   the weakest possible evidence, not the strongest.
 *
 * Names are compared by `compareNames`, which requires the two spellings to
 * resolve to the SAME project-relative path. The names RETURNED are the change
 * run's own spellings — those are what an operator greps for and what the PR
 * body lists.
 */
export function attributeFailuresByName(
  changeNames: readonly string[],
  baseNames: readonly string[],
  roots: NameRoots,
  /** Memo from `createNameResolution()`; omit for a live walk every time. */
  resolution?: NameResolution,
): FailureAttribution {
  if (changeNames.length === 0) {
    return {
      preExisting: [],
      changeCaused: [],
      unattributable:
        "the failing tests could not be named from the verify output, so no per-test comparison was possible — a change run that FAILED while naming nothing is a report that does not describe that failure, which is unattributable, not an absence of failures",
    };
  }
  if (baseNames.length === 0) {
    return {
      preExisting: [],
      changeCaused: [],
      unattributable:
        "the base run named no failing tests, so nothing was shown to be red without this change",
    };
  }
  const changeCaused: string[] = [];
  const preExisting: string[] = [];
  outer: for (const name of new Set(changeNames)) {
    let unknown = false;
    for (const baseName of baseNames) {
      const cmp = compareNames(name, baseName, roots, resolution);
      if (cmp === "same") {
        preExisting.push(name);
        continue outer;
      }
      if (cmp === "unknown") unknown = true;
    }
    // A name that could not be placed in either tree says nothing about
    // whether the two runs ran the same file. Guessing either way is wrong —
    // "different" would park a healthy cycle, "same" would push a red gate —
    // so the whole run becomes unattributable and the caller parks with the
    // reason.
    if (unknown) {
      return {
        preExisting: [],
        changeCaused: [],
        unattributable:
          "a failing test name could not be placed in either the integration tree or the base probe's tree, so no comparison of it is trustworthy",
      };
    }
    changeCaused.push(name);
  }
  return { preExisting, changeCaused };
}
/** What one baseline probe learned about a consolidated verify failure. */
export interface BaselineProbeOutcome {
  /** Failing test names that also fail at base — not caused by the change. */
  preExistingFailures: string[];
  /** Failing test names that pass at base — caused by the change. */
  changeCausedFailures: string[];
  /**
   * #1404 round 3 — the names the CHANGE run's report carried, exactly as read
   * (not deduplicated). The continue gate needs the denominator the other two
   * fields were computed from: `preExistingFailures.length === 0` is also the
   * shape of "the run named nothing", and only the caller that owns the push
   * should have to know the difference — so it is handed the count it has to
   * check rather than being asked to infer it.
   */
  changeRunNames: string[];
}

/** A git commit is 40 hex chars; nothing else may reach `git worktree add`. */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * #1404 — run the base probe and diff the failing-test-name sets.
 *
 * NAMES COME FROM REPORT FILES, NOT FROM THE STREAM. The caller hands in the
 * path each run wrote its out-of-band verdict to (`changeReportFile` for the
 * run that just failed, `probeReportFile` for the base run this function makes
 * it produce). Names parsed out of stdout/stderr are a string a test can print
 * — and the triad shape (per-file `FAILED:` + a count-matched summary + a
 * non-zero `P:/F:` tally) is byte-identical to the loop's own output, so a
 * green base could be made to name the change's failure and the cycle would
 * push. The stream is still read, and still cross-checked, but it can now only
 * ever REFUSE an excuse, never grant one.
 *
 * Returns `undefined` — the park stands with the original reason — for every
 * shape the probe cannot establish: the sha is not a sha, either report file
 * is missing / empty / malformed / self-contradictory or lives outside the
 * driver's private report dir, the base could not be checked out, the base run
 * died for want of dependencies, the base run was killed at its bound, the
 * probe ran a DIFFERENT command than the change run did, or the two pieces of
 * evidence about the base run disagree. Fail-closed is the default: a wrong
 * "not the change" is worse than a park, so absence of evidence is never read
 * as evidence of innocence.
 *
 * Otherwise returns the per-name split, and the ONLY case that may continue
 * (all change names pre-existing, both name sets non-empty) is expressed by
 * the caller checking `changeCausedFailures.length === 0`.
 */
export async function attributeAgainstBase(
  execFn: NonNullable<ExecFn>,
  opts: {
    repoRoot: string;
    /**
     * The command the CHANGE run actually executed — its fast tier when that
     * tier is what failed (`ranCmd`), not the full command. Probing a
     * different command than the one that failed compares two gates, not one
     * gate twice, and every name comparison below would be meaningless.
     */
    verifyCmd: string;
    timeoutMs?: number;
    /** The cycle's base commit, validated as 40-hex before it reaches git. */
    baseSha: string;
    /**
     * Every tree the CHANGE run may have executed in, beyond the integration
     * checkout (`repoRoot`) and the probe tree, which the seam always knows.
     * A committed gate script resolves its own directory, so its printed paths
     * follow the checkout the script lives in rather than the cwd it was run
     * from. Anything the change run printed from outside ALL of these is
     * unplaceable, and therefore unattributable.
     */
    changeRoots?: readonly string[];
    /**
     * The change run's out-of-band report file, as created by the caller in its
     * private 0700 report dir and written by the smoke loop. REQUIRED: without
     * it there is no trustworthy name list, and a caller that has none gets the
     * pre-#1404 park rather than a stream-derived excuse.
     */
    changeReportFile: string;
    /**
     * The driver's private report directory. Both report paths must resolve
     * inside it, or neither is read — this is what stops a project (whose
     * `.pi/verify-cmd` is a project file) from steering the reader at a file a
     * test wrote.
     */
    reportDir: string;
    /**
     * The env the base run executes with — the caller's env plus
     * `VERIFY_REPORT_FILE` pointing at `probeReportFile`. Absent → the ambient
     * env, which writes no report, which reads as unattributable.
     */
    probeEnv?: NodeJS.ProcessEnv;
    /**
     * Where the base run's report must be written. Created by the caller (in
     * `reportDir`) so its name is not derivable from anything the project
     * controls.
     */
    probeReportFile: string;
    /**
     * #1647 — the probe tree's label. Defaults to the commit-pr seam's own
     * (`commit-pr`); another seam passes its own so two seams never share one
     * worktree name (and so one seam's teardown never removes another's checkout).
     */
    probeLabel?: string;
  },
): Promise<BaselineProbeOutcome | undefined> {
  if (!SHA_RE.test(opts.baseSha)) {
    trace(
      `work-driver: commit-pr verify — the baseline probe refused to run: baseSha is not a 40-hex commit id (${opts.baseSha.slice(0, 16)}…); the consolidated failure parks as before`,
    );
    return undefined;
  }
  const probeLabel = opts.probeLabel ?? "commit-pr";
  const probeTree = baselineProbeWorktreePath(opts.repoRoot, probeLabel);
  // Every name the comparison will use has to come from a file inside the
  // driver's own report dir. Checked BEFORE the base run is paid for: a
  // misconfigured caller should not cost a full gate run to discover it cannot
  // attribute anything.
  for (const [which, file] of [
    ["change", opts.changeReportFile],
    ["base", opts.probeReportFile],
  ] as const) {
    if (!isInsideReportDir(file, opts.reportDir)) {
      trace(
        `work-driver: commit-pr verify — the ${which} run's verify report path does not resolve inside the driver's private report directory, so it is not a file the driver created and is not read; the consolidated failure parks as before`,
      );
      return undefined;
    }
    if (!isRegularReportFile(file)) {
      trace(
        `work-driver: commit-pr verify — the ${which} run's verify report path is not a regular file the driver can read; the consolidated failure parks as before`,
      );
      return undefined;
    }
  }
  const changeReport = readVerifyReport(opts.changeReportFile);
  if (changeReport.names === undefined) {
    trace(
      `work-driver: commit-pr verify — the change run's failing tests are unattributable (${changeReport.reason}); the consolidated failure parks as before`,
    );
    return undefined;
  }
  const changeNames = changeReport.names;
  const bound = opts.timeoutMs ?? 30 * 60_000;
  const verdict = await probeBaselineVerify(execFn, {
    repoRoot: opts.repoRoot,
    baseSha: opts.baseSha,
    // Deliberately NOT the bare issue number: the develop step's probe tree
    // is `baseline-verify-<issue>`, and two steps sharing one tree name means
    // one step's teardown removes the other's checkout.
    issue: probeLabel,
    cmd: opts.verifyCmd,
    timeoutMs: bound,
    ...(opts.probeEnv !== undefined ? { env: opts.probeEnv } : {}),
  });
  if (verdict.status === "green" || verdict.status === "unknown") {
    trace(
      `work-driver: commit-pr verify — the baseline probe did not establish a red base (${verdict.status === "unknown" ? verdict.reason : "the base is green"}); the consolidated failure parks as before`,
    );
    return undefined;
  }
  // #1404 fix round 3 — a base run killed at its bound judged nothing, so it is
  // its own verdict arm and there is nothing here to read from it. Keeping it
  // out of the `red` shape is the point: the fields this seam reasons over are
  // precisely the ones a killed run cannot supply, and an optional field on the
  // excusing shape is a field a future producer can leave out and still excuse.
  if (verdict.status === "red-timed-out") {
    trace(
      "work-driver: commit-pr verify — the baseline run was killed at its bound, so no per-test comparison was possible; the consolidated failure parks as before",
    );
    return undefined;
  }
  const baseStream = verdict.rawStream;
  // The base run's NAMES come from its report file. The stream is still read
  // here, and still read sceptically: `probed` and `isContradictoryTally` can
  // each veto an excuse, and neither can ever create one. Both are derived from
  // the stream, which is precisely why they were not allowed to be the source
  // of the names — a stream that can be forged can forge "I judged the gate"
  // as easily as it can forge a name.
  if (verdict.probed !== true) {
    trace(
      "work-driver: commit-pr verify — the baseline run did not report its own verdict (no `FAILED: <n> test(s)` summary in its output), so its exit code says nothing about the gate; the consolidated failure parks as before",
    );
    return undefined;
  }
  // The two pieces of evidence about the base run must AGREE. A run that
  // exited non-zero while its own tally reported `F: 0` is either a broken
  // harness or a forged stream, and in neither case does it establish that any
  // particular test was already red. The optimistic half is never taken alone.
  // A MISSING exit code is read as non-zero (`?? 1`), which is the strict side:
  // an executor that could not say what the child returned is not evidence the
  // child succeeded, and the agreement check runs rather than being skipped.
  if ((verdict.exitCode ?? 1) !== 0 && isContradictoryTally(baseStream) === true) {
    trace(
      `work-driver: commit-pr verify — ${emptyBaseReason(false, baseStream)}; the consolidated failure parks as before`,
    );
    return undefined;
  }
  const baseReport = readVerifyReport(opts.probeReportFile);
  if (baseReport.names === undefined) {
    trace(
      `work-driver: commit-pr verify — the base run's failing tests are unattributable (${baseReport.reason}); the consolidated failure parks as before`,
    );
    return undefined;
  }
  const baseNames = baseReport.names;
  // One memo for the whole comparison. Every name in both lists is walked once
  // and reused across the C×B comparisons it takes to settle the run.
  const resolution = createNameResolution();
  // Anchor the comparison in the trees each run ACTUALLY executed in. The
  // probe's worktree is one of them (the probe created it, so the exported
  // naming rule names the same path). The other is where the CHANGE run's names
  // came from, which the caller cannot know from `repoRoot` alone: the gate is a
  // script, and a script that resolves its own path (`$(dirname "$0")`, which is
  // how a committed `gate.sh` names its test list) prints paths under the tree
  // the script lives in — so in a followup round, or a ci retry that re-runs on
  // a different checkout, the change run's names sit under a third tree
  // entirely. Hence `changeRoots`: every tree the change run may have run in. A
  // name that sits under NONE of them is `unknown`, and `unknown` parks — it
  // never excuses.
  const attribution = attributeFailuresByName(
    changeNames,
    baseNames,
    {
      changeRoots: [probeTree, opts.repoRoot, ...(opts.changeRoots ?? [])],
      probeRoot: probeTree,
    },
    resolution,
  );
  if (attribution.unattributable !== undefined) {
    trace(
      `work-driver: commit-pr verify — the baseline probe is unattributable: ${attribution.unattributable}`,
    );
    return undefined;
  }
  // The guard the continue path is NOT. `attributeFailuresByName` already
  // refuses a zero-name change report as unattributable, but this function's
  // contract is the object the caller reads, and a caller that reads
  // `changeCausedFailures.length === 0` as "continue" must never be handed
  // that shape from a report that names nothing. "No evidence" and "evidence
  // of innocence" are different facts and only the second one may continue;
  // an empty list is never evidence of innocence, whatever else the run said.
  if (changeNames.length === 0) {
    trace(
      "work-driver: commit-pr verify — the change run's report named no failing test while its run failed, so the report does not describe this failure; the consolidated failure parks as before",
    );
    return undefined;
  }
  return {
    preExistingFailures: attribution.preExisting,
    changeCausedFailures: attribution.changeCaused,
    changeRunNames: [...changeNames],
  };
}
