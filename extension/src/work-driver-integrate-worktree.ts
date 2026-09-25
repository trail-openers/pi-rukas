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

import { exec as execCb } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import { isDriverManagedDirtLine } from "./work-driver-branch-residue.ts";
import { runCreateGuards } from "./worktree-create-guard.ts";
import { provisionWorktree } from "./worktree-provision.ts";
import { resolvePath, worktreePath, worktreeRemove } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

const execp = promisify(execCb);

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
  stateFile?: string,
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
  // this same cycle. Its HEAD is recorded, then it is force-removed BEFORE
  // the #475 target-path guard runs — the guard is unconditional and
  // never waived, so the driver removes its own stale tree first, making
  // the target absent when the guard inspects it (a fresh creation is the
  // same shape: the path simply does not exist, and a git command in a
  // nonexistent directory fails, which the guard's own catch treats as
  // "no work to lose", not a refusal).
  let repoRootDetached = false;
  let staleHead: string | undefined;
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
    } else if (await isIntegrateTreeInCycle(stateFile, abs)) {
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
      trace(
        `work-driver: stale ${name} worktree at ${abs} (old HEAD: ${staleHead ?? "unreadable"}) — driver-owned, force-removing and recreating`,
      );
      await worktreeRemove(execFn, repoRoot, name, true);
    } else {
      // Operator residue at the integrate path: a dirty one HALTS (the
      // driver never moves operator residue); a clean one is pre-removed
      // (the same shape as the "unregistered directory" case, where the
      // #475 target guard's own pre-remove handles it).
      let dirt = "";
      try {
        ({ stdout: dirt } = await execFn("git status --porcelain", {
          cwd: abs,
          maxBuffer: 1024 * 1024,
        }));
      } catch {
        dirt = "";
      }
      if (dirt.split("\n").some((l) => l.trim())) {
        throw new Error(
          `integrate path ${abs} holds a registered worktree NOT recorded in the cycle's state file (the state file records only the branch step's workstreams) and is dirty — the driver refuses to destroy operator residue: ${dirt
            .split("\n")
            .filter((l) => l.trim())
            .slice(0, 5)
            .join(", ")}`,
        );
      }
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
    [abs],
  );

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
 * Whether the MAIN working tree (repoRoot) currently holds the branch.
 * `git worktree list --porcelain` never lists the main tree, so the
 * branch-holder audit and the repoRoot-detach path can both see it only
 * via this direct probe of its own checkout.
 *
 * Error classes are distinguished, because "cannot answer" and "holds the
 * branch" have OPPOSITE consequences:
 *  - "not a git repository" (stderr) or ENOENT (the directory is gone) →
 *    FALSE. A directory that is not a repository cannot hold a branch, so
 *    reading it as holding would halt clean cycles with a spurious
 *    `integration-worktree-violation` (the #861 shape: the fallback audit
 *    probed a temp repoRoot that is not a repo and the fail-closed default
 *    read it as the offending holder).
 *  - ANY OTHER git error (a lock, permission, timeout) → TRUE (fail closed
 *    with a trace): there is a repo there we simply could not read, and a
 *    possibly-holding tree must not be exculpated (the #861 defect: a
 *    failing probe read as "does not hold").
 */
