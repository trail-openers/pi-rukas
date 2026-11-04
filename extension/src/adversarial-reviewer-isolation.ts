/**
 * adversarial-reviewer-isolation — where the adversarial loop's REVIEWER child
 * runs, and what it is isolated from (#1975).
 *
 * Split from `adversarial.ts` (AGENTS.md §12, the 500-line gate). The loop owns
 * WHEN the tree exists — created before the first reviewer spawn, released in
 * the `finally` that closes the round loop, so a spawn throw, an abort and a cap
 * kill all release it. This module owns the two decisions the loop should not
 * re-derive: which commit the throwaway tree is detached at, and what a child's
 * cwd becomes when no tree could be made.
 *
 * The head is a resolved SHA before any spawn, never a ref: a reviewer must read
 * the commit the diff names, and `HEAD` would answer with whatever the reviewed
 * tree holds at the moment of the creation. An unresolvable head yields no tree
 * at all — the reviewer runs in the reviewed tree and says so — rather than a
 * tree at a commit somebody guessed at.
 */

import type { AdversarialLoopParams } from "./adversarial-loop-params.ts";
import { execp } from "./exec.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import { type ReviewerTree, openReviewerTree } from "./reviewer-tree.ts";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/** What {@link openAdversarialReviewerTree} decided, and how to use it. */
export interface ReviewerIsolation {
  /** The cwd to dispatch a REVIEWER child with; `undefined` for the reviewed tree. */
  cwd: () => string | undefined;
  /** Why there is no isolated tree, when there is none. */
  fallback?: string;
  /** The 40-char head the tree was created at, when one was created. */
  headSha?: string;
  /**
   * Remove the tree when `fn` ends, whichever way it ends, and hand back
   * `fn`'s own value — or `undefined` when `fn` returned by breaking out of
   * the loop rather than answering. A `Promise<T | undefined>` is what lets the
   * loop keep its own exhausted-rounds tail below the wrapper.
   */
  withRelease: <T>(fn: () => Promise<T | undefined>) => Promise<T | undefined>;
  /** Remove the tree. Best-effort, never throws, safe when there is none. */
  release: () => Promise<void>;
}

/**
 * Resolve the reviewed head and open this loop's throwaway reviewer tree.
 *
 * `params.workCwd` is what a reviewer gets when no tree exists — the reviewed
 * worktree, exactly as before this mechanism. The fix pass is not this function's
 * concern: it keeps the real worktree, because its work has to land. Takes the
 * three loop fields it reads rather than the whole params bag, so the loop's call
 * site stays one line at the 500-line gate.
 */
/**
 * Run the adversarial round loop with its reviewer children in one throwaway
 * tree. The tree is created before the first spawn and removed on every exit of
 * `run`, throw or abort included — which is the whole reason the loop is handed
 * to a function rather than wrapped inline: the 500-line gate has no room for a
 * closure around the loop body. `run` returns `undefined` when the loop fell out
 * of its own tail, so the caller keeps that case and runs its exhausted-rounds
 * result below.
 */
export async function runReviewerRounds<T>(
  params: Pick<AdversarialLoopParams, "workCwd" | "head" | "commentExecFn">,
  run: (reviewerCwd: string | undefined) => Promise<T | undefined>,
): Promise<T | undefined> {
  const isolation = await openAdversarialReviewerTree(params);
  try {
    return await run(isolation.cwd());
  } finally {
    await isolation.release();
  }
}

export async function openAdversarialReviewerTree(
  params: Pick<AdversarialLoopParams, "workCwd" | "head" | "commentExecFn">,
): Promise<ReviewerIsolation> {
  const fallbackCwd = params.workCwd;
  const headRef = params.head;
  const execFn = params.commentExecFn;
  const none = (fallback: string): ReviewerIsolation => ({
    cwd: () => fallbackCwd,
    fallback,
    withRelease: async (fn) => fn(),
    release: async () => undefined,
  });
  if (fallbackCwd === undefined) return none("no workCwd: the reviewer runs where the loop runs");
  const headSha = await resolveHeadSha(fallbackCwd, headRef ?? "HEAD", execFn ?? execp);
  if (headSha === undefined) {
    return none(
      `reviewed head ${JSON.stringify((headRef ?? "HEAD").slice(0, 40))} did not resolve to a SHA`,
    );
  }
  const tree: ReviewerTree = await openReviewerTree(execp, fallbackCwd, headSha);
  if (!tree.cwd) return none(tree.fallback ?? "the reviewer tree could not be created");
  const cwd = tree.cwd;
  trace(`adversarial: reviewer children run in ${cwd} at ${headSha.slice(0, 12)}`);
  return {
    cwd: () => cwd,
    headSha,
    withRelease: async (fn) => {
      try {
        return await fn();
      } finally {
        await tree.release?.();
      }
    },
    release: () => tree.release?.() ?? Promise.resolve(),
  };
}
