/**
 * lib/lean-verify-fixture — the harness the `lean/verify` smoke tests share.
 *
 * `verify`'s claims are git claims plus process-exit claims, so both are real
 * here: a temp git repo whose HEAD holds the frozen acceptance test, real `git`
 * probes, and real `sh` processes for the tiers and the frozen test runs. Only
 * the project's CONFIG is injected — a case that wants a tier to exit 1 must not
 * have to rewrite a commit the frozen records were hashed at to ask for one.
 *
 * This module builds its own repo rather than reusing `lean-build-fixture`'s
 * `buildFixture`, for one reason: that helper checks the run's branch out in
 * `repoRoot` too (`-B`), and a worktree whose HEAD the case moves must hold the
 * branch alone. The shape is otherwise the same — base commit, acceptance-test
 * commit, registered worktree — and the frozen sha256 in the step log is the one
 * the committed blob really hashes to, so the tamper cases have to break a real
 * byte to be red.
 *
 * A case mutates the tree BEFORE the step looks at it — editing a frozen file on
 * disk, committing a rewrite of the frozen blob at HEAD, dropping a stray file —
 * and the step then judges the result. That order is the whole point: `verify`
 * is asked "is this the tree that was frozen?", and the only way to show it
 * reads bytes rather than vibes is to change the bytes.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { type Outcome, type Step, createRun } from "../../src/lean/state.ts";

import type { VerifyDeps } from "../../src/lean/verify.ts";
import {
  DETACH_TIER,
  HANG_TIER,
  PASS_TIER,
  failTier,
  flakeTier,
  killOnSecondTier,
  pytestFailTier,
  writeTier,
} from "./lean-verify-tiers.ts";
export {
  DETACH_TIER,
  HANG_TIER,
  PASS_TIER,
  failTier,
  flakeTier,
  killOnSecondTier,
  pytestFailTier,
  writeTier,
} from "./lean-verify-tiers.ts";
import { type Fixture, provisionHookedTree } from "./lean-verify-hook-tree.ts";
import {
  type VerifyOpts,
  type VerifyRun,
} from "./lean-verify-types.ts";
import {
  canonicalProbeDir,
  makeVerifyExec,
} from "./lean-verify-exec.ts";

/** The shapes a verify case is configured with and answers with, re-exported here so a
 * case imports the whole harness from one module. */
export type { VerifyOpts, VerifyRun };

/** Temp dirs this module made; the caller removes them at the end of the run. */
export const ROOTS: string[] = [];

/**
 * The frozen-test and runner-helper bytes, re-exported so a case imports the whole
 * harness from one module. They live in `lean-verify-bytes.ts` with the reason each
 * body has to take the shape it does.
 */
export {
  GREEN_TEST,
  NAMING_RUNNER_FILE,
  NAMING_RUNNER_SCRIPT,
  NAMING_RUNNER_TEMPLATE,
  RED_ACCEPTANCE_TEST,
  RED_BASE_TEST,
  SILENT_RUNNER_FILE,
  SILENT_RUNNER_SCRIPT,
  SILENT_RUNNER_TEMPLATE,
  SRC,
  TEST,
  commitFrozenFiles,
} from "./lean-verify-bytes.ts";
import {
  NAMING_RUNNER_FILE,
  NAMING_RUNNER_SCRIPT,
  NAMING_RUNNER_TEMPLATE,
  RED_ACCEPTANCE_TEST,
  RED_BASE_TEST,
  SILENT_RUNNER_FILE,
  SILENT_RUNNER_SCRIPT,
  SILENT_RUNNER_TEMPLATE,
  SRC,
  TEST,
  commitFrozenFiles,
} from "./lean-verify-bytes.ts";
import { fixtureGitEnv, git, sha } from "./lean-verify-git.ts";

export { git, sha };

/**
 * The frozen contract of the BASE: an acceptance test the mainline carries and cannot
 * pass. Its bytes live in `lean-verify-bytes.ts` beside the rest of the contract.
 */
/** The one acceptance-test path the fixture freezes, and the baseline probe judges. */
const FROZEN_FILE = "tests/AC1-retry.test.sh";

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
async function fixture(
  issue: number,
  baseRedContract: boolean,
  hook?: { script: string; marksDir: string },
  frozenText?: string,
  extraFrozen: Record<string, string> = {},
): Promise<Fixture> {
  const built = fixtureSync(issue, baseRedContract, hook, frozenText, extraFrozen);
  if (hook !== undefined) await provisionHookedTree(built, hook, fixtureGitEnv());
  return built;
}

