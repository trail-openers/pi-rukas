/**
 * lib/lean-verify-repo — the REPO a verify case runs against.
 *
 * The tree half of the verify harness: a real repo whose HEAD holds the frozen acceptance test, a
 * registered worktree on the run's branch at that HEAD, and the executable project-test stub the
 * roster's enumeration matches. `lean-verify-fixture.ts` runs the step against what this builds;
 * a case that only needs a log needs neither.
 *
 * The worktree is built first and the branch handed to it outright, so a case can commit inside the
 * tree — moving the very head the step is about to judge — without git refusing to move a branch
 * `repoRoot` holds. `fixtureSync` builds the repo and its worktree; `fixture` layers the optional
 * hook-provisioned tree on top, which is the only reason the repo build is not all synchronous.
 */

import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { ROSTER_REPORT_FILE } from "../../src/lean/verify-roster-command.ts";
import { type Outcome, type Step, createRun } from "../../src/lean/state.ts";
import { RED_BASE_TEST, SRC, TEST, commitFrozenFiles } from "./lean-verify-bytes.ts";
import { FROZEN_FILE } from "./lean-verify-frozen.ts";
import { ROOTS, fixtureGitEnv, git, sha } from "./lean-verify-git.ts";
import { type Fixture, provisionHookedTree } from "./lean-verify-hook-tree.ts";

/** The dependency directories a case may give the project; each must read as gitignored to git. */
const SHAREABLE_DEP_DIRS = ["node_modules", ".venv", "vendor"] as const;

export { git, sha };

/**
 * The pre-existing project test a roster case gives a tree.
 *
 * An executable stub: its NAME is what the roster's enumeration matches (`testDir` + `testGlob`),
 * and the names it "contains" are what the fixture writes beside it. The runner reports those, so
 * the roster the step records comes out of a report a real script wrote in a real tree rather than
 * out of a stub's return value.
 */
function projectStubScript(rel: string, baseFails = false): string {
  // The exit code is the case's, because the roster's base-version run executes THESE bytes through
  // the project's own `verify.test` template: a case asking "what if the base's copy fails against
  // the head code" has to be able to say so in the file the base actually holds.
  return `#!/bin/sh\n# ${rel}\nexit ${baseFails ? 1 : 0}\n`;
}

/** A declared failing test name, in the shape a report's `<testcase>` records as a failure. */
export function rosterFail(name: string): string {
  return `FAIL:${name}`;
}

/**
 * The frozen contract of the BASE: an acceptance test the mainline carries and cannot
 * pass. Its bytes live in `lean-verify-bytes.ts` beside the rest of the contract.
 */

/**
 * Commit the acceptance test in `dir` and return the resulting head. This is the
 * freeze: the sha the step log records is the sha of the bytes this commit holds,
 * so every tamper case has to change a real byte to be red.
 */
function commitFreeze(dir: string, issue: number, text: string): string {
  const target = path.join(dir, FROZEN_FILE);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, { mode: 0o755 });
  chmodSync(target, 0o755);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `test: acceptance tests for #${issue}`);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * A repo whose HEAD holds the frozen acceptance test, and a registered worktree
 * on the run's branch at that HEAD.
 *
 * The worktree is built first and the branch is handed to it outright, so a case
 * can commit inside the tree — moving the very head the step is about to judge —
 * without git refusing to move a branch `repoRoot` holds.
 *
 * `fixtureSync` builds the repo and its worktree; `fixture` layers the optional
 * hook-provisioned tree on top, which is the only reason the repo build is not all
 * synchronous.
 */
/** What building a fixture yields: the repo, its worktree, the frozen record and the ctx. */
export async function fixture(
  issue: number,
  baseRedContract: boolean,
  hook?: { script: string; marksDir: string },
  frozenText?: string,
  extraFrozen: Record<string, string> = {},
  /** Declared pre-existing test files: path -> the names its run reports. */
  rosterFiles?: Record<string, string[]>,
  /** Make the BASE commit's copy of each pre-existing test exit non-zero (bench cell 2). */
  baseProjectTestFails?: boolean,
  /**
   * Commit a real non-empty gitignored `node_modules/` at the base, so the roster's throwaway base
   * checkout has a dependency tree the provisioner could have linked — and a case can then ask what
   * happens when it does not.
   */
  baseHasDeps?: boolean,
): Promise<Fixture> {
  const built = fixtureSync(
    issue,
    baseRedContract,
    hook,
    frozenText,
    extraFrozen,
    rosterFiles,
    baseProjectTestFails,
    baseHasDeps,
  );
  if (hook !== undefined) await provisionHookedTree(built, hook, fixtureGitEnv());
  return built;
}

