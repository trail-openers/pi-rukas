/**
 * plan-phase5 — the compiled /plan pipeline's Phase 5: the cap-skip
 * routing for the DISCRIMINATED filing failure + the single filing pass.
 *
 * Moved from plan-driver.ts along the 500-line seam (AGENTS.md §12) —
 * code only, the comments verbatim, so the driver keeps the Phase 5
 * section header as the orchestration-visible seam.
 */
import { type FilingFailure, fileIssue, getPlanForge, planForgeFor } from "./plan-filing.ts";

export interface Phase5Args {
  capReason: string | undefined;
  dryRun?: boolean;
  title: string;
  finalBody: string;
  repoRoot: string;
  rawUnparsedHead?: string;
  timed: <T>(phase: string, fn: () => Promise<T>) => Promise<T>;
}

export interface Phase5Result {
  issueUrl?: string;
  filingFailure?: FilingFailure;
}

/**
 * Phase 5 — file (unless dryRun OR the cap routed to surface). D2: when
 * the cap routed to "surface" (CRITICAL remaining — the CRITICAL-only
 * terminal rule, #664 transposed), do NOT file — surface to the operator. D7: the filing failure is DISCRIMINATED and
 * carried on the result; the operator-visible text (plan-tool.ts) surfaces
 * the reason including the forge stderr, without requiring PI_ENSEMBLE_DEBUG.
 */
export async function phase5FilingFailure(args: Phase5Args): Promise<Phase5Result> {
  let issueUrl: string | undefined;
  let filingFailure: FilingFailure | undefined;
  // The cap-based skips set filingFailure REGARDLESS of dryRun: they are
  // policy, and the NOT-FILEABLE head + FILING STATUS must render on a dry
  // run too (hiding a halt behind dryRun is the #647 C1 defect).
  if (args.capReason === "review-unparseable") {
    // Fail closed: nothing was reviewed, so nothing files. The raw head
    // travels so parser-vs-prompt drift is diagnosable, never silent.
    filingFailure = {
      reason: "review-unparseable",
      detail: `the gap-gate review could not be parsed (no structured findings and no verdict, after one strict retry) — the spec was NOT reviewed and was not filed. Re-run start_plan_driver to retry the gate. Raw reviewer output head: ${args.rawUnparsedHead ?? "(unavailable)"}`,
    };
  } else if (args.capReason === "unresolved-blocking") {
    // Deliberate skip: CRITICAL gaps remain (CRITICAL-only blocks; HIGH
    // travels in the residual disclosure) — not filed by policy.
    filingFailure = {
      reason: "cap-surface",
      detail: "the gap gate cap routed to surface (CRITICAL gaps remain) — not filed by policy",
    };
  } else if (args.capReason === "gate-unavailable") {
    // Deliberate skip: the gate dispatch failed — no reviewer saw the spec.
    filingFailure = {
      reason: "gate-unavailable",
      detail:
        "the gap-gate dispatch failed — no reviewer ever saw the spec, so it was not filed (re-run start_plan_driver after the gate failure is addressed)",
    };
  } else if (!args.dryRun) {
    const fr = await args.timed("filing", () =>
      fileIssue(args.title, args.finalBody, getPlanForge() ?? (() => planForgeFor(args.repoRoot))),
    );
    issueUrl = fr.url;
    filingFailure = fr.failure;
  }
  return { issueUrl, filingFailure };
}
