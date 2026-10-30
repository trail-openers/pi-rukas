/**
 * lib/lean-specify-fixture — the temp-git-repo harness the `lean/specify`
 * smoke tests share.
 *
 * The step's claims are git claims ("this file is the only thing that
 * changed", "this commit contains exactly these tests"), so a stub exec would
 * test the stub. Here the repo, the base commit and the worktree are real,
 * `exec` shells out to the real `execp`, and only the model is a stub: the
 * fake dispatch writes files into the worktree and returns the `submit_tests`
 * tool calls the child would have made.
 *
 * Three hooks place the child's writes at the moments that matter, because
 * "the step does not care what the tree holds later" is only testable if a
 * test can make the tree hold something later:
 *
 *   - `writes` — the child's work, at the point it is still working;
 *   - `toolUses` — the declaration; a FUNCTION is called at the instant the
 *     child submits, so a case can submit content it then overwrites;
 *   - `afterCapture` — the child's write in the one window that matters: after
 *     the step has read the submitted bytes into memory and before it resets
 *     the tree (case (m)).
 *
 * Split from test-lean-specify.ts for the AGENTS.md §12 line cap.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { type CaptureResult, captureTestBytes } from "../../src/lean/specify-capture.ts";
import { parsePorcelainZ } from "../../src/lean/specify-tree.ts";
import { type SpecifyDeps, SpecifyInfraError } from "../../src/lean/specify.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import { gitTestEnv } from "./git-test-env.ts";
export { put } from "./lean-build-fixture.ts";
import { put } from "./lean-build-fixture.ts";

/** Temp dirs this module made; the caller removes them at the end of the run. */
export const ROOTS: string[] = [];

/**
 * The identity every git child of this test runs with.
 *
 * Set in the ENVIRONMENT rather than with `-c` on the fixture's own calls,
 * because the commit under test is made by the PRODUCTION step (`git commit`
 * through the injected exec), which takes no flags from here — and a CI
 * container with no global identity would fail exactly that commit while the
 * fixture's own commits went through. `gitTestEnv()` supplies the isolated
 * HOME, so the host's gitconfig is not what fills these in.
 */
function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** git in `dir`, with an identity in the child's environment. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** A repo whose single commit contains `files`; returns its root and base sha. */
export function makeRepo(files: Record<string, string>): {
  repoRoot: string;
  baseSha: string;
} {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-specify-"));
  ROOTS.push(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) put(repoRoot, rel, content);
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  return { repoRoot, baseSha: git(repoRoot, "rev-parse", "HEAD") };
}

/** A second temp dir for files that must live OUTSIDE the worktree. */
export function outsideDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-outside-"));
  ROOTS.push(dir);
  return dir;
}

const SPEC = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S" as const,
  criteria: [
    {
      id: "AC1",
      text: "retries a transient failure twice before failing",
      verify: "test" as const,
    },
    { id: "AC2", text: "documents the retry budget", verify: "manual" as const },
  ],
};

