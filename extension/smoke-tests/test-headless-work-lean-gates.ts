#!/usr/bin/env bun
/**
 * The `gates` object on the work-lean result record, and the switch that owns it.
 *
 * `pi-rukas-result.json` is the host contract; `.pi/lean-state/<issue>.json` is the
 * driver's private persistence and carries no stability promise (docs/headless.md).
 * A host that wants to know WHICH files froze per criterion, what the challenge
 * answered, which tier went red at which criterion, what each review round found,
 * which head the fix wave pushed, and what the handback actually shipped had to read
 * the private file for it. `issues[].gates` moves those events onto the record that
 * does promise them.
 *
 * Five rules the cases below are built around:
 *
 *   - **the switch** (G12) and **the off arm's byte-equality** live together in
 *     `test-headless-work-lean-gates-switch.ts` — the object is absent entirely under
 *     `PI_ENSEMBLE_LEAN_RESULT_GATES=0`, and the document is then the one this build wrote
 *     before the object existed, proved against the WHOLE serialisation, key order included;
 *   - **every field is read from the durable record** (G1), and a field the record
 *     does not answer is an explicit `null`, never an omitted key (G7) — a host must
 *     be able to tell "this run had no challenge" from "this build did not look";
 *   - **the severity vocabulary is the published four** (G2), and a record that
 *     breaks it is refused at load rather than quietly projected (G9) — the two refusal
 *     arms are pinned in `test-headless-work-lean-gates-review-refusal.ts`;
 *   - **the two heads and `prState` cannot disagree** (G10) because the projection
 *     asks the same helpers the PR-state verdict asks;
 *   - **a capped list declares its cut** — every list the projection clips rides a
 *     `<name>Total` sibling, pinned in `test-headless-work-lean-gates-truncation.ts`.
 *
 * Each reading rule is asserted twice over: once from a hand-built log (what the
 * projection reads) and once from a log the REAL engine wrote and `loadRun` read back
 * (that a handler can write what the projection prints).
 */

