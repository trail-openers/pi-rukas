/**
 * lean/state-outcome-record — what a step's handler returned.
 *
 * Split from `state.ts` for the 500-line gate (AGENTS.md §12), along the seam
 * the file already draws: `state.ts` owns the on-disk run record and its load
 * rules, this owns the verdict SHAPE the handlers write into it. `state.ts`
 * re-exports the type, so every importer keeps spelling `Outcome` from
 * `state.ts` — the field set is the contract, its file is an implementation
 * detail of where the record is documented.
 */

import type { HandoffChannel } from "../work-driver-handoff-channel.ts";
import type { PreexistingTierRecord } from "./state-outcome-maps.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/// What the `review` step records when its OWN clock stopped it: the wave it
/// reached, the lanes that never got a verdict, and the stop's own sentence. Lens
/// names come from a skill roster — data from outside this process — so each is
/// neutralised and count-capped on the way in. Absent means the step finished
/// inside its bound, the normal case.

export interface ReviewBoundRecord {
  wave: "full" | "fix";
  unreviewedLanes: string[];
  reason: string;
}

/**
 * What a step's handler returned. The engine routes on `kind` and reads the
 * four fields below for a reason line or a report, so they are named rather
 * than left to an index signature — a handler that adds a scratch field is a
 * compile error, which is what keeps the durable log a record of verdicts an
 * operator reads rather than of whatever a closure happened to hold.
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
   * criterion id — verbatim from the gate's own tree and on-disk checks, and each
   * bounded. Per criterion rather than one slot because the reasons differ and so
   * do the fixes: `x does not exist at base` is an issue to rewrite, `x is a
   * symlink` is a tree to repair and `x changed since base` means the criterion
   * stopped describing preservation. Carried so the PR body explains each blank
   * instead of leaving the operator to guess.
   */
  commandNotRunnable?: Record<string, string>;
  /**
   * `build` only (kind `blocked`): the frozen test files the builder could not
   * satisfy together, path -> the contradiction it stated. The driver re-ran
   * them and at least one came back red before this was written, so it is
   * evidence, not the child's word; `handback` prints it because exit 10 alone
   * never names a cause. Shape as for `commandNotRunnable`, keys to the
   * frozen-path rule.
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
   * `handback` only: the comment the step built, in full, on the record.
   *
   * What the step is FOR, not a description of it. Before this field the only
   * account of a handback was `posted` plus the prose `handbackOutcome` wrote
   * about its own post ("handback comment posted"), so on the host channel —
   * where the result document IS the delivery and a host has to print the comment
   * itself — the host was handed a sentence about the harness instead of the
   * report: what the run still needs, the frozen acceptance tests, the branch and
   * the PR. Those live in the body the step assembled and then threw away.
   *
   * The same string the forge is handed, recorded BEFORE the post is attempted, so
   * a run that could not post still reports what it tried to say. Untrusted child
   * text, which is why every reader of it redacts before publishing.
   */
  report?: string;
  /**
   * `handback` and `decline` only (#1920 item 3): the CHANNEL this reporting step
   * acted on. `"host"` means the run addressed its report to the host that drives
   * it and posted nothing to the forge, by contract; `"forge"` means the step
   * tried to post and `posted` says whether the forge took it.
   *
   * Typed beside `posted` because the two are ONE fact written once — "who owns
   * the channel" and "did anything reach them" — and the projection that tells a
   * host which half of the contract it owes reads the record, never
   * `PI_ENSEMBLE_HANDOFF_CHANNEL`. A projection that re-read the env could
   * contradict what the step did (a host that clears the var before reading the
   * document would be told to post a comment the forge already took, or left with
   * no body at all), which is the double-post this field exists to prevent.
   * Absent means the step recorded no channel, which every reader treats as
   * `"forge"` — the channel with a forge to post to.
   */
  channel?: HandoffChannel;
  /// `review` only: the step's OWN wall clock stopped it, not one child's budget —
  /// a distinct clock, so not the budget trio (that belongs to a `budget` kind and
  /// `review` has none). Shape and bounds: `ReviewBoundRecord`.

  reviewBound?: ReviewBoundRecord;
  /**
   * `specify`, `build` and `challenge` only: one row per dispatch the step
   * paid for, including the ones that died or were stopped by their budget.
   * #1920 slice A groundwork for the lean result's per-role usage: a row is
   * written for every child so the totals a host reads cannot quietly omit the
   * expensive failures.
   */
  dispatches?: DispatchUsageRow[];
  /**
   * `budget` only (#1883): ceiling crossed, its value, what the child used. Data
   * rather than reason prose, so "out of turns" reads apart from "out of minutes".
   */
  limit?: "minutes" | "turns" | "tokens";
  value?: number;
  used?: number;
}
