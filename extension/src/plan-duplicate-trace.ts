/**
 * plan-duplicate-trace — the operator-visible trace for one post-filtered
 * duplicate-risk verdict (#1856 review round 2).
 *
 * Split from `plan-investigate.ts` so the barrier keeps a single reason to
 * change; the three lines here are what an operator reads when a HIGH either
 * survives the post-filter or does not, and each names the issues involved.
 * A kept HIGH on an issue the inventory may not even carry has no other
 * evidence trail, so its refs are printed; a downgraded HIGH is a WARN because
 * the driver filed something the risk child called a duplicate.
 */
import { namedIssueTokens } from "./plan-duplicate-self.ts";
import type { DuplicateRisk } from "./plan-investigate.ts";
import { trace, traceWarn } from "./trace.ts";

/**
 * Trace one post-filtered verdict. `kept` is true when the post-filter returned
 * the child's own verdict unchanged (so the driver halts on it), and the named
 * issue refs are printed so the halt is attributable after the fact.
 */
export function traceDuplicateRisk(
  verdict: DuplicateRisk,
  args: { kept: boolean; sourceIssue?: number; fullText: string },
): void {
  if (args.kept) {
    const unjudged = namedIssueTokens(args.fullText).filter(
      (n) => args.sourceIssue === undefined || n !== args.sourceIssue,
    );
    if (unjudged.length > 0) {
      trace(
        `plan-driver: duplicate-risk HIGH kept — unjudged issue ref(s): ${unjudged
          .map((n) => `#${n}`)
          .join(", ")}`,
      );
    }
  }
  trace(`plan-driver: duplicateRisk=${verdict.level}`);
  if (verdict.downgradedFrom !== undefined) {
    const why = verdict.downgradeReason ?? "";
    traceWarn(`plan-driver: duplicate-risk HIGH downgraded — ${why}`);
  }
}
