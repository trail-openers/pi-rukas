#!/usr/bin/env bun
/**
 * #1756 part (b) — a crowded `paths` list is never a reason to refuse a whole
 * workstream's `report_workstream` call, and NOTHING is removed from it.
 *
 * The defect (five field parks, all `plan-spec-mismatch`): the schema
 * carried `maxItems: WORKSTREAM_LIST_MAX` (50) on `paths`, so one path over
 * the 50th failed Pi's schema check and the companion refused the CALL —
 * "paths: must not have more than 50 items". The planner's recovery was to
 * re-report with a shorter list, and every scope gate reads `ws.paths` as THE
 * AUTHORISED SET, so the omitted files silently stopped being authorised.
 *
 * This file judges that the fix holds in the only direction that matters:
 * NOTHING is removed from `paths`, and everything downstream still reads the
 * whole list. What the prompts PRINT of that list is the companion file,
 * `test-plan-paths-display-1756.ts`.
 *
 *   1. the schema accepts 51 and 500 declared paths and refuses only 501 (the
 *      abuse ceiling) with a legible message, while a 301-character path is
 *      still refused per entry;
 *   2. `workstreamFromArgs` keeps all 80, records no display count, collapses
 *      duplicates on the normalised key, says so on ONE trace line, and the
 *      call is not refused;
 *   3. the fanout gate's denominator is the FULL list — 80 declared paths buy
 *      a limit of 240, and undeclared files past that still fail;
 *   4. a collision in the tail (paths 51-80) still fires
 *      `findPathCollisions`;
 *   5. a deferred protected path in the tail is still removed by
 *      `withDeferredProtectedFence`;
 *   6. a fold of 40 + 40 keeps all 80, returns a plain workstream, and the
 *      fold passes report the REAL kept count in their one line;
 *   7. the bound's own primitives: the tally, its plural, and the subject
 *      going through the fence neutraliser.
 */

import { Value } from "@sinclair/typebox/value";
import { boundPaths, pathsBoundNotice } from "../src/plan-paths-bound.ts";
import {
  WORKSTREAM_LIST_MAX,
  WORKSTREAM_PARAMETERS,
  WORKSTREAM_PATH_INPUT_LIST_MAX,
  WORKSTREAM_PATH_MAX,
  workstreamCallRefusal,
  workstreamPathProblem,
} from "../src/plan-workstream-schema.ts";
import { normaliseDeclaredPath } from "../src/work-driver-declared-path.ts";
import { withDeferredProtectedFence } from "../src/work-driver-plan-fence.ts";
import { findPathCollisions } from "../src/work-driver-plan-paths.ts";
import { foldPortPlan } from "../src/work-driver-plan-contract.ts";
import { foldToCeiling, workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { foldTwo } from "../src/workstream-fold.ts";
import { VALID } from "./lib/plan-outofscope-fixtures.ts";
import { crowdedArgs, pathList } from "./lib/plan-paths-fixtures.ts";
import { captureTracesSync, withTightFanout } from "./lib/spec-slot-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ws = (id: string, paths: string[], outOfScope: string[] = []): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

/** Run a fold pass with the ceiling pinned to M, restoring the ambient value. */
function withMaxWorkstreams<T>(max: number, run: () => T): T {
  // `= undefined` would leave the key present, so `Number(undefined)` is NaN
  // and the ceiling silently stays at its default — the pass must actually fold.
  const prev = process.env.PI_ENSEMBLE_MAX_WORKSTREAMS;
  process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = String(max);
  try {
    return run();
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_MAX_WORKSTREAMS");
    else process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = prev;
  }
}

/**
 * The aggregate `paths bounded` line of a fold pass that DID collapse entries,
 * or `undefined` when the pass was clean — `traceWarn` writes synchronously and
 * `captureTracesSync` collects every `stderr.write` chunk, so a chunk must be
 * flattened before the whole line is found in it.
 */
function boundLineOf(traces: string[]): string | undefined {
  return traces
    .join("")
    .split("\n")
    .find((l) => l.includes("paths bounded"));
}

// ── 1. the schema accepts a crowded plan and refuses only what no plan is ────
{
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID,
      paths: pathList(WORKSTREAM_LIST_MAX + 1),
    }) === true,
    `a ${WORKSTREAM_LIST_MAX + 1}-path list is ACCEPTED (it used to refuse the whole call)`,
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID,
      paths: pathList(WORKSTREAM_PATH_INPUT_LIST_MAX),
    }) === true,
    `the abuse ceiling itself is accepted (${WORKSTREAM_PATH_INPUT_LIST_MAX} paths)`,
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID,
      paths: pathList(WORKSTREAM_PATH_INPUT_LIST_MAX + 1),
    }) === false,
    `past the ceiling (${WORKSTREAM_PATH_INPUT_LIST_MAX}) the call IS refused — a runaway reply is not a plan`,
  );
  // The refusal must be legible and it must be the one the tool boundary
  // actually gives: Pi validates the same `WORKSTREAM_PARAMETERS` schema and
  // echoes that error back to the planner, so the assertion reads the
  // validator's own first error and checks it names the ceiling the schema
  // declares.
  const refusal = Value.Errors(WORKSTREAM_PARAMETERS, {
    ...VALID,
    paths: pathList(WORKSTREAM_PATH_INPUT_LIST_MAX + 1),
  }).First();
  assert(
    refusal?.message?.includes(String(WORKSTREAM_PATH_INPUT_LIST_MAX)) === true &&
      workstreamPathProblem(crowdedArgs("task-a", pathList(501))) === undefined,
    `a 501-path report is refused clearly, by the list ceiling alone (got: ${JSON.stringify(refusal?.message)})`,
  );
}

