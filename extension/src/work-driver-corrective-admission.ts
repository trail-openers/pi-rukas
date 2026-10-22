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
 * The route keeps route (a) (`namedPaths`) provenance and anchor requirements
 * and adds a window of its OWN. A file is admitted only when ALL of these hold,
 * and each is a thing the DRIVER did, not a thing the developer said — the
 * refusal names the one that failed:
 *
 *   (1) it is in the candidate set route (a) reads —
 *        `trackedPaths(base) ∪ committedChanges(base..headBefore)`: a file the
 *        cycle already made, or one that existed at base. Handed in from the
 *        plan and never recomputed here, so the two routes cannot disagree about
 *        what the cycle owns. Refused as `not-candidate`;
 *   (2) its directory is anchored to a declared path or an already-changed
 *        non-root path, the SAME rule (`anchorDirs`) route (a) applies — again
 *        handed in from the plan. Refused as `not-anchored`;
 *   (3) the round's own evidence names it, judged by the SAME matcher as route
 *        (a) (`pathTokenIn`) — this module used to carry its own
 *        `evidenceTargets` splitter, and a second answer to "does this prose name
 *        this file" is exactly the drift the shared module exists to prevent. A
 *        file no evidence line names is refused as `not-candidate`: the driver
 *        never ordered it, so the round is not its author;
 *   (4) `git` reports the file changed AFTER `headAtRound` — the commit the
 *        round's record carries from the moment BEFORE any corrective developer
 *        started. Without this, evidence alone would authorise any file with
 *        that path in its name, including one the fix pass itself wrote before
 *        the round existed. Refused as `not-post-round`, or as `no-baseline` /
 *        `git-read-failed` when the window could not be read at all;
 *   (5) it is unfenced and unprotected. Those two guards are NOT here: the fix
 *        fence runs them through the shared admitter (`fenced` then `protected`)
 *        BEFORE asking this module — see `CORRECTIVE_PRECEDES` in the fence,
 *        which states that precedence positively — so a fence the plan wrote and
 *        the protected-path gate keep their precedence over the round;
 *   (6) `CORRECTIVE_ADMIT_MAX` files per workstream is not yet spent — the same
 *        shape as `SPEC_SLOT_MAX_FILES` on the spec-slot side: an authorisation
 *        is a budget, not a skeleton key. Refused as `cap`.
 *
 * A round whose record has no usable `headAtRound` (state written before this
 * field existed, or a HEAD the driver could not read) admits NOTHING and says
 * `no-baseline`: the commit window IS the proof, and with no proof there is no
 * admission. A failing `git` read is the distinct `git-read-failed` — an
 * unreadable tree is not evidence that nothing changed.
 *
 * RESIDUAL LIMIT, stated plainly: a stray that the round itself also touches,
 * inside an anchored directory, is admitted. That is the same widening route (a)
 * already allows — route (a) admits a finding-named file the cycle made, in an
 * anchored directory, with no window at all. What the window buys is the
 * attribution to THIS round; the bound on how far a round can reach is the
 * provenance set, the anchor and the cap, not the round's own identity.
 *
 * Split from `work-driver-adversarial-fix-scope.ts` for the AGENTS.md §12 size
 * limit. The fence builds one per workstream that ran a round and makes ONE call
 * per candidate stray.
 */

import { trace } from "./trace.ts";
import {
  type FixExec,
  committedChanges,
  gitReadTimeoutMs,
  headOf,
} from "./work-driver-adversarial-fix-git.ts";
import { dirOfPath, pathTokenIn } from "./work-driver-declared-path.ts";
import type { CorrectiveRoundEvent } from "./workflow-state-events-corrective.ts";
import type { WorkEvent } from "./workflow-state.ts";

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
export function correctiveRoundsOf(events: readonly WorkEvent[]): CorrectiveRoundEvent[] {
  return events.filter((e): e is CorrectiveRoundEvent => e.kind === "corrective-round");
}

/**
 * The one round this workstream ran. Keyed by workstream rather than read
 * through an object index: the key is driver state, and a plain `{}` would let a
 * workstream id of `__proto__` write through the prototype. A cycle runs at most
 * one round (the record's own `attempt: 1` is the schema's word for it), so the
 * FIRST matching record is the round and the rest are corrupt state — joining
 * several records' evidence and taking the earliest baseline would widen the
 * admitted window backwards to commits the first round never had.
 */
export function correctiveRoundFor(
  events: readonly CorrectiveRoundEvent[],
  workstreamId: string,
): CorrectiveRound | undefined {
  for (const e of events) {
    if (e.workstreamId !== workstreamId) continue;
    return { evidence: e.evidenceLines.join("\n"), command: e.command, headAtRound: e.headAtRound };
  }
  return undefined;
}

/**
 * Why the corrective route may NOT admit a file, naming the condition that
 * failed so the park reason can say which bound stopped it:
 * `not-candidate` (condition 1 or 3 — no evidence line names it, or the cycle
 * never made it), `not-anchored` (2 — its directory is no anchor's),
 * `not-post-round` (4 — the round did not commit it), `no-baseline` (4, and the
 * record carries no usable `headAtRound`), `git-read-failed` (4, and the
 * worktree's commits could not be read — a state defect and an I/O defect are
 * different diagnoses to an operator), `cap` (6 — the round's budget is spent).
 */
