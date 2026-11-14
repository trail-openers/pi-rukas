#!/usr/bin/env bun
/**
 * The lane cap is one rule, and both surfaces that print the lanes obey it.
 *
 * `gates.review.reviewBound.unreviewedLanes` is the list; the older string-valued
 * `issues[].reviewBound` is the same list joined into one sentence — reason, wave, and
 * the lanes after `unreviewed:`. Both are written by the projection module, both slice
 * at the same cap, and a benchmark that reads one and counts the other has to be told
 * when either was cut. This file pins the sentence's half of the pairing that
 * `test-headless-work-lean-gates-truncation.ts` pins for the object: the count the
 * sentence's `Total` reports is the count that produced the sentence.
 *
 * The sentence keeps the shape the host contract has always published — reason, `; wave `,
 * `; unreviewed: ` — because the marker lives in the object and the line stays a line for
 * a person. What the two share is the cut and its count, which is why one projection
 * builds both and this case reads both from one run.
 */

import { redactClip } from "../src/decision-log.ts";
import { leanGates, LIST_MAX, reviewBoundSentence } from "../src/headless/work-lean-gates.ts";
import type { ReviewBoundRecord } from "../src/lean/review-bound.ts";
import type { Outcome, Step } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { driveLean } from "./lib/lean-result-fixture.ts";
import { ROUND_1, gatesOf } from "./lib/lean-result-gates-fixture.ts";

const { assert, failures } = makeAssert();

/** The projection's print cap, read from the projection itself so the two surfaces cannot
 * be pinned against a number the code no longer uses. */

/** A bound whose lane list runs `extra` entries past the cap. */
function boundPast(extra: number): ReviewBoundRecord {
  return {
    wave: "full",
    unreviewedLanes: Array.from({ length: LIST_MAX + extra }, (_, i) => `lane ${String(i)}`),
    reason: "review STEP stopped: minutes budget 20 exceeded (used 24)",
  };
}

