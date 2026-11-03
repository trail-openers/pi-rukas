#!/usr/bin/env bun
/**
 * lean: `failure.cause` on a headless result (#1920 item 6).
 *
 * A host's retry ladder reads `issues[].failure.cause` and decides whether to
 * re-run a container. `work` fills it from `classifyFailureCause`, whose input is
 * the dispatch's kill. A lean step records the kill's CONSEQUENCE — its budget
 * trio, its `ok: false` row, the engine's error text — and no kill cause of its
 * own, so most lean failures have no cause to report and must get none: a cause
 * invented from a budget's `limit` string would send a host's ladder off a fact
 * the run never observed.
 *
 *   (1) a `minutes` ceiling whose child row reported `ok: false` is the one shape
 *       lean observed a kill of, and gets `work`'s own classification for it;
 *   (2) a `turns` ceiling stops a child at a turn boundary and is not a kill, so
 *       the failure is `timeout` with the trio named and NO cause;
 *   (3) a `minutes` ceiling whose every row says `ok` never observed a kill either
 *       — same answer, no cause;
 *   (4) the cause is read from the newest WORKING step only: a ceiling the run
 *       SURVIVED is older than the gate that later refused it, and the gate's red
 *       verdict is the failure, which has no cause of its own.
 *
 * Everything is driven through the verb's own document path (`driveLean`), so a
 * projection that stopped being reached would fail these rather than pass them.
 */

import { makeAssert } from "./headless-verb-harness.ts";
import { CHILDREN, driveLean, leanLog, stepWith } from "./lib/lean-result-fixture.ts";

const { assert, state } = makeAssert();

/** The arm every case puts on the record: a run armed and stopped by its ceiling. */
const ARMED = { deadlineMs: 1_700_000_000_000 };

{
  const breach = await driveLean(
    "handed-back",
    10,
    // The gate has to have refused the run for a `handed-back` document to carry a
    // failure at all: a breach alone hands back with nothing that failed.
    // No gate verdict: the only thing that stopped this run is the ceiling, and a
    // red gate anywhere later would honestly be the failure's cause instead.
    leanLog({ minutesBreach: true }),
    undefined,
    { deadlineMs: 1_700_000_000_000 },
  );
  const failure = breach.issue?.failure as Record<string, unknown> | undefined;
  assert(
    failure?.kind === "timeout",
    `(1) the minutes breach is still a timeout failure (got ${JSON.stringify(failure)})`,
  );
  assert(
    failure?.cause === "self-killed:child-bound",
    `(1) the killed child's row classifies it with work's own taxonomy (got ${JSON.stringify(failure?.cause)})`,
  );
  assert(
    breach.violations.length === 0,
    `(1) output contract on a caused failure (${breach.violations.join("; ")})`,
  );

  const survived = await driveLean(
    "handed-back",
    10,
    [
      stepWith("challenge", { kind: "budget", limit: "turns", value: 3, used: 99 }),
      stepWith("handback", { kind: "done", posted: true, reason: "handback comment posted" }),
    ],
    undefined,
    { deadlineMs: 1_700_000_000_000 },
  );
  const f2 = survived.issue?.failure as Record<string, unknown> | undefined;
  assert(
    f2?.kind === "timeout" && f2.cause === undefined,
    `(2) a turns ceiling is not a kill, so no cause is invented (got ${JSON.stringify(f2)})`,
  );

  const noKillRow = await driveLean(
    "handed-back",
    10,
    [
      stepWith("build", {
        kind: "budget",
        limit: "minutes",
        value: 15,
        used: 26,
        dispatches: CHILDREN,
      }),
      stepWith("handback", { kind: "done", posted: true, reason: "handback comment posted" }),
    ],
    undefined,
    { deadlineMs: 1_700_000_000_000 },
  );
  const f3 = noKillRow.issue?.failure as Record<string, unknown> | undefined;
  assert(
    f3?.kind === "timeout" && f3.cause === undefined,
    `(3) and a minutes breach whose rows all say ok gets no cause either — the run never observed a kill (got ${JSON.stringify(f3)})`,
  );
}

// ── (4) the newest working step is the only one the projection may blame.
{
  const survived = await driveLean(
    "handed-back",
    10,
    [
      stepWith("challenge", { kind: "budget", limit: "minutes", value: 3, used: 99 }),
      stepWith("verify", { kind: "red", reason: "acceptance test y is red" }),
      stepWith("handback", { kind: "done", posted: true, reason: "handback comment posted" }),
    ],
    undefined,
    ARMED,
  );
  const f4 = survived.issue?.failure as Record<string, unknown> | undefined;
  assert(
    f4?.kind === "verify" && f4.cause === undefined,
    `(4) a survived minutes ceiling is not the cause when a later red gate is (got ${JSON.stringify(f4)})`,
  );
}

// ── (5) a `blocked` build is a judgement, so the document carries a failure.
{
  // #1984: the builder proved the frozen tests cannot all pass together and the
  // driver re-ran them, so this is a verdict about the contract in the same
  // family as a red gate — not a step that ran out of rounds. Before `blocked`
  // was recognised here, a blocked run's host document carried NO `failure`
  // object at all, and the one cause a host could branch on was silent.
  const blocked = await driveLean(
    "handed-back",
    10,
    [
      stepWith("build", {
        kind: "blocked",
        reason: "frozen tests cannot all pass together: tests/a.test.ts — case 2 vs case 3",
        blockedBy: { "tests/a.test.ts": "case 2 needs the array mutable, case 3 mutates it" },
        dispatches: CHILDREN,
      }),
      stepWith("handback", { kind: "done", posted: true, reason: "handback comment posted" }),
    ],
    undefined,
    ARMED,
  );
  const f5 = blocked.issue?.failure as Record<string, unknown> | undefined;
  assert(
    f5 !== undefined,
    `(5) a blocked run's document carries a failure at all (got ${JSON.stringify(blocked.issue?.failure)})`,
  );
  assert(
    f5?.kind === "verify",
    `(5) a proved contract conflict reads like a gate verdict, not process (got ${JSON.stringify(f5)})`,
  );
  assert(
    typeof f5?.message === "string" && f5.message.includes("tests/a.test.ts"),
    `(5) and its message is the run's own cause sentence (got ${JSON.stringify(f5?.message)})`,
  );
  assert(
    blocked.violations.length === 0,
    `(5) output contract on a blocked failure (${blocked.violations.join("; ")})`,
  );
}

process.exit(state.exit);
