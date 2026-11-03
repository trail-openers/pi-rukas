/**
 * lens-review-policy — ONE full review, ONE fix wave, ONE scoped re-review
 * (#1537).
 *
 * The loop used to be bounded only by a counter: while a verdict carried a
 * finding at or above the project's threshold the driver dispatched a fixer and
 * then re-ran the WHOLE six-lens review, up to `MAX_REVIEW_ROUNDS` times, and
 * the merge guard accepted an `ISSUES_FOUND` ledger row only once its `round`
 * had reached that same cap. A four-line PR with three MEDIUM findings therefore
 * paid for three six-lens reviews before it could merge. Measured on this repo:
 * a +4/-12 change took three lens rounds and ~96 finding rows across three
 * residual disclosures; a test deletion took three rounds and ~1.5 h. Neither
 * carried a CRITICAL or HIGH.
 *
 * The policy this module states:
 *
 *   1. the first round is a full review, and the only unscoped one;
 *   2. findings at or above `BLOCKING_SEVERITY` (HIGH) get ONE fix wave;
 *   3. the round after that fix is ONE re-review, scoped to the fix diff;
 *   4. in the re-review a row carried from the blocking round is still open and
 *      keeps blocking at its own severity, and a NEW finding blocks only when it
 *      is CRITICAL — everything else is disclosed;
 *   5. no blocking finding in the first round means no fix and no re-review.
 *
 * The loop ends by SHAPE, not by a count: `lensPolicyOf` answers what this round
 * IS from the event log, and a third review is not a shape — which is why no call
 * site reads or decrements a round number. The wall clock, the per-child bounds
 * and the findings memory still own every time and cost bound; nothing here
 * loosens them.
 *
 * "Scoped to the fix diff" is the round's BLOCKING SCOPE, and it is deliberately
 * not what `resolveReviewDiff` does to the reviewed text. The driver hands the
 * lenses the whole merged diff with the fix delta as a labelled section beside it
 * (fix-delta.ts: "The full diff stays — it is the thing being approved"); a round
 * that read only the delta would approve a fix without reading the diff it
 * belongs to. What the scope changes is what the round may BLOCK on, and that is
 * `scopedBlocking` below, judged from the rows the round itself carried.
 *
 * Fail closed on unreadable evidence: a round whose phase cannot be read is
 * treated as the most conservative one available (`first`, i.e. everything it
 * reports blocks), and a scoped round is only ever concluded from the rows the
 * review actually returned — never from an assumption about what it resolved.
 */

import type { Severity } from "./lens-review-format.ts";
import { type CarriedFinding, type Finding, isCarried } from "./lens-review-types.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/** The severity the driver treats as worth a fix wave: HIGH and above.
 *
 * A number compared through `SEVERITY_ORDER`, not a list of literals, so a
 * severity added to the union cannot quietly become neither blocking nor
 * disclosed. The project's own bar (`resolveReviewThreshold`) decides what the
 * REVIEW reports and whether its verdict is `ISSUES_FOUND`; this decides what
 * the driver spends its one fix wave ON, and the policy's words fix that: a fix
 * wave answers CRITICAL and HIGH. A project with a LOW bar therefore still gets
 * exactly one fix wave, not a longer one, and its sub-HIGH rows are disclosed
 * rather than fixed. */
export const BLOCKING_SEVERITY: Severity = "HIGH";

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** Blocking = HIGH or CRITICAL. MEDIUM and LOW are disclosed, never fixed. */
export function isBlockingSeverity(severity: Severity): boolean {
  return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[BLOCKING_SEVERITY];
}

/** The blocking half of a finding list — what a fix wave is given. */
export function blockingFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => isBlockingSeverity(f.severity));
}

/** True when a finding list carries anything the one fix wave must answer. */
export function hasBlockingFinding(findings: readonly Finding[]): boolean {
  return findings.some((f) => isBlockingSeverity(f.severity));
}

/** A new finding blocks a scoped re-review only when it is CRITICAL. */
export function isCriticalFinding(f: Finding): boolean {
  return f.severity === "CRITICAL";
}

/**
 * What a lens round IS.
 *
 * - `first` — nothing blocking is outstanding: this is the full review.
 * - `scoped` — a blocking verdict is recorded and its fix wave has NOT been
 *   dispatched: the round the fix owes has not been spent, so this is it.
 * - `closed` — the fix wave has been dispatched: its re-review has been spent,
 *   so a re-review does not open a second one and this round's own verdict is
 *   the whole answer.
 */
export type LensPhase = "first" | "scoped" | "closed";

/** The round whose fix wave this phase answers, as its verdict recorded it. */
export interface BlockingRound {
  round: number;
  verdict: "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND";
  findings: string;
  /** The head that verdict was produced against (#1742): a disclosure and the
   * owed-round route both require a verdict to name the commit it read. */
  headSha?: string;
}

export interface LensPolicy {
  phase: LensPhase;
  blockingRound?: BlockingRound;
}

type LensVerdictEvent = Extract<WorkEvent, { kind: "lens-issues-found" }>;

