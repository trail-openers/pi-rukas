/**
 * lean/state-outcome-record — what a step's handler returned.
 *
 * Split from `state.ts` for the 500-line gate, along the seam the file already
 * draws: `state.ts` owns the on-disk run record and its load rules, this owns the
 * verdict SHAPE the handlers write into it. `state.ts` re-exports the type, so
 * every importer keeps spelling `Outcome` from `state.ts`.
 */

import type { HandoffChannel } from "../work-driver-handoff-channel.ts";
import type { ReviewBoundRecord } from "./review-bound.ts";
import type { RedRecord, ReviewRecord } from "./state-outcome-gates.ts";
import type { PreexistingTierRecord } from "./state-outcome-maps.ts";
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
  /**
   * `specify` only: the frozen acceptance tests, path -> sha256 of the bytes
   * at freeze time. Persisted in the step log so a resumed run, `build` and
   * `verify` can tell "the test still holds" apart from "somebody edited it
   * after the step that proved it red".
   */
  frozen?: Record<string, string>;
  /**
   * `specify` only: criterion id -> the kept test files that cover it. The
   * record of which criterion each frozen file answers for.
   */
  tests?: Record<string, string[]>;
  /**
   * `verify` only: the 40-hex commit whose tree produced this verdict. The land
   * gate compares it to the PR head, so "the tests were green" is a claim about
   * a named commit rather than about whatever tree happened to be on disk when
   * the step ran.
   */
  verifiedHead?: string;
  /**
   * `verify` only: the spec's `command` criteria this gate EXECUTED and that
   * exited 0, keyed by criterion id. A criterion the gate ran is a claim
   * `publish-body` may print as `passed (command)`; one absent from this map was
   * never run, and the body says so. Kept as a bare id->word map (not nested
   * objects) so the durable record stays a record of verdicts and the validator
   * can check every value it reads.
   */
  commandCriteria?: Record<string, string>;
  /**
   * `verify` only: why the gate did NOT run each `command` criterion, keyed by
   * criterion id — verbatim from the gate's own tree and on-disk checks, each
   * bounded. Per criterion rather than one slot because the reasons differ and so
   * do the fixes: a missing file is an issue to rewrite, a symlink is a tree to
   * repair, a changed file means the criterion stopped describing preservation.
   */
  commandNotRunnable?: Record<string, string>;
  /**
   * `build` only (kind `blocked`): the frozen test files the builder could not
   * satisfy together, path -> the contradiction it stated. The driver re-ran them
   * and at least one came back red before this was written, so it is evidence, not
   * the child's word; `handback` prints it because exit 10 alone never names a
   * cause. Same shape as `commandNotRunnable`.
   */
  blockedBy?: Record<string, string>;
  /**
   * `verify` and `ci` only: the tiers this step found red at HEAD whose every
   * failing test ALSO failed at the run's base commit, so the step graded green and
   * disclosed them instead of handing the run back. Keyed by tier name; each entry
   * is the command, the capped names, the true total and the base sha, and `verify`
   * also carries the base run's complete name set so `ci` can reuse the proof. A
   * record is evidence only as much as its validator allows — see
   * `preexistingFailuresProblem` in `state-outcome-maps.ts`.
   */
  preexistingFailures?: Record<string, PreexistingTierRecord>;
  /**
   * `publish` only: the PR's https URL, as the forge returned it. Publish-only
   * by contract — no other step writes it, and `handback` reads no other field
   * for a URL — so "there is a PR at this address" is a recorded fact rather
   * than something a later reader guesses out of a reason line.
   */
  prUrl?: string;
  /** `publish` only: the full 40-hex head it pushed, from the value the push
   *  carried — what the result matches against `verify`'s `verifiedHead`. */
  publishedHead?: string;
  /**
   * `publish` only: whether the PR this step handed the forge was a draft. The
   * run exits 10 whatever the answer, so a host cannot tell "green and waiting
   * for a merge" apart from "draft behind unverified bytes" from the exit code
   * or the reason prose — this field is the typed answer. Recorded from the
   * value actually passed to `prCreate`/`prDraft`, not recomputed at read time.
   */
  draft?: boolean;
  /**
   * `handback` and `decline` only: whether the comment this step was the run's
   * way of telling someone actually reached the forge. The step never throws
   * either way — the run ends on its verdict regardless of the comment — so this
   * field is the ONLY record of a failed post, and a result that printed
   * "delivered" without it would send a host to look at a comment nobody posted.
   * Absent means no claim was recorded, which every reader treats as NOT
   * delivered.
   */
  posted?: boolean;
  /**
   * `handback` only: the comment the step built, in full, on the record — what the
   * step is FOR, not a description of it. On the host channel the result document
   * IS the delivery, so without the body the host is handed a sentence about the
   * harness instead of the report.
   *
   * The same string the forge is handed, recorded BEFORE the post is attempted, so
   * a run that could not post still reports what it tried to say. Untrusted child
   * text, which is why every reader of it redacts before publishing.
   */
  report?: string;
  /**
   * `handback` and `decline` only: the CHANNEL this reporting step acted on.
   * `"host"` means the run addressed its report to the host and posted nothing to
   * the forge, by contract; `"forge"` means it tried to post and `posted` says
   * whether the forge took it.
   *
   * Typed beside `posted` because the two are ONE fact written once — "who owns
   * the channel" and "did anything reach them" — and the projection that tells a
   * host which half of the contract it owes reads the record, never
   * `PI_ENSEMBLE_HANDOFF_CHANNEL`: a projection that re-read the env could
   * contradict what the step did, which is the double-post this field prevents.
   * Absent is read as `"forge"`.
   */
  channel?: HandoffChannel;
  /// `review` only: the step's OWN wall clock stopped it, not one child's budget.
  reviewBound?: ReviewBoundRecord;
  /**
   * `review` only: what the step judged — one per-round tally keyed by the four
   * published severities, and the full head each fix wave pushed. The prose reason
   * prints a 12-char prefix and a disclosed-row count; a host that has to say WHICH
   * round raised the CRITICAL, or check out the commit the fixer left, could not
   * recover either from it. Written by the step that judged the rounds, validated and
   * rebuilt on load — see `state-outcome-gates.ts`.
   */
  review?: ReviewRecord;
  /**
   * `verify` and `ci` only, on a RED step: the tier(s) that failed and the criterion
   * ids the failing checks answer for. The verdict's `reason` is a clipped sentence
   * about the first failure, which cannot say which tier it came from nor which
   * criterion it answers for — and those are the two things a host triaging the red
   * asks. Absent on a green, and on a red whose gate could not name them.
   */
  red?: RedRecord;
  /**
   * `handback` only: the head origin's branch holds once this step finished — the
   * verified one it moved back to, or the unverified one it left standing. A run
   * whose `fixed` review pushed and whose re-verification never ran otherwise
   * reports a head no gate certified, and the reader could not tell the two cases
   * apart from the reason prose. Absent means this step moved nothing and had no
   * head to name.
   */
  shippedHead?: string;
  /**
   * `handback` only: whether `shippedHead` is a head the run's own gate certified.
   * The typed answer to "did verify see what shipped", which no other field of the
   * record can give once a fix wave moved the branch. Written with `shippedHead`,
   * and true in the one case where this step pushed nothing because origin already
   * held the certified head — what shipped then is certified whatever this step
   * did with it.
   */
  shippedVerified?: boolean;
  /**
   * `handback` only: the head this step's own push moved off and did NOT ship,
   * kept reachable under `refs/lean/unverified/<issue>` by the same transaction
   * that moved the branch. Absent when this step displaced nothing — a refused
   * push leaves origin holding the run's head, so there is nothing unshipped to
   * name, and a branch that never moved displaced nothing.
   */
  unshippedHead?: string;
  /**
   * `handback` only: why the unshipped head was not shipped, or why a rewind that
   * was due did not move anything — a lease git refused, a push git rejected for a
   * reason it states itself, an unreadable origin, a run with no green verify to
   * fall back to. Prose for the operator, beside the two head fields it explains.
   */
  unshippedReason?: string;
  /**
   * `specify`, `build` and `challenge` only: one row per dispatch the step paid
   * for, including the ones that died or were stopped by their budget. A row is
   * written for every child so the totals a host reads cannot quietly omit the
   * expensive failures.
   */
  dispatches?: DispatchUsageRow[];
  /**
   * `budget` only: ceiling crossed, its value, what the child used. Data rather
   * than reason prose, so "out of turns" reads apart from "out of minutes".
   */
  limit?: "minutes" | "turns" | "tokens";
  value?: number;
  used?: number;
}
