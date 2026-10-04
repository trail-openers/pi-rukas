import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startJob } from "./async-jobs.ts";
import { renderSummary } from "./lens-review-format.ts";
import { LENS_REVIEW_DIFF_DESCRIPTION, MAX_LENS_ATTEMPTS, runLensReview } from "./lens-review.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/**
 * Register the `dispatch_lens_review` tool: the public entry point for the
 * six-pass review. It opens a single async job (via `startJob`) so the caller
 * gets a job handle immediately and the consolidated verdict + dedup'd
 * findings arrive later as a `[ensemble:async]` message. The heavy lifting
 * (roster build, lens fan-out, retries, verdict) lives in `runLensReview`
 * (lens-review.ts); this module is only the tool wiring.
 */
export function registerLensReviewTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "dispatch_lens_review",
    label: "Code Review",
    description:
      "Fan out the code-review lenses (roster parsed from the installed `code-review-*` skills, precedence in each SKILL.md's frontmatter) in parallel as an async job. Returns a job handle immediately; ONE consolidated verdict + dedup'd findings arrives as a [ensemble:async] user message when all lenses finish. End your turn after dispatching.",
    parameters: Type.Object({
      diff: Type.Optional(Type.String({ description: LENS_REVIEW_DIFF_DESCRIPTION })),
      context: Type.Optional(
        Type.String({
          description: "1-3 sentence description of what changed and why; passed to every lens.",
        }),
      ),
      base: Type.Optional(
        Type.String({
          description:
            "With head: the base ref for `git diff <base>...<head>` (three-dot, merge-base) in cwd. Requires head.",
        }),
      ),
      head: Type.Optional(
        Type.String({
          description:
            "With base: the head ref for the diff the tool computes itself (see base). Requires base.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory; defaults to current; also the cwd for `git diff <base>...<head>` when base+head are given.",
        }),
      ),
      since: Type.Optional(
        Type.String({
          description:
            "#973 — the delta base: a commit ref the review diffs from (`git diff <since>..<head>`). When given, the lenses review ONLY the delta, with the full base...head range as context. The FIRST review on a branch is always a full review; the tool's auto-delta base (the latest lens entry's headSha) applies when `since` is absent and a prior lens entry exists.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as {
        diff?: string;
        context?: string;
        cwd?: string;
        base?: string;
        head?: string;
        since?: string;
      };
      const hasDiff = typeof params.diff === "string" && params.diff.length > 0;
      const hasRange = typeof params.base === "string" && typeof params.head === "string";
      if (hasDiff && hasRange) {
        trace(
          `lens review: diff string supplied alongside base=${params.base} head=${params.head} — the diff string wins`,
        );
      }
      const { jobId } = startJob(pi, {
        label: "lens_review",
        role: "lens-review",
        // Orchestrator-only — runLensReview opens one deck entry per lens
        // (6 rows) so the deck shows the real children, not a synthetic
        // umbrella row that masks them.
        skipDeck: true,
        work: async (signal): Promise<DispatchResult> => {
          const start = Date.now();
          const summary = await runLensReview({ ...params, signal });
          // ok is true when the review completed AND the verdict is neither
          // CRITICAL nor INCOMPLETE. INCOMPLETE means at least one lens
          // failed all retries (#3) — the review did NOT actually run every
          // pass, so PM/user must decide whether to retry or override.
          // #973 — a delta review that found nothing since the last recorded
          // run returns a deltaReview flag on the summary; the text says so.
          const text = renderSummary(summary, MAX_LENS_ATTEMPTS);
          return {
            role: "lens-review",
            ok:
              summary.verdict !== "CRITICAL_ISSUES_FOUND" &&
              summary.verdict !== "REVIEW_INCOMPLETE",
            text: summary.note ? `${text}\n\n${summary.note}` : text,
            toolUses: [],
            ms: Date.now() - start,
            exitCode: 0,
          };
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Dispatched async lens review; job ${jobId}. Verdict + findings will arrive as a [ensemble:async] user message when all lenses finish. End your turn.`,
          },
        ],
        details: { jobId, role: "lens-review", async: true },
      };
    },
  });
}
