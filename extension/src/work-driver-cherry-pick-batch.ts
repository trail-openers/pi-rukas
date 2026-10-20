/**
 * work-driver-cherry-pick-batch — #813 (file-size split): the atomic
 * cherry-pick batch `orchestrateCherryPick` runs, moved verbatim out of
 * work-driver-cherry-pick.ts to keep that module under the AGENTS.md §12 cap.
 *
 * Behaviour is unchanged except for what #813 added: on the first failing
 * pick the batch records WHICH workstream's pick failed and WHICH picks had
 * already applied cleanly, and hands that observation back as a
 * `CherryPickConflict` rather than the bare string `"conflict"` it used to
 * return. Nothing upstream could tell those two shapes apart before, so every
 * caller reported the same guessed "two workstreams edited the same lines;
 * the decomposition is incoherent" — see the conflict module for why that
 * guess is now the wrong advice.
 */
import { trace } from "./trace.ts";
import { type CherryPickConflict, conflictedFileFrom } from "./work-driver-cherry-pick-conflict.ts";
import type { CherryPickEntry, WorkStreamPickScope } from "./work-driver-cherry-pick.ts";
import { pickScopeBase } from "./work-driver-cherry-pick.ts";
import { isCommitOnBranch } from "./work-driver-integrate-commit.ts";

/**
 * Cherry-pick each workstream's FULL committed range (parent→child) onto
 * the integration branch — #728: the pre-#728 pick used only the worktree's
 * HEAD SHA, so a ≥2-commit workstream (the #723 shape) staged the last
 * commit's files and silently dropped the earlier ones.
 * The batch is atomic: on the first conflict the in-progress abort is
 * attempted and the `CherryPickConflict` discriminator is returned
 * explicitly (the pre-#750 `[]` return collapsed "all skipped" with
 * "conflict aborted" for a single-workstream batch). No partial picks
 * survive — the caller's verified restore (#750) unwinds every staged pick
 * and verifies the root.
 */
