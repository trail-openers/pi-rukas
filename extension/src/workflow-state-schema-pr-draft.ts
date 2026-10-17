/**
 * workflow-state-schema-pr-draft — the PR draft fact and its disclosure record
 * (#1292, extended by #1398).
 *
 * Split from workflow-state-schema.ts for the 500-line cap (AGENTS.md §12).
 * One object answers "may anyone merge this PR yet?" for the cycle's own PR, and
 * one row of it answers the harder sub-question: "were THIS patch's residual
 * findings actually disclosed where the merge guard will look?"
 *
 * The disclosure row is keyed on `patchId` — the
 * `merge-base(remote/head, remote/mainline)..remote/head` identity
 * `mergeIdentity` (merge-guard-reads.ts, #1305) computes, and the same string
 * merge-guard-round-cap.ts compares a PR comment's marker against. Keying on the
 * patch is what makes the record honest: a disclosed finding is not a fix, so a
 * fix push produces a new patch the old disclosure does not describe, and must
 * not inherit a licence to go ready.
 */

/**
 * #1292 — the PR's draft state, recorded only once the PR number is known:
 * `draft` until the review is done, `ready` once marked (or found not to be a
 * draft at all), `ready-failed` (with the last error) when `pr ready` failed.
 * `attempts` counts `pr ready` calls made this cycle (bounded); `holdReason`
 * says why the driver deliberately left it a draft. Absent = no draft fact
 * recorded (the PR was not opened as a draft).
 *
 * #1398 round 3 — `status` is optional because a cycle that never opened its PR
 * as a draft can still record a disclosure (`findingsPosted`) without claiming a
 * draft it never made. `recordLensResidualsPosted` is the only writer that ever
 * produces that shape, and it never invents a status; every draft-direction
 * writer (`withPrDraft`, `rearmDraftForReview`, the mark points) always sets one.
 * `markDraftPrReady`'s short-circuit (`!draft || draft.status === "ready"`) and
 * `rearmDraftForReview`'s gate (`status !== "ready"`) both do nothing on an
 * absent status, which is the correct reading: the driver is not holding this PR,
 * so there is nothing to lift or put back.
 */
export type PrDraftState = {
  /**
   * #1398 round 3 — optional: a disclosure-only record carries the rows and no
   * claim about the draft. Validated as "a known value or absent" by
   * `prDraftFindings` (an unrecognised string still fails closed).
   */
  status?: "draft" | "ready" | "ready-failed";
  error?: string;
  attempts?: number;
  /**
   * #1398 round 3 — why a RE-ARM (the draft direction) held the cycle. Kept
   * separate from `error` on purpose: `error` is the record of a `pr ready`
   * attempt that failed, and the handoff line that prints it says "a `pr ready`
   * attempt also failed". A re-arm halt reusing that field told the operator
   * the driver had tried to mark the PR ready — the opposite of what it tried
   * to do — and blamed the merge for a draft-direction failure
   * (`work-driver-draft-pr-handoff.ts` omits that clause for a re-arm hold).
   */
  rearmError?: string;
  /**
   * #1398 — `pr draft` (the draft direction) calls made, on its OWN counter.
   * `attempts` is the ready budget the merge spends; a re-arm charged against it
   * drained the merge's retries, so the two directions count separately
   * (work-driver-draft-pr.ts's `MAX_DRAFT_REARM_ATTEMPTS`).
   *
   * #1398 round 3 — the counter is scoped to the REVIEW ROUND that is
   * re-arming (`rearmRound`), and is charged BEFORE the command issues, not on
   * success. Two defects in one field: a per-cycle bound meant a cycle that
   * CI-looped four times with four successful re-arms exhausted its budget and
   * then reviewed a mergeable PR (the bound had become the bug); and charging
   * only after a confirmed conversion meant a forge that refused every attempt
   * never moved the counter, so the bound never closed and the driver issued
   * `pr draft` on every lens entry forever.
   */
  draftAttempts?: number;
  /**
   * #1398 round 3 — the `reviewRound` `draftAttempts` belongs to. A counter
   * whose round is not the current one counts nothing: a new review round is
   * entitled to its own bound, and the old round's attempts are history.
   */
  rearmRound?: number;
  holdReason?: string;
  /**
   * #1398 — the residual findings of THIS patch were disclosed ON the PR and
   * the merge guard can find them.
   *
   * The authoritative record is the `lens-residuals-posted` EVENT log; this is
   * its mirror on `pipelineState` for the handoff lines and the resume check. A
   * concluded review whose findings were never disclosed holds the PR as a draft
   * rather than marking it ready.
   */
  findingsPosted?: PrDraftFindingsFact[];
};

