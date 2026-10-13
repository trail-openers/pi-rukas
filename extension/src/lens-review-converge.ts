/**
 * lens-review-converge — the #1129 convergence stop rule for the six-lens
 * review: the round probe, the round-2 downgrade and the CONVERGED verdict.
 * Split out of lens-review.ts (AGENTS.md §12 file-size limit).
 *
 * AGENTS.md §1: round 1 is unchanged. From the second lens round a MEDIUM
 * finding WITHOUT a concrete trigger is downgraded to LOW ("no trigger");
 * HIGH and CRITICAL are never downgraded. The downgrade is a VERDICT-time
 * judgement: the findings memory stores the severity a lens gave and never a
 * downgraded one (review-findings-severity.ts says which rows are eligible).
 * A round whose remaining findings are only those downgrades — and where no
 * lens blocked or went silent and nothing reaches the configured threshold —
 * is CONVERGED (passed).
 */

import { execp } from "./lens-exec.ts";
import { type Severity, type Verdict, computeVerdict } from "./lens-review-format.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import { roundAfter } from "./review-ledger-round.ts";
import { latestEntry, ledgerPathFor, readLedgerAt } from "./review-ledger.ts";

/** The first round the downgrade applies to. */
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
 * The round-2 downgrade, applied when the verdict is computed. Only a MEDIUM
 * with no trigger that is `eligible` (the memory admitted it — see
 * review-findings-severity.ts) becomes a LOW carrying a `downgrade` record;
 * everything else is returned unchanged. Round 1 has no downgrade. The input is
 * not mutated.
 */
export function applyRoundDowngrade(
  findings: Finding[],
  round: number,
  eligible: ReadonlySet<Finding>,
): Finding[] {
  if (round < CONVERGENCE_FROM_ROUND) return findings;
  return findings.map((f) =>
    f.severity === "MEDIUM" && !f.trigger && eligible.has(f)
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
 * decided) becomes CONVERGED when the downgrade applied to at least one finding.
 * REVIEW_INCOMPLETE, CRITICAL_ISSUES_FOUND and ISSUES_FOUND keep their
 * precedence; a review with zero findings stays APPROVED.
 */
export function convergeVerdict(verdict: Verdict, judged: Finding[]): Verdict {
  return verdict === "APPROVED" && judged.some((f) => f.downgrade) ? "CONVERGED" : verdict;
}

/**
 * The round's reported findings and verdict. `kept` are this round's findings
 * as the memory reported them; `recorded` carries the open rows this round did
 * not re-report (`carried`) and the set the downgrade may touch (`downgradable`,
 * by identity). With no memory (`recorded` not ok or absent) every fresh finding
 * in `unrecorded` is eligible. CONVERGED is decided on the REPORTED findings, so
 * a downgrade the store reversed cannot pass the verdict silently.
 */
export function judgeRound(
  kept: Finding[],
  recorded: { ok: boolean; carried?: Finding[]; downgradable?: ReadonlySet<Finding> } | undefined,
  unrecorded: Finding[],
  lensResults: LensRunResult[],
  threshold: Severity,
  round: number,
): { reported: Finding[]; verdict: Verdict } {
  const carried = recorded?.ok ? (recorded.carried ?? []) : [];
  const eligible = recorded?.ok ? (recorded.downgradable ?? new Set()) : new Set(unrecorded);
  const reported = applyRoundDowngrade([...kept, ...carried], round, eligible);
  const verdict = convergeVerdict(computeVerdict(reported, lensResults, threshold), reported);
  return { reported, verdict };
}
