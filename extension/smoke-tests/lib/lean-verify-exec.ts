/**
 * lib/lean-verify-exec — the exec stub the `lean/verify` smoke tests hand the step.
 *
 * `verify` judges a tree by RUNNING things, so the stub is where every case's
 * expectations actually live: it decides which exec call is which, and answers the
 * calls a case cares about while passing everything else to a real child. The three
 * questions it has to keep straight are the ones a real executor never asks:
 *
 * 1. **Is this call the baseline probe?** The probe runs in a throwaway checkout whose
 *    PATH identifies it — but the `git worktree add` that creates that tree runs with
 *    its cwd at the repo root, so the add is recognised by the path it names rather
 *    than by a cwd that does not have it yet.
 * 2. **Inside the probe, is this the tier or the frozen contract?** Command identity,
 *    not the binary's name: a failTier tier is itself a quoted sh -c string, and the
 *    the frozen runner template is `sh {file}`, so "the binary is sh" separates nothing.
 *    What separates them is that a tier reaches the executor as a whole shell string
 *    with no argv, while the runner arrives in argv form with the test path as its
 *    argument.
 * 3. **Is this a step-run whose colour the case declared?** `headTierRedRuns` stubs the
 *    first runs red and lets the last go to the real shell, so a tier excused as flaky
 *    was excused on a re-run that was actually spawned.
 *
 * Everything else — the porcelain checks, the HEAD and branch reads, the tamper
 * comparisons — is passed to a real `git`, because a stub that answered those would be
 * testing the stub. The two facts that identify the probe's own tree — its canonical
 * path and the registration test — are the subject of `lean-verify-probe-tree.ts`.
 *
 * Prose in this file is read by the unscrubbed-spawn gate in
 * test-verify-loop-git-env.ts, which blanks quoted spans BEFORE it blanks comments. A
 * quote pair that opens on one line and closes on another therefore deletes the lines
 * between them from that analysis, and a code span here would hide the scrubbed env a
 * git spawn passes. Prose in this file keeps every quote pair on one line.
 */

import { execp } from "../../src/exec.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { namesProbeTree } from "./lean-verify-probe-tree.ts";
import { canonicalRosterProbeDir } from "./lean-verify-probe-tree.ts";
import type { VerifyOpts } from "./lean-verify-types.ts";

export { canonicalProbeDir } from "./lean-verify-probe-tree.ts";

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROSTER_REPORT_FILE } from "../../src/lean/verify-roster-command.ts";
import {
  baseTierHangCommand,
  isProbeBlobRead,
  probeBlobReadTimeoutError,
} from "./lean-verify-probe-shapes.ts";
import {
  NO_REPORT_SENTINEL,
  isRosterReportRead,
  rosterReportXml,
  rosterSideOf,
} from "./lean-verify-roster.ts";