export async function repoRootHoldsBranch(repoRoot: string, branchName: string): Promise<boolean> {
  if (!branchName) return false;
  // The probe ALWAYS runs through the production exec seam (not execFn):
  // the repoRoot holder is the one `git worktree list` refuses to report,
  // and a test fake's `git symbolic-ref` short-circuit must not be able to
  // make the probe fail and exculpate that holder. The primary probe is
  // `symbolic-ref`; a DETACHED HEAD returns non-empty output but the wrong
  // ref, so a detached root reads as not-holding. A truly unreadable
  // symbolic-ref (not a clean empty) cannot be distinguished from a
  // detached HEAD via that command, so the `git status` fallback
  // disambiguates: its "## branch..." line carries the checkout name.
  const probe = async (cmd: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execp(cmd, {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      });
      return stdout;
    } catch (err) {
      const e = err as Error & { code?: string; stderr?: string };
      const detail = e.stderr ?? e.message ?? "";
      if (/not a git repository/i.test(detail) || e.code === "ENOENT") {
        // A directory that is not a repository (or is gone) cannot hold a
        // branch — the fail-closed default would halt clean cycles over
        // what is actually nothing (the #861 spurious-violation shape).
        trace(
          `work-driver: repoRoot holder probe for ${branchName} — ${repoRoot} is not a git repository (or is gone) — it cannot hold the branch`,
        );
        return "not-a-repo";
      }
      trace(
        `work-driver: repoRoot holder probe failed for ${branchName} — treating as possibly holding (fail closed): ${String(detail).slice(0, 200)}`,
      );
      return undefined;
    }
  };
  const refProbe = await probe("git symbolic-ref --quiet --short HEAD");
  if (refProbe === "not-a-repo") return false;
  if (refProbe !== undefined) return refProbe.trim() === branchName;
  const statusOut = await probe("git status --porcelain=v1 -b --untracked-files=normal");
  if (statusOut === "not-a-repo") return false;
  if (statusOut === undefined) return true;
  const line = statusOut.split("\n")[0] ?? "";
  const m = /^## ([^\s.]+)/.exec(line);
  return m !== null && m[1] === branchName;
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
export type BranchHoldersResult = { ok: true; holders: string[] } | { ok: false; error: string };

export async function branchHolders(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<BranchHoldersResult> {
  let list: string;
  try {
    ({ stdout: list } = await execFn("git worktree list --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
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
  return { ok: true, holders };
}

/**
 * #861 round 2 — the stale-tree ownership check. The state file (the cycle's
 * `.pi/work-state/<issue>.json`) records the branch step's worktree map
 * (id → path). If the integrate path appears in that map, the tree at that
 * path is driver-owned re-entry residue (this cycle created it). If it does
 * NOT appear, the tree is NOT this cycle's — it is operator residue the
 * driver must not silently destroy (a dirty one HALTS; a clean one is
 * pre-removed by the #475 target guard below).
 *
 * An unreadable state file returns false (the safe direction: the path is
 * then treated as NOT this cycle's, so a dirty one halts rather than being
 * silently destroyed; a clean one is pre-removed and the fresh creation
 * proceeds — the same shape as the "unregistered directory" case).
 */
async function isIntegrateTreeInCycle(
  stateFile: string | undefined,
  abs: string,
): Promise<boolean> {
  if (!stateFile) return false;
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as {
      pipelineState?: {
        worktrees?: Record<string, string>;
        integrateWorktree?: string;
      };
    };
    const ps = parsed.pipelineState ?? {};
    const worktrees = ps.worktrees ?? {};
    const target = resolvePath(abs);
    if (ps.integrateWorktree !== undefined && resolvePath(ps.integrateWorktree) === target) {
      return true;
    }
    return Object.values(worktrees).some((p) => resolvePath(p) === target);
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the path is a REGISTERED worktree (`git worktree list --porcelain`
 * contains it). This is the driver's stale-tree discriminator: a registered
 * tree at the integrate path is driver-owned re-entry residue (an earlier
 * attempt of this same cycle created it), so it is force-replaced. A
 * directory that exists but is registered NOWHERE is not driver-owned
 * residue — it is left for the unconditional #475 target guard, which
 * refuses a dirty one.
 *
 * Unreadable list → false (the safe direction: the path, if anything is
 * there, is then left to the guard rather than force-removed).
 */
async function isRegisteredWorktree(
  execFn: ExecFn,
  repoRoot: string,
  abs: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFn("git worktree list --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const target = resolvePath(abs);
    return stdout
      .split("\n")
      .some(
        (l) =>
          l.trim().startsWith("worktree ") &&
          resolvePath(l.trim().slice("worktree ".length)) === target,
      );
  } catch {
    return false;
  }
}