/** The whole run around one review step carrying `bound`. */
function logWith(bound: ReviewBoundRecord): Step[] {
  const review: Outcome = {
    kind: "done",
    reason: "adversarial and six-lens review clean",
    review: { rounds: [{ ...ROUND_1 }], waves: [] },
    reviewBound: bound,
  };
  return [
    { key: "7:ready:0", state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    {
      key: "7:verify:0",
      state: "verify",
      startedAt: 2,
      endedAt: 3,
      outcome: { kind: "green", verifiedHead: "a".repeat(39) + "1" },
    },
    {
      key: "7:publish:0",
      state: "publish",
      startedAt: 4,
      endedAt: 5,
      outcome: {
        kind: "ok",
        prUrl: "https://example.test/pull/7",
        publishedHead: "a".repeat(39) + "1",
      },
    },
    { key: "7:review:0", state: "review", startedAt: 6, endedAt: 7, outcome: review },
    {
      key: "7:handback:0",
      state: "handback",
      startedAt: 8,
      endedAt: 9,
      outcome: { kind: "done", reason: "handback comment posted", posted: true },
    },
  ];
}

/** Redaction is not what this file is about, so the seam is the identity. */
const noRedact = (s: string): string => s;

// ─── (1) one run, two surfaces, one cut and one count ──────────────────────────
{
  const total = LIST_MAX + 5;
  const bound = boundPast(5);
  const r = await driveLean("handed-back", 10, logWith(bound) as never);
  const sentence = r.issue?.reviewBound;
  const published = gatesOf(r.issue).review?.reviewBound as Record<string, unknown> | undefined;
  const lanes = published?.unreviewedLanes as string[] | undefined;

  assert(
    Array.isArray(lanes) &&
      lanes.length === LIST_MAX &&
      published?.unreviewedLanesTotal === total,
    `the object's list is cut at ${LIST_MAX} and its Total names the full ${String(total)} (${String(lanes?.length)} of ${String(published?.unreviewedLanesTotal)})`,
  );
  assert(
    typeof sentence === "string" &&
      sentence.startsWith(`${bound.reason}; wave full; unreviewed: `) &&
      sentence.split("; unreviewed: ")[1]?.split(", ").length === LIST_MAX,
    `the top-level line keeps the published shape and names the same ${LIST_MAX} lanes the object lists (${JSON.stringify(typeof sentence === "string" ? sentence.slice(0, 60) : sentence)}…)`,
  );
  // The pair the host needs: the sentence carries no number of its own, so the count a
  // host uses for it is the object's — and they must describe the same cut.
  assert(
    published?.unreviewedLanesTotal === total &&
      (lanes ?? []).length < total,
    "the sentence's cut is detected by the object's Total, which is the only number either surface publishes",
  );
}

// ─── (2) the Total counts survivors, and the sentence shows the same ones ─────
// Both surfaces drop a lane the seam empties — a child whose whole lane was one
// credential-shaped token leaves nothing behind after the scrub — and the Total counts what
// survives, so the object's count and the sentence's list can never name a different set of
// lanes. The seam never answers `""` for a non-empty input (it substitutes a marker), so the
// arm is driven through the projection's own redaction parameter, which is the seam the
// rule lives behind; case (1) keeps the document-level proof for the ordinary cut.
{
  const lanes = Array.from({ length: LIST_MAX + 4 }, (_, i) => `lane ${String(i)}`);
  const bound: ReviewBoundRecord = {
    wave: "fix",
    unreviewedLanes: lanes,
    reason: "review STEP stopped",
  };
  // One lane that redacts away entirely, placed inside the first `LIST_MAX`: a projection
  // that counted the record's entries and clipped afterwards would report one more than the
  // list holds, and a projection that printed the empty lane would show a blank slot in the
  // sentence. The projection's print bound is the caller's, so the seam below is the same
  // shape `leanIssueResult` passes — a redaction followed by the field's own clip.
  const SECRET_LANE = `ghp_${"a".repeat(36)}`;
  const seam = (s: string): string => (s === SECRET_LANE ? "" : redactClip(s, 500));
  const withBlank: ReviewBoundRecord = {
    ...bound,
    unreviewedLanes: lanes.map((lane, i) => (i === 0 ? SECRET_LANE : lane)),
  };
  const sentence = reviewBoundSentence(withBlank, seam);
  assert(
    sentence.startsWith("review STEP stopped; wave fix; unreviewed: ") &&
      !sentence.includes("lane 0") &&
      sentence.includes("lane 1"),
    `the sentence drops a lane the redactor emptied, from inside the kept window (${JSON.stringify(sentence.slice(0, 70))})`,
  );
  const kept = leanGates(logWith(withBlank) as never, seam).review?.reviewBound;
  // Fifteen `lane N` names plus the one the cap pulled forward, and `lane 16` — the entry
  // that only survives because the emptied lane made room — is the witness that the count
  // is the set this document names, not the number of entries the record held.
  assert(
    Array.isArray(kept?.unreviewedLanes) &&
      kept.unreviewedLanes.length === LIST_MAX &&
      kept.unreviewedLanesTotal === LIST_MAX + 3 &&
      !(kept.unreviewedLanes ?? []).includes("lane 0") &&
      !(kept.unreviewedLanes ?? []).includes(SECRET_LANE) &&
      kept.unreviewedLanes.includes("lane 16"),
    `the Total counts survivors — 20 entries, one of them emptied by the seam, so the pair is ${LIST_MAX} printed of ${LIST_MAX + 3} kept and the dropped lane is in neither number (${String(kept?.unreviewedLanes.length)} / ${String(kept?.unreviewedLanesTotal)})`,
  );
  // The same log through an identity seam — the code path a missing redaction call is
  // equivalent to — keeps the secret's lane and reports one more than this document does,
  // so the assertion above is the seam's doing and not a lane list that was short anyway.
  const unredacted = leanGates(logWith(withBlank) as never, (s) => s).review?.reviewBound;
  assert(
    unredacted?.unreviewedLanesTotal === LIST_MAX + 4 &&
      unredacted.unreviewedLanes.some((lane) => lane === SECRET_LANE),
    `with no seam the same log holds the secret lane and counts every entry, so the survivor count above is the projection's doing (${String(unredacted?.unreviewedLanesTotal)})`,
  );
  assert(
    reviewBoundSentence(bound, noRedact).split("; unreviewed: ")[1]?.split(", ").length ===
      LIST_MAX,
    "the same sentence built from the un-redacted record lists exactly the cap, so the case above isolated the redaction and not the clip",
  );
}

// ─── (3) a list at or under the cap reports no cut on either surface ───────────
{
  const bound = boundPast(0);
  const r = await driveLean("handed-back", 10, logWith(bound) as never);
  const published = gatesOf(r.issue).review?.reviewBound as Record<string, unknown> | undefined;
  const kept = published?.unreviewedLanes as string[] | undefined;
  assert(
    Array.isArray(kept) &&
      kept.length === LIST_MAX &&
      published?.unreviewedLanesTotal === LIST_MAX,
    `at exactly the cap the Total equals the list, so Total > length means a cut and nothing else (${String(kept?.length)} / ${String(published?.unreviewedLanesTotal)})`,
  );
  const short = boundPast(-12);
  const small = await driveLean("handed-back", 10, logWith(short) as never);
  const smallBound = gatesOf(small.issue).review?.reviewBound as Record<string, unknown>;
  assert(
    (smallBound.unreviewedLanes as string[]).length === 4 &&
      smallBound.unreviewedLanesTotal === 4,
    `below the cap the Total is the list's own length (${String((smallBound.unreviewedLanes as string[]).length)} / ${String(smallBound.unreviewedLanesTotal)})`,
  );
  assert(
    small.issue?.reviewBound === reviewBoundSentence(short, noRedact),
    "an uncapped sentence is the shape the contract has always published, unchanged by the marker",
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
