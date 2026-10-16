/**
 * work-driver-integrate-worktree — the driver-owned integration worktree
 * (`.worktrees/issue-<N>-integrate`) the commit-pr ops fallback is pinned
 * to.
 *
 * #861 — the ops fallback used to dispatch with no cwd and its prompt told
 * the child to use "the repo root if it's checked out on <branch>, else cd
 * into a worktree that is" — the instruction that let #841's ops child check
 * its branch out inside #844's worktree. The fallback now dispatches from
 * this worktree, which the driver owns:
 *
 *  - ATTACHED at `refs/heads/<branchName>` when the branch exists (the
 *    integrate() conflict path leaves it at baseSha), else created at
 *    baseSha. The #287 always-detached invariant has one documented
 *    exemption: this tree, by name suffix.
 *  - Re-entry: an existing `issue-<N>-integrate` is driver-owned (an
 *    earlier attempt of this same cycle), not operator residue — its old
 *    HEAD is recorded (its unpushed commits kept on a backup ref, #1173),
 *    it is force-removed, and a fresh one is created.
 *    The #475/#545 create guards (runCreateGuards) still run on top.
 *    #1396: the registration check is a STRICT `git worktree list` — an
 *    unreadable listing throws `WorktreeScanError` and removes nothing,
 *    rather than reading the tree as unregistered and skipping the
 *    commit-keeping path.
 *  - If repoRoot itself holds the branch, it is detached first (under the
 *    caller's integration lock) when clean, and a dirty repoRoot halts —
 *    the driver never moves operator residue.
 *
 * All git goes through the caller's ExecFn (the same seam the rest of the
 * driver audits); nothing here runs at process.cwd().
 */

import fs from "node:fs/promises";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import { repoRootHoldsBranch } from "./work-driver-branch-holder.ts";
import { isDriverManagedDirtLine } from "./work-driver-branch-residue.ts";
import { isConfiguredExemptDirtLine } from "./work-driver-dirty-root-exempt.ts";
import {
  backupIntegrateHead,
  isIntegrateTreeInCycle,
  isRegisteredWorktree,
  keepOrRefuseStaleIntegrateTree,
  readCycleWorktreePaths,
  refuseDirtyCycleTrees,
} from "./work-driver-integrate-cycle.ts";
import { runCreateGuards } from "./worktree-create-guard.ts";
import { assertSafeRef } from "./worktree-loss.ts";
// The branch-holder audit lives in work-driver-integrate-holders.ts (§12 size
// split) and is re-exported here so the audit's importers keep one home for the
// integrate tree's whole surface: path, creation, and who holds its branch.
export {
  type BranchHoldersResult,
  branchHolders,
  repoRootHoldsBranch,
} from "./work-driver-integrate-holders.ts";
import { repoRootHoldsBranch } from "./work-driver-integrate-holders.ts";
import { provisionWorktree } from "./worktree-provision.ts";
import { worktreePath, worktreeRemove } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * #861 — the shared porcelain-dirt reader (trimmed, non-empty lines; `[]`
 * on failure) for the two inline dirt checks in ensureIntegrateWorktree.
 * Both call sites keep their own failure behaviour (an unreadable dirt read
 * reads as clean — a throwing check is not a dirty tree) — only the
 * line-extraction shape was duplicated.
 */
