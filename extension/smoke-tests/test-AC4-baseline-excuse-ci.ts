#!/usr/bin/env bun
/**
 * #2042 AC4 — `ci`'s red FULL tier is excused over the base commit too, and it
 * does not pay twice for a proof `verify` already made.
 *
 * `ci` grades mergeability on the forge's rows plus the project's full tier. When
 * that tier exits non-zero the question is the same one `verify` already answered
 * for its own tiers, so `ci` may reuse `verify`'s record — but the record is a
 * claim that licenses a GREEN, and reuse is narrow (see `lean/ci-excuse.ts`):
 *
 *   (record-not-reused) the newest DECIDED verify is green, certified this head, and
 *     carries a byte-identical command with a `baseNames` set — and `ci` STILL runs its
 *     OWN probe: TWO tier runs, one of them in the throwaway base checkout, and the
 *     excuse granted only on what THAT probe printed. A recorded base set is no longer
 *     evidence `ci` may compare against.
 *   (probe-refuses) the same reusable record, with the probe's tier red on OTHER tests
 *     -> the run stays red, because the record buys `ci` nothing
 *   (no-record) no record at all -> the same probe path, and the same verdict
 *
 * The probe path is exercised here rather than in `test-AC5` because it shares this
 * recorder; `test-AC5` covers the probe's own edge shapes.
 *
 * Everything is offline: the forge is a recorder answering the pinned argv and the
 * tier is an `sh` command the recorder runs.
 */
import { withEnv } from "./lib/env-scope.ts";
import { cleanUp, run } from "./lib/lean-ci-recorder.ts";
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";

const SELF = "test-AC4-baseline-excuse-ci.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const NAMES = [
  "FAILED tests/x_test.py::test_a - Assert",
  "FAILED tests/x_test.py::test_b - Assert",
];
/** The tier's own red output: its failing lines verbatim, so the excuse has lines to read. */
const TIER_STREAM = NAMES.join("\n");
const FULL = "sh -c 'pytest'";
/** The run's frozen contract: one test file, committed for the re-probe cases. */
const FROZEN_FILE = "tests/AC1-retry.test.sh";
const FROZEN_BYTES = "#!/bin/sh\nexit 0\n";
/** The base's copy: real bytes, and NOT the ones the run froze — the base's own copy
 *  of this contract does not satisfy what the run is held to. */
const BASE_BYTES = "#!/bin/sh\nexit 1\n";

/**
 * A verify record of the shape a PRE-#2100 step log carries — the current writer never
 * persists `baseNames`, and nothing reads it, so this fixture is the resumed-run case.
 */
function recordFor(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    cmd: FULL,
    names: NAMES,
    total: NAMES.length,
    baseSha: "b".repeat(40),
    baseNames: NAMES,
    ...over,
  };
}

/** The full tier's red, with its own stream, from the recorder. */
const tierRed = {
  tierExit: 1,
  tierStdout: TIER_STREAM,
} as const;

function rec(r: Awaited<ReturnType<typeof run>>): Record<string, PreexistingTierRecord> | undefined {
  return (r.outcome as { preexistingFailures?: Record<string, PreexistingTierRecord> } | undefined)
    ?.preexistingFailures;
}

// The re-probe cases' frozen contract: the base holds its own copy of the file and
// the run's head rewrites it, which is the probe's `red`. Without it the probe answers
// `carries-nothing` and never runs the tier, which is a different refusal.
const PROBE = {
  frozenBytes: { path: FROZEN_FILE, bytes: FROZEN_BYTES, baseBytes: BASE_BYTES },
} as const;

