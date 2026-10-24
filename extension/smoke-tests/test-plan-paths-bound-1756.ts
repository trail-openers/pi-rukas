#!/usr/bin/env bun
/**
 * #1756 part (b) — a crowded `paths` list is BOUNDED for display, never a
 * reason to refuse a whole workstream's `report_workstream` call.
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
 * whole list.
 *
 *   1. the schema accepts 51 and 500 declared paths and refuses only 501 (the
 *      abuse ceiling), while a 301-character path is still refused per entry;
 *   2. `workstreamFromArgs` keeps all 80, records `pathsDropped = 30`, emits
 *      ONE trace line, and the call is not refused;
 *   3. the fanout gate's denominator is the FULL list — 80 declared paths buy
 *      a limit of 240, and undeclared files past that still fail;
 *   4. a collision in the undisplayed tail (paths 51-80) still fires
 *      `findPathCollisions`;
 *   5. a deferred protected path in the tail is still removed by
 *      `withDeferredProtectedFence`;
 *   6. a fold of 40 + 40 keeps all 80 with the merged display count, and never
 *      truncates;
 *   7. the develop prompt shows the "(+N more declared paths in scope…)" note
 *      only when the workstream declared more than it shows; otherwise the line
 *      is byte-identical to what it rendered before this change.
 */

import { Value } from "@sinclair/typebox/value";
import { quotedPaths } from "../src/plan-path-shape.ts";
import { boundPaths, inScopeFilesLine, pathsBoundNotice } from "../src/plan-paths-bound.ts";
import {
  WORKSTREAM_LIST_MAX,
  WORKSTREAM_PARAMETERS,
  WORKSTREAM_PATH_INPUT_LIST_MAX,
  WORKSTREAM_PATH_MAX,
  workstreamCallRefusal,
  workstreamPathProblem,
} from "../src/plan-workstream-schema.ts";
import { correctiveDevelopPrompt } from "../src/work-driver-corrective-prompt.ts";
import { normaliseDeclaredPath } from "../src/work-driver-declared-path.ts";
import { withDeferredProtectedFence } from "../src/work-driver-plan-fence.ts";
import { findPathCollisions } from "../src/work-driver-plan-paths.ts";
import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { foldTwo } from "../src/workstream-fold.ts";
import { VALID_ARGS, crowdedArgs, pathList } from "./lib/plan-paths-fixtures.ts";
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

// ── 1. the schema accepts a crowded plan and refuses only what no plan is ────
{
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID_ARGS,
      paths: pathList(WORKSTREAM_LIST_MAX + 1),
    }) === true,
    `a ${WORKSTREAM_LIST_MAX + 1}-path list is ACCEPTED (it used to refuse the whole call)`,
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID_ARGS,
      paths: pathList(WORKSTREAM_PATH_INPUT_LIST_MAX),
    }) === true,
    `the abuse ceiling itself is accepted (${WORKSTREAM_PATH_INPUT_LIST_MAX} paths)`,
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...VALID_ARGS,
      paths: pathList(WORKSTREAM_PATH_INPUT_LIST_MAX + 1),
    }) === false,
    `past the ceiling (${WORKSTREAM_PATH_INPUT_LIST_MAX}) the call IS refused — a runaway reply is not a plan`,
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

// ── 3. workstreamFromArgs keeps every path, records the display count, one trace
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
    stored.pathsDropped === 30,
    `pathsDropped records what the prompt will not print (got ${stored.pathsDropped})`,
  );
  const notices = traces.filter((t) => t.includes("paths bounded"));
  assert(notices.length === 1, `exactly one trace line per bounded call (got ${notices.length})`);
  assert(
    notices[0]?.includes("80 kept") === true &&
      notices[0]?.includes("30 paths past the 50-path prompt display") === true,
    `the trace says what was kept and what is merely undisplayed (got: ${notices[0]?.trim()})`,
  );
  assert(
    notices[0]?.includes("all still in scope") === true,
    "the trace says plainly that nothing lost its authorisation",
  );
}

{
  // A list the prompt shows in full records nothing and says nothing.
  const { value: small, traces } = captureTracesSync(() =>
    workstreamFromArgs(crowdedArgs("task-a", pathList(5))),
  );
  assert(
    small.pathsDropped === undefined &&
      traces.filter((t) => t.includes("paths bounded")).length === 0,
    "a 5-path plan records no display count and emits no bound line",
  );
  assert(
    !("pathsDropped" in small),
    "and the key is ABSENT, so the workstream keeps the pre-#1756 shape",
  );
}

{
  // Duplicates collapse on the NORMALISED identity, and the raw string is what
  // is stored: the annotation is prose the consolidation normaliser strips.
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
}

// ── 4. the fanout denominator is the FULL list, not the displayed 50 ────────
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

// ── 5. a collision in the undisplayed tail still fires ──────────────────────
{
  const a = pathList(80, "src/a");
  // The collision sits at index 55 of b's list — past what any prompt shows.
  const b = pathList(80, "src/b");
  b[55] = "src/a-77.ts";
  const collisions = findPathCollisions({ "task-a": { paths: a }, "task-b": { paths: b } });
  assert(
    collisions.some((c) => c.path === "src/a-77.ts"),
    `a collision in the undisplayed tail (paths 51-80) still fires findPathCollisions (got ${JSON.stringify(collisions)})`,
  );
}

