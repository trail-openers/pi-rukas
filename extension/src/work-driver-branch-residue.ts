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
import { detectMainline, freshMainlineTip } from "./work-driver-branch-mechanized.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent, writeState } from "./workflow-state.ts";
import { handleSameIssueLeftovers } from "./worktree-leftover.ts";
import type { ExecFn } from "./worktree.ts";
import { worktreePath } from "./worktree.ts";

/**
 * #746 task-b — the driver-managed paths that do NOT count as repoRoot dirt.
 * The branch-step early block and the post-develop consolidated-verify
 * preflight must agree on what is dirt, or one gate fires where the other
 * does not (or both fire when the driver's own scaffolding is present).
 * This helper is the single source of truth for both sites.
 */
export function isDriverManagedDirtLine(line: string): boolean {
  return (
    /^..\s+"?\.worktrees\//.test(line) || /^..\s+"?\.pi\//.test(line) || /^..\s+"?tmp\//.test(line)
  );
}

/**
 * #746 task-b — the branch-step early dirty-root check.
 *
 * Runs `git status --porcelain -uall` at repoRoot, applies the driver-managed
 * exclusion set, and returns the remaining paths — residue from a previous
 * cycle or the operator's own in-progress work. The caller HARD-BLOCKS the
 * cycle with a cap-hit on any hit: a stray file at repoRoot is a
 * correctness hazard for `integrate()` staging under the integration lock,
 * and a silent continue burns ~50 min before the consolidated verify fires
 * the same refusal.
 *
 * `-uall` is load-bearing for the "names the EXACT paths" criterion: plain
 * `--porcelain` collapses an untracked directory tree to its top-level
 * entry (a stray `extension/src/work-driver-converge.ts` at the root reads
 * as a bare `?? extension/`, which is what made the #741 handoff's
 * "residue at extension/…" message name a directory, not the file). The
 * dirty-root gates must point at the residue itself, not its container.
 *
 * Returns `undefined` when the root is clean (the common case).
 *
 * NEVER deletes, stashes, or otherwise mutates the paths — preserving is
 * the safe default; the observed #741 residue held an alternative design
 * worth keeping.
 */
export async function readRepoRootDirt(
  execFn: ExecFn,
  repoRoot: string,
): Promise<string[] | undefined> {
  const { stdout } = await execFn("git status --porcelain -uall", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  const dirt = stdout.split("\n").filter((l) => l.trim() && !isDriverManagedDirtLine(l));
  return dirt.length > 0 ? dirt : undefined;
}

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
  // #746 task-b — the EARLY dirty-root block. A stray untracked or modified
  // file at repoRoot outside the driver-managed exclusion set (`.worktrees/`,
  // `.pi/`, `tmp/`) is residue from a previous cycle or the operator's own
  // in-progress work. The branch step HARD-BLOCKs the cycle here — before
  // any development dispatch is paid for — with a cap-hit naming the exact
  // paths, rather than discovering the dirt at the post-develop consolidated
  // verify roughly 50 minutes later. The paths are preserved, never
  // deleted or stashed: the observed #741 residue held an alternative
  // design worth keeping, and the operator's own working tree is not ours
  // to move. A failure of this read degrades to no-op (the post-develop
  // gate still fires) rather than masking a clean root.
  const rootDirt = await readRepoRootDirt(execFn, ctx.repoRoot).catch((err) => {
    trace(
      `work-driver: branch-step dirty-root pre-check failed (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
    );
    return undefined;
  });
  if (rootDirt !== undefined) {
    const paths = rootDirt.map((l) => l.slice(3).trim());
    const pathsShown = paths.slice(0, 5).join(", ");
    const omitted = paths.length > 5 ? ` (+${paths.length - 5} more)` : "";
    trace(
      `work-driver: branch step — repoRoot dirty, blocking before dispatch: ${pathsShown}${omitted}`,
    );
    let next = appendEvent(state, {
      kind: "plumb-report",
      at: Date.now(),
      step: "branch",
      role: "driver",
      body: `Branch step blocked — repoRoot is dirty before any development dispatch:
${paths.map((p) => `  - ${p}`).join("\n")}
This is residue from a previous cycle or the operator's own in-progress work — it is NOT a defect in this cycle's diff. It is preserved (nothing is deleted or stashed); inspect and clear it (commit, move, or add to .gitignore) and re-run the cycle.`,
    });
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, currentStep: "handoff" },
    };
    await writeState(ctx.repoRoot, next).catch((err) => {
      trace(
        `work-driver: failed to persist dirty-root block state (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
      );
    });
    return appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "repo-root-residue",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
      evidence: `${pathsShown}${omitted}`,
    });
  }
  try {
    const mainline = await detectMainline(execFn, ctx.repoRoot);
    const { sha: fromRef } = await freshMainlineTip(execFn, ctx.repoRoot, mainline);
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
