/**
 * work-driver-branch-mechanized — #287 Part A: branch setup as driver code.
 *
 * Pre-#287 the branch step narrated itself to an LLM ops subagent, which then
 * ran `git fetch/checkout/pull --ff-only` against repoRoot and, for N=1,
 * developed there directly (`worktrees = {default: repoRoot}`). That made
 * repoRoot a development tree, which is why:
 *
 *   - stale repoRoot residue was swept into a merged PR (incident #602);
 *   - an aborted step left a dirty tree that wedged every downstream issue's
 *     branch step;
 *   - parallel groups were impossible — two cycles would fight over one
 *     checkout.
 *
 * After #287 repoRoot is an INTEGRATION POINT ONLY. Nothing between branch and
 * commit-pr runs git against it. Every workstream — including the degenerate
 * N=1 `default` — gets `.worktrees/issue-<N>-<id>` detached at the resolved
 * base SHA, and patches are applied onto the feature branch at repoRoot by
 * `integrate()`.
 *
 * The branch itself is created lazily by `integrate()` via
 * `git checkout -B <branch> <baseSha>`; this step only resolves and records
 * the name, so a cycle that dies before producing a diff leaves no branch
 * behind.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";
import { worktreeCreate } from "./worktree.ts";

/** #287 escape hatch: PI_ENSEMBLE_ALWAYS_WORKTREE=0 restores the N=1 repoRoot behaviour. */
export function alwaysWorktreeEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_ALWAYS_WORKTREE;
  return v !== "0" && v !== "false";
}

/**
 * Deterministic branch slug. Replaces the LLM-authored name, which produced
 * `…-thinking-only-output` and `…-thinking-only-model-output` for the same
 * issue on consecutive runs (#358/#359) — two names for one issue defeats any
 * idempotency check keyed on the branch.
 */
export function branchSlug(issues: number[], title: string | undefined): string {
  const stem = issues.length === 1 ? `issue-${issues[0]}` : `issues-${issues.join("-")}`;
  const brief = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return brief ? `feature/${stem}-${brief}` : `feature/${stem}`;
}

/** Detect the mainline branch name, preferring origin's HEAD over a guess. */
export async function detectMainline(execFn: ExecFn, repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFn("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const ref = stdout.trim();
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  } catch {
    // origin/HEAD is often unset on clones; fall through to the probe below.
  }
  for (const candidate of ["main", "master"]) {
    try {
      await execFn(`git rev-parse --verify ${JSON.stringify(`origin/${candidate}`)}`, {
        cwd: repoRoot,
        maxBuffer: 64 * 1024,
      });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return "main";
}

/**
 * Keep `.worktrees/` out of the repo's own `git status`.
 *
 * Written to `.git/info/exclude` (per-clone) rather than `.gitignore`
 * (committed) so the driver never alters the project's tracked shape — the
 * same convention AGENTS.md §7 already mandates for `tmp/`.
 *
 * Not cosmetic: without it, the very worktrees this step creates read as
 * untracked residue at repoRoot, and `integrate()`'s dirty-root preflight
 * refuses to run — every cycle, forever. Caught by the real-git test, missed
 * by the mocked one, which is the whole argument for having both.
 */
export async function ensureWorktreesExcluded(execFn: ExecFn, repoRoot: string): Promise<void> {
  const excludePath = path.join(repoRoot, ".git", "info", "exclude");
  try {
    const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
    if (/^\.worktrees\/?$/m.test(existing)) return;
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await fs.appendFile(
      excludePath,
      `${sep}# pi-ensemble /work driver (#287) — per-cycle worktrees\n.worktrees/\n`,
      "utf8",
    );
  } catch (err) {
    // Best-effort: the preflight filters `.worktrees/` defensively too.
    trace(
      `work-driver: could not update .git/info/exclude: ${(err as Error).message?.slice(0, 120)}`,
    );
  }
}

export interface MechanizedBranchResult {
  branchName: string;
  baseSha: string;
  mainline: string;
  worktrees: Record<string, string>;
}

/**
 * Resolve the base, name the branch, and create one detached worktree per
 * workstream. Throws on any failure — the caller routes that to a
 * `dispatch-failed` on the branch step, which the router turns into a handoff.
 *
 * Deliberately does NOT touch repoRoot's checkout: no `checkout`, no `pull`.
 * `git fetch` is the sole repoRoot command and it mutates only refs, never the
 * working tree, so an operator's uncommitted work in the main checkout is
 * untouched and — unlike pre-#287 — no longer blocks the cycle at all.
 */
export async function mechanizedBranchSetup(
  execFn: ExecFn,
  repoRoot: string,
  issue: number,
  issues: number[],
  workstreamIds: string[],
  issueTitle: string | undefined,
): Promise<MechanizedBranchResult> {
  await ensureWorktreesExcluded(execFn, repoRoot);
  const mainline = await detectMainline(execFn, repoRoot);
  await execFn(`git fetch origin ${JSON.stringify(mainline)}`, {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  const { stdout: shaOut } = await execFn(`git rev-parse ${JSON.stringify(`origin/${mainline}`)}`, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024,
  });
  const baseSha = shaOut.trim();
  if (!baseSha) throw new Error(`could not resolve origin/${mainline} to a commit`);

  const branchName = branchSlug(issues, issueTitle);
  const ids = workstreamIds.length > 0 ? workstreamIds : ["default"];
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    worktrees[id] = await worktreeCreate(execFn, {
      repoRoot,
      name: `issue-${issue}-${id}`,
      fromRef: baseSha,
    });
  }
  trace(
    `work-driver: mechanized branch setup — ${branchName} @ ${baseSha.slice(0, 8)} (${ids.length} worktree(s))`,
  );
  return { branchName, baseSha, mainline, worktrees };
}