// ------------------------------------------------------- (record-not-reused)
{
  const r = await run({
    full: FULL,
    ...tierRed,
    ...PROBE,
    reuseRecord: recordFor(),
    // The base's output is supplied ONLY through the probe, so a reuse replay would
    // grade this green off the record and never run the tier at the base.
    baseTierOutput: TIER_STREAM,
  });
  assert(
    r.outcome?.kind === "green",
    `(record-not-reused) ci excuses on its own probe's output (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("pre-existing"),
    `(record-not-reused) the green discloses the excuse rather than claiming a clean tier (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert(
    rec(r)?.["full"]?.names.join(",") === NAMES.join(","),
    `(record-not-reused) the record carries the tier's names (${JSON.stringify(rec(r)?.["full"])})`,
  );
  assert(
    r.cmds.filter((c) => c === FULL).length === 2,
    `(record-not-reused) a reusable record buys no tier run: HEAD and the base probe both ran (${String(r.cmds.filter((c) => c === FULL).length)})`,
  );
  assert(
    (r.tierRuns ?? 0) === 2,
    `(record-not-reused) the tier ran again inside the throwaway checkout (${String(r.tierRuns)})`,
  );
}

// --------------------------------------------------------- (probe-refuses)
{
  const r = await run({
    full: FULL,
    ...tierRed,
    ...PROBE,
    reuseRecord: recordFor(),
    // The base is red on OTHER tests: a colour, not an excuse — and the record that
    // names the head's own failures may not stand in for what the probe printed.
    baseTierOutput: "FAILED tests/z.py::other - Assert",
  });
  assert(
    r.outcome?.kind === "red",
    `(probe-refuses) a byte-identical, head-matching, baseNames-bearing record still hands the run back (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(rec(r) === undefined, "(probe-refuses) no excuse recorded");
  assert(
    r.cmds.filter((c) => c === FULL).length === 2,
    `(probe-refuses) and it paid the probe to find out (${String(r.cmds.filter((c) => c === FULL).length)})`,
  );
}

// -------------------------------------------------------------- (moved-head)
{
  const r = await run({
    full: FULL,
    ...tierRed,
    ...PROBE,
    reuseRecord: recordFor(),
    // Nothing about a verify verdict may be reused for a head ci is not judging; the
    // case keeps the shape so the probe path is exercised from a stale-certified log too.
    verifiedHead: "d".repeat(40),
    worktreeHead: "other",
  });
  assert(
    r.outcome?.kind === "red",
    `(moved-head) a record about another head excuses nothing (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(rec(r) === undefined, "(moved-head) no excuse recorded");
}

// -------------------------------------------------------- (different-command)
{
  const r = await run({
    full: FULL,
    ...tierRed,
    // Byte-identical is the rule: a tier that differs by a flag is a different gate.
    ...PROBE,
    // No base output: a record for another command must NOT be replaced by a fresh
    // probe, so the probe's tier really exits 0 and the excuse has no colour to read.
    reuseRecord: recordFor({ cmd: `${FULL} --watch` }),
    // The probe's tier exits 1 and prints a marker the head run never printed: the
    // base is red on OTHER tests, which is a colour but not an excuse.
    baseTierOutput: "FAILED tests/z.py::other - Assert",
  });
  assert(
    r.outcome?.kind === "red",
    `(different-command) a record for another command excuses nothing (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(rec(r) === undefined, "(different-command) no excuse recorded");
}

// ----------------------------------------------------------------- (no-record)
{
  const r = await run({
    full: FULL,
    ...tierRed,
    baseTierOutput: TIER_STREAM,
    ...PROBE,
  });
  assert(
    r.outcome?.kind === "green",
    `(no-record) with nothing to reuse ci probes the base itself and excuses on a real match (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(rec(r) !== undefined, "(no-record) and the fresh probe's proof is recorded");
  assert(
    r.cmds.filter((c) => c === FULL).length === 2,
    `(no-record) the tier ran at HEAD and once more at the base (${String(r.cmds.filter((c) => c === FULL).length)})`,
  );
  assert(
    (r.tierRuns ?? 0) === 2,
    `(no-record) the tier ran again inside that checkout (${String(r.tierRuns)})`,
  );
}

// ---------------------------------------------- (no-record, base-names-other)
{
  const r = await run({
    full: FULL,
    ...tierRed,
    baseTierOutput: "FAILED tests/z.py::other - Assert",
    ...PROBE,
  });
  assert(
    r.outcome?.kind === "red",
    `(no-record, base-names-other) a base that failed other tests keeps the red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(rec(r) === undefined, "(no-record, base-names-other) no excuse recorded");
  assert(
    r.cmds.filter((c) => c === FULL).length === 2,
    "(no-record, base-names-other) it still paid the probe, and still landed red",
  );
}

// ------------------------------------------------- (roster-passed, label spelling)
{
  // The base prints the same lines, so the line rule alone excuses — but verify's roster saw the
  // first name PASS, and the roster outranks a line match in ci as it does in verify. Here the roster
  // label IS the failure line, the one spelling the label rule can meet.
  const r = await run({
    full: FULL,
    ...tierRed,
    baseTierOutput: TIER_STREAM,
    ...PROBE,
    verifyRoster: {
      baseSha: "b".repeat(40),
      files: ["tests/x_test.py"],
      passed: [NAMES[0] as string],
      failed: [],
      baseFailed: [],
      total: 1,
      baseTotal: 0,
      baseSkipped: true,
    },
  });
  assert(
    r.outcome?.kind === "red" && rec(r) === undefined,
    `(roster-passed) a failing name the verify roster saw passing is not excused (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
}

// --------------------------------------------- (roster-passed, sibling spelling)
{
  // The bench shape, end to end. A pytest project's tier fails `tests/x_test.py::test_b`; the base
  // printed the SAME line, so the whole-line excuse is ready to call the tier green. But verify's own
  // base roster passed every test of that file and never named `test_b` failing — so by the location
  // rule (`tests.x_test::test_b` shares its module path with the passing `tests.x_test::test_a`) the
  // roster owns the judgement and the run stays red. Under the switch's `0` arm the roster sees no
  // match in the label spelling and the line rule excuses, which is the behaviour that landed a broken
  // pass-to-pass test.
  const SIBLING = "FAILED tests/x_test.py::test_b - Assert";
  const rosterSeenPassing = {
    baseSha: "b".repeat(40),
    files: ["tests/x_test.py"],
    // pytest's report labels the passing test in its own spelling, which is never the tier's line.
    passed: ["tests.x_test::test_a"],
    failed: [],
    baseFailed: [],
    total: 1,
    baseTotal: 1,
  };
  const armed = {
    full: FULL,
    tierExit: 1,
    tierStdout: SIBLING,
    baseTierOutput: SIBLING,
    ...PROBE,
    verifyRoster: rosterSeenPassing,
  };
  const r = await run(armed);
  assert(
    r.outcome?.kind === "red" && rec(r) === undefined,
    `(sibling) a tier line for a test of a file the roster watched pass is not excused (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  let off!: Awaited<ReturnType<typeof run>>;
  await withEnv({ PI_ENSEMBLE_LEAN_ROSTER_TIER_LOCATION: "0" }, async () => {
    off = await run(armed);
  });
  assert(
    off.outcome?.kind === "green" && rec(off) !== undefined,
    `(sibling, off) the label-only arm excuses the same tier as before the location rule (got ${off.outcome?.kind ?? `threw: ${off.threw?.message}`})`,
  );
}

cleanUp();
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
