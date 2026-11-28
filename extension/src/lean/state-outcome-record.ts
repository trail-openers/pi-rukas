import type { RepairRecord } from "../oracle-repair-fields.ts";
import type { EvidenceLine } from "../oracle-repair-record.ts";
/**
 * lean/state-outcome-record — what a step's handler returned.
 *
 * `state.ts` owns the on-disk run record and its load rules; this owns the
 * verdict SHAPE the handlers write into it. `state.ts` re-exports the type, so
 * every importer keeps spelling `Outcome` from `state.ts`.
 */
import type { HandoffChannel } from "../work-driver-handoff-channel.ts";
import type { ReviewBoundRecord } from "./review-bound.ts";
import type { DerivedSpec } from "./state-derived-spec.ts";
import type { RedRecord, ReviewRecord } from "./state-outcome-gates.ts";
import type { PreexistingTierRecord, ProjectRosterRecord } from "./state-outcome-maps.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
/**
 * What a step's handler returned. The engine routes on `kind` and reads the rest
 * for a reason line or a report, so the fields are named rather than left to an
 * index signature: a handler that adds a scratch field is a compile error, which
 * is what keeps the durable log a record of verdicts an operator reads.
 */
export interface Outcome {
  kind: string;
  reason?: string;
  message?: string;
  failedRules?: string[];
  /** `specify` only: the frozen acceptance tests, path -> sha256 of the bytes at freeze time, so a resumed run can tell "the test still holds" from "somebody edited it after the step that proved it red". */
  frozen?: Record<string, string>;
  /** `specify` only: criterion id -> the kept test files that cover it. */
  tests?: Record<string, string[]>;
  /** `verify` only: the 40-hex commit whose tree produced this verdict — what the land gate matches to the PR head, so "green" is a claim about a named commit and not about whatever tree was on disk. */
  verifiedHead?: string;
  /** `verify` only: the `command` criteria the gate EXECUTED and that exited 0, by id. A criterion absent from the map was never run, and the body says so. Bare id->word, so the validator checks every value. */
  commandCriteria?: Record<string, string>;
  /** `verify` only: why the gate did NOT run each `command` criterion, by id — the gate's own bounded tree checks, one slot per criterion because the fixes differ. */
  commandNotRunnable?: Record<string, string>;
  /** `build` only (kind `blocked`): frozen test path -> the contradiction the driver itself re-proved red. `handback` prints it; exit 10 alone never names a cause. */
  blockedBy?: Record<string, string>;
  /** `build` only (kind `blocked`): the at-head red the DRIVER watched the runner print — the only failure
   *  evidence a repair brief may quote. Rules and reader: `oracle-repair-record.ts`. */
  blockedEvidence?: EvidenceLine[];
  /** `build` only: the head this round started from, read off the tree before its child ran. On `blocked` it is
   *  the commit the driver ran the named files at — the red's commit, where a repair round resets its seat. */
  headBefore?: string;
  /** `build` only: the repair round's observed facts, once bought. Rules: `oracle-repair-fields.ts`. */
  repair?: RepairRecord;
  /** The two fields `ready` owns and the engine copies onto the RUN (`applyReadyFacts`): the commit the config was read at, and — for a `derive` run — the contract the engine drafted, which is durable because a derived one exists nowhere else. Checked on load against the contract's own rules. */
  baseSha?: string;
  derivedSpec?: DerivedSpec;
  /** `verify`/`ci` only: tiers red at HEAD whose every failing test ALSO failed at the run's base, so the step graded green and disclosed them instead of handing back. Evidence only as far as `preexistingFailuresProblem` allows. */
  preexistingFailures?: Record<string, PreexistingTierRecord>;
  /** `verify` only: the run's roster of the PROJECT's own pre-existing tests — enumerated at the base, run at head AND at base, per-test verdicts read from the runner's report, with the base version of every file the run edited run again against the head code. A green `verify` without it never reaches `landed`: absent is "the gate never asked", not "nothing failed", which is why an empty roster is refused on load rather than carried. */
  projectRoster?: ProjectRosterRecord;
  /** `publish` only: the PR's https URL as the forge returned it — a recorded fact, not something a later reader guesses from a reason line. */
  prUrl?: string;
  /** `publish` only: the full 40-hex head it pushed, from the value the push
   *  carried — what the result matches against `verify`'s `verifiedHead`. */
  publishedHead?: string;
  /** `publish` only: whether the PR handed to the forge was a draft — the typed answer a host cannot read off exit 10 or the reason prose. Recorded from the value passed to `prCreate`/`prDraft`, never recomputed. */
  draft?: boolean;
  /** `handback`/`decline` only: whether the comment reached the forge. The step never throws either way, so this is the ONLY record of a failed post; absent is read as NOT delivered. */
  posted?: boolean;
  /** `handback` only: the comment the step built, recorded BEFORE the post was attempted, so a run that could not post still reports what it tried to say. Untrusted text: every reader redacts before publishing. */
  report?: string;
  /** `handback`/`decline` only: the CHANNEL this reporting step acted on — the step's own record, never `PI_ENSEMBLE_HANDOFF_CHANNEL` re-read at projection time, which is what keeps a host's document from contradicting a post the step already made. Absent is read as `"forge"`. */
  channel?: HandoffChannel;
  /// `review` only: the step's OWN wall clock stopped it, not one child's budget.
  reviewBound?: ReviewBoundRecord;
  /// `review` only: the full head the step's fix wave started from, saved before the fixer ran.
  preFixHead?: string;
  /** `review` only: what the step judged — a per-round tally by the four published severities, and the full head each fix wave pushed. Neither is recoverable from the clipped prose reason. Validated and rebuilt on load (`state-outcome-gates.ts`). */
  review?: ReviewRecord;
  /** `verify`/`ci` only, on a RED step: the failing tier(s) and the criterion ids the failing checks answer for — the two things a triaging host asks that the clipped first-failure `reason` cannot say. Absent on a green, and on a red whose gate could not name them. */
  red?: RedRecord;
  /** `handback` only: the head origin's branch holds once this step finished — the verified one it moved back to, or the unverified one it left standing. Without it a run whose `fixed` review pushed and never re-verified reports a head no gate certified. Absent means nothing was moved and no head needed naming. */
  shippedHead?: string;
  /** `handback` only: whether `shippedHead` is a head this run's own gate certified — the typed answer to "did verify see what shipped", which no other field gives once a fix wave moved the branch. Written with `shippedHead`, and true when origin already held the certified head. */
  shippedVerified?: boolean;
  /** `handback` only: the head this step's own push moved off and did NOT ship, kept reachable under `refs/lean/unverified/<issue>` by the same transaction. Absent when this step displaced nothing. */
  unshippedHead?: string;
  /** `handback` only: why the unshipped head was not shipped, or why a rewind that was due moved nothing — the operator's sentence beside the two head fields it explains. */
  unshippedReason?: string;
  /** `specify`/`build`/`challenge` only: one row per dispatch the step paid for, dead or budget-stopped children included, so the totals a host reads cannot quietly omit the expensive failures. */
  dispatches?: DispatchUsageRow[];
  /** `budget` only: ceiling crossed, its value, what the child used — data rather than prose, so "out of turns" reads apart from "out of minutes". */
  limit?: "minutes" | "turns" | "tokens" | "stall";
  value?: number;
  used?: number;
}
