/**
 * lib/lean-challenge-fixture — the temp-git-repo harness `lean/challenge`
 * smoke tests share.
 *
 * It reuses `lib/lean-build-fixture.ts` to get the state `challenge` actually
 * starts from: a repo whose HEAD holds the frozen acceptance-test commit and a
 * build commit on top of it. Building that shape here a second time would be a
 * second place to get the interesting part wrong — which commit is HEAD, that
 * the worktree sits on the run's branch AT that head, and that the frozen sha in
 * the step log is the one the committed blob really hashes to.
 *
 * On top of it this adds the two things `challenge` alone needs:
 *
 *   - `buildCommit` — a real implementation commit above the frozen test commit,
 *     so the run has built something to attack and `frozenFromLog` sees the
 *     `build:ok` step the machine put there;
 *   - `runChallenge` — the step driven against a stub adversary that writes its
 *     new test files and declares them through `submit_tests`, with the child's
 *     acts and its declarations both supplied per case.
 *
 * `headBefore` the step reads is the BUILD commit, not the frozen test commit:
 * the challenge round's whole claim is red-against-the-current-code, so a case
 * whose child moved HEAD has to be visible in that number.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { ChallengeDeps } from "../../src/lean/challenge.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { foldLog } from "../../src/lean/resume.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import {
  type Built,
  RUNNER,
  SPEC_BODY,
  buildFixture,
  git,
  gitEnvFor,
  sha,
} from "./lean-build-fixture.ts";

/**
 * `git show <ref>:<rel>` as RAW BYTES.
 *
 * `spawnSync` with an `encoding` would decode the blob in the HARNESS, which is
 * exactly the mangling the byte-exactness tests exist to catch — and a harness
 * that decodes would agree with a broken step. The fixture's `git()` strips a
 * trailing newline too, and the frozen hashes are over the committed bytes
 * WITH it, so this call must be the one untrimmed, un-decoded path.
 */
export function rawShow(wt: string, spec: string): Buffer {
  const r = spawnSync("git", ["show", spec], {
    cwd: wt,
    maxBuffer: 8 * 1024 * 1024,
    env: gitEnvFor(),
  });
  if (r.status !== 0)
    throw new Error(`git show ${spec} failed: ${(r.stderr ?? "").toString().trim()}`);
  return r.stdout;
}

/** The sha256 of a committed blob at `ref`, the way the freeze records it. */
export function blobSha(wt: string, ref: string, rel: string): string {
  return sha(rawShow(wt, `${ref}:${rel}`));
}

export {
  ROOTS,
  RUNNER,
  SPEC_BODY,
  childCommit as childCommitOf,
  git,
  put,
  putOutside,
  sha,
} from "./lean-build-fixture.ts";
export { SpecifyInfraError } from "../../src/lean/specify.ts";

export interface ChallengeBuilt extends Built {
  /** The build commit `challenge` finds as HEAD — above the frozen test commit. */
  buildSha: string;
}

/**
 * A spec with TWO `verify: "test"` criteria.
 *
 * `SPEC_BODY` has one test criterion and one manual one, which is enough to
 * drive every case except the coverage rule: with a single criterion, "all
 * criteria covered" and "at least one red" are the same question. This body is
 * what makes the two rules separate — a run that is red for AC1 and green for
 * AC2 is a refusal under `specify`'s `"all-criteria"` and a freeze under
 * `challenge`'s `"any-red"`, and the case below is what pins that.
 */
export const TWO_AC_BODY = `\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: [
      { id: "AC1", text: "retries a transient failure twice before failing", verify: "test" },
      { id: "AC2", text: "gives up on a non-transient error without retrying", verify: "test" },
    ],
    scope: { paths: ["src/retry.ts"], out: ["docs/"] },
  },
  null,
  2,
)}
\`\`\``;

/**
 * A repo at base + frozen-test commit + build commit, with the step log a run
 * carries when the machine routes it into `challenge` after its first build.
 *
 * `extraFrozen` is how a case extends the contract with a file that is not the
 * fixture's own `tests/AC1-retry.test.sh` — the shape the "adversary may not
 * replace a frozen test" rule needs, since that rule is about a path the run
 * already froze and hashed. The file is written and committed INTO the build
 * commit, and its sha256 is unioned into the frozen map the step log records,
 * so `assertFrozenIntact` reads a real blob and agrees. The caller is
 * responsible for making the file executable if the runner must run it.
 */
