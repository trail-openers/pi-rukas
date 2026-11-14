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
 *   - **the switch** (G12): default on, only the literal `"0"` off, read at CALL
 *     time, and registered as an input and in the docs like every other knob;
 *   - **the off arm is byte-identical to today's document** — proved by comparing the
 *     WHOLE serialised document, key order included. A field-absence check is not
 *     that proof: `gates: undefined` is absent to a field check and present to a host
 *     that string-compares the document;
 *   - **every field is read from the durable record** (G1), and a field the record
 *     does not answer is an explicit `null`, never an omitted key (G7) — a host must
 *     be able to tell "this run had no challenge" from "this build did not look";
 *   - **the severity vocabulary is the published four** (G2), and a record that
 *     breaks it is refused at load rather than quietly projected (G9);
 *   - **the two heads and `prState` cannot disagree** (G10) because the projection
 *     asks the same helpers the PR-state verdict asks.
 *
 * Each reading rule is asserted twice over: once from a hand-built log (what the
 * projection reads) and once from a log the REAL engine wrote and `loadRun` read back
 * (that a handler can write what the projection prints).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { HEADLESS_FEATURES } from "../src/headless/capabilities.ts";
import { HEADLESS_INPUTS } from "../src/headless/inputs.ts";
import { leanIssueResult, leanResultDocument } from "../src/headless/work-lean-result.ts";
import { leanResultGatesEnabled } from "../src/lean/result-gates-switch.ts";
import { loadRun, saveRun } from "../src/lean/state.ts";
import { CLOCK, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";
import { driveEngineGates } from "./lib/lean-gates-engine-drive.ts";
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

/**
 * The env keys these cases pin, restored after every case. The switch is read at
 * call time and the arms are pinned per block, so the set has to be the one the
 * scope clears — a key left set by an earlier block is a switch that silently
 * disables the next file in the same bun process.
 */
const SWITCH = "PI_ENSEMBLE_LEAN_RESULT_GATES";
const savedSwitch = process.env[SWITCH];
async function withSwitch(value: string | undefined, body: () => Promise<void>): Promise<void> {
  if (value === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = value;
  try {
    await body();
  } finally {
    if (savedSwitch === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = savedSwitch;
  }
}

// ─── (1) the switch's truth table ───────────────────────────────────────────────
// G12: only the literal "0" takes the object out. An empty value is a shell that
// meant nothing, and `false` is a value, not the token the contract names.
for (const [value, want] of [
  [undefined, true],
  ["", true],
  ["1", true],
  ["false", true],
  ["0", false],
] as const) {
  await withSwitch(value, async () => {
    assert(leanResultGatesEnabled() === want, `switch ${JSON.stringify(value)} → ${String(want)}`);
  });
}

// ─── (2) THE OFF ARM IS THE SAME DOCUMENT ──────────────────────────────────────
// The whole serialised document compared, not a field check: this is the claim that
// lets the object ship on by default without breaking a host that parses the file
// strictly. The on arm must genuinely differ, or the comparison proves nothing.
{
  const steps = gatesLog({
    challenge: "new-tests",
    verify: "red",
    reds: { tiers: ["fast"], criteria: ["AC1"] },
    review: "fixed",
    heads: { shippedHead: HEAD, shippedVerified: true },
  });
  const seed = await driveLean("handed-back", 10, steps);
  let on = "";
  let off = "";
  await withSwitch(undefined, async () => {
    on = JSON.stringify(leanResultDocument(seed.run, 10).doc);
  });
  await withSwitch("0", async () => {
    off = JSON.stringify(leanResultDocument(seed.run, 10).doc);
  });
  const onIssues = (JSON.parse(on).issues ?? []) as Record<string, unknown>[];
  const offIssues = (JSON.parse(off).issues ?? []) as Record<string, unknown>[];
  assert(onIssues[0]?.hasOwnProperty("gates"), "on: the projected issue carries a `gates` key");
  assert(
    !offIssues[0]?.hasOwnProperty("gates"),
    "off: no `gates` key at all — not one holding null, not one holding undefined",
  );
  assert(on !== off, "the on arm really differs from the off arm (the comparison is not vacuous)");
  const stripped = JSON.parse(on) as { issues: Record<string, unknown>[] };
  delete stripped.issues[0]?.gates;
  assert(
    off === JSON.stringify(stripped),
    "off: the whole serialised document is today's document, key order included",
  );
  // The top-level `schema` is the document's own version stamp: a new OPTIONAL key
  // on a record whose consumers ignore unknown keys is additive, so the number a
  // host branches on must not move. If it did, every host that pins it would read
  // the off document as a different contract than the one it already handles.
  assert(
    JSON.parse(off).schema === JSON.parse(on).schema,
    "the schema stamp does not move between the arms",
  );
}

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
        { state: "verify", kind: "red", tiers: ["fast", "full"], criteria: ["AC1", "AC2"] },
        // The run's gate then said what it says about a pipeline the run never ran:
        // `ci` follows `review`, so a run that ended at its gate has a `ci` verdict
        // nobody gave and this list says so rather than dropping the entry.
        { state: "ci", kind: "green", tiers: null, criteria: null },
      ]),
    `verify: the red names its tier and the criteria it failed for (${JSON.stringify(gatesOf(r.issue).verify)})`,
  );
  const bare = await driveLean("handed-back", 10, gatesLog({ verify: "red" }));
  assert(
    JSON.stringify(gatesOf(bare.issue).verify) ===
      JSON.stringify([
        { state: "verify", kind: "red", tiers: null, criteria: null },
        { state: "ci", kind: "green", tiers: null, criteria: null },
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
      JSON.stringify([{ state: "verify", kind: "green", tiers: null, criteria: null }]),
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
      // are named, not as a fixture happened to spell them.
      JSON.stringify({
        wave: "full",
        reason: REVIEW_BOUND.reason,
        unreviewedLanes: REVIEW_BOUND.unreviewedLanes,
      }),
    `review: reviewBound is the record's own, unreviewed lanes included (${JSON.stringify(gatesOf(bound.issue).review?.reviewBound)})`,
  );
  // A head the record cannot name as an oid is not printed: the projection re-checks
  // rather than trusting what reached it, because a projection is the last place a
  // malformed value can be stopped before a host parses it.
  const badHead = await driveLean(
    "handed-back",
    10,
    gatesLog({ review: "fixed" }).map((s) =>
      s.state === "review"
        ? {
            ...s,
            outcome: {
              ...s.outcome,
              review: {
                rounds: [ROUND_1, ROUND_2].map((r) => ({ ...r })),
                waves: [{ wave: "fix", head: "nope" }],
              },
            } as Outcome,
          }
        : s,
    ),
  );
  assert(
    gatesOf(badHead.issue).review === null,
    `review: a wave head that is not a full oid is refused at the projection, not printed (${JSON.stringify(gatesOf(badHead.issue).review?.waves)})`,
  );
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
  const still = await driveLean("handed-back", 10, gatesLog({}));
  const moved = gatesOf(still.issue).handback as Record<string, unknown>;
  assert(
    moved.reason === "handback comment posted" &&
      moved.head === null &&
      moved.verified === null &&
      moved.unshipped === null,
    `handback: a handback that moved nothing is four nulls, not four omissions (${JSON.stringify(moved)})`,
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

// ─── (8) the record is the source: driven by the real engine, read back by loadRun ─
// A projection tested only against hand-written logs is a projection that reads what
// a test author typed. This case asks the engine's own handlers to write the record and
// `loadRun` to hand it back, so every projected value is one a handler wrote and a
// validator accepted on the way in.
{
  const { run } = await driveEngineGates(tempDir("lean-gates-engine").dir, 91, {
    challenge: "new-tests",
    // Two rounds, which is what the table owes a run whose first review bought a fixer:
    // the wave is re-reviewed before the step may answer, so a record naming one round is
    // a step that judged two and reported one.
    review: ["fixed", "done"],
    record: { rounds: [ROUND_1, ROUND_2], waves: WAVES },
    // The rewind moved origin back to the last certified head, so what shipped is NOT
    // what `publish` recorded — which is the one case `shippedVerified` exists to say.
    publishedHead: UNSHIPPED,
    heads: { shippedHead: HEAD, shippedVerified: false },
    land: "refused",
  });
  const issue = leanIssueResult(run, 91) as unknown as Record<string, unknown>;
  const g = gatesOf(issue);
  assert(
    run.state === "landed" || run.state === "handed-back",
    `engine: the drive walked its table to a terminal state, so nothing below is read off a log some scripted step left short (${String(run.state)}, ${String(run.result?.reason)})`,
  );
  assert(
    JSON.stringify(g.review?.rounds) === JSON.stringify([ROUND_1, ROUND_2]),
    `engine: the review counts survived the write, the load and the projection (${JSON.stringify(g.review?.rounds)})`,
  );
  assert(
    JSON.stringify(g.review?.waves) === JSON.stringify(WAVES),
    `engine: the fix wave's full head is the handler's own record (${JSON.stringify(g.review?.waves)})`,
  );
  assert(
    g.handback?.head === HEAD && g.handback?.verified === false,
    `engine: the shipped head and the gate's verdict about it are the handback step's own record (${JSON.stringify(g.handback)})`,
  );
  assert(
    outcomeOf(run, "review")?.review?.rounds !== undefined,
    "engine: the record itself holds the counts the projection printed — the projection invented none",
  );
  // Two reds, both recorded, both projected: the table routes a red `verify` back
  // through build and a red `ci` through one fix round, so a run genuinely carries
  // two gate failures and the host must not have to guess which one ended it.
  const twice = await driveEngineGates(tempDir("lean-gates-engine").dir, 92, {
    verify: ["red", "green"],
    reds: { tiers: ["fast"], criteria: ["AC1"] },
    review: ["done"],
    ci: ["red", "red"],
    ciReds: { tiers: ["full"], criteria: ["AC2"] },
    land: "refused",
  });
  const twiceIssue = leanIssueResult(twice.run, 92) as unknown as Record<string, unknown>;
  const entries = (gatesOf(twiceIssue).verify ?? []) as Record<string, unknown>[];
  assert(
    entries.length === 5 &&
      entries[0]?.kind === "red" &&
      JSON.stringify(entries[0]?.tiers) === JSON.stringify(["fast"]) &&
      JSON.stringify(entries[0]?.criteria) === JSON.stringify(["AC1"]) &&
      entries[2]?.kind === "green" &&
      entries[3]?.state === "ci" &&
      JSON.stringify(entries[3]?.tiers) === JSON.stringify(["full"]) &&
      JSON.stringify(entries[3]?.criteria) === JSON.stringify(["AC2"]) &&
      entries[4]?.state === "ci" &&
      entries[4]?.kind === "red",
    // Five entries, not four: the table gives a red pipeline exactly one fix round, so a
    // run that fails it twice carries both `ci` verdicts, and a list that collapsed them
    // would hide which of the two ended the run.
    `engine: every red the run recorded is in the list, verify's and ci's alike (${JSON.stringify(entries)})`,
  );
  assert(
    twice.run.state === "handed-back",
    `engine: a second red pipeline ends the run at the reporting step (${String(twice.run.state)})`,
  );
}

// ─── (9) G9: a record outside the published severity vocabulary is refused at load ─
// The list is what the host branches on. Refusing at the load keeps the projection a
// reader and makes the malformed record a loud one — a projection that tolerated a
// fifth word would print it and a host would silently miss those findings.
{
  const dir = tempDir("lean-gates-sev").dir;
  const forged = (round: Record<string, number>): Step[] =>
    gatesLog({ review: "fixed" }).map((s) =>
      s.state === "review"
        ? {
            ...s,
            outcome: { ...s.outcome, review: { rounds: [round], waves: [] } },
          }
        : s,
    ) as Step[];
  const load = (steps: Step[], issue: number): Error | undefined => {
    saveRun(dir, {
      schema: 1,
      issue,
      version: "test",
      models: {},
      baseSha: "f".repeat(40),
      branch: `feature/issue-${String(issue)}`,
      state: "handed-back",
      counters: {
        buildAttempts: 0,
        challengeDone: false,
        reviewDone: true,
        ciFixUsed: false,
        draft: false,
      },
      steps,
      result: { reason: "test", code: 10 },
    } as never);
    try {
      loadRun(dir, issue);
      return undefined;
    } catch (err) {
      return err as Error;
    }
  };
  // The control first: the record the run's own handler writes, with the four words,
  // loads. Without it the refusal below could be a refusal of EVERY record.
  assert(
    load(forged({ ...ROUND_1 }), 93) === undefined,
    "G9: the four published severities load, so the refusal below is about the fifth word and nothing else",
  );
  const fifth = load(forged({ ...ROUND_1, BLOCKER: 1 } as never), 94);
  assert(
    fifth?.name === "LeanStateError",
    `G9: a round naming a severity outside the published four is refused at load (got: ${String(fifth)})`,
  );
  assert(
    fifth?.message?.includes("review.rounds") === true,
    `G9: the refusal names the field a host would have read (${String(fifth?.message)})`,
  );
  const half = load(forged({ CRITICAL: 1, HIGH: 1 } as never), 95);
  assert(
    half?.name === "LeanStateError",
    `G9: a round missing two of the four is refused too — a partial tally is the silent half of the same bug (got: ${String(half)})`,
  );
}

// ─── (10) G8 + G12: the switch is discoverable ─────────────────────────────────
// A knob that appears in no inventory is a knob that does not exist: `--capabilities`
// is how a host asks what this build reads and writes, and a field it does not
// mention is a field no host can code against.
{
  assert(
    HEADLESS_FEATURES.leanGates === true,
    "features.leanGates is true on a build that writes the object",
  );
  const names = HEADLESS_INPUTS.map((i) => i.name);
  assert(
    names.includes("PI_ENSEMBLE_LEAN_RESULT_GATES"),
    "HEADLESS_INPUTS lists PI_ENSEMBLE_LEAN_RESULT_GATES",
  );
  // The list's own order is the collation `test-headless-inputs.ts` enforces (the
  // `__`-to-space localeCompare that mostly ignores the separators), not ASCII order —
  // so the new entry has to sit where THAT rule puts it, and this is the same rule, not
  // a second opinion about it.
  assert(
    JSON.stringify(
      [...names].sort((a, b) => a.replace(/_/g, " ").localeCompare(b.replace(/_/g, " "))),
    ) === JSON.stringify(names),
    "HEADLESS_INPUTS stays sorted after the new entry",
  );
  const entry = HEADLESS_INPUTS.find((i) => i.name === "PI_ENSEMBLE_LEAN_RESULT_GATES");
  assert(
    entry?.type === "boolean" && entry.default === true,
    `the entry is a boolean that defaults to on (${JSON.stringify(entry)})`,
  );
  const docText = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "docs", "configuration.md"),
    "utf8",
  );
  assert(
    docText.includes("`PI_ENSEMBLE_LEAN_RESULT_GATES`"),
    "docs/configuration.md carries a row for the switch",
  );
}

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
