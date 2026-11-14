#!/usr/bin/env bun
/**
 * A review record whose severity tally falls outside the published vocabulary is
 * REFUSED AT THE LOAD, not carried and printed.
 *
 * `gates.review.rounds` is keyed by the four words a host branches on. A projection that
 * tolerated a fifth key would publish it, and a host switching on four names would
 * silently stop seeing the findings filed under the fifth — a partial truth that reads as
 * a whole one. So the loader is the one that refuses, and this file is the case that makes
 * that refusal loud.
 *
 * Split from `test-headless-work-lean-gates.ts` for the size gate, along the seam the
 * file's own sections drew: the projection's readings there, the validator's refusals here.
 */

import { tempDir } from "./lib/lean-engine-fixtures.ts";
import { ROUND_1, gatesLog } from "./lib/lean-result-gates-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import type { Step } from "../src/lean/state.ts";
import { loadRun, saveRun } from "../src/lean/state.ts";

const { assert, failures } = makeAssert();

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
  // And WHICH rule refused it. Asserting only that a throw came back is satisfied by
  // any rule in the chain: with the loader's exactness rule deleted, the partial tally
  // falls through to the count rule below it (or to no rule at all) and this case stays
  // green while the projection silently drops the round. The message is the identity of
  // the rule, so the case pins the rule rather than a throw.
  assert(
    half?.message?.includes("must name exactly") === true,
    `G9: the partial tally is refused by the exactness rule, not incidentally by another one (${String(half?.message)})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
