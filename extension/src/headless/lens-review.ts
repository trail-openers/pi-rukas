/**
 * headless/lens-review — `pi-rukas-headless lens-review` (headless S6, #1021):
 * one six-pass review (runLensReview) under the same round budget the
 * `dispatch_lens_review` tool admits it through (admitLensRound).
 *
 *   lens-review [--base <ref> --head <ref>] [--since <ref>] [--full]
 *               [--context <text>] [--pr <n>] [--json]
 *
 * Without --base/--head the lenses review the working tree's diff, as the tool
 * does. The run writes the review ledger like the tool.
 *
 * Exit codes, from the verdict:
 *   0   APPROVED, or no review (an empty delta: `"noReview": true` — this is
 *       not an approval, and the JSON says so)
 *  10   ISSUES_FOUND
 *  20   CRITICAL_ISSUES_FOUND
 *  30   REVIEW_INCOMPLETE (or REVIEW_INCOMPLETE_STREAK)
 *  40   bad arguments, or ROUND_CAP_REACHED (the round budget refused the run)
 */

import type { LensLedgerOutcome } from "../lens-ledger.ts";
import type { LensReviewSummary, Verdict } from "../lens-review-format.ts";
import { runLensReview } from "../lens-review.ts";
import { admitLensRound } from "../lens-round-cap.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";

export const LENS_REVIEW_FLAGS = [
  "--base",
  "--head",
  "--since",
  "--full",
  "--context",
  "--pr",
  "--json",
] as const;

/** The exit code for each verdict. CRITICAL is 20 (the review's own scale, not `aborted`). */
export const LENS_VERDICT_EXIT: Record<Verdict, number> = {
  APPROVED: EXIT.merged,
  ISSUES_FOUND: EXIT.handoff,
  CRITICAL_ISSUES_FOUND: 20,
  REVIEW_INCOMPLETE: EXIT.crash,
  REVIEW_INCOMPLETE_STREAK: EXIT.crash,
  ROUND_CAP_REACHED: EXIT.refused,
};

/** Test seams: the admission and the review itself. */
export interface LensReviewSeams {
  admit?: typeof admitLensRound;
  run?: typeof runLensReview;
}

export async function runLensReviewVerb(
  argv: readonly string[],
  ctx: VerbContext,
  seams: LensReviewSeams = {},
): Promise<VerbOutcome> {
  const p = parseFlags(argv, {
    bool: ["--full", "--json"],
    value: ["--base", "--head", "--since", "--context", "--pr"],
  });
  if ("error" in p) return badArguments(p.error);
  if (p.positional.length > 0) return badArguments(`unexpected argument "${p.positional[0]}"`);
  const base = p.value.get("--base");
  const head = p.value.get("--head");
  if ((base === undefined) !== (head === undefined)) {
    return badArguments("--base and --head are given together");
  }
  const prText = p.value.get("--pr");
  const pr = prText === undefined ? undefined : Number(prText);
  if (pr !== undefined && !(Number.isInteger(pr) && pr > 0)) {
    return badArguments(`invalid --pr "${prText}"`);
  }
  const cwd = ctx.repoRoot;
  ctx.host.sendUserMessage(`lens-review: ${base ? `${base}...${head}` : "working tree"}`, {
    deliverAs: "steer",
  });
  const admission = await (seams.admit ?? admitLensRound)({ cwd, head, pr });
  let summary: LensReviewSummary;
  let ledger: LensLedgerOutcome | undefined;
  if (admission.admitted) {
    let ledgerWrite: Promise<LensLedgerOutcome> | undefined;
    try {
      summary = await (seams.run ?? runLensReview)({
        cwd,
        base,
        head,
        since: p.value.get("--since"),
        full: p.bool.has("--full"),
        context: p.value.get("--context"),
        pr,
        pi: ctx.host,
        overrideCap: admission.overrideCap,
        ledgerKey: admission.key,
        onLedgerWrite: (w) => {
          ledgerWrite = w;
        },
      });
    } finally {
      const unrecorded = await admission.release(ledgerWrite);
      if (unrecorded)
        ctx.host.sendUserMessage(`lens-review: ${unrecorded}`, { deliverAs: "steer" });
    }
    ledger = ledgerWrite ? await ledgerWrite.catch(() => undefined) : undefined;
    if (admission.note)
      ctx.host.sendUserMessage(`lens-review: ${admission.note}`, { deliverAs: "steer" });
  } else {
    summary = admission.refusal;
  }
  const exitCode = summary.noReview ? EXIT.merged : LENS_VERDICT_EXIT[summary.verdict];
  ctx.host.sendUserMessage(
    `lens-review: ${summary.noReview ? "no review" : summary.verdict} (exit ${exitCode})`,
    { deliverAs: "steer" },
  );
  return {
    exitCode,
    doc: {
      subcommand: "lens-review",
      exitCode,
      verdict: summary.verdict,
      noReview: summary.noReview === true,
      totalFindings: summary.totalFindings,
      bySeverity: summary.bySeverity,
      findings: summary.findings,
      ...(summary.note ? { note: summary.note } : {}),
      ...(summary.deltaReview ? { deltaReview: summary.deltaReview } : {}),
      ...(summary.usage ? { usage: summary.usage } : {}),
      ...(ledger ? { ledger } : {}),
    },
  };
}
