import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startJob } from "./async-jobs.ts";
import type { LensLedgerOutcome } from "./lens-ledger.ts";
import { type LensReviewSummary, renderSummary } from "./lens-review-format.ts";
import { LENS_REVIEW_DIFF_DESCRIPTION, MAX_LENS_ATTEMPTS, runLensReview } from "./lens-review.ts";
import { admitLensRound } from "./lens-round-cap.ts";
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
            "#973 — the delta base: a commit ref the review diffs from (`git diff <since>..<head>`). When given, the lenses review ONLY the delta, with the full base...head range as context. Without it, the delta base DEFAULTS to this branch's latest lens ledger entry's headSha when that SHA is an ancestor of HEAD (an automatic delta review); the first review on a branch (no ledger entry) is always a full review. An empty delta (no changes since the base) is a no-review outcome — no re-review, no ledger entry. Pass `full: true` to force a full review.",
        }),
      ),
      full: Type.Optional(
        Type.Boolean({
          description:
            "#973 — force a full review: the automatic delta base (the latest lens ledger entry's headSha) is not consulted. An explicit `since` still wins when given. An explicit base + head (with no `since`) is ALWAYS a full review — the automatic delta base only applies to a bare branch/cwd review.",
        }),
      ),
      pr: Type.Optional(
        Type.Number({
          description:
            "Open PR/MR number for the branch (optional; auto-detected when omitted). When given, the residual-findings disclosure posts to this PR directly without resolving the branch's open PR.",
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
        full?: boolean;
        pr?: number;
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
          // #1127 — the round budget runs BEFORE any lens is dispatched; a
          // refusal is the terminal ROUND_CAP_REACHED summary, nothing recorded.
          // An admitted run holds its reservation until it settles, so a
          // concurrent call in this process cannot pass the same round.
          // The bypass is the operator's env var (read inside admitLensRound) —
          // never a tool parameter, so the model cannot set it (#1127).
          const admission = await admitLensRound({
            cwd: params.cwd,
            head: params.head,
            pr: params.pr,
          });
          let summary: LensReviewSummary;
          let admissionNote: string | undefined;
          let unrecordedNote: string | undefined;
          if (admission.admitted) {
            admissionNote = admission.note;
            // The round is held until the run's ledger write settles, so a
            // back-to-back call cannot be admitted to the same round. The
            // settled write's outcome is reported on this run's result (#1127).
            let ledgerWrite: Promise<LensLedgerOutcome> | undefined;
            try {
              summary = await runLensReview({
                ...params,
                overrideCap: admission.overrideCap,
                ledgerKey: admission.key,
                signal,
                onLedgerWrite: (w) => {
                  ledgerWrite = w;
                },
              });
            } finally {
              unrecordedNote = await admission.release(ledgerWrite);
            }
          } else {
            summary = admission.refusal;
          }
          // A refusal's note is the whole report (renderSummary), so it is not
          // appended a second time.
          const refused =
            summary.verdict === "ROUND_CAP_REACHED" ||
            summary.verdict === "REVIEW_INCOMPLETE_STREAK";
          const noteAppended = summary.note && !refused ? summary.note : undefined;
          const extra = [noteAppended, admissionNote, unrecordedNote].filter(
            (n): n is string => !!n,
          );
          // ok is true when the review completed AND the verdict is neither
          // CRITICAL nor INCOMPLETE. INCOMPLETE means at least one lens
          // failed all retries (#3) — the review did NOT actually run every
          // pass, so PM/user must decide whether to retry or override.
          // #973 — a delta review that found nothing since the last recorded
          // run returns a deltaReview flag on the summary; the text says so.
          // #973 review — the no-review outcome (decision 4) is NOT an
          // approval: `ok` is false and the text says "NO REVIEW" (the
          // verdict on the summary stays APPROVED because the Verdict union
          // is unchanged, but the tool result must never look like a pass).
          const text = renderSummary(summary, MAX_LENS_ATTEMPTS);
          return {
            role: "lens-review",
            ok:
              !summary.noReview &&
              summary.verdict !== "CRITICAL_ISSUES_FOUND" &&
              summary.verdict !== "REVIEW_INCOMPLETE" &&
              !refused,
            text: extra.length > 0 ? `${text}\n\n${extra.join("\n\n")}` : text,
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
