/**
 * The `gates` cases that put the REAL engine in front of the projection.
 *
 * A projection tested only against hand-written logs is a projection that reads what a
 * test author typed: nothing in such a file says a handler can write the value, or that
 * the loader would accept one it did. These cases ask the engine's own handlers to write
 * the record and `loadRun` to hand it back, so every projected value is one a handler
 * wrote and a validator accepted on the way in — the counterpart to the hand-built-log
 * cases in `test-headless-work-lean-gates.ts`, which is where the switch, the off arm and
 * the per-field readings are pinned.
 *
 * Split from that file for the size gate, along the seam the two fixtures already drew:
 * one file reads a log, the other drives one.
 */

import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { tempDir } from "./lib/lean-engine-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { driveEngineGates } from "./lib/lean-gates-engine-drive.ts";
import { HEAD } from "./lib/lean-result-fixture.ts";
import {
  ROUND_1,
  ROUND_2,
  UNSHIPPED,
  WAVES,
  gatesOf,
  outcomeOf,
} from "./lib/lean-result-gates-fixture.ts";

const { assert, failures } = makeAssert();

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
    JSON.stringify(g.specify) === JSON.stringify({ frozen: null, tests: null }),
    `engine: a run whose specify step froze nothing says so with two nulls off the LOADED record, not an empty object (${JSON.stringify(g.specify)})`,
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

// The one reading the driven case owes the frozen map: `specify` wrote it, so the loaded
// record carries it and the projection prints it. Paired with the null arm above, which
// is the same field on a run whose step recorded nothing.
{
  const { run } = await driveEngineGates(tempDir("lean-gates-frozen").dir, 93, {
    review: ["done"],
    frozen: { "tests/AC1-retry.test.sh": "a".repeat(64) },
    tests: { AC1: ["tests/AC1-retry.test.sh"] },
  });
  const g = gatesOf(leanIssueResult(run, 93) as unknown as Record<string, unknown>);
  assert(
    JSON.stringify(g.specify) ===
      JSON.stringify({
        frozen: { "tests/AC1-retry.test.sh": "a".repeat(64) },
        tests: { AC1: ["tests/AC1-retry.test.sh"] },
      }),
    `engine: the frozen map came off the record loadRun returned, verbatim (${JSON.stringify(g.specify)})`,
  );
  assert(
    outcomeOf(run, "specify")?.frozen !== undefined,
    "engine: the frozen map is on the durable record, so the projection is a reader of it and not a re-derivation",
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
