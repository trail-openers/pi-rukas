/**
 * develop-unfinished-fixture — the git fixtures the #1768 tests share
 * (`test-develop-unfinished.ts` for the rule and the attribution,
 * `test-develop-unfinished-attribution.ts` for the round, the park and the
 * registries).
 *
 * These are the real thing on purpose: a fake that resolved every git call
 * successfully turns `git rev-parse -q --verify MERGE_HEAD` into "a merge is in
 * progress" and makes the #622 safety net skip for a reason that has nothing to
 * do with the product, and a commit helper that staged one file instead of the
 * tree leaves a removed sibling in the index, so the tree reads "clean" for the
 * wrong reason and the net finds nothing to commit. Both are test bugs that
 * look like passing assertions about the product.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type WorkState, appendEvent, initialState } from "../../src/workflow-state.ts";

const execFileP = promisify(execFile);

/** Print a check the way every smoke test in this directory prints one; returns
 *  the caller's exit code so each file ends on one verdict of its own. */
export function makeAssert(): {
  assert: (cond: boolean, msg: string) => void;
  failed: () => boolean;
} {
  let failed = false;
  return {
    assert(cond, msg) {
      if (cond) console.log(`✓ ${msg}`);
      else {
        console.error(`✗ ${msg}`);
        failed = true;
      }
    },
    failed: () => failed,
  };
}

/** A `DriverExecFn` fake over the real git binary, matching what `execp` does
 *  with the argv form (`execFile(cmd, argv, …)` — the array goes to git as-is,
 *  so a commit message with spaces survives without shell quoting) and
 *  PROPAGATING the exit status (see the module header). */
export function gitExec(defaultCwd: string) {
  return (cmd: string, opts?: { cwd?: string; argv?: string[] }): Promise<{ stdout: string }> =>
    execFileP(cmd, opts?.argv ?? [], {
      cwd: opts?.cwd ?? defaultCwd,
    }).then((r) => ({ stdout: r.stdout }));
}

/** The raw `execFile` promise, for the fixtures that run git outside the
 *  driver's executor (repo setup, and the child-style commits the safety-net
 *  cases stage by hand). */
export { execFileP };

/** A git repo with a base commit and one detached worktree (same shape as
 *  test-develop-safety-net.ts — it must be the real one here). */
export async function mkRepo(): Promise<{ root: string; wt: string; baseSha: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "dev-unfinished-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await execFileP("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileP("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  await execFileP("git", ["-C", repo, "add", "base.txt"]);
  await execFileP("git", ["-C", repo, "commit", "-q", "-m", "base"]);
  const { stdout } = await execFileP("git", ["-C", repo, "rev-parse", "HEAD"]);
  const baseSha = stdout.trim();
  const wt = path.join(root, ".worktrees", "wt");
  await execFileP("git", ["-C", repo, "worktree", "add", "-q", "--detach", wt, "HEAD"]);
  return { root, wt, baseSha };
}

/** A child-style commit: `git add -A` then commit, as the developer prompt
 *  instructs (see the module header for why the whole tree is staged). */
export async function commit(wt: string, file: string, subject: string): Promise<void> {
  writeFileSync(path.join(wt, file), `${subject}\n`);
  await execFileP("git", ["-C", wt, "add", "-A"]);
  await execFileP("git", ["-C", wt, "commit", "-q", "-m", subject]);
}

/** The shape `classifyDevelopPass` is called with on a child-reported green —
 *  the incident's own words, so a regression that reads the narration instead
 *  of the tree still fails. */
export function greenResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    text: "agent done: developer",
    stopReason: "endTurn",
    ...overrides,
  } as never;
}

/** A develop-step state carrying `events`, for the park and renderer cases. */
export function stateWith(issue: number, events: WorkState["eventLog"]): WorkState {
  let s = initialState(issue, Date.now());
  s = { ...s, pipelineState: { ...s.pipelineState, currentStep: "develop" } };
  for (const e of events) s = appendEvent(s, e);
  return s;
}
