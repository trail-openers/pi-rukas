import { verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { linkShareableDeps } from "../worktree-provision.ts";
import { testLocationOf } from "./config-test-location.ts";
import { leanProjectRosterEnabled } from "./project-roster-switch.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import type { PreexistingTierRecord, ProjectRosterRecord } from "./state-outcome-maps.ts";
import {
  PREEXISTING_NAMES_CAP,
  PREEXISTING_NAME_MAX_CHARS,
  ROSTER_FILES_CAP,
  ROSTER_NAMES_CAP,
  preexistingFailuresProblem,
  projectRosterProblem,
} from "./state-outcome-maps.ts";
import { probeWorktreePath } from "./verify-baseline.ts";
import { listProjectTestFilesAtBase, undeliveredDeps } from "./verify-roster-base.ts";
import {
  type SuiteRun,
  renderRosterCommand,
  retargetRosterCommand,
  runProjectSuite,
} from "./verify-roster-command.ts";
import { editedTestFiles, runEditedBaseVersions } from "./verify-roster-edited.ts";
import { fullTierSatisfiedBy } from "./verify-suite-command.ts";
import type { VerifyExec, VerifyRosterConfig } from "./verify-types.ts";

/** The three answers to "what did the project's suite do?". `none` is never read as a colour. */
type ProjectRosterOutcome =
  | { status: "roster"; record: ProjectRosterRecord }
  | { status: "red"; reason: string; record?: ProjectRosterRecord }
  | { status: "none"; reason: string };

/** Why a roster could not be built — prose for the hand-back, never a verdict. */
function none(reason: string): ProjectRosterOutcome {
  return { status: "none", reason };
}

/**
 * The project suite at the base commit, in a throwaway checkout.
 *
 * The tree is at `probeWorktreePath`, under the repo's `.worktrees/`. Dependencies are
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
    if (undelivered === undefined)
      return {
        ran: false,
        reason: `the base commit's dependency listing could not be read at ${baseSha.slice(0, 12)}, so no base run may excuse a head failure`,
      };
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
  /** The project's `verify.full` tier, verbatim, for the question below. */
  fullTier?: string;
  /** The run's frozen acceptance tests — never part of the pre-existing set. */
  frozen: Record<string, string>;
}): Promise<ProjectRosterOutcome> {
  const { exec, repoRoot, wt, baseSha, timeoutMs, config } = opts;
  const loc = testLocationOf(config);
  if (loc === undefined)
    return none(
      "the project configured no verify.testDir (or verify.testDirs) + verify.testGlob pair, so the pre-existing test files this gate must run cannot be listed",
    );
  const listed = await listProjectTestFilesAtBase(exec, repoRoot, baseSha, loc);
  if ("reason" in listed) return none(listed.reason);
  // The frozen filter runs over the FULL enumeration, before any cap: it is what keeps this run's own
  // acceptance tests out of the pre-existing set, and after the cap a run could bury one past entry 200.
  const preexisting = listed.files.filter((f) => opts.frozen[f] === undefined);
  // An empty pre-existing set is `none` (the hand-back), never a roster whose totals would be
  // refused on load: a project that configures a test location with no tests in it has given the
  // gate nothing to judge, which is not the same as a suite that passed.
  if (preexisting.length === 0)
    return none(
      `the base commit carries no test file matching ${loc.testDirs.map((d) => `${d}/${loc.testGlob}`).join(" or ")}, so there is no project suite for this gate to judge`,
    );

  const rendered = renderRosterCommand(config, wt);
  if ("reason" in rendered) return none(rendered.reason);

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
  // Deduped ONCE: the two red arms below and the roster's own `failed` list all read the head's
  // failing names, and a stream-order dedupe asked at each site is three chances to answer differently.
  const headFailed = dedupe(head.failed);

  // THE BASE-LEG SKIP. Both red arms range over `head.failed` — `newlyFailing` ∩ what the base
  // passed, `unexplained` what the base never named — so an accepted head run that failed nothing
  // leaves a base run nothing to decide, and the suite would be paid for twice for two empty sets.
  // The condition is the ACCEPTED run, not a quiet report: a run that handed back still hands back.
  const skipBase = head.failed.length === 0;
  const base: SuiteRun = skipBase
    ? { ran: true, passed: [], failed: [] }
    : await runProjectSuiteAtBase({
        exec,
        repoRoot,
        baseSha,
        issue: opts.issue,
        timeoutMs,
        command: rendered,
        headTree: wt,
      });
  if (!base.ran) return none(`at the base commit: ${base.reason}`);

  // What the suite did on both sides, recorded BEFORE the red arms: a roster red carries it, so the
  // tests that turned the run red are a record a host reads rather than the absence of a roster.
  const recordedFiles = preexisting.slice(0, ROSTER_FILES_CAP);
  const observed: ProjectRosterRecord = {
    baseSha,
    files: recordedFiles,
    passed: dedupe(head.passed).slice(0, ROSTER_NAMES_CAP),
    failed: headFailed.slice(0, ROSTER_NAMES_CAP),
    baseFailed: dedupe(base.failed).slice(0, ROSTER_NAMES_CAP),
    total: head.passed.length + head.failed.length,
    baseTotal: base.passed.length + base.failed.length,
    // Carried only when the cap actually cut the list: a record naming every file has none to disclose.
    ...(preexisting.length > recordedFiles.length ? { fileCount: preexisting.length } : {}),
    ...(skipBase ? { baseSkipped: true } : {}),
    ...(fullTierSatisfiedBy(opts.fullTier, rendered, head) ? { fullSatisfied: true } : {}),
  };
  const redWith = (reason: string): ProjectRosterOutcome => ({
    status: "red",
    reason,
    ...(projectRosterProblem(observed) === undefined ? { record: observed } : {}),
  });

  // The base roster is the record of what was already broken. Anything failing at head that the
  // base shows PASSING is this run's regression, and the roster — not the line comparison — is
  // the arbiter.
  const basePassed = new Set(base.passed);
  const newlyFailing = headFailed.filter((name) => basePassed.has(name));
  if (newlyFailing.length > 0) return redWith(newlyFailingReason(newlyFailing, baseSha));
  // Failing on BOTH sides is the mainline's own and is not charged. A name neither passed nor
  // failed at base was not observed there, so the base cannot vouch for it and this run owns it.
  const baseSeen = new Set([...base.failed, ...base.passed]);
  const unexplained = headFailed.filter((name) => !baseSeen.has(name));
  if (unexplained.length > 0)
    return redWith(
      `project tests now fail that the base run never ran: ${clip(unexplained)} — the base roster cannot show these were already broken, so this run owns them`,
    );

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
  // A failing base version is not builder-fixable — no build round makes the old expectation pass —
  // so it is RECORDED for review to accept or withhold, and land refuses it unaccepted. A list past
  // the cap is a hand-back: land could not tell an accepted list from a cut one.
  const red = baseVersions.redFiles;
  if (red.length > PREEXISTING_NAMES_CAP)
    return none(
      `the base versions of ${String(red.length)} edited test files fail against the head code, more than the ${String(PREEXISTING_NAMES_CAP)} a review may accept: ${clip(red)}`,
    );

  const roster: ProjectRosterRecord = {
    ...observed,
    // The edited files whose BASE version passed against the head code, and those whose base version
    // failed — the second list is what land needs the newest review to accept.
    ...(baseVersions.editedFiles.length === 0
      ? {}
      : { editedFiles: baseVersions.editedFiles.slice(0, ROSTER_NAMES_CAP) }),
    ...(red.length === 0 ? {} : { baseVersionRed: red }),
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

/**
 * A recorded name cut to what the step log's reader accepts.
 *
 * The roster bounds a name by {@link PREEXISTING_NAME_MAX_CHARS}, one shorter than the record reader's
 * own ceiling (`ROSTER_PATH_MAX_CHARS`): a roster name is a test name, so it is bounded by the rule for
 * names, while the wider ceiling stays the reader's backstop for any roster it is handed.
 */
function boundedName(name: string): string {
  return name.length > PREEXISTING_NAME_MAX_CHARS
    ? name.slice(0, PREEXISTING_NAME_MAX_CHARS)
    : name;
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
 * The roster's precedence over the whole-line baseline excuse.
 *
 * `headFailed` and `baseFailed` are the failing names each run's report read — the same sets the
 * roster was built from, so the tier and the roster cannot disagree about what the suite did. A
 * name verify's roster saw PASSING, and its base run did not fail, is this run's regression when the
 * tier fails it: `red`;
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
  // The tier's lines and the report's labels are two spellings of one test; compared unnormalised
  // they never meet and the roster's precedence never fires. A name the base roster failed is the
  // mainline's own, never this run's regression.
  const baseFailedNames = new Set(roster.baseFailed.map(testIdOf));
  const passedNames = new Set(roster.passed.map(testIdOf).filter((n) => !baseFailedNames.has(n)));
  const newlyFailing = opts.headFailed.filter((line) => passedNames.has(testIdOf(line)));
  if (newlyFailing.length > 0)
    return {
      kind: "red",
      // `passed` is verify's head run: the record keeps no base passes, so the reason claims none.
      reason: `project tests the verify roster saw passing fail this tier: ${clip(newlyFailing.map(testIdOf))} — a name the roster saw pass is this run's to fix, whatever the base printed at ${opts.baseSha.slice(0, 12)}`,
    };
  const baseFailed = new Set(opts.baseFailed);
  if (!opts.headFailed.every((name) => baseFailed.has(name))) return { kind: "uninvolved" };
  const record: PreexistingTierRecord = {
    cmd: opts.cmd,
    names: opts.headFailed.slice(0, PREEXISTING_NAMES_CAP).map(boundedName),
    total: opts.headFailed.length,
    baseSha: opts.baseSha,
  };
  // A record the step log's reader would refuse licenses nothing: the arm keeps its hand-back.
  if (preexistingFailuresProblem({ tier: record }) !== undefined) return { kind: "uninvolved" };
  return { kind: "excused", record };
}

/**
 * One test's identity, whether spelled as a tier's failure line or as a report's label.
 *
 * pytest prints `FAILED tests/x_test.py::TestC::test_a - AssertionError` and its report labels the
 * same test `tests.x_test.TestC::test_a`; both become the dotted form before the last `::`. A line
 * that names no `::` test (a TAP or go line) is kept whole, which is what it was compared as before.
 */
function testIdOf(text: string): string {
  const id =
    text
      .trim()
      .replace(/^(?:FAILED|ERROR)\s+/, "")
      .split(/\s+-\s/)[0] ?? "";
  const parts = id.split("::");
  const name = parts.pop() ?? "";
  if (parts.length === 0 || /\s/.test(id)) return text.trim();
  const scope = parts.map((p) => p.replace(/\.py$/, "").replace(/\//g, ".")).join(".");
  return `${scope}::${name}`;
}
