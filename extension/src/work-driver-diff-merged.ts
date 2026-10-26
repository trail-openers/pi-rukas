/**
 * work-driver-diff-merged — the multi-workstream fan-out, split from
 * `work-driver-diff.ts` (AGENTS.md §12 file-size limit).
 *
 * `readWorktreeDiff` (still in work-driver-diff.ts) answers the question about
 * ONE tree. This module answers it about a whole fan-out and assembles the
 * single document both review gates read, which is where the second set of
 * decisions lives: whether to emit `## workstream:` headers at all, how the
 * 1 MiB budget is shared across sibling bodies, and — since #1634 — whether the
 * merged result may be called EMPTY. That last one decides an approval, so it
 * derives from what the per-worktree reads REPORTED, never from the length of
 * the document the loop happened to build.
 */

import { execp } from "./exec.ts";
import { type WorktreeDiff, readWorktreeDiff } from "./work-driver-diff.ts";
import {
  MERGED_DIFF_PIECE_TRUNCATED,
  MERGED_DIFF_TRUNCATED_AT_TOTAL,
  MERGED_DIFF_WORKSTREAM_PREFIX,
} from "./work-driver-diff.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * PR3 multi-worktree variant of `fetchDiff`. Resolves the diff(s) for
 * the current /work cycle's workstreams:
 *  - N=1 (default workstream): single `git diff <baseSha>..HEAD` from the
 *    recorded worktree path, OR `ctx.repoRoot` as fallback when the
 *    worktrees map is empty (the B2 cwd-fallback, restored to working
 *    order by populating the map in Step 3 — single-task /work writes
 *    `{default: ctx.repoRoot}`).
 *  - N>1: one diff per worktree, concatenated with `## workstream: <id>`
 *    headers so reviewers (adversarial-developer + lens code-review-
 *    specialists) see one merged document with provenance. Per-branch
 *    fetch failures contribute an empty section rather than aborting
 *    the whole gather.
 * Total budget capped at 1 MiB cumulative; once exceeded the function
 * returns what it has plus a `[... truncated for size]` marker so
 * downstream prompts don't silently lose context.
 * file, so the producer and the reader cannot drift apart.
 */
export async function fetchAllDiffs(
  worktrees: Record<string, string>,
  repoRoot: string,
  baseSha?: string,
  exec: ExecFn = execp,
): Promise<WorktreeDiff> {
  const ids = Object.keys(worktrees);
  // N=1 path — the structural fix for B2. With Step 3 populating the
  // worktrees map (default → repoRoot for single-task), `worktrees[id]`
  // is always a string, never undefined.
  if (ids.length <= 1) {
    const cwd = ids.length === 1 ? worktrees[ids[0] ?? ""] : repoRoot;
    return readWorktreeDiff(cwd ?? repoRoot, baseSha, exec);
  }
  // N>1: gather all per-workstream diffs FIRST, then decide whether to
  // emit headers. PR7 — when every body is empty (e.g., all three
  // developer workstreams provider-errored mid-stream without committing
  // anything), return "" so PR6's `!diff.trim()` guard in runLens fires.
  // Pre-PR7, the `## workstream: <id>\n` headers alone made the returned
  // string non-empty and lens-review ran against header-only "diffs",
  // hallucinating findings against unrelated files (the /work 553
  // 2026-06-24 re-test cascade).
  const fetched: Array<{ id: string; body: string }> = [];
  const unreadable: string[] = [];
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) continue;
    const r = await readWorktreeDiff(wt, baseSha, exec);
    if (!r.ok) {
      unreadable.push(`${id} (${r.reason})`);
      continue;
    }
    // A workstream whose read is EMPTY contributes nothing to the merged
    // document, but it is not dropped from the count: the `fetched.every(...)`
    // test below needs it present, or an all-empty fan-out collapses to zero
    // entries and reads as "nothing was gathered" rather than "nothing to
    // review".
    fetched.push({ id, body: r.diff });
  }
  // #1634 — "every body is blank" and "every read failed" are different
  // answers, and the caller must not render the second as the first: an
  // empty merged diff means APPROVED on both review gates. Any unreadable
  // workstream makes the whole read unreadable, so one stale ref cannot
  // silently shrink the reviewed set.
  if (unreadable.length > 0) {
    return {
      ok: false,
      reason: `unreadable diff for ${unreadable.join(", ")}`,
    };
  }
  if (fetched.every((f) => !f.body.trim())) return { ok: true, diff: "", empty: true };

  // Mixed-or-full diff: emit headers + bodies with the same budget rules
  // as before. Header preserved even for empty bodies in this branch so
  // reviewers see "task-a had no changes" alongside "task-b had X".
  const TOTAL_CAP = 1024 * 1024;
  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const { id, body: piece } of fetched) {
    if (truncated) break;
    const header = `${MERGED_DIFF_WORKSTREAM_PREFIX}${id}\n`;
    const remaining = TOTAL_CAP - totalBytes - header.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const body =
      piece.length > remaining
        ? `${piece.slice(0, remaining)}\n${MERGED_DIFF_PIECE_TRUNCATED}`
        : piece;
    sections.push(header + body);
    totalBytes += header.length + body.length;
  }
  if (truncated) sections.push(`\n${MERGED_DIFF_TRUNCATED_AT_TOTAL}`);
  return { ok: true, diff: sections.join("\n"), empty: false };
}
