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
 *
 * #1396 (round 3) has one exception, and it is the fail-open this module used
 * to be: the listing behind the residue pass is now bounded, so a HANG is a
 * rejection. Turning that into "no leftovers" (the old `catch → []` plus this
 * file's blanket non-fatal catch) would report a clean residue pass while a
 * same-issue tree holding uncommitted work sat untouched. A rejection that is
 * not "there is no git here" is recorded as a `worktree-listing-unreadable`
 * cap-hit — a visible park with the git error as its evidence.
 */

import { trace } from "./trace.ts";
import { detectMainline, freshMainlineTip } from "./work-driver-branch-mechanized.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import {
  classifyRootDirt,
  probeIgnored,
  readIgnoredPaths,
} from "./work-driver-dirty-root-classify.ts";
import { dirtyRootExemptReadNotice } from "./work-driver-dirty-root-exempt.ts";
import { isConfiguredExemptDirtLine } from "./work-driver-dirty-root-exempt.ts";
import { readDirtyRootExemptBaseline } from "./work-driver-dirty-root-exempt.ts";
import { IGNORE_PROBE_TIMEOUT_MS } from "./work-driver-ignore-probe.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";
import { handleSameIssueLeftovers } from "./worktree-leftover.ts";
import type { ExecFn } from "./worktree.ts";
import { WorktreeScanError, isMissingGit, worktreePath } from "./worktree.ts";

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
  exempt?: readonly string[],
): Promise<string[] | undefined> {
  // #1421 round 3 — BOUNDED, same reasoning as the consolidated verify's
  // preflight: an unbounded read of a hung git holds the integration lock (the
  // branch step runs under it) and every other worktree's consolidation behind
  // it, and reports nothing. The kill rejects with no exit code, which
  // `runBranchResiduePass` already degrades non-fatally — the post-develop
  // gate still fires — so the bound converts a hang into that existing
  // degradation instead of an endless block.
  const { stdout } = await execFn("git status --porcelain -uall", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
    timeout: IGNORE_PROBE_TIMEOUT_MS,
  });
  const dirt = stdout.split("\n");
  // #1421 — untracked paths git itself declares ignored are build output, not
  // residue the operator must clear: a Rust workspace at the repo root leaves
  // `target/` behind from its own gate run, and blocking a cycle on it (or on
  // the consolidated verify's identical refusal 50 minutes later) parked
  // finished work. The ignored read failing classifies everything as dirt —
  // the pre-#1421 shape — so this narrowing can never weaken the gate.
  //
  // #1421 fix round (lens) — the two git reads run CONCURRENTLY. Here (unlike
  // the consolidated verify's preflight) the probe's candidates are exactly
  // the status lines, so neither read waits on the other; each still fails
  // closed on its own, and `classifyRootDirt` refuses on either being
  // `undefined`.
  const [ignored, probed] = await Promise.all([
    readIgnoredPaths(execFn, repoRoot),
    probeIgnored(execFn, repoRoot, dirt),
  ]);
  const classified = classifyRootDirt(dirt, ignored, exempt, probed);
  return classified.dirt.length > 0 ? classified.dirt : undefined;
}

/**
 * #1362 — record the paths already untracked under the project's exempt
 * prefixes, once, at the point where the branch step first reads repoRoot's
 * dirt (immediately after the residue pass, before the mechanized setup can
 * write anything). The restore claim reads this back as provenance: after an
 * abort's mixed reset a staged-new deliverable and a tool's stray are both
 * `??`, so only "was it already here?" separates them — and only a snapshot
 * taken before the cycle could write answers that.
 *
 * Written once and never recomputed: a resumed cycle keeps the value its first
 * run captured, because recomputing late would bless the cycle's own output as
 * pre-existing. No exemption list, or nothing under it, records nothing — and
 * `undefined` is the answer `isClaimCountedEntry` treats as "name everything".
 * Best-effort: a failed read is traced and records nothing, which is the safe
 * direction (a claim that names too much is a false alarm; one that spares the
 * cycle's own work is the defect this field exists to prevent).
 */