export async function cherryPickWorkstreams(
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
  opts: {
    repoRoot: string;
    branchName: string;
    /** Workstream id → worktree path. Only workstreams listed here are cherry-picked. */
    worktrees: Record<string, string>;
    /** SHA already applied from a previous attempt; keyed by workstream id. */
    commitShas: Record<string, string>;
    /** Scratch dir for conflict artifacts. */
    scratchDir?: string;
    /** Legacy single base the `baseSha..HEAD` range is measured against. */
    baseSha?: string;
    /** #794 — per-workstream own-range selection (see `WorkStreamPickScope`). */
    pickScope?: WorkStreamPickScope;
  },
): Promise<CherryPickEntry[] | CherryPickConflict> {
  // #813 — the exec seam is typed to the success shape in the public
  // signature, but the real one (`DriverContext["verifyExecFn"]`) also
  // resolves `stderr`, and an execFile rejection carries it on the Error.
  // The conflict branch reads both, so it sees git's named file whichever
  // shape the seam hands back.
  const gitErrText = (err: unknown): string => {
    const e = err as { stderr?: unknown; message?: unknown };
    return [
      typeof e?.stderr === "string" ? e.stderr : "",
      typeof e?.message === "string" ? e.message : "",
    ]
      .filter(Boolean)
      .join("\n");
  };
  const { repoRoot, branchName, worktrees, commitShas } = opts;
  const scope: WorkStreamPickScope = opts.pickScope ?? { globalBaseSha: opts.baseSha };
  const ids = Object.keys(worktrees);
  const entries: CherryPickEntry[] = [];
  const rangeFellBack = new Map<string, { workstreamId: string; error: string }>();
  let conflictedAt: string | undefined;
  let conflictedFile: string | undefined;
  // #813 — the picks that landed BEFORE the aborting one, so the caller can
  // say which workstream applied cleanly rather than guessing that both
  // sides edited the same lines.
  const appliedBeforeConflict = new Set<string>();
  // #728 — resolve each workstream's committed range (parent→child) once so
  // every SHA is deduplicated and picked in order; a range read failure
  // degrades to the legacy HEAD-only pick for that workstream (traced).
  const ranges: Record<string, string[]> = {};
  const rangeReadErrors = new Map<string, string>();
  for (const id of ids) {
    const wtPath = worktrees[id];
    if (!wtPath) continue;
    // #794 — the range base is the workstream's own effective base (its
    // dependency's tip when stacked) so ancestor commits are not re-picked.
    const rangeBase = pickScopeBase(id, scope);
    let list: string[] = [];
    if (rangeBase) {
      try {
        const { stdout } = await execFn(
          `git rev-list --reverse --first-parent ${JSON.stringify(rangeBase)}..HEAD`,
          { cwd: wtPath, maxBuffer: 1024 * 1024 },
        );
        list = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[0-9a-f]{7,}$/.test(l));
      } catch (err) {
        const msg = (err as Error).message?.slice(0, 200) ?? "unknown";
        rangeReadErrors.set(id, msg);
        trace(
          `work-driver: cherry-pick — could not list range for '${id}', falling back to HEAD only: ${msg}`,
        );
      }
    }
    if (list.length === 0) {
      const { stdout } = await execFn("git rev-parse HEAD", {
        cwd: wtPath,
        maxBuffer: 64 * 1024,
      });
      const sha = stdout.trim();
      if (sha && sha.length >= 7) list = [sha];
      // #728 (task-c) — a range-read failure degraded to the HEAD-only pick;
      // record it so the completeness evidence (task-a) can name the cause
      // instead of a bare dropped-path list.
      const rangeErr = rangeReadErrors.get(id);
      if (rangeErr) rangeFellBack.set(id, { workstreamId: id, error: rangeErr });
    }
    ranges[id] = list;
  }
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) continue;
    for (const sha of ranges[id] ?? []) {
      if (sha.length < 7) continue;
      // Check if this SHA is already on the integration branch.
      const alreadyOnBranch = await isCommitOnBranch(execFn, repoRoot, branchName, sha);
      if (alreadyOnBranch) {
        trace(
          `work-driver: cherry-pick — SHA ${sha.slice(0, 8)} for '${id}' already on branch, skipping`,
        );
        entries.push({ sha, status: "skipped", rangeReadError: rangeFellBack.get(id) });
        continue;
      }
      // Also skip if the SHA matches an already-recorded `commitShas` entry
      // for a DIFFERENT workstream (cross-workstream overlap).
      const recordSha = commitShas[id];
      if (recordSha && recordSha === sha) {
        trace(
          `work-driver: cherry-pick — SHA ${sha.slice(0, 8)} for '${id}' already recorded, skipping`,
        );
        entries.push({ sha, status: "skipped", rangeReadError: rangeFellBack.get(id) });
        continue;
      }
      // Cherry-pick the SHA.
      try {
        await execFn(`git cherry-pick --no-commit ${sha}`, {
          cwd: repoRoot,
          maxBuffer: 8 * 1024 * 1024,
        });
        entries.push({ sha, status: "cherry-picked", rangeReadError: rangeFellBack.get(id) });
        appliedBeforeConflict.add(id);
      } catch (gitErr) {
        // Cherry-pick failed — this is a conflict. Abort the batch and record
        // which workstream caused it, plus the file git named for the pick
        // (#813 — git prints the colliding path on its own stderr, so the
        // reporters can name a file without scanning free prose).
        conflictedAt = id;
        conflictedFile = conflictedFileFrom(gitErrText(gitErr));
        break;
      }
    }
  }
  // If any cherry-pick conflicted, attempt the in-progress abort and return
  // the explicit conflict marker. #750: `git cherry-pick --no-commit` often
  // leaves no CHERRY_PICK_HEAD, in which case `--abort` REFUSES (exit 128)
  // — that refusal is neither success nor the only recovery, so it is
  // traced and the caller's verified restore (`verifiedRestoreRoot`) is the
  // actual recovery, verified by its own porcelain read.
  if (conflictedAt !== undefined) {
    try {
      await execFn("git cherry-pick --abort", { cwd: repoRoot, maxBuffer: 64 * 1024 });
    } catch (abortErr) {
      trace(
        `work-driver: cherry-pick — abort refused after conflict in '${conflictedAt}' (no CHERRY_PICK_HEAD for a --no-commit pick; caller restores): ${(abortErr as Error).message?.slice(0, 200)}`,
      );
    }
    return {
      __conflict: true,
      conflictedAt,
      appliedBeforeConflict: [...appliedBeforeConflict],
      ...(conflictedFile !== undefined ? { conflictedFile } : {}),
    };
  }
  return entries;
}
