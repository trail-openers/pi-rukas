#!/usr/bin/env bun
/**
 * #2042 — the recorded base set must ROUND-TRIP through `baseStreamOf`.
 *
 * `ci` reuses `verify`'s base-name set instead of paying for its own probe, and it
 * does so by rebuilding a stream and reading it back through the SAME parser a fresh
 * probe would have used (`testIdentitiesOf`). A token that does not survive that
 * round-trip makes reuse silently never match, and `ci` pays a probe it was promised
 * it would not — worst for the runner whose names are bare (go, TAP), because those
 * are the ones emitted as TAP lines.
 *
 * Two shapes, both real output:
 *
 *   (tap)    a bare identity — a TAP description or a go name — written as
 *            `not ok 1 - <name>` must read back as `<name>`, and numbered and
 *            unnumbered TAP lines must yield the SAME token
 *   (go)     a head run whose every `--- FAIL: TestX` the recorded base set carries
 *            is graded green by `ci` on ONE tier run, with no base probe at all
 */
import { baseStreamOf, testIdentitiesOf } from "../src/lean/verify-baseline-excuse.ts";
import { cleanUp, run } from "./lib/lean-ci-recorder.ts";
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";

const SELF = "test-AC8-baseline-excuse-tap.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const namesOf = (stream: string): string[] => testIdentitiesOf(stream).map((i) => i.name);

// ------------------------------------------------ (tap) a bare name round-trips
{
  const names = ["checkout renders the total", "TestRetryBackoff"];
  const rebuilt = baseStreamOf(names);
  assert(
    !rebuilt.includes("not ok - "),
    `(tap) the emitted line carries a number, not a bare "not ok - " (${JSON.stringify(rebuilt.split("\n")[0])})`,
  );
  assert(
    namesOf(rebuilt).join("\n") === names.join("\n"),
    `(tap) every bare name survives the stream round-trip (${JSON.stringify(namesOf(rebuilt))})`,
  );
  const numbered = namesOf("not ok 7 - checkout renders the total");
  const unnumbered = namesOf("not ok - checkout renders the total");
  assert(
    numbered.join() === unnumbered.join() && numbered[0] === "checkout renders the total",
    `(tap) numbered and unnumbered TAP lines yield the same token (${JSON.stringify(numbered)} vs ${JSON.stringify(unnumbered)})`,
  );
  // The tail a TAP harness prints beside the description is still not the name.
  assert(
    namesOf("not ok 3 - checkout renders the total - expected 3 got 4").join() ===
      "checkout renders the total",
    "(tap) the trailing reason is still stripped from a numbered line",
  );
}

// --------------------------------------------------------- (go) ci reuses on go
const GO_NAMES = ["TestRetryBackoff", "TestVerifyGate"];
const FULL = "sh -c 'go test ./...'";
/** go's own red: `--- FAIL: TestX` lines, which is what a go head run prints. */
const GO_HEAD = GO_NAMES.map((n) => `--- FAIL: ${n}`).join("\n") + "\nFAIL\n";
/** The run's frozen contract, committed at the base and rewritten at HEAD. */
const PROBE = {
  frozenBytes: {
    path: "tests/AC1-retry.test.sh",
    bytes: "#!/bin/sh\nexit 0\n",
    baseBytes: "#!/bin/sh\nexit 1\n",
  },
} as const;

/** The record `verify` writes for an excused tier, keyed `full` by the recorder. */
const record: PreexistingTierRecord = {
  cmd: FULL,
  names: GO_NAMES,
  total: GO_NAMES.length,
  baseSha: "b".repeat(40),
  baseNames: GO_NAMES,
};

{
  const r = await run({ full: FULL, tierExit: 1, tierStdout: GO_HEAD, ...PROBE, reuseRecord: record });
  assert(
    r.outcome?.kind === "green",
    `(go) a head run whose names the recorded base carries is graded green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(
    r.cmds.filter((c) => c === FULL).length === 1,
    `(go) ONE tier run at HEAD (${String(r.cmds.filter((c) => c === FULL).length)})`,
  );
  assert(
    (r.tierRuns ?? 0) === 1,
    `(go) and the tier never ran in a base checkout (${String(r.tierRuns)})`,
  );
  assert(
    !r.cmds.some((c) => c.includes(".baseline-lean-verify-")),
    "(go) no throwaway base checkout was created for ci's own probe",
  );
  assert(
    !r.cmds.some((c) => c.includes("worktree") && c.includes("add")),
    "(go) no base-probe command ran (git worktree add never asked for)",
  );
}

cleanUp();
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
