#!/usr/bin/env bun
/**
 * #1744 — one long `outOfScope` entry is BOUNDED, never a reason to refuse a
 * whole workstream's `report_workstream` call.
 *
 * The defect: `outOfScope` is documented as free text the developer reads, but
 * the schema carried `maxLength: 500` per entry and `maxItems: 50`. One entry
 * over the limit failed Pi's schema check and the companion refused the CALL —
 * so a workstream with a 700-character prose fence, or a 30-path list written
 * as one entry, reported nothing at all and could not correct itself inside the
 * dispatch. The field's own contract said "bounded, not verified"; the schema
 * was verifying it.
 *
 * This file judges THE BOUND:
 *
 *   1. the schema ACCEPTS what a sentence is and refuses only what no sentence
 *      can be (the abuse ceilings, per entry AND per list), while an over-limit
 *      `paths` entry is still refused — the two fields are different kinds of
 *      thing;
 *   2. the call lands, the entry is clipped at its last path separator, comma or
 *      space at or before the bound, carries NO marker, and the clip is recorded
 *      keyed by the ENTRY TEXT;
 *   3. a comma list of plain paths is split into its parts, one prose sentence
 *      with a comma in it survives whole, and duplicates collapse;
 *   4. past the entry-count cap the rest are dropped and counted, a blank is an
 *      `empty` drop wherever it sits, and past the ceiling the work STOPS — no
 *      split, no path grammar, no clip;
 *   5. the bound is measured in CODE POINTS, a clipped PATH entry still fences
 *      (at the develop gate and at the fix fence, the two consumers that match on
 *      entry text), and a clip that landed on a `/` is disclosed as the WIDER
 *      fence it became.
 *
 * What the bound LEAVES BEHIND — the record through the fold, the third writer,
 * and the prompt rendering — is the other half: test-plan-outofscope-visible-1744.ts.
 */

import { rmSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { boundOutOfScope, clipFenceEntry } from "../src/plan-fence-bound.ts";
import { fenceDropCount } from "../src/plan-fence-record.ts";
import {
  WORKSTREAM_FENCE_INPUT_LIST_MAX,
  WORKSTREAM_FENCE_INPUT_MAX,
  WORKSTREAM_FENCE_MAX,
  WORKSTREAM_LIST_MAX,
  WORKSTREAM_PARAMETERS,
  workstreamCallRefusal,
} from "../src/plan-workstream-schema.ts";
import { fenceMatches } from "../src/work-driver-declared-path.ts";
import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import { foldTwo } from "../src/workstream-fold.ts";
import {
  LONG_PATH_FENCE,
  LONG_PROSE,
  PROSE_SPLIT,
  PROSE_WITH_COMMA,
  THIRTY_PATHS,
  VALID,
  fenceList,
} from "./lib/plan-outofscope-fixtures.ts";
import { FENCED_FILE } from "./lib/plan-outofscope-fixtures.ts";
import { planResultFromCalls, planResultFromRawCalls } from "./lib/plan-workstream-calls.ts";
import {
  NEW_FILE,
  SLOT,
  captureTracesSync,
  fenceVerdict,
  repo,
  specWith,
  stateWith,
} from "./lib/spec-slot-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO_DIRS: string[] = [];

// ── 1 — the schema accepts a long fence and refuses only what no sentence is ──
{
  assert(
    LONG_PROSE.length > WORKSTREAM_FENCE_MAX,
    `the fixture is over the bound it is meant to exercise (${LONG_PROSE.length} > ${WORKSTREAM_FENCE_MAX})`,
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, { ...VALID, outOfScope: [LONG_PROSE] }) === true,
    "a 700-character outOfScope entry is ACCEPTED by the schema (it used to refuse the whole call)",
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID,
      outOfScope: Array.from({ length: WORKSTREAM_LIST_MAX + 30 }, (_, i) => `fence ${i}`),
    }) === true,
    `an ${WORKSTREAM_LIST_MAX + 30}-entry outOfScope list is ACCEPTED — the count cap is the tool boundary's job`,
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID,
      outOfScope: ["x".repeat(WORKSTREAM_FENCE_INPUT_MAX + 1)],
    }) === false,
    "an entry past the abuse ceiling is refused: the field is free text, not a megabyte pipe",
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID,
      outOfScope: Array.from(
        { length: WORKSTREAM_FENCE_INPUT_LIST_MAX + 1 },
        (_, i) => `fence ${i}`,
      ),
    }) === false,
    `an outOfScope ARRAY past ${WORKSTREAM_FENCE_INPUT_LIST_MAX} entries is refused — the ceiling bounds the abuse, and the work past the count cap is bounded too`,
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID,
      outOfScope: Array.from({ length: WORKSTREAM_FENCE_INPUT_LIST_MAX }, (_, i) => `fence ${i}`),
    }) === true,
    "an outOfScope array AT the abuse ceiling is still accepted",
  );
  // The other field is still a path list with a grammar, and refusing it is right.
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, { ...VALID, paths: [`${"a".repeat(301)}.ts`] }) === false,
    "an over-long `paths` entry is still refused by the schema",
  );
  const report = workstreamCallsOf(
    planResultFromRawCalls([
      { id: "task-a", args: { ...VALID, paths: [`src/${"a".repeat(300)}.ts`] } },
    ]),
  );
  assert(
    report.accepted === 0 && report.refused.length === 1,
    "an over-long declared path is refused by the reader, not truncated into the plan",
  );
  assert(
    workstreamCallRefusal({ ...VALID, outOfScope: [LONG_PROSE] }, new Set<string>()) === undefined,
    "the companion accepts a long fence instead of refusing the call it belongs to",
  );
}

