import { blockedClaimKey, blockedProved, usableConflicts } from "../oracle-repair-prove.ts";
import { BLOCKED_EVIDENCE_OUTPUT_CAP, type EvidenceLine } from "../oracle-repair-record.ts";
/**
 * lean/build-blocked — the anti-forgery gate for the build child's "these frozen tests cannot all pass
 * together" report.
 *
 * The child's report is narration, not executed evidence. A builder that could end a run by naming a conflict
 * would end runs whose contract it never read, or one that is satisfiable. The driver honours it only when
 * BOTH hold:
 *
 *   1. **every named path is in the run's frozen map** — read off the same `frozenFromLog` every other reader
 *      of the contract uses;
 *   2. **at least one named frozen test comes back red on the child's tree**, run with the project's own
 *      `verify.test` template through the runner `verify` and `specify` use.
 *
 * A runner that could not start or was killed is NOT a red — it observed nothing — and a green named test is
 * not a conflict either. The re-run itself is `oracle-repair-prove.ts`; the entry and reason bounds are the DURABLE
 * record's, so an entry it could not persist is refused before anything is spent running it.
 */
import { trace, traceWarn } from "../trace.ts";
import { extractBlockedReport } from "./build-blocked-extract.ts";
import type { BuildExec, NormaliseReport } from "./build-types.ts";
import { renderTestCommand } from "./specify-proof.ts";
import { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP } from "./state-outcome-maps.ts";
import { oneLine } from "./text-fence.ts";

/** The cause LINE's ceiling: the renderer caps plus the sentence around them. */
const BLOCKED_CAUSE_CAP = BLOCKED_PATH_CAP + BLOCKED_REASON_CAP + 44;

/** The child's report judged end to end. `undefined` says "not honoured". */
export async function judgeBlockedReport(opts: {
  exec: BuildExec;
  wt: string;
  template: string | undefined;
  frozen: Record<string, string>;
  toolUses: unknown[];
  issue: number;
  timeoutMs?: number;
}): Promise<
  { reason: string; blockedBy: Record<string, string>; evidence: EvidenceLine[] } | undefined
> {
  const extracted = extractBlockedReport(opts.toolUses);
  if (extracted.rows.length === 0) {
    if (extracted.skipped > 0)
      trace(
        `lean build #${String(opts.issue)}: ignored ${String(extracted.skipped)} unreadable report_blocked call(s)`,
      );
    return undefined;
  }
  const paths = usableConflicts(extracted.rows);
  const proved = await blockedProved({
    exec: opts.exec,
    wt: opts.wt,
    template: opts.template,
    frozen: opts.frozen,
    paths,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  if (!proved.honoured) {
    // The refused claim still names what was claimed: a cell that spent its one round on a refused repair is
    // only attributable if the ledger can see the claim that bought it.
    traceWarn(`${blockedClaimKey(opts.issue, paths)} — ${proved.why}`);
    return undefined;
  }
  // Only files the driver ACTUALLY RAN enter the record (`proved.ran` stops at the red), sanitised here
  // rather than at each reader since this durable record prints the child's prose. The first reason a path was
  // given wins.
  const ran = new Set(proved.ran);
  const blockedBy: Record<string, string> = {};
  for (const row of extracted.rows) {
    if (!ran.has(row.path) || row.path in blockedBy) continue;
    blockedBy[oneLine(row.path, BLOCKED_PATH_CAP)] = oneLine(row.reason, BLOCKED_REASON_CAP);
  }
  const red = proved.red;
  if (!(red in blockedBy)) return undefined;
  // Bounded and sanitised where it is built: this durable record prints into a child's prompt.
  const evidence = executedEvidence(opts.template ?? "", proved);
  // The cause line leads with the file the driver watched fail; the map carries all.
  return {
    reason: oneLine(
      `frozen tests cannot all pass together: ${red} — ${blockedBy[red] ?? ""}`,
      BLOCKED_CAUSE_CAP,
    ),
    blockedBy,
    evidence,
  };
}

/** The driver's own run of the file under dispute: the command it rendered, and what came back. Only the RED
 * file's output is carried — the greens argue nothing about the conflict and would only widen a prompt.
 */
function executedEvidence(
  template: string,
  proved: { red: string; output: string },
): EvidenceLine[] {
  return [
    {
      path: proved.red,
      cmd: renderTestCommand(template, proved.red),
      output: oneLine(proved.output, BLOCKED_EVIDENCE_OUTPUT_CAP),
    },
  ];
}
