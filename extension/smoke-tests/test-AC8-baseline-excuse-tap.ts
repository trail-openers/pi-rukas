#!/usr/bin/env bun
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";
/**
 * #2042 — a TAP-only or go-only pair is REFUSED, not excused.
 *
 * Earlier rounds of this feature tried to read identities from TAP (`not ok 1 - …`)
 * and go (`--- FAIL: TestX`) lines. Three reviews each found a new way for such a
 * parser to fold two different checks onto one token — cutting at the runner's
 * ` - ` merged `checkout - expected 3 got 4` with `checkout - other assertion`, and
 * an optional test-number group merged `not ok 1 - 1 - boom` with
 * `not ok 2 - 1 - boom` — and a folded name excuses a failure only this run
 * authored. So the excuse reads pytest's `path::name` identities and nothing else:
 * a non-pytest identity anywhere in either stream refuses it, and today's red
 * stands. (Both pairs below WOULD have been excused under the old parsers, which is
 * why they are the cases.)
 *
 * The pytest pair stays green, and it also pins the `ci` reuse round-trip: the
 * recorded base set rebuilds through `baseStreamOf` and reads back through the
 * SAME parser a fresh probe would have used (`testIdentitiesOf`), which is what
 * lets `ci` excuse on one tier run and no base probe.
 */
import {
  baseStreamOf,
  baselineExcuse,
  testIdentitiesOf,
} from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";
import { cleanUp, run } from "./lib/lean-ci-recorder.ts";

const SELF = "test-AC8-baseline-excuse-tap.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };

/** Two trees that are definitely different directories. */
const HEAD_ROOT = "/tmp/pi-rukas-2042-tap/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2042-tap/repo.baseline-lean-verify-9";

/** One comparison, on the lines each run printed. */
function excuseOf(headLines: string[], baseLines: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'prove -r t'",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

const namesOf = (stream: string): string[] => testIdentitiesOf(stream).map((i) => i.name);

// ----------------------------------------------------- (tap) head-only TAP pair
{
  // Identical on both sides — the shape that earned an excuse when TAP was parsed.
  const COMMON = "not ok 1 - checkout - expected 3 got 4";
  const r = excuseOf([COMMON], [COMMON]);
  assert(
    r.kind === "refused",
    `(tap) a TAP-only pair that used to excuse is now refused (${r.kind})`,
  );
  assert(
    namesOf(COMMON).length === 0,
    `(tap) and no TAP token is read as an identity at all (${JSON.stringify(namesOf(COMMON))})`,
  );
}
// --------------------------------------------------------- (go) head-only pair
{
  const GO = ["--- FAIL: TestRetryBackoff (0.31s)", "--- FAIL: TestVerifyGate (0.02s)"];
  const r = excuseOf(GO, GO);
  assert(
    r.kind === "refused",
    `(go) a go-only pair that used to excuse is now refused (${r.kind})`,
  );
  assert(
    namesOf(GO.join("\n")).length === 0,
    `(go) and no go name is read as an identity (${JSON.stringify(namesOf(GO.join("\n")))})`,
  );
}

// ------------------------------------- (mixed) a pytest pair poisoned by one line
{
  const PY = "FAILED tests/x_test.py::test_a - AssertionError";
  assert(excuseOf([PY], [PY]).kind === "excused", "(mixed) the pytest pair alone still excuses");
  assert(
    excuseOf([PY, "not ok 1 - a bats check"], [PY]).kind === "refused",
    "(mixed) one TAP line in the HEAD stream refuses the whole excuse",
  );
  assert(
    excuseOf([PY], [PY, "--- FAIL: TestSolo (0.01s)"]).kind === "refused",
    "(mixed) one go line in the BASE stream refuses it too",
  );
}

// ------------------------------------- (ci reuse) pytest names round-trip whole
{
  const NAMES = ["tests/x_test.py::test_a", "tests/x_test.py::test_b"];
  const rebuilt = baseStreamOf(NAMES);
  assert(
    !rebuilt.includes("not ok"),
    `(ci reuse) a recorded name is rebuilt as a pytest line, never a TAP one (${JSON.stringify(rebuilt.split("\n")[0])})`,
  );
  assert(
    namesOf(rebuilt).join("\n") === NAMES.join("\n"),
    `(ci reuse) every name survives baseStreamOf -> testIdentitiesOf unchanged (${JSON.stringify(namesOf(rebuilt))})`,
  );

  const FULL = "sh -c 'pytest'";
  const record: PreexistingTierRecord = {
    cmd: FULL,
    names: NAMES,
    total: NAMES.length,
    baseSha: "b".repeat(40),
    baseNames: NAMES,
  };
  const r = await run({
    full: FULL,
    tierExit: 1,
    tierStdout: NAMES.map((n) => `FAILED ${n} - Assert`).join("\n"),
    frozenBytes: {
      path: "tests/AC1-retry.test.sh",
      bytes: "#!/bin/sh\nexit 0\n",
      baseBytes: "#!/bin/sh\nexit 1\n",
    },
    reuseRecord: record,
  });
  assert(
    r.outcome?.kind === "green",
    `(ci reuse) the recorded pytest set excuses ci's red full tier (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(
    r.cmds.filter((c) => c === FULL).length === 1,
    `(ci reuse) ONE tier run at HEAD (${String(r.cmds.filter((c) => c === FULL).length)})`,
  );
  assert(
    (r.tierRuns ?? 0) === 1 && !r.cmds.some((c) => c.includes(".baseline-lean-verify-")),
    `(ci reuse) and no base probe ran (${String(r.tierRuns)})`,
  );
}

cleanUp();
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
