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
import { chmodSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { BuildDeps } from "../../src/lean/build.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import type { RunningState } from "../../src/progress.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import { gitTestEnv } from "./git-test-env.ts";

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
export const SRC = "export const retry = () => { throw new Error('not implemented'); };\n";
/** The frozen acceptance test: fails against SRC, names its own path when it does. */
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
    frozen: { "tests/AC1-retry.test.sh": frozenSha },
    ctx,
  };
}

/** Worktree-relative path of a file the child may create. */
export function put(wt: string, rel: string, content: string, mode?: number): void {
  const target = path.join(wt, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: mode ?? 0o644 });
}

/** The child made a symlink at `rel` pointing at `target`. */
export function symlink(wt: string, rel: string, target: string): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  symlinkSync(target, path.join(wt, rel));
}

/**
 * The child hard-linked `rel` in the worktree to a file OUTSIDE the repo.
 * `linkSync` across filesystems throws EXDEV, so the outside file is written
 * into the same filesystem as the repo.
 */
export function hardlinkFromOutside(wt: string, rel: string, outsideAbs: string): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  linkSync(outsideAbs, path.join(wt, rel));
}

/** Write a file outside every repo and return its absolute path. */
export function putOutside(abs: string, content: string): string {
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** The child committed whatever it had, itself. */
export function childCommit(wt: string, message: string): void {
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", message);
}

export interface RunResult {
  outcome?: Outcome;
  threw?: Error;
  dispatched: number;
  prompts: string[];
  specs: DispatchSpec[];
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
  /** Extra steps to append to the log (a re-entry `verify:red` for case (i)). */
  extraSteps?: Step[];
  /** Override the config handed to the step. */
  config?: WorkConfig;
  /** A build fixture whose frozen record is deliberately wrong (case (g)). */
  frozenSha?: string;
  /** The frozen test's committed bytes, when a case needs something other than TEST. */
  frozenText?: string | Buffer;
  /** The aggregate capture ceiling in bytes, when a case needs a small one. */
  captureCeiling?: number;
  /** Skip the fixture's own worktree setup to test the "no worktree" throw. */
  built?: Built;
  /** Leave the run's branch to the worktree so a case can dismantle that tree. */
  childOwnsBranch?: boolean;
  /** A config load that refuses (case o); the step must treat it as infrastructure. */
  loadConfigError?: string;
  /**
   * Drive the fake child's progress feed at the moment it is still working.
   * A budget case calls `onProgress` the way `spawn.ts` does at every
   * `message_end`, which is what makes a ceiling breach observable without a
   * real child.
   */
  onProgressTick?: (onProgress: ((s: RunningState) => void) | undefined) => void;
  /**
   * THE config the step reads, verbatim — as opposed to `config`, which is
   * discarded unless it is set whole. A case that wants to change one field of
   * the runner config (a budget, a tier) uses this so the rest still comes from
   * {@link configWithRunner}: a budget case that dropped the runner template
   * would fail for the wrong reason.
   */
  exactConfig?: WorkConfig;
}

/** Run the step against a fresh fixture; a throw comes back as the error. */
export async function runBuild(opts: RunOpts): Promise<RunResult> {
  const built =
    opts.built ??
    buildFixture(opts.issue, {
      ...(opts.frozenSha === undefined ? {} : { frozenSha: opts.frozenSha }),
      ...(opts.frozenText === undefined ? {} : { frozenText: opts.frozenText }),
      ...(opts.childOwnsBranch === undefined ? {} : { childOwnsBranch: opts.childOwnsBranch }),
    });
  if (opts.extraSteps !== undefined) {
    built.ctx.run.steps = [...built.ctx.run.steps, ...opts.extraSteps];
    built.ctx.steps = built.ctx.run.steps;
  }
  const prompts: string[] = [];
  const specs: DispatchSpec[] = [];
  const gitArgvs: string[][] = [];
  let dispatched = 0;
  const exec: BuildDeps["exec"] = async (cmd, o) => {
    if (cmd === "git" && o?.argv) gitArgvs.push(o.argv);
    return execp(cmd, { ...o, env: gitEnv() });
  };
  const dispatch: BuildDeps["dispatch"] = async (spec: DispatchSpec, o) => {
    dispatched++;
    specs.push(spec);
    prompts.push(spec.prompt);
    opts.onProgressTick?.(o.onProgress);
    opts.child?.(spec.cwd as string);
    const result: DispatchResult = {
      role: spec.role,
      ok: true,
      text: "implemented",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    };
    return result;
  };
  const deps: BuildDeps = {
    exec,
    dispatch,
    fetchIssueBody: async () => SPEC_BODY,
    loadConfig: async () => {
      if (opts.loadConfigError !== undefined) throw new Error(opts.loadConfigError);
      return opts.exactConfig ?? opts.config ?? configWithRunner();
    },
    ...(opts.captureCeiling === undefined ? {} : { captureCeiling: opts.captureCeiling }),
  };
  try {
    const { buildOutcome } = await import("../../src/lean/build.ts");
    const outcome = await buildOutcome(built.ctx, deps);
    return {
      outcome,
      dispatched,
      prompts,
      specs,
      worktree: built.worktree,
      headBefore: built.headBefore,
      headAfter: headOf(built.worktree),
      gitArgvs,
    };
  } catch (err) {
    return {
      threw: err as Error,
      dispatched,
      prompts,
      specs,
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

/** A config carrying the project's test runner template. */
export function configWithRunner(): WorkConfig {
  return { ...defaultConfig(), verify: { fast: "true", test: RUNNER } };
}

/** A body carrying the spec `build` re-reads from the forge. */
export const SPEC_BODY = `\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: [
      { id: "AC1", text: "retries a transient failure twice before failing", verify: "test" },
      { id: "AC2", text: "documents the retry budget", verify: "manual" },
    ],
    scope: { paths: ["src/retry.ts"], out: ["docs/"] },
  },
  null,
  2,
)}
\`\`\``;

/** `git status --porcelain -uall` for a worktree, "" when clean. */
export function status(wt: string): string {
  return git(wt, "status", "--porcelain", "-uall");
}

/** The paths one commit changes, in git's order. */
export function commitPaths(wt: string, ref = "HEAD"): string[] {
  const out = git(wt, "show", "--name-only", "--format=", ref);
  return out === "" ? [] : out.split("\n");
}

/** The subject line of HEAD. */
export function subject(wt: string): string {
  return git(wt, "log", "--format=%s", "-1");
}

/** Every commit subject above `ref`. */
export function subjectsAbove(wt: string, ref: string): string[] {
  return git(wt, "log", "--format=%s", `${ref}..HEAD`)
    .split("\n")
    .filter((s) => s !== "");
}