// ── 2 — the call is accepted, the entry clipped, and the clip keyed by text ───
{
  const { value: report, traces } = captureTracesSync(() =>
    workstreamCallsOf(planResultFromCalls([{ ...VALID, outOfScope: [LONG_PROSE] }])),
  );
  const ws = report.workstreams["task-a"];
  assert(report.accepted === 1 && ws !== undefined, "the long-fence call is ACCEPTED");
  if (ws) {
    const stored = ws.outOfScope[0] ?? "";
    assert(ws.outOfScope.length === 1, "one prose entry stays one entry (no comma to split on)");
    assert(
      stored.length <= WORKSTREAM_FENCE_MAX && stored.length > WORKSTREAM_FENCE_MAX - 40,
      `the stored entry is clipped to the bound (${stored.length} chars)`,
    );
    assert(
      !stored.includes("clipped") && !stored.includes("…"),
      "the stored entry carries NO marker — the fence matches on the retained text alone",
    );
    assert(
      LONG_PROSE.startsWith(stored) && LONG_PROSE[stored.length] === " ",
      "the cut landed on a space: whole words, not a word sawn in half",
    );
    assert(
      JSON.stringify(ws.outOfScopeClipped) ===
        JSON.stringify([
          {
            kind: "clipped",
            entry: stored,
            originalLength: Array.from(LONG_PROSE).length,
            keptLength: Array.from(stored).length,
          },
        ]),
      `the clip is recorded on the workstream, KEYED BY THE ENTRY TEXT (got ${JSON.stringify(ws.outOfScopeClipped)})`,
    );
  }
  const warned = traces.filter((t) => t.includes("outOfScope bounded"));
  assert(
    warned.length === 1 && warned[0]?.includes("task-a") === true,
    `one traceWarn names the bounded workstream (got ${warned.length})`,
  );
  const line = warned[0] ?? "";
  assert(
    line.includes("1 entry clipped to 500 chars") &&
      line.includes("0 dropped past the 50-entry cap") &&
      line.includes("0 blank entries dropped") &&
      line.includes("(kept: 1/1)"),
    `the trace counts clipped, cap-dropped and blank-dropped SEPARATELY and measures kept against the expanded list (got: ${line.replace("[pi-rukas] WARN work-driver: ", "")})`,
  );
}