import { leanGates } from "../src/headless/work-lean-gates.ts";
import { leanIssueResult, leanResultDocument } from "../src/headless/work-lean-result.ts";
import { leanResultGatesEnabled } from "../src/lean/result-gates-switch.ts";
import { loadRun, saveRun } from "../src/lean/state.ts";
import { CLOCK, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";
import { HEAD, URL, driveLean, stepWith } from "./lib/lean-result-fixture.ts";
import {
  FIX_HEAD,
  FROZEN,
  REVIEW_BOUND,
  ROUND_1,
  ROUND_2,
  TESTS,
  UNSHIPPED,
  WAVES,
  gatesLog,
  gatesOf,
  gatesRun,
  outcomeOf,
  verifyEntry,
} from "./lib/lean-result-gates-fixture.ts";

const { assert, failures } = makeAssert();

// ─── (2) the switch and its two arms live in `test-headless-work-lean-gates-switch.ts ─
// The truth table (default on, only the literal `"0"` off, read at CALL time) and the
// off-arm byte-equality are the pair that owns the knob, so they are pinned together there;
// the per-field readings below are the other half of this file's subject.

// ─── (3) G5: `specify` — the frozen files, and the tests kept per criterion ─────
// `build` reads the union of the frozen maps from the log and `handoff` renders the
// criterion list, so the projection is reading data the run already keeps — that is
// what makes publishing it cheap enough to keep in sync by construction.
{
  const r = await driveLean("handed-back", 10, gatesLog({}));
  assert(
    r.violations.length === 0,
    `specify: the output contract still holds (${r.violations.join("; ")})`,
  );
  assert(
    JSON.stringify(gatesOf(r.issue).specify) === JSON.stringify({ frozen: FROZEN, tests: TESTS }),
    `specify: frozen path->sha256 and tests id->files, verbatim from the record (${JSON.stringify(gatesOf(r.issue).specify)})`,
  );
  const none = await driveLean("handed-back", 10, gatesLog({ frozen: null, tests: null }));
  assert(
    JSON.stringify(gatesOf(none.issue).specify) === JSON.stringify({ frozen: null, tests: null }),
    `specify: a run that froze nothing is {frozen:null,tests:null} — never {}, never an omitted object (${JSON.stringify(gatesOf(none.issue).specify)})`,
  );
}

// ─── (4) G4: `challenge` — the verdict by POSITION, and the ceiling's trio ───────
// The verdict is read from the newest challenge step wherever it sits, so a run that
// later re-verifies and republishes still reports the verdict it actually got. A
// status-line reader would read the last line of the log and answer for `handback`.
{
  for (const verdict of ["new-tests", "none"] as const) {
    const r = await driveLean("handed-back", 10, gatesLog({ challenge: verdict }));
    assert(
      gatesOf(r.issue).challenge?.kind === verdict,
      `challenge: the recorded verdict ${verdict} is projected (${JSON.stringify(gatesOf(r.issue).challenge)})`,
    );
  }
  const ceiling = await driveLean("handed-back", 10, gatesLog({ challenge: "budget" }));
  assert(
    JSON.stringify(gatesOf(ceiling.issue).challenge) ===
      JSON.stringify({ kind: "budget", limit: "turns", value: 3, used: 3 }),
    `challenge: the ceiling arm keeps the typed trio the step already records (${JSON.stringify(gatesOf(ceiling.issue).challenge)})`,
  );
  // The newest by position, not the newest that answered: a crashed re-entry is the
  // run's current state and a projection that skipped to the older verdict would
  // report a challenge this run is no longer standing on. The crash's own entry must
  // sit AT THE END of the log — that is the only shape the engine ever writes an
  // undecided step in, and a log that buried one mid-way would be refused at load.
  const crashed = await driveLean("handed-back", 10, [
    ...gatesLog({ challenge: "none", ci: null, review: null }).filter(
      (s) => s.state !== "handback",
    ),
    { key: "7:challenge:1", state: "challenge", startedAt: CLOCK + 9 } as Step,
  ]);
  assert(
    gatesOf(crashed.issue).challenge === null,
    `challenge: an outcome-less newest attempt is null, not the older verdict (${JSON.stringify(gatesOf(crashed.issue).challenge)})`,
  );
  const absent = await driveLean("handed-back", 10, gatesLog({ challenge: null }));
  assert(
    gatesOf(absent.issue).challenge === null,
    `challenge: a log with no challenge step at all is null, not "none" — the two are different facts (${JSON.stringify(gatesOf(absent.issue).challenge)})`,
  );
}

// ─── (5) G3: every `verify`/`ci` red, with its tier and the criteria it answers ──
// A list, not one field: a run can carry two reds and the host must see both, each
// with the tier that failed and the criterion ids the failing lines were mapped to —
// the same list the handback comment renders.
{
  const r = await driveLean(
    "handed-back",
    10,
    gatesLog({
      verify: "red",
      reds: { tiers: ["fast", "full"], criteria: ["AC1", "AC2"] },
    }),
  );
  assert(
    JSON.stringify(gatesOf(r.issue).verify) ===
      JSON.stringify([
        {
          state: "verify",
          kind: "red",
          tiers: ["fast", "full"],
          tiersTotal: 2,
          criteria: ["AC1", "AC2"],
          criteriaTotal: 2,
        },
        // The run's gate then said what it says about a pipeline the run never ran:
        // `ci` follows `review`, so a run that ended at its gate has a `ci` verdict
        // nobody gave and this list says so rather than dropping the entry. Its two
        // `Total`s are null with their lists — the record named neither.
        {
          state: "ci",
          kind: "green",
          tiers: null,
          tiersTotal: null,
          criteria: null,
          criteriaTotal: null,
        },
      ]),
    `verify: the red names its tier and the criteria it failed for (${JSON.stringify(gatesOf(r.issue).verify)})`,
  );
  const bare = await driveLean("handed-back", 10, gatesLog({ verify: "red" }));
  assert(
    JSON.stringify(gatesOf(bare.issue).verify) ===
      JSON.stringify([
        {
          state: "verify",
          kind: "red",
          tiers: null,
          tiersTotal: null,
          criteria: null,
          criteriaTotal: null,
        },
        {
          state: "ci",
          kind: "green",
          tiers: null,
          tiersTotal: null,
          criteria: null,
          criteriaTotal: null,
        },
      ]),
    `verify: a red that recorded no tier is null for it, never an empty list that reads as "checked none" (${JSON.stringify(gatesOf(bare.issue).verify)})`,
  );
  const green = await driveLean(
    "handed-back",
    10,
    gatesLog({ verify: "green", pr: false, ci: null, review: null }),
  );
  assert(
    JSON.stringify(gatesOf(green.issue).verify) ===
      JSON.stringify([
        {
          state: "verify",
          kind: "green",
          tiers: null,
          tiersTotal: null,
          criteria: null,
          criteriaTotal: null,
        },
      ]),
    `verify: the verdict the run ended on is recorded with its kind (${JSON.stringify(gatesOf(green.issue).verify)})`,
  );
  const ci = await driveLean(
    "handed-back",
    10,
    gatesLog({ verify: "green", ci: { tiers: ["full"], criteria: ["AC1"] } }),
  );
  const list = gatesOf(ci.issue).verify as Record<string, unknown>[];
  assert(
    Array.isArray(list) &&
      list.length === 2 &&
      list[1]?.state === "ci" &&
      JSON.stringify(list[1]?.tiers) === JSON.stringify(["full"]) &&
      JSON.stringify(list[1]?.criteria) === JSON.stringify(["AC1"]),
    `ci: the pipeline's red is its own entry with its own tier, not folded into verify's (${JSON.stringify(list)})`,
  );
}

// ─── (6) G2 + G11: `review` — counts by the published four, the wave's head, the
// unreviewed lanes verbatim ──────────────────────────────────────────────────────
{
  const r = await driveLean("handed-back", 10, gatesLog({ review: "fixed" }));
  const g = gatesOf(r.issue);
  assert(
    g.review?.kind === "fixed",
    `review: the vocabulary documents \`fixed\` and the projection keeps it (${String(g.review?.kind)})`,
  );
  assert(
    JSON.stringify(g.review?.rounds) === JSON.stringify([ROUND_1, ROUND_2]),
    `review: one entry per round, keyed by exactly the four published severities (${JSON.stringify(g.review?.rounds)})`,
  );
  assert(
    JSON.stringify(g.review?.waves) === JSON.stringify(WAVES),
    `review: each fix wave's FULL 40-hex head, not the 12 the reason line prints (${JSON.stringify(g.review?.waves)})`,
  );
  const error = await driveLean("handed-back", 10, gatesLog({ review: "error" }));
  assert(
    gatesOf(error.issue).review?.kind === "error",
    `review: the third documented vocabulary word reaches the host (${JSON.stringify(gatesOf(error.issue).review)})`,
  );
  const never = await driveLean("handed-back", 10, gatesLog({ review: null }));
  assert(
    gatesOf(never.issue).review === null,
    `review: a run that never reached review is null, not a zero-round review (${JSON.stringify(gatesOf(never.issue).review)})`,
  );
  // G11: `reviewBound` rides the entry verbatim from the record — it was already
  // written to the document's own persistence for exactly this question.
  const bound = await driveLean(
    "handed-back",
    10,
    gatesLog({ review: "fixed" }).map((s) =>
      s.state === "review"
        ? {
            ...s,
            outcome: {
              ...(s.outcome as object),
              reviewBound: { ...REVIEW_BOUND },
            } as never,
          }
        : s,
    ),
  );
  assert(
    JSON.stringify(gatesOf(bound.issue).review?.reviewBound) ===
      // Key order as the projection publishes it: the record's fields, published as they
      // are named, then the print count beside the lane list it counts — and both come
      // from one pass over the lanes, so neither can disagree with the other.
      JSON.stringify({
        wave: "full",
        reason: REVIEW_BOUND.reason,
        unreviewedLanes: REVIEW_BOUND.unreviewedLanes,
        unreviewedLanesTotal: REVIEW_BOUND.unreviewedLanes.length,
      }),
    `review: reviewBound is the record's own, unreviewed lanes included (${JSON.stringify(gatesOf(bound.issue).review?.reviewBound)})`,
  );
  // A head the record cannot name as an oid, and one malformed round: both refusals, and
  // the all-or-nothing rule behind them, are pinned in
  // `test-headless-work-lean-gates-review-refusal.ts` — this file reads a sound record and
  // that one reads a broken one, which is the seam the §12 size cap asked for.
}

// ─── (7) G6 + G10: `handback` — reason, both heads, and the verdict they agree with ─
{
  const r = await driveLean(
    "handed-back",
    10,
    gatesLog({
      // The run must land where `publish`'s own record can be the head: the handback's
      // `shippedHead` is that head, and the re-verification a `fixed` review owes would
      // otherwise certify the FIXER's commit and leave this one uncertified.
      review: "done",
      draft: false,
      heads: {
        shippedHead: HEAD,
        // `ready` needs a gate that cleared THIS head, so the run's re-verification is the
        // second green below and its head is the one publish pushed.
        shippedVerified: true,
        unshippedHead: UNSHIPPED,
        unshippedReason: "the rewind's lease refused the push",
      },
    }),
  );
  const h = gatesOf(r.issue).handback as Record<string, unknown>;
  assert(
    h.reason === "handback comment posted",
    `handback: the step's own reason (${String(h.reason)})`,
  );
  assert(
    h.head === HEAD,
    `handback: head is the handback step's own shippedHead (${String(h.head)})`,
  );
  assert(
    h.verified === true &&
      r.issue?.prState === "ready" &&
      // The document's own cap is the third surface that reads the same verdict: a run
      // whose heads and `prState` agreed but whose cap said otherwise would be three
      // fields answering three questions.
      r.issue?.cap === "awaiting-human-merge",
    `handback: 'verified', 'prState' and the cap are one verdict (${String(h.verified)} / ${String(r.issue?.prState)} / ${String(r.issue?.cap)})`,
  );
  assert(
    JSON.stringify(h.unshipped) ===
      JSON.stringify({ head: UNSHIPPED, reason: "the rewind's lease refused the push" }),
    `handback: the head it displaced, with the reason beside it (${JSON.stringify(h.unshipped)})`,
  );
  // Two silent hands, one shape. The log's `heads: null` arm is the run whose handback
  // recorded NO head at all — the rule never fired, or the no-head recording switch is
  // off — and both head fields still answer, off the publish side: nulls there would read
  // "shipped nothing" beside `prState: "ready"`, two surfaces telling two stories about one
  // commit. The log with no `handback` step at all (`review: null`, so nothing reaches the
  // reporting step) is where four nulls really are the answer.
  const silent = await driveLean("handed-back", 10, gatesLog({ heads: null }));
  const moved = gatesOf(silent.issue).handback as Record<string, unknown>;
  assert(
    moved.reason === "handback comment posted" &&
      moved.head === HEAD &&
      moved.verified === true &&
      moved.unshipped === null,
    `handback: a handback that recorded no head still says what its PR stands on, read the way prState reads it (${JSON.stringify(moved)})`,
  );
  const never = await driveLean(
    "handed-back",
    10,
    gatesLog({ heads: null, pr: false, ci: null, review: null }),
  );
  const none = gatesOf(never.issue).handback as Record<string, unknown>;
  assert(
    none.head === null && none.verified === null && none.unshipped === null,
    `handback: a run that reached no reporting step and opened no PR is nulls, not omissions (${JSON.stringify(none)})`,
  );
  const ready = await driveLean("handed-back", 10, gatesLog({ review: "done", draft: false }));
  const mergeable = gatesOf(ready.issue).handback as Record<string, unknown>;
  assert(
    ready.issue?.prState === "ready" &&
      mergeable.head === HEAD &&
      mergeable.verified === true,
    `handback: a run ready to merge never reads "no head" — the publish-side head answers where the step was silent (${JSON.stringify(mergeable)} / ${String(ready.issue?.prState)})`,
  );
  // The drift case, and the agreement it proves: the shipped head is not the head the
  // gate certified, so the run is not ready. `verified` false and `prState` draft are
  // one answer read from one helper — two fields that cannot drift apart.
  const drifted = await driveLean(
    "handed-back",
    10,
    gatesLog({
      draft: false,
      // What shipped is a head the gate never certified — the rewind moved origin back
      // to the last green one, and that is the case this pair of fields exists to show.
      publishedHead: UNSHIPPED,
      heads: {
        shippedHead: HEAD,
        shippedVerified: false,
        unshippedReason: "origin was rewound to the last certified head",
      },
    }),
  );
  const d = gatesOf(drifted.issue).handback as Record<string, unknown>;
  assert(
    d.verified === false && drifted.issue?.prState === "draft",
    `handback: an uncertified shipped head reads false/draft together (${String(d.verified)}/${String(drifted.issue?.prState)})`,
  );
  // A handback that posted nothing still says what it shipped, so the reason for its
  // absence can be read off the record instead of reconstructed from the step log.
  const unposted = await driveLean(
    "handed-back",
    10,
    gatesLog({
      review: "done",
      posted: false,
      heads: { shippedHead: HEAD, shippedVerified: true },
    }),
  );
  assert(
    gatesOf(unposted.issue).handback?.head === HEAD,
    `handback: the head is reported whether or not the comment reached the forge`,
  );
  const noReason = await driveLean("handed-back", 10, gatesLog({ handbackReason: null }));
  assert(
    gatesOf(noReason.issue).handback?.reason === null,
    `handback: a record with no reason line is null, not "" — the run said nothing and the host can see it`,
  );
}

// ─── (8) split for the §12 size gate, along the seam each new file's question draws
// `test-headless-work-lean-gates-engine.ts` holds the cases that put the REAL engine in
// front of the projection — the same object read off a record a handler wrote and `loadRun`
// handed back — while `test-headless-work-lean-gates-redaction.ts` holds the two strings a
// run's own CHILD authored, where the projection has to change the record rather than read
// it. This file reads a log and asks what came out; those two drive one, or redact one.
// ─── (11) the object is one key, and it holds only the gate events ───────────────
// The shape a host codes against is a contract, and a contract grows by accretion:
// every field that arrives because "we already had it here" is a field somebody has
// to keep true forever. These are the seven, and nothing else.
{
  const r = await driveLean(
    "handed-back",
    10,
    gatesLog({ challenge: "none", verify: "green", review: "done", heads: { shippedHead: HEAD } }),
  );
  assert(
    JSON.stringify(Object.keys(gatesOf(r.issue)).sort()) ===
      JSON.stringify(["challenge", "handback", "review", "specify", "verify"]),
    `the object holds the gate events and nothing else (${JSON.stringify(Object.keys(gatesOf(r.issue)))})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
