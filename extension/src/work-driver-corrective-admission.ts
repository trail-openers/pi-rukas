/**
 * work-driver-corrective-admission — #1698(b): the one admission a fix pass
 * grants to the corrective round it dispatched itself.
 *
 * When the develop verify INSIDE a fix pass fails on attributed assertion
 * lines, the driver dispatches ONE corrective developer per failing workstream
 * with those exact lines (`work-driver-corrective-round.ts`) and tells it to
 * repair the files they name. The fix-pass fence used to read that committed
 * file as a stray and cap the cycle for making the edit the driver itself
 * ordered. This module is the whole of that admission, and the whole of its
 * bound.
 *
 * Three conditions, and only these — and each is a thing the DRIVER did, not a
 * thing the developer said:
 *
 *   (ii) the file is in the round's OWN target set: a path its evidence lines
 *        name. The driver dispatched that developer with those lines, so the
 *        target set is a record, not a claim;
 *   (i)  `git` reports the file changed AFTER `headAtRound` — the commit the
 *        round's record carries from the moment BEFORE any corrective developer
 *        started. Without this, evidence alone would authorise any file with
 *        that path in its name, including one the fix pass itself wrote before
 *        the round existed;
 *   (iii) it is unfenced and unprotected. Those two guards are NOT here: the
 *        fix fence runs them through the shared admitter (`fenced` then
 *        `protected`) BEFORE asking this module, so a fence the plan wrote and
 *        the protected-path gate keep their precedence over the round.
 *
 * `CORRECTIVE_ADMIT_MAX` caps how many files one round contributes per
 * workstream — the same shape as `SPEC_SLOT_MAX_FILES` on the spec-slot side:
 * an authorisation is a budget, not a skeleton key. A round whose record has no
 * usable `headAtRound` (state written before this field existed, or a HEAD the
 * driver could not read) admits NOTHING and its refusal says so: the commit
 * window IS the proof, and with no proof there is no admission.
 *
 * Split from `work-driver-adversarial-fix-scope.ts` for the AGENTS.md §12 size
 * limit. The fence calls `createCorrectiveAdmission` once per workstream and
 * asks it the three questions in order.
 */

import { trace } from "./trace.ts";
import { type FixExec, committedChanges, headOf } from "./work-driver-adversarial-fix-git.ts";
import { normaliseDeclaredPath } from "./work-driver-declared-path.ts";
import type { CorrectiveRoundEvent } from "./workflow-state-events-corrective.ts";

/** How many files ONE corrective round may contribute to one workstream. */
export const CORRECTIVE_ADMIT_MAX = 3;

/** One workstream's corrective round, as the fence reads it. */
export interface CorrectiveRound {
  /** The joined evidence lines that workstream's developer was dispatched with. */
  evidence: string;
  /** The verify command whose failure the round was built from (trace-only). */
  command: string;
  /**
   * The worktree's commit when the round was recorded. A round written before
   * #1698(b), or whose HEAD the driver could not read, carries none — and then
   * the fence admits nothing from it.
   */
  headAtRound?: string;
}

/**
 * The `corrective-round` records a fix pass carries, taken from THAT pass's
 * event window. The gate owns its input: the caller hands over the window's
 * events and this does the narrowing, so no caller can hand over a pre-joined
 * string the fence then trusts without the records behind it.
 */
export function correctiveRoundsOf(events: readonly { kind: string }[]): CorrectiveRoundEvent[] {
  return events.filter((e): e is CorrectiveRoundEvent => e.kind === "corrective-round");
}

/**
 * The one round this workstream ran, joined from its records. Keyed by
 * workstream rather than read through an object index: the key is driver
 * state, and a plain `{}` would let a workstream id of `__proto__` write
 * through the prototype. A cycle runs at most one round; if the log carries
 * several, their evidence joins and the FIRST recorded baseline governs, so a
 * later record can never widen the admitted window backwards to a commit the
 * earlier round did not have.
 */
