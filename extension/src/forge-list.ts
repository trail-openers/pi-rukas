/**
 * forge-list — the two list replies the forge adapter maps.
 *
 * Split out of `forge.ts` for the §12 size cap, and the seam is real: both
 * replies accept a shape that is NOT the CLI's JSON, because callers that only
 * want numbers ask for `--jq '.[0].number'` and get a bare digit string back.
 * That tolerance is easy to lose in a refactor of the adapter (it looks like
 * dead defensive code) and impossible to notice losing — a list that throws on
 * the shape its own tests emit is a step that fails at runtime. So both live
 * here, next to each other, with the non-JSON branch written once.
 */

import type { ForgeType } from "./forge-detect.ts";
import { asArray, mapGhIssue, mapGhPr, mapGlIssue, mapGlMr } from "./forge-mapping.ts";
import type { NormalizedIssue, NormalizedPullRequest } from "./forge-types.ts";

/** A bare positive integer, or undefined when `stdout` is not one. */
function bareNumber(stdout: string): number | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("{")) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * A PR list reply: an array of PR rows, or a single bare number wrapped into a
 * minimal row. The empty-list case is `[]`, never a throw — "no PRs" is a real
 * answer the driver acts on (it opens one).
 */
export function mapPrListReply(forge: ForgeType, stdout: string): NormalizedPullRequest[] {
  const n = bareNumber(stdout);
  if (n !== undefined) {
    return [
      {
        number: n,
        url: "",
        state: "" as NormalizedPullRequest["state"],
        title: "",
        body: "",
        headRefName: undefined,
        baseRefName: undefined,
        author: undefined,
        mergeable: null,
        mergeStateStatus: null,
        labels: [],
        createdAt: undefined,
        updatedAt: undefined,
      },
    ];
  }
  return asArray(stdout).map((raw) => {
    const o = raw as Record<string, unknown>;
    return forge === "github" ? mapGhPr(o) : mapGlMr(o);
  });
}

/** An issue-search reply. No bare-number branch: search has no single-number form. */
export function mapIssueSearchReply(forge: ForgeType, stdout: string): NormalizedIssue[] {
  return asArray(stdout).map((raw) => {
    const o = raw as Record<string, unknown>;
    return forge === "github" ? mapGhIssue(o) : mapGlIssue(o);
  });
}
