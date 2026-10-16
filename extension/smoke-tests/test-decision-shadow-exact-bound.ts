#!/usr/bin/env bun
/**
 * The exact-rule-match path is BOUNDED, not throttled (#1393).
 *
 * A skip record is throttled per seam per window: it describes a call that was
 * not made, and a burst of skips is one event. An exact-rule-match record is a
 * DECISION the rule made, and `shadowExactRuleMatch` fires it from the kill-
 * cause classifier — so a storm (a driver tearing down 500 dispatches at once)
 * used to mean 500 concurrent `appendDecisionRecord` calls, each doing its own
 * `realpath`/`stat`/`mkdir` chain under a lock. Throttling it was the wrong
 * instrument: suppressing records because OTHER decisions happened nearby would
 * erase the very sample S5 reads to compare the rule against the model.
 *
 * So the path is bounded by an in-flight counter instead, and past the cap a
 * write is DROPPED AND TRACED. Three claims, in order:
 *
 *   1. a burst larger than the cap does not become that many concurrent writes;
 *   2. the saturation is VISIBLE (a trace line names the count dropped);
 *   3. the records that were written are the ones a reader can use — exact
 *      records carry `exactRuleMatch` AND `reason`, and are never `skipped`.
 *
 * Concurrency is driven by the append itself rather than by a fake clock: the
 * whole point is the shape a synchronous fan-out produces, so the calls are made
 * in one tight loop and only then awaited.
 *
 * Offline: writes go to a temp dir, no model is configured or consulted.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { SeamId, SeamSpec } from "../src/decision-seam-registry.ts";
import { SEAMS } from "../src/decision-seam-registry.ts";
import {
  SKIP_WINDOW_MS,
  __exactInFlightForTests,
  __resetShadowForTests,
  __setSkipClockForTests,
  shadowExactRuleMatch,
} from "../src/decision-shadow.ts";
import { makeAssert, records, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

/** A tests-only seam: exact matches need a real registry entry to bound against. */
const seam = "fixture-exact-storm" as SeamId;
(SEAMS as Record<string, SeamSpec>)[seam] = {
  id: seam,
  kind: "classification",
  instructions: "What caused the failure?",
  labels: { transient: "worth waiting out", fatal: "waiting will not help" },
  ruleDefault: "fatal",
  passing: ["transient"],
  composition: "advisory",
  defaultMode: "shadow",
  evidence: "none",
  owner: "test-decision-shadow-exact-bound.ts",
  timeoutMs: 1_000,
  tokenBudget: 4_000,
  fields: { cause: { max: 400 } },
};

// Saturation must be visible to an OPERATOR, and `trace.ts` writes WARN lines
// straight to stderr (`process.stderr.write`), which is the channel an operator
// actually reads. Hooking that rather than `console.warn` is hooking the real
// sink: a `console.warn` override would have caught nothing, and an assertion
// written against the wrong sink reads as "no warnings" — indistinguishable from
// the feature being broken.
const warnings: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
  const line = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  if (line.includes("exact-match record dropped")) warnings.push(line.trim());
  else realWrite(chunk as never, ...(rest as []));
  return true;
}) as typeof process.stderr.write;