export function challengeFixture(
  issue: number,
  opts?: { extraFrozen?: Record<string, string>; issueDir?: number },
): ChallengeBuilt {
  // A case that wants two runs against ONE repo — one whose child touches a
  // frozen path, one that leaves it alone — gives the second its own issue
  // number so it gets its own worktree. `issue` stays the number the step and
  // its commit subject carry; only the worktree directory is shared.
  const built = buildFixture(opts?.issueDir ?? issue) as ChallengeBuilt;
  const wt = built.worktree;
  // The builder's work, committed the way the build step commits it: a real
  // commit ON the run's branch, above the frozen test commit. Written in the
  // worktree because that is the tree the run's branch is checked out in.
  mkdirSync(path.join(wt, "src"), { recursive: true });
  // Bytes that keep the FROZEN test green (it greps its own path out of the
  // source and fails when it finds it) while leaving an adversary free to write
  // a file that still fails: the builder finished the obvious case, and the
  // round's question is whether it finished the one nobody thought of.
  writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => retryTwice();\n");
  const extra: Record<string, string> = {};
  for (const [rel, text] of Object.entries(opts?.extraFrozen ?? {})) {
    // Executable, because a frozen test the runner has to run is executable by
    // definition — and a case that froze a non-executable file would have the
    // step throw for the wrong reason (see `assertRan`).
    writeFileSync(path.join(wt, rel), text, { mode: 0o755 });
    extra[rel] = sha(text);
  }
  const frozen = { ...built.frozen, ...extra };
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", `build: attempt 1 for #${issue}`);
  const buildSha = git(wt, "rev-parse", "HEAD");

  // The log a run carries when it is sitting in `challenge`. Two shapes reach
  // it and this fixture builds the one the machine produces on the happy path —
  // the FIRST round, which is what a fresh cycle does: `build:ok` with
  // `challengeDone` unset routes to `challenge`, and the write-ahead entry sits
  // on top. `foldLog` is asked to confirm the position rather than being told it
  // (a fixture that hand-carries counters is a fixture that can drift from the
  // table it claims to be standing in), so a log the machine could never write
  // throws here instead of driving a step from an impossible position.
  const steps: Step[] = [
    { key: `${issue}:ready:0`, state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    {
      key: `${issue}:specify:0`,
      state: "specify",
      startedAt: 2,
      outcome: {
        kind: "ok",
        frozen,
        tests: { AC1: ["tests/AC1-retry.test.sh"] },
      },
    },
    { key: `${issue}:build:0`, state: "build", startedAt: 3, outcome: { kind: "ok" } },
    { key: `${issue}:challenge:0`, state: "challenge", startedAt: 4 },
  ];
  // The counters are the table's answer, not the fixture's guess: `foldLog`
  // replays the log through `next()`, so the position this run carries is the
  // one a real drive reached by routing `build:ok` -> `challenge:none` ->
  // `build:ok` -> here. A hand-carried counter is a fixture that can drift from
  // the table it is supposed to be standing in.
  const counters = foldLog({ ...built.ctx.run, steps }).pos.counters;
  const ctx: HandlerCtx = {
    repoRoot: built.repoRoot,
    issue,
    run: { ...built.ctx.run, issue, steps, counters },
    steps,
    stepKey: `${issue}:challenge:0`,
    now: () => 7,
  };
  return { ...built, buildSha, ctx };
}

/** A test the adversary wrote that FAILS against the current head. */
export function redEdge(rel: string): string {
  return [
    "#!/bin/sh",
    `echo "not ok - ${rel}" 1>&2`,
    'echo "assertion failed: retry gave up on the second transient failure" 1>&2',
    "exit 1",
    "",
  ].join("\n");
}

/** A test the adversary wrote that PASSES against the current head. */
export function greenEdge(rel: string): string {
  return ["#!/bin/sh", `echo "ok - ${rel}"`, "exit 0", ""].join("\n");
}

/** The child declared these files for this criterion. */
export function submit(criterionId: string, testFiles: string[]): unknown {
  return { name: "submit_tests", arguments: { criterionId, testFiles } };
}

export interface RunResult {
  outcome?: Outcome;
  threw?: Error;
  dispatched: number;
  prompts: string[];
  specs: DispatchSpec[];
  worktree: string;
  headBefore: string;
  /** argv of every git call the step made, for the hook-guard canary. */
  gitArgvs: string[][];
}

export interface RunOpts {
  issue: number;
  /** The adversary's acts in the worktree, at the moment it is still working. */
  child?: (wt: string) => void;
  /** The `submit_tests` calls; a function is called at the instant of declaring. */
  toolUses?: unknown[] | (() => unknown[]);
  /** Override the config handed to the step. */
  config?: WorkConfig;
  /** A config with no runner template configured. */
  noRunner?: boolean;
  /** A config whose runner names an executable that cannot be started. */
  runner?: string;
  /** The issue body the step re-reads; defaults to `SPEC_BODY` (one test criterion). */
  specBody?: string;
  /**
   * Extra paths to add to the frozen contract this case is shown, so the step
   * checks them and refuses a submission that names one. The file is committed
   * into the fixture's build commit and its sha256 goes in the step log, so the
   * frozen-intact precondition reads a real blob and agrees.
   */
  extraFrozen?: Record<string, string>;
  /**
   * Run this case in ANOTHER issue's worktree, keeping its own step log keys
   * and commit subject. Two runs against one repo fight over the same tree, so
   * a pair of cases that differ only in what the child did splits on the tree
   * and not on the issue the step reports.
   */
  worktreeIssue?: number;
  /** Per-run runner limits — a short timeout proves a hang is infra. */
  testLimits?: { timeoutMs?: number };
  /** A child whose dispatch did not succeed (the infra case). */
  dispatchOk?: boolean;
  /** A pre-built fixture, for a case that dismantles the tree first. */
  built?: ChallengeBuilt;
  /** A step log to use instead of the one the fixture builds. */
  extraSteps?: Step[];
}

/** Run the step against a fresh fixture; a throw comes back as the error. */
export async function runChallenge(opts: RunOpts): Promise<RunResult> {
  const built =
    opts.built ??
    challengeFixture(opts.issue, {
      ...(opts.extraFrozen === undefined ? {} : { extraFrozen: opts.extraFrozen }),
      ...(opts.worktreeIssue === undefined ? {} : { worktreeIssue: opts.worktreeIssue }),
    });
  let ctx = built.ctx;
  if (opts.extraSteps !== undefined) {
    ctx = {
      ...built.ctx,
      run: { ...built.ctx.run, steps: opts.extraSteps },
      steps: opts.extraSteps,
    };
  }
  const prompts: string[] = [];
  const specs: DispatchSpec[] = [];
  const gitArgvs: string[][] = [];
  let dispatched = 0;
  const exec: ChallengeDeps["exec"] = async (cmd, o) => {
    if (cmd === "git" && o?.argv) gitArgvs.push(o.argv);
    return execp(cmd, { ...o, env: gitEnvFor() });
  };
  const dispatch: ChallengeDeps["dispatch"] = async (spec: DispatchSpec) => {
    dispatched++;
    specs.push(spec);
    prompts.push(spec.prompt);
    opts.child?.(spec.cwd as string);
    const declared =
      typeof opts.toolUses === "function" ? opts.toolUses() : [...(opts.toolUses ?? [])];
    const result: DispatchResult = {
      role: spec.role,
      ok: opts.dispatchOk !== false,
      text: "found an edge case",
      toolUses: declared,
      ms: 1,
      exitCode: opts.dispatchOk === false ? 1 : 0,
    };
    return result;
  };
  const deps: ChallengeDeps = {
    exec,
    dispatch,
    fetchIssueBody: async () => opts.specBody ?? SPEC_BODY,
    loadConfig: async () => {
      if (opts.noRunner === true) return { ...configWith(), verify: { fast: "true" } };
      if (opts.runner !== undefined) return configWithRunner(opts.runner);
      return opts.config ?? configWith();
    },
    ...(opts.testLimits === undefined ? {} : { testLimits: opts.testLimits }),
    statReporter: async () => ({}),
  };
  try {
    const { challengeOutcome } = await import("../../src/lean/challenge.ts");
    const outcome = await challengeOutcome(ctx, deps);
    return {
      outcome,
      dispatched,
      prompts,
      specs,
      worktree: built.worktree,
      headBefore: built.buildSha,
      gitArgvs,
    };
  } catch (err) {
    return {
      threw: err as Error,
      dispatched,
      prompts,
      specs,
      worktree: built.worktree,
      headBefore: built.buildSha,
      gitArgvs,
    };
  }
}

/** A config carrying the project's test runner template. */
export function configWith(runner: string = RUNNER): WorkConfig {
  return { ...defaultConfig(), verify: { fast: "true", test: runner } };
}

/**
 * The same config under another runner. Named apart from `configWith` so a
 * case that swaps ONLY the runner does not also have to restate the fast tier.
 */
export function configWithRunner(runner: string): WorkConfig {
  return configWith(runner);
}

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
