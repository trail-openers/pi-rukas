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
 *   (reuse) byte-identical command, newest DECIDED verify, green, and
 *     `verifiedHead` equal to the head `ci` judges -> green, ONE tier run at HEAD,
 *     and no base probe of `ci`'s own
 *   (moved-head) the certified head is not the head `ci` judges -> no reuse
 *   (different-command) the tier `ci` runs differs by a flag -> no reuse
 *   (no-record) no record at all -> `ci` probes the base itself and pays the extra
 *     tier run, excusing only when the base really printed the same names
 *
 * The probe path is exercised here rather than in `test-AC5` because it shares this
 * recorder; `test-AC5` covers the probe's own edge shapes.
 *
 * Everything is offline: the forge is a recorder answering the pinned argv and the
 * tier is an `sh` command the recorder runs.
 */
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

/** A verify record of the shape `verify` writes for an excused tier. */
function recordFor(over: Partial<PreexistingTierRecord> = {}): PreexistingTierRecord {
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

// ------------------------------------------------------------------ (reuse)
{
  const r = await run({ full: FULL, ...tierRed, ...PROBE, reuseRecord: recordFor() });
  assert(
    r.outcome?.kind === "green",
    `(reuse) a red full tier whose names the recorded base has -> green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("pre-existing"),
    `(reuse) the green discloses the excuse rather than claiming a clean tier (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert(
    rec(r)?.["full"]?.names.join(",") === NAMES.join(","),
    `(reuse) the record carries the tier's names (${JSON.stringify(rec(r)?.["full"])})`,
  );
  assert(
    r.cmds.filter((c) => c === FULL).length === 1,
    `(reuse) the full tier ran once at HEAD and never at the base (${String(r.cmds.filter((c) => c === FULL).length)})`,
  );
  assert(
    !r.cmds.some((c) => c.includes(".baseline-lean-verify-")),
    "(reuse) and ci paid for no throwaway base checkout of its own",
  );
}

// -------------------------------------------------------------- (moved-head)
{
  const r = await run({
    full: FULL,
    ...tierRed,
    ...PROBE,
    reuseRecord: recordFor(),
    // The verify step certified a head the PR does not carry: nothing about that
    // verdict may be reused for the head ci is judging.
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

// ------------------------------------------------- (base-names-nothing-record)
{
  const r = await run({
    full: FULL,
    ...tierRed,
    // A record whose base set was too large to persist is no evidence: comparing
    // against a partial set would excuse a failure ci never saw at base.
    reuseRecord: recordFor({ baseNames: undefined }),
    baseTierOutput: "FAILED tests/z.py::other - Assert",
  });
  assert(
    r.outcome?.kind === "red",
    `(base-names-nothing-record) an omitted base set is treated as no record (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(rec(r) === undefined, "(base-names-nothing-record) no excuse recorded");
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

cleanUp();
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
