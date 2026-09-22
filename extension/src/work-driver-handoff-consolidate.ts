/**
 * work-driver-handoff-consolidate — #674 item 1+2: move a parked cycle's
 * work onto its feature branch BEFORE the handoff body is rendered.
 *
 * The shape this exists for: a develop-parked cycle (e.g.
 * `verify-failed:develop`, the shape of #645/#649/#659/#660/#664) carries
 * its workstream work as commits on DETACHED-HEAD worktrees under
 * `.worktrees/issue-<N>-<id>`. At handoff time the feature branch does not
 * exist locally or remotely — nothing has ever reached commit-pr — and the
 * printed recovery used to say `git -C <repoRoot> status` / `add -p` /
 * `push -u origin <branch>`: every command against a main checkout that is
 * provably empty. An operator following it verbatim concludes the work was
 * lost; in reality `git worktree list` + cherry-pick recovers it, which is
 * what a human had to discover by hand each of the five times.
 *
 * Preferred fix direction, per the ticket: consolidate onto the feature
 * branch using the existing commit-pr machinery (`orchestrateCherryPick`),
 * so the branch genuinely contains the work and the printed `git status` /
 * `push` instructions become true.
 *
 * Deliberate deviations from `integrate()` (all three are load-bearing):
 *
 *   - **No verify command.** `integrate()` runs the project's verify command
 *     between commit and push. This handoff path SKIPS it on purpose: the
 *     work is known to have failed develop's own verify gate (that is why
 *     it parked), and re-running the same gate here would block the
 *     preferred path in the exact cycles where the operator wants the
 *     branch to inspect. If the consolidated tree is broken, the operator
 *     sees that when they build — they were going to anyway.
 *   - **No push.** The branch is local-only at handoff time; the recovery
 *     block the operator gets ends in the push. A failed push must not
 *     destroy the local consolidation.
 *   - **No worktree reset / removal.** After a successful consolidation the
 *     cycle is TERMINAL: the work is on the branch, so the in-cycle teardown
 *     (`runWorktreeTeardown`) removes the worktrees it now covers — that is
 *     the bug-2 cleanup, and it removes only worktrees keyed in
 *     `pipelineState.worktrees` that pass the "work provably on the branch"
 *     check. Nothing here ever deletes a worktree.
 *
 * Failure mode: ANY failure (dirty repoRoot, cherry-pick conflict, git
 * error) degrades to `{ ok: false, reason }` WITHOUT aborting the handoff —
 * the renderers then fall back to the accurate per-worktree recovery
 * (work-driver-handoff-recovery.ts), and `runWorktreeTeardown` retains the
 * worktrees because the work is not (yet) on a branch. Consolidation must
 * never destroy work or block the handoff from completing.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { type ForgeDetection, detectForge } from "./forge-detect.ts";
import { createForge } from "./forge.ts";
import { trace } from "./trace.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.ts";
import { deriveConsolidationSubject } from "./work-driver-handoff-subject.ts";
import { withIntegrationLock } from "./work-driver-integrate.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

const defaultExecFn: ExecFn = promisify(exec) as unknown as ExecFn;

/** Whether handoff-time consolidation is enabled (default on). */
export function handoffConsolidationEnabled(): boolean {
  return process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE !== "0";
}

/**
 * How many local commits the worktrees carry past `baseSha`, and at which
 * worktree HEADs. `rev-list --count baseSha..HEAD` is the same predicate the
 * cherry-pick orchestrator uses to decide a worktree has commits to move, so
 * consolidation only runs when there is something to move. Returns
 * `{ ahead: 0 }` when there is no committed work to consolidate (or no base
 * SHA recorded) — the caller treats that as "nothing to do, keep the
 * existing snapshot".
 */