// ── 3 — a path list is split, a sentence is not, duplicates collapse ──────────
{
  const list = boundOutOfScope([THIRTY_PATHS]);
  assert(
    list.entries.length === 30 &&
      list.entries[0] === "src/mod0.ts" &&
      list.entries[29] === "src/mod29.ts",
    "a comma-separated list of 30 plain paths is stored as 30 fence entries",
  );
  assert(list.clipped.length === 0, "splitting a list of short paths records no bound");
  assert(
    fenceMatches(list.entries[0] ?? "", "src/mod0.ts"),
    "each split part is a real fence entry: it matches the file it names",
  );
  const prose = boundOutOfScope([PROSE_WITH_COMMA]);
  assert(
    prose.entries.length === 1 && prose.entries[0] === PROSE_WITH_COMMA,
    `a sentence a path grammar cannot pronounce survives whole (got ${JSON.stringify(prose.entries)})`,
  );
  const halfPath = boundOutOfScope(["src/a.ts, the API's public surface"]);
  assert(
    halfPath.entries.length === 1,
    "a list with ONE segment the path grammar refuses is prose after all: never partially split",
  );
  const splitProse = boundOutOfScope(["the docs folder, the public API of foo"]);
  assert(
    splitProse.entries.length === 2 &&
      splitProse.entries.every((e, i) => PROSE_SPLIT.split(/, /)[i] === e),
    `a prose comma list whose halves are all path-shaped splits, losing no text (got ${JSON.stringify(splitProse.entries)})`,
  );
  const dupe = boundOutOfScope(["the docs folder", "the docs folder", "docs/**", "docs/**"]);
  assert(
    dupe.entries.length === 2 && dupe.expanded === 4,
    `duplicates collapse so one text identifies one entry, and the trace denominator still counts what the planner wrote (kept ${dupe.entries.length}/expanded ${dupe.expanded})`,
  );
  assert(
    dupe.clipped.length === 0,
    "a duplicate is not a loss — the text is stored once, so no drop is recorded for it",
  );
}

// ── 4 — the entry-count cap drops the rest as ONE aggregated record ───────────
{
  const many = fenceList(WORKSTREAM_LIST_MAX + 10);
  const bounded = boundOutOfScope(many);
  assert(
    bounded.entries.length === WORKSTREAM_LIST_MAX,
    `the list is capped at ${WORKSTREAM_LIST_MAX} entries`,
  );
  const drops = bounded.clipped.filter((r) => r.kind === "dropped");
  assert(
    drops.length === 1 &&
      drops[0]?.kind === "dropped" &&
      drops[0].reason === "cap" &&
      drops[0].count === 10,
    `the 10 entries past the cap are ONE aggregated record, not ten (got ${JSON.stringify(drops)})`,
  );
  assert(
    bounded.expanded === WORKSTREAM_LIST_MAX + 10,
    "the trace denominator is the expanded count, so kept 50/expanded 60 reads true",
  );
  assert(
    fenceDropCount(bounded.clipped, "cap") === 10 && fenceDropCount(bounded.clipped, "empty") === 0,
    "the drop counts are readable per reason",
  );
}

// ── 4b — a blank entry is an `empty` drop, never a cap drop ──────────────────
{
  const blanks = boundOutOfScope(["   ", "the docs folder", "", "\t\n", "docs/**"]);
  assert(
    blanks.entries.length === 2 &&
      blanks.entries[0] === "the docs folder" &&
      blanks.entries[1] === "docs/**",
    `blank entries never reach the fence (got ${JSON.stringify(blanks.entries)})`,
  );
  assert(
    fenceDropCount(blanks.clipped, "empty") === 3 && fenceDropCount(blanks.clipped, "cap") === 0,
    "three blanks are three `empty` drops and zero cap drops",
  );
  // A blank entry past the cap is still an empty drop, not a cap drop.
  const atCap = fenceList(WORKSTREAM_LIST_MAX);
  const blanksPastCap = boundOutOfScope([...atCap, "", "   ", "src/one-more.ts"]);
  assert(
    fenceDropCount(blanksPastCap.clipped, "empty") === 2 &&
      fenceDropCount(blanksPastCap.clipped, "cap") === 1,
    "the blank/cap distinction is judged before the position, so a blank past the cap is not billed to the cap",
  );
}