export async function recordDirtyRootExemptBaseline(
  ctx: CycleContext,
  state: WorkState,
  execFn: ExecFn,
): Promise<WorkState> {
  const ps = state.pipelineState;
  if (ps.dirtyRootExemptBaseline !== undefined) return state;
  if (ctx.dirtyRootExempt === undefined || ctx.dirtyRootExempt.length === 0) return state;
  // Same gate as the residue pass beside it: with worktrees already in the
  // state this is a re-entry, and repoRoot is no longer the pre-cycle tree the
  // snapshot is meant to describe.
  if (Object.keys(ps.worktrees ?? {}).length > 0) return state;
  try {
    const baseline = await readDirtyRootExemptBaseline(execFn, ctx.repoRoot, ctx.dirtyRootExempt);
    if (baseline === undefined) return state;
    // A cycle with no exempt paths present at all needs no field: leaving it
    // absent keeps a resumed cycle in the same "name everything" state it would
    // reach with an empty list, and keeps the state file unchanged for the
    // overwhelmingly common case of nothing to record.
    if (baseline.length === 0) return state;
    return {
      ...state,
      pipelineState: { ...ps, dirtyRootExemptBaseline: baseline },
    };
  } catch (err) {
    trace(
      `work-driver: could not record the exempt baseline (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
    );
    return state;
  }
}

/**
 * Run the residue pass for a first-branch-entry state (empty worktrees
 * map) and record its outcome. Returns the (possibly event-appended)
 * state, unchanged when the pass found nothing or could not run.
 */
export async function runBranchResiduePass(
  ctx: CycleContext,
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
  const rootDirt = await readRepoRootDirt(execFn, ctx.repoRoot, ctx.dirtyRootExempt).catch(
    (err) => {
      trace(
        `work-driver: branch-step dirty-root pre-check failed (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
      );
      return undefined;
    },
  );
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
This is residue from a previous cycle or the operator's own in-progress work — it is NOT a defect in this cycle's diff. It is preserved (nothing is deleted or stashed); inspect and clear it (commit, move, or add to .gitignore) and re-run the cycle. A previous cycle whose restore could not save the root's state leaves it like this on purpose — its handoff says so and names the tree; state a restore did save is in that cycle's scratch dir as restored-state-*.diff.${
        // #1362 — when the exemption file could not be read, the operator must
        // learn it HERE: every path above was judged with an empty list, so a
        // file the project legitimately exempts reads exactly like residue. The
        // trace went to stderr at cycle start; the handoff is what is read.
        ctx.dirtyRootExemptReadFailed === undefined
          ? ""
          : `\n\n${dirtyRootExemptReadNotice(ctx.dirtyRootExemptReadFailed)}`
      }`,
    });
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, currentStep: "handoff" },
    };
    await persistCycle(ctx, next).catch((err) => {
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
    // #1396 round 3 — "could not read the listing" is not "there was nothing
    // to clean". Only a git that genuinely cannot run (`ENOENT`) keeps the
    // long-standing non-fatal degradation; a timeout or a kill parks, because
    // the alternative is a residue pass that removed nothing and reported
    // success while a dirty same-issue tree stayed in place for the next
    // cycle's `worktree add` to refuse on.
    if (err instanceof WorktreeScanError || !isMissingGit(err)) {
      const detail = (err as Error).message ?? String(err);
      trace(
        `work-driver: same-issue residue pass could not read the worktree list — halting the branch step: ${detail.slice(0, 200)}`,
      );
      return appendEvent(state, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "worktree-listing-unreadable",
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
        evidence: `same-issue residue pass could not read \`git worktree list\`, so the branch step cannot tell whether a leftover holds work: ${detail.slice(0, 300)}`,
      });
    }
    trace(
      `work-driver: same-issue residue pass failed (non-fatal): ${(err as Error).message?.slice(
        0,
        200,
      )}`,
    );
    return state;
  }
}
