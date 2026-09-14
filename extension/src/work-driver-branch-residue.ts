/**
 * work-driver-branch-residue — #730 same-issue worktree residue pass.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate). Runs the
 * branch step's residue handler (worktree-leftover.ts) before the
 * mechanized setup and records its outcome in the state: a plumb report
 * (the prose for the handoff) + one `worktree-leftover-handled` event per
 * leftover (the machine-readable record of "reused vs removed, and which
 * it did").
 *
 * The pass itself is documented in worktree-leftover.ts: it scans the
 * worktree list directly (not the state-file-keyed sweep, whose
 * `${name}.json` lookup can never match — state files are keyed by issue
 * number), adopts a clean leftover at the cycle's own target path, and
 * preserves (salvage patch + durable HEAD tag) any dirty leftover before
 * removing it. It is scoped to the cycle's own issue(s) — a concurrent
 * cycle's `.worktrees/issue-<M>-*` (M ≠ N) is never touched.
 *
 * Runs on the FIRST branch entry only (no worktrees in the state yet); a
 * re-entry into branch (e.g. from step-back) operates on the state's OWN
 * worktrees, which the #545 salvage at the refusal path already covers.
 *
 * Never throws: the existing refusal/degradation paths cover the case
 * where the pass could not resolve the residue.
 */

import { trace } from "./trace.ts";
import { detectMainline, resolveBaseSha } from "./work-driver-branch-mechanized.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
import { handleSameIssueLeftovers } from "./worktree-leftover.ts";
import type { ExecFn } from "./worktree.ts";
import { worktreePath } from "./worktree.ts";

/**
 * Run the residue pass for a first-branch-entry state (empty worktrees
 * map) and record its outcome. Returns the (possibly event-appended)
 * state, unchanged when the pass found nothing or could not run.
 */
export async function runBranchResiduePass(
  ctx: DriverContext,
  state: WorkState,
  execFn: ExecFn,
  salvageScratch: string,
): Promise<WorkState> {
  if (Object.keys(state.pipelineState.worktrees ?? {}).length > 0) {
    return state;
  }
  try {
    const mainline = await detectMainline(execFn, ctx.repoRoot);
    const fromRef = await resolveBaseSha(execFn, ctx.repoRoot, mainline);
    if (!fromRef) return state;
    const { actions, unresolved } = await handleSameIssueLeftovers(
      execFn,
      ctx.repoRoot,
      fromRef,
      activeIssuesOf(state),
      salvageScratch,
      worktreePath(ctx.repoRoot, `issue-${ctx.issue}-default`),
    );
    if (actions.length === 0 && unresolved.length === 0) return state;
    const lines = actions.map((a) => {
      // Honest prose, per case: a clean removal preserves nothing (there
      // was nothing to preserve); a dirty removal preserved first.
      const what =
        a.action === "adopt"
          ? "adopted (reused)"
          : a.leftover.dirty
            ? "preserved (salvage patch and/or durable ref), then removed"
            : "removed (clean — nothing to preserve)";
      const extra: string[] = [];
      if (a.salvageDir) extra.push(`salvage: ${a.salvageDir}`);
      if (a.refs.length > 0) extra.push(`durable refs: ${a.refs.join(", ")}`);
      return `  - ${a.leftover.path}: ${what}${extra.length ? ` (${extra.join("; ")})` : ""}`;
    });
    if (unresolved.length > 0) {
      lines.push(
        `  - UNRESOLVED (still present, the refusal below names it): ${unresolved.join(", ")}`,
      );
    }
    let next = appendEvent(state, {
      kind: "plumb-report",
      at: Date.now(),
      step: "branch",
      role: "driver",
      body: `Same-issue worktree residue handled before branch setup:\n${lines.join("\n")}`,
    });
    // #730 — one machine-readable event per leftover (the acceptance
    // criterion: "reuses an existing worktree knowingly or removes it
    // first, and reports which it did"), plus a durable-ref note so the
    // handoff can name the recovery path without re-parsing prose.
    for (const a of actions) {
      next = appendEvent(next, {
        kind: "worktree-leftover-handled",
        at: Date.now(),
        path: a.leftover.path,
        action: a.action,
        refs: a.refs,
        ...(a.salvageDir ? { salvageDir: a.salvageDir } : {}),
        ...(a.action === "removed" && a.leftover.dirty ? { preserved: true } : {}),
      });
    }
    return next;
  } catch (err) {
    trace(
      `work-driver: same-issue residue pass failed (non-fatal): ${(err as Error).message?.slice(
        0,
        200,
      )}`,
    );
    return state;
  }
}