// ── 2. the per-entry refusal is untouched ───────────────────────────────────
{
  // One long segment then two short ones: the fill sits at the END, which is
  // the shape a formatter leaves alone, and the last segment keeps a real
  // extension so the fixture is a path a plan could actually have written.
  const tooLong = `${"x".repeat(WORKSTREAM_PATH_MAX + 1 - "src/deep/leaf.ts".length)}src/deep/leaf.ts`;
  assert(
    tooLong.length === WORKSTREAM_PATH_MAX + 1,
    `the fixture is exactly one over ${WORKSTREAM_PATH_MAX} (${tooLong.length})`,
  );
  // The per-entry length is the SCHEMA'S clause (`Type.String({ maxLength:
  // WORKSTREAM_PATH_MAX })`), not `plannedPathProblem`'s — the latter judges
  // shape only (shell characters, leading `-`/`:`, globs, `..`). So the refusal
  // is asserted where it is enforced, and `Value.Check` is the same check Pi
  // runs on a tool call. Asking `workstreamCallRefusal` instead asserts a
  // tautology: it cannot see length, so it returns `undefined` whatever the
  // fixture is, and the label would have claimed a guard that does not exist.
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, crowdedArgs("task-a", [tooLong])) === false,
    "a 301-character path is still refused by the schema — #1756 raised the LIST ceiling, not the per-entry one",
  );
  assert(
    // A 500-path plan whose every entry sits at the per-entry limit is still
    // accepted: the two ceilings are independent, and a crowded plan of legal
    // entries is what the fix is for.
    Value.Check(
      WORKSTREAM_PARAMETERS,
      crowdedArgs(
        "task-a",
        Array.from({ length: WORKSTREAM_PATH_INPUT_LIST_MAX }, () =>
          tooLong.slice(0, WORKSTREAM_PATH_MAX),
        ),
      ),
    ) === true,
    `a full-ceiling plan (${WORKSTREAM_PATH_INPUT_LIST_MAX} paths at ${WORKSTREAM_PATH_MAX} chars each) is accepted`,
  );
  assert(
    workstreamPathProblem(crowdedArgs("task-a", [tooLong])) === undefined &&
      workstreamCallRefusal(crowdedArgs("task-a", [tooLong]), new Set()) === undefined,
    "control: the path rules judge shape, not length — the length clause is the schema's and nothing else refuses it",
  );
}

