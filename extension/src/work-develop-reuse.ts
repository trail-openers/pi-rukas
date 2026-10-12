/**
 * work-develop-reuse — #1016: may a persisted dependent worktree be reused?
 *
 * A resumed dependent keeps its existing worktree instead of creating a new one.
 * That worktree was built on the base the dependency had when it was created. If
 * the dependency's resolved base is no longer an ancestor of the worktree's HEAD
 * (the dependency was rebased, or the state points at an unrelated tree), the
 * reused tree is built on the wrong history, so the reuse is refused. The check is
 * an argv git call; any failure, including "not an ancestor", refuses (fail closed).
 */
import { type ExecFn, errText, isValidBaseSha, runGit } from "./work-develop-git.ts";

/** A named refusal reason, or undefined when the worktree may be reused. */
export async function reuseRefusal(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
): Promise<string | undefined> {
  if (!isValidBaseSha(base)) {
    return "reused dependent worktree refused — its resolved base is not a 40-hex sha";
  }
  try {
    await runGit(execFn)(["merge-base", "--is-ancestor", base, "HEAD"], {
      cwd,
      maxBuffer: 64 * 1024,
    });
    return undefined;
  } catch (err) {
    return `reused dependent worktree refused — its HEAD does not contain the resolved base ${base.slice(0, 12)} — ${errText(err)}`;
  }
}
