#!/usr/bin/env bun
/**
 * A capped `gates` list announces that it was capped.
 *
 * The projection prints at most {@link LIST_MAX} entries of any list it hands a host
 * (`src/headless/work-lean-gates.ts`). Before this file, a list of 20 lanes printed as
 * sixteen and a list of sixteen printed as sixteen: byte for byte the same document, and
 * a benchmark that counted entries reported sixteen where the run held twenty. A host
 * cannot tell "that is all there was" from "the rest was cut" out of the list itself, so
 * every capped list now rides a sibling integer `<name>Total` — the full count BEFORE
 * the cut, `null` exactly when its list is `null`. A host detects a cut with
 * `<name>Total > <name>.length`, which is the only rule this file exists to keep true.
 *
 * Two rules the cases below are built to break:
 *
 *   - **the count survives the cut, and the cut does not survive the count.** `Total`
 *     counts the entries that clear the projection's own filter (a lane that redacts to
 *     nothing, a wave whose head is not a full oid) and says nothing about the ones that
 *     did not: a host comparing `Total` against a raw record would be told a different
 *     number than this document's list length can account for.
 *   - **`Total` is `null` when the list is `null`, never `0`.** The null rule of
 *     `gates` (docs/headless.md) says an explicit null is "the record holds no value";
 *     a `0` beside a null list would be a positive claim — the run had a list and it was
 *     empty — which is a different fact and the wrong one.
 *
 * The cases drive the projection through `leanIssueResult`, so what is asserted is the
 * document a host parses and not a helper's return value.
 */

import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { GATE_SEVERITIES } from "../src/lean/gate-severities.ts";
import type { Outcome, Step } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { driveLean } from "./lib/lean-result-fixture.ts";
import { ROUND_1, gatesOf } from "./lib/lean-result-gates-fixture.ts";

const { assert, failures } = makeAssert();

/** The projection's own print cap, restated here so the case breaks when it moves. */
const LIST_MAX = 16;

/** One more entry than the cap — the smallest log that can prove a cut is visible. */
function past(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `lane ${String(i)}`);
}

/** A review outcome carrying `lanes` unreviewed and `waves` fix waves. */
function reviewOutcome(
  lanes: string[],
  waves: { wave: "full" | "fix"; head: string }[],
): Outcome {
  return {
    kind: "done",
    reason: "adversarial and six-lens review clean",
    review: { rounds: [{ ...ROUND_1 }], waves },
    reviewBound: { wave: "full", unreviewedLanes: lanes, reason: "review STEP stopped" },
  };
}

/** A `verify` red whose gate attributed `tiers` tiers and `criteria` criterion ids. */
function redOutcome(tiers: string[], criteria: string[]): Outcome {
  return {
    kind: "red",
    reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
    red: { tiers, criteria },
  };
}

/** The shortest log the projection walks: a gate, a review, a reporting step. */
function log(review: Outcome | undefined, ...verify: Outcome[]): Step[] {
  const steps: Step[] = [{ key: "7:ready:0", state: "ready", startedAt: 1, outcome: { kind: "ok" } }];
  let n = 1;
  const at = (state: Step["state"], outcome: Outcome): Step => ({
    key: `7:${state}:${String(n++)}`,
    state,
    startedAt: n,
    endedAt: n + 1,
    outcome,
  });
  for (const oc of verify) steps.push(at("verify", oc));
  steps.push(at("publish", { kind: "ok", prUrl: "https://example.test/pull/7" }));
  if (review !== undefined) steps.push(at("review", review));
  steps.push(at("handback", { kind: "done", reason: "handback comment posted", posted: true }));
  return steps;
}

/** Project one log and hand back its `gates` object. */
async function gatesOfLog(review: Outcome | undefined, ...verify: Outcome[]) {
  const r = await driveLean("handed-back", 10, log(review, ...verify));
  return { issue: r.issue, gates: gatesOf(r.issue) };
}

