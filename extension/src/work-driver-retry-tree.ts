/**
 * work-driver-retry-tree — the retry's working tree, accounted for.
 *
 * #1391. A step child that dies mid-edit leaves its files in the worktree, and
 * the transient retry dispatches a fresh child into that same tree. For
 * `lens-fix` the next thing to read those files was the reposition guard, which
 * had no way to tell "the operator edited this" from "the child the driver just
 * lost wrote this" — so it parked the cycle (nessie #109: round 3 of 3, one
 * second long). The router asks this module two questions and gets a verdict
 * with a location attached: which tree is the retry dispatching into, and where
 * the copy of what it found there lives.
 *
 * The CLEAN itself is task-b's `worktree-retry-clean.ts` (composing the existing
 * save/reset primitives). It is reached through the seam below rather than a
 * direct import, for two reasons: it lands on a sibling branch, and the router
 * must not become the place that decides whether a developer's uncommitted work
 * is safe to move. Until the seam is filled the router behaves exactly as it did
 * before — no tree accounted for, nothing touched.
 */

import type { CycleContext } from "./work-driver-context.ts";
import { WORKTREE_EDITING_STEPS } from "./work-driver-retry-context.ts";
import type { RetryTreeAccounting } from "./workflow-state-schema-retry-tree.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

/**
 * The seam task-b implements: read the tree, save what it holds, clear it, and
 * report what was there. It is called BEFORE the retry line is composed and
 * before anything moves, and what it returns is what the operator sees — the
 * pre-clean reading, because a post-clean read always says "clean".
 *
 * A step whose work is not files (`WORKTREE_EDITING_STEPS`) is never offered.
 */
export type RetryTreeCleaner = (args: {
  ctx: CycleContext;
  state: WorkState;
  step: WorkStep;
  /** The tree the retried child is about to be dispatched into. */
  tree: string;
  /** Where the pre-clean copy goes (scratch dir, never the repo root). */
  patchPath: string;
}) => Promise<RetryTreeAccounting | undefined>;

let cleaner: RetryTreeCleaner | undefined;

/** Test/feature seam. Returns a restore function. */
export function __setRetryTreeCleaner(fn: RetryTreeCleaner | undefined): () => void {
  const prev = cleaner;
  cleaner = fn;
  return () => {
    cleaner = prev;
  };
}

/** True when a retry of this step has a cleaner installed to run. */
export function retryTreeCleanerInstalled(): boolean {
  return cleaner !== undefined;
}

/**
 * The tree a retried file-editing step dispatches into, or undefined.
 *
 * `lens-fix` works in `lensWorktree`'s tree — `default`, else the first entry —
 * because the review and the fix must agree on one tree (the #663 defect was
 * them disagreeing). `develop` keys on the retried workstream, which for the
 * single-workstream shape that reaches this router is `default`.
 *
 * repoRoot is never returned: it is the integration point, and the gate that
 * clears a dirty root is the branch step's, which refuses on purpose.
 */
export function retryTreeOf(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
): string | undefined {
  if (!WORKTREE_EDITING_STEPS.includes(step)) return undefined;
  const wts = state.pipelineState.worktrees ?? {};
  const first = wts[Object.keys(wts)[0] ?? ""];
  const candidate = step === "lens-fix" ? (wts.default ?? first) : (wts.default ?? first);
  return candidate && candidate !== ctx.repoRoot ? candidate : undefined;
}

/**
 * Where the pre-clean copy of a lost attempt's work goes.
 *
 * Never the repo root and never a tracked directory: this is an ephemeral
 * artefact describing a half-written change, and #109's was a scratch diff
 * nobody opened. The directory is overridable for hosts that keep scratch
 * elsewhere; the default is host-level `/tmp`, outside any repository.
 */
export function retryPatchPathFor(ctx: CycleContext, step: WorkStep, attempt: number): string {
  const dir = process.env.PI_ENSEMBLE_RETRY_TREE_DIR ?? `/tmp/pi-rukas/issue-${ctx.issue}`;
  return `${dir}/retry-${step}-${attempt}.patch`;
}

/**
 * The router's one call: decide the tree, run the cleaner, return the account.
 * Returns undefined (behaviour unchanged from before #1391) when the step does
 * not edit files, no tree is recorded, or no cleaner is wired.
 */
export function retryTreeAccount(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
  attempt: number,
): Promise<RetryTreeAccounting | undefined> {
  const tree = retryTreeOf(ctx, state, step);
  if (!tree) return Promise.resolve(undefined);
  return cleanRetryTree({
    ctx,
    state,
    step,
    tree,
    patchPath: retryPatchPathFor(ctx, step, attempt),
  });
}

/** Run the installed cleaner for this retry, or undefined when none is wired. */
export async function cleanRetryTree(args: {
  ctx: CycleContext;
  state: WorkState;
  step: WorkStep;
  tree: string;
  patchPath: string;
}): Promise<RetryTreeAccounting | undefined> {
  if (!cleaner) return undefined;
  try {
    return await cleaner(args);
  } catch (e) {
    // The clean is the retry's hygiene, never its failure: an account that could
    // not be produced is reported as unreadable rather than silently as "there
    // was nothing there", which is the difference between an operator checking
    // the tree and an operator trusting a lie.
    return {
      outcome: "unreadable",
      paths: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
