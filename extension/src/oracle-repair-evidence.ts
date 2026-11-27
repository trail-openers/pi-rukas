/**
 * oracle-repair-evidence — the executed evidence a repair brief is allowed to carry, and nothing else.
 *
 * The repair seat exists to correct an oracle the builder could not satisfy. The one way that round becomes
 * worse than no round is for it to see the builder's work: a child that reads the build diff writes the test
 * its code already passes, which is exactly the oracle the run was trying to repair. So the brief is built
 * from a closed list — the spec, the named file, the driver's own reason, and the output the DRIVER watched
 * the project's runner print at that head — and every other fact about the run is absent by construction, not
 * by restraint.
 *
 * `blockedEvidenceLines` is the ONLY reader of a blocked step's record that feeds a prompt, and it reads the
 * record rather than a builder's prose: `blockedBy` is written by `build-blocked.ts` from the files it
 * actually executed and stopped at, so a line here cannot be a claim nobody ran.
 *
 * Lives outside `src/lean/` for the line budget, and because it is prompt text, not engine state.
 */
import { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP } from "./lean/state-outcome-maps.ts";
import { BLOCKED_EVIDENCE_OUTPUT_CAP } from "./oracle-repair-record.ts";
import type { Step } from "./lean/state.ts";
import { oneLine } from "./lean/text-fence.ts";

/** How many evidence lines one brief carries, so a 32-file report does not become a wall. */
const EVIDENCE_LINE_CAP = 8;

/** The two facts of one proven conflict, sanitised for a prompt. */
export interface EvidenceRow {
  path: string;
  reason: string;
}

/**
 * The named frozen files and their stated conflicts, from the newest decided `build:blocked` step.
 *
 * `blockedBy` is the record's own map; a step that proved nothing has none, and this returns `[]` rather than
 * guessing. The reason is the child's prose, so it is bounded and one-lined exactly as the durable record and
 * the handback comment bound it — three readers of one field, one sanitising rule.
 */
export function blockedEvidenceLines(steps: Step[]): EvidenceRow[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "build" || step.outcome?.kind !== "blocked") continue;
    return Object.entries(step.outcome.blockedBy ?? {})
      .slice(0, EVIDENCE_LINE_CAP)
      .map(([path, reason]) => ({
        path: oneLine(path, BLOCKED_PATH_CAP),
        reason: oneLine(reason, BLOCKED_REASON_CAP),
      }));
  }
  return [];
}

/**
 * The lines of the executed red the driver itself watched: which file, which runner command, what it printed.
 *
 * Read off the record beside `blockedBy` rather than kept in a closure, so a resumed run shows the repair seat
 * the same evidence the visit that proved it did. Absent means the step recorded no output, and a brief with
 * no evidence line is a refusal, never an empty section.
 */
export interface HeadEvidenceRow {
  /** The frozen file the driver ran. */
  path: string;
  /** The runner command as the driver rendered it. */
  cmd: string;
  /** The runner's own output on the red, already clipped. */
  output: string;
}

/**
 * Read the at-head evidence off one blocked step, or `[]` when it recorded none.
 *
 * Re-sanitised on the way to a prompt rather than trusted from the record: a state file an operator edited
 * is untrusted input, and this is the one path from that file into a child's prompt.
 */
export function headEvidenceFromStep(step: Step | undefined): HeadEvidenceRow[] {
  const raw = step?.outcome?.blockedEvidence;
  if (!Array.isArray(raw)) return [];
  const rows: HeadEvidenceRow[] = [];
  for (const e of raw.slice(0, EVIDENCE_LINE_CAP)) {
    if (typeof e?.path !== "string" || typeof e.cmd !== "string" || typeof e.output !== "string")
      continue;
    rows.push({
      path: oneLine(e.path, BLOCKED_PATH_CAP),
      cmd: oneLine(e.cmd, BLOCKED_PATH_CAP),
      output: oneLine(e.output, BLOCKED_EVIDENCE_OUTPUT_CAP),
    });
  }
  return rows;
}
