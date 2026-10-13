/**
 * git-range — the PR range and its commit count (#1134).
 *
 * Shared by the driver's diff reader, the verify gates and the comment-retention
 * check, so every PR-shaped git read names its range the same way. Imports
 * nothing from work-driver-*: it is a neutral leaf, which keeps those modules
 * from depending on each other through it.
 */

import type { ExecFn } from "./worktree.ts";

/**
 * The PR range as one string: `<base>...<head>`, the diff from the merge base to
 * `head`. Callers pass fully-qualified refs (`origin/<base>`, `origin/<branch>`),
 * or a local ref where the site runs before the push. Two-dot is never used for
 * a PR: it diffs tip against tip, so a base that moved after the branch was cut
 * reads as reverted files.
 */
export function prRange(base: string, head: string): string {
  return `${base}...${head}`;
}

/**
 * Does `ref` resolve to a commit in this clone? Runs through argv, so a branch
 * name never reaches a shell. Any failure is "does not resolve" — the caller
 * names what that means for its gate (#1134 follow-up: a pushed-ref precondition).
 */
export async function refResolves(exec: ExecFn, cwd: string, ref: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", {
      argv: ["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
      cwd,
      maxBuffer: 64 * 1024,
    });
    return /^[0-9a-f]{40,64}$/.test(stdout.trim());
  } catch {
    return false;
  }
}

/**
 * The PR's own commits: `rev-list --count --right-only <range>`, i.e. commits
 * reachable from `head` and not from `base`. Returns NaN when git's reply is not
 * a plain count; callers treat NaN as unknown, never as zero. An exec failure
 * rejects. `--end-of-options` keeps the refs from being read as flags.
 */
export async function countPrCommits(
  exec: ExecFn,
  cwd: string,
  base: string,
  head: string,
  opts: { pathspec?: string[]; timeout?: number } = {},
): Promise<number> {
  const pathspec = opts.pathspec ?? [];
  const { stdout } = await exec("git", {
    argv: [
      "rev-list",
      "--count",
      "--right-only",
      "--end-of-options",
      prRange(base, head),
      ...(pathspec.length > 0 ? ["--", ...pathspec] : []),
    ],
    cwd,
    timeout: opts.timeout,
    maxBuffer: 64 * 1024,
  });
  const t = stdout.trim();
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}
