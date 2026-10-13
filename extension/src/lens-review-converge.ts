/**
 * lens-review-converge — the #1129 convergence stop rule for the six-lens
 * review: the round probe, the round-2 downgrade pre-pass and the CONVERGED
 * verdict. Split out of lens-review.ts (AGENTS.md §12 file-size limit).
 *
 * AGENTS.md §1: round 1 is unchanged. From the second lens round a MEDIUM
 * finding WITHOUT a concrete trigger is downgraded to LOW ("no trigger");
 * HIGH and CRITICAL are never downgraded. A round whose remaining findings
 * are only those downgrades — and where no lens blocked or went silent and
 * nothing reaches the configured threshold — is CONVERGED (passed).
 */

import { execp } from "./lens-exec.ts";
import { type Severity, type Verdict, computeVerdict } from "./lens-review-format.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import { roundAfter } from "./review-ledger-round.ts";
import { latestEntry, ledgerPathFor, readLedgerAt } from "./review-ledger.ts";

/** The first round the downgrade pre-pass applies to. */
export const CONVERGENCE_FROM_ROUND = 2;

/** The reason recorded on every downgraded finding. */
export const NO_TRIGGER_REASON = "no trigger";

/**
 * The round this review runs as: the branch's latest lens ledger entry
 * probed by `roundAfter`. No resolvable branch (or no ledger yet) → round 1.
 */
export async function probeLensRound(cwd: string, branch: string | undefined): Promise<number> {
  if (!branch) return 1;
  const file = await ledgerPathFor(execp, cwd);
  if (!file) return 1;
  return roundAfter(latestEntry(readLedgerAt(file), branch, "lens"));
}

/**
 * The downgrade pre-pass (runs BEFORE dedupe). On round ≥ 2 each MEDIUM with
 * no trigger becomes a LOW carrying a `downgrade` record; everything else is
 * returned unchanged. Round 1 has no pre-pass. The input is not mutated.
 */
export function applyRoundDowngrade(findings: Finding[], round: number): Finding[] {
  if (round < CONVERGENCE_FROM_ROUND) return findings;
  return findings.map((f) =>
    f.severity === "MEDIUM" && !f.trigger
      ? {
          ...f,
          severity: "LOW",
          downgrade: { from: "MEDIUM", reason: NO_TRIGGER_REASON },
        }
      : f,
  );
}

/**
 * CONVERGED: an APPROVED verdict (zero findings at or above the threshold, no
 * CRITICAL, every lens complete — all of which `computeVerdict` has already
 * decided) becomes CONVERGED when the pre-pass downgraded at least one finding.
 * REVIEW_INCOMPLETE, CRITICAL_ISSUES_FOUND and ISSUES_FOUND keep their
 * precedence; a review with zero findings stays APPROVED.
 */
export function convergeVerdict(verdict: Verdict, judged: Finding[]): Verdict {
  return verdict === "APPROVED" && judged.some((f) => f.downgrade) ? "CONVERGED" : verdict;
}

/**
 * The round's reported findings and verdict. Carried rows (open findings the
 * round did not re-report, from the findings memory) get the same pre-pass as
 * this round's findings, so a trigger-less MEDIUM a round-2 lens omits still
 * downgrades; a triggered one (the row keeps its trigger) still blocks. A
 * downgraded carried row counts toward CONVERGED like a judged one. CONVERGED is
 * decided on the REPORTED findings (what the store kept), so a downgrade the
 * store reversed cannot pass the verdict silently. Legacy
 * carried rows (written before #1129, no trigger ever recorded) are NOT
 * downgraded: they keep their stored MEDIUM until a lens re-reports them.
 */
export function judgeRound(
  kept: Finding[],
  recorded: { ok: boolean; carried?: Finding[]; legacy?: Finding[] } | undefined,
  lensResults: LensRunResult[],
  threshold: Severity,
  round: number,
): { reported: Finding[]; verdict: Verdict } {
  const carried = applyRoundDowngrade(recorded?.ok ? (recorded.carried ?? []) : [], round);
  const legacy = recorded?.ok ? (recorded.legacy ?? []) : [];
  const reported = [...kept, ...carried, ...legacy];
  const verdict = convergeVerdict(computeVerdict(reported, lensResults, threshold), reported);
  return { reported, verdict };
}
