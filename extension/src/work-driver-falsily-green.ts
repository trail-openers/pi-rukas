/**
 * work-driver-falsily-green — #679 (task-evidence) per-worktree evidence check.
 *
 * Extracted from work-driver-verify-develop.ts (file-size cap, AGENTS.md §12).
 *
 * A workstream whose worktree has ZERO commits ahead of its effective base
 * AND whose changed files are entirely non-source (per the project's own
 * verify-cmd / language detection) AND whose OWN declared paths are entirely
 * non-source is NOT penalised — that is a genuine docs-only workstream
 * (e.g. `docs/*.md`). But a workstream whose declared paths are source yet
 * produced no source changes is falsely green: it claims done while
 * contributing nothing the transfer unit (a commit) would carry. That shape
 * records a failure here even though the dispatch's process-exit was green.
 *
 * The check is PER-WORKTREE, so one empty workstream no longer suppresses
 * the evidence for the rest of the fanout (the old `verdicts.every(ok)` gate
 * skipped the whole check on one failed sibling). Reuses `verifyCmdFor`'s
 * manifest signals via `declaredPathsHaveSource` / `isSourcePath` — no new
 * classifier is invented.
 *
 * It fires ONLY when the developer produced uncommitted work that was never
 * committed (the "did something but left it uncommitted" shape). A completely
 * empty worktree (clean + 0 commits) is the existing "empty diff" case, not
 * falsely-green, and the generic empty-diff message handles it.
 */

import type { VerifyExecFn } from "./work-driver-git.ts";
import { isSourcePath } from "./work-driver-verify-cmd.ts";

/** #679 — the global/per-workstream base must be a 40-char hex SHA. */
function isValidSha(s: string | undefined): s is string {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

/**
 * #679 (task-evidence) — run the per-worktree falsily-green evidence check.
 *
 * Mutates `failures` in place. `declaredSourceByWorkstream` is the pre-computed
 * per-workstream declared-source flag (shared with the uncommitted-only
 * suppression in verify-develop). `legitimateNonSourceWorkstreams` is a Set
 * that this function POPULATES with workstream ids whose declared paths are
 * entirely non-source, so the caller can suppress the generic empty-diff
 * message for them.
 */
export async function runFalsilyGreenCheck(
  execFn: NonNullable<VerifyExecFn>,
  repoRoot: string,
  worktrees: Record<string, string>,
  workstreamBaseShas: Record<string, string> | undefined,
  baseSha: string | undefined,
  changedPathsByWorkstream: Map<string, Set<string>>,
  declaredSourceByWorkstream: Map<string, boolean>,
  legitimateNonSourceWorkstreams: Set<string>,
  failures: string[],
): Promise<void> {
  const effectiveBaseFor = (wsId: string): string | undefined => {
    const per = workstreamBaseShas?.[wsId];
    if (isValidSha(per)) return per;
    if (isValidSha(baseSha)) return baseSha;
    return undefined;
  };

  for (const [id, cwd] of Object.entries(worktrees)) {
    const effBase = effectiveBaseFor(id);
    if (!effBase) continue; // no resolvable base → cannot prove emptiness; skip
    const ownSet = changedPathsByWorkstream.get(id) ?? new Set<string>();
    const ownChanged = [...ownSet];
    // The falsily-green check fires ONLY when the developer produced
    // uncommitted work that was never committed. A completely empty worktree
    // is the existing "empty diff" case, not falsely-green.
    let hasAnyWork = ownChanged.length > 0;
    let hasCommitsAhead = false;
    try {
      const { stdout } = await execFn(`git rev-list --count ${effBase}..HEAD`, {
        cwd,
        maxBuffer: 64 * 1024,
      });
      hasCommitsAhead = Number.parseInt(stdout.trim(), 10) > 0;
      if (hasCommitsAhead) hasAnyWork = true;
    } catch {
      // Effective base not in this worktree's history — treat as no commits.
    }
    if (!hasAnyWork) continue; // completely empty → empty-diff handles it
    if (hasCommitsAhead) continue; // genuine committed work — not falsely green
    const declaredSource = declaredSourceByWorkstream.get(id) ?? true;
    if (!declaredSource) {
      // Docs-only workstream — explicitly not penalised. Track it so the
      // generic empty-diff message is also suppressed for it.
      legitimateNonSourceWorkstreams.add(id);
      continue;
    }
    // Declared paths are source, and the workstream has uncommitted work but
    // zero commits ahead of base. Falsely green when ALL changed files are
    // non-source (the developer declared source but did only docs).
    const changedIsAllNonSource =
      ownChanged.length === 0 ||
      (
        await Promise.all(
          ownChanged.map(async (f) => {
            try {
              return !(await isSourcePath(f, repoRoot));
            } catch {
              return false; // cannot classify → assume source (don't penalise)
            }
          }),
        )
      ).every((s) => s);
    if (changedIsAllNonSource) {
      failures.push(
        `worktree "${id}": declared source paths but produced no source changes (zero commits ahead of its base, no source file touched) — the workstream is falsely green; it claimed done without contributing any source code`,
      );
    }
  }
}
