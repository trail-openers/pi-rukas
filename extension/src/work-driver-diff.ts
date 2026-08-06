/**
 * work-driver-diff — git-shell diff fetchers and reply-parsing leaves.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure git-
 * shell + text-parsing helpers with no DriverContext dependency, used
 * throughout the step handlers (still in work-driver.ts, moving to their
 * own files in a later pass) to resolve worktree diffs and parse ops/
 * branch subagent replies.
 */

import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * Resolve a diff for the given working directory.
 *
 * PR2 (post-#553 live test): the v1 stub returned "" unconditionally,
 * which meant adversarial-developer reviewed nothing and trivially
 * approved every cycle ("VERDICT: APPROVED — no code changes to review"
 * was the literal text from the live transcript). The fix shells out to
 * `git -C <cwd> diff` for both staged and unstaged changes (`git diff
 * HEAD` covers both) so the orchestrator's subagents work against the
 * actual worktree state.
 *
 * Failure modes return "":
 *  - cwd is undefined (no worktree resolved yet — early steps before
 *    branch creation)
 *  - cwd isn't a git repo
 *  - `git diff` returned non-zero or threw (e.g., permissions)
 *
 * The subagent prompts already include the cwd; an empty-diff result
 * lets adversarial / lens-review hint correctly ("nothing changed, no
 * review needed"). The hard cap on diff size (1 MiB) prevents a runaway
 * worktree state from bloating the dispatch prompt — pi-ai providers
 * have their own context limits and a 1 MB diff is already a red flag.
 */
export async function fetchDiff(cwd: string | undefined): Promise<string> {
  if (!cwd) return "";
  try {
    const { stdout } = await execp("git diff HEAD", {
      cwd,
      maxBuffer: 1024 * 1024, // 1 MiB cap
    });
    return stdout;
  } catch (err) {
    trace(`work-driver: fetchDiff(${cwd}) failed: ${(err as Error).message?.slice(0, 200)}`);
    return "";
  }
}

/**
 * PR3 multi-worktree variant of `fetchDiff`. Resolves the diff(s) for
 * the current /work cycle's workstreams:
 *
 *  - N=1 (default workstream): single `git diff HEAD` from the recorded
 *    worktree path, OR `ctx.repoRoot` as fallback when the worktrees
 *    map is empty (the B2 cwd-fallback, restored to working order by
 *    populating the map in Step 3 — single-task /work writes
 *    `{default: ctx.repoRoot}`).
 *
 *  - N>1: one diff per worktree, concatenated with `## workstream: <id>`
 *    headers so reviewers (adversarial-developer + lens code-review-
 *    specialists) see one merged document with provenance. Per-branch
 *    fetch failures contribute an empty section rather than aborting
 *    the whole gather.
 *
 * Total budget capped at 1 MiB cumulative; once exceeded the function
 * returns what it has plus a `[... truncated for size]` marker so
 * downstream prompts don't silently lose context.
 */
async function fetchAllDiffs(worktrees: Record<string, string>, repoRoot: string): Promise<string> {
  const ids = Object.keys(worktrees);
  // N=1 path — the structural fix for B2. With Step 3 populating the
  // worktrees map (default → repoRoot for single-task), `worktrees[id]`
  // is always a string, never undefined.
  if (ids.length <= 1) {
    const cwd = ids.length === 1 ? worktrees[ids[0] ?? ""] : repoRoot;
    return fetchDiff(cwd ?? repoRoot);
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
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) continue;
    fetched.push({ id, body: await fetchDiff(wt) });
  }
  if (fetched.every((f) => !f.body.trim())) return "";

  // Mixed-or-full diff: emit headers + bodies with the same budget rules
  // as before. Header preserved even for empty bodies in this branch so
  // reviewers see "task-a had no changes" alongside "task-b had X".
  const TOTAL_CAP = 1024 * 1024;
  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const { id, body: piece } of fetched) {
    if (truncated) break;
    const header = `## workstream: ${id}\n`;
    const remaining = TOTAL_CAP - totalBytes - header.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const body = piece.length > remaining ? `${piece.slice(0, remaining)}\n[... truncated]` : piece;
    sections.push(header + body);
    totalBytes += header.length + body.length;
  }
  if (truncated) sections.push("\n[... merged diff truncated at 1 MiB total]");
  return sections.join("\n");
}

/**
 * #287 — the integrated diff, read at repoRoot from the pushed branch:
 * `origin/<mainline>..origin/<branch>`. This is the shape lens-review wants
 * once `integrate()` has committed and pushed, and it is independent of any
 * worktree's HEAD (which stays detached at baseSha). Best-effort: any failure
 * returns empty and the caller falls back to the per-worktree read.
 */
