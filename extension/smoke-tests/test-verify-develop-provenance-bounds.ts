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

import {
  PROVENANCE_MAX_TOKENS,
  verifyProvenanceEnabled,
} from "../src/work-driver-verify-develop-provenance.ts";
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

// ── 13b. a non-string value under a provenance key is judged or disclosed, never exempt ────
{
  // `sources` is one of the seven keys, and an array is the shape a real record uses for a
  // multi-file corpus. A walker that recursed into the array without reading its string
  // elements judged NOTHING and reported a pass — the vacuous-green class this gate exists to
  // close, and the one a `typeof raw === "string"` guard at the key check silently produces.
  const arr = await driveProvenanceFixture({
    "runs/list.json": JSON.stringify({ sources: ["runs/gone.json"] }),
  });
  const arrMine = provenanceFailures(arr.failures);
  assert(
    arrMine.length === 1 && arrMine[0]?.includes("runs/gone.json") === true,
    `a string array under a provenance key has its elements judged: one element, one absent verdict (got ${String(arrMine.length)}: ${arrMine.join(" | ")})`,
  );
  assert(
    arr.disclosures.length === 0,
    `and the judged element is not ALSO disclosed as unverifiable (got: ${JSON.stringify(arr.disclosures)})`,
  );

  // An object under a provenance key names nothing the gate can probe. It is not a pass either:
  // a value that is not a string is exactly what a hand-edited or half-serialised record looks
  // like, and reading it as "nothing to check" is silence-as-pass.
  const obj = await driveProvenanceFixture({
    "runs/nested.json": JSON.stringify({ source: { path: "x" } }),
  });
  assert(
    provenanceFailures(obj.failures).length === 0,
    `an object value never fails on a path the gate could not name (got: ${provenanceFailures(obj.failures).join(" | ")})`,
  );
  assert(
    obj.disclosures.some((d) => d.file === "runs/nested.json" && d.key === "source") === true,
    `an object value under a provenance key is DISCLOSED, naming the file and the key (got: ${JSON.stringify(obj.disclosures)})`,
  );

  // The array of objects the walk already reaches: the strings inside are judged and the
  // container itself is not disclosed as a second, spurious row.
  const mixed = await driveProvenanceFixture({
    "runs/rows.json": JSON.stringify({ rows: [{ input: "runs/absent-row.json" }] }),
  });
  assert(
    provenanceFailures(mixed.failures).some((x) => x.includes("runs/absent-row.json")) === true,
    `a string inside an object inside an array is still judged (got: ${provenanceFailures(mixed.failures).join(" | ")})`,
  );

  // The non-vacuity pair for the disclosure arm: the same shape whose token IS committed
  // discloses nothing, so the row above is the value's shape and not a fixture that always
  // discloses.
  const ok = await driveProvenanceFixture({
    "runs/nested.json": JSON.stringify({ source: { path: "x" } }),
    "x": "row\n",
  });
  assert(
    provenanceFailures(ok.failures).length === 0,
    `control: a record whose sibling is committed still reddens nothing (got: ${provenanceFailures(ok.failures).join(" | ")})`,
  );
}

/** How many probes a run says it asked, read from the run's own executed-pass note. Read
 * from the note rather than a failure list, because a failure list can be emptied by a bug
 * and a note that overstates its work is the thing under test. A run that judged NOTHING
 * prints no note at all, and "no note" is the same thing the gate would print for a run that
 * judged nothing by accident — so callers that need to tell those apart pass `whenAbsent`.
 * The value is the one `judgedLabel` writes, which is why the number in a note cannot drift
 * from the probes the walk counted. */
function countJudged(notes: readonly string[], whenAbsent = -1): number {
  const row = notes.find((n) => n.includes("provenance token(s)"));
  if (row === undefined) return whenAbsent;
  return Number(row.match(/judged (\d+)/)?.[1] ?? "-1");
}

