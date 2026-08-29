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

/** Validate a git SHA before shell interpolation. */
const VALID_BASEDIFF_SHA_RE = /^[0-9a-f]{40}$/;

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
 * #451 — the bare `git diff HEAD` is DELIBERATE pre-commit semantics, not
 * a ref-resolution bug, and is the fallback for backwards compatibility.
 * The preferred primary path when `baseSha` is provided is
 * `git diff baseSha..HEAD`, which captures committed changes — without
 * this, once the developer commits their work `git diff HEAD` returns
 * empty and adversarial would trivially approve (#453). Logic:
 *   1. If baseSha is a valid 40-char hex SHA, try `git diff baseSha..HEAD`.
 *      If the result is non-empty, return it — this is the committed work.
 *   2. Fall back to `git diff HEAD` for uncommitted changes (pre-commit
 *      compat, or when baseSha is absent / the baseSha range is empty).
 *
 * `fetchDiff` is always per-worktree (`cwd` is one of the cycle's
 * worktrees, or the last-resort repoRoot fallback recorded by the branch
 * step). The load-bearing discipline is which cwd the caller scopes it to —
 * a worktree, never the repo root once it leaves the feature branch. That
 * is what the grep canary in test-work-driver-diff-head-canary.ts
 * protects: no new bare `git diff HEAD` in a REPO-ROOT verification or
 * diff-fetch path, and this per-worktree call stays documented.
 *
 * Failure modes return "":
 *  - cwd is undefined (no worktree resolved yet — early steps before
 *    branch creation)
 *  - cwd isn't a git repo
 *  - `git diff` returned non-zero or threw (e.g., permissions)
 *
 * The hard cap on diff size (1 MiB) prevents a runaway worktree state
 * from bloating the dispatch prompt.
 */
export async function fetchDiff(cwd: string | undefined, baseSha?: string): Promise<string> {
  if (!cwd) return "";
  // #453 — try committed diff first when baseSha is available and valid.
  // `git diff baseSha..HEAD` shows everything the developer committed,
  // which `git diff HEAD` misses once the working tree is clean.
  if (baseSha && VALID_BASEDIFF_SHA_RE.test(baseSha)) {
    try {
      const { stdout } = await execp(`git diff ${baseSha}..HEAD`, {
        cwd,
        maxBuffer: 1024 * 1024,
      });
      if (stdout.trim()) return stdout;
    } catch (err) {
      trace(
        `work-driver: fetchDiff(${cwd}, baseSha..HEAD) failed: ${(err as Error).message?.slice(
          0,
          200,
        )}`,
      );
    }
  }
  // Fallback: uncommitted diff — DELIBERATE pre-commit semantics for callers
  // without a baseSha and for the case where baseSha..HEAD is empty
  // (developer hasn't committed yet).
  try {
    // Prefer `git diff <baseSha>..HEAD` when baseSha is available — this
    // captures committed work. Without baseSha, fall back to `git diff HEAD`
    // (uncommitted changes only), which is correct for pre-commit scenarios.
    const diffRange = baseSha ? `${JSON.stringify(baseSha)}..HEAD` : "HEAD";
    const { stdout } = await execp(`git diff ${diffRange}`, {
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
 *  - N=1 (default workstream): single `git diff <baseSha>..HEAD` from the
 *    recorded worktree path, OR `ctx.repoRoot` as fallback when the
 *    worktrees map is empty (the B2 cwd-fallback, restored to working
 *    order by populating the map in Step 3 — single-task /work writes
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
async function fetchAllDiffs(
  worktrees: Record<string, string>,
  repoRoot: string,
  baseSha?: string,
): Promise<string> {
  const ids = Object.keys(worktrees);
  // N=1 path — the structural fix for B2. With Step 3 populating the
  // worktrees map (default → repoRoot for single-task), `worktrees[id]`
  // is always a string, never undefined.
  if (ids.length <= 1) {
    const cwd = ids.length === 1 ? worktrees[ids[0] ?? ""] : repoRoot;
    return fetchDiff(cwd ?? repoRoot, baseSha);
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
    fetched.push({ id, body: await fetchDiff(wt, baseSha) });
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
  const r = await readIntegratedDiff(repoRoot, branchName);
  return r.ok ? r.diff : "";
}

/**
 * The same read, but able to say "I could not tell" — #384.
 *
 * `fetchIntegratedDiff` swallowed every error and returned `""`, and
 * `runLens` treats an empty diff as APPROVED. So a transient git failure, a
 * stale `origin/<branch>` ref, or a `maxBuffer` overrun on a large diff all
 * produced the same value as "there is genuinely nothing to review" — and
 * that value meant approve, then merge. A gate whose no-signal answer is
 * approval is a gate that cannot fail, the same defect #380 removed from the
 * merge step.
 *
 * `empty` is established POSITIVELY, by counting commits ahead of base,
 * rather than inferred from the absence of output. Proving the green is the
 * whole difference between a gate and a formality.
 */
export type IntegratedDiff =
  | { ok: true; diff: string; empty: boolean }
  | { ok: false; reason: string };

export async function readIntegratedDiff(
  repoRoot: string,
  branchName: string,
): Promise<IntegratedDiff> {
  let base: string;
  try {
    const { stdout: head } = await execp(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { cwd: repoRoot, shell: "/bin/bash" },
    );
    base = head.trim() || "main";
  } catch (err) {
    // The mainline is unknowable, so the diff below would be meaningless.
    return { ok: false, reason: `could not resolve mainline: ${errText(err)}` };
  }
  try {
    const { stdout } = await execp(`git diff origin/${base}..origin/${branchName}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    if (stdout.trim()) return { ok: true, diff: stdout, empty: false };
  } catch (err) {
    return {
      ok: false,
      reason: `git diff origin/${base}..origin/${branchName} failed: ${errText(err)}`,
    };
  }
  // Empty output. Confirm it means "no commits ahead" rather than "the read
  // silently produced nothing" — those are the two cases this whole type
  // exists to separate.
  try {
    const { stdout } = await execp(`git rev-list --count origin/${base}..origin/${branchName}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const ahead = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(ahead)) {
      return { ok: false, reason: `could not count commits ahead of origin/${base}` };
    }
    if (ahead === 0) return { ok: true, diff: "", empty: true };
    // Commits exist but the diff is empty. Possible legitimately (an empty
    // commit, or changes that cancel out), but it is not something to approve
    // on silently.
    return {
      ok: false,
      reason: `branch is ${ahead} commit(s) ahead of origin/${base} but the diff came back empty`,
    };
  } catch (err) {
    return { ok: false, reason: `could not count commits ahead: ${errText(err)}` };
  }
}

function errText(err: unknown): string {
  return ((err as Error).message ?? String(err)).slice(0, 200);
}

/** A path that is safe to interpolate into a git command. */
const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Read a file as it stands ON THE BRANCH, not in the working tree.
 *
 * This distinction is the whole reason the function exists. The reviewed diff
 * is built from `origin/<base>..origin/<branch>` (see `readIntegratedDiff`),
 * but lens children run with `cwd` set to a worktree, and under always-worktree
 * those "stay DETACHED at baseSha" — the invariant recorded at the bottom of
 * `readAllMergedDiffs`. A reviewer that opens a changed file from its own cwd
 * therefore reads the version from BEFORE the change.
 *
 * That is not a hypothetical. A real cycle shipped a documentation paragraph
 * contradicting another paragraph 70 lines further down the same file, and no
 * lens reported it: the contradicting line was outside the diff, so it was
 * never in any reviewer's context, and opening the file would have shown the
 * pre-change text anyway.
 *
 * Returns undefined rather than throwing — an unreadable file means the
 * reviewer gets less evidence, never a fabricated finding.
 */
export async function readFileAtBranch(
  repoRoot: string,
  branchName: string,
  filePath: string,
): Promise<string | undefined> {
  if (!SAFE_PATH.test(filePath) || !SAFE_PATH.test(branchName)) return undefined;
  try {
    const { stdout } = await execp(`git show origin/${branchName}:${filePath}`, {
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Paths a unified diff touches, in order, deduplicated. */
export function pathsInDiff(diff: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const p = line.slice(4).replace(/^b\//, "").trim();
    if (p === "/dev/null" || p.length === 0 || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * #384 — `fetchAllMergedDiffs` with the failure case preserved.
 *
 * The plain version cannot distinguish "nothing to review" from "could not
 * find out", and `runLens` approves on both. Lens review is the last gate
 * before merge, so it is the one place that distinction has to survive.
 */
export async function readAllMergedDiffs(
  worktrees: Record<string, string>,
  repoRoot: string,
  branchName?: string,
  baseSha?: string,
): Promise<IntegratedDiff> {
  // With a branch name the integrated read is authoritative in BOTH
  // directions: a confirmed-empty diff means no commits ahead of base, which
  // no per-worktree read can contradict, and a failure means we do not know.
  if (branchName) return readIntegratedDiff(repoRoot, branchName);
  // N>1 per-worktree diff path: each worktree's diff is relative to its own
  // baseSha (the detatch point), so we can read committed work with
  // `git diff <baseSha>..HEAD`. Without baseSha we fall back to `git diff
  // HEAD` (uncommitted work only), which is correct for pre-commit
  // scenarios but would return empty after a developer commit.
  const ids = Object.keys(worktrees);
  if (ids.length > 0) {
    const diff = await fetchAllDiffs(worktrees, repoRoot, baseSha);
    return { ok: true, diff, empty: !diff.trim() };
  }
  return {
    ok: true,
    diff: "",
    empty: true,
  };
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
