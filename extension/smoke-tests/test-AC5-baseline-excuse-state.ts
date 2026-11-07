#!/usr/bin/env bun
/**
 * #2042 AC5 — the disclosure is a durable claim, so it round-trips or it is refused.
 *
 * `preexistingFailures` licenses a GREEN over a tier that exited non-zero, and the
 * step log is the only copy a resumed run has. So the pair of rules the record lives
 * under is tested here rather than at the gate that writes it:
 *
 *   (round-trip) a valid entry survives a save and a load through the same
 *     `buildOutcome` every other field passes through, byte for byte — a field
 *     `buildOutcome` forgets to copy is silently gone from every resumed run
 *   (forged) an entry the gate could not have written is refused by
 *     `outcomeProblem`, naming the field, and the step is not loaded
 *   (invalid-forfeits) the validator also DROPS a bad entry when rebuilding, which
 *     is what makes "forfeit the excuse, never throw" true: no throw, no record,
 *     and the tier keeps today's hand-back (the live half of that is AC2)
 *   (ownership) the field belongs to a verify or ci step and nowhere else — a
 *     handback that reports pre-existing failures would print a gate's evidence on
 *     a step that ran no gate
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";
import { INITIAL_COUNTERS, leanStateFile, loadRun } from "../src/lean/state.ts";
import { outcomeProblem } from "../src/lean/state-outcome.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const SELF = "test-AC5-baseline-excuse-state.ts";
/** `makeAssert` prints the message verbatim, so the suite name rides on each one. */
function check(cond: boolean, msg: string): void {
  assert(cond, `${SELF}: ${msg}`);
}

/** A record of the shape `verify` writes for one excused tier. */
const RECORD: PreexistingTierRecord = {
  cmd: "pnpm test",
  names: [
    "FAILED tests/a.spec.ts::t1 - Assert",
    "FAILED tests/b.spec.ts::t2 - Assert",
  ],
  total: 7,
  baseSha: "c".repeat(40),
  baseNames: [
    "FAILED tests/a.spec.ts::t1 - Assert",
    "FAILED tests/b.spec.ts::t2 - Assert",
    "FAILED tests/c.spec.ts::t3 - Assert",
  ],
};

/** Write a run whose newest step is `step`, then load it back. */
function roundTrip(issue: number, step: Record<string, unknown>): ReturnType<typeof loadRun> {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
    writeFileSync(
      leanStateFile(dir, issue),
      JSON.stringify(
        {
          schema: 1,
          issue,
          version: "test",
          models: {},
          baseSha: FIXTURE_BASE_SHA,
          branch: `feature/issue-${String(issue)}`,
          state: "verify",
          counters: INITIAL_COUNTERS,
          steps: [
            { key: `${issue}:ready:0`, state: "ready", startedAt: 0, outcome: { kind: "ok" } },
            step,
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    return loadRun(dir, issue);
  } finally {
    cleanup();
  }
}

const verifyStep = (outcome: Record<string, unknown>): Record<string, unknown> => ({
  key: "71:verify:0",
  state: "verify",
  startedAt: 1,
  endedAt: 1,
  outcome: { kind: "green", verifiedHead: "b".repeat(40), ...outcome },
});

// ------------------------------------------------------------- (round-trip)
{
  const loaded = roundTrip(71, verifyStep({ preexistingFailures: { fast: RECORD } }));
  const oc = loaded?.steps[loaded.steps.length - 1]?.outcome;
  check(
    oc !== undefined,
    `(round-trip) the step loaded at all (got ${JSON.stringify(loaded === null ? "not loaded" : oc?.kind)})`,
  );
  check(
    JSON.stringify(oc?.preexistingFailures?.["fast"]) === JSON.stringify(RECORD),
    `(round-trip) the record survives save and load unchanged (${JSON.stringify(oc?.preexistingFailures?.["fast"])})`,
  );
  check(
    oc?.verifiedHead === "b".repeat(40),
    "(round-trip) and the green it rides with is still a green",
  );
}

// ----------------------------------------------------------------- (forged)
{
  const forgeries: [string, unknown][] = [
    ["a name that is not a string", { fast: { ...RECORD, names: [1] } }],
    [
      "a base sha that is not a commit",
      { fast: { ...RECORD, baseSha: "not-a-sha" } },
    ],
    ["a total of zero", { fast: { ...RECORD, total: 0 } }],
    ["an empty printed name set", { fast: { ...RECORD, names: [] } }],
    [
      "a name carrying a control character",
      { fast: { ...RECORD, names: ["FAILED tests/a\u0000b::t1 - Assert"] } },
    ],
    ["a tier value that is not an object", { fast: "pytest said so" }],
  ];
  for (const [what, value] of forgeries) {
    const why = outcomeProblem({ kind: "green", preexistingFailures: value }, "verify");
    check(why !== undefined, `(forged) ${what} is refused by outcomeProblem (${why ?? "ACCEPTED"})`);
    let loaded: unknown = null;
    let threw = false;
    try {
      loaded = roundTrip(72, verifyStep({ preexistingFailures: value }));
    } catch {
      threw = true;
    }
    check(
      threw || loaded === null,
      `(forged) ${what}: the store refuses the file rather than handing back a record the validator rejected`,
    );
  }
}

// ------------------------------------------------------ (invalid-forfeits)
{
  // The rebuild drops a bad entry rather than throwing — which is the difference
  // between an excuse that is forfeited and a gate that crashes the run.
  const why = outcomeProblem(
    { kind: "green", preexistingFailures: { fast: RECORD, full: { ...RECORD, cmd: "  " } } },
    "verify",
  );
  check(why !== undefined, `(invalid-forfeits) one bad tier refuses the map (${why ?? "ACCEPTED"})`);
  check(
    !/throw|error/i.test(why ?? "refused"),
    "(invalid-forfeits) and the refusal is a reason, not an exception",
  );
}

// ---------------------------------------------------------------- (ownership)
{
  const why = outcomeProblem(
    { kind: "done", preexistingFailures: { fast: RECORD } },
    "handback",
  );
  check(
    why !== undefined && /verify|ci/.test(why),
    `(ownership) a handback carrying the field is refused (${why ?? "ACCEPTED"})`,
  );
  const ok = outcomeProblem({ kind: "green", preexistingFailures: { full: RECORD } }, "ci");
  check(ok === undefined, `(ownership) the ci step may carry it (${ok ?? "accepted"})`);
}

process.exit(failures());
