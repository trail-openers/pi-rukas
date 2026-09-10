/**
 * work-driver-handoff-post — #674 item 3: post the handoff comment + label
 * through the forge, with retry-with-backoff, BEFORE the HANDOFF DISPATCH
 * INCOMPLETE banner.
 *
 * A transient API hiccup (measured: two sessions' handoffs hit "[FAILED]
 * NOT posted" on the first attempt and succeeded moments later) should not
 * become a manual-recovery task when a short retry would likely succeed.
 * Each attempt is idempotent: the label is created (ignore "already
 * exists") and added (gh --add-label is idempotent server-side), and a
 * crashed re-entry is deduped by priorHandoffCommentUrl before this point.
 *
 * Shape follows dispatch-retry.ts: bounded attempts, backoff doubling
 * (1s → 2s), escape-hatch env var (`PI_ENSEMBLE_HANDOFF_POST_RETRY=0`
 * disables the retry entirely — single attempt). `sleep` is injectable so
 * tests don't wait real backoff.
 *
 * Split from work-driver-handoff.ts (AGENTS.md §12 file-size limit).
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import type { Forge } from "./forge.ts";
import { trace } from "./trace.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

const execp = promisify(exec);

/**
 * Parse a GitHub comment URL from forge output. Local copy to avoid a
 * circular import (work-driver-handoff.ts imports from this module).
 * Same regex as parseHandoffCommentUrl in work-driver-handoff.ts.
 */
function parseCommentUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/https:\/\/github\.com\/[^\s)>]+#issuecomment-\d+/);
  return m?.[0];
}

export interface HandoffPostResult {
  commentUrl?: string;
  labelApplied: boolean;
  attempts: number;
}

/**
 * Post the handoff comment + label via the forge, retrying with backoff.
 *
 * Returns the outcome after up to `maxAttempts` attempts (3 by default, 1
 * when `PI_ENSEMBLE_HANDOFF_POST_RETRY=0`). A successful comment post does
 * not stop the loop — the label is applied mechanically (idempotent) on
 * every attempt until both succeed, because `gh --add-label` is idempotent
 * server-side and narration cannot establish that a side effect happened.
 */
export async function postHandoffToForge(opts: {
  forge: Forge;
  issue: number;
  prNumber: number | undefined;
  handoffBodyPath: string;
  /** When set, the comment URL is already known — skip issueComment. */
  knownCommentUrl?: string;
  /** Injected in tests so a 1s/2s backoff does not take 1s/2s. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<HandoffPostResult> {
  const { forge, issue, prNumber, handoffBodyPath } = opts;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const targetId = String(prNumber ?? issue);
  const objType = prNumber ? "pr" : "issue";
  let commentUrl = opts.knownCommentUrl;
  let labelApplied = false;
  let backoffMs = 1000; // 1s → 2s (two retries, bounded)
  const maxAttempts = process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY === "0" ? 1 : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!commentUrl) {
      // The forge adapter models `issueComment` only (S2 surface). PRs
      // get their handoff comment via the ops dispatch's raw `gh` prompt.
      // For the in-process path, the forge covers the issue-comment shape.
      if (objType === "issue") {
        const body = await fs.readFile(handoffBodyPath, "utf8").catch(() => "");
        const out = await forge.issueComment(issue, body);
        const parsedUrl = parseCommentUrl(out) ?? out.trim();
        if (parsedUrl) commentUrl = parsedUrl;
      }
    }
    if (!labelApplied) {
      try {
        await forge.labelCreate("needs-human-attention", "FFAA00");
      } catch {
        /* already exists or no perms; continue */
      }
      await forge.labelAdd(
        objType === "pr" ? "mr" : "issue",
        Number(targetId),
        "needs-human-attention",
      );
      labelApplied = true;
    }
    if (commentUrl && labelApplied) return { commentUrl, labelApplied: true, attempts: attempt };
    if (attempt === maxAttempts) break;
    trace(
      `work-driver: handoff forge post attempt ${attempt} incomplete — retrying in ${backoffMs}ms`,
    );
    await sleep(backoffMs);
    backoffMs *= 2;
  }
  return { commentUrl, labelApplied, attempts: maxAttempts };
}