/**
 * Build the repo, its single acceptance-test commit, and the run's worktree. Synchronous
 * because most cases need nothing else; `fixture` adds the hook-provisioned tree on top.
 */
function fixtureSync(
  issue: number,
  baseRedContract: boolean,
  hook?: { script: string; marksDir: string },
  frozenText?: string,
  extraFrozen: Record<string, string> = {},
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

/** Run `verify` against a fixture repo; a throw comes back as `threw`. */
export async function runVerify(opts: VerifyOpts): Promise<VerifyRun> {
  const f = await fixture(
    opts.issue,
    opts.baseRedContract === true,
    opts.hookAtBase,
    opts.frozenText,
    opts.extraFrozen ?? {},
  );

  const wt = f.wt;
  const repoRoot = f.repoRoot;
  const probeDir = canonicalProbeDir(repoRoot, opts.issue);

  if (opts.implement === true && opts.editDisk === undefined) {
    // The green cases COMMIT their work, so the tree the step judges is clean.
    writeFileSync(path.join(wt, "src/DONE"), "done\n");
    git(wt, "add", "src/DONE");
    commitHere(wt, "feat: implemented the retry helper");
  }
  if (opts.editAtHead !== undefined) {
    // The freeze is the fixture's own commit, hashed into the log's record; this
    // rewrite lands AFTER it, so HEAD's blob no longer matches the record while
    // the working tree stays clean. Only a read of the commit can see it.
    writeFileSync(path.join(wt, FROZEN_FILE), opts.editAtHead, { mode: 0o755 });
    chmodSync(path.join(wt, FROZEN_FILE), 0o755);
    commitHere(wt, "chore: rewrote the frozen test after the freeze");
  }
  if (opts.editDisk !== undefined) {
    // The on-disk tamper case: the frozen file is edited and NOTHING else is
    // dirty, so the only thing standing between this run and a tier pass is the
    // on-disk comparison. The marker the contract asks for is committed here —
    // uncommitted, it would trip the clean-tree refusal before the tamper was
    // ever reached, and the case would prove nothing.
    if (opts.implement === true) {
      writeFileSync(path.join(wt, "src/DONE"), "done\n");
      commitHere(wt, "feat: implemented the retry helper");
    }
    writeFileSync(path.join(wt, FROZEN_FILE), opts.editDisk, { mode: 0o755 });
  }
  if (opts.dirty === true) writeFileSync(path.join(wt, "notes.txt"), "a stray file\n");

  const head = git(wt, "rev-parse", "HEAD");
  // The tier commands this case configured, as strings: a tier runs as a shell
  // command, so the only thing that identifies one to the executor is its own text.
  const configured: Partial<WorkConfig["verify"]> =
    opts.noCommand === true ? {} : (opts.config ?? { fast: PASS_TIER });
  if (opts.full !== undefined) configured.full = opts.full;
  const tiers: string[] = [configured.fast, configured.full].filter(
    (c): c is string => typeof c === "string" && c.trim() !== "",
  );
  if (opts.silentRunner === true) {
    // Committed before `head` is read: the step refuses a dirty tree before it
    // ever runs a test, so a helper left untracked would trip that first, and the
    // frozen file itself is untouched, so no tamper is mistaken for this.
    writeFileSync(path.join(wt, SILENT_RUNNER_FILE), SILENT_RUNNER_SCRIPT, { mode: 0o755 });
    commitHere(wt, "chore: fixture runner that stays silent");
  }
  if (opts.alwaysRedFrozen === true) {
    // The same rule as the silent helper above: committed, and committed before
    // `head` is read, so the tree the step judges is clean.
    writeFileSync(path.join(wt, NAMING_RUNNER_FILE), NAMING_RUNNER_SCRIPT, { mode: 0o755 });
    commitHere(wt, "chore: fixture runner that names its failing test");
  }
  // The log's frozen record is the bytes the FREEZE committed. A case that
  // rewrote the file on disk or at HEAD afterwards faces a record that no
  // longer matches, which is exactly the tamper the step must catch.
  const all = opts.extraSteps === undefined ? f.ctx.steps : [...f.ctx.steps, ...opts.extraSteps];
  const ctx: HandlerCtx = { ...f.ctx, steps: all };
  ctx.run = { ...ctx.run, steps: all };

  const { exec, redRunsSeen, baseTierRunsSeen, frozenRunsSeen } = makeVerifyExec({
    wt,
    probeDir,
    repoRoot,
    tiers,
    opts,
    baseSha: f.ctx.run.baseSha,
    ...(opts.hookAtBase === undefined ? {} : { hookMarks: opts.hookAtBase.marksDir }),
  });

  const deps: VerifyDeps = {
    exec,
    loadConfig: async () => ({
      verify: {
        ...configured,
        test:
          opts.frozenRunner ??
          (opts.silentRunner === true
            ? SILENT_RUNNER_TEMPLATE
            : opts.alwaysRedFrozen === true
              ? NAMING_RUNNER_TEMPLATE
              : "sh {file}"),
      },
    }),
    readVerifyCmd: async () => undefined,
    // The lean contract lives in the issue body, and the verify gate now reads it
    // through this seam for its `command` criteria. A fixture case whose body
    // carries no `pi-spec` block is the ordinary "the spec asked for nothing"
    // shape, so the tier runs no criteria and the case judges only what it asked.
    fetchIssueBody: async () => opts.specBody ?? "",
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };
  try {
    const { verifyOutcome } = await import("../../src/lean/verify.ts");
    return {
      outcome: await verifyOutcome(ctx, deps),
      worktree: wt,
      head,
      probeDir,
      repoRoot,
      tierRuns: redRunsSeen(),
      baseTierRuns: baseTierRunsSeen(),
      frozenRuns: frozenRunsSeen(),
    };
  } catch (err) {
    return {
      threw: err as Error,
      worktree: wt,
      head,
      probeDir,
      repoRoot,
      tierRuns: redRunsSeen(),
      baseTierRuns: baseTierRunsSeen(),
      frozenRuns: frozenRunsSeen(),
    };
  }
}

/** Commit everything in `dir`, as the fixture's identity. */
function commitHere(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

export interface HandbackPost {
  repoRoot: string;
  issue: number;
  body: string;
}

/** A HandlerCtx for a handback case, carrying the log the case asked for. */
export function handbackCtx(
  issue: number,
  steps: Step[],
  repoRoot = "/tmp/lean-handback-repo",
): HandlerCtx {
  const run = createRun({
    issue,
    version: "test",
    models: {},
    baseSha: "a".repeat(40),
    branch: `lean/issue-${issue}`,
  });
  const withSteps = { ...run, steps };
  return {
    repoRoot,
    issue,
    run: withSteps,
    steps: withSteps.steps,
    stepKey: `${issue}:handback:0`,
    now: () => 5,
  };
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

/** A decided step for the handback cases. */
export function decided(state: Step["state"], outcome: Outcome, n = 0): Step {
  return { key: `7:${state}:${n}`, state, startedAt: 1, endedAt: 2, outcome };
}

/**
 * A publish step that recorded its PR the only sanctioned way: `prUrl`.
 * `url`/`htmlUrl` are the fields the old guess list read, and a step that
 * reaches for one of them is refused by `state.ts` on load.
 *
 * `issue` names the branch the step belongs to, so a hand-built log can carry a
 * publish step whose `prUrl` the handback under test would print for that run.
 */
export function publishStep(
  url: string,
  field: "prUrl" | "url" | "htmlUrl" = "prUrl",
  issue?: number,
): Step {
  const outcome = { kind: "ok", ...(field === "prUrl" ? { prUrl: url } : { [field]: url }) };
  return decided("publish", outcome as Outcome, issue ?? 7);
}

/** The log a run carries when it reaches handback after its gate said red. */
export function redLog(prUrl?: string): Step[] {
  const steps: Step[] = [
    decided("ready", { kind: "ok" }),
    decided("specify", {
      kind: "ok",
      frozen: { [FROZEN_FILE]: "a".repeat(64) },
      tests: { AC1: [FROZEN_FILE] },
    }),
    decided("build", { kind: "ok", reason: "1 file(s) changed" }),
    decided("verify", {
      kind: "red",
      reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
    }),
  ];
  if (prUrl !== undefined) steps.push(decided("publish", { kind: "ok", prUrl } as Outcome));
  return steps;
}