export async function fetchIntegratedDiff(repoRoot: string, branchName: string): Promise<string> {
  try {
    const { stdout: head } = await execp(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { cwd: repoRoot, shell: "/bin/bash" },
    );
    const base = head.trim() || "main";
    const { stdout } = await execp(`git diff origin/${base}..origin/${branchName}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    trace(
      `work-driver: fetchIntegratedDiff(${branchName}) failed: ${(err as Error).message?.slice(0, 200)}`,
    );
    return "";
  }
}

/**
 * PR11 — the integration-branch-vs-mainline diff read from INSIDE a worktree
 * (`git diff origin/<base>..HEAD`). Correct whenever the worktree's HEAD
 * actually advances — i.e. the legacy PI_ENSEMBLE_ALWAYS_WORKTREE=0 shape,
 * where development happens on the branch itself. Under always-worktree the
 * worktree stays detached at baseSha, so `fetchIntegratedDiff` above is the
 * one that sees the commits.
 */
async function fetchMergedDiff(cwd: string | undefined): Promise<string> {
  if (!cwd) return "";
  try {
    const { stdout: head } = await execp(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { cwd, shell: "/bin/bash" },
    );
    const base = head.trim() || "main";
    const { stdout } = await execp(`git diff origin/${base}..HEAD`, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    trace(`work-driver: fetchMergedDiff(${cwd}) failed: ${(err as Error).message?.slice(0, 200)}`);
    return "";
  }
}

/**
 * PR11 — Multi-worktree counterpart to `fetchMergedDiff`. Same N=1
 * vs N>1 shape as `fetchAllDiffs`, same headers + 1 MiB cap + empty-
 * aware return — just uses `fetchMergedDiff` instead of `fetchDiff` so
 * post-commit lens-review sees the integrated diff against mainline.
 */
export async function fetchAllMergedDiffs(
  worktrees: Record<string, string>,
  repoRoot: string,
  branchName?: string,
): Promise<string> {
  // #287 — after always-worktree the worktrees are DETACHED at baseSha and
  // never advance: the integrated commits live on the feature branch at
  // repoRoot. Reading `origin/<base>..HEAD` from inside a worktree would
  // therefore return empty on every cycle, silently skipping six-pass review
  // — the same failure PR11 fixed once already, from the other direction.
  // With a branch name available, diff the pushed branch instead.
  if (branchName) {
    const integrated = await fetchIntegratedDiff(repoRoot, branchName);
    if (integrated.trim()) return integrated;
  }
  const ids = Object.keys(worktrees);
  if (ids.length <= 1) {
    const cwd = ids.length === 1 ? worktrees[ids[0] ?? ""] : repoRoot;
    return fetchMergedDiff(cwd ?? repoRoot);
  }
  const fetched: Array<{ id: string; body: string }> = [];
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) continue;
    fetched.push({ id, body: await fetchMergedDiff(wt) });
  }
  if (fetched.every((f) => !f.body.trim())) return "";

  const TOTAL_CAP = 1024 * 1024;
  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const { id, body: piece } of fetched) {
    if (truncated) break;
    const header = `## workstream: ${id}\n`;
    const remaining = TOTAL_CAP - totalBytes - header.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const body = piece.length > remaining ? `${piece.slice(0, remaining)}\n[... truncated]` : piece;
    sections.push(header + body);
    totalBytes += header.length + body.length;
  }
  if (truncated) sections.push("\n[... merged diff truncated at 1 MiB total]");
  return sections.join("\n");
}

/**
 * Count prior `step-started` events for this step in the event log.
 * Used by the driver loop (PR4) to compute a `(round N)` suffix for the
 * scrollback lifecycle line on steps that iterate during a fix loop
 * (adversarial / lens-review / lens-fix / re-entered develop). First
 * entry returns 0 — the emit sites add 1 and pass `round` to lifecycle;
 * `formatLine` suppresses the suffix for `round <= 1` so single-entry
 * steps stay terse.
 */
export function countPriorStepStarts(state: WorkState, step: WorkStep): number {
  let n = 0;
  for (const e of state.eventLog) {
    if (e.kind === "step-started" && e.step === step) n++;
  }
  return n;
}

/** Hash a diff for change-detection across rounds. SHA1 is fine — not a security boundary. */
function hashDiff(diff: string): string {
  return createHash("sha1").update(diff, "utf8").digest("hex").slice(0, 16);
}

/**
 * Detect subagent ABORT markers.
 *
 * Ops's branch and commit-pr step prompts instruct the subagent to write
 * `ABORT: <reason>` (or `**ABORT...**` for markdown emphasis) when a
 * precondition fails (dirty working tree, --ff-only refusal, etc). The
 * subagent's PROCESS still exits 0 — it ran successfully, just refused
 * the requested action — so the driver can't rely on exit code. This
 * scans the LAST ~800 chars of the reply for the marker; that's the
 * "verdict zone" where ops doctrine places it.
 *
 * Returns the matched abort line trimmed if found, or undefined.
 *
 * On issue #553's live cycle: ops's branch step replied with
 * "**ABORT: Working tree is not clean**" but PR #239 recorded ok:true
 * and the driver continued develop without a feature branch. The fix:
 * treat an ABORT marker as a dispatch-failed regardless of exit code.
 */
export function parseAbort(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const tail = text.slice(-800);
  // Multiline scan — markers may be in their own paragraph or inside a
  // markdown ** bold ** wrapper. Match conservative: must START with the
  // word "ABORT" (or **ABORT) and be a fresh line, to avoid false
  // positives on prose discussing aborts.
  const m = tail.match(/^[ \t]*\*{0,2}ABORT[:\s].*$/m);
  return m ? m[0].replace(/^\*+|\*+$/g, "").trim() : undefined;
}

/**
 * Parse a `branch: <name>` line from an ops reply (Step 3 doctrine asks
 * for this verbatim). Used by runBranch to capture the feature branch
 * into pipelineState.branchName so downstream step prompts can reference
 * it without re-discovering via `git rev-parse`.
 *
 * Lenient: accepts surrounding whitespace, optional backticks, optional
 * `**branch**` markdown emphasis. Returns undefined if no marker line.
 */
export function parseBranchName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*\*{0,2}branch\*{0,2}\s*:\s*`?([^\s`]+)`?\s*$/m);
  return m?.[1]?.trim();
}
