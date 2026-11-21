/**
 * lean/verify-roster — the PROJECT's own pre-existing tests, run at head and at the base, as a
 * per-test record the run cannot talk into.
 *
 * The frozen contract covers only what this run authored. Two bench cells landed patches that
 * broke tests nobody in the run looked at: one where verify never ran the changed module's own
 * tests, one where the run edited an existing test's expectation, verify ran the EDITED copy,
 * and the hidden run restored the original and failed. A roster closes both — the project's
 * pre-existing test files, run at head AND at `run.baseSha`, keyed by test name.
 *
 * Four rules the module is built around:
 *
 *   1. **"Pre-existing" is a fact about the base commit**, not the working tree: the config pair
 *      `verify.testDir` + `verify.testGlob` listed at `run.baseSha` with `git ls-tree`, the same
 *      base-existence reading `existsInCommit` (behind `submit-tests-cap.ts`'s `existsAtBase`)
 *      applies. A frozen acceptance test the RUN added is not pre-existing.
 *
 *   2. **The unit is the test NAME**, read from the runner's machine-readable report — a
 *      `verify.roster` template when configured, otherwise the derived `--junitxml=<file>`
 *      pytest default. With no readable report there is no roster and the step hands back.
 *
 *   3. **Absence is never a pass.** An empty roster and a suite that ran nothing are different
 *      answers; only a run that observed itself running tests, on BOTH sides, becomes a roster.
 *      Every unreadable stream, killed child, or report naming fewer tests than it tallied ends
 *      in `none`, which the caller turns into a hand-back (`VerifyInfraError`), not a green.
 *
 *   4. **The roster is the arbiter for project tests.** Where it can be read it outranks the
 *      whole-line `baselineExcuse`: a test the base roster shows PASSING and head fails is this
 *      run's regression and is `red`. Line excuse and roster are never combined to turn a roster
 *      red into a green.
 *
 * The base version of an edited file runs through `runTestFile` (the project's `verify.test`
 * template, argv form), so its verdict is per FILE. Base bytes come from
 * `git show <baseSha>:<path>` — the object store, never the tree the run may have rewritten —
 * and are materialised by `writeCaptured`, the same write path `specify`'s reset uses.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { isFullCommitSha } from "../commit-sha.ts";
import { verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { SHAREABLE_DEPS } from "../worktree-dep-contract.ts";
import { linkShareableDeps } from "../worktree-provision.ts";
import { globMatches } from "./config-test-location.ts";
import { leanProjectRosterEnabled } from "./project-roster-switch.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import type { PreexistingTierRecord, ProjectRosterRecord } from "./state-outcome-maps.ts";
import {
  PREEXISTING_NAMES_CAP,
  ROSTER_FILES_CAP,
  ROSTER_NAMES_CAP,
  ROSTER_PATH_MAX_CHARS,
  projectRosterProblem,
} from "./state-outcome-maps.ts";
import { probeWorktreePath } from "./verify-baseline.ts";
import {
  type SuiteRun,
  parseJUnitCases,
  renderRosterCommand,
  retargetRosterCommand,
  runProjectSuite,
} from "./verify-roster-command.ts";
import { editedTestFiles, runEditedBaseVersions } from "./verify-roster-edited.ts";
import type { VerifyExec, VerifyRosterConfig } from "./verify-types.ts";

/** The three answers to "what did the project's suite do?". `none` is never read as a colour. */
type ProjectRosterOutcome =
  | { status: "roster"; record: ProjectRosterRecord }
  | { status: "red"; reason: string }
  | { status: "none"; reason: string };

/** Why a roster could not be built — prose for the hand-back, never a verdict. */
function none(reason: string): ProjectRosterOutcome {
  return { status: "none", reason };
}

/**
 * The dependencies the base commit tracks that `tree` does NOT have — the ones its suite could not
 * have imported.
 *
 * Asked of the BASE COMMIT rather than of `expectedDepLocations`, and that choice is the whole rule:
 * the provisioner decides what to link by looking at the SOURCE, so if the source has since gone it
 * links nothing, expects nothing, and reports nothing — a base that cannot import a single module is
 * then read as a base whose suite ran and failed on its merits, which is the excuse that turns a
 * head-only regression green. The base commit is the one record of what the project's own tree held
 * that no link can silently empty, so it is what the expectation is taken from. `statSync` follows the
 * symlink provisioning made, so a link whose source has gone is undelivered; any read fault is
 * "undelivered", the fail-closed direction — a tree this cannot look at is not a tree whose suite ran.
 */
