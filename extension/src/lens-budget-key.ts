/**
 * lens-budget-key — the ledger key a `dispatch_lens_review` run is budgeted
 * and recorded under (#1127).
 *
 * The round budget (lens-round-cap.ts) is per ledger key. A run whose branch
 * resolves directly (explicit `branch`, a branch-named `head`, or the
 * checkout's branch) is keyed on that branch. When it does not — a detached
 * checkout, or a bare commit SHA as `head` — the key falls back, in order:
 *
 *   1. the PR's head branch, when a `pr` number is given (`gh pr view`);
 *   2. the ONE local branch whose tip is the head commit (`git branch
 *      --points-at`); two or more matches are ambiguous and fall through;
 *   3. `detached:<40-hex head SHA>` — a synthetic key no branch can carry, so
 *      the merge guard (which matches real branch names) ignores it.
 *
 * A head that does not resolve to a commit has no key at all: the caller
 * refuses (no unbudgeted path remains). Never throws.
 */

import { execp } from "./exec.ts";
import { prBaseBranchCmd, prHeadBranchCmd } from "./forge-commands.ts";
import { detectForge } from "./forge-detect.ts";
import { resolveLensReviewBranch } from "./lens-review-branch-resolve.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import { trace } from "./trace.ts";

export type BudgetKeySource = "branch" | "pr" | "points-at" | "detached";

export type BudgetKey =
  | { key: string; source: BudgetKeySource }
  | { key: undefined; reason: string };

/** The head commit's local branch, when exactly one local branch points at it. */
async function soleBranchAt(cwd: string, sha: string): Promise<string | undefined> {
  try {
    const { stdout } = await execp("git", {
      cwd,
      // for-each-ref over refs/heads: `git branch` would also list the
      // `(HEAD detached from …)` pseudo-entry, which is not a branch.
      argv: [
        "-C",
        cwd,
        "for-each-ref",
        "--points-at",
        sha,
        "--format=%(refname:short)",
        "refs/heads",
      ],
      maxBuffer: 64 * 1024,
    });
    const names = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return names.length === 1 ? names[0] : undefined;
  } catch (err) {
    trace(`lens-budget-key: branch lookup failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** The PR's head branch (`gh pr view`), or undefined when unavailable. */
async function prHeadBranch(cwd: string, pr: number): Promise<string | undefined> {
  try {
    const { stdout } = await execp(prHeadBranchCmd("github", pr), {
      cwd,
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    const raw = JSON.parse(stdout) as { headRefName?: unknown };
    return typeof raw.headRefName === "string" && raw.headRefName ? raw.headRefName : undefined;
  } catch (err) {
    trace(`lens-budget-key: PR head lookup failed: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * The PR's BASE branch — the branch the PR merges INTO, which is what a
 * review's patch identity is taken against.
 *
 * This is the working side of the mainline/working-base split: a project whose
 * release flow is `feature → staging → (operator publishes prod from main by
 * hand)` keeps `origin/HEAD` on `main` while every PR is opened against
 * `staging`. The round budget and the ledger row follow the PR, so both ask
 * here rather than assuming the production line; the PRODUCTION merge gate
 * (`mergeIdentity`) never calls it and still requires the mainline (#1305).
 *
 * The answer comes from the forge, not from git: `baseRefName` (GitHub) /
 * `target_branch` (GitLab) are the same fields the #912 guard reads for its
 * own comparison, so the review and the guard ask one question of one source.
 * It is read through the canonical `prBaseBranchCmd` seam (forge-commands.ts),
 * NOT through the full `prView` adapter: that command's field list carries
 * `body`, and a PR body is untrusted text that would land in this process's
 * memory for no reason when one bare field answers the question.
 *
 * Returns undefined whenever the base is not knowable (no `pr`, unknown forge,
 * no CLI, malformed JSON) — every caller falls back to the mainline, which is
 * today's behaviour, so a failed read costs nothing but the fallback.
 */
export async function prBaseBranchFor(
  cwd: string,
  pr: number | undefined,
): Promise<string | undefined> {
  if (!Number.isInteger(pr) || (pr as number) <= 0) return undefined;
  const number = pr as number;
  try {
    const detection = await detectForge(cwd, { allowProbe: false });
    if (detection.forge === "unknown") {
      trace(`lens-budget-key: forge unknown for ${cwd} — PR #${number} base branch not resolved`);
      return undefined;
    }
    const { stdout } = await execp(prBaseBranchCmd(detection.forge, number), {
      cwd,
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    const raw = JSON.parse(stdout) as { baseRefName?: unknown; target_branch?: unknown };
    const value = detection.forge === "github" ? raw.baseRefName : raw.target_branch;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch (err) {
    trace(`lens-budget-key: PR #${number} base lookup failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** Resolve the ledger key a run is budgeted and recorded under (module header). */
export async function resolveBudgetKey(opts: {
  cwd: string;
  head?: string;
  pr?: number;
}): Promise<BudgetKey> {
  const resolved = await resolveBudgetKeyInner(opts);
  const shown = resolved.key ?? resolved.reason;
  trace(`lens-budget-key: head ${opts.head ?? "HEAD"} → ${shown}`);
  return resolved;
}

async function resolveBudgetKeyInner(opts: {
  cwd: string;
  head?: string;
  pr?: number;
}): Promise<BudgetKey> {
  const { branch } = await resolveLensReviewBranch({ head: opts.head, cwd: opts.cwd });
  if (branch) return { key: branch, source: "branch" };
  if (Number.isInteger(opts.pr) && (opts.pr as number) > 0) {
    const pr = await prHeadBranch(opts.cwd, opts.pr as number);
    if (pr) return { key: pr, source: "pr" };
  }
  const sha = await resolveHeadSha(opts.cwd, opts.head ?? "HEAD", execp);
  if (!sha) {
    return {
      key: undefined,
      reason: `the head ${JSON.stringify(opts.head ?? "HEAD")} does not resolve to a commit`,
    };
  }
  const sole = await soleBranchAt(opts.cwd, sha);
  if (sole) return { key: sole, source: "points-at" };
  return { key: `detached:${sha}`, source: "detached" };
}