// ── 3. workstreamFromArgs keeps every path and stays silent when clean ─────
{
  const paths = pathList(80);
  const { value: stored, traces } = captureTracesSync(() =>
    workstreamFromArgs(crowdedArgs("task-a", paths)),
  );
  assert(
    stored.paths.length === 80 && stored.paths.join() === paths.join(),
    `80 declared paths stay 80, in the planner's order (got ${stored.paths.length})`,
  );
  assert(
    !("pathsDropped" in stored),
    "no display count is recorded — there is no display bound any more",
  );
  const notices = traces.filter((t) => t.includes("paths bounded"));
  assert(
    notices.length === 0,
    `a clean 80-path plan emits no bound line — nothing was bounded (got ${notices.length})`,
  );
}

{
  // Duplicates ARE worth saying out loud, and one line says them.
  const { value: dup, traces } = captureTracesSync(() =>
    workstreamFromArgs(crowdedArgs("task-a", [...pathList(60), ...pathList(60, "src/mod")])),
  );
  const notices = traces.filter((t) => t.includes("paths bounded"));
  assert(
    dup.paths.length === 60 &&
      notices.length === 1 &&
      notices[0]?.includes("60 duplicates collapsed") === true,
    `60 duplicated entries collapse and produce exactly one trace line (got ${JSON.stringify(notices)})`,
  );
  assert(
    !("pathsDropped" in dup),
    "and even a crowded call with duplicates records no display count",
  );
}

{
  // Duplicates collapse on the NORMALISED identity — the SAME key every scope
  // gate uses — and the raw string is what is stored: the annotation is prose
  // the consolidation normaliser strips. `**src/b.ts**` and `src/b.ts` are one
  // file to `fenceMatches`/`normaliseScopePath`, so they must be one entry here
  // or the same file is authorised twice and the fanout denominator lies.
  const { value: dup } = captureTracesSync(() =>
    workstreamFromArgs(
      // The three `src/b.ts` spellings are ONE file to the declared-path
      // normaliser (annotation and paired markup both stripped) while the raw
      // text is what is stored. No backticks anywhere: `plannedPathProblem`
      // refuses one outright, so a backtick is not a shape a stored plan holds.
      crowdedArgs("task-a", [
        "src/a.ts",
        "src/b.ts",
        "src/b.ts (added)",
        "**src/b.ts**",
        "**src/c.ts**",
        "src/d.ts",
      ]),
    ),
  );
  assert(
    dup.paths.join() === "src/a.ts,src/b.ts,**src/c.ts**,src/d.ts",
    `the RAW strings are stored (annotation and markup intact), deduped on the normalised text (got ${JSON.stringify(dup.paths)})`,
  );
  assert(dup.paths.length === 4, "three spellings of one file are one declared path");
  assert(dup.paths[1] === "src/b.ts", "the FIRST spelling of a file is the one kept");
  assert(
    dup.paths.filter((p) => normaliseDeclaredPath(p) === "src/b.ts").length === 1,
    "both markup and annotation spellings of src/b.ts collapse to one entry keyed src/b.ts",
  );
}

// ── 4. the fanout denominator is the FULL declared list ───────────────
{
  const declared = pathList(80);
  const gate = (changed: string[]) => {
    const failures: string[] = [];
    const notes: string[] = [];
    runScopeFanoutGate(
      { "task-a": ws("task-a", declared, []) },
      new Map([["task-a", new Set(changed)] as [string, Set<string>]]),
      failures,
      notes,
    );
    return failures;
  };
  // 80 declared × factor 3 = 240, and 80 undeclared files are all inside it.
  const within = gate(pathList(80, "src/other"));
  assert(
    within.length === 0,
    `80 declared paths buy a fanout limit of 240 (got failures: ${within.join("; ")})`,
  );
  const beyond = gate(pathList(241, "src/other"));
  assert(
    beyond.some((f) => f.includes("scope fanout:")),
    `undeclared files past that limit still fail the gate (got: ${beyond.join("; ")})`,
  );
  // The denominator is the FULL list: clipped to the 50 the prompt shows, the
  // same run would report a limit of 150 and fail the very change above.
  assert(
    !beyond.some((f) => f.includes("vs 150 declared")),
    "the denominator is 80 declared paths, not the 50 a prompt prints",
  );
  const shown = beyond.find((f) => f.includes("scope fanout:")) ?? "";
  assert(
    shown.includes("declared paths 80"),
    `the failure names the denominator actually used (got: ${shown.slice(0, 120)})`,
  );
  // Control: with the tightest tunables the same list still buys only
  // factor×declared, so the pass above is the denominator, not the floor.
  const tight = withTightFanout(() => gate(pathList(81, "src/other")));
  assert(
    tight.some((f) => f.includes("scope fanout:")),
    "control: at factor 1 the same 80-path plan bounds 80 undeclared files",
  );
}