async function undeliveredDeps(
  exec: VerifyExec,
  repoRoot: string,
  baseSha: string,
  tree: string,
): Promise<string[]> {
  if (!isFullCommitSha(baseSha)) return [];
  const listed = await trackedPathsAt(exec, repoRoot, baseSha, SHAREABLE_DEPS);
  if (listed === undefined) return [];
  // A directory is expected where the commit tracks a path under one of the shareable names; the
  // recorded path's first segment is the dependency directory itself.
  const expected = new Set<string>();
  for (const rel of listed) {
    const head = rel.split("/")[0] ?? "";
    if ((SHAREABLE_DEPS as readonly string[]).includes(head)) expected.add(head);
  }
  return [...expected].filter((dep) => {
    try {
      return !statSync(path.join(tree, dep)).isDirectory();
    } catch {
      return true;
    }
  });
}

/**
 * The project's PRE-EXISTING test files at the run's base commit.
 *
 * `git ls-tree -r` of `verify.testDir` AT `baseSha`, kept where the basename matches
 * `verify.testGlob`. Listing at the commit rather than the disk is the rule every base read in
 * a run follows: a run that adds or deletes test files would otherwise choose the suite that
 * judges it.
 *
 * A failed listing is NOT "no tests". A directory that does not exist at the base answers exit
 * 0 with empty stdout; a bad sha or a broken object store REJECTS, and a rejection is `none`.
 */
/**
 * The tracked paths one commit holds under `paths`, or `undefined` when git would not answer.
 *
 * Both base reads the roster makes are this one question — which paths does `baseSha` track — asked of
 * the commit and never of the disk, because a run that adds or deletes files would otherwise choose the
 * tree that judges it. A rejection is `undefined`, never an empty list: a directory that does not exist
 * at the base answers exit 0 with nothing, and that IS an empty listing, while a bad sha or a broken
 * object store REJECTS and is not "the base had none".
 */
