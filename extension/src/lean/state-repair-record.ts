/**
 * lean/state-repair-record — the repair round's own two facts, and the rules that keep them facts.
 *
 * A run that repaired a frozen test has to be able to say, afterwards, WHAT it replaced and WHAT it now holds
 * the run to. Two things answer that, and neither may be a child's claim:
 *
 *   - `originalHashes` — the content hash of the file the round REPLACED, taken from the frozen map the run
 *     already held. A reader can see the contract the run started with against the one it finished with.
 *   - `passedAtHead` — whether the replacement passed at the build head when the DRIVER ran it there. A path
 *     whose value is `false` is a replacement whose pass was never observed, and the disclosure prints that
 *     rather than inferring a pass from a green `verify`.
 *
 * The round is one-shot: `repairsSpent` on the counters and `repairAttempted` on the record, so a run that
 * spent its round and handed back cannot spend it again on resume.
 *
 * Separate from `state-outcome-gates.ts` because that file's fields describe the gates' verdicts; this one
 * describes an action the build step took, and its rules read the frozen map rather than a runner.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import { BLOCKED_PATH_CAP, RECORD_MAX_ENTRIES } from "./state-outcome-maps.ts";
import { frozenKeyProblem } from "./state-outcome.ts";

/** One repaired frozen test, as the record and the disclosure print it. */
export interface RepairRecord {
  /** The round number, 1-based. A run has one repair, so today this is always 1. */
  round: number;
  /** The build head the replacements were run at — the commit `verify` then had to hold green. */
  baseSha: string;
  /** Per replaced path: the ORIGINAL frozen file's content hash. */
  originalHashes: Record<string, string>;
  /** Per replaced path: whether the replacement passed at the build head, as the driver observed it. */
  passedAtHead: Record<string, boolean>;
}

/** Why a loaded `repair` field is not a record, or `undefined` when it is one. */
export function repairRecordProblem(v: unknown, frozen: Record<string, string> | undefined): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "repair must be an object";
  const o = v as Record<string, unknown>;
  if (typeof o.round !== "number" || !Number.isInteger(o.round) || o.round < 1)
    return "repair.round must be a positive integer";
  if (typeof o.baseSha !== "string" || !isFullCommitSha(o.baseSha))
    return "repair.baseSha must be a full commit sha";
  const original = replacementMapProblem(o.originalHashes, frozen, "repair.originalHashes");
  if (original !== undefined) return original;
  const passed = o.passedAtHead;
  if (typeof passed !== "object" || passed === null || Array.isArray(passed))
    return "repair.passedAtHead must be an object";
  const replaced = Object.keys(o.originalHashes as Record<string, string>);
  const entries = Object.entries(passed as Record<string, unknown>);
  if (entries.length !== replaced.length)
    return "repair.passedAtHead must hold exactly the replaced paths";
  for (const [path, value] of entries) {
    if (!replaced.includes(path))
      return `repair.passedAtHead names ${path.slice(0, BLOCKED_PATH_CAP)}, which was not replaced`;
    if (typeof value !== "boolean")
      return `repair.passedAtHead[${path.slice(0, BLOCKED_PATH_CAP)}] must be a boolean`;
  }
  return undefined;
}

/** Rebuild a validated record, so a loaded object never keeps an unchecked member. */
export function validatedRepairRecord(v: unknown): RepairRecord {
  const o = v as { round: number; baseSha: string; originalHashes: Record<string, string>; passedAtHead: Record<string, boolean> };
  return {
    round: o.round,
    baseSha: o.baseSha,
    originalHashes: { ...o.originalHashes },
    passedAtHead: { ...o.passedAtHead },
  };
}

/** One path -> content-hash map: non-empty, bounded, and every path one the run froze. */
function replacementMapProblem(
  v: unknown,
  frozen: Record<string, string> | undefined,
  field: string,
): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return `${field} must be an object`;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return `${field} is empty, so nothing was repaired`;
  if (entries.length > RECORD_MAX_ENTRIES)
    return `${field} must hold at most ${RECORD_MAX_ENTRIES} files`;
  for (const [path, hash] of entries) {
    const key = frozenKeyProblem(path);
    if (key !== undefined) return `${field} key ${path.slice(0, BLOCKED_PATH_CAP)} is not a valid test path: ${key}`;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
      return `${field}[${path.slice(0, BLOCKED_PATH_CAP)}] must be a content hash`;
    if (frozen === undefined || !(path in frozen))
      return `${field} names ${path.slice(0, BLOCKED_PATH_CAP)}, which the run never froze`;
  }
  return undefined;
}
