#!/usr/bin/env bun
/**
 * #1744 — one long `outOfScope` entry is BOUNDED, never a reason to refuse a
 * whole workstream's `report_workstream` call.
 *
 * The defect: `outOfScope` is documented as free text the developer reads, but
 * the schema carried `maxLength: 500` per entry and `maxItems: 50`. One entry
 * over the limit failed Pi's schema check and the companion refused the CALL —
 * so a workstream with a 700-character prose fence, or a 30-path list written
 * as one entry, reported nothing at all and could not correct itself inside
 * the dispatch. The field's own contract said "bounded, not verified"; the
 * schema was verifying it.
 *
 * What this pins:
 *
 *   1. the schema ACCEPTS what a sentence is and refuses only what no sentence
 *      can be (the abuse ceiling), while an over-limit `paths` entry is still
 *      refused — the two fields are different kinds of thing;
 *   2. the stored entry is clipped at its last path separator, comma or space
 *      at or before 500, carries NO marker, and the clip is recorded;
 *   3. a comma list of plain paths is split into its parts, and one prose
 *      sentence with a comma in it survives whole;
 *   4. past the entry-count cap the rest are dropped AND recorded;
 *   5. a clipped PATH-shaped entry still fences its path — at the develop gate
 *      and at the fix fence, the two consumers that match on the entry text;
 *   6. the fold carries the records onto the folded list and re-applies the
 *      cap, so a fold cannot smuggle past the bound a single call was held to;
 *   7. the bound is said out loud: one traceWarn per bounded call, and the
 *      prompt renders ` …[clipped]` beside a cut entry.
 */

import { rmSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import {
  FENCE_CLIP_MARKER,
  WORKSTREAM_FENCE_INPUT_MAX,
  WORKSTREAM_FENCE_MAX,
  WORKSTREAM_LIST_MAX,
  WORKSTREAM_PARAMETERS,
  type WorkstreamArgs,
  boundOutOfScope,
  clipFenceEntry,
  neutraliseFenceEntry,
  quotedOutOfScope,
  rekeyClippedAfterRemoval,
  workstreamCallRefusal,
} from "../src/plan-workstream-schema.ts";
import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { foldTwo } from "../src/workstream-fold.ts";
import { fenceMatches } from "../src/work-driver-declared-path.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
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
import type { Workstream } from "../src/workflow-state-schema.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A 700-character prose fence with no comma: one entry, over the bound. */
const LONG_PROSE = `the legacy compatibility layer for the old report format ${"which must not be touched ".repeat(24)}`;
/** A path-list entry: 30 plain paths, one entry, comma-separated. */
const THIRTY_PATHS = Array.from({ length: 30 }, (_, i) => `src/mod${i}.ts`).join(",");
/** One prose sentence with a comma AND a character no path may hold: never split. */
const PROSE_WITH_COMMA = "the public API of foo, not its internals' internals";
const PROSE_SPLIT = "the docs folder, the public API of foo";
/** A path-shaped entry whose retained prefix still fences `FENCED_FILE`. */
const LONG_PATH_FENCE = `extension/src/reports/${"widget".repeat(120)} must not change`;
const FENCED_FILE = "extension/src/reports/widget-table.ts";

const VALID: WorkstreamArgs = {
  id: "task-a",
  scope: "the fix",
  paths: ["src/a.ts"],
  outOfScope: [],
};

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
      outOfScope: Array.from({ length: 80 }, (_, i) => `fence ${i}`),
    }) === true,
    "a 60+ entry outOfScope list is ACCEPTED by the schema — the cap is the tool boundary's job",
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID,
      outOfScope: ["x".repeat(WORKSTREAM_FENCE_INPUT_MAX + 1)],
    }) === false,
    "an entry past the abuse ceiling is refused: the field is free text, not a megabyte pipe",
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

// ── 2 — the call is accepted, the entry clipped, and the clip recorded ───────
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
          { index: 0, originalLength: LONG_PROSE.length, keptLength: stored.length },
        ]),
      `the clip is recorded on the workstream (got ${JSON.stringify(ws.outOfScopeClipped)})`,
    );
  }
  const warned = traces.filter((t) => t.includes("outOfScope bounded"));
  assert(
    warned.length === 1 && warned[0]?.includes("task-a") === true,
    `one traceWarn names the bounded workstream (got ${warned.length})`,
  );
}

// ── 3 — a path list written as one entry is split; a sentence is not ─────────
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
}