// ─── (1) every capped list carries its own `Total`, in the same arm as its list ──
// One log, all five capped fields over the cap at once: `verify[].tiers`,
// `verify[].criteria`, `review.waves`, `review.reviewBound.unreviewedLanes`. A field
// whose marker is missing here is a field whose cut no host can see.
{
  const tiers = Array.from({ length: LIST_MAX + 4 }, (_, i) => `tier-${String(i)}`);
  const criteria = Array.from({ length: LIST_MAX + 7 }, (_, i) => `AC${String(i + 1)}`);
  const lanes = past(LIST_MAX + 3);
  const waves = Array.from({ length: LIST_MAX + 2 }, (_, i) => ({
    wave: (i % 2 === 0 ? "full" : "fix") as "full" | "fix",
    head: (i % 2 === 0 ? "a" : "b").repeat(39) + String(i % 10),
  }));
  const { gates } = await gatesOfLog(reviewOutcome(lanes, waves), redOutcome(tiers, criteria));

  const entry = (gates.verify as Record<string, unknown>[]).find(
    (e) => e.state === "verify" && e.kind === "red",
  );
  assert(
    Array.isArray(entry?.tiers) &&
      (entry?.tiers as string[]).length === LIST_MAX &&
      entry?.tiersTotal === tiers.length,
    `verify[].tiers: the list is cut at ${LIST_MAX} and tiersTotal names the full ${String(tiers.length)} (${String((entry?.tiers as string[] | undefined)?.length)} of ${String(entry?.tiersTotal)})`,
  );
  assert(
    Array.isArray(entry?.criteria) &&
      (entry?.criteria as string[]).length === LIST_MAX &&
      entry?.criteriaTotal === criteria.length,
    `verify[].criteria: cut at ${LIST_MAX}, criteriaTotal names the full ${String(criteria.length)} (${String((entry?.criteria as string[] | undefined)?.length)} of ${String(entry?.criteriaTotal)})`,
  );
  const review = gates.review as Record<string, unknown> | undefined;
  const bound = review?.reviewBound as Record<string, unknown> | undefined;
  assert(
    Array.isArray(review?.waves) &&
      (review?.waves as unknown[]).length === LIST_MAX &&
      review?.wavesTotal === waves.length,
    `review.waves: cut at ${LIST_MAX}, wavesTotal names the full ${String(waves.length)} (${String((review?.waves as unknown[] | undefined)?.length)} of ${String(review?.wavesTotal)})`,
  );
  assert(
    Array.isArray(bound?.unreviewedLanes) &&
      (bound?.unreviewedLanes as string[]).length === LIST_MAX &&
      bound?.unreviewedLanesTotal === lanes.length,
    `review.reviewBound.unreviewedLanes: cut at ${LIST_MAX}, unreviewedLanesTotal names the full ${String(lanes.length)} (${String((bound?.unreviewedLanes as string[] | undefined)?.length)} of ${String(bound?.unreviewedLanesTotal)})`,
  );
  // The host's own rule, stated once and checked on all four at once: a cut is exactly
  // the case where the total exceeds what was printed. Below the cap it never does.
  const cuts = [entry?.tiers, entry?.criteria, review?.waves, bound?.unreviewedLanes].map(
    (list) => (Array.isArray(list) ? list.length : -1),
  );
  assert(
    cuts.every((n) => n === LIST_MAX),
    `every capped list really was cut, so the totals above are cut-detections and not tautologies (${JSON.stringify(cuts)})`,
  );
}

// ─── (2) a list under the cap is not reported as cut ────────────────────────────
// The marker's other half: `Total === length` below the cap, so `Total > length` means
// a cut and nothing else. A `Total` that always exceeded the list would make the rule
// useless, and a host that merged on "no cut" would merge on a lie.
{
  const lanes = past(3);
  const waves = [{ wave: "full" as const, head: "c".repeat(40) }];
  const { gates } = await gatesOfLog(
    reviewOutcome(lanes, waves),
    redOutcome(["fast"], ["AC1"]),
  );
  const entry = (gates.verify as Record<string, unknown>[]).find(
    (e) => e.state === "verify" && e.kind === "red",
  );
  const review = gates.review as Record<string, unknown> | undefined;
  const bound = review?.reviewBound as Record<string, unknown> | undefined;
  assert(
    entry?.tiersTotal === 1 &&
      entry?.criteriaTotal === 1 &&
      review?.wavesTotal === 1 &&
      bound?.unreviewedLanesTotal === 3,
    `below the cap each Total equals its list's length — the two are never equal across a cut (${JSON.stringify([entry?.tiersTotal, entry?.criteriaTotal, review?.wavesTotal, bound?.unreviewedLanesTotal])})`,
  );
}

// ─── (3) the Total counts what survives the filter, not what the record held ────
// `criteria` keeps its `/^AC\d+$/` rule and `waves` its full-oid rule, so entries can be
// dropped by the projection rather than by the cap. The total counts the survivors: a
// host comparing `Total` against `length` is asking "was anything cut for LENGTH", and a
// total that counted refused entries would answer that question wrongly in the direction
// that matters — it would claim a cut that this document's list does not have.
{
  const kept = Array.from({ length: LIST_MAX + 1 }, (_, i) => `AC${String(i + 1)}`);
  const criteria = [...kept, "not-an-id", "AC1 padded", ""];
  const tiers = Array.from({ length: LIST_MAX + 2 }, (_, i) => `tier-${String(i)}`);
  const goodWaves = Array.from({ length: LIST_MAX }, (_, i) => ({
    wave: "fix" as const,
    head: "d".repeat(39) + String(i % 10),
  }));
  // Two malformed waves pushed past the cap: the projection refuses the whole `waves`
  // field for them, which is the sibling rule (a malformed head publishes nothing rather
  // than a partial truth) — asserted here so the two rules cannot quietly replace each
  // other.
  const { gates } = await gatesOfLog(
    reviewOutcome(past(LIST_MAX), [...goodWaves, { wave: "fix", head: "nope" }]),
    redOutcome(tiers, criteria),
  );
  const entry = (gates.verify as Record<string, unknown>[]).find(
    (e) => e.state === "verify" && e.kind === "red",
  );
  assert(
    entry?.criteriaTotal === kept.length &&
      (entry?.criteria as string[]).length === LIST_MAX,
    `verify[].criteriaTotal counts the ids this projection keeps, so a refused entry is in neither number (${String(entry?.criteriaTotal)} vs ${String((entry?.criteria as string[] | undefined)?.length)})`,
  );
  const review = gates.review as Record<string, unknown> | undefined;
  assert(
    review?.waves === null && review?.wavesTotal === null,
    `review.waves: a malformed head refuses the field, and its Total is null with it — never the count of a list that was not published (${JSON.stringify([review?.waves, review?.wavesTotal])})`,
  );
}

