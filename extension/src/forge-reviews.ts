/**
 * forge-reviews — the review/approval read of the forge adapter (#2160).
 *
 * `Forge` modelled a pull request's *comments* but never its *reviews*, so a
 * helper reviewing a PR could not ask the forge who approved it and with what
 * body without running `gh`/`glab` under its own login. The adapter had no
 * verb to expose, which is why this read lives behind the adapter rather than
 * in a child's bash: `forge_read` serves it with the parent's credential and
 * the helper holds none.
 *
 * GitHub takes the GraphQL `reviews` field on `gh pr view`; GitLab has no
 * `glab` subcommand that returns approvals as JSON, so the read goes to the
 * approvals endpoint, whose `approved_by` rows are the same shape of answer
 * (who, and when).
 */

import * as cmds from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import { asRecord } from "./forge-mapping.ts";

/** One review/approval, normalized across forges. */
export interface NormalizedReview {
  /** Reviewer login/username, when the payload names one. */
  author: string | undefined;
  /** Upper-cased verdict: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED… */
  state: string;
  /** The review body, empty when the reviewer said nothing. */
  body: string;
  submittedAt: string | undefined;
}

function ghRows(raw: Record<string, unknown>): unknown[] {
  return Array.isArray(raw.reviews) ? (raw.reviews as unknown[]) : [];
}

function glRows(raw: Record<string, unknown>): unknown[] {
  // The approvals endpoint answers `{ approved_by: [...], rules: [...] }`;
  // some GitLab tiers answer the approved-review list as `approvals`.
  if (Array.isArray(raw.approved_by)) return raw.approved_by as unknown[];
  if (Array.isArray(raw.approvals)) return raw.approvals as unknown[];
  return [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function mapGhReview(raw: unknown): NormalizedReview {
  const o = raw as Record<string, unknown>;
  const author = (o.author as Record<string, unknown> | null | undefined)?.login ?? str(o.user);
  return {
    author: typeof author === "string" ? author : undefined,
    state: (str(o.state) ?? "").toUpperCase(),
    body: str(o.body) ?? "",
    submittedAt: str(o.submittedAt) ?? str(o.created_at),
  };
}

function mapGlReview(raw: unknown): NormalizedReview {
  const o = raw as Record<string, unknown>;
  const user = (o.user ?? o.approver) as Record<string, unknown> | undefined;
  const username = user ? str(user.username) : undefined;
  return {
    author: username ?? str(o.username),
    state: (str(o.state) ?? "APPROVED").toUpperCase(),
    body: str(o.body) ?? "",
    submittedAt: str(o.created_at),
  };
}

/** Map one forge's review payload (the raw stdout of `prReviewsCmd`) to rows. */
export function mapReviews(forge: ForgeType, stdout: string): NormalizedReview[] {
  const raw = asRecord(stdout);
  const rows = forge === "github" ? ghRows(raw) : glRows(raw);
  return rows.map((row) => (forge === "github" ? mapGhReview(row) : mapGlReview(row)));
}

/** The command the read runs — exported for the argv-pinning tests. */
export const prReviewsCmd = cmds.prReviewsCmd;