// ── 5. a collision in the tail still fires ───────────────────────────────
{
  const a = pathList(80, "src/a");
  // The collision sits at index 55 of b's list — where the old display bound
  // stopped printing, which is the shape that used to hide a collision.
  const b = pathList(80, "src/b");
  b[55] = "src/a-77.ts";
  const collisions = findPathCollisions({ "task-a": { paths: a }, "task-b": { paths: b } });
  assert(
    collisions.some((c) => c.path === "src/a-77.ts"),
    `a collision in the tail (paths 51-80) still fires findPathCollisions (got ${JSON.stringify(collisions)})`,
  );
}

// ── 6. a deferred protected path in the tail is still removed ───────────────
{
  const paths = pathList(80, "src/mod");
  const tailPath = "src/mod-63.ts";
  assert(paths.includes(tailPath), "the fixture's protected path is past the old display bound");
  const fenced = withDeferredProtectedFence({ "task-a": ws("task-a", [...paths]) }, [tailPath]);
  const kept = fenced["task-a"];
  assert(
    kept?.paths.includes(tailPath) === false,
    "the deferred protected path in the tail is still removed from paths",
  );
  assert(
    kept?.paths.length === 79 && kept?.outOfScope.includes(tailPath) === true,
    `and it is fenced in outOfScope (paths ${kept?.paths.length}, fence ${JSON.stringify(kept?.outOfScope)})`,
  );
  assert(
    !("pathsDropped" in (kept ?? {})),
    "the fence records no display count for the 79 paths it stores",
  );
}

// ── 7. the fold keeps every path of both halves and never truncates ─────────
{
  const a = workstreamFromArgs(crowdedArgs("task-a", pathList(40, "src/a")));
  const b = workstreamFromArgs(crowdedArgs("task-b", pathList(40, "src/b")));
  const merged = foldTwo(a, b);
  assert(
    merged.paths.length === 80,
    `a fold of 40 + 40 keeps all 80 declared paths (got ${merged.paths.length})`,
  );
  assert(
    !("pathsDropped" in merged),
    "the merged workstream carries no display count in its state",
  );
  assert(
    !("duplicatePaths" in merged),
    // A fold returns a Workstream, not a Workstream plus a bookkeeping field:
    // every caller had to strip it by hand, and a leftover one is a key no
    // schema declares in a state file.
    `the fold returns a plain workstream, no tally field to strip (got ${JSON.stringify(Object.keys(merged))})`,
  );
  assert(
    boundPaths([...a.paths, ...b.paths, ...a.paths]).duplicate === 40,
    "the bound the pass callers use reports the 40 collapsed entries of a repeated union",
  );
  // The fold's self-fence rule still reads the whole union: an entry naming one
  // of the absorbed half's tail files is dropped, because it is now in scope.
  const tailFile = pathList(40, "src/b")[37];
  const selfFenced = foldTwo(a, { ...b, outOfScope: [tailFile, "the docs folder"] });
  assert(
    selfFenced.outOfScope.includes(tailFile) === false &&
      selfFenced.outOfScope.includes("the docs folder") === true,
    "the fold still drops a self-fence that names a merged path from the tail",
  );
}