// ─── (4) a null list carries a null Total, never a zero ─────────────────────────
// The null rule, applied to the new fields. A red whose gate named no tier publishes
// `tiers: null` (that arm is pinned in `test-headless-work-lean-gates.ts`); beside it a
// `0` would say the gate checked zero tiers, which the record never said.
{
  const { gates } = await gatesOfLog(undefined, {
    kind: "red",
    reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
  });
  const entry = (gates.verify as Record<string, unknown>[]).find(
    (e) => e.state === "verify" && e.kind === "red",
  );
  assert(
    entry?.tiers === null &&
      entry?.tiersTotal === null &&
      entry?.criteria === null &&
      entry?.criteriaTotal === null,
    `verify[]: a red that recorded no attribution is null/null for both halves of each pair, never null/0 (${JSON.stringify(entry)})`,
  );
  // The same pair on the review arm a run reaches with no `reviewBound` at all: the
  // whole `reviewBound` is null, so it has no lane list whose count could be zero.
  const noBound: Outcome = {
    kind: "done",
    reason: "adversarial and six-lens review clean",
    review: { rounds: [{ ...ROUND_1 }], waves: [] },
  };
  const reviewed = await gatesOfLog(noBound);
  const review = reviewed.gates.review as Record<string, unknown> | undefined;
  assert(
    review?.reviewBound === null,
    `review.reviewBound: absent from the record is the field's null (${JSON.stringify(review?.reviewBound)})`,
  );
}

// ─── (5) `kind: "error"` is a third gate verdict, and it attributes nothing ─────
// A gate whose handler threw is infrastructure: the engine records `{kind: "error"}`
// (`lean/error-outcome.ts`) and the run hands back. That record can sit on a `verify` or
// `ci` step, so the list a host reads over carries `green | red | error` — and the two
// halves of an error entry are nulls, because an error is not a verdict about a tier and
// attributing one would send a host to a check this run never made.
{
  const { issue, gates } = await gatesOfLog(undefined, { kind: "error", message: "the gate died" });
  const entry = (gates.verify as Record<string, unknown>[]).find((e) => e.state === "verify");
  assert(
    entry?.kind === "error",
    `verify[]: an infra throw reaches the host as its own kind, not as a red and not folded away (${JSON.stringify(entry?.kind)})`,
  );
  assert(
    entry?.tiers === null &&
      entry?.tiersTotal === null &&
      entry?.criteria === null &&
      entry?.criteriaTotal === null,
    `verify[]: an error entry publishes no attribution — an infrastructure throw is not a tier's verdict (${JSON.stringify([entry?.tiers, entry?.tiersTotal, entry?.criteria, entry?.criteriaTotal])})`,
  );
  // The vocabulary itself, so a host switching on the three words sees the set from the
  // projection rather than inferring it from one run's JSON.
  const kinds = (gates.verify as Record<string, unknown>[]).map((e) => e.kind);
  assert(
    kinds.length === 1 && kinds[0] === "error",
    `the list holds the error verdict alone and does not invent a companion red for it (${JSON.stringify(kinds)})`,
  );
  // And the document's own copy: `gates.verify[].kind` is host-published, so the error
  // arm has to survive `leanIssueResult`, not just the projection helper.
  assert(
    JSON.stringify((issue?.gates as Record<string, unknown>)?.verify).includes('"kind":"error"'),
    "the host document carries kind \"error\" on the verify entry, verbatim",
  );
}

// ─── (6) the marker reaches the document, and the vocabulary stays the published four ─
{
  const { issue, gates } = await gatesOfLog(
    reviewOutcome(past(LIST_MAX + 1), [{ wave: "fix", head: "e".repeat(40) }]),
  );
  const doc = JSON.stringify(issue?.gates);
  assert(
    doc.includes('"unreviewedLanesTotal":') &&
      doc.includes('"wavesTotal":') &&
      doc.includes('"tiersTotal":') &&
      doc.includes('"criteriaTotal":'),
    `all four markers are on the serialised document a host parses, not only on the helper's return value (${doc.slice(0, 160)}…)`,
  );
  // The round tally is still keyed by exactly the published severities: the markers are
  // siblings of the lists, never new keys inside a round object a host enumerates.
  const review = gates.review as Record<string, unknown> | undefined;
  const round = (review?.rounds as Record<string, unknown>[])[0];
  assert(
    JSON.stringify(Object.keys(round ?? {}).sort()) ===
      JSON.stringify([...GATE_SEVERITIES].sort()),
    `a round still carries exactly the four published severities and no Total of its own (${JSON.stringify(Object.keys(round ?? {}))})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