export async function readDirtyPorcelainLines(
  execFn: ExecFn,
  cwd: string,
  timeoutMs = 60_000,
): Promise<string[]> {
  try {
    const { stdout } = await execp("git status --porcelain", {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l);
  } catch {
    return [];
  }
}

/** The worktree name the driver owns for this issue's commit-pr fallback. */
export function integrateWorktreeName(issue: number): string {
  return `issue-${issue}-integrate`;
}

/** The absolute path of the integration worktree for this issue. */
export function integrateWorktreePath(repoRoot: string, issue: number): string {
  return worktreePath(repoRoot, integrateWorktreeName(issue));
}

export interface IntegrateWorktreeCreation {
  /** The worktree's absolute path (logical form, not realpath-resolved). */
  path: string;
  /** The branch's HEAD after the add, or baseSha when the ref was absent. */
  refHead: string;
  /**
   * The stale tree's HEAD, recorded BEFORE its force-removal — the
   * re-entry's trace/plumb evidence (decision (2)). Absent on a fresh
   * creation (no stale tree existed).
   */
  staleHead?: string;
  /** #1173 — the ref the stale tree's unpushed commits were kept on, if any. */
  backupRef?: string;
  /**
   * #1396 (six-lens) — the sha the per-issue backup ref held BEFORE this call
   * replaced it. Present only on a re-entry whose ref already pointed at a
   * different commit: the ref is one per issue, so that older kept HEAD has
   * just lost its only named reference and the handoff must say so.
   */
  supersededSha?: string;
  /** True when the driver detached repoRoot off the branch to free it. */
  repoRootDetached: boolean;
}

/**
 * Create (or recreate) the driver-owned integration worktree, returning its
 * path. Throws on a dirty-repoRoot-that-holds-the-branch, a dirty stale
 * tree that could not be replaced, or a git failure of `worktree add`.
 *
 * The caller runs this INSIDE withIntegrationLock (the tree holds the
 * integration branch; a sibling's sweep/integration must not race it).
 */
export async function ensureIntegrateWorktree(
  execFn: ExecFn,
  opts: {
    repoRoot: string;
    issue: number;
    branchName: string;
    baseSha: string;
    /** #1362 — the cycle's `.pi/dirty-root-exempt` list (see `createIntegrateWorktree`). */
    dirtyRootExempt?: readonly string[];
  },
  stateFile?: string,
): Promise<IntegrateWorktreeCreation> {
  // #1173 — a failure AFTER the stale tree's commits were kept must still name
  // the ref, or the operator's halt has no pointer to the recoverable work.
  const kept: { ref?: string; supersededSha?: string } = {};
  try {
    return await createIntegrateWorktree(execFn, opts, stateFile, kept);
  } catch (err) {
    if (kept.ref === undefined || !(err instanceof Error)) throw err;
    // Annotate in place: the error keeps its class (DirtyWorktreeError stays one).
    // The ref also travels as a structured field, so the halt report can name
    // it without parsing the message (which the halt truncates).
    const note = ` (the stale integrate tree's unpushed commits were kept on ${kept.ref})`;
    const e = err as Error & { stderr?: unknown; backupRef?: string; supersededSha?: string };
    e.backupRef = kept.ref;
    if (kept.supersededSha !== undefined) e.supersededSha = kept.supersededSha;
    e.message += note;
    if (typeof e.stderr === "string" && e.stderr) e.stderr += note;
    throw err;
  }
}

async function createIntegrateWorktree(
  execFn: ExecFn,
  opts: {
    repoRoot: string;
    issue: number;
    branchName: string;
    baseSha: string;
    /**
     * #1362 — the cycle's exemption list. Read ONLY for the repoRoot dirt check
     * below: the integrate tree at `abs` is the driver's own integration
     * point, not the operator's checkout, so its dirt is judged with no list
     * — an exempted prefix never hides work from the commit that runs there.
     */
    dirtyRootExempt?: readonly string[];
  },
  stateFile: string | undefined,
  kept: { ref?: string; supersededSha?: string },
): Promise<IntegrateWorktreeCreation> {
  const { repoRoot, issue, branchName, baseSha } = opts;
  const name = integrateWorktreeName(issue);
  const abs = worktreePath(repoRoot, name);
  // #1170 — branchName and baseSha reach shell strings below.
  try {
    assertSafeRef(branchName);
    assertSafeRef(baseSha);
  } catch (err) {
    throw new Error(`integrate ref refused: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- preflight: what holds the branch, and who is where
  let branchHead: string | undefined;
  try {
    const { stdout } = await execFn(
      `git rev-parse --verify --quiet ${JSON.stringify(`refs/heads/${branchName}`)}`,
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    branchHead = stdout.trim();
    if (!branchHead || branchHead.length < 7) branchHead = undefined;
  } catch {
    branchHead = undefined;
  }
  // #1170 — branchHead is git output; fail closed before any removal.
  if (branchHead !== undefined) assertSafeRef(branchHead);

  // #1170 — the cycle's own worktrees (the develop trees) are excluded from
  // the sibling scan below; a dirty one still refuses, before any mutation.
  const cycleTrees = await readCycleWorktreePaths(stateFile);
  await refuseDirtyCycleTrees(execFn, cycleTrees, abs, repoRoot, baseSha);

  // The stale-tree re-entry: driver-owned residue of an earlier attempt of
  // this same cycle. Its HEAD is recorded, then it is force-removed BEFORE
  // the #475 target-path guard runs — the guard is unconditional and
  // never waived, so the driver removes its own stale tree first, making
  // the target absent when the guard inspects it (a fresh creation is the
  // same shape: the path simply does not exist, and a git command in a
  // nonexistent directory fails, which the guard's own catch treats as
  // "no work to lose", not a refusal).
  let repoRootDetached = false;
  let staleHead: string | undefined;
  let backupRef: string | undefined;
  let supersededSha: string | undefined;
  const registered = await isRegisteredWorktree(execFn, repoRoot, abs);
  // #861 round 3 — one branch decides the fate of a registered tree at the
  // integrate path: driver-owned (this cycle's state file records it) →
  // record the old HEAD and force-replace; NOT this cycle's (operator
  // residue at the same path) → a dirty one HALTS (the driver refuses to
  // destroy operator work), a clean one is pre-removed and the fresh
  // creation proceeds. In either case a registration whose directory is
  // already gone is a stale registration — `worktree remove --force` it so
  // the fresh `worktree add` does not hit "already exists".
  if (registered) {
    let registeredStill = true;
    try {
      await execFn("git rev-parse --verify --quiet HEAD", { cwd: abs, maxBuffer: 64 * 1024 });
    } catch {
      registeredStill = false;
    }
    if (!registeredStill) {
      trace(
        `work-driver: ${name} registered in the worktree list but gone from disk — removing the stale registration`,
      );
      await worktreeRemove(execFn, repoRoot, name, true);
    } else if (isIntegrateTreeInCycle(cycleTrees, abs)) {
      // Driver-owned re-entry: record the old HEAD (decision (2)'s
      // re-entry evidence), then replace.
      try {
        const { stdout } = await execFn("git rev-parse --verify --quiet HEAD", {
          cwd: abs,
          maxBuffer: 64 * 1024,
        });
        staleHead = stdout.trim() || undefined;
      } catch {
        staleHead = undefined;
      }
      // #1170 — a stale tree holding uncommitted or foreign work is refused,
      // not force-removed; #1173 — the cycle's own commits are backed up.
      const backup = await keepOrRefuseStaleIntegrateTree(
        execFn,
        repoRoot,
        abs,
        branchHead ?? baseSha,
        branchName,
        issue,
      );
      kept.ref = backup?.ref;
      kept.supersededSha = backup?.supersededSha;
      backupRef = backup?.ref;
      supersededSha = backup?.supersededSha;
      trace(
        `work-driver: stale ${name} worktree at ${abs} (old HEAD: ${staleHead ?? "unreadable"}) — driver-owned, force-removing and recreating`,
      );
      await worktreeRemove(execFn, repoRoot, name, true);
    } else {
      // Operator residue at the integrate path: a dirty one HALTS (the
      // driver never moves operator residue); a clean one is pre-removed
      // (the same shape as the "unregistered directory" case, where the
      // #475 target guard's own pre-remove handles it).
      const dirt = await readDirtyPorcelainLines(execFn, abs);
      if (dirt.length > 0) {
        throw new Error(
          `integrate path ${abs} holds a registered worktree NOT recorded in the cycle's state file (the state file records only the branch step's workstreams) and is dirty — the driver refuses to destroy operator residue: ${dirt
            .slice(0, 5)
            .join(", ")}`,
        );
      }
      // #1173 — clean is not "nothing to lose": a detached HEAD's commits
      // die with the tree, so they are kept on a backup ref first (a tree on
      // another branch holding unique commits throws instead).
      const backup = await backupIntegrateHead(
        execFn,
        abs,
        branchHead ?? baseSha,
        branchName,
        issue,
        repoRoot,
      );
      kept.ref = backup?.ref;
      kept.supersededSha = backup?.supersededSha;
      backupRef = backup?.ref;
      supersededSha = backup?.supersededSha;
      trace(
        `work-driver: registered worktree at ${abs} is NOT this cycle's (state file does not record it) and is clean — force-removing and recreating (the cycle already committed to replacing the integrate tree)`,
      );
      await worktreeRemove(execFn, repoRoot, name, true);
    }
  } else if (await pathExists(abs)) {
    // Registered nowhere, yet the directory exists: a leftover that is NOT
    // this driver's stale re-entry. The unconditional #475 target guard
    // below inspects it as any other pre-existing tree (a dirty one parks;
    // a clean one is pre-removed by the guard's own remove step).
    trace(`work-driver: unregistered directory at ${abs} — leaving it for the target guard`);
  }
  // ---- repoRoot must not hold the branch: git refuses the add otherwise
  if (branchHead && (await repoRootHoldsBranch(repoRoot, branchName))) {
    // The main working tree (repoRoot) is NOT in `git worktree list
    // --porcelain` — the worktree-list holder audit can never say repoRoot
    // holds the branch. The direct probe (repoRootHoldsBranch) is what
    // matters here: the main tree's own checkout is what git refuses to
    // duplicate into a second worktree, so a clean repoRoot on the branch
    // is DETACHED first (decision (1)), and a DIRTY one HALTS — the
    // driver never moves operator residue. The probe runs through the
    // production exec seam, so a test fake cannot fake the checkout.
    // #1362 — the UNFILTERED read, and the filter is applied to its result two
    // lines down rather than inside the reader: the raw lines are what the halt
    // message quotes, so an exempt line stays visible in the evidence while
    // being excluded from the decision. Deliberate asymmetry with the other
    // dirt gates, which filter inside the reader.
    const dirt = await readDirtyPorcelainLines(execFn, repoRoot);
    if (
      dirt.some(
        (l) => !isDriverManagedDirtLine(l) && !isConfiguredExemptDirtLine(l, opts.dirtyRootExempt),
      )
    ) {
      throw new Error(
        `repoRoot holds ${branchName} and is dirty — cannot detach it for the ${name} worktree: ${dirt
          .slice(0, 5)
          .join(", ")}`,
      );
    }
    const originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    })
      .then((r) => r.stdout.trim())
      .catch(async () =>
        (await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })).stdout.trim(),
      );
    // DETACHED HEAD: the main tree is on no branch — a plain
    // `git checkout <ref>` would move it ONTO the branch we are trying to
    // free (the trace would say "detached" while repoRoot still holds the
    // branch, and the strict audit would halt the next fallback). The
    // branch cannot be checked out twice, so a detached root is the only
    // place to park it.
    // #861 round 3 — a throwing detach is its OWN sub-cause, not a
    // creation failure: the caller's `integration-worktree-violation` cap
    // attributes the halt to worktree creation, so a transient git error
    // here must carry its own evidence to read correctly.
    try {
      await execFn(`git checkout --detach ${JSON.stringify(originalRef)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
    } catch (detachErr) {
      const detail = (
        (detachErr as Error & { stderr?: string }).stderr ??
        (detachErr as Error).message ??
        ""
      ).toString();
      throw new Error(
        `repoRoot holds ${branchName} and is clean, but the driver could not detach it (git checkout --detach failed): ${detail.slice(0, 200)}`,
      );
    }
    trace(
      `work-driver: detached repoRoot from ${branchName} (checked out ${originalRef}) so the ${name} worktree can hold it`,
    );
    repoRootDetached = true;
  }

  // ---- the #475/#545 create guards (still apply to the driver-owned tree)
  // The stale-integrate re-entry above was already force-removed (HEAD
  // recorded first), so the target path is ABSENT here — the unconditional
  // target-path guard sees a fresh creation, and the sibling scan still
  // refuses a foreign same-issue leftover. The driver-owned tree's OWN path
  // is in the in-cycle set: it is already handled above (nothing to
  // pre-remove), and the guard's own `git worktree add` "already exists"
  // error remains the signal for a clean in-cycle path.
  await runCreateGuards(
    execFn,
    {
      repoRoot,
      name,
      fromRef: branchHead ?? baseSha,
      callerVerifiedTargetAbsent: true,
    },
    [abs, ...cycleTrees],
  );

  const ref = branchHead ?? baseSha;
  // ATTACHED: the one documented exemption from #287's always-detached
  // invariant — the ops fallback child starts ON the branch (the prompt says
  // so). #1100/#1173 — the branch NAME, never its SHA: a SHA detached the
  // tree, so the child's commit never moved the branch, its `push -u origin
  // <branch>` pushed nothing, and the commit wedged the next re-entry.
  const add = branchHead
    ? `git worktree add ${JSON.stringify(abs)} ${JSON.stringify(branchName)}`
    : `git worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(abs)} ${JSON.stringify(baseSha)}`;
  await execFn(add, { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  // A bare worktree cannot run a project's own commands — the same
  // provisioning the branch step's worktreeCreate gives every workstream
  // tree (provisionWorktree never throws; a failure is a reported problem,
  // not a cycle killer).
  const provisioned = await provisionWorktree(execFn, repoRoot, abs);
  if (provisioned.problem) {
    trace(`work-driver: ${name} worktree provisioning incomplete — ${provisioned.problem}`);
  }
  return {
    path: abs,
    refHead: ref,
    ...(staleHead ? { staleHead } : {}),
    ...(backupRef ? { backupRef } : {}),
    ...(supersededSha ? { supersededSha } : {}),
    repoRootDetached,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
