/**
 * oracle-repair-record — the `blockedEvidence` field the repair round reads, and the rules that keep it a
 * fact. Pure over plain values, so it lives outside `src/lean/`: the engine calls into the judgement rather
 * than owning it. See `oracle-repair-fields.ts` for the round's other field.
 *
 * `blockedBy` says which frozen file the driver proved cannot pass. This says what the project's runner
 * actually printed when the driver ran it, which is the only thing a repair brief may quote: a seat that read
 * the builder's prose about the failure would be reading an argument, and an argument about a test is exactly
 * what this round must not hear. Because the field is printed into a child's prompt, every member is bounded
 * and control-character-free, and a row that cannot be shown to be one run of one named file is refused
 * rather than carried.
 */

import { BLOCKED_PATH_CAP } from "./lean/state-outcome-maps.ts";
import { frozenKeyProblem } from "./lean/state-outcome.ts";

/** How many executed runs one blocked step may record — the same bound the brief reads. */
export const BLOCKED_EVIDENCE_MAX = 8;

/** One executed run of one named frozen file, as the record holds it. */
export interface EvidenceLine {
  path: string;
  cmd: string;
  output: string;
}

/** The bound on one row's quoted output: long enough to see a failing assertion, short enough for a prompt. */
export const BLOCKED_EVIDENCE_OUTPUT_CAP = 600;

/** Why the list is not a record of executed runs, or `undefined` when it is. */
export function blockedEvidenceProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "outcome blockedEvidence must be an array";
  if (value.length > BLOCKED_EVIDENCE_MAX)
    return `outcome blockedEvidence must hold at most ${BLOCKED_EVIDENCE_MAX} runs`;
  for (const row of value as unknown[]) {
    const problem = rowProblem(row);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Rebuild the list from the rows this module actually checked. */
export function validatedBlockedEvidence(value: unknown): EvidenceLine[] {
  if (!Array.isArray(value)) return [];
  const out: EvidenceLine[] = [];
  for (const row of value as unknown[]) {
    const r = row as { path: string; cmd: string; output: string };
    out.push({ path: r.path, cmd: r.cmd, output: r.output });
    if (out.length >= BLOCKED_EVIDENCE_MAX) break;
  }
  return out;
}

/** One row: three strings, a nameable path, a one-line command, output that cannot forge a heading. */
function rowProblem(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row))
    return "outcome blockedEvidence rows must be objects";
  const r = row as Record<string, unknown>;
  for (const key of ["path", "cmd", "output"] as const) {
    if (typeof r[key] !== "string") return `outcome blockedEvidence row needs a string ${key}`;
  }
  const path = r.path as string;
  if (path.length > BLOCKED_PATH_CAP)
    return `outcome blockedEvidence path is over ${BLOCKED_PATH_CAP} characters`;
  const key = frozenKeyProblem(path);
  if (key !== undefined)
    return `outcome blockedEvidence path ${path.slice(0, BLOCKED_PATH_CAP)} is not a valid test path: ${key}`;
  const cmd = r.cmd as string;
  if (cmd.length > BLOCKED_PATH_CAP)
    return `outcome blockedEvidence cmd is over ${BLOCKED_PATH_CAP} characters`;
  const output = r.output as string;
  if (output.length > BLOCKED_EVIDENCE_OUTPUT_CAP)
    return `outcome blockedEvidence output is over ${BLOCKED_EVIDENCE_OUTPUT_CAP} characters`;
  // The output reaches a child's prompt inside a fenced block: no control character survives, so a row
  // cannot close the fence and become the prompt's own instruction.
  if (/\p{Cc}/u.test(cmd) || /\p{Cc}/u.test(output))
    return "outcome blockedEvidence cmd and output must be free of control characters";
  return undefined;
}
