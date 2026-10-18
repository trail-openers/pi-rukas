/**
 * The verify-command fixtures shared by the #1240 duplicate-verify tests.
 *
 * The rule under test decides whether the project's verify command runs, so
 * each test must observe exactly one thing: **did the command execute, and
 * where.** Counting through the filesystem would perturb the tree being
 * hashed (an untracked counter file is invisible to `git write-tree`, which is
 * why the original harness could use one — but the in-memory counter below is
 * the version that cannot go wrong), so the executor is the counter.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { initialState } from "../../src/workflow-state.ts";

const execFileP = promisify(execFile);

/** A counted verify invocation: where the project's command ran. */
export type Runs = Array<{ cwd: string }>;

/**
 * The per-case executor bookkeeping: counted verify runs plus the repoRoot a
 * `breakAtRepoRoot` predicate applies to. Declared ONCE here because both
 * #1240 tests build the same value for the same executor factory.
 */
export interface Counts {
  runs: Runs;
  repoRoot: string;
}

/** The verify command: append one line to a counter in the cwd, then pass or
 * fail per `opts.fail`. The harness counts runs in the executor, not by
 * reading the counter, so a counted run never touches the tree being hashed. */
export function installVerifyCmd(repo: string, markerFile: string, opts: { fail?: boolean } = {}) {
  const cmd = `sh -c 'echo run >> ${markerFile}${opts.fail ? "; exit 1" : ""}'`;
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), `${cmd}\n`);
  return cmd;
}

/**
 * The executor: real git, but a verify-command run is counted and replaced by
 * a canned outcome (`fail` reproduces the command's own exit-1 branch without
 * executing it). The counter lives in-memory so a counted run cannot disturb
 * tree identity. `onRun` lets a test observe state at the moment a run
 * starts. `breakAtRepoRoot` makes selected git reads at repoRoot throw
 * — the identity-read failure case.
 */
export function makeExec(
  counts: Counts,
  opts: {
    fail?: boolean;
    breakAtRepoRoot?: (cmd: string) => boolean;
    /** Called as each verify run is counted, before its outcome. */
    onRun?: () => void;
  } = {},
): NonNullable<DriverContext["verifyExecFn"]> {
  return async (cmd, o) => {
    if (cmd.startsWith("sh -c 'echo run >>")) {
      counts.runs.push({ cwd: o?.cwd ?? "?" });
      opts.onRun?.();
      if (opts.fail) {
        throw Object.assign(new Error("verify command exited non-zero"), {
          stdout: "",
          stderr: "✗ verify asserted\n",
        });
      }
      return { stdout: "" };
    }
    if (o?.cwd === counts.repoRoot && opts.breakAtRepoRoot?.(cmd) === true) {
      throw new Error("simulated git read failure");
    }
    try {
      const opts2 = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
      const { stdout } = o?.argv
        ? await execFileP(cmd, o.argv, opts2)
        : await execFileP("/bin/sh", ["-c", cmd], opts2);
      return { stdout };
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      e.stdout = e.stdout ?? "";
      e.stderr = e.stderr ?? (err as unknown as { stderr?: string }).stderr ?? "";
      throw e;
    }
  };
}

/** At least one counted verify run happened at `cwd`. */
export function ranAt(runs: Runs, cwd: string): boolean {
  return runs.some((r) => path.resolve(r.cwd) === path.resolve(cwd));
}

/** A driver state carrying the cycle's base and worktree map. */
export function stateFor(f: { baseSha: string; worktrees: Record<string, string> }, issue: number) {
  let s = initialState(issue, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      branchName: `feature/issue-${issue}`,
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      workstreams: Object.fromEntries(
        Object.keys(f.worktrees).map((id) => [
          id,
          { id, scope: `scope ${id}`, paths: [], outOfScope: [] },
        ]),
      ),
    },
  };
  return s;
}

/** A DriverContext carrying the injected verify executor. */
export function ctxFor(
  repo: string,
  issue: number,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
) {
  return {
    host: { sendUserMessage: () => {} } as never,
    repoRoot: repo,
    issue,
    verifyExecFn: execFn,
  } as unknown as DriverContext;
}