// ── 13c. the token cap is the WORKSTREAM's budget, not each file's allowance ─────────────
{
  // The constant's own words are "this gate judges for one workstream", and the cap exists to
  // bound the git probes ONE review round will pay. A cap counted per file lets a workstream
  // add N files and judge N × the cap: the bound is then a per-file courtesy and the cost it
  // bounds is unbounded. Two files, each alone under the cap, is the smallest witness.
  const rows = (n: number, prefix: string): string =>
    JSON.stringify({
      source: Array.from({ length: n }, (_, i) => `${prefix}/${String(i)}.json`),
    });
  const half = Math.floor(PROVENANCE_MAX_TOKENS / 2);

  // Control: the budget split across two files with nothing to spare judges everything and
  // discloses nothing. Without this arm, a "cap enforced" assertion passes on a gate that
  // judged nothing at all. The tokens are absent paths, so every probe reddens: the count is
  // read from the run's own note, not from a failure list that could be emptied by a bug.
  const exact = await driveProvenanceFixture({
    "runs/a.json": rows(half, "exact-a"),
    "runs/b.json": rows(half, "exact-b"),
  });
  const exactJudged = countJudged(exact.notes);
  assert(
    exactJudged === PROVENANCE_MAX_TOKENS && exact.disclosures.length === 0,
    `control: two files totalling exactly the cap judge everything and disclose nothing (judged ${String(exactJudged)} of ${String(PROVENANCE_MAX_TOKENS)}, disclosures ${JSON.stringify(exact.disclosures)})`,
  );

  // The overflow arm: two files whose union exceeds the cap. Each file is individually legal,
  // so a per-file counter sees two in-budget files; the workstream counter sees the remainder.
  const spill = await driveProvenanceFixture({
    "runs/a.json": rows(half + 4, "spill-a"),
    "runs/b.json": rows(half + 4, "spill-b"),
  });
  assert(
    spill.disclosures.length > 0,
    "two files whose union passes the cap disclose the remainder — the cap is the workstream's, not each file's allowance",
  );
  const judgedCount = countJudged(spill.notes);
  assert(
    judgedCount <= PROVENANCE_MAX_TOKENS,
    `the probes ONE workstream asks never exceed the cap it advertises (judged ${String(judgedCount)} of ${String(2 * (half + 4))}, cap ${String(PROVENANCE_MAX_TOKENS)})`,
  );

  // The non-vacuity pair for the budget itself. The two arms above pass on a walk that counted
  // the tokens it turned into pairs and nothing else — which is not the same population as the
  // tokens it OFFERED. Here the workstream offers 2 × cap tokens and turns NONE of them into
  // probes: every value is an absolute host path, so the classifier sets each aside. A budget
  // charged only at pair-creation would see zero spent, judge nothing, and disclose nothing — a
  // silent pass bought with unprobeable tokens. The charge is taken for tokens deduped away and
  // tokens never probeable alike, so this overflows.
  const unprobeable = (n: number, prefix: string): string =>
    JSON.stringify({ source: Array.from({ length: n }, (_, i) => `/opt/${prefix}/${String(i)}.json`) });
  const aside = await driveProvenanceFixture({
    "runs/a.json": unprobeable(PROVENANCE_MAX_TOKENS, "a"),
    "runs/b.json": unprobeable(PROVENANCE_MAX_TOKENS, "b"),
  });
  assert(
    countJudged(aside.notes, 0) === 0,
    `control for the arm below: nothing here is probeable, so nothing is judged (judged ${String(countJudged(aside.notes, 0))})`,
  );
  assert(
    aside.disclosures.some((d) => String(d.reason).includes("the workstream carries")) === true,
    `a workstream whose tokens are all unprobeable still runs out of budget and says so — a token nobody examined spent budget (got: ${JSON.stringify(aside.disclosures.filter((d) => String(d.reason).includes("workstream carries")))})`,
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
