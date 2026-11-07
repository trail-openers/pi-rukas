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
import type { WorkConfig } from "../../src/lean/config.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { namesProbeTree } from "./lean-verify-probe-tree.ts";

export { canonicalProbeDir } from "./lean-verify-probe-tree.ts";

import {
  type ProbeShapeOpts,
  baseTierHangCommand,
  isProbeBlobRead,
  probeBlobReadTimeoutError,
} from "./lean-verify-probe-shapes.ts";
export interface VerifyRun {
  outcome?: Outcome;
  threw?: Error;
  worktree: string;
  head: string;
  /**
   * Where the baseline probe's throwaway tree lives, for the removal cases: it is
   * derived from the fixture's own `repoRoot`, which the case never has to rebuild.
   */
  probeDir?: string;
  /** How many times the tier command ran, across HEAD and the probe. */
  tierRuns?: number;
  /**
   * How many times the BASE PROBE ran the tier in its throwaway checkout (0 = it never got there).
   */
  baseTierRuns?: number;
  /**
   * How many times the step ran a FROZEN file through the `verify.test` runner. The
   * cost-bound cases assert on this rather than on wall clock: a hang's whole cost IS
   * the bound, so counting invocations says "one bound" in milliseconds where timing it
   * would pay a second one to prove it was not paid.
   */
  frozenRuns?: number;
  /** The run's repo root, for a case that wants to ask git about its worktrees. */
  repoRoot?: string;
}

