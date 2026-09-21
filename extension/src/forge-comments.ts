/**
 * forge-comments — comment read + write seam for the forge adapter (#775).
 *
 * The `Forge` interface models `issueComments` / `prComments` (list) and
 * `prComment` (post on a PR target). These implementations live here —
 * separate from `forge.ts` (which is at the §12 500-line cap) — and are
 * wired into the Forge object in `forge.ts` as plain function references.
 *
 * The PR comment seam is the load-bearing half of the #775 in-process
 * handoff fallback: PR-targeted cycles (prNumber set) previously had NO
 * in-process path to post the handoff comment (the adapter modeled
 * `issueComment` only), so a failed ops dispatch on a PR handoff left the
 * banner firing even though the driver had the body and the issue number.
 *
 * All commands are single, unchained invocations (#408 recovery-command
 * rule — the fallback runs in-process in the driver, not through the
 * permission layer, but the unchained shape is pinned by test-forge-*.ts).
 */

import * as cmds from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import { asArray, asRecord, mapGhComment, mapGlComment } from "./forge-mapping.ts";
import type { NormalizedComment } from "./forge-types.ts";
import type { ForgeExecFn } from "./forge.ts";

/**
 * A comment-read seam: takes the forge type + the exec/run helpers from
 * `createForge` and returns a list of NormalizedComment for the given
 * target. `run` is the same closure `createForge` builds (it carries the
 * forge's cwd + maxBuffer + per-call execOpts).
 */
export interface CommentSeamDeps {
  forge: ForgeType;
  run: <T>(cmd: string, map: (stdout: string) => T) => Promise<T>;
  withBodyFile: <T>(
    prefix: string,
    body: string,
    withFile: (file: string) => Promise<T>,
  ) => Promise<T>;
}

/** List an issue's comments (the idempotency check for the handoff fallback).
 *  `gh issue view N --json comments` returns `{"comments": [...]}` — a single
 *  object, not a bare array. GitLab's notes endpoint returns a bare array. */
export async function listIssueComments(
  deps: CommentSeamDeps,
  number: number,
): Promise<NormalizedComment[]> {
  return deps.run(cmds.issueCommentsCmd(deps.forge, number), (stdout) => {
    const rows = extractCommentRows(deps.forge, stdout);
    return rows.map((raw) => {
      const o = raw as Record<string, unknown>;
      if (deps.forge === "github") return mapGhComment(o);
      return mapGlComment(o);
    });
  });
}

/** List a PR/MR's review comments (notes `gh pr comment N --body-file` creates).
 *  Same shape as `listIssueComments`: GitHub returns `{"comments": [...]}`. */
export async function listPrComments(
  deps: CommentSeamDeps,
  number: number,
): Promise<NormalizedComment[]> {
  return deps.run(cmds.prCommentsCmd(deps.forge, number), (stdout) => {
    const rows = extractCommentRows(deps.forge, stdout);
    return rows.map((raw) => {
      const o = raw as Record<string, unknown>;
      if (deps.forge === "github") return mapGhComment(o);
      return mapGlComment(o);
    });
  });
}

/**
 * Extract the comment rows from the forge's comment-list response.
 * GitHub (`gh … view N --json comments`) returns a single object
 * `{"comments": [...]}` — extract the array. GitLab (notes endpoint)
 * returns a bare JSON array. This helper handles both shapes.
 */
function extractCommentRows(forge: ForgeType, stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    // GitLab: bare array (or empty).
    return asArray(stdout);
  }
  const obj = asRecord(stdout);
  const comments = obj.comments;
  if (Array.isArray(comments)) return comments as unknown[];
  // Fallback: the response was an object but had no `comments` field —
  // return empty (the caller's idempotency check finds no match → posts).
  return [];
}

/**
 * Post a comment on a PR target. GitHub PRs are GitHub issues under the
 * hood, so `gh pr comment N --body-file` is the same call shape as the
 * issue path. GitLab: the MR's notes endpoint (same shape as `issueComment`).
 *
 * Returns the posted comment's URL (GitHub: the canonical `…#issuecomment-<id>`
 * form `gh pr comment` prints; GitLab: the note's `web_url`).
 */
export async function postPrComment(
  deps: CommentSeamDeps,
  number: number,
  body: string,
): Promise<string> {
  return deps.withBodyFile(`pr-comment-${number}`, body, (file) =>
    deps.run(cmds.prCommentCmd(deps.forge, number, file), (stdout) => {
      if (deps.forge === "github") return stdout.trim();
      try {
        const o = asRecord(stdout);
        return (o.web_url as string) ?? stdout.trim();
      } catch {
        return stdout.trim();
      }
    }),
  );
}