export function makeVerifyExec(opts: {
  wt: string;
  probeDir: string;
  repoRoot: string;
  tiers: string[];
  opts: VerifyOpts;
  /** Set for the hook case: the dir the project's hook marks, so the marker says WHERE. */
  hookMarks?: string;
  /** The run's base sha — what identifies the probe's `<base>:<path>` blob reads. */
  baseSha?: string;
  /**
   * The roster command this case configured, as `{bin, rest}`: the first word is the executable the
   * roster's argv begins with. Absent means the case configured no roster command at all.
   */
  rosterCmd?: { bin: string };
  /**
   * The names each side's roster report holds, as the case declared them. Given for a side, the stub
   * writes that side's report itself rather than running the configured command — "this test passed at
   * head and failed at the base" is a fact about one tree's verdicts, not bytes both trees share.
   * Absent for a side, the configured command really runs and its own output is what the gate reads.
   */
  rosterNames?: {
    head?: { passed: string[]; failed: string[] };
    base?: { passed: string[]; failed: string[] };
  };
}): {
  exec: VerifyExec;
  redRunsSeen: () => number;
  baseTierRunsSeen: () => number;
  frozenRunsSeen: () => number;
  rosterRunsSeen: () => number;
} {
  const { wt, probeDir, repoRoot, tiers, opts: o } = opts;
  const hookMarks = opts.hookMarks;
  const baseSha = opts.baseSha;
  /** The env every child of this case gets: the fixture's git identity, plus the hook's marker dir. */
  const childEnv = (): NodeJS.ProcessEnv => ({
    ...gitTestEnv(),
    ...(hookMarks === undefined ? {} : { PI_RUKAS_TEST_HOOK_MARKS: hookMarks }),
  });
  const RECHECK_ARGV = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "rev-parse",
    "HEAD",
  ];
  const BRANCH_ARGV = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ];
  let tierRan = false;
  /**
   * Every execution of a project tier's command BY THE STEP, at HEAD or at the base
   * probe. The canary is excluded: `guardCompilerIntegrity` runs the tier's command
   * verbatim to ask the pinned compiler a question, and a counter that counted that
   * would have the tier go green before the tier ever ran.
   */
  let tierRuns = 0;
  /** How many of HEAD's runs the tier is allowed to fail before it goes green. */
  const redBudget = o.headTierRedRuns ?? 0;
  /** How many of HEAD's runs the step made in the RUN's own worktree. */
  let headTierRuns = 0;
  /** Runs of a FROZEN file through the runner template — see `VerifyRun.frozenRuns`. */
  let frozenRuns = 0;
  /** Runs of the tier the BASE PROBE has made in its throwaway checkout. */
  let baseTierRuns = 0;
  /** Runs of the roster's project suite, at head and at the base probe (see `VerifyRun.rosterRuns`). */
  let rosterRuns = 0;
  /**
   * The roster command this case configured, if any.
   *
   * The gate renders the project's roster command into argv and runs it, and the stub must be able
   * to tell that call from a tier's shell string and from a frozen run's `sh <file>`: the roster is
   * the only caller that submits argv whose first word is the configured command's own binary AND
   * whose argv holds the tree it runs in. Recorded per case so the identity is one thing, not a
   * guess at dispatch time.
   */
  const rosterCmd = opts.rosterCmd;
  /**
   * Is this exec call the roster running the project's suite?
   *
   * Command identity again, in the same spirit as `isTierCommand`: the roster reaches the executor
   * in ARGV form (so no shell re-parses the tree's path), its first word is the configured roster
   * command's binary, and its cwd is one of the two trees the roster runs in. A frozen run is also
   * argv form, so the binary is what separates the two — and the roster's own report read is
   * recognised earlier, by `isRosterReportRead`.
   */
  const isRosterSuiteRun = (cmd: string, o2: Parameters<VerifyExec>[1] | undefined): boolean => {
    if (rosterCmd === undefined || cmd !== rosterCmd.bin) return false;
    if (!Array.isArray(o2?.argv)) return false;
    // The report flag is what separates the roster's run from a FROZEN run of the same runner
    // template: `sh <file>` and `sh <file> --junitxml=… {dir}` are the same binary and the same
    // shape, and only one of them is being asked for a machine-readable report.
    if (!o2.argv.some((a) => a.startsWith("--junitxml="))) return false;
    // Any cwd: the base run happens in the roster's OWN throwaway checkout of the base commit, whose
    // path the step derives and the fixture does not know. Requiring the fixture's baseline dir would
    // silently miss every base run, and a base run the stub misses is a run whose report nobody wrote.
    return true;
  };
  /**
   * Run the roster's project suite in one tree.
   *
   * The suite itself is a real child: what it does is the configured command's own doing. The one
   * thing the stub adds is the per-side choice of WHICH tests the report names, because "the base
   * carried this test and it passed there, and at head it fails" is the fact a case is asserting and
   * cannot be deduped from bytes both trees share. Absent that override, the configured command's
   * real output is what the gate reads back.
   */
  const runRosterSuite = (
    command: string,
    o2: Parameters<VerifyExec>[1],
    side: "head" | "base",
  ) => {
    rosterRuns++;
    const killed = side === "head" ? o.roster?.headRunKilled : o.roster?.baseRunKilled;
    if (killed === true) {
      // The executor's OWN kill shape: no numeric code, `killed` and `timedOutKill` stamped. A run
      // with no exit status has no per-test verdicts, whatever its report might have said.
      return Promise.reject(
        Object.assign(new Error(`Command failed: ${command}`), {
          code: null,
          killed: true,
          timedOutKill: true,
          stdout: "",
          stderr: "",
        }),
      );
    }
    const declared = side === "head" ? opts.rosterNames?.head : opts.rosterNames?.base;
    // The tree is the run's OWN cwd, which is the probe's throwaway checkout rather than the
    // fixture's baseline dir: writing the report where the gate will look for it is the whole point.
    if (declared !== undefined)
      return writeDeclaredReport(String(o2?.cwd ?? treeOf(side)), declared, side);
    return execp(command, { ...o2, env: o2?.env ?? childEnv() });
  };
  /** The tree a roster run of this side belongs to. */
  const treeOf = (side: "head" | "base") => (side === "base" ? probeDir : wt);
  /**
   * The roster's OWN throwaway checkout of the base commit. The step derives its path from the repo
   * root, so the stub recognises the `worktree add` that makes it rather than guessing at a name.
   */
  const rosterProbeDir = canonicalRosterProbeDir(repoRoot, o.issue);
  /**
   * Take the dependency tree a case says never arrived out of the roster's base checkout.
   *
   * Timed to the base SUITE's run rather than to the checkout: the production order is checkout, link,
   * then run, and the gate is asked to notice an undelivered dependency between the link that reported
   * success and the run that would silently fail every test. Removing them here is the state a link that
   * never landed leaves — the tree is present, the modules are not, and nothing upstream reported it.
   */
  const bareBaseDeps = (tree: string): void => {
    for (const dep of o.roster?.baseMissingDeps ?? []) {
      try {
        rmSync(path.join(tree, dep), { recursive: true, force: true });
      } catch {
        /* a tree already bare is the state the case asked for */
      }
    }
  };
  /**
   * A roster run the stub itself produces: it writes the report the gate then reads back, holding the
   * names this side was declared to have. The report is a real file in the tree the run belongs to and
   * in the shape a JUnit report has, so the gate's parser, its emptiness rule and its contradiction
   * rule all run on bytes rather than on a verdict the harness asserted.
   */
  const writeDeclaredReport = (
    tree: string,
    side: { passed: readonly string[]; failed: string[] },
    which: "head" | "base",
  ) => {
    const report = path.join(tree, ROSTER_REPORT_FILE);
    const absent = [...side.passed, ...side.failed].includes(NO_REPORT_SENTINEL);
    const xml = absent ? undefined : rosterReportXml(side);
    // Synchronous, and it has to be: the gate reads the report back with its own `readFileSync` the
    // moment the run resolves, so an await between the run and its answer is a report that arrives
    // after the verdict, which is the same as no report at all.
    try {
      if (xml === undefined) rmSync(report, { force: true });
      else writeFileSync(report, xml);
    } catch {
      /* a tree that is already gone is the gate's problem to refuse, not the stub's to hide */
    }
    return Promise.resolve({ code: 0, stdout: `roster-said-${which}\n`, stderr: "" });
  };

  /** The tier's own marker, so a stubbed red prints the identity of ITS tier. A command
   * with no `tier-said-` marker has no stamp at all — the stub invents none. */
  const markerOf = (cmd: string): string | undefined =>
    cmd.match(/tier-said-([A-Za-z0-9_-]+)/)?.[1];
  /**
   * Is this exec call the step running a project tier's shell command?
   *
   * Command identity, in both directions, because "the binary is `sh`" proves nothing:
   * a tier command built by `failTier()` is ITSELF `sh -c '…'`, and the frozen runner
   * template is `sh {file}` — so the only pair of facts that separates them is (the
   * whole command string is one of the configured tiers) and (argv is absent, which is
   * how a shell command reaches the executor, while the frozen runner arrives in argv
   * form with the test path as its argument).
   */
  const isTierCommand = (cmd: string, argv: string[] | undefined | null): boolean =>
    (argv === undefined || argv === null) && tiers.includes(cmd);
  /**
   * Run one tier's command for the step.
   *
   * `headTierRedRuns` is how many of the step's runs in ITS OWN worktree are stubbed
   * red, and the last of them is deliberately left to the real shell: the step's re-run
   * must be a spawn that saw the work, never a stubbed answer, or a case would excuse a
   * tier as flaky on evidence nobody produced. So `headTierRedRuns: 1` means "the first
   * run is red and the re-run executes" (pair it with `flakeTier`, whose script fails
   * once and then passes), and the default of one says "red however often it is asked".
   * A stubbed red carries the executor's own non-zero shape — a numeric `code` plus the
   * stream the tier printed — so `runTier` reads a real red rather than a kill or a
   * command that never started.
   *
   * `headRun: false` is the base probe's run, which the counter does NOT own: by the
   * time it happens HEAD has spent its budget, and "red at the base" is a property of
   * the base commit rather than of how many runs came before it.
   */
  const runCountedTier = (command: string, o2: Parameters<VerifyExec>[1], headRun: boolean) => {
    const cmd = command;
    if (!headRun) {
      // The base probe's own run of the tier, counted separately: `tierRuns` counts the
      // STEP's runs at HEAD, and a case that wants to know whether the probe reached its
      // tier — rather than settling on an earlier arm — asks for this one.
      baseTierRuns++;
      if (o.baseTierOutput !== undefined) {
        // A case that declares what the base printed: the executor's own non-zero shape
        // carrying that stream, which is the only way to ask "what did the base name"
        // about a run in a tree the case built — the same seam `baseBlobBytes` uses for
        // the base's bytes. Two facts make this a REAL run's stream rather than a declared
        // one, and the excuse compares its lines VERBATIM, so the base must print what a
        // run of THIS tier prints:
        //   - the executor's `Command failed: <cmd>` echo is part of the shape and is NOT
        //     withheld: the base probe really did run this tier and the executor really did
        //     prefix its failure with this line, so a base stream without it would be a
        //     stream no real run produced, and a tier whose own echo carries a failure word
        //     (`Command failed: sh -c '… FAILED tests/x.py::t …'`) could then be excused
        //     for a head-only line the base would in fact have echoed too;
        //   - the tier's own `tier-said-<marker>` stamp, which a tier built by
        //     `lean-verify-tiers` prints on EVERY red run of itself — head and base alike.
        //     Withholding it here left the head with a line the base never printed, and the
        //     excuse refused a pair whose failing lines were identical. Carrying it is what
        //     makes the two runs' residue IDENTICAL, which is the only residue shape the
        //     verbatim rule can compare.
        const marker = markerOf(cmd);
        return Promise.reject(
          Object.assign(new Error(`Command failed: ${cmd}`), {
            code: 1,
            stdout: o.baseTierOutput,
            stderr: marker === undefined ? "" : `tier-said-${marker}\n`,
          }),
        );
      }
      return execp(cmd, { ...o2, env: o2?.env ?? gitTestEnv(), cwd: o2?.cwd ?? probeDir });
    }
    const run = headTierRuns;
    headTierRuns++;
    tierRuns++;
    // The hung re-run: only the second run of the tier gets the shortened bound, so the
    // executor's own group kill fires on it and on nothing else.
    const bound = o.headRerunKilled === true && run === 1 ? (o.timeoutMs ?? 2_000) : o.timeoutMs;
    if (o.headRerunSilentReject === true && run === 1) return Promise.reject(new Error("nope"));
    if (o.headRerunRejects !== undefined && run === 1) return Promise.reject(o.headRerunRejects);
    // A case whose tier must NAME failing tests owns the stream both of HEAD's runs
    // print; the exit code stays the executor's own non-zero shape, so `runTier` reads
    // a real red rather than a kill or a command that never started. The tier's own stamp
    // carries NO run number: a per-run digit would make the head's two runs print
    // DIFFERENT residue, and the baseline excuse compares the head's lines against the
    // base verbatim, so a stamp that moved would read as a line only the head printed.
    if (run < redBudget - 1 || o.headTierOutput !== undefined) {
      return Promise.reject(
        Object.assign(new Error(`Command failed: ${cmd}`), {
          code: 1,
          stdout: o.headTierOutput ?? "",
          stderr: markerOf(cmd) === undefined ? "" : `tier-said-${markerOf(cmd)}\n`,
        }),
      );
    }
    return execp(cmd, {
      ...o2,
      timeout: bound,
      env: o2?.env ?? childEnv(),
      cwd: headRun ? wt : probeDir,
    });
  };

  const exec: VerifyExec = (cmd, o2) => {
    // The roster's report read: the gate's own bounded `cat <tree>/.lean-roster-report.xml`. It
    // goes to a REAL child, because the report is a file the roster's runner wrote in that tree —
    // a stub that answered it would let a step that never ran a suite look like it had. The one
    // thing this stub does for the read is refuse it when the case asked for a run that produced no
    // report: git's own missing-file shape, which the gate reads as no roster and hands back.
    const reportSide = String(o2?.cwd ?? "") === probeDir ? "base" : "head";
    if (
      isRosterReportRead(o2) &&
      (reportSide === "head"
        ? o.roster?.headReportMissing === true
        : o.roster?.baseReportMissing === true)
    )
      return Promise.reject(
        Object.assign(new Error("cat: no such file"), {
          code: 1,
          stderr: "cat: no such file or directory\n",
          stdout: "",
        }),
      );
    if (isRosterSuiteRun(cmd, o2))
      return runRosterSuite(cmd, o2, rosterSideOf(String(o2?.cwd ?? ""), wt, probeDir));
    // A frozen-test run is the argv-form call the runner template makes: `runTestFile`
    // renders `<bin> <args…>` and submits it as `exec(bin, { argv })` with the kill-group
    // bound, so the file path reaches the executor in argv and never in the command string.
    // Tiers arrive the other way — whole command string, no argv — and git's own argv reads
    // of a frozen path (`git show <ref>:tests/AC1-….test.sh`) carry no `killGroup`, so
    // neither can be mistaken for a run of the contract.
    if ((o2 as { killGroup?: boolean } | undefined)?.killGroup === true && Array.isArray(o2?.argv))
      frozenRuns++;
    // The tier command is the marker between the step's pre-tier reads and its
    // post-tier re-checks; only the HEAD read on the far side of it goes quiet.
    if (cmd !== "git" && cmd !== "sh") tierRan = true;
    // The baseline probe runs the tier's command, and the run's frozen contract, in a
    // throwaway checkout of the base. Its tree is identified by PATH, and within that
    // tree the TWO runs are told apart by command identity, not by the counter.
    // Both are answered from the options rather than from the checkout: at the base
    // commit the implementation the contract is red against has by definition not been
    // written, so the case — not the filesystem — decides what the base looks like.
    const addCmd =
      o.baseAddFails === true && cmd === "git" && String(o2?.argv ?? "").includes(probeDir);
    if (addCmd) return Promise.reject(new Error("git worktree add: fatal: bad object"));
    // The probe's OWN bookkeeping is git's business, not the stub's: `worktree add` and
    // `worktree remove` go to the real git, so the registration the cleanup cases read
    // back is the one production created and the one production destroyed. Answering a
    // `remove` here would let a step that never cleaned up look clean, because the stub
    // would have "removed" a tree git still holds. The command is found wherever the
    // two words sit in argv, because the call carries the config guard before them.
    if (
      cmd === "git" &&
      Array.isArray(o2?.argv) &&
      o2.argv.some((a, i) => a === "worktree" && o2.argv?.[i + 1] === "remove")
    ) {
      return execp(cmd, { ...o2, env: o2?.env ?? childEnv(), cwd: o2?.cwd ?? repoRoot });
    }
    if (
      cmd === "git" &&
      Array.isArray(o2?.argv) &&
      o2.argv.some((a, i) => a === "worktree" && o2.argv?.[i + 1] === "add")
    ) {
      // The fixture's own `worktree add` for the run's tree, plus the probe's: both go to
      // the real git, since a registration the stub invented could not be read back.
      const isRosterProbe = o2?.argv?.includes(rosterProbeDir) === true;
      return execp(cmd, { ...o2, env: o2?.env ?? childEnv(), cwd: o2?.cwd ?? repoRoot }).then((r) => {
        // Bared the moment the checkout exists — before the gate provisions it and before it asks the
        // checkout anything — so the whole production sequence (checkout, link, judge, run) sees the
        // same tree a link that never landed would leave.
        if (isRosterProbe) bareBaseDeps(rosterProbeDir);
        return r;
      });
    }
    if (namesProbeTree(repoRoot, probeDir, o2) || isProbeBlobRead(o2, baseSha)) {
      // The base's blob reads are the ONE place a case answers for the base commit rather
      // than asking the real git of it: what the base held at the run's frozen paths is a
      // property of a commit the fixture built, and a case that needs the contract arm to
      // answer a particular way must not have to rewrite a commit to ask. Those reads carry
      // `cwd: repoRoot` and a `<base>:<path>` argv, so path-registration cannot identify
      // them — `isProbeBlobRead` recognises them by the sha the run is probing instead.
      if (o.baseBlobReadFails === true || o.baseBlobBytes !== undefined) {
        if (cmd === "git" && Array.isArray(o2?.argv) && o2.argv.includes("show")) {
          if (o.baseBlobReadFails === true) {
            // A NON-128 rejection: the executor's own timeout shape (`timedOutKill`, no
            // numeric `code`), which `gitPathAbsent` cannot mistake for git's "no such
            // path" (exit 128 plus its wording), and which must not be read as a colour.
            // With no `stdout` own-property the contract's reader cannot inspect any bytes,
            // so the probe is answered by its could-not-look arm rather than by the base
            // commit — which is what that case is about.
            return Promise.reject(probeBlobReadTimeoutError());
          }
          return Promise.resolve({ stdout: o.baseBlobBytes ?? "", stderr: "" });
        }
      }
      if (
        (o.baseRunTimesOut === true || o.baseRunOverflows === true) &&
        !isTierCommand(cmd, o2?.argv)
      ) {
        // The probe's frozen-test run at the base is NOT the run under test — it goes to
        // the real git of the base checkout, exactly as every other case's does. Without
        // this the hung/overflow command below would be substituted for it too, the probe
        // would return on its contract arm, and the tier classifier the case is about
        // would never be reached.
        return execp(cmd, { ...o2, env: o2?.env ?? childEnv(), cwd: o2?.cwd ?? probeDir });
      }
      if (
        (o.baseRunTimesOut === true || o.baseRunOverflows === true) &&
        (o2 as { killGroup?: boolean } | undefined)?.killGroup === true
      ) {
        // The probe's TIER run at the base, hung (a `sleep` past the bound) or chatty
        // (a `yes` past its `maxBuffer`). Both shapes come from the REAL executor — the
        // KILL, the `code: null`, the `timedOutKill` and the `overflow` stamp — rather than
        // from a stub, which is the only way to show what the base classifier does with a
        // run that produced no exit code at all. The tier's own marker is echoed first, so
        // the red the case reads back is the tier's, not the harness's.
        const { cmd: hungCmd, maxBuffer } = baseTierHangCommand(tiers, o.baseRunOverflows === true);
        // Routed through `runCountedTier` with `headRun: false`, so the base-tier counter
        // sees it: the case asserts the probe REACHED its classifier, and a substitution
        // that reported nothing would let the case pass without ever getting there.
        return runCountedTier(
          hungCmd,
          {
            ...o2,
            killGroup: true,
            maxBuffer,
            timeout:
              o.baseRunOverflows === true ? (o.timeoutMs ?? 2_000) * 4 : (o.timeoutMs ?? 2_000),
          },
          false,
        );
      }
      // The probe's tier and the probe's frozen contract are told apart by command
      // identity, not by the counter. The frozen run goes to the REAL git of the base
      // checkout — nothing here answers it — because "does the base fail this run's own
      // acceptance tests?" is a fact about the bytes the base commit holds, and a stub
      // that answered it would keep saying "red" for a tree that is not the base at all.
      if (isTierCommand(cmd, o2?.argv)) {
        if (o.baseTierThrows === true) return Promise.reject(new Error("probe tier exploded"));
        return runCountedTier(cmd, o2, false);
      }
      return execp(cmd, { ...o2, env: o2?.env ?? childEnv(), cwd: o2?.cwd ?? probeDir });
    }
    if (isTierCommand(cmd, o2?.argv)) return runCountedTier(cmd, o2, true);
    if (
      o.recheckHeadFails === true &&
      cmd === "git" &&
      String(o2?.argv ?? []) === String(RECHECK_ARGV) &&
      tierRan
    )
      return Promise.reject(new Error("git: fatal: unable to read HEAD"));
    if (
      o.recheckBranchDetached === true &&
      cmd === "git" &&
      String(o2?.argv ?? []) === String(BRANCH_ARGV) &&
      tierRan
    )
      return Promise.resolve({ stdout: "", stderr: "" });
    if (
      o.recheckBranchNoisyExit1 === true &&
      cmd === "git" &&
      String(o2?.argv ?? []) === String(BRANCH_ARGV) &&
      tierRan
    )
      return Promise.reject(
        Object.assign(new Error("git symbolic-ref: fatal: could not read HEAD"), {
          code: 1,
          stderr: "fatal: unable to resolve HEAD\n",
        }),
      );
    return execp(cmd, { ...o2, env: o2?.env ?? childEnv(), cwd: o2?.cwd ?? wt });
  };

  return {
    exec,
    redRunsSeen: () => tierRuns,
    baseTierRunsSeen: () => baseTierRuns,
    frozenRunsSeen: () => frozenRuns,
    rosterRunsSeen: () => rosterRuns,
  };
}
