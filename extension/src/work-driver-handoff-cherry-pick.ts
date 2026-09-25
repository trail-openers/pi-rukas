/**
 * work-driver-handoff-cherry-pick — the SINGLE source of the cherry-pick
 * recovery command for a `dirty=false` (committed, unconsolidated) workstream,
 * shared by the recovery-step generator (work-driver-handoff-recovery-caps.ts)
 * and the cap-explanation blurb (work-driver-explain.ts).
 *
 * Two invariants, both load-bearing:
 *
 * - The command is ALWAYS qualified to the workstream's own worktree
 *   (`git -C <worktree> cherry-pick …`), so it runs correctly no matter which
 *   checkout the operator is in. The markdown surface (the one these lines
 *   were written for — it is posted from the repo root) emits the in-tree
 *   RELATIVE path (`.worktrees/issue-<N>-<id>`), which the chat surface's
 *   `requalifyLine` rewrites to the absolute path — the dedicated rule
 *   `git -C .worktrees/<x>…` → `git -C <repoRoot>/.worktrees/<x>…` — and
 *   leaves the pick itself untouched. A recorded absolute worktree path is
 *   collapsed to that in-tree form first: it is by definition
 *   `<repoRoot>/.worktrees/issue-<N>-<id>`, and the `repoRoot` prefix is
 *   exactly what `requalifyLine` re-adds on the chat side.
 *
 * - The command NEVER interpolates a placeholder. When the effective base
 *   SHA (`workstreamBaseShas[id] ?? baseSha`) is missing, the line is plain
 *   text telling the operator to locate the base first — no command.
 */

export type CherryPickLine = { kind: "command"; line: string } | { kind: "note"; line: string };

/**
 * Collapse a recorded worktree path to its in-tree relative form for the
 * markdown surface. Worktrees live at `<repoRoot>/.worktrees/<name>` — the
 * in-tree form is therefore `.worktrees/<basename>` for any well-formed
 * recorded path (absolute or relative); an unrecognised shape (e.g. the
 * legacy repoRoot record for N=1, where the worktree path IS the repo) is
 * returned unchanged.
 */
function inTreeWorktreePath(wt: string | undefined, issue: number, id: string): string {
  if (wt === undefined) return `.worktrees/issue-${issue}-${id}`;
  const idx = wt.lastIndexOf(".worktrees/");
  if (idx !== -1) {
    const name = wt.slice(idx + ".worktrees/".length).split("/")[0];
    if (name) return `.worktrees/${name}`;
  }
  return wt;
}

/**
 * Build the cherry-pick line for workstream `id`.
 *
 * @param issue      the cycle's issue number (for the worktree fallback path)
 * @param id         the workstream id
 * @param worktree   `pipelineState.worktrees[id]` — absolute or in-tree
 *                   (absolute paths are collapsed to `.worktrees/<basename>`);
 *                   the fallback relative path is used when absent
 * @param baseSha    `pipelineState.baseSha` (may be undefined — the no-SHA note)
 * @param ownBase    `pipelineState.workstreamBaseShas[id]` (may be undefined)
 * @param headSha    `pipelineState.commitShas[id]` (may be undefined → `..HEAD`)
 * @param comment    an optional trailing `# …` comment for the markdown surface
 */
export function cherryPickRecoveryFor(
  issue: number,
  id: string,
  opts: {
    worktree?: string;
    baseSha?: string;
    ownBase?: string;
    headSha?: string;
    comment?: string;
  },
): CherryPickLine {
  const base = opts.ownBase ?? opts.baseSha;
  if (!base) {
    return {
      kind: "note",
      line: `no cherry-pick command available — the base SHA was not recorded (no workstream base, no cycle base). Locate the worktree's base first (e.g. its merge-base with the mainline via \`git merge-base\`) and cherry-pick its commits from there manually.`,
    };
  }
  const pick = `cherry-pick ${base}..${opts.headSha ?? "HEAD"}`;
  const wt = inTreeWorktreePath(opts.worktree, issue, id);
  return {
    kind: "command",
    line: `git -C ${wt} ${pick}${opts.comment ? `   # ${opts.comment}` : ""}`,
  };
}
