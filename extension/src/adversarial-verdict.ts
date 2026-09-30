/**
 * adversarial-verdict — what the reviewer said, and what it costs.
 *
 * Split out of `adversarial.ts` because the decision it encodes turned out to
 * be the whole bug, and a decision that consequential deserves to be readable
 * and directly testable rather than inlined in a dispatch loop.
 *
 * ## The defect this closes
 *
 * `agents-base/adversarial-developer.md` defines four verdicts and calls two of
 * them non-blocking:
 *
 *     CRITICAL_ISSUES_FOUND — blocking
 *     ISSUES_FOUND          — "Should address, not blocking"
 *     MINOR_OBSERVATIONS    — "Non-blocking, author's discretion"
 *     APPROVED              — clean
 *
 * The loop knew three of them and exited only on `APPROVED`. So the verdict the
 * doctrine calls *not blocking* halted the cycle, and `MINOR_OBSERVATIONS` —
 * absent from the enum — failed to parse, fell through to the `ISSUES_FOUND`
 * default, and was punished as a malfunction.
 *
 * Measured over 253 loops from the durable session store: 49 ended REJECTED,
 * and 41 of those 49 (83.7%) ended on `ISSUES_FOUND`. Eight ended on
 * `CRITICAL`. A loop still alive at the last round was roughly 2:1 to be
 * rejected — not because the code was bad, but because a reviewer told to
 * "attack this implementation" will always find *something*, and anything was
 * enough.
 *
 * nessie #664 is the worked example: its final round wrote "quality gates pass
 * … the overall design is sound", filed one item under `### ISSUES` and the
 * rest under `### MINOR_OBSERVATIONS`, and returned `ISSUES_FOUND`. The cycle
 * died with green tests, no commit and no PR.
 *
 * ## What replaces it
 *
 * Mid-loop, anything unresolved earns a fix round — that is what rounds are
 * for, and #664's rounds 1 and 2 produced real fixes. At the last round only
 * `CRITICAL_ISSUES_FOUND` blocks. Everything else passes, carrying its
 * outstanding findings to the PR body and into the six-lens review at step 7,
 * which applies the project's own configurable threshold. Nothing is waved
 * through silently; it is handed to the gate with more information.
 */

import { readEnumMarker } from "./reply-markers.ts";
import type { AdversarialVerdict, AdversarialVerdictStatus, DispatchResult } from "./types.ts";

/**
 * The verdicts the reviewer may return, most severe first.
 *
 * Order matters for the parser: `CRITICAL_ISSUES_FOUND` contains
 * `ISSUES_FOUND` as a substring. Leftmost-match already resolves this
 * correctly, but the ordering makes the intent explicit and the canary pins it.
 */
export const VERDICT_STATUSES = [
  "CRITICAL_ISSUES_FOUND",
  "ISSUES_FOUND",
  "MINOR_OBSERVATIONS",
  "APPROVED",
] as const;

/**
 * What the loop does next.
 *
 * `incomplete` is not a review outcome — it means no verdict was produced at
 * all, so there is nothing to pass or reject. The loop reports it as the
 * infrastructure failure it is.
 */
export type LoopAction = "pass" | "fix" | "reject" | "incomplete";

/**
 * Read the reviewer's verdict marker.
 *
 * #408 — this was `/VERDICT:\s*(APPROVED|…)/`: case-sensitive, no tolerance for
 * the `**VERDICT: APPROVED**` that reviewers routinely write. A miss defaulted
 * to `ISSUES_FOUND` *and* passed the whole reply on as `findings`, so an
 * approval was handed to the fix-developer as a list of things to fix.
 *
 * The default is still `ISSUES_FOUND` — another review round is the safe
 * direction. Under the terminal rule below that is no longer fatal, so the safe
 * direction has stopped costing a cycle.
 */
export function parseVerdict(text: string): AdversarialVerdict {
  const status = readEnumMarker(text, "VERDICT", VERDICT_STATUSES);
  if (status) return { status, findings: text, raw: text };
  return {
    status: "ISSUES_FOUND",
    findings: `The reviewer's reply contained no readable VERDICT marker, so its verdict is unknown — this is NOT a list of findings. Treat the text below as unstructured review notes, and if it raises nothing actionable, say so plainly rather than inventing work.\n\n${text}`,
    raw: text,
    verdictParsed: false,
  };
}

/**
 * Decide what a verdict means at this point in the loop.
 *
 * Mid-loop every unresolved verdict earns a fix round. At the last round the
 * doctrine's own blocking level decides: only `CRITICAL_ISSUES_FOUND` rejects.
 */
export function decideLoopAction(
  status: AdversarialVerdictStatus,
  round: number,
  maxRounds: number,
  verdictParsed = true,
): LoopAction {
  // No readable marker means no verdict, and `parseVerdict` defaults the status
  // to ISSUES_FOUND so another round is attempted. That default is safe
  // mid-loop and became dangerous at the terminal round the moment ISSUES_FOUND
  // stopped blocking: a reviewer that crashed, was truncated, or wrote its
  // marker in an unknown shape would have PASSED on no signal whatsoever —
  // the mirror of the bug the relaxation fixed.
  //
  // It is not a rejection either. Nothing was reviewed, so this is an
  // infrastructure failure, which the loop already knows how to report and the
  // step router already knows how to retry.
  if (!verdictParsed) return round < maxRounds ? "fix" : "incomplete";
  if (status === "APPROVED" || status === "MINOR_OBSERVATIONS") return "pass";
  // Unresolved. More rounds left → spend one.
  if (round < maxRounds) return "fix";
  // Out of rounds. Only the verdict the doctrine calls blocking blocks.
  return status === "CRITICAL_ISSUES_FOUND" ? "reject" : "pass";
}

interface SynthesizeInput {
  ok: boolean;
  text: string;
  ms: number;
  usage: DispatchResult["usage"];
  transcriptPath?: string;
  model?: string;
  /** #298 — how the loop ended; see DispatchResult.loopOutcome. */
  loopOutcome?: DispatchResult["loopOutcome"];
  /** #485 — per-round verdict records, threaded from the loop as data. */
  adversarialRounds?: DispatchResult["adversarialRounds"];
  /** #485 — total rounds executed when the loop exited with no verdict. */
  roundsExecuted?: number;
  /** #543 — a loop / token-budget self-kill, threaded so the cap path can distinguish it. */
  killCause?: DispatchResult["killCause"];
}

export function synthesizeResult(i: SynthesizeInput): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: i.ok,
    text: i.text,
    toolUses: [],
    ms: i.ms,
    exitCode: i.ok ? 0 : 1,
    usage: i.usage,
    model: i.model,
    transcriptPath: i.transcriptPath,
    loopOutcome: i.loopOutcome,
    adversarialRounds: i.adversarialRounds,
    roundsExecuted: i.roundsExecuted,
    ...(i.killCause ? { killCause: i.killCause } : {}),
  };
}