try {
  const root = tmpDir("exact-bound");
  const log = path.join(root, ".pi", "decisions.jsonl");
  __resetShadowForTests({ inFlight: true, exact: true });

  // The storm: 3 x the cap, fired synchronously. Each call awaits its own
  // append, so every one of them is "in flight" at the moment the next is made
  // — which is precisely the shape the counter exists to bound.
  const STORM = 96;
  const inflightPeaks: number[] = [];
  const pending: Promise<undefined>[] = [];
  for (let i = 0; i < STORM; i++) {
    pending.push(
      shadowExactRuleMatch(
        seam,
        { question: `kill ${i}`, rule: "fatal" },
        { repoRoot: root },
        {
          cause: `provider terminated the stream at attempt ${i}`,
        },
      ),
    );
    inflightPeaks.push(__exactInFlightForTests());
  }
  const peak = Math.max(...inflightPeaks);
  await Promise.all(pending);

  assert(
    peak <= 32,
    `the in-flight counter never exceeded the cap during a ${STORM}-call synchronous storm (peak ${peak})`,
  );
  assert(
    __exactInFlightForTests() === 0,
    `every acquired slot was released once the appends settled (${__exactInFlightForTests()})`,
  );
  assert(
    warnings.length > 0,
    `saturation is VISIBLE, not silent: ${warnings.length} trace line(s) named the dropped writes`,
  );

  const recs = records(log);
  assert(
    recs.length > 0 && recs.length <= 32,
    `the log holds at most the cap's worth of records, not the storm's (${recs.length})`,
  );
  assert(
    recs.every(
      (r) => r.exactRuleMatch === true && typeof r.reason === "string" && r.skipped === undefined,
    ),
    "an exact record is a DECISION: it carries `exactRuleMatch` AND its `reason`, and is never `skipped`",
  );
  // The state was bounded by the registry entry, not handed through raw.
  assert(
    recs.every((r) => typeof (r.state as { cause?: unknown } | undefined)?.cause === "string"),
    "the caller's `state` reached the record through the seam's own field bound",
  );

  // The counter is reusable: after the storm drains, the next decision writes.
  const before = records(log).length;
  await shadowExactRuleMatch(
    seam,
    { question: "after", rule: "fatal" },
    { repoRoot: root },
    {
      cause: "one more",
    },
  );
  assert(
    records(log).length === before + 1,
    `once the storm drains the path works again (${before} -> ${records(log).length})`,
  );

  // Raw-line check: the file is what S5 parses, so assert on the bytes too.
  const raw = readFileSync(log, "utf8");
  assert(
    raw
      .split("\n")
      .filter(Boolean)
      .every((l) => l.includes('"exactRuleMatch":true')),
    "every line in the file is an exact-match record (no skip-shaped line mixed in)",
  );

  // ------------------------------------------------------------------ clock
  //
  // The cap is bounded by SETTLEMENT, never by the clock (#1393).
  //
  // The exact path used to call `exactWindowOpen(now)` before checking the cap,
  // which zeroed `exactInFlight` once the throttle's clock rolled past
  // `SKIP_WINDOW_MS` — while appends from before the tick were still in flight.
  // Those then decremented a counter that had been reset to 0, so it went
  // negative and admitted a second full window's worth of concurrent writes on
  // top of the first: the 32 cap was a suggestion the clock could cancel.
  //
  // Driven with a fake clock because the whole point is a tick that lands WHILE
  // the writes are outstanding; a real 60-second wait would only prove nothing
  // had timed out. Acquire to the cap, advance past the skip window, and the
  // counter must still read the cap — nothing released, nothing subtracted.
  __resetShadowForTests({ inFlight: true, exact: true });
  let clock = 1_000;
  const restoreClock = __setSkipClockForTests(() => clock);
  try {
    const held: Promise<undefined>[] = [];
    for (let i = 0; i < 32; i++) {
      held.push(
        shadowExactRuleMatch(
          seam,
          { question: `held ${i}`, rule: "fatal" },
          { repoRoot: root },
          { cause: `held write ${i}` },
        ),
      );
    }
    const atCap = __exactInFlightForTests();
    clock += SKIP_WINDOW_MS * 3;
    assert(
      __exactInFlightForTests() === atCap && atCap === 32,
      `advancing the clock past SKIP_WINDOW_MS does not drop the in-flight counter while appends are unsettled (${atCap} -> ${__exactInFlightForTests()})`,
    );
    // And the cap still bites after the tick: the 33rd write is refused, not
    // admitted by a counter the clock silently reset.
    const overflow = await shadowExactRuleMatch(
      seam,
      { question: "overflow", rule: "fatal" },
      { repoRoot: root },
      { cause: "past the cap, after a clock tick" },
    );
    assert(
      overflow === undefined && __exactInFlightForTests() === atCap,
      `the cap still refuses past a clock tick rather than counting from a reset (${__exactInFlightForTests()})`,
    );
    await Promise.all(held);
    assert(
      __exactInFlightForTests() === 0,
      `settlement, not the clock, is what releases the slots (${__exactInFlightForTests()})`,
    );
  } finally {
    restoreClock();
  }
} finally {
  process.stderr.write = realWrite;
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
