#!/usr/bin/env bun
/**
 * #2042 — a bare identity is compared WHOLE, so a head-only failure cannot hide
 * behind a base failure whose name it shares.
 *
 * The runner puts ` - ` between a test name and the text it printed on failure
 * (`not ok 1 - checkout - expected 3 got 4`). Cutting an identity at the FIRST
 * ` - ` collapses two different assertions onto one name, and a failure only this
 * run authored is then excused as pre-existing — the one thing this feature must
 * never do. pytest keeps its ` - reason` strip because its identity is the
 * `path::name` printed before that reason, so no cut lands inside the name.
 *
 * Two assertions, one per direction of the risk:
 *
 *   (reason) a head run carrying one TAP failure the base never named is REFUSED,
 *     and the same head failure the base did name is still excused
 *   (round-trip) a name that itself contains ` - ` survives `baseStreamOf` →
 *     `testIdentitiesOf` unchanged, which is how `ci` reuses `verify`'s base set
 */
import {
  baselineExcuse,
  baseStreamOf,
  testIdentitiesOf,
} from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC8b-baseline-excuse-tap-reason.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const namesOf = (stream: string): string[] => testIdentitiesOf(stream).map((i) => i.name);

// ------------------------------- (reason) a head-only TAP failure is never excused
{
  const RED: BaseProbe = { status: "red" };
  /** The two sides of one comparison, in two trees that are definitely different. */
  const excuseOf = (headLines: string[], baseLines: string[]) =>
    baselineExcuse({
      tierName: "fast",
      cmd: "prove -r t",
      baseSha: "a".repeat(40),
      probe: RED,
      headStream: headLines.join("\n"),
      baseStream: baseLines.join("\n"),
      headRoot: "/tmp/pi-rukas-2042-tap/worktree",
      probeRoot: "/tmp/pi-rukas-2042-tap/repo.baseline-lean-verify-9",
    });
  const COMMON = "not ok 1 - checkout - expected 3 got 4";
  const refused = excuseOf([COMMON, "not ok 2 - checkout - other assertion"], [COMMON]);
  assert(
    refused.kind === "refused",
    `(reason) a head failure the base never named refuses the excuse (${refused.kind})`,
  );
  const excused = excuseOf([COMMON], [COMMON]);
  assert(
    excused.kind === "excused",
    `(reason) the same head failure the base did name is still excused (${excused.kind})`,
  );
}

// --------------------------- (round-trip) a name containing " - " survives rebuild
{
  const REASONED = "not ok 3 - checkout renders the total - expected 3 got 4";
  assert(
    namesOf(REASONED).join() === "checkout renders the total - expected 3 got 4",
    `(round-trip) the trailing reason stays part of the bare identity (${JSON.stringify(namesOf(REASONED))})`,
  );
  const withDash = ["checkout - expected 3", "TestRetryBackoff - context deadline exceeded"];
  assert(
    namesOf(baseStreamOf(withDash)).join() === withDash.join(),
    `(round-trip) every name survives baseStreamOf unchanged (${JSON.stringify(namesOf(baseStreamOf(withDash)))})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
