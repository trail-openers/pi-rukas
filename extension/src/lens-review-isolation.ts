/**
 * lens-review-isolation — where a lens review batch's children run (#1975).
 *
 * Split from `lens-review.ts` (AGENTS.md §12, the 500-line gate). The fan-out
 * owns WHEN the tree exists — opened before the first lens spawn, released once
 * every child has returned and before the ledger write. This module owns the one
 * decision the fan-out should not re-derive: which head the throwaway tree is
 * detached at, and what a child gets when no tree could be made.
 *
 * The head is the SHA the run already resolved (#1039), never a ref: a lens must
 * read the commit its diff was computed from, and `HEAD` would answer with
 * whatever the reviewed tree holds at the moment of the creation. When no SHA
 * resolved, or the tree could not be created, every child runs in `reviewedCwd`
 * exactly as before this mechanism and the reason is disclosed — a review is
 * never lost to git plumbing (the same fail-open rule as `plan-base-tree.ts`).
 */

import { execp } from "./exec.ts";
import type { LensRunResult } from "./lens-review-types.ts";
import { withLensModelSlot } from "./lens-model-slots.ts";
import { openReviewerTree } from "./reviewer-tree.ts";
import { trace } from "./trace.ts";

/** What {@link openLensReviewerTree} decided, and how the fan-out uses it. */
export interface LensIsolation {
  /** The cwd to dispatch lens children with; `undefined` for the reviewed tree. */
  childCwd: string | undefined;
  /** Why there is no isolated tree, when there is none (for the caller to record). */
  fallback?: string;
  /** Remove the tree. Best-effort, never throws, safe when there is none. */
  release: () => Promise<void>;
}

/** An empty roster spawns nothing, so no tree is worth creating. */
export const NO_LENS_TREE: LensIsolation = {
  childCwd: undefined,
  release: async () => undefined,
};

/**
 * Open the one throwaway tree this lens batch spawns its children in.
 *
 * `headSha` is the run's resolved head; `undefined` (an unresolvable ref, a
 * blocked or carried review) means no tree, and the children run in
 * `reviewedCwd`. Six lens children share this one tree: one `worktree add` and
 * one provisioning per round, not six, and one removal on every exit path.
 */
export async function openLensReviewerTree(
  reviewedCwd: string,
  headSha: string | undefined,
  spawnCount: number,
): Promise<LensIsolation> {
  if (spawnCount === 0 || headSha === undefined) return NO_LENS_TREE;
  const tree = await openReviewerTree(execp, reviewedCwd, headSha);
  if (!tree.cwd) return { childCwd: undefined, fallback: tree.fallback, release: async () => undefined };
  const childCwd = tree.cwd;
  trace(`lens-review: ${spawnCount} lens children run in ${childCwd} at ${headSha.slice(0, 12)}`);
  return { childCwd, release: () => tree.release?.() ?? Promise.resolve() };
}

/** The per-lens spawner, as `lens-review.ts` resolves it (real or test stub). */
type LensChildFn = typeof import("./lens-review-child.ts").runLensChild;

/** Everything the fan-out threads to each child, supplied by the caller. */
export interface LensFanOutInput {
  lensChildFn: LensChildFn;
  runId: string;
  skillsDir: string;
  context: string;
  roster: Parameters<LensChildFn>[0]["roster"];
  /** The run's own options, spread onto each child's — `diff`/`childCwd`/
   * `priorFindings` are written by the fan-out, so the caller's copies of
   * those three are the caller's to supply or omit. */
  opts: Omit<Parameters<LensChildFn>[0]["opts"], "diff" | "childCwd" | "priorFindings"> &
    Partial<Pick<Parameters<LensChildFn>[0]["opts"], "diff" | "childCwd">> & {
      pi?: Parameters<LensChildFn>[0]["pi"];
    };
  diff: string;
  priorFindings: string | undefined;
  bumpBatch: () => void;
}

/**
 * Fan the healthy roster out over the isolated tree and release it.
 *
 * The whole batch shares ONE tree (one `git worktree add`, one provisioning, not
 * six), and the tree is gone before the caller's ledger write and findings pass
 * — both of which read the reviewed tree. The tree is released even when a child
 * throws, which is the leak path a per-child owner could not cover.
 */
export async function runLensFanOut(
  input: LensFanOutInput,
  headSha: string | undefined,
): Promise<{ value: LensRunResult[]; fallback?: string }> {
  const { lensChildFn, runId, skillsDir, context, roster, opts, diff, priorFindings, bumpBatch } =
    input;
  const healthy = roster.filter((entry) => entry.error === undefined);
  const tree = await openLensReviewerTree(opts.cwd ?? process.cwd(), headSha, healthy.length);
  try {
    const value = await Promise.all(
      healthy.map((lens) =>
        withLensModelSlot(
          lens.name,
          () =>
            lensChildFn({
              lens,
              runId,
              skillsDir,
              context,
              roster,
              opts: { ...opts, diff, priorFindings, childCwd: tree.childCwd },
              bumpBatch,
              ...(opts.pi ? { pi: opts.pi } : {}),
            }),
          opts.signal,
        ),
      ),
    );
    return { value, ...(tree.fallback ? { fallback: tree.fallback } : {}) };
  } finally {
    await tree.release();
  }
}