/**
 * #674 — build the handoff-emitted event, carrying the consolidation
 * outcome (item 1+2) into the event so the renderers (chat + GitHub body +
 * /work-status) can print either the branch-contains-the-work path
 * (consolidated) or the accurate per-worktree fallback (consolidation
 * infeasible). The `handoff-consolidated` event is the audit trail; the
 * snapshot's `committedWork` field is the source the recovery renderers
 * read for the per-worktree paths + SHAs.
 *
 * Pure: no I/O. The caller passes the parsed consolidation state.
 */
export function makeHandoffEmittedEvent(opts: {
  at: number;
  commentUrl: string | undefined;
  labelApplied: boolean;
  handoffBodyPath: string;
  consolidated: boolean;
  consolidatedBranch?: string;
  consolidatedWorkstreams?: string[];
  consolidationReason?: string;
}): Extract<WorkEvent, { kind: "handoff-emitted" }> {
  const { at, commentUrl, labelApplied, handoffBodyPath } = opts;
  const ev: Extract<WorkEvent, { kind: "handoff-emitted" }> = {
    kind: "handoff-emitted",
    at,
    commentUrl,
    labelApplied,
    handoffBodyPath,
  };
  if (opts.consolidated) {
    ev.consolidated = true;
    ev.consolidatedBranch = opts.consolidatedBranch;
    ev.consolidatedWorkstreams = opts.consolidatedWorkstreams;
  } else if (opts.consolidationReason) {
    ev.consolidationReason = opts.consolidationReason;
  }
  return ev;
}

/** #674 — a committed-worktree entry inside a handoff snapshot. */
export interface HandoffCommittedWorkEntry {
  worktreeId: string;
  path: string;
  headSha: string;
  ahead: number;
}

/**
 * #674 — record each worktree's committed work (HEAD SHA + commits ahead
 * of the cycle's base) into the snapshot's `committedWork` field.
 *
 * `captureWorktreeSnapshot` (work-driver-handoff.ts) reads `git status
 * --porcelain` only, so a developer's committed work on a detached-HEAD
 * worktree (clean tree, N commits ahead of base) reported 0 files / 0
 * staged / 0 unstaged — the exact shape of the five parked cycles
 * (#645/#649/#659/#660/#664). This captures that committed work
 * explicitly, so the "Worktree state" section and the worktree-aware
 * recovery print the work's true location (path + HEAD SHA) instead of
 * "0 file(s) modified".
 *
 * Best-effort: every git invocation is try/catch'd; a missing worktree or
 * an unknown base degrades to an absent `committedWork`, which the
 * renderers treat as "no committed work recorded" (the porcelain-based
 * counts still describe any uncommitted dirt).
 */
export async function captureCommittedWork(
  snapshot: NonNullable<WorkState["pipelineState"]["handoffSnapshot"]>,
  _repoRoot: string,
  ps: { baseSha?: string; worktrees?: Record<string, string> },
  execFn: ExecFn = execp as unknown as ExecFn,
): Promise<void> {
  const worktrees = ps.worktrees ?? {};
  const baseSha = ps.baseSha;
  if (Object.keys(worktrees).length === 0 || !baseSha) return;
  const committedWork: HandoffCommittedWorkEntry[] = [];
  for (const [id, wt] of Object.entries(worktrees)) {
    try {
      const { stdout: shaOut } = await execFn("git rev-parse HEAD", { cwd: wt });
      const headSha = shaOut.trim();
      const { stdout: countOut } = await execFn(
        `git rev-list --count ${JSON.stringify(baseSha)}..HEAD`,
        {
          cwd: wt,
        },
      );
      const ahead = Number.parseInt(countOut.trim(), 10);
      if (Number.isFinite(ahead) && ahead > 0 && headSha.length >= 7) {
        committedWork.push({ worktreeId: id, path: wt, headSha, ahead });
      }
    } catch (err) {
      trace(
        `work-driver: captureCommittedWork failed for worktree ${id} (${wt}): ${(err as Error).message?.slice(0, 160)}`,
      );
    }
  }
  if (committedWork.length > 0) snapshot.committedWork = committedWork;
}