export function correctiveRoundFor(
  events: readonly CorrectiveRoundEvent[],
  workstreamId: string,
): CorrectiveRound | undefined {
  let round: CorrectiveRound | undefined;
  for (const e of events) {
    if (e.workstreamId !== workstreamId) continue;
    round = {
      evidence: `${round?.evidence ?? ""}\n${e.evidenceLines.join("\n")}`,
      command: round?.command ? round.command : e.command,
      headAtRound: round?.headAtRound ?? e.headAtRound,
    };
  }
  return round;
}

/**
 * A path as `git` and the fence both spell it. The evidence is prose the verify
 * command emitted, so it can carry the same decoration a declared path does —
 * and the ONE declared-path normaliser strips it, so "the evidence names this
 * file" and "the plan declared this file" are answered from one reading
 * (AGENTS.md §12: no second normaliser to drift).
 */
const cleanPath = normaliseDeclaredPath;

/** The path-like tokens one round's evidence names — its own target set. */
function evidenceTargets(evidence: string): Set<string> {
  const out = new Set<string>();
  for (const raw of evidence.split(/[\s,;()[\]]+/)) {
    // Lead-in decoration (a `✗` mark, a bullet) and a `:line:col` suffix are
    // not part of the path; neither is trailing prose punctuation.
    const tok = raw
      .replace(/^[^\w./@-]+/, "")
      .replace(/:\d+(?::\d+)?$/, "")
      .trim();
    if (tok.includes("/") || /\.\w+$/.test(tok)) out.add(cleanPath(tok));
  }
  return out;
}

/** One workstream's corrective admission, with its commit window read once. */
export interface CorrectiveAdmission {
  /** Is `file` in the round's own target set? */
  names(file: string): boolean;
  /**
   * Why this round may NOT admit `file`; `undefined` when it may. `fenced` and
   * `protected` are the CALLER's guards and run before this (see the header).
   */
  refusal(file: string): Promise<string | undefined>;
  /**
   * Record the admission: counts it against the cap, traces ONE line, and
   * returns the disclosure note for the caller to surface — the audit trail an
   * operator reads. A fence that widened invisibly is the failure class #1522
   * was written about.
   */
  admit(id: string, file: string): string;
}

/**
 * The admission for one workstream's round. `round` is `undefined` when the
 * pass ran no corrective round for that workstream — every question then
 * answers "no", and the fence's ordinary refusal stands.
 */
export function createCorrectiveAdmission(
  execFn: FixExec,
  round: CorrectiveRound | undefined,
  worktree: string,
  timeoutMs?: number,
): CorrectiveAdmission {
  const targets = round ? evidenceTargets(round.evidence) : undefined;
  let count = 0;
  // The post-round commit window, read ONCE per workstream. `null` means it
  // could not be read at all (no recorded baseline, or a failing `git`) — not
  // the same as "empty": it is the fail-closed answer, and it is named as such.
  let postRound: Set<string> | null | undefined;
  const changedAfterRound = async (): Promise<Set<string> | null> => {
    if (postRound !== undefined) return postRound;
    const baseline = round?.headAtRound;
    if (baseline === undefined) {
      postRound = null;
      return postRound;
    }
    const headNow = await headOf(execFn, worktree, timeoutMs);
    if (!headNow.ok) {
      postRound = null;
      return postRound;
    }
    const since = await committedChanges(execFn, worktree, baseline, headNow.value, timeoutMs);
    postRound = since.ok ? new Set(since.value) : null;
    return postRound;
  };
  return {
    names: (file) => targets?.has(cleanPath(file)) === true,
    async refusal(file) {
      const since = await changedAfterRound();
      if (since === null)
        return "the corrective round recorded no usable HEAD baseline, so nothing it did is provable";
      if (!since.has(file))
        return "it was not committed after the corrective round began — the round did not change it";
      if (count >= CORRECTIVE_ADMIT_MAX)
        return `the round already admitted its ${CORRECTIVE_ADMIT_MAX} evidence-named files`;
      return undefined;
    },
    admit(id, file) {
      count++;
      trace(
        `work-driver: fix pass ${id} admitted ${file} — the corrective round dispatched against ${round?.command ?? "its verify command"} named it`,
      );
      return `${id}: ${file} admitted — the corrective round's evidence named it and it changed after that round began`;
    },
  };
}
