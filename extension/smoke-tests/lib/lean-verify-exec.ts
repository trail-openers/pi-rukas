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
 *    not the binary's name: `failTier()` builds a tier that is itself `sh -c '…'`, and
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
 * testing the stub.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { NO_HOOKS } from "../../src/lean/specify-reset.ts";
import { baselineProbeWorktreePath } from "../../src/lean/verify-baseline.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";
import { gitTestEnv } from "./git-test-env.ts";

/**
 * The probe's tree path, canonicalised the way `probeTierAtBase` builds it.
 *
 * On macOS `tmpdir()` is `/var/…`, a symlink to `/private/var`, and a path built from
 * the raw tmpdir is never equal to the one the probe actually runs in — so a probe call
 * would be mistaken for a HEAD run and answered from the run's own red counter. The
 * tree does not exist yet, so `realpathSync` cannot resolve it; its PARENT (which the
 * fixture created) is canonicalised and the leaf re-joined.
 */
export function canonicalProbeDir(repoRoot: string, issue: number): string {
  const probePath = baselineProbeWorktreePath(repoRoot, issue);
  const probeParent = path.dirname(probePath);
  return path.join(realpathSync(probeParent), probePath.slice(probeParent.length + 1));
}

/**
 * The ONE fact that makes an exec call "the probe": it names the probe's own tree, and
 * that tree is REGISTERED with git.
 *
 * Both halves are needed, and each kills one way the fixture could lie to itself.
 *
 * Naming the probe's path is what separates the probe from every other call the step
 * makes: the run's OWN worktree is a registered worktree too, so "is a registered
 * worktree" alone would answer the step's `rev-parse HEAD` in its own tree as a probe
 * call and every case would die at the very first read.
 *
 * Registration is what keeps a stubbed failure honest. When a case makes `worktree add`
 * refuse, the tree was never created; without this check the add itself (whose argv
 * names the path) would be answered from the base options, so the probe would be reading
 * its own `git worktree add` as a red frozen test and the run would surface `unusable`
 * for the wrong reason. `probeTierAtBase` removes the tree in a `finally`, so the window
 * in which git lists it is exactly the window in which the probe runs.
 *
 * The path is matched EXACTLY against what production names, and the tree must also be
 * REGISTERED with git right now. Each half kills a distinct way the fixture could lie:
 *
 *   - exact path, because the run's OWN worktree is a registered worktree too — a test
 *     that asked only "is this a registered tree?" would answer the step's `rev-parse
 *     HEAD` in its own worktree as a probe call and every case would die at its first
 *     read, and a probe moved INSIDE the repo is a path production never runs its
 *     commands at, so nothing matches it and the probe's colour comes out wrong;
 *   - registration, because when a case makes `worktree add` refuse the tree was never
 *     created: without this the add itself (whose argv names the path) would be answered
 *     from the base options and the probe would report its own `git worktree add` as a
 *     red contract. `probeTierAtBase` removes the tree in a `finally`, so the window in
 *     which git lists it is exactly the window in which the probe runs.
 */
function namesProbeTree(
  repoRoot: string,
  probeDir: string,
  o2: Parameters<VerifyExec>[1] | undefined,
): boolean {
  const named: string[] = [];
  if (typeof o2?.cwd === "string") named.push(o2.cwd);
  if (Array.isArray(o2?.argv)) named.push(...o2.argv.filter((a) => typeof a === "string"));
  if (!named.some((p) => p === probeDir)) return false;
  const listed = spawnSync("git", [...NO_HOOKS, "worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitTestEnv(),
  });
  if (listed.status !== 0) return false;
  const registered = new Set(
    (listed.stdout ?? "")
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length)),
  );
  return named.some((p) => registered.has(p));
}

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
  /** The run's repo root, for a case that wants to ask git about its worktrees. */
  repoRoot?: string;
}

export interface VerifyOpts {
  issue: number;
  /** What the project configured; `fast` defaults to a passing tier. */
  config?: Partial<WorkConfig["verify"]>;
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
  /** Log lines to add after the fixture's own. */
  extraSteps?: Step[];
}

export function makeVerifyExec(opts: {
  wt: string;
  probeDir: string;
  repoRoot: string;
  tiers: string[];
  opts: VerifyOpts;
}): { exec: VerifyExec; redRunsSeen: () => number } {
  const { wt, probeDir, repoRoot, tiers, opts: o } = opts;
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
  /** Runs of the tier the step has made in the RUN's own worktree. */
  let headTierRuns = 0;
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
  const runCountedTier = (cmd: string, o2: Parameters<VerifyExec>[1], headRun: boolean) => {
    if (!headRun)
      return execp(cmd, { ...o2, env: o2?.env ?? gitTestEnv(), cwd: o2?.cwd ?? probeDir });
    const run = headTierRuns;
    headTierRuns++;
    tierRuns++;
    // The hung re-run: only the second run of the tier gets the shortened bound, so the
    // executor's own group kill fires on it and on nothing else.
    const bound = o.headRerunKilled === true && run === 1 ? (o.timeoutMs ?? 2_000) : o.timeoutMs;
    if (o.headRerunSilentReject === true && run === 1) return Promise.reject(new Error("nope"));
    if (run < redBudget - 1) {
      return Promise.reject(
        Object.assign(new Error(`Command failed: ${cmd}`), {
          code: 1,
          stdout: "",
          stderr: `tier-said-red-${String(run + 1)}\n`,
        }),
      );
    }
    return execp(cmd, { ...o2, timeout: bound, env: o2?.env ?? gitTestEnv(), cwd: o2?.cwd ?? wt });
  };

  const exec: VerifyExec = (cmd, o2) => {
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
      return execp(cmd, { ...o2, env: o2?.env ?? gitTestEnv(), cwd: o2?.cwd ?? repoRoot });
    }
    if (namesProbeTree(repoRoot, probeDir, o2)) {
      // The probe's tier and the probe's frozen contract are told apart by command
      // identity, not by the counter. The frozen run goes to the REAL git of the base
      // checkout — nothing here answers it — because "does the base fail this run's own
      // acceptance tests?" is a fact about the bytes the base commit holds, and a stub
      // that answered it would keep saying "red" for a tree that is not the base at all.
      if (isTierCommand(cmd, o2?.argv)) {
        if (o.baseTierThrows === true) return Promise.reject(new Error("probe tier exploded"));
        return runCountedTier(cmd, o2, false);
      }
      return execp(cmd, { ...o2, env: o2?.env ?? gitTestEnv(), cwd: o2?.cwd ?? probeDir });
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
    return execp(cmd, { ...o2, env: o2?.env ?? gitTestEnv(), cwd: o2?.cwd ?? wt });
  };

  return { exec, redRunsSeen: () => tierRuns };
}
