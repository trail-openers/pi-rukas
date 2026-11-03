/**
 * lib/lean-build-fixture — the temp-git-repo harness the `lean/build` smoke
 * tests share.
 *
 * `build`'s claims are git claims ("the commit's parent is the head I found",
 * "no frozen path is in it", "the tree is clean afterwards"), so a stub exec
 * would test the stub. Here the repo, the frozen test commit and the worktree
 * are all real, `exec` shells out to the real `execp`, and only the model is a
 * stub: the fake dispatch performs the child's acts in the worktree and hands
 * back a `DispatchResult`.
 *
 * The fixture builds the state the step expects rather than pretending it: a
 * repo whose HEAD holds the frozen test commit (a `src/` file plus a test that
 * fails against it), a registered worktree on the run's branch at that HEAD,
 * and a step log carrying the `ready` / `specify` outcomes the run would have
 * earned on the way here. The frozen sha256 recorded in the log is the one the
 * committed blob really hashes to, so the case that must throw — (g) — has to
 * break the record on purpose, which is the only way to show the check reads
 * bytes rather than vibes.
 *
 * The child's acts are a callback so each case decides what its developer did:
 * edited `src/`, rewrote a frozen test, committed on its own, edited `.pi/` and
 * `.github/`, dropped a symlink and a hard link, or did nothing at all.
 *
 * `agents.json` is tracked in the base commit, so a case that edits it is the
 * tracked-protected shape: the reset has to bring it back, not merely the clean.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { BuildInfraError } from "../../src/lean/build-errors.ts";
import type { BuildDeps } from "../../src/lean/build.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import type { DispatchUsageRow } from "../../src/lean/step-budget.ts";
import type { BudgetOpts } from "../../src/lean/step-budget.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { SPEC_BODY, configWithRunner } from "./lean-build-asserts.ts";

/** Temp dirs this module made; the caller removes them at the end of the run. */
export const ROOTS: string[] = [];

/**
 * A directory OUTSIDE every fixture repo, for the link cases: the target a
 * symlink or hard link points at must not live in the worktree, or "no outside
 * bytes were committed" would prove nothing.
 */
export function outsideDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-build-outside-"));
  ROOTS.push(dir);
  return dir;
}

/** The identity every git child runs with — including the production commit. */
function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** The identity every git child runs with — exported for the challenge fixture. */
export function gitEnvFor(): Record<string, string> {
  return gitEnv();
}

/** git in `dir`, with an identity in the child's environment. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** The sha256 of a string's bytes, the way the freeze records them. */
export function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The implementation the frozen test is red against. */
export const SRC = "export const retry = () => { throw new Error('not-implemented'); };\n";
/**
 * The frozen acceptance test: fails against SRC, names its own path when it
 * does. It greps for a token that is NOT valid JS on its own (`not-implemented`
 * parses as subtraction), so an implementation that leaves the literal anywhere
 * keeps the test red — and it echoes its own path, which is what makes the
 * runner classify the failure as a red rather than an unclear exit.
 */
export const TEST =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1-retry.test.sh" 1>&2; exit 1; fi\nexit 0\n';
/** The tracked `agents.json` every build case has at the base; a protected path. */
export const AGENTS_JSON = '{"project-manager":{"write":"deny"}}\n';
/** The runner template a `.pi/work.json` would configure. */
export const RUNNER = "sh {file}";

export interface Built {
  repoRoot: string;
  /** The commit `ready` resolved — the base everything descends from. */
  baseSha: string;
  /** The head the frozen records were hashed at: base + the acceptance-test commit. */
  headBefore: string;
  branch: string;
  worktree: string;
  frozen: Record<string, string>;
  ctx: HandlerCtx;
}

/**
 * A repo whose HEAD holds the frozen test commit, a worktree at that HEAD on
 * the run's branch, and the step log a run would carry when it reaches build.
 *
 * `childOwnsBranch` is how a case gets a worktree at all when its child is
 * going to `git worktree remove`, `reset --hard` or otherwise wreck the tree:
 * the fixture's OWN git children run in `repoRoot`, whose checkout gets moved
 * off `main` by `-B branch` (git refuses to check out a branch a registered
 * worktree holds), so leaving the branch where the worktree was created —
 * detached at the frozen commit — keeps `repoRoot` on `main` and the case can
 * dismantle its own tree from inside the child callback.
 */