// ── 4 — the entry-count cap drops the rest and says so ───────────────────────
{
  const many = Array.from({ length: WORKSTREAM_LIST_MAX + 10 }, (_, i) => `src/fence-${i}.ts`);
  const bounded = boundOutOfScope(many);
  assert(
    bounded.entries.length === WORKSTREAM_LIST_MAX,
    `the list is capped at ${WORKSTREAM_LIST_MAX} entries`,
  );
  const drops = bounded.clipped.filter((r) => r.keptLength === 0);
  assert(
    drops.length === 10 &&
      drops.every((r, i) => r.index === WORKSTREAM_LIST_MAX + i && r.originalLength > 0),
    `the 10 entries past the cap are recorded as dropped (got ${JSON.stringify(drops.slice(0, 2))})`,
  );
}

// ── 5 — a clipped PATH entry still fences, at both gates ─────────────────────
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

// ── 6 — the fold carries the records and re-applies the cap ──────────────────
{
  const a = workstreamFromArgs({
    ...VALID,
    id: "a",
    paths: ["src/a.ts"],
    outOfScope: [LONG_PROSE, "docs/a.md"],
  });
  const b = workstreamFromArgs({
    ...VALID,
    id: "b",
    paths: ["src/b.ts"],
    outOfScope: [LONG_PATH_FENCE],
  });
  const folded: Workstream = foldTwo(a, b);
  assert(
    folded.outOfScope.length === 3 && folded.outOfScope.includes("docs/a.md"),
    `the fold unions both halves' fences (got ${JSON.stringify(folded.outOfScope)})`,
  );
  const keptRecords = (folded.outOfScopeClipped ?? []).filter((r) => r.keptLength > 0);
  assert(
    keptRecords.length === 2,
    `both halves' clip records survive the fold (got ${JSON.stringify(folded.outOfScopeClipped)})`,
  );
  assert(
    keptRecords.every((r) => (folded.outOfScope[r.index] ?? "").length === r.keptLength),
    "every carried record points at the entry it describes: keptLength is that entry's length",
  );

  // Twice the cap unions to the cap, and the excess is recorded.
  const wide = (id: string, offset: number): Workstream =>
    workstreamFromArgs({
      ...VALID,
      id,
      paths: [`src/${id}.ts`],
      outOfScope: Array.from(
        { length: WORKSTREAM_LIST_MAX },
        (_, i) => `src/${id}-${offset + i}.ts`,
      ),
    });
  const big = foldTwo(wide("a", 0), wide("b", 1000));
  assert(
    big.outOfScope.length === WORKSTREAM_LIST_MAX,
    `a fold of two full lists is re-capped at ${WORKSTREAM_LIST_MAX}, not twice it`,
  );
  assert(
    (big.outOfScopeClipped ?? []).filter((r) => r.keptLength === 0).length === WORKSTREAM_LIST_MAX,
    "and every entry the fold dropped is recorded",
  );
}

// ── 7 — the bound is visible where a person reads it ─────────────────────────
{
  const bounded = boundOutOfScope([LONG_PROSE]);
  const shown = quotedOutOfScope(bounded.entries, bounded.clipped);
  assert(
    shown.includes(
      `${JSON.stringify(neutraliseFenceEntry(bounded.entries[0] ?? ""))}${FENCE_CLIP_MARKER}`,
    ),
    "a clipped fence says so in the prompt, outside the quotes",
  );
  assert(
    !quotedOutOfScope(bounded.entries).includes("clipped"),
    "with no record passed, the fence renders exactly as it did before #1744",
  );
  assert(
    quotedOutOfScope(["the docs folder"]).includes('"the docs folder"'),
    "an uncut entry is untouched by the marker path",
  );

  // The unfence pass re-keys the records against the list that actually remains.
  const before = ["src/gone.ts", ...(bounded.entries as string[]), "src/keep.ts"];
  const records = [
    { index: 1, originalLength: LONG_PROSE.length, keptLength: bounded.entries[0]?.length ?? 0 },
  ];
  assert(
    JSON.stringify(rekeyClippedAfterRemoval(before, before.slice(1), records)) ===
      JSON.stringify([
        { index: 0, originalLength: LONG_PROSE.length, keptLength: records[0]?.keptLength },
      ]),
    "removing an earlier entry shifts the record onto its entry's new position",
  );
  assert(
    rekeyClippedAfterRemoval(
      before,
      before.filter((_, i) => i !== 1),
      records,
    ).length === 0,
    "removing the clipped entry itself takes the record with it",
  );
}

for (const dir of REPO_DIRS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
