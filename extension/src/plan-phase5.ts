/**
 * plan-phase5 — the compiled /plan pipeline's Phase 5: the cap-skip
 * routing for the DISCRIMINATED filing failure + the single filing pass.
 *
 * Moved from plan-driver.ts along the 500-line seam (AGENTS.md §12) —
 * code only, the comments verbatim, so the driver keeps the Phase 5
 * section header as the orchestration-visible seam.
 */
import {
  type FilingFailure,
  fileIssue,
  getPlanForge,
  labelGate,
  planForgeFor,
} from "./plan-filing.ts";
import { validateFinalSpec } from "./plan-validate.ts";

export interface Phase5Args {
  capReason: string | undefined;
  dryRun?: boolean;
  title: string;
  finalBody: string;
  /** The operator context: its NEVER CLAIM block is re-checked on the final body (#1043). */
  context?: string;
  repoRoot: string;
  rawUnparsedHead?: string;
  /**
   * #1377: labels to create the issue with. Checked against the repo's label
   * list BEFORE the create call (a missing label halts filing, nothing is filed
   * and no label is created); passed to the forge so the issue carries them from
   * its first moment. Empty/absent → the pre-#1377 code path exactly.
   */
  labels?: string[];
  timed: <T>(phase: string, fn: () => Promise<T>) => Promise<T>;
}

export interface Phase5Result {
  issueUrl?: string;
  /** #1377: the filed issue's number, when the forge response carried one. */
  issueNumber?: number;
  filingFailure?: FilingFailure;
}

/**
 * Phase 5 — file (unless dryRun OR the cap routed to surface). D2: when
 * the cap routed to "surface" (CRITICAL remaining — the CRITICAL-only
 * terminal rule, #664 transposed), do NOT file — surface to the operator. D7: the filing failure is DISCRIMINATED and
 * carried on the result; the operator-visible text (plan-tool.ts) surfaces
 * the reason including the forge stderr, without requiring PI_ENSEMBLE_DEBUG.
 * #1132: the cap no longer routes to surface. Still-blocking CRITICAL points are
 * filed in the body as open points, so the iteration cap does not prevent filing.
 */
export async function phase5FilingFailure(args: Phase5Args): Promise<Phase5Result> {
  let issueUrl: string | undefined;
  let issueNumber: number | undefined;
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
  } else if (args.capReason === "gate-unavailable") {
    // Deliberate skip: the gate dispatch failed — no reviewer saw the spec.
    filingFailure = {
      reason: "gate-unavailable",
      detail:
        "the gap-gate dispatch failed — no reviewer ever saw the spec, so it was not filed (re-run start_plan_driver after the gate failure is addressed)",
    };
  } else {
    // #1043: the final-spec checks run on every path that would file, a dry run
    // included, so a dry run's fileability already reflects them.
    const check = validateFinalSpec(args.title, args.finalBody, args.context);
    if (!check.ok) {
      filingFailure = {
        reason: "draft-invalid",
        detail: `the final spec failed deterministic checks, so it was not filed: ${check.problems.join("; ")}`,
      };
    } else if (!args.dryRun) {
      // #1377: ONE "filing" timed phase, sequenced inside it — the label
      // existence check, then the create call. Appending two "filing" entries
      // would double the phase in the operator-visible timings line for a path
      // that has nothing to do with a second filing.
      const resolver = getPlanForge() ?? (() => planForgeFor(args.repoRoot, args.labels ?? []));
      const fr = await args.timed("filing", async () => {
        const gate = await labelGate(args.labels ?? [], resolver);
        if (gate) return { failure: gate };
        return fileIssue(args.title, args.finalBody, resolver, { labels: args.labels ?? [] });
      });
      issueUrl = fr.url;
      issueNumber = fr.number;
      filingFailure = fr.failure;
    }
  }
  return { issueUrl, issueNumber, filingFailure };
}