export function buildFixture(
  issue: number,
  opts?: {
    frozenSha?: string;
    frozenText?: string | Buffer;
    /**
     * Extra frozen files (path -> bytes) to commit on the run's head, hash to, and
     * record in the step log under a `challenge:new-tests` step. A case that asks
     * for the adversary's files gets blobs git really holds, so the step's
     * frozen-integrity check passes for the right reason.
     */
    extraFrozen?: Record<string, string>;
    childOwnsBranch?: boolean;
    /**
     * Build the run's worktree under `lean-<this>` rather than `lean-<issue>`.
     * The run's `issue`, branch and step-log keys stay `issue`: only the tree
     * directory moves. It is what lets a second fixture for another issue share
     * THIS repo without the two runs landing in one worktree — which matters
     * because `challenge`/`specify` derive their tree path from `repoRoot` plus
     * their own issue number, so a shared repo otherwise means a shared tree.
     */
    worktreeIssue?: number;
  },
): Built {
  const frozenText = opts?.frozenText ?? TEST;
  const frozenSha = opts?.frozenSha ?? sha(frozenText);
  const extraFrozen = opts?.extraFrozen ?? {};
  const worktreeIssue = opts?.worktreeIssue ?? issue;
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-build-"));
  ROOTS.push(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  const dir = (rel: string) => path.join(repoRoot, rel);
  mkdirSync(dir("src"), { recursive: true });
  mkdirSync(dir("tests"), { recursive: true });
  // `.pi/` and `.github/` exist and are tracked so a child's edit to them reads
  // as a change git reports — the shape the protected-path rule is for.
  // `.pi/` and `.github/` are NOT tracked: the harder shape for the protected
  // rule, because a tracked edit would come back from the plain reset whether
  // or not the step treated those paths as untouchable, while an untracked one
  // only leaves if the reset really cleans.
  mkdirSync(dir(".pi"), { recursive: true });
  mkdirSync(dir(".github/workflows"), { recursive: true });
  writeFileSync(dir("src/retry.ts"), SRC);
  writeFileSync(dir("agents.json"), AGENTS_JSON);
  writeFileSync(dir("tests/AC1-retry.test.sh"), frozenText, { mode: 0o755 });
  chmodSync(dir("tests/AC1-retry.test.sh"), 0o755);
  // The adversary's files go in the BASE commit here and the run's head commit is
  // empty above it, so every frozen blob — the specify one and the challenge ones
  // — is in the commit the frozen records were hashed at.
  for (const [rel, text] of Object.entries(extraFrozen)) {
    const target = dir(rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  const baseSha = git(repoRoot, "rev-parse", "HEAD");

  // The specify step's output: a commit on the run's branch holding the test.
  const branch = `lean/issue-${issue}`;
  git(repoRoot, "checkout", "-q", "-b", branch);
  git(repoRoot, "commit", "-q", "--allow-empty", "-m", `test: acceptance tests for #${issue}`);
  const headBefore = git(repoRoot, "rev-parse", "HEAD");
  if (!opts?.childOwnsBranch) git(repoRoot, "checkout", "-q", "main");

  const wt = path.join(repoRoot, ".worktrees", `lean-${worktreeIssue}`);
  // Always `-B branch`: the ownership check the step runs requires the tree to
  // sit on the run's branch (or be detached at the head), and `--detach` fails
  // the former while a detached-at-head tree would let a case move HEAD and
  // have the step not notice. In the `childOwnsBranch` shape `repoRoot` still
  // holds the branch, so git is told to detach the NEW tree without checking
  // anything out on the branch, and the step's own read of HEAD — not the
  // fixture's bookkeeping — is what the check compares against.
  const add = opts?.childOwnsBranch
    ? ["worktree", "add", "-q", "-B", branch, "--no-checkout", wt, headBefore]
    : ["worktree", "add", "-q", "--checkout", "-B", branch, wt, headBefore];
  git(repoRoot, ...add);
  if (opts?.childOwnsBranch) {
    // Check the tree out by hand: `git checkout <sha>` in a worktree whose
    // branch the parent holds leaves the same commits and a detached HEAD.
    const r = spawnSync("git", ["checkout", "-q", "--detach", headBefore], {
      cwd: wt,
      encoding: "utf8",
      env: gitEnv(),
    });
    if (r.status !== 0)
      throw new Error(`fixture checkout failed in ${wt}: ${(r.stderr ?? "").trim()}`);
  }

  const run = createRun({ issue, version: "test", models: {}, baseSha, branch });
  const steps: Step[] = [
    { key: `${issue}:ready:0`, state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    {
      key: `${issue}:specify:0`,
      state: "specify",
      startedAt: 2,
      outcome: {
        kind: "ok",
        frozen: { "tests/AC1-retry.test.sh": frozenSha },
        tests: { AC1: ["tests/AC1-retry.test.sh"] },
      },
    },
    // The adversary's round, when the case asked for one: the frozen map it
    // recorded is the one the committed bytes hash to.
    ...(Object.keys(extraFrozen).length === 0
      ? []
      : [
          {
            key: `${issue}:challenge:0`,
            state: "challenge" as const,
            startedAt: 3,
            outcome: { kind: "new-tests" as const, frozen: shaAll(extraFrozen) },
          },
        ]),
    // The position the log folds to: one build round owed.
    { key: `${issue}:build:0`, state: "build", startedAt: 3 },
  ];
  // One entry per build ROUND. The pending entry the engine re-runs is appended below it, exactly as
  // `runLean` appends a fresh step per round: a run already carrying a decided build
  // step is on its second round, not its first.
  const pending: Step = {
    key: `${issue}:build:${steps.filter((x) => x.state === "build").length}`,
    state: "build",
    startedAt: 3,
  };
  const withSteps = { ...run, steps: [...steps, pending] };
  const ctx: HandlerCtx = {
    repoRoot,
    issue,
    run: withSteps,
    steps,
    stepKey: `${issue}:build:0`,
    now: () => 4,
  };
  return {
    repoRoot,
    baseSha,
    headBefore,
    branch,
    worktree: wt,
    frozen: { "tests/AC1-retry.test.sh": frozenSha, ...shaAll(extraFrozen) },
    ctx,
  };
}

/** The sha256 of each value, keyed as the value is keyed. */
function shaAll(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, sha(v)]));
}

/** Worktree-relative path of a file the child may create. */
export { put, putOutside, symlink, hardlinkFromOutside } from "./lean-build-artifacts.ts";

/** The child committed whatever it had, itself. */
export function childCommit(wt: string, message: string): void {
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", message);
}

export interface RunResult {
  outcome?: Outcome;
  threw?: Error;
  /**
   * The cost rows the infra error carried, when the step paid for a child and
   * died. Read off the `BuildInfraError` itself so a case asserts the rows
   * survived the throw rather than re-deriving them from a message.
   */
  deadDispatches?: DispatchUsageRow[];
  dispatched: number;
  prompts: string[];
  specs: DispatchSpec[];
  /** The `extraArgs` of each dispatch, so a case can pin the reporter companion.
   *  `readonly` because the dispatcher hands over a frozen array — the fixture
   *  stores what it was given rather than a mutable copy of it. */
  extraArgs: readonly (readonly string[])[];
  worktree: string;
  headBefore: string;
  /** The worktree's HEAD after the step, so a case can say nothing was committed. */
  headAfter: string;
  /** The argv of every git call the step made, for the hook-guard canary. */
  gitArgvs: string[][];
}

export interface RunOpts {
  issue: number;
  /** The child's acts in the worktree, at the moment it is still working. */
  child?: (wt: string) => void;
  /**
   * Acts performed after the child's dispatch and before the step's next read of
   * the tree. A case needs this to place a file that is NOT part of the child's
   * commit: the blocked gate re-runs the reported frozen files at exactly this
   * moment — before normalisation's `clean -fdx`, which would delete an untracked
   * one — so a case about "what the driver actually sees when it re-runs the named
   * tests" plants its tree change here rather than in `child`.
   */
  afterDispatch?: (wt: string) => void;
  /** Extra steps to append to the log (a re-entry `verify:red` for case (i)). */
  extraSteps?: Step[];
  /** A build fixture whose frozen record is deliberately wrong (case (g)). */
  frozenSha?: string;
  /** The frozen test's committed bytes, when a case needs something other than TEST. */
  frozenText?: string | Buffer;
  /** Extra frozen files (path -> bytes) committed and frozen as challenge added them. */
  extraFrozen?: Record<string, string>;
  /** The aggregate capture ceiling in bytes, when a case needs a small one. */
  captureCeiling?: number;
  /** Skip the fixture's own worktree setup to test the "no worktree" throw. */
  built?: Built;
  /** Leave the run's branch to the worktree so a case can dismantle that tree. */
  childOwnsBranch?: boolean;
  /** A config load that refuses (case o); the step must treat it as infrastructure. */
  loadConfigError?: string;
  /** A child whose dispatch did not succeed — the infra case, as in `challenge`. */
  dispatchOk?: boolean;
  /**
   * Drive the fake child's progress feed at the moment it is still working.
   * A budget case calls `onProgress` the way `spawn.ts` does at every
   * `message_end`, which is what makes a ceiling breach observable without a
   * real child.
   */
  onProgressTick?: (onProgress: BudgetOpts["onProgress"]) => void;
  /**
   * THE config the step reads, verbatim. A case that wants to change one field
   * of the runner config (a budget, a tier) spreads {@link configWithRunner}
   * into this so the rest still comes from it: a budget case that dropped the
   * runner template would fail for the wrong reason.
   */
  config?: WorkConfig;
  /**
   * The child's tool calls, verbatim on the `DispatchResult` the stub returns.
   * A function is called at the instant of dispatch, so a case can build its
   * call from the tree the child's own `child` callback just wrote. The shape
   * `runChallenge` already carries; build's reporter tool (`report_blocked`)
   * needs it, and a case that wants a report cannot fake it any other way.
   */
  toolUses?: unknown[] | (() => unknown[]);
  /** Bounds the driver's re-run of a reported frozen test (a case observes a hang). */
  blockedTimeoutMs?: number;
}

/** Run the step against a fresh fixture; a throw comes back as the error. */
export async function runBuild(opts: RunOpts): Promise<RunResult> {
  const built =
    opts.built ??
    buildFixture(opts.issue, {
      ...(opts.frozenSha === undefined ? {} : { frozenSha: opts.frozenSha }),
      ...(opts.frozenText === undefined ? {} : { frozenText: opts.frozenText }),
      ...(opts.extraFrozen === undefined ? {} : { extraFrozen: opts.extraFrozen }),
      ...(opts.childOwnsBranch === undefined ? {} : { childOwnsBranch: opts.childOwnsBranch }),
    });
  if (opts.extraSteps !== undefined) {
    built.ctx.run.steps = [...built.ctx.run.steps, ...opts.extraSteps];
    built.ctx.steps = built.ctx.run.steps;
  }
  const prompts: string[] = [];
  const specs: DispatchSpec[] = [];
  const extraArgs: (readonly string[])[] = [];
  const gitArgvs: string[][] = [];
  let dispatched = 0;
  /** Whether the one-shot `afterDispatch` hook has fired (see `deps` below). */
  let planted = false;
  const exec: BuildDeps["exec"] = async (cmd, o) => {
    if (cmd === "git" && o?.argv) gitArgvs.push(o.argv);
    return execp(cmd, { ...o, env: gitEnv() });
  };
  const dispatch: BuildDeps["dispatch"] = async (spec: DispatchSpec, o) => {
    dispatched++;
    specs.push(spec);
    prompts.push(spec.prompt);
    extraArgs.push(o.extraArgs ?? []);
    opts.onProgressTick?.(o.onProgress);
    opts.child?.(spec.cwd as string);
    const declared =
      typeof opts.toolUses === "function" ? opts.toolUses() : [...(opts.toolUses ?? [])];
    const result: DispatchResult = {
      role: spec.role,
      ok: opts.dispatchOk !== false,
      text: "implemented",
      toolUses: declared,
      ms: 1,
      exitCode: opts.dispatchOk === false ? 1 : 0,
      // A child that reports no usage is a child that cost nothing, and the
      // step's dispatch row would record zeros — so the fixture reports what a
      // real child reports, and a case can assert the row carried it.
      usage: { input: 11, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.5, turns: 4 },
    };
    return result;
  };
  const inner: BuildDeps = {
    exec,
    dispatch,
    fetchIssueBody: async () => SPEC_BODY,
    loadConfig: async () => {
      if (opts.loadConfigError !== undefined) throw new Error(opts.loadConfigError);
      return opts.config ?? configWithRunner();
    },
    ...(opts.captureCeiling === undefined ? {} : { captureCeiling: opts.captureCeiling }),
    ...(opts.blockedTimeoutMs === undefined ? {} : { blockedTimeoutMs: opts.blockedTimeoutMs }),
  };
  const deps: BuildDeps = {
    ...inner,
    ...(opts.afterDispatch === undefined
      ? {}
      : {
          // The gate runs its re-runs before it looks at any git state, so firing
          // the hook on the first NON-git exec lands it in that instant without a
          // production seam invented for the test. It fires ONCE: a case plants a
          // tree change for the gate to judge, and re-planting it on every later
          // runner would make the tree depend on how many files the gate happened
          // to execute. git calls are skipped — the step's own `clean -fdx` runs
          // later, and planting before it would let normalisation delete the file.
          exec: async (cmd, o) => {
            if (cmd !== "git" && !planted) {
              planted = true;
              opts.afterDispatch?.(built.worktree);
            }
            return inner.exec(cmd, o);
          },
        }),
  };
  try {
    const { buildOutcome } = await import("../../src/lean/build.ts");
    const outcome = await buildOutcome(built.ctx, deps);
    return {
      outcome,
      dispatched,
      prompts,
      specs,
      extraArgs,
      worktree: built.worktree,
      headBefore: built.headBefore,
      headAfter: headOf(built.worktree),
      gitArgvs,
    };
  } catch (err) {
    return {
      threw: err as Error,
      deadDispatches: err instanceof BuildInfraError ? err.dispatches : undefined,
      dispatched,
      prompts,
      specs,
      extraArgs,
      worktree: built.worktree,
      headBefore: built.headBefore,
      headAfter: headOf(built.worktree),
      gitArgvs,
    };
  }
}

/** The worktree's HEAD, or "" when the tree is gone. */
function headOf(wt: string): string {
  try {
    return git(wt, "rev-parse", "HEAD");
  } catch {
    return "";
  }
}
