/**
 * work-driver-fix-pass-strays-copies — the byte-copy half of the revert's
 * preservation: the untracked strays, which live in no commit and no diff.
 *
 * Split from `work-driver-fix-pass-strays.ts` for the AGENTS.md §12 size gate,
 * and the seam is real rather than mechanical: this file does no git at all. It
 * copies bytes and verifies them, which is the property an untracked stray needs
 * — the ref holds only what was committed and the patch only what is tracked, so
 * for a file git has never been told about the copy IS the record, and a copy that
 * silently came out short is the revert destroying the only copy that ever held it.
 * The reason therefore names WHICH file failed and how: a refusal that cannot be
 * acted on is a park the operator cannot diagnose.
 */

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { errText } from "./work-develop-git.ts";
import type { StrayState } from "./work-driver-fix-pass-strays-state.ts";
import type { FixPassStraysRequest } from "./work-driver-fix-pass-strays.ts";
import { fixPassStraysUntrackedDir } from "./work-driver-fix-pass-strays.ts";

/** Copy each untracked stray beside the patch, keeping its path relative to the
 *  worktree, and VERIFY each copy before the caller is allowed to remove the
 *  source. Same size, then same bytes — the source is still on disk at this
 *  point, so the comparison is made against it rather than trusted. */
export function copyUntracked(
  req: FixPassStraysRequest,
  state: StrayState,
): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const copied: string[] = [];
  for (const file of state.strays) {
    if (!state.untracked.has(file) || !state.present.has(file)) continue;
    const source = join(req.worktree, file);
    const dest = join(fixPassStraysUntrackedDir(req.scratchDir), relative(req.worktree, source));
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    } catch (err) {
      return {
        ok: false,
        reason: `${JSON.stringify(file)} could not be copied to ${dest}: ${errText(err)}`,
      };
    }
    // The copy is the only record an untracked file has, so it is confirmed
    // against the source rather than trusted: same size, then same bytes.
    try {
      const src = readFileSync(source);
      const dst = readFileSync(dest);
      if (src.length !== dst.length || !src.equals(dst))
        return {
          ok: false,
          reason: `${JSON.stringify(file)} copied to ${dest} does not match the source (${dst.length} byte(s) against ${src.length})`,
        };
    } catch (err) {
      return {
        ok: false,
        reason: `${JSON.stringify(file)} could not be read back from ${dest} to confirm the copy: ${errText(err)}`,
      };
    }
    copied.push(file);
  }
  return { ok: true, paths: copied };
}