export async function countAheadOfBase(
  execFn: ExecFn,
  repoRoot: string,
  baseSha: string | undefined,
  worktrees: Record<string, string>,
): Promise<{ total: number; ahead: Record<string, number> }> {
  if (!baseSha) return { total: 0, ahead: {} };
  const ahead: Record<string, number> = {};
  let total = 0;
  for (const [id, wt] of Object.entries(worktrees)) {
    try {
      const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(baseSha)}..HEAD`, {
        cwd: wt,
        maxBuffer: 64 * 1024,
      });
      const n = Number.parseInt(stdout.trim(), 10);
      if (Number.isFinite(n) && n > 0) {
        ahead[id] = n;
        total += n;
      }
    } catch {
      // Unreadable worktree (deleted on disk, no shared history) — treat as
      // no committed work. Uncommitted dirt in the same worktree is still
      // visible via the porcelain-based snapshot.
    }
  }
  return { total, ahead };
}

/**
 * Whether the cycle's work is demonstrably NOT yet on its local branch —
 * the re-entry guard for crash-resume re-post. A second `runHandoff`
 * (the dedupe census: a crash after the comment posted but before the
 * enclosing writeState left the file at "running") must not re-consolidate
 * work that is already on the branch: the cherry-pick orchestrator's
 * tree-hash dedupe makes a redundant run cheap but not free, and a
 * redundant run after an operator manually resolved a conflict would
 * re-introduce it. Returns true when the branch exists locally AND at
 * least one worktree is still ahead of the base; false when the branch is
 * absent (first entry — consolidate) or there is nothing ahead (nothing to
 * move, keep the snapshot the caller built).
 */
export async function workNotYetOnBranch(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string | undefined,
  baseSha: string | undefined,
  worktrees: Record<string, string>,
): Promise<boolean> {
  if (!branchName || !baseSha) return true;
  let branchExists = false;
  try {
    await execFn(`git rev-parse --verify ${JSON.stringify(branchName)}`, { cwd: repoRoot });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  if (!branchExists) return true;
  const { total } = await countAheadOfBase(execFn, repoRoot, baseSha, worktrees);
  return total > 0;
}

export interface ConsolidateOutcome {
  ok: boolean;
  /** The branch the work was consolidated onto (success only). */
  branchName?: string;
  /** Committed workstream ids that landed on the branch (cherry-picked or
   * patch-applied). Present when at least one workstream had committed work. */
  workstreams?: string[];
  /** Human-readable failure reason (failure only). */
  reason?: string;
}

/**
 * Consolidate the parked cycle's workstream work onto its feature branch at
 * repoRoot, WITHOUT pushing and WITHOUT verifying (see module header).
 *
 * Returns a failure outcome (never throws) when consolidation is not
 * possible — dirty repoRoot, cherry-pick conflict, git error, or the
 * integration lock itself misbehaving. The caller degrades to the
 * accurate-worktree-paths fallback and lets the handoff complete.
 */
export async function consolidateWorktreesToBranch(
  ctx: { repoRoot: string; issue: number; scratchDir: string },
  state: WorkState,
  execFn: ExecFn = defaultExecFn,
): Promise<ConsolidateOutcome> {
  const ps = state.pipelineState;
  const branchName = ps.branchName;
  const worktrees = ps.worktrees ?? {};
  const ids = Object.keys(worktrees);
  if (!branchName || ids.length === 0) {
    return { ok: false, reason: "no branchName or no worktrees recorded — nothing to consolidate" };
  }
  // Nothing to move? Then the existing (porcelain-based) snapshot already
  // describes the cycle's true state and consolidation would only risk
  // repoRoot for no gain.
  const { total } = await countAheadOfBase(execFn, ctx.repoRoot, ps.baseSha, worktrees);
  if (total === 0) {
    return { ok: false, reason: "no committed work ahead of the base — nothing to consolidate" };
  }

  // #750 — where the root was before consolidation touched its checkout.
  // The failure paths must restore it and say so honestly; pre-#750 this
  // site only ran `git cherry-pick --abort` (which refuses for a
  // --no-commit pick) and claimed "the batch was aborted" with the root
  // still carrying staged/unmerged index content.
  let originalRef: string | undefined;
  const mode = await branchExistsAtRoot(execFn, ctx.repoRoot, branchName);
  const commitBody =
    `Consolidated at handoff (issue #${state.issue}): the cycle parked at ` +
    `${ps.currentStep} with committed work on detached-HEAD worktrees; this commit moves it onto ` +
    `${branchName} so the handoff recovery instructions are true.`;

  try {
    const result = await withIntegrationLock(ctx.repoRoot, async () => {
      // Dirty-repoRoot preflight — same gate as integrate() and
      // consolidated-verify: untracked `??` IS dirt (the N=1 pre-#287 shape
      // develops directly at repoRoot, and stagePorcelainPaths can sweep
      // untracked files into the branch). `.worktrees/` is the driver's own
      // scaffolding, not operator residue.
      const { stdout: rootStatus } = await execFn("git status --porcelain", {
        cwd: ctx.repoRoot,
        maxBuffer: 1024 * 1024,
      });
      const rootDirt = rootStatus
        .split("\n")
        .filter((l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l));
      if (rootDirt.length > 0) {
        return {
          ok: false as const,
          reason: `repoRoot has uncommitted changes (including untracked files, which this path can sweep into the parked branch); refusing to consolidate into ${branchName}: ${rootDirt
            .slice(0, 5)
            .map((l) => l.slice(3))
            .join(", ")}`,
        };
      }
      originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
        cwd: ctx.repoRoot,
        maxBuffer: 64 * 1024,
      })
        .then((r) => r.stdout.trim())
        .catch(async () =>
          (
            await execFn("git rev-parse HEAD", {
              cwd: ctx.repoRoot,
              maxBuffer: 64 * 1024,
            })
          ).stdout.trim(),
        );
      if (mode === "create") {
        // No local branch and no baseSha — cannot create at a known commit;
        // degrade to the accurate-worktree fallback.
        if (!ps.baseSha) {
          return {
            ok: false as const,
            reason: `no local branch ${branchName} and no baseSha recorded — cannot create the branch without a commit to start from`,
          };
        }
        await execFn(
          `git checkout -B ${JSON.stringify(branchName)} ${JSON.stringify(ps.baseSha)}`,
          {
            cwd: ctx.repoRoot,
            maxBuffer: 256 * 1024,
          },
        );
      } else {
        await execFn(`git checkout ${JSON.stringify(branchName)}`, {
          cwd: ctx.repoRoot,
          maxBuffer: 256 * 1024,
        });
      }
      // #794 — own-range selection: a stacked workstream's range is
      // measured against its dependency's tip (`workstreamBaseShas`), so
      // ancestor commits are not re-picked on top of their content (the
      // #775 replay). A workstream with no entry falls back to `ps.baseSha`.
      const orch = await orchestrateCherryPick(execFn, {
        repoRoot: ctx.repoRoot,
        branchName,
        worktrees: { ids, worktrees, commitShas: {} },
        baseSha: ps.baseSha,
        scratchDir: ctx.scratchDir,
        requireAllNonEmpty: false,
        pickScope: { globalBaseSha: ps.baseSha, workstreamBaseShas: ps.workstreamBaseShas },
      });
      if (orch._conflict === "conflict") {
        // #750 — the verified restore (cherry-pick.ts already attempted
        // `--abort`; this one resets the staged/unmerged index the refusal
        // leaves behind and verifies the root is actually clean).
        const restore = originalRef
          ? await verifiedRestoreRoot(execFn, {
              repoRoot: ctx.repoRoot,
              originalRef,
              scratchDir: ctx.scratchDir,
              label: "handoff consolidation",
            })
          : undefined;
        // A conflict means the worktrees still hold their commits verbatim —
        // the accurate per-worktree recovery (which names the paths and
        // HEAD SHAs) is the honest fallback, and the worktrees are retained.
        // #750 — the claim goes through the shared builder: the restored
        // variant is the verified post-condition, the not-restored variant
        // is loud and tells the operator where to look.
        const claim = restoreClaim(
          restore === undefined ? undefined : restore,
          undefined,
          "run git status at the repo root",
        );
        return {
          ok: false as const,
          reason: `cherry-pick conflict — ${claim}; the work remains on its worktree detached HEADs (per-worktree recovery below)`,
        };
      }
      if (orch._applyConflict !== undefined) {
        const { id, reason, patchFile } = orch._applyConflict;
        const restore = originalRef
          ? await verifiedRestoreRoot(execFn, {
              repoRoot: ctx.repoRoot,
              originalRef,
              scratchDir: ctx.scratchDir,
              label: "handoff consolidation",
            })
          : undefined;
        const claim = restoreClaim(restore === undefined ? undefined : restore);
        return {
          ok: false as const,
          reason: `patch-apply failed for workstream '${id}': ${reason} (patch preserved at ${patchFile}); ${claim}; the work remains in its worktree (per-worktree recovery below)`,
        };
      }
      // #728 — the completeness gate (#723 class: the pick staged a subset
      // and claimed success). This handoff path deliberately cannot hard-halt
      // (work preservation), so it degrades to the honest recovery: the
      // `handoff-consolidated` event (the "branch contains the work" claim)
      // is only emitted on a COMPLETE consolidation, so an incomplete or
      // unverifiable pick renders the accurate per-worktree recovery instead.
      const comp = orch.completeness;
      if (comp?.checkError) {
        return {
          ok: false as const,
          reason: `consolidation completeness could not be verified (${comp.checkError.slice(0, 200)}); treating as unverifiable — the per-worktree recovery below names the work`,
        };
      }
      if (comp?.droppedPaths && comp.droppedPaths.length > 0) {
        return {
          ok: false as const,
          reason: `consolidation incomplete — ${comp.droppedPaths.length} path(s) intended but not on the branch (${comp.droppedPaths
            .slice(0, 10)
            .join(
              ", ",
            )}${comp.droppedPaths.length > 10 ? "…" : ""}); the work remains in its worktrees (per-worktree recovery below)`,
        };
      }
      const applied = [...orch.cherryApplied, ...orch.patchApplied];
      if (applied.length === 0) {
        // Every worktree had a clean tree and no committed work — the
        // countAheadOfBase precheck above should have caught that, but the
        // operator's branch may already contain the work. Not an error.
        return {
          ok: true as const,
          branchName,
          workstreams: [],
        };
      }
      // Commit the staged batch. (No push: the branch is local-only at
      // handoff time; the recovery block ends in the push the operator runs.
      // No verify: the work already failed develop's gate — see header.)
      const { stdout: hasStaged } = await execFn("git diff --cached --name-only", {
        cwd: ctx.repoRoot,
        maxBuffer: 64 * 1024,
      });
      if (hasStaged.trim()) {
        // #810 — real change IS present (non-empty staged diff), so the commit
        // describes the CHANGE, not the driver's housekeeping step. The subject
        // is derived from the issue title; a fetch failure or an unmappable
        // type falls back to an honest `chore(work):` rather than relabelling
        // the change to satisfy release-please.
        const subject =
          (await deriveConsolidationSubjectFor(ctx)) ??
          `chore(handoff): consolidate parked work onto ${branchName}`;
        await execFn(`git commit -m ${JSON.stringify(subject)} -m ${JSON.stringify(commitBody)}`, {
          cwd: ctx.repoRoot,
          maxBuffer: 256 * 1024,
        });
      }
      return { ok: true as const, branchName, workstreams: applied };
    });
    if (result.ok) {
      trace(
        `handoff-consolidate: consolidated ${result.workstreams?.length ?? 0} workstream(s) onto ${branchName} (local, not pushed)`,
      );
    }
    return result;
  } catch (err) {
    // Anything that threw mid-consolidation (a failed checkout, a git lock,
    // a lockfile error) must not abort the handoff — same degradation as a
    // conflict. The worktrees still hold every commit, so no work is
    // destroyed; #750 also restores the root (which the throw may have
    // left mid-`checkout`) and reports that honestly.
    const msg = (err as Error & { stderr?: string }).stderr ?? (err as Error).message ?? "unknown";
    trace(`handoff-consolidate: failed: ${msg.toString().slice(0, 200)}`);
    if (originalRef) {
      await verifiedRestoreRoot(execFn, {
        repoRoot: ctx.repoRoot,
        originalRef,
        scratchDir: ctx.scratchDir,
        label: "handoff consolidation",
      }).catch((rerr) =>
        trace(
          `handoff-consolidate: restore after failure also failed: ${(rerr as Error).message?.slice(0, 200)}`,
        ),
      );
    }
    return { ok: false, reason: `consolidation failed: ${msg.toString().slice(0, 200)}` };
  }
}