/** The round that opened the fix wave, from its verdict event. */
function blockingRoundOf(e: LensVerdictEvent): BlockingRound {
  return {
    round: e.round,
    verdict: e.verdict,
    findings: e.findings,
    ...(e.headSha !== undefined ? { headSha: e.headSha } : {}),
  };
}

/**
 * Where this lens round sits in the policy, read off the event log alone.
 *
 * A `lens-approved` or an empty-diff skip at the tail closes the wave: a round
 * that read the fix and came back clean is not owed another, and the next round
 * is an ordinary full review of whatever the branch has since grown.
 */
export function lensPolicyOf(log: readonly WorkEvent[]): LensPolicy {
  let verdict: LensVerdictEvent | undefined;
  let verdictAt = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "lens-issues-found") {
      verdict = e;
      verdictAt = i;
      break;
    }
    if (e?.kind === "lens-approved" || e?.kind === "lens-skipped-empty-diff") {
      return { phase: "first" };
    }
  }
  if (verdict === undefined) return { phase: "first" };
  const blockingRound = blockingRoundOf(verdict);
  // The authoritative fact that the fix wave was ANSWERED: the landing arm
  // records it only for a fix that committed, so a fixer that dispatched and
  // committed nothing leaves the round owed instead of spending the budget on a
  // re-review of an unchanged head. The dispatch log is the fallback for state
  // files written before this event existed (and for a landing arm that died
  // before recording it), where a dispatched fix is the best evidence available.
  const answered = log.some((e) => e.kind === "lens-fix-rereviewed" && e.round === verdict.round);
  if (answered) return { phase: "closed", blockingRound };
  const fixDispatched = log
    .slice(verdictAt + 1)
    .some((e) => e.kind === "dispatch-started" && e.step === "lens-fix");
  return { phase: fixDispatched ? "scoped" : "closed", blockingRound };
}

/** True when the round about to run is the re-review a fix wave owes: the
 * blocking verdict is outstanding and its fixer has not been dispatched yet. */
export function owesReReview(log: readonly WorkEvent[]): boolean {
  return lensPolicyOf(log).phase === "scoped";
}

/** True when the fix wave's re-review has already been spent. */
export function reReviewSpent(log: readonly WorkEvent[]): boolean {
  return lensPolicyOf(log).phase === "closed";
}

/**
 * The scoped re-review's blocking set.
 *
 * - a row the findings store carried (`isCarried`) is a row the round saw and
 *   did not resolve — still open, and still blocking at its own severity: a fix
 *   pass that ignores a finding cannot pass. A carried row's severity is its
 *   own, so a carried MEDIUM does not block where a carried HIGH does;
 * - a row the round REPORTED (not carried) is new to this round, and nothing in
 *   the fix wave was asked to answer it: it blocks only when CRITICAL. A new
 *   MEDIUM on code the first review read and did not report is the noise this
 *   policy exists to stop, so it is disclosed with the rest;
 * - a new CRITICAL blocks wherever it sits — the one class never demoted, no
 *   matter what the delta ranges say.
 *
 * What this function does NOT do is decide whether a carried row resolved: that
 * is `rowFate` (review-findings-fate.ts), whose output this reads and never
 * re-derives.
 */
export function scopedBlocking(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => isCarried(f) || isCriticalFinding(f));
}

/** The carried half of a finding list, for a renderer or a test to name. */
export function carriedFindings(findings: readonly Finding[]): CarriedFinding[] {
  return findings.filter(isCarried);
}

/**
 * Does this verdict's findings blob still carry a row the findings store handed
 * back as OPEN (`carried: true`, stamped by `review-findings-round.ts`)?
 *
 * On the terminal re-review this is the question the `ci` route turns on (its one
 * caller is `appendReviewCapHit`): a carried row is one the round saw, did not
 * resolve, and whose cited code is unchanged — a fix pass that ignored a finding
 * cannot be rewarded with a merge that discloses it as settled. An unreadable
 * blob is treated as OPEN (a park): the route is an allowance, and an allowance
 * cannot be granted on evidence the driver cannot read.
 *
 * A carried row blocks at ITS OWN severity: a carried MEDIUM/LOW is an open row
 * the policy never asked the fix wave to answer (the project's bar, or the scoped
 * round's demotion, left it sub-blocking) and disclosing it is the policy's word
 * for that. Only a carried HIGH/CRITICAL means the fix wave failed to land the
 * thing it was sent to fix. Reads the serialised blob rather than `Finding[]`
 * because the cap's input is the event's own `findings` field — the same string
 * the disclosure renders, so the route and the comment cannot disagree.
 */
export function hasOpenCarriedFinding(findingsBlob: string | undefined): boolean {
  if (!findingsBlob?.trim()) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(findingsBlob);
  } catch {
    return true;
  }
  if (!Array.isArray(parsed)) return true;
  return parsed.some(
    (f) =>
      typeof f === "object" &&
      f !== null &&
      (f as { carried?: unknown }).carried === true &&
      isBlockingSeverity((f as { severity?: unknown }).severity as Severity),
  );
}