/** One disclosure of one patch's residual findings, mirrored on `prDraft`. */
export type PrDraftFindingsFact = {
  /** The reviewed patch the posted findings describe. */
  patchId: string;
  /** When the disclosure reached the PR. */
  at: number;
  /** The lens-review round whose findings were posted. */
  round: number;
  /** The PR the disclosure was made on, when the cycle had one. */
  prNumber?: number;
};

/**
 * #533's rule, applied to `pipelineState.prDraft` (#1398): the cast in
 * `readState` is the only runtime gate, so a partial or hand-edited record must
 * not reach a mark point. `markDraftPrReady` reads `status` to decide whether
 * the PR may merge and `findingsPosted` to decide whether a disclosure licenses
 * the ready — a status outside the three known values would read as "not a
 * draft", and a findings row without its `patchId` could never be compared
 * against the patch being marked ready, so a corrupt record would silently
 * permit the merge the fact exists to hold.
 *
 * Returns the findings for `validateDiscriminants` to surface; `[]` when the
 * field is absent — every state file written before #1292, and every cycle that
 * never opened its PR as a draft, must still resume.
 */
export function prDraftFindings(prDraft: unknown): string[] {
  if (prDraft === undefined) return [];
  if (typeof prDraft !== "object" || prDraft === null || Array.isArray(prDraft)) {
    return ["pipelineState.prDraft is not an object"];
  }
  const out: string[] = [];
  const draft = prDraft as Record<string, unknown>;
  // An ABSENT status is legal (#1398 round 3, a disclosure-only record); a
  // present one must be a known value — a string outside the three would read
  // as "not a draft" at every mark point and silently permit the merge.
  if (draft.status !== undefined && !PR_DRAFT_STATUSES.includes(draft.status)) {
    out.push(`pipelineState.prDraft.status has unknown value ${JSON.stringify(draft.status)}`);
  }
  // `attempts` (ready calls) and `draftAttempts` (#1398 draft-direction calls)
  // are both optional counters the bounds are compared against: a NaN or a
  // string would make `used >= MAX` false forever, i.e. an unbounded loop.
  // `rearmRound` is in the same family — a non-number there would make every
  // round look like a fresh one and turn the per-round bound back off.
  for (const field of ["attempts", "draftAttempts", "rearmRound"] as const) {
    const v = draft[field];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      out.push(`pipelineState.prDraft.${field} is not a finite number`);
    }
  }
  const posted = draft.findingsPosted;
  if (posted !== undefined) {
    if (!Array.isArray(posted)) {
      out.push("pipelineState.prDraft.findingsPosted is not an array");
    } else {
      posted.forEach((entry, i) => {
        const fact = entry as Record<string, unknown> | null;
        if (typeof fact !== "object" || fact === null) {
          out.push(`pipelineState.prDraft.findingsPosted[${i}] is not an object`);
        } else if (typeof fact.patchId !== "string") {
          out.push(`pipelineState.prDraft.findingsPosted[${i}].patchId is missing or not a string`);
        }
      });
    }
  }
  return out;
}

/** `prDraft.status` vocabulary — mirrors the `PrDraftState` union above. */
const PR_DRAFT_STATUSES: readonly unknown[] = ["draft", "ready", "ready-failed"];
