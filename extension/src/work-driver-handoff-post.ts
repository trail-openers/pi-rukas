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
import { parseHandoffCommentUrl } from "./work-driver-handoff.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

const execp = promisify(exec);

/** The label the handoff applies — the ops prompt, the fallback and the
 * verification reader must all name the same label. */
export const HANDOFF_LABEL = "needs-human-attention";

/**
 * #775 — the handoff delivery-provenance field (the `delivery` member of
 * the handoff-emitted event, `workflow-state-events-handoff.ts`).
 */
export type HandoffDelivery = "dispatch" | "fallback";

/**
 * #775 — read the attention label back from the target the handoff posted to
 * (issue or PR) via the forge's existing `issueView` / `prView` seam — the
 * same read `checkAttentionLabel` uses. `gh label add` is idempotent and its
 * exit code is not proof the label is on the target (rate limits, 202
 * accepted-but-pending writes, an edit that touched the wrong object), so the
 * recorded state is verified, not narrated. Returns false on ANY read error
 * — an unverifiable label is not an applied one, and the caller then falls
 * back to the mechanical apply path rather than recording a false state.
 */
export async function verifyHandoffLabel(
  forge: Forge,
  objType: "issue" | "pr",
  targetId: number,
): Promise<boolean> {
  try {
    const view = objType === "pr" ? await forge.prView(targetId) : await forge.issueView(targetId);
    return (view.labels ?? []).some((l) => l.name === HANDOFF_LABEL);
  } catch (err) {
    trace(
      `work-driver: handoff label verification read failed (${objType} #${targetId}): ${(err as Error).message?.slice(0, 160)}`,
    );
    return false;
  }
}

/**
 * #775 — mechanical parse of the ops child's handoff reply. The ops prompt
 * (work-driver-prompts-late.ts, #775) ends with a canonical marker block:
 *
 *   HANDOFF-RESULT: comment=<url> label=<applied|not-applied|failed>
 *
 * (plus an optional unchained `gh` verification command for the child to run).
 * `label` is informational only — the driver verifies via the forge read in
 * `verifyHandoffLabel` regardless, so a false "applied" in the reply is
 * harmless and a missed marker never loses a label that WAS applied.
 * The URL is the primary parse (last-match-wins per the #408 marker doctrine,
 * the same regex the URL-only pre-#775 path used).
 */
export function parseHandoffOpsReply(text: string | undefined): {
  commentUrl?: string;
  labelConfirmed: boolean;
} {
  const url = parseHandoffCommentUrl(text);
  const labelConfirmed = /HANDOFF-RESULT:[\s\S]*?label=applied/.test(text ?? "");
  return { commentUrl: url, labelConfirmed };
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
        const parsedUrl = parseHandoffCommentUrl(out) ?? out.trim();
        if (parsedUrl) commentUrl = parsedUrl;
      }
    }
    if (!labelApplied) {
      try {
        await forge.labelCreate(HANDOFF_LABEL, "FFAA00");
      } catch {
        /* already exists or no perms; continue */
      }
      await forge.labelAdd(objType === "pr" ? "mr" : "issue", Number(targetId), HANDOFF_LABEL);
      // #775 — the label state is VERIFIED, not assumed: re-read the target
      // through the forge's view seam. A label whose read-back fails is not
      // recorded as applied; the loop re-applies on the next attempt (gh
      // --add-label is idempotent), and an unrecoverable read degrades to
      // labelApplied:false — an honest "not verifiable", never a lie.
      labelApplied = await verifyHandoffLabel(forge, objType, Number(targetId));
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
 * #775 — the `delivery` field records WHERE the recorded comment/label
 * state came from (the ops dispatch parse/verify, or the in-process forge
 * fallback). "dispatch" is asserted only when the driver VERIFIED the state
 * (via `verifyHandoffLabel` or a parsed URL) — a reply whose state the
 * driver could not verify records no provenance, which readers treat as
 * unknown.
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
  /** #775 — provenance of the recorded comment/label state. */
  delivery?: HandoffDelivery;
  /** #798 — explicit target object type (where the comment was posted). */
  targetType?: "issue" | "pr";
  /** #798 — the number of the target object. */
  targetNumber?: number;
  /** #798 — per-target: the issue label was verified on the issue. */
  issueLabelApplied?: boolean;
  /** #798 — per-target: the PR label was verified on the PR. */
  prLabelApplied?: boolean;
}): Extract<WorkEvent, { kind: "handoff-emitted" }> {
  const { at, commentUrl, labelApplied, handoffBodyPath, delivery } = opts;
  const ev: Extract<WorkEvent, { kind: "handoff-emitted" }> = {
    kind: "handoff-emitted",
    at,
    commentUrl,
    labelApplied,
    handoffBodyPath,
  };
  if (delivery) ev.delivery = delivery;
  if (opts.targetType) ev.targetType = opts.targetType;
  if (opts.targetNumber !== undefined) ev.targetNumber = opts.targetNumber;
  if (opts.issueLabelApplied !== undefined) ev.issueLabelApplied = opts.issueLabelApplied;
  if (opts.prLabelApplied !== undefined) ev.prLabelApplied = opts.prLabelApplied;
  if (opts.consolidated) {
    ev.consolidated = true;
    ev.consolidatedBranch = opts.consolidatedBranch;
    ev.consolidatedWorkstreams = opts.consolidatedWorkstreams;
  } else if (opts.consolidationReason) {
    ev.consolidationReason = opts.consolidationReason;
  }
  return ev;
}

/**
 * #798 — apply the issue label in the dual-target (option a) path.
 *
 * When `prNumber` is set, `postHandoffWithRetry` labels the comment target
 * (the PR). The issue label is applied here, separately, because the retry
 * targets a single object. This is idempotent (`gh --add-label`) and
 * verified independently via `verifyHandoffLabel`. Returns `true` when the
 * label was successfully applied AND verified on the issue.
 */
export async function applyIssueLabelDualTarget(forge: Forge, issue: number): Promise<boolean> {
  try {
    await forge.labelCreate(HANDOFF_LABEL, "FFAA00").catch(() => {});
    await forge.labelAdd("issue", issue, HANDOFF_LABEL);
    return await verifyHandoffLabel(forge, "issue", issue);
  } catch (err) {
    trace(
      `work-driver: issue label fallback failed (#798 dual-target): ${(err as Error).message?.slice(0, 160)}`,
    );
    return false;
  }
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