// ── 8. the fold notice reports the REAL kept count, never `0 kept` ─────────
{
  // The ceiling fold and the port fold used to print `{ paths: [], duplicate: n }`
  // — an aggregate that claimed the merged workstream kept nothing. `kept` must
  // be the length of the union the pass actually bounded.
  // The line only fires when the pass collapsed something, so the aggregate is
  // observed on a plan that DOES have duplicates across its folds: ten
  // workstreams, each re-declaring the eight `task-0` already holds.
  const ten = Array.from({ length: 10 }, (_, i) =>
    workstreamFromArgs(
      crowdedArgs(`task-${i}`, [...pathList(8, `src/t${i}`), ...pathList(8, "src/shared")]),
    ),
  );
  const { value: folded, traces } = captureTracesSync(() =>
    withMaxWorkstreams(1, () => foldToCeiling(ten)),
  );
  // 8 unique to each of the ten + the 8 shared ones = 88 kept, and the 72
  // repeats of the shared octet across the nine later workstreams collapsed.
  const kept = Object.values(folded)[0]?.paths.length ?? -1;
  const notice = boundLineOf(traces);
  assert(
    kept === 88 && Object.keys(folded).length === 1,
    `the ceiling fold keeps all 80 paths of the ten it absorbed (kept ${kept})`,
  );
  assert(
    notice !== undefined &&
      notice.includes(`— ${kept} kept`) === true &&
      !notice.includes(" — 0 kept") &&
      notice.includes("72 duplicates collapsed") === true,
    `the ceiling fold's line reports the real kept count, never 0 (got: ${notice?.trim()})`,
  );
  // The duplicate case, where the line actually fires: two workstreams whose
  // halves share 20 entries keep 20 and collapse 20, and the line says 20 kept.
  const dupPair = [
    workstreamFromArgs(crowdedArgs("task-a", pathList(20, "src/shared"))),
    workstreamFromArgs(
      crowdedArgs("task-b", [...pathList(20, "src/shared"), ...pathList(20, "src/b")]),
    ),
  ];
  const port = captureTracesSync(() =>
    foldPortPlan({ "task-a": dupPair[0], "task-b": dupPair[1] }, "o/r#9"),
  );
  const portLine = boundLineOf(port.traces) ?? "";
  // One line, and it carries the driver's own prefix: the tally sits between
  // the subject and the ceiling, and must not read as an empty workstream.
  assert(
    Object.values(port.value)[0]?.paths.length === 40 &&
      /port o\/r#9 fold paths bounded — 40 kept, 20 duplicates collapsed/.test(portLine) ===
        true &&
      !/ — 0 kept/.test(portLine),
    `the port fold's one line says 40 kept / 20 collapsed for a 40-path union (got: ${portLine.trim()})`,
  );
}

// ── 9. the bound's own primitives ──────────────────────────────────────────
{
  const b = boundPaths(["src/a.ts", "src/a.ts", "src/b.ts"]);
  assert(
    b.paths.length === 2 && b.duplicate === 1,
    `boundPaths collapses a whole-entry duplicate and counts it (got ${JSON.stringify(b)})`,
  );
  const notice = pathsBoundNotice("plan workstream 'task-a'", {
    kept: 60,
    duplicate: 2,
  });
  assert(
    notice.startsWith("work-driver: plan workstream 'task-a' paths bounded — ") &&
      notice.includes("60 kept") &&
      notice.includes("2 duplicates collapsed") &&
      notice.includes(`schema ceiling: ${WORKSTREAM_PATH_INPUT_LIST_MAX}`),
    `the notice names the subject, what was kept, what collapsed and the ceiling (got: ${notice})`,
  );
  assert(
    pathsBoundNotice("x", { kept: 1, duplicate: 1 }).includes("1 duplicate collapsed") &&
      pathsBoundNotice("x", { kept: 1, duplicate: 2 }).includes("2 duplicates collapsed"),
    "the tally pluralises on the count it prints",
  );
  // The subject carries planner-derived text (a workstream id, a port ref) and
  // reaches the fence bound's log channel, so it goes through the fence's
  // neutraliser: one line, no backticks, no forged clip marker.
  const forged = pathsBoundNotice(`task \`rm -rf /\`\nWARN work-driver: forged ${"…"}[clipped]`, {
    kept: 3,
    duplicate: 1,
  });
  assert(
    !forged.includes("`") &&
      !forged.includes("\n") &&
      forged.split("WARN work-driver:").length === 2 &&
      !forged.includes("[clipped]"),
    `a hostile subject cannot write its own log line or forge the clip marker (got: ${forged})`,
  );
  assert(
    normaliseDeclaredPath("src/a.ts (new)") === "src/a.ts",
    "the dedup key is the declared-path normaliser, the same identity findPathCollisions uses",
  );
}

process.exit(exit);