/**
 * #810 — the consolidation commit's subject, derived from the issue title.
 *
 * Fetches the issue title the same way the branch slug and PR title are built
 * (`gh issue view` via the forge adapter) and runs it through
 * {@link deriveConsolidationSubject}. A fetch failure (forge undetermined,
 * network, auth) or an empty/unmappable title returns `undefined`, which the
 * caller maps to the honest `chore(handoff):` line rather than guessing.
 */
async function deriveConsolidationSubjectFor(ctx: {
  repoRoot: string;
  issue: number;
}): Promise<string | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  let det: ForgeDetection;
  try {
    det = await detectForge(ctx.repoRoot, {});
  } catch {
    return undefined;
  }
  if (det.forge === "unknown") return undefined;
  const forge = createForge(det, { cwd: ctx.repoRoot });
  try {
    const issue = await forge.issueView(ctx.issue);
    return deriveConsolidationSubject(issue.title);
  } catch {
    return undefined;
  }
}

/** Whether the branch exists locally at repoRoot ("create" when not). */
async function branchExistsAtRoot(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<"create" | "followup"> {
  try {
    await execFn(`git rev-parse --verify ${JSON.stringify(branchName)}`, { cwd: repoRoot });
    return "followup";
  } catch {
    return "create";
  }
}