export interface VerifyOpts extends ProbeShapeOpts {
  issue: number;
  /** What the project configured; `fast` defaults to a passing tier. */
  config?: Partial<WorkConfig["verify"]>;
  /**
   * Freeze extra acceptance-test files besides the fixture's own, as path -> bytes.
   * They are committed on top of the freeze and hashed into the record, so the step
   * judges them as genuine frozen tests — the shape a hanging frozen file needs.
   */
  extraFrozen?: Record<string, string>;
  /**
   * The `verify.test` runner template verbatim, for the case that wants a runner it
   * cannot start (`no-such-test-runner {file}`) rather than `sh {file}` or the
   * silent helper.
   */
  frozenRunner?: string;
  /**
   * The run's frozen contract is one that fails whatever the tree holds, so the
   * runner must name it — see `NAMING_RUNNER_TEMPLATE`. Used with `frozenText:
   * RED_ACCEPTANCE_TEST`; without it the helper goes untracked-or-unused and an
   * unconditional-red contract reads `unclear` rather than red.
   */
  alwaysRedFrozen?: boolean;
  /** Nothing configured at all: the frozen tests alone decide. */
  noCommand?: boolean;
  /** Bounds every tier and frozen-test run, so a hang is observable in seconds. */
  timeoutMs?: number;
  /** Make the worktree dirty before the step looks at it. */
  dirty?: boolean;
  /** Rewrite the frozen file ON DISK, uncommitted, before the step looks. */
  editDisk?: string;
  /** Commit a rewrite of the frozen file at HEAD before the step looks. */
  editAtHead?: string;
  /** Commit the implementation, so the frozen test's own red goes away. */
  implement?: boolean;
  /**
   * A second tier, run after `fast`: the re-check cases use it to rewrite a
   * frozen file, drop an untracked file, or commit, once the tree has already
   * been read clean. The command runs through a shell in the worktree.
   */
  full?: string;
  /**
   * Run the frozen tests through the silent helper runner instead of `sh {file}`:
   * it exits non-zero without naming the file, so the proof arrives `unclear`.
   * What the step is allowed to make of an unclear proof is what the case asks.
   */
  silentRunner?: boolean;
  /**
   * Reject the post-tier BRANCH read with exit 1 AND a message on stderr. git's
   * own detached answer is exit 1 with NOTHING printed, so a noisy exit 1 is a
   * git that could not reply and must not be read as "detached".
   */
  recheckBranchNoisyExit1?: boolean;
  /**
   * Make the HEAD read that happens AFTER the tiers reject, while every earlier
   * git call still goes to the real git. That read is the post-tier re-check: a
   * step that cannot re-read HEAD once the tiers have run has not observed a
   * tier moving it — it has failed to read the tree, which is infrastructure.
   */
  recheckHeadFails?: boolean;
  /**
   * Reject the post-tier BRANCH read (`symbolic-ref --short -q HEAD`) while
   * every earlier git call still goes to the real git — the shape a detached
   * HEAD gives, since `-q` exits 1 without printing anything. A read that
   * REJECTS rather than exiting 1 is covered by `recheckHeadFails` for the HEAD
   * read; this one proves the branch read treats git's "detached" exit as an
   * answer and not as a machine that could not reply.
   */
  recheckBranchDetached?: boolean;
  /**
   * The issue body the verify gate reads for its `command` criteria. Absent means
   * an issue with no `pi-spec` block, which is the "the spec asked for no command
   * criteria" shape — the ordinary case these cases are not about.
   */
  specBody?: string;
  /**
   * How many times the tier command may fail before it goes green, counted over
   * EVERY tree it runs in (HEAD's first run, HEAD's re-run, the base probe, in that
   * order): `1` is the flake — red at HEAD, green on the re-run; `2` is a tier red at
   * HEAD twice and green at the base, which is the real failure that still earns a
   * build round; `3` adds a base that is red too, which is the baseline hand-back.
   */
  headTierRedRuns?: number;
  /**
   * Make the BASE commit itself fail the run's frozen contract, with a real committed
   * test that exits non-zero whatever the tree holds.
   *
   * This is the only honest way to make a baseline-red case: the probe re-runs the run's
   * own acceptance tests inside the base checkout and reads their colour from the real
   * runner, so a base that is red is red because git says so, not because the case said
   * so. `false` is the boundary — a base with no red of its own, over which a tier may
   * not be excused.
   */
  baseRedContract?: boolean;
  /**
   * Make the probe's `git worktree add` reject. The base then cannot be judged at
   * all, which is infrastructure rather than a colour, and the probe tree must still
   * be gone afterwards — which is what the removal case drives.
   */
  baseAddFails?: boolean;
  /**
   * Reject the probe's tier run. A base run that throws is the case where a cleanup
   * that only ran on the happy path would leak its checkout, so the tree has to be
   * gone from `git worktree list` afterwards even though the probe itself failed.
   */
  baseTierThrows?: boolean;
  /**
   * Make the step's RE-RUN at HEAD reject with the executor's own kill shape
   * (`killed`, `timedOutKill`, `code: null`, no numeric exit code) — the shape a tier
   * that hung on its second attempt really produces, and the one a numeric `code`
   * cannot fake. The tier's OWN script is what hangs (see `killOnSecondTier`), so this
   * only makes the hang observable in seconds by shortening the bound the step gives a
   * tier: the SIGKILL, the `code: null`, and the `killed` stamp all come from the real
   * executor, not from a stub. A re-run that observed nothing may not excuse the tier:
   * the run must stay red, and a gate that read "no numeric code" as "exited 0" would
   * call it a flake and report a green nobody observed.
   */
  headRerunKilled?: boolean;
  /**
   * Make the step's RE-RUN at HEAD reject with NOTHING on it: no exit `code`, no
   * `killed`, no `overflow`, no `ENOENT`. This is the shape a harness speaks with rather
   * than a gate, and it is the one an "absence of an exit code means green" test gets
   * wrong — the rejection arrives as an object with no `stdout`, so the only honest
   * reading is "nobody told us anything" and the first red must stand.
   */
  headRerunSilentReject?: boolean;
  /**
   * Reject the step's RE-RUN at HEAD with a value the case names — the executor's own
   * kill, `overflow` or `ENOENT` shape, each of which `tierObserved` says `false` for.
   * These shapes still carry a `stdout`, so the re-run is the one place a tier that
   * nobody saw fail twice can print the very names the base printed, and an excuse
   * built from it grades a green on an unobserved run.
   */
  headRerunRejects?: unknown;
  /**
   * What the BASE PROBE's tier run printed (combined stdout+stderr), for the cases
   * that decide what the base NAMED rather than only what it exited. The base runs
   * at a commit the case built, so only the case can say what that run printed —
   * the same reason `baseBlobBytes` answers the base's bytes.
   */
  baseTierOutput?: string;
  /**
   * What the tier prints when the run's OWN worktree runs it red, for the cases
   * whose head tier must name failing tests. Absent means the tier's own script
   * output, which is every case that came before the baseline-excuse cases.
   */
  headTierOutput?: string;
  /**
   * The bytes to freeze as the run's acceptance test, for the case that fixes the
   * ACCEPTANCE half of the verdict rather than deriving it (`GREEN_TEST` and
   * `RED_ACCEPTANCE_TEST` in `lib/lean-verify-fixture.ts`). Absent means the
   * fixture's own red-until-implemented test.
   */
  frozenText?: string;
  /** Log lines to add after the fixture's own. */
  extraSteps?: Step[];
}

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
}): { exec: VerifyExec; redRunsSeen: () => number; baseTierRunsSeen: () => number; frozenRunsSeen: () => number } {
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
  /** The tier's own marker, so a stubbed red prints the identity of ITS tier. */
  const markerOf = (cmd: string): string => cmd.match(/tier-said-([A-Za-z0-9_-]+)/)?.[1] ?? "red";
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
    let cmd = command;
    if (!headRun) {
      // The base probe's own run of the tier, counted separately: `tierRuns` counts the
      // STEP's runs at HEAD, and a case that wants to know whether the probe reached its
      // tier — rather than settling on an earlier arm — asks for this one.
      baseTierRuns++;
      if (o.baseTierOutput !== undefined) {
        // A case that declares what the base printed: the executor's own non-zero shape
        // carrying that stream, which is the only way to ask "what did the base name"
        // about a run in a tree the case built — the same seam `baseBlobBytes` uses for
        // the base's bytes.
        return Promise.reject(
          Object.assign(new Error(`Command failed: ${cmd}`), {
            code: 1,
            stdout: o.baseTierOutput,
            stderr: "",
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
    let bound = o.headRerunKilled === true && run === 1 ? (o.timeoutMs ?? 2_000) : o.timeoutMs;
    if (o.headRerunSilentReject === true && run === 1) return Promise.reject(new Error("nope"));
    if (o.headRerunRejects !== undefined && run === 1) return Promise.reject(o.headRerunRejects);
    // A case whose tier must NAME failing tests owns the stream both of HEAD's runs
    // print; the exit code stays the executor's own non-zero shape, so `runTier` reads
    // a real red rather than a kill or a command that never started.
    if (run < redBudget - 1 || o.headTierOutput !== undefined) {
      return Promise.reject(
        Object.assign(new Error(`Command failed: ${cmd}`), {
          code: 1,
          stdout: o.headTierOutput ?? "",
          stderr: `tier-said-${markerOf(cmd)}-${String(run + 1)}\n`,
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
      return execp(cmd, { ...o2, env: o2?.env ?? childEnv(), cwd: o2?.cwd ?? repoRoot });
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
      if ((o.baseRunTimesOut === true || o.baseRunOverflows === true) && !isTierCommand(cmd, o2?.argv)) {
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
        const { cmd: hungCmd, maxBuffer } = baseTierHangCommand(
          tiers,
          o.baseRunOverflows === true,
        );
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
              o.baseRunOverflows === true
                ? (o.timeoutMs ?? 2_000) * 4
                : (o.timeoutMs ?? 2_000),
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
  };
}