async function trackedPathsAt(
  exec: VerifyExec,
  repoRoot: string,
  sha: string,
  paths: readonly string[],
): Promise<string[] | undefined> {
  const ran = await exec("git", {
    argv: [
      ...NO_HOOKS,
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      "--end-of-options",
      sha,
      "--",
      ...paths,
    ],
    cwd: repoRoot,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: verifyHostEnv(),
  }).catch(() => undefined);
  if (ran === undefined) return undefined;
  return (ran.stdout ?? "")
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

async function listProjectTestFilesAtBase(
  exec: VerifyExec,
  repoRoot: string,
  baseSha: string,
  testDir: string,
  testGlob: string,
): Promise<{ files: string[] } | { reason: string }> {
  if (!isFullCommitSha(baseSha))
    return {
      reason: `the roster could not list ${testDir}/: "${baseSha}" is not a full commit sha`,
    };
  const listed = await trackedPathsAt(exec, repoRoot, baseSha, [testDir]);
  if (listed === undefined)
    return {
      reason: `could not list the project's test files at ${baseSha.slice(0, 12)}`,
    };
  const prefix = `${testDir}/`;
  const files: string[] = [];
  for (const entry of listed) {
    // Directly inside `testDir` only — the boundary `testLocationProblem` applies to a
    // submitted acceptance test, so the roster and the freeze agree about where tests live.
    if (!entry.startsWith(prefix)) continue;
    const rel = entry.slice(prefix.length);
    if (rel === "" || rel.includes("/")) continue;
    if (!globMatches(testGlob, rel)) continue;
    files.push(entry);
    if (files.length > ROSTER_FILES_CAP)
      return {
        reason: `the project carries more than ${ROSTER_FILES_CAP} test files in ${testDir}/ — refusing to run a suite this gate cannot record a verdict for`,
      };
  }
  return { files };
}

/**
 * The project suite at the base commit, in a throwaway checkout.
 *
 * A SIBLING of `repoRoot`, never under it: verify scans the whole repo with porcelain
 * `--untracked-files=all`, so a tree inside the repo is itself untracked dirt. Dependencies are
 * symlinked only (`linkShareableDeps` — the project's `.pi/worktree-setup` is arbitrary code and
 * this probe never runs it). The report is read BEFORE the `finally` removes the tree: a roster
 * re-read after teardown is a roster read from nothing.
 */
async function runProjectSuiteAtBase(opts: {
  exec: VerifyExec;
  repoRoot: string;
  baseSha: string;
  issue: number;
  timeoutMs: number;
  command: { bin: string; args: string[]; report: string };
  headTree: string;
}): Promise<SuiteRun> {
  const { exec, repoRoot, baseSha, timeoutMs } = opts;
  const abs = probeWorktreePath(repoRoot, opts.issue, "roster");
  const run = retargetRosterCommand(opts.command, opts.headTree, abs);
  const hostEnv = verifyHostEnv();
  const remove = () =>
    exec("git", {
      argv: [...NO_HOOKS, "worktree", "remove", "--force", abs],
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 256 * 1024,
      env: hostEnv,
    }).catch(() => undefined);
  // A registration a killed run left behind makes the next `worktree add` at this path refuse.
  await remove();
  try {
    try {
      await exec("git", {
        argv: [...NO_HOOKS, "worktree", "add", "--detach", abs, baseSha],
        cwd: repoRoot,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: hostEnv,
      });
    } catch (err) {
      return {
        ran: false,
        reason: `the base commit ${baseSha.slice(0, 12)} could not be checked out: ${(err as Error)?.message ?? String(err)}`,
      };
    }
    // A configured template with no `{report}` reports to a path this gate cannot predict; reading
    // the head tree's report as the base's is the one reading that would grade a green on bytes
    // from the wrong tree, so the base run is not run at all.
    if (run.bin === "")
      return {
        ran: false,
        reason:
          "the roster command writes no report the base run can be asked for, so the base run's per-test verdicts cannot be read",
      };
    // A base run is only evidence about the project's suite if the suite could actually run, so the
    // dependencies are verified HERE — before the command is asked, and after provisioning has had its
    // turn. `linkShareableDeps` never throws and reports no problem for the shape that matters: it
    // checks a candidate at its SOURCE, so a checkout whose dependency tree never landed is recorded as
    // a success. A base that cannot import its own suite fails every test, and a head failure naming the
    // same tests is then excused as "already failing at base" — a green graded on a run nobody watched.
    // So the checkout is asked directly, in its own cwd, before it is believed: every dependency the
    // repo carries at its root or in a package dir must be a directory here. A project with nothing to
    // link has no expected locations, no problem, and is not this refusal.
    const provisioned = await linkShareableDeps(exec, repoRoot, abs).catch(
      (err: unknown) =>
        ({
          problem: `the provisioner itself failed: ${(err as Error)?.message ?? String(err)}`,
        }) as const,
    );
    const undelivered = await undeliveredDeps(exec, repoRoot, baseSha, abs);
    if (provisioned.problem !== undefined || undelivered.length > 0)
      return {
        ran: false,
        reason: `the base checkout ${abs} never received the project's dependencies (${
          provisioned.problem ?? `never arrived: ${clip(undelivered)}`
        }), so its suite could not have run and no head failure may be excused against it`,
      };
    return await runProjectSuite(exec, { cwd: abs, ...run, timeoutMs, reportCwd: abs });
  } finally {
    await remove();
  }
}

export async function buildProjectRoster(opts: {
  exec: VerifyExec;
  repoRoot: string;
  wt: string;
  baseSha: string;
  issue: number;
  timeoutMs: number;
  config: VerifyRosterConfig;
  /** The run's frozen acceptance tests — never part of the pre-existing set. */
  frozen: Record<string, string>;
}): Promise<ProjectRosterOutcome> {
  const { exec, repoRoot, wt, baseSha, timeoutMs, config } = opts;
  if (config.testDir === undefined || config.testGlob === undefined)
    return none(
      "the project configured no verify.testDir + verify.testGlob pair, so the pre-existing test files this gate must run cannot be listed",
    );
  const listed = await listProjectTestFilesAtBase(
    exec,
    repoRoot,
    baseSha,
    config.testDir,
    config.testGlob,
  );
  if ("reason" in listed) return none(listed.reason);
  const preexisting = listed.files.filter((f) => opts.frozen[f] === undefined);
  if (preexisting.length === 0)
    return none(
      `the base commit carries no test file matching ${config.testDir}/${config.testGlob}, so there is no project suite for this gate to judge`,
    );

  const rendered = renderRosterCommand(config, wt);
  if ("reason" in rendered) return none(rendered.reason);

  // An empty pre-existing set is `none` (the hand-back), never a roster whose totals would be
  // refused on load: a project that configures a test location with no tests in it has given the
  // gate nothing to judge, which is not the same as a suite that passed.

  const head = await runProjectSuite(exec, {
    cwd: wt,
    bin: rendered.bin,
    args: rendered.args,
    report: rendered.report,
    timeoutMs,
    // The head report is read from the WORKTREE, not from wherever the exec seam landed: the probe
    // tree is removed before the caller reads anything, and a head report read from it would be a
    // report read from nothing.
    reportCwd: wt,
  });
  if (!head.ran) return none(`at head: ${head.reason}`);

  const base = await runProjectSuiteAtBase({
    exec,
    repoRoot,
    baseSha,
    issue: opts.issue,
    timeoutMs,
    command: rendered,
    headTree: wt,
  });
  if (!base.ran) return none(`at the base commit: ${base.reason}`);

  // The base roster is the record of what was already broken. Anything failing at head that the
  // base shows PASSING is this run's regression, and the roster — not the line comparison — is
  // the arbiter (parent #2410 R4).
  const basePassed = new Set(base.passed);
  const newlyFailing = dedupe(head.failed).filter((name) => basePassed.has(name));
  if (newlyFailing.length > 0)
    return { status: "red", reason: newlyFailingReason(newlyFailing, baseSha) };
  // Failing on BOTH sides is the mainline's own and is not charged. A name neither passed nor
  // failed at base was not observed there, so the base cannot vouch for it and this run owns it.
  const baseSeen = new Set([...base.failed, ...base.passed]);
  const unexplained = dedupe(head.failed).filter((name) => !baseSeen.has(name));
  if (unexplained.length > 0)
    return {
      status: "red",
      reason: `project tests now fail that the base run never ran: ${clip(unexplained)} — the base roster cannot show these were already broken, so this run owns them`,
    };

  const edited = await editedTestFiles(exec, wt, baseSha, preexisting);
  if (edited === undefined)
    return none("could not tell which pre-existing test files this run edited");
  if (config.test === undefined && edited.length > 0)
    return none(
      "this run edited pre-existing test files and no verify.test runner template is configured, so their base versions cannot be run",
    );

  const baseVersions = await runEditedBaseVersions({
    exec,
    repoRoot,
    wt,
    baseSha,
    template: config.test ?? "",
    timeoutMs,
    edited,
  });
  if (!baseVersions.ok) return none(baseVersions.reason);
  if (baseVersions.redFiles.length > 0)
    return {
      status: "red",
      reason: `the base versions of these test files fail against the head code: ${clip(baseVersions.redFiles)} — the run changed the contract its own tests were written against, and Part A has no acceptance path for that`,
    };

  const roster: ProjectRosterRecord = {
    baseSha,
    files: preexisting.slice(0, ROSTER_FILES_CAP),
    passed: dedupe(head.passed).slice(0, ROSTER_NAMES_CAP),
    failed: dedupe(head.failed).slice(0, ROSTER_NAMES_CAP),
    baseFailed: dedupe(base.failed).slice(0, ROSTER_NAMES_CAP),
    total: head.passed.length + head.failed.length,
    baseTotal: base.passed.length + base.failed.length,
    // The files whose BASE version was run against the head code and PASSED. A run that edited a
    // pre-existing test and whose base version fails never gets this far: it returned `red` above,
    // so land can never see a roster that recorded a failing base version as a green.
    ...(baseVersions.editedFiles.length === 0
      ? {}
      : { editedFiles: baseVersions.editedFiles.slice(0, ROSTER_NAMES_CAP) }),
  };
  // The step log's reader is the last word on what a durable roster may assert; asking it here
  // turns a would-be-unloadable record into a hand-back an operator can read.
  if (projectRosterProblem(roster) !== undefined)
    return none("the roster this run built is not a record the step log would accept");
  return { status: "roster", record: roster };
}

/**
 * Why a roster red: the tests that were green at the base and fail now, named.
 *
 * One sentence for one verdict, written once: the roster's own comparison and the tier arm that ranks
 * with it must be able to say the same thing about the same names, and two copies of the wording are two
 * chances to say it differently.
 */
function newlyFailingReason(names: readonly string[], baseSha: string): string {
  return `project tests that passed at the base commit now fail: ${clip(names)} — these were green at ${baseSha.slice(0, 12)}, so this run broke them`;
}

/** A recorded name cut to what the step log's reader accepts. */
function boundedName(name: string): string {
  return name.length > ROSTER_PATH_MAX_CHARS ? name.slice(0, ROSTER_PATH_MAX_CHARS) : name;
}

/** Order-preserving dedupe and bound; stream order is what an operator re-running the suite sees. */
function dedupe(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(boundedName(name));
  }
  return out;
}