// ── 6. a deferred protected path in the tail is still removed ───────────────
{
  const paths = pathList(80, "src/mod");
  const tailPath = "src/mod-63.ts";
  assert(paths.includes(tailPath), "the fixture's protected path is past the display bound");
  const fenced = withDeferredProtectedFence({ "task-a": ws("task-a", [...paths]) }, [tailPath]);
  const kept = fenced["task-a"];
  assert(
    kept?.paths.includes(tailPath) === false,
    "the deferred protected path in the undisplayed tail is still removed from paths",
  );
  assert(
    kept?.paths.length === 79 && kept?.outOfScope.includes(tailPath) === true,
    `and it is fenced in outOfScope (paths ${kept?.paths.length}, fence ${JSON.stringify(kept?.outOfScope)})`,
  );
  assert(
    kept?.pathsDropped === 29,
    `the display count is recomputed for the list the fence actually stores — 79 kept, so 29 are undisplayed, not the 30 the 80-path list implied (got ${kept?.pathsDropped})`,
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
    merged.pathsDropped === 30,
    `the merged list carries its OWN display count, not either half's (got ${merged.pathsDropped})`,
  );
  assert(
    a.pathsDropped === undefined && b.pathsDropped === undefined,
    "neither half at 40 paths had a display count to begin with",
  );
  // The fold's self-fence rule still reads the whole union: an entry naming one
  // of the absorbed half's tail files is dropped, because it is now in scope.
  const tailFile = pathList(40, "src/b")[37];
  const selfFenced = foldTwo(a, { ...b, outOfScope: [tailFile, "the docs folder"] });
  assert(
    selfFenced.outOfScope.includes(tailFile) === false &&
      selfFenced.outOfScope.includes("the docs folder") === true,
    "the fold still drops a self-fence that names a merged path from the undisplayed tail",
  );
}

// ── 8. the develop prompt: the note appears only when paths are undisplayed ─
{
  const eighty = pathList(80);
  const crowded = workstreamFromArgs(crowdedArgs("task-a", eighty));
  const prompt = inlineDevelopPrompt([1756], "/tmp/scratch", crowded, "task-a");
  const inScopeLine = prompt.split("\n").find((l) => l.startsWith("In-scope files:")) ?? "";
  assert(
    inScopeLine.includes(
      "(+30 more declared paths in scope; read the plan list before adding new files)",
    ),
    "the develop prompt says the rest exists and where to read it",
  );
  assert(
    inScopeLine.includes(JSON.stringify(eighty[0])) &&
      !inScopeLine.includes(JSON.stringify(eighty[50])),
    "and it prints the first 50 quoted, not the tail",
  );
  const shownCount = (inScopeLine.match(/"src\/mod-/g) ?? []).length;
  assert(shownCount === 50, `exactly ${WORKSTREAM_LIST_MAX} paths are printed (got ${shownCount})`);

  // Byte-identical when nothing is hidden: the line is what quotedPaths renders.
  const small = workstreamFromArgs(crowdedArgs("task-b", pathList(5)));
  const smallLine =
    inlineDevelopPrompt([1756], "/tmp/scratch", small, "task-b")
      .split("\n")
      .find((l) => l.startsWith("In-scope files:")) ?? "";
  assert(
    smallLine === `In-scope files: ${quotedPaths(small.paths)}`,
    "with no display drop the line is byte-identical to the previous rendering",
  );
  assert(
    inScopeFilesLine(small.paths, 0) === quotedPaths(small.paths),
    "inScopeFilesLine with dropped = 0 is quotedPaths exactly",
  );
  assert(
    inScopeFilesLine([], 0) === "",
    "an empty list renders the empty string, as quotedPaths always did",
  );
}

{
  // The corrective round reads the same count, so a repair round is not told a
  // shorter scope than the first pass was.
  const crowded = workstreamFromArgs(crowdedArgs("task-a", pathList(80)));
  const corrective = correctiveDevelopPrompt({
    issues: [1756],
    scratchDirAbs: "/tmp/scratch",
    workstreamId: "task-a",
    parallel: false,
    scope: crowded.scope,
    paths: crowded.paths,
    pathsDropped: crowded.pathsDropped,
    command: "bun test",
    lines: ["assertion failed"],
    outOfScope: [],
  });
  assert(
    corrective.includes(
      "(+30 more declared paths in scope; read the plan list before adding new files)",
    ),
    "the corrective prompt shows the same note the develop prompt showed",
  );
  const plain = correctiveDevelopPrompt({
    issues: [1756],
    scratchDirAbs: "/tmp/scratch",
    workstreamId: "task-b",
    parallel: false,
    scope: "the fix",
    paths: pathList(3),
    command: "bun test",
    lines: ["assertion failed"],
    outOfScope: [],
  });
  assert(
    plain.includes(`In-scope files: ${quotedPaths(pathList(3))}`) &&
      !plain.includes("more declared paths in scope"),
    "and stays as it was for a workstream whose paths all fit on the line",
  );
}

// ── 9. the bound's own primitives ───────────────────────────────────────────
{
  const b = boundPaths(["src/a.ts", "src/a.ts", "src/b.ts"]);
  assert(
    b.paths.length === 2 && b.duplicate === 1 && b.dropped === 0,
    `boundPaths collapses a whole-entry duplicate and counts it (got ${JSON.stringify(b)})`,
  );
  const notice = pathsBoundNotice("plan workstream 'task-a'", {
    paths: pathList(60),
    dropped: 10,
    duplicate: 2,
  });
  assert(
    notice.startsWith("work-driver: plan workstream 'task-a' paths bounded — ") &&
      notice.includes("kept") &&
      notice.includes("prompt display"),
    `the notice names the subject, what was kept and why the rest is only undisplayed (got: ${notice})`,
  );
  assert(
    normaliseDeclaredPath("src/a.ts (new)") === "src/a.ts",
    "the dedup key is the declared-path normaliser, the same identity findPathCollisions uses",
  );
}

process.exit(exit);
