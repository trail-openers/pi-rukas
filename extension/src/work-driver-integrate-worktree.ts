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
 *    HEAD is recorded, it is force-removed, and a fresh one is created.
 *    The #475/#545 create guards (runCreateGuards) still run on top.
 *  - If repoRoot itself holds the branch, it is detached first (under the
 *    caller's integration lock) when clean, and a dirty repoRoot halts —
 *    the driver never moves operator residue.
 *
 * All git goes through the caller's ExecFn (the same seam the rest of the
 * driver audits); nothing here runs at process.cwd().
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import { isDriverManagedDirtLine } from "./work-driver-branch-residue.ts";
import { runCreateGuards } from "./worktree-create-guard.ts";
import { provisionWorktree } from "./worktree-provision.ts";
import { resolvePath, worktreePath, worktreeRemove } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

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
  opts: { repoRoot: string; issue: number; branchName: string; baseSha: string },
): Promise<IntegrateWorktreeCreation> {
  const { repoRoot, issue, branchName, baseSha } = opts;
  const name = integrateWorktreeName(issue);
  const abs = worktreePath(repoRoot, name);

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

  // The stale-tree re-entry: driver-owned residue of an earlier attempt of
  // this same cycle. Its HEAD is recorded, then it is force-removed —
  // NOT operator residue (the #475/#545 guards below still run on top,
  // but a driver-owned stale tree must never park the cycle).
  let repoRootDetached = false;
  let staleHead: string | undefined;
  if (await pathExists(abs)) {
    try {
      const { stdout } = await execFn("git rev-parse --verify --quiet HEAD", {
        cwd: abs,
        maxBuffer: 64 * 1024,
      });
      staleHead = stdout.trim() || undefined;
    } catch {
      staleHead = undefined;
    }
    try {
      const { stdout } = await execFn("git status --porcelain", {
        cwd: abs,
        maxBuffer: 1024 * 1024,
      });
      trace(
        `work-driver: stale ${name} worktree at ${abs} (old HEAD: ${staleHead ?? "unreadable"}, dirty: ${
          stdout.split("\n").filter((l) => l.trim()).length > 0
        }) — driver-owned, force-removing and recreating`,
      );
    } catch {
      trace(
        `work-driver: stale ${name} worktree at ${abs} (old HEAD: ${staleHead ?? "unreadable"}) — driver-owned, force-removing and recreating`,
      );
    }
    await worktreeRemove(execFn, repoRoot, name, true);
  }

  // ---- repoRoot must not hold the branch: git refuses the add otherwise
  if (branchHead) {
    // The holder list comes from `git worktree list --porcelain`, which does
    // NOT include the main working tree (repoRoot itself) — so the list can
    // never say repoRoot holds the branch, and the dirty-repoRoot refusal
    // below would be dead code in the production executor. Probe repoRoot
    // DIRECTLY: the main tree's checkout IS what matters here.
    // The main working tree (repoRoot) is NOT in `git worktree list --porcelain`.
    // The pre-#861 code probed `branchHolders` (the worktree list) and compared
    // against `resolvePath(repoRoot)` — the main tree never appears there, so
    // the dirty-repoRoot refusal was dead code in the production executor. The
    // correct probe is repoRoot's own checkout.
    const holders = await branchHolders(execFn, repoRoot, branchName);
    const rootHolds = holders.some((h) => resolvePath(h) === resolvePath(repoRoot));
    if (rootHolds) {
      let dirt = "";
      try {
        ({ stdout: dirt } = await execFn("git status --porcelain", {
          cwd: repoRoot,
          maxBuffer: 1024 * 1024,
        }));
      } catch {
        dirt = "";
      }
      if (dirt.split("\n").some((l) => l.trim() && !isDriverManagedDirtLine(l))) {
        throw new Error(
          `repoRoot holds ${branchName} and is dirty — cannot detach it for the ${name} worktree: ${dirt
            .split("\n")
            .filter((l) => l.trim())
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
          (
            await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })
          ).stdout.trim(),
        );
      await execFn(`git checkout ${JSON.stringify(originalRef)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
      trace(
        `work-driver: detached repoRoot from ${branchName} (checked out ${originalRef}) so the ${name} worktree can hold it`,
      );
      repoRootDetached = true;
    }
  }

  // ---- the #475/#545 create guards (still apply to the driver-owned tree)
  // The stale-integrate re-entry above is driver-owned residue and was
  // handled; the guards still run on top so foreign leftovers of the same
  // issue are still refused the usual way. The driver-owned tree's OWN path
  // is excluded from the guards' in-cycle set: it is already handled (old
  // HEAD recorded + force-removed above), and re-inspecting it as a guard
  // refusal would treat driver-owned residue as operator residue.
  // #861 — `targetHandled` waives the TARGET-path #475 dirty inspection
  // (the path is either absent — fresh creation — or was just force-removed
  // by the re-entry); the SIBLING scan still runs (a foreign same-issue
  // leftover is still a hazard).
  const targetHandled = staleHead !== undefined || (await pathExists(abs)) === false;
  await runCreateGuards(execFn, { repoRoot, name, fromRef: branchHead ?? baseSha, targetHandled }, [
    abs,
  ]);

  const ref = branchHead ?? baseSha;
  // ATTACHED (no --detach): this is the one documented exemption from #287's
  // always-detached invariant — the tree CHECKS OUT the integration branch
  // so the ops fallback child starts on it (the prompt pins it as the only
  // permitted working tree).
  await execFn(`git worktree add ${JSON.stringify(abs)} ${JSON.stringify(ref)}`, {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  // A bare worktree cannot run a project's own commands — the same
  // provisioning the branch step's worktreeCreate gives every workstream
  // tree (provisionWorktree never throws; a failure is a reported problem,
  // not a cycle killer).
  const provisioned = await provisionWorktree(execFn, repoRoot, abs);
  if (provisioned.problem) {
    trace(`work-driver: ${name} worktree provisioning incomplete — ${provisioned.problem}`);
  }
  return { path: abs, refHead: ref, ...(staleHead ? { staleHead } : {}), repoRootDetached };
}

/**
 * The branch-holder audit (decision (4)). Parses `git worktree list
 * --porcelain` and REALPATH-resolves every listed path (the macOS
 * /private/var shape — #753) and returns the worktrees whose `branch`
 * attribute is `refs/heads/<branchName>`. The driver's post-dispatch audit
 * requires that list to contain only the integrate worktree (or be empty);
 * any other holder halts the cycle. Sibling worktree HEADs are NOT
 * compared — concurrent cycles legitimately commit in their own worktrees.
 *
 * Unreadable list → empty array (the safe direction: nothing to halt on;
 * the PR-verification gates still run the executed-evidence checks).
 */
export async function branchHolders(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<string[]> {
  let list: string;
  try {
    ({ stdout: list } = await execFn("git worktree list --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    return [];
  }
  const lines = list.split("\n");
  const holders: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]?.trim() ?? "";
    if (!l.startsWith("worktree ")) continue;
    // The worktree line is followed by its attribute lines (HEAD, branch,
    // detached) up to the next `worktree` marker — the branch we care about
    // is in the `branch` line, so walk forward (the #654 sweep pattern).
    let j = i + 1;
    let found = false;
    while (j < lines.length) {
      const attr = lines[j]?.trim() ?? "";
      if (attr.startsWith("worktree ")) break;
      if (attr === `branch refs/heads/${branchName}`) {
        holders.push(lines[i]?.slice("worktree ".length).trim() ?? "");
        found = true;
        break;
      }
      j++;
    }
    if (found) i = j;
  }
  return holders;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