/** A short list for a reason line; the record carries the full capped sets. */
function clip(names: readonly string[]): string {
  const shown = names.slice(0, 10);
  const rest = names.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` (+${String(rest)} more)` : ""}`;
}

/** Why this run may not land: named, and never defaulted to an empty roster. */
export const ROSTER_LAND_REFUSAL =
  "the newest green verify carries no project-test roster — the gate never ran the project's own pre-existing tests, so the merge stays refused";

/** Why this run may not be green either: the hand-back the step raises. */
export function rosterHandbackReason(reason: string): string {
  return `no project test roster: ${reason} — the run hands back rather than going green without a roster`;
}

/**
 * What the roster decided about a tier the base also failed. The three answers are the arm's, and
 * `uninvolved` is a judgement rather than a fallback: a tier whose report the roster could not read
 * (a typecheck tier, a lint tier) is not the roster's to judge, and the whole-line excuse keeps its
 * rule over it. What the roster never does is stand aside while a name it saw PASSING at base is
 * excused by a line match.
 */
export type RosterArbitration =
  | { kind: "red"; reason: string }
  | { kind: "excused"; record: PreexistingTierRecord }
  | { kind: "uninvolved" };

/**
 * The roster's precedence over the whole-line baseline excuse (parent #2410 R4).
 *
 * `headFailed` and `baseFailed` are the failing names each run's report read — the same sets the
 * roster was built from, so the tier and the roster cannot disagree about what the suite did. A
 * name the roster saw PASSING at base and head fails is this run's regression and answers `red`;
 * names that failed at base on both sides answer `excused`, with the record the disclosure renders;
 * anything else answers `uninvolved` and the line rule decides.
 */
export function arbitrateTierWithRoster(opts: {
  roster: ProjectRosterRecord | undefined;
  headFailed: readonly string[];
  baseFailed: readonly string[];
  baseSha: string;
  cmd: string;
}): RosterArbitration {
  if (!leanProjectRosterEnabled()) return { kind: "uninvolved" };
  const roster = opts.roster;
  if (roster === undefined) return { kind: "uninvolved" };
  if (opts.headFailed.length === 0) return { kind: "uninvolved" };
  const basePassed = new Set(roster.passed);
  const newlyFailing = opts.headFailed.filter((name) => basePassed.has(name));
  if (newlyFailing.length > 0)
    return { kind: "red", reason: newlyFailingReason(newlyFailing, opts.baseSha) };
  const baseFailed = new Set(opts.baseFailed);
  if (opts.headFailed.every((name) => baseFailed.has(name)))
    return {
      kind: "excused",
      record: {
        cmd: opts.cmd,
        names: opts.headFailed.slice(0, PREEXISTING_NAMES_CAP).map(boundedName),
        total: opts.headFailed.length,
        baseSha: opts.baseSha,
      },
    };
  return { kind: "uninvolved" };
}