/**
 * Build the repo, its single acceptance-test commit, and the run's worktree. Synchronous
 * because most cases need nothing else; `fixture` adds the hook-provisioned tree on top.
 */
export function fixtureSync(
  issue: number,
  baseRedContract: boolean,
  hook?: { script: string; marksDir: string },
  frozenText?: string,
  extraFrozen: Record<string, string> = {},
  rosterFiles?: Record<string, string[]>,
  baseProjectTestFails?: boolean,
  baseHasDeps?: boolean,
): Fixture {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-verify-"));
  ROOTS.push(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  const dir = (rel: string) => path.join(repoRoot, rel);
  mkdirSync(dir("src"), { recursive: true });
  mkdirSync(dir("tests"), { recursive: true });
  writeFileSync(dir("src/retry.ts"), SRC);
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  if (hook !== undefined) {
    // A project hook COMMITTED AT THE BASE, so both trees this case involves are
    // hook-provisioned trees: the run's own worktree (which the driver must provision
    // through the hook) and the probe's throwaway checkout (which it must not). The hook
    // is an `sh` script that marks its `$PI_RUKAS_TEST_HOOK_MARKS` directory, so the case
    // reads evidence of WHERE it ran rather than trusting a stub's word for it.
    mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
    const hookFile = path.join(repoRoot, ".pi", "worktree-setup");
    writeFileSync(hookFile, hook.script, { mode: 0o755 });
    chmodSync(hookFile, 0o755);
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-q", "-m", "chore: project worktree-setup hook");
  }
  if (baseRedContract === true) {
    // The incident's shape, made of real bytes rather than of a stub's say-so, and put
    // where a baseline probe can actually reach it: at the SAME path the run goes on to
    // freeze, the base commit holds a test that fails UNCONDITIONALLY. That is exactly a
    // mainline whose acceptance suite is red on this host, seen through the run's own
    // contract — the one comparison the probe can make without running the run's tests
    // at a commit that predates them. The freeze then records the run's PASSING bytes at
    // the same path, so the tamper guard's rule ("HEAD's blob is the frozen blob") still
    // holds at HEAD while the base holds other, failing, bytes.
    mkdirSync(dir("tests"), { recursive: true });
    writeFileSync(dir(FROZEN_FILE), RED_BASE_TEST, { mode: 0o755 });
    chmodSync(dir(FROZEN_FILE), 0o755);
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-q", "-m", "test: the mainline's own suite is red on this host");
  }
  // The project's OWN pre-existing tests, committed at the BASE so the roster's enumeration finds
  // them there. Each is a real `sh` script that writes the machine-readable report the gate reads,
  // with the names this case declared — so the roster the step records comes out of a report a real
  // runner wrote in a real tree, not out of a stub's return value.
  if (rosterFiles !== undefined) {
    // The project's pre-existing test FILES are committed at the base, because that is the fact the
    // roster's enumeration reads: `git ls-tree <base>` under the configured pair must find them, and
    // a file the case only has in its head tree is not a pre-existing test. What each file "reports"
    // is declared per side below, since one file's verdicts differ between the trees.
    // The runner the roster command names, committed so BOTH trees have it — the run's worktree and
    // the probe's throwaway checkout. What it reports is declared per side, so the script itself only
    // has to exist and exit: the stub writes the report the gate reads back. The roster's derived
    // command spells the suite, so its script is named apart from the runner the frozen-test arm
    // spells — a case whose tier IS the roster's command can still count the two arms apart.
    writeFileSync(dir(".lean-roster-suite.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(dir(".lean-roster-suite.sh"), 0o755);
    // A project keeps its runner's report out of the index, and the step's own re-check demands a
    // clean tree afterwards, so the fixture earns the same courtesy it would give a real suite.
    writeFileSync(dir(".gitignore"), `${ROSTER_REPORT_FILE}\n`);
    // The dependency dirs a case gives this project are gitignored from the FIRST commit: a candidate
    // git does not report as ignored is one `linkShareableDeps` will never link, and a gate cannot
    // judge whether a link landed for a link that was never on the table.
    if (baseHasDeps === true)
      writeFileSync(dir(".gitignore"), `${ROSTER_REPORT_FILE}\n${SHAREABLE_DEP_DIRS.join("\n")}\n`);
    // A project's dependency tree lives where the provisioner looks for it: at the root, gitignored,
    // and non-empty. Both halves are needed to ask "what if the base checkout never received it": the
    // `.gitignore` entry that makes the candidate linkable at all (an unignored candidate is one the
    // provisioner was never going to link, and a link that was never on the table is not this gate's
    // problem to catch), and a real non-empty tree beside it. Both are COMMITTED at the base, so the
    // throwaway checkout has them and `expectedDepLocations` expects them there — a case asking what
    // happens when they do not arrive removes them from the checkout, since git restores tracked bytes.
    if (baseHasDeps === true) {
      mkdirSync(dir("node_modules/dep"), { recursive: true });
      writeFileSync(dir("node_modules/dep/index.js"), "export const dep = 1;\n");
    }
    for (const rel of Object.keys(rosterFiles)) {
      const target = dir(rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, projectStubScript(rel, baseProjectTestFails === true), { mode: 0o755 });
      chmodSync(target, 0o755);
    }
    git(repoRoot, "add", "-A", "-f");
    git(repoRoot, "commit", "-q", "-m", "test: the project's own pre-existing test suite");
  }
  const baseSha = git(repoRoot, "rev-parse", "HEAD");
  const branch = `lean/issue-${issue}`;
  git(repoRoot, "checkout", "-q", "main");
  // The worktree is created BEFORE the freeze commit and the branch is handed to
  // it outright, so a case that commits inside the tree moves a head nothing
  // else holds. `--no-checkout` + a hand-written checkout is how git is told to
  // put the branch on a tree without also checking it out in `repoRoot`.
  const wt = path.join(repoRoot, ".worktrees", `lean-${issue}`);
  git(repoRoot, "worktree", "add", "-q", "-B", branch, wt, baseSha);
  // The frozen contract's bytes: the fixture's own red-until-implemented test, or the
  // case's, for the pair that fixes the ACCEPTANCE half of a verdict (green for an
  // excuse case, red for the case asking what an acceptance-red run does on the
  // excuse path).
  const head = commitFreeze(wt, issue, frozenText ?? TEST);
  // The case's own extra frozen files, committed ON TOP of the freeze: they must be
  // the bytes the record names, or the step's tamper guard reports a hang as an
  // edited contract.
  if (Object.keys(extraFrozen).length > 0) commitFrozenFiles(wt, extraFrozen);

  const run = createRun({ issue, version: "test", models: {}, baseSha, branch });
  // The record is what the step reads back, so it must be the bytes the FREEZE holds at
  // HEAD — which is the run's own contract. The base's red acceptance test is NOT part
  // of it: it belongs to the mainline, and a run cannot freeze a test it did not author.
  // What makes the base red is that the base carries a test at all whose bytes the run's
  // contract does not satisfy, which the probe reads off the base commit itself.
  // The record must hold the sha of the bytes the FREEZE actually holds — the case's
  // bytes when the case fixed them — or the integrity check reads a green contract as
  // a tampered one.
  const frozen: Record<string, string> = { [FROZEN_FILE]: sha(frozenText ?? TEST) };
  for (const [rel, text] of Object.entries(extraFrozen)) frozen[rel] = sha(text);
  const extraPaths = Object.keys(extraFrozen);
  const steps: Step[] = [
    { key: `${issue}:ready:0`, state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    {
      key: `${issue}:specify:0`,
      state: "specify",
      startedAt: 2,
      outcome: {
        kind: "ok",
        frozen,
        tests: { AC1: [FROZEN_FILE, ...extraPaths] },
      },
    },
  ];
  const withSteps = { ...run, steps };
  return {
    repoRoot,
    wt,
    head,
    frozen,
    ctx: {
      repoRoot,
      issue,
      run: withSteps,
      steps,
      stepKey: `${issue}:verify:0`,
      now: () => 4,
    },
  };
}

/** Commit everything in `dir`, as the fixture's identity. */
export function commitHere(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

/**
 * A fixture in the state `verify` expects, for the wiring tests: the real repo,
 * the real registered worktree, and a HandlerCtx whose step log froze the test.
 * Nothing runs, so the case can call a handler directly and watch it refuse.
 */
export function buildFixtureForWiring(issue: number): {
  repoRoot: string;
  wt: string;
  ctx: HandlerCtx;
} {
  // The wiring cases never provision a tree, so they take the synchronous path.
  const f = fixtureSync(issue, false);
  return { repoRoot: f.repoRoot, wt: f.wt, ctx: f.ctx };
}