export type CorrectiveRefusal =
  | "no-baseline"
  | "git-read-failed"
  | "not-post-round"
  | "not-anchored"
  | "not-candidate"
  | "cap";

/** The answer for one file: admitted, or refused with the condition and a note. */
export type CorrectiveVerdict =
  | { admitted: true; note: string }
  | { admitted: false; reason: CorrectiveRefusal; note: string };

/**
 * One workstream's corrective admission, with its commit window read once.
 *
 * ONE entry point: `names` / `refusal` / `admit` were three calls the caller had
 * to sequence correctly, and a caller that skipped one got a silently different
 * rule (asking `refusal` without `names` admitted a file no evidence named).
 * `tryAdmit` judges every condition in order and cannot be partially asked; the
 * note it returns IS the disclosure line, so an admission the operator never saw
 * — the failure class #1522 was written about — cannot happen by omission.
 */
export interface CorrectiveAdmission {
  tryAdmit(file: string): Promise<CorrectiveVerdict>;
}

/** What the fence hands the admission: where to read, and route (a)'s sets. */
export interface CorrectiveScope {
  /** The workstream's own worktree — the only tree the window is read from. */
  worktree: string;
  /** `trackedPaths(base) ∪ committedChanges(base..headBefore)` — condition (1). */
  candidates: ReadonlySet<string>;
  /** `anchorDirs(declared ∪ already-changed)` — condition (2). */
  dirs: ReadonlySet<string>;
}

/**
 * The admission for one workstream's round. The caller builds it only when a
 * round exists for that workstream — a pass that ran none has nothing to ask,
 * and asking anyway would render "the round never named it" as an explanation
 * for a route that was never in play.
 */
export function createCorrectiveAdmission(
  execFn: FixExec,
  round: CorrectiveRound,
  scope: CorrectiveScope,
  timeoutMs?: number,
): CorrectiveAdmission {
  const budget = timeoutMs ?? gitReadTimeoutMs();
  let count = 0;
  // The post-round commit window, read ONCE per workstream. `null` means it
  // could not be read at all — not the same as "empty": it is the fail-closed
  // answer, and the two causes are named apart below.
  let postRound: Set<string> | "no-baseline" | "git-read-failed" | undefined;
  const changedAfterRound = async (): Promise<Set<string> | "no-baseline" | "git-read-failed"> => {
    if (postRound !== undefined) return postRound;
    const baseline = round.headAtRound;
    if (baseline === undefined) {
      postRound = "no-baseline";
      return postRound;
    }
    const headNow = await headOf(execFn, scope.worktree, budget);
    if (!headNow.ok) {
      postRound = "git-read-failed";
      return postRound;
    }
    const since = await committedChanges(execFn, scope.worktree, baseline, headNow.value, budget);
    postRound = since.ok ? new Set(since.value) : "git-read-failed";
    return postRound;
  };
  const refuse = (reason: CorrectiveRefusal, note: string): CorrectiveVerdict => ({
    admitted: false,
    reason,
    note,
  });
  return {
    async tryAdmit(file) {
      // The evidence is prose the verify command emitted and a candidate path
      // carries the same decoration a declared path does; the ONE prose-token
      // matcher answers "does this prose name this file", for this route and for
      // route (a) alike.
      const p = file.trim();
      if (!pathTokenIn(round.evidence, p))
        return refuse(
          "not-candidate",
          "no line of the round's evidence names it — the driver never ordered this edit",
        );
      if (!scope.candidates.has(p))
        return refuse(
          "not-candidate",
          "it is neither tracked at the cycle's base nor committed by the cycle before this pass, so the round is not its author",
        );
      if (!scope.dirs.has(dirOfPath(p)))
        return refuse(
          "not-anchored",
          `its directory \`${dirOfPath(p) === "" ? "." : dirOfPath(p)}\` holds no declared and no already-changed path`,
        );
      const since = await changedAfterRound();
      if (since === "no-baseline")
        return refuse(
          "no-baseline",
          "the corrective round recorded no usable HEAD baseline, so nothing it did is provable",
        );
      if (since === "git-read-failed")
        return refuse(
          "git-read-failed",
          "the commits after the corrective round could not be read — an unreadable tree is not proof that nothing changed",
        );
      if (!since.has(p))
        return refuse(
          "not-post-round",
          "it was not committed after the corrective round began — the round did not change it",
        );
      if (count >= CORRECTIVE_ADMIT_MAX)
        return refuse(
          "cap",
          `the round already admitted its ${CORRECTIVE_ADMIT_MAX} evidence-named files`,
        );
      count++;
      trace(
        `work-driver: fix pass admitted ${p} — the corrective round dispatched against ${round.command} named it`,
      );
      return {
        admitted: true,
        note: `${p} admitted — the corrective round's evidence named it and it changed after that round began`,
      };
    },
  };
}
