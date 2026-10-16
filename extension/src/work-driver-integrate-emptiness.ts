/**
 * The "did the integration actually produce anything?" decision of `integrate()`
 * step 3.5.
 *
 * An integration that consolidates nothing is not a failure and must not be
 * reported as a success — the caller would otherwise push an empty branch and
 * open a PR whose diff is empty, and the #749 distinction is what the handoff
 * renders: "nothing produced" (the workstream had no commits) is a different
 * fact from "the work exists and its content is already on the branch"
 * (dedup skipped every pick).
 *
 * Two shapes, because the two integration modes leave different evidence:
 * with a recorded `baseSha` the question is answered by commit count
 * (`rev-list base..HEAD`), which is exact; without one (the patch-transplant
 * fallback, which produces no commits) the only observable is the index.
 *
 * Extracted from `work-driver-integrate.ts` for the AGENTS.md §12 line cap;
 * behaviour is a pure move.
 */

import type { ExecFn } from "./worktree.ts";

export interface IntegrationEmptiness {
  empty: boolean;
  /** Populated only when the consolidation produced nothing. */
  skippedAlreadyOnBranch?: string[];
}

export async function integrationEmptiness(
  execFn: ExecFn,
  opts: {
    repoRoot: string;
    /** The recorded base, when the integration has one (create mode). */
    baseSha: string | undefined;
    /** Workstreams whose content landed, by either route. */
    appliedWorkstreams: string[];
    /** Workstreams deduped as already-on-branch by the pick orchestrator. */
    skippedAlreadyOnBranch?: string[];
  },
): Promise<IntegrationEmptiness> {
  const skipped = opts.skippedAlreadyOnBranch ?? [];
  const emptyResult = (): IntegrationEmptiness => ({
    empty: true,
    ...(skipped.length > 0 ? { skippedAlreadyOnBranch: skipped } : {}),
  });

  if (opts.baseSha) {
    const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(opts.baseSha)}..HEAD`, {
      cwd: opts.repoRoot,
      maxBuffer: 64 * 1024,
    });
    const ahead = Number.parseInt(stdout.trim(), 10);
    // An unparseable count is "no commits", not "some commits": the safe
    // reading of a git read that did not behave.
    if (!Number.isFinite(ahead) || ahead === 0) return emptyResult();
    return { empty: false };
  }

  // No baseSha — the patch fallback transplants content without committing
  // it, so the index is the only place that content is observable.
  if (opts.appliedWorkstreams.length === 0) {
    const { stdout } = await execFn("git diff --cached --name-only", {
      cwd: opts.repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (!stdout.trim()) return emptyResult();
  }
  return { empty: false };
}