// ── 4c — past the ceiling the work stops: counted, not parsed ────────────────
{
  const atCap = fenceList(WORKSTREAM_LIST_MAX);
  const beyond = boundOutOfScope([...atCap, THIRTY_PATHS, `${"x".repeat(900)} tail`]);
  assert(
    beyond.entries.length === WORKSTREAM_LIST_MAX,
    "the ceiling holds when the extra entries arrive after it",
  );
  assert(
    fenceDropCount(beyond.clipped, "cap") === 31,
    `a 30-path list past the ceiling is 30 dropped exclusions and the 900-char entry is one more, counted by SEPARATORS not by parsing (cap drops: ${fenceDropCount(beyond.clipped, "cap")})`,
  );
  assert(
    beyond.clipped.every((r) => r.kind === "dropped"),
    "no clip record is produced for an entry the bound never examined",
  );
}

// ── 4e — widening is judged on the RETAINED text, not on the cut character ───
{
  // A space cut and a comma cut that each leave a BARE PATH behind fence
  // exactly as widely as a cut on a `/` does: what matches files is the kept
  // text, so the disclosure has to follow the kept text (#1744 adversarial
  // round — the cut character was the original, wrong, signal).
  const spaceCut = boundOutOfScope([`src/legacy/deep/thing.ts ${"x".repeat(600)}`]);
  const spaceKept = spaceCut.entries[0] ?? "";
  assert(spaceKept === "src/legacy/deep/thing.ts", `the space cut kept the path (got ${JSON.stringify(spaceKept)})`);
  assert(
    spaceCut.widened.includes(spaceKept) &&
      spaceCut.clipped.some((r) => r.kind === "clipped" && r.entry === spaceKept && r.widened === true),
    "a cut on a SPACE that leaves a bare path is disclosed as widening, and the record carries `widened: true`",
  );

  // The comma list is not split — its second segment is 600 characters, a
  // length the planner's own grammar refuses in `paths`, so the whole entry is
  // prose and the clip is what remains.
  const commaCut = boundOutOfScope([`src/legacy/deep/thing.ts,${"y".repeat(600)}`]);
  const commaKept = commaCut.entries[0] ?? "";
  assert(commaKept === "src/legacy/deep/thing.ts", `the comma cut kept the path (got ${JSON.stringify(commaKept)})`);
  assert(
    commaCut.widened.includes(commaKept) &&
      commaCut.clipped.some((r) => r.kind === "clipped" && r.entry === commaKept && r.widened === true),
    "a cut on a COMMA that leaves a bare path is disclosed as widening too",
  );

  // A long run with no separator at all hard-cuts to 500 characters. It is not
  // a path anyone could have declared, so it is NOT reported as a widened
  // fence — the length clause is what keeps the disclosure honest.
  const hardCut = boundOutOfScope(["z".repeat(900)]);
  assert(
    hardCut.widened.length === 0,
    "a 500-character hard cut is not called a widened fence",
  );

  // The fold carries the widened set on the records, so the fold's own re-cap
  // can say the same thing the tool boundary said (#1744 review — the fold
  // used to report an empty widened list).
  const widenedWs = workstreamFromArgs({
    ...VALID,
    id: "w",
    paths: ["src/w.ts"],
    outOfScope: [
      `src/legacy/deep/thing.ts ${"x".repeat(600)}`,
      ...Array.from({ length: WORKSTREAM_LIST_MAX - 1 }, (_, i) => `src/w-${i}.ts`),
    ],
  });
  const otherWs = workstreamFromArgs({
    ...VALID,
    id: "p",
    paths: ["src/p.ts"],
    outOfScope: Array.from({ length: WORKSTREAM_LIST_MAX }, (_, i) => `src/p-${i}.ts`),
  });
  assert(
    (widenedWs.outOfScopeClipped ?? []).some(
      (r) => r.kind === "clipped" && r.widened === true,
    ),
    "the widened half arrived at the fold already carrying the flag on its clip record",
  );
  const { value: widenedFold, traces: reCapTraces } = captureTracesSync(() =>
    foldTwo(widenedWs, otherWs),
  );
  assert(
    widenedFold.outOfScope.length === WORKSTREAM_LIST_MAX &&
      (widenedFold.outOfScopeClipped ?? []).some(
        (r) => r.kind === "clipped" && r.widened === true,
      ),
    "the folded workstream still carries the widened flag on its clip record",
  );
  assert(
    reCapTraces.some(
      (t) => t.includes("outOfScope bounded") && t.includes("clipped fence now covers"),
    ),
    `the fold's re-cap line names the widened subtree, derived from the carried records (got: ${reCapTraces.filter((t) => t.includes("outOfScope bounded")).join(" | ") || "no re-cap trace — the fold was silent"})`,
  );
}

