/**
 * work-driver-completeness — #728 (task-a) intended-vs-actual consolidation
 * completeness check. Extracted from work-driver-cherry-pick.ts to keep that
 * file under the 500-line limit.
 *
 * Compares what consolidation INTENDED to stage against what ACTUALLY landed,
 * from executed git evidence only.
 *
 * Intended = union over every committed workstream of
 * `git diff --name-only baseSha..worktree-HEAD` — the CUMULATIVE diff, so a
 * file that nets to zero across the workstream's commits (the #723 shape)
 * is correctly absent; no per-commit or file-count comparison false-alarms.
 * Landed = `baseSha..HEAD` at repoRoot plus the index (the `--no-commit`
 * picks are staged before the caller commits them). Paths are normalised
 * with `normaliseDeclaredPath` (work-driver-verify.ts) — the existing
 * normalisation, not a second one. Never throws: any git read failure is
 * `checkError`, which callers treat as "unverifiable" — never complete.
 */
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/** Shape of `OrchestratedCherryPickResult["completeness"]` (defined here to avoid a circular import). */
export interface ConsolidationCompleteness {
  intended: string[];
  landed: string[];
  droppedPaths: string[];
  checkError?: string;
}

export async function measureConsolidationCompleteness(
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
  opts: {
    repoRoot: string;
    worktrees: Record<string, string>;
    baseSha?: string;
    committedIds: string[];
  },
): Promise<ConsolidationCompleteness> {
  const { repoRoot, worktrees, baseSha, committedIds } = opts;
  const nameSet = async (cmd: string, cwd: string) => {
    const { stdout } = await execFn(cmd, { cwd, maxBuffer: 1024 * 1024 });
    return new Set(stdout.split("\n").map(normaliseDeclaredPath).filter(Boolean));
  };
  try {
    const intended = new Set<string>();
    for (const id of committedIds) {
      const wt = worktrees[id];
      if (!wt || !baseSha) continue;
      for (const p of await nameSet(`git diff --name-only ${JSON.stringify(baseSha)}..HEAD`, wt)) {
        intended.add(p);
      }
    }
    // Landed = the integration branch's cumulative diff plus the index (the
    // --no-commit picks are staged before the caller commits them).
    const landed = new Set<string>();
    if (baseSha) {
      const { stdout: headOut } = await execFn("git rev-parse HEAD", {
        cwd: repoRoot,
        maxBuffer: 64 * 1024,
      });
      const headSha = headOut.trim();
      if (headSha) {
        for (const p of await nameSet(
          `git diff --name-only ${JSON.stringify(baseSha)}..${JSON.stringify(headSha)}`,
          repoRoot,
        )) {
          landed.add(p);
        }
      }
    }
    for (const p of await nameSet("git diff --cached --name-only", repoRoot)) landed.add(p);
    const droppedPaths = [...intended].filter((p) => !landed.has(p)).sort();
    return {
      intended: [...intended].sort(),
      landed: [...landed].sort(),
      droppedPaths,
    };
  } catch (err) {
    return {
      intended: [],
      landed: [],
      droppedPaths: [],
      checkError: (err as Error).message?.slice(0, 200) ?? "completeness check failed",
    };
  }
}
