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
export async function ensureWorktreesExcluded(_execFn: ExecFn, repoRoot: string): Promise<void> {
  await ensureGitExclude(repoRoot, [".worktrees/"]);
}

/**
 * Add lines to `.git/info/exclude` as ONE atomic read-modify-write.
 *
 * Two callers append to this file — this one and `setupWorkspaceTmp` (for
 * `tmp/`) — and both previously did a non-atomic read-then-write. Interleaved,
 * the `writeFile` overwrite clobbers whatever the other just appended. Losing
 * the `.worktrees/` line is not cosmetic: every worktree file then shows in
 * repoRoot's `git status --porcelain`, and while `integrate()`'s preflight
 * filters it defensively, nothing else does.
 *
 * tmp-file + rename, the same shape `writeState` uses, so a concurrent reader
 * never observes a half-written file.
 *
 * `.git/info/exclude` rather than `.gitignore`: per-clone, so the driver never
 * alters the project's tracked shape — the convention AGENTS.md §7 already
 * mandates for `tmp/`.
 */
let excludeChain: Promise<unknown> = Promise.resolve();

export function ensureGitExclude(repoRoot: string, lines: string[]): Promise<void> {
  // Serialised, not merely atomic. tmp-file + rename makes each WRITE atomic,
  // but two callers that read the same original and each write their own
  // version still lose one update — which is precisely the bug: whichever
  // wrote second silently dropped the other's line. The chain makes the whole
  // read-modify-write the unit.
  const run = excludeChain.then(
    () => ensureGitExcludeInner(repoRoot, lines),
    () => ensureGitExcludeInner(repoRoot, lines),
  );
  excludeChain = run.catch(() => undefined);
  return run;
}

async function ensureGitExcludeInner(repoRoot: string, lines: string[]): Promise<void> {
  const excludePath = path.join(repoRoot, ".git", "info", "exclude");
  try {
    const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
    const missing = lines.filter(
      (l) => !new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(existing),
    );
    if (missing.length === 0) return;
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const body = `${existing}${sep}# pi-ensemble /work driver\n${missing.join("\n")}\n`;
    const tmp = `${excludePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, excludePath);
  } catch (err) {
    // Best-effort: integrate()'s preflight filters `.worktrees/` defensively.
    trace(
      `work-driver: could not update .git/info/exclude: ${(err as Error).message?.slice(0, 120)}`,
    );
  }
}

let inFlightFetch: { key: string; p: Promise<unknown> } | undefined;

/** Coalesce concurrent `git fetch origin <ref>` calls into one. */
async function sharedFetch(execFn: ExecFn, repoRoot: string, ref: string): Promise<void> {
  const key = `${repoRoot}::${ref}`;
  if (inFlightFetch?.key === key) {
    await inFlightFetch.p.catch(() => undefined);
    return;
  }
  const p = execFn(`git fetch origin ${JSON.stringify(ref)}`, {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  inFlightFetch = { key, p };
  try {
    await p;
  } finally {
    if (inFlightFetch?.p === p) inFlightFetch = undefined;
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
  // Concurrent fetches of the SAME ref collide on `packed-refs.lock` and
  // throw, which `runBranch` catches and demotes to the LLM ops fallback —
  // so a group silently loses mechanized setup for a transient lock. Groups
  // starting together all want the same ref, so one shared in-flight fetch
  // serves them all.
  await sharedFetch(execFn, repoRoot, mainline);
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