const BODY = `\`\`\`pi-spec v1\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``;

/**
 * A spec with TWO `verify: "test"` criteria.
 *
 * `SPEC` has one test criterion and one manual one, so with it "every criterion
 * is covered" and "at least one file is red" are the same question — which is
 * exactly why the per-caller coverage rule went unnoticed. This body is what
 * separates them: a run that is red for AC1 and green for AC2 is a refusal
 * under `specify`'s `"all-criteria"` and a freeze under `challenge`'s `"any-red"`.
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

export function configWith(verify: WorkConfig["verify"]): WorkConfig {
  return { ...defaultConfig(), verify };
}

function ctxFor(repoRoot: string, baseSha: string, issue: number): HandlerCtx {
  const run = createRun({ issue, version: "test", models: {}, baseSha, branch: "" });
  return { repoRoot, issue, run, steps: run.steps, stepKey: `${issue}:specify:0`, now: () => 1 };
}

function okResult(toolUses: unknown[]): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses, ms: 1, exitCode: 0 };
}

export function submit(criterionId: string, testFiles: string[]): unknown {
  return { name: "submit_tests", arguments: { criterionId, testFiles } };
}

/** Every path the worktree reports against its base. */
export async function worktreePaths(wt: string): Promise<string[]> {
  const { stdout } = await execp("git", {
    argv: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: wt,
  });
  return parsePorcelainZ(stdout).map((e) => e.path);
}

export interface RunResult {
  outcome?: Outcome;
  threw?: Error;
  sawBaseHealthy: boolean;
  dispatched: number;
  worktree: string;
}

export interface RunOpts {
  repoRoot: string;
  baseSha: string;
  issue: number;
  config: WorkConfig;
  /** The child's work, while it is still working. */
  writes: (wt: string) => void;
  /** The child's `submit_tests` calls — a list, or one built at the declaration. */
  toolUses: unknown[] | (() => unknown[]);
  /** The child's write after its dispatch returns, before the step reads anything. */
  afterSubmit?: (wt: string) => void;
  /**
   * The child's write in the one window that matters: AFTER the step has read
   * the submitted bytes into memory and BEFORE it resets the tree.
   */
  afterCapture?: (wt: string) => void;
  /**
   * A capture that runs a write of the case's own BEFORE the real read — the
   * window between validation and capture, where a link swapped in after the
   * `lstat` has to be caught by the pinned descriptor.
   */
  capture?: (wt: string, paths: string[], owners: Map<string, string>) => CaptureResult;
  /** Per-run runner limits, e.g. a short timeout to prove a hang is infra. */
  testLimits?: { timeoutMs?: number };
  /** The issue body the step re-reads; defaults to the single-test-criterion spec. */
  specBody?: string;
  /**
   * Where the fake child records the kickoff prompt the STEP built. The prompt
   * is production text, so this is the only way a case asserts what the
   * adversary was actually told (e.g. that its tests must go in the folder
   * `.pi/work.json` names).
   */
  prompts?: string[];
  dispatchOk?: boolean;
  /**
   * Turns the fake child reports to the budget hook it was handed, on every
   * dispatch. Past the step's `turns` ceiling this is a child the budget ends.
   */
  progressTurns?: number;
}

/** Run the step; a throw comes back as the error, so each case asserts on it. */
export async function runSpecify(opts: RunOpts): Promise<RunResult> {
  const issue = opts.issue;
  let sawBaseHealthy = false;
  let dispatched = 0;
  const exec: SpecifyDeps["exec"] = async (cmd, o) => {
    if (cmd === opts.config.verify.fast) sawBaseHealthy = true;
    // The identity is in the env for EVERY exec, including the production
    // commit the step makes — that commit is the thing under test.
    return execp(cmd, { ...o, env: { ...gitEnv(), ...(o?.env ?? {}) } });
  };
  const dispatch: SpecifyDeps["dispatch"] = async (spec: DispatchSpec, dopts) => {
    dispatched++;
    opts.prompts?.push(spec.prompt);
    const wt = spec.cwd as string;
    opts.writes(wt);
    if (opts.progressTurns !== undefined)
      dopts.onProgress?.({
        role: "developer",
        turns: opts.progressTurns,
        toolUses: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        totalTokens: 0,
        elapsedMs: 0,
        done: false,
      });
    // The child's worktree state at the moment its `submit_tests` calls are
    // made. Everything after this line is what the child leaves behind, and the
    // step must not be able to be moved by it.
    const declared = typeof opts.toolUses === "function" ? opts.toolUses() : [...opts.toolUses];
    opts.afterSubmit?.(wt);
    return opts.dispatchOk === false
      ? { ...okResult(declared), ok: false, exitCode: 1 }
      : okResult(declared);
  };
  const deps: SpecifyDeps = {
    exec,
    dispatch,
    // The one write that can be made between the step reading the submitted
    // bytes and it resetting the tree — the window a child has to swap a test
    // after the parent already holds it. Nothing downstream re-reads the disk,
    // so what a case commits and hashes must be the captured bytes.
    capture:
      opts.capture ??
      ((wt, paths, owners) => {
        const got = captureTestBytes(wt, paths, owners);
        opts.afterCapture?.(wt);
        return got;
      }),
    ...(opts.testLimits === undefined ? {} : { testLimits: opts.testLimits }),
    fetchIssueBody: async () => opts.specBody ?? BODY,
    loadConfig: async () => opts.config,
    statReporter: async () => ({}),
  };
  const worktree = path.join(opts.repoRoot, ".worktrees", `lean-${issue}`);
  try {
    const specify = await import("../../src/lean/specify.ts");
    const outcome = await specify.specifyOutcome(ctxFor(opts.repoRoot, opts.baseSha, issue), deps);
    return { outcome, sawBaseHealthy, dispatched, worktree };
  } catch (err) {
    return { threw: err as Error, sawBaseHealthy, dispatched, worktree };
  }
}

/** The per-file runner template every case that runs a test uses. */
export const RUNNER = "sh {file}";

/**
 * A test file that fails for the behaviour the criterion states, and whose
 * output names the FILE — which is what the step's `red` classification asks
 * for ("non-zero AND the output named this file"). A real runner prints the
 * file it is reporting on; a bare `echo` of a message that happens to contain
 * the basename would satisfy the check for the wrong reason, so this asserts
 * on the mechanism instead: the runner's own line for the file.
 */
export function redScript(): string {
  return [
    "#!/bin/sh",
    'echo "not ok - $(basename "$0")" 1>&2',
    'echo "assertion failed: retry gave up on the first transient failure" 1>&2',
    "exit 1",
    "",
  ].join("\n");
}

/** A test the runner reports as PASSING — the file a coverage gap is made of. */
export function greenScript(): string {
  return ["#!/bin/sh", 'echo "ok - $(basename "$0")"', "exit 0", ""].join("\n");
}

/** The sha256 of a string's bytes, the way the freeze records them. */
export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export { SpecifyInfraError };