// ── 4d — the bound is measured in code points, not UTF-16 units ──────────────
{
  // 500 astral characters = 1 000 UTF-16 units but 500 CODE POINTS: a bound
  // measured in units would clip half of a real character's worth of fence, and
  // `slice` would cut between the halves of a surrogate pair.
  const astral = `${"🚧".repeat(WORKSTREAM_FENCE_MAX)} / keep-this-out`;
  const bounded = boundOutOfScope([astral]);
  const kept = bounded.entries[0] ?? "";
  const points = Array.from(kept).length;
  assert(
    bounded.clipped.some(
      (r) => r.kind === "clipped" && r.originalLength === Array.from(astral).length,
    ),
    "originalLength is a code-point count, not the UTF-16 length",
  );
  assert(
    points <= WORKSTREAM_FENCE_MAX && kept === kept.trim(),
    `the kept text is at most ${WORKSTREAM_FENCE_MAX} CODE POINTS and is still whole (${points} code points, ${kept.length} UTF-16 units)`,
  );
  assert(
    kept.length === points * 2 && /^(?:[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(kept),
    "the cut never lands between the halves of a surrogate pair: every pair is intact",
  );
}

// ── 5 — a clipped PATH entry still fences, and the widening is disclosed ──────
{
  const clipped = clipFenceEntry(LONG_PATH_FENCE);
  assert(
    clipped === "extension/src/reports",
    `the cut fell on the path separator (got "${clipped}")`,
  );
  assert(
    fenceMatches(clipped, FENCED_FILE),
    "the clipped entry still fences the file its retained prefix covers",
  );
  assert(
    !fenceMatches(LONG_PATH_FENCE, FENCED_FILE),
    "unclipped, that same entry fences nothing — the bound is what makes it a fence",
  );

  const { traces } = captureTracesSync(() =>
    workstreamFromArgs({ ...VALID, id: "widening", outOfScope: [LONG_PATH_FENCE] }),
  );
  const warned = traces.filter((t) => t.includes("outOfScope bounded"));
  assert(
    warned.length === 1 &&
      warned[0]?.includes("clipped fence now covers extension/src/reports/") === true,
    `a clip that landed on a '/' says which SUBTREE the fence now covers (got: ${(warned[0] ?? "").replace("[pi-rukas] WARN work-driver: ", "")})`,
  );
  const noWiden = captureTracesSync(() =>
    workstreamFromArgs({ ...VALID, id: "prose", outOfScope: [LONG_PROSE] }),
  );
  assert(
    !noWiden.traces.some((t) => t.includes("clipped fence now covers")),
    "a clip that fell on a space widens nothing and says nothing about widening",
  );

  const failures: string[] = [];
  runScopeFanoutGate(
    { a: { id: "a", scope: "t", paths: ["extension/src/own.ts"], outOfScope: [clipped] } },
    new Map([["a", new Set([FENCED_FILE])]]),
    failures,
    [],
    undefined,
  );
  assert(
    failures.some((f) => f.includes(FENCED_FILE)),
    `the develop gate blocks a file behind the clipped fence (got: ${failures.join("; ") || "none"})`,
  );

  // The fix fence, through the real pass: the spec slot would admit the file,
  // and the clipped fence must beat it.
  const dir = repo("1744-fix-fence");
  REPO_DIRS.push(dir);
  const st = stateWith(dir, {
    outOfScope: [clipFenceEntry(`extension/src/${"x".repeat(600)}`)],
    specSource: specWith([SLOT], "d1"),
  });
  const { parked } = await fenceVerdict(dir, st, [NEW_FILE]);
  assert(
    parked.includes(NEW_FILE) && parked.includes("outOfScope fence"),
    `the fix fence refuses the file behind its clipped entry, not the slot (got: ${parked.slice(0, 140)})`,
  );
}

for (const dir of REPO_DIRS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
