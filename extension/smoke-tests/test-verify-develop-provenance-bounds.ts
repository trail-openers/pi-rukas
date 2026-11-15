#!/usr/bin/env bun
/**
 * #2283 — the develop gate's data-provenance check: its BOUNDS and its SWITCH.
 *
 * Split from `test-verify-develop-data-provenance.ts` for the 500-line cap, along the seam
 * between *what the gate judges* and *what the gate refuses to look at*. The behaviour suite
 * asks whether an absent source reddens a record; this one asks what happens when the gate
 * cannot afford to answer at all — a corpus past its token ceiling, a file past its byte
 * ceiling, and the switch that turns the whole gate off. Both share
 * `lib/verify-develop-provenance-harness.ts`, so an arm cannot exist in one file and be
 * silently unavailable in the other.
 *
 * The invariant the bounds cases exist for is a single one, and it is the same one the
 * behaviour suite rests on: a thing this gate did not look at is DISCLOSED as unjudged, never
 * read as "judged and fine" and never failed on a corpus it never saw. Silence is not a pass,
 * and a bound that quietly truncated would be exactly that.
 */

import { verifyProvenanceEnabled } from "../src/work-driver-verify-develop-provenance.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  driveProvenanceFixture,
  provenanceFailures,
} from "./lib/verify-develop-provenance-harness.ts";

// ── 13. the gate's own bounds are honoured: a corpus past the ceiling is disclosed ─────────
{
  const rows = Array.from({ length: 300 }, (_, i) => ({ source: `rows/absent-${String(i)}.json` }));
  const huge = JSON.stringify({ rows }, null, 2);
  const r = await driveProvenanceFixture({ "runs/many.json": huge });
  const mine = provenanceFailures(r.failures);
  assert(
    mine.length > 0 && mine.length < 300,
    `a corpus past the per-workstream token cap judges at most the cap and discloses the rest (judged ${String(mine.length)} of 300)`,
  );
  assert(r.disclosures.length > 0, "the tokens past the cap are disclosed, never silently skipped");
  // The over-read arm, through the same gate. Which ceiling binds first — the gate's own byte
  // constant or the executor's output buffer — is not the property; the property is that a
  // committed record the gate cannot read is DISCLOSED as unjudged rather than read as "nothing
  // was added", and never fails on a corpus it never saw.
  const bigRun = await driveProvenanceFixture({
    "runs/huge.json": `{"source":"runs/gone.json","blob":"${"x".repeat(2 * 1024 * 1024)}"}`,
  });
  assert(
    provenanceFailures(bigRun.failures).length === 0,
    `an over-ceiling file never fails on a corpus it did not read (got: ${provenanceFailures(bigRun.failures).join(" | ")})`,
  );
  assert(
    bigRun.disclosures.some((d) => d.file === "runs/huge.json" && d.reason.length > 0) === true,
    `and it is disclosed as a file the gate refused to read, with the reason said out loud (got: ${JSON.stringify(bigRun.disclosures)})`,
  );
}

// ── 17. the switch's truth table, read at call time ───────────────────────────────────────
{
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["off", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_VERIFY_PROVENANCE: value }, async () => {
      assert(
        verifyProvenanceEnabled() === want,
        `reader: PI_ENSEMBLE_VERIFY_PROVENANCE=${JSON.stringify(value)} → ${String(want)}`,
      );
    });
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
