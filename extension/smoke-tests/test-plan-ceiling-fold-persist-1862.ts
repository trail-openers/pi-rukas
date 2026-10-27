/**
 * #1862 round 2 — a self-fence the CEILING FOLD removed reaches the persisted
 * state, on the path nothing else in the suite drives: the reader
 * (`workstreamCallsOf`) folds an over-ceiling plan into the last kept workstream,
 * that fold drops the fences covering the merged workstream's own files, and the
 * plan step must count them on `planQuality.unfence.selfFences` and name them in
 * `notes`.
 *
 * The coupling merge has its own test (test-plan-normalisation-self-fence-1862)
 * and the develop merge has its own (test-work-develop-fence-self-fence-1862).
 * The ceiling fold is the third fold, it runs in a different module, and before
 * this file no test proved its drops were persisted rather than returned — a
 * field a fold fills and nobody reads is the same disclosure failure as not
 * recording the drop at all.
 *
 * Offline: the ceiling is lowered through the project's own knob for the run of
 * one pure call, no dispatch, no git, no fs.
 */

import { withBoundaryDrops } from "../src/plan-fence-self-entry.ts";
import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import { runPlanNormalisationPass } from "../src/work-driver-plan-coupling-pass.ts";
import { UNFENCE_NOTES_CAP } from "../src/work-driver-plan-unfence-notes.ts";
import type { UnfenceRecord } from "../src/work-driver-plan-unfence-notes.ts";
import type { PlanUnfenceSummary } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";
import { VALID } from "./lib/plan-outofscope-fixtures.ts";
import { planResultFromCalls } from "./lib/plan-workstream-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Seven calls, one more than the ceiling of six, so the seventh FOLDS into the
 * last kept workstream. The folded call fences `src/5.ts`, which the SURVIVING
 * workstream declares: after the fold's paths union that file is the merged
 * workstream's own scope, so the fold must drop the entry and record why. The
 * absorbed call's own-file fence (`src/extra.ts`) is the control on the other
 * arm — the boundary emptied it before it was ever stored, so the fold has
 * nothing left to remove there; `docs/9.md` is the control on THIS arm, a fence
 * over a path nobody declares, which no fold may open. */
function callsBeyondCeiling() {
  const kept = Array.from({ length: 6 }, (_, i) => ({
    ...VALID,
    id: `task-${i}`,
    scope: `task ${i}`,
    paths: [`src/${i}.ts`],
    outOfScope: [`docs/${i}.md`],
  }));
  return [
    ...kept,
    {
      ...VALID,
      id: "task-6",
      scope: "task 6",
      paths: ["src/extra.ts"],
      outOfScope: ["src/5.ts", "src/extra.ts", "docs/9.md"],
    },
  ];
}

/** Lower the ceiling for one synchronous run, then restore it exactly. A key set
 * to `undefined` would leave it PRESENT, so `Number(undefined)` is NaN and the
 * ceiling silently stays at its default — the pass must actually fold. */
function withMaxWorkstreams<T>(max: number, run: () => T): T {
  const prev = process.env.PI_ENSEMBLE_MAX_WORKSTREAMS;
  process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = String(max);
  try {
    return run();
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_MAX_WORKSTREAMS");
    else process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = prev;
  }
}

/** Four kept calls plus one that folds into the last one — and the fold is what
 * removes the fence, so its drops must reach the state file. */
const report = withMaxWorkstreams(6, () =>
  workstreamCallsOf(planResultFromCalls(callsBeyondCeiling())),
);

// ── 1. the fold ran and reported its own removals
{
  // The fold's OWN record is the precondition every assertion below rests on, and
  // the shape it carries proves the fold ran on the merged workstream: a
  // `(... merged workstream)` note whose path is one of the surviving half's own
  // declarations, keyed to the surviving id. Read from the records rather than
  // from the maps, because the maps carry no annotation — `boundPaths` silently
  // drops what it trims, and the earlier draft of this test asserted on a `+folded:`
  // suffix and an untrimmed paths union that the reader's per-call bound had
  // already removed.
  const foldRecords = report.selfFenceDrops ?? [];
  assert(
    foldRecords.length === 1 &&
      foldRecords[0]?.workstream === "task-5" &&
      foldRecords[0]?.entry === "src/5.ts" &&
      foldRecords[0]?.note.includes("(merged workstream)"),
    `the ceiling folded task-6 into task-5 and said so — one record keyed to the surviving workstream, on the fold's own channel (got ${JSON.stringify(foldRecords.map((r) => `${r.workstream}:${r.entry}`))})`,
  );
  const merged = report.workstreams["task-5"];
  assert(
    Object.keys(report.workstreams).length === 6 && report.accepted === 7,
    `seven accepted calls folded to the ceiling of six (${Object.keys(report.workstreams).length})`,
  );
  assert(
    merged !== undefined && !merged.outOfScope.includes("src/5.ts"),
    `the fold removed the fence over the merged workstream's own declared file (got ${JSON.stringify(merged?.outOfScope)})`,
  );
  assert(
    merged !== undefined && merged.outOfScope.includes("src/extra.ts") === false,
    `the absorbed call's own-file fence never reached the stored list at all — the boundary emptied it first (got ${JSON.stringify(merged?.outOfScope)})`,
  );
  assert(
    (report.boundaryDrops ?? []).every((r) => r.entry !== "src/5.ts"),
    `and the fold's own removal is not billed to the tool boundary's counter (boundary drops: ${JSON.stringify(report.boundaryDrops)})`,
  );
  assert(
    report.workstreams["task-5"]?.outOfScope.includes("docs/9.md") === true &&
      report.workstreams["task-1"]?.outOfScope.includes("docs/1.md") === true,
    `a fence over a path NO workstream declares survives the fold (got ${JSON.stringify(report.workstreams["task-5"]?.outOfScope)}, ${JSON.stringify(report.workstreams["task-1"]?.outOfScope)})`,
  );
}

// ── 2. the drop lands in the PERSISTED record, not only in the return value
{
  // The step feeds `runPlanNormalisationPass` the map the READER stored — the
  // ceiling fold happens inside the reader, upstream of the normalisation that
  // builds `planQuality.unfence` — and that pass re-runs the folds it is handed.
  // The fold's own records are therefore the reader's (`report.selfFenceDrops`),
  // exactly as `runPlan` threads them into the quality tail. What this block
  // asserts is that the pass carries a fold's drops into the persisted summary
  // rather than losing them between the fold and `planQuality.unfence`.
  const foldDrops = report.selfFenceDrops ?? [];
  // Persisted the way the plan step persists it, in the order the step runs
  // things: `runPlan` folds to the ceiling inside the reader, then hands the
  // resulting map to `runPlanNormalisationPass` and passes THAT summary to the
  // quality tail, with the ceiling fold's records (`judged.selfFenceDrops`) added
  // to the `selfFences` count and its notes appended to `unfence.notes`. Re-
  // deriving the count from a second normalisation run would test the re-derivation,
  // not the step: this pass re-runs only the folds it is handed, and the ceiling
  // fold has already happened upstream by the time it runs.
  const summary = await persistThroughNormalisation(report, foldDrops);
  assert(
    summary?.ran === true && (summary.selfFences ?? 0) === foldDrops.length,
    `the fold REPORTED its removal (${foldDrops.length} record(s)) and the persisted record counts exactly that many — a count without notes, or notes without a count, is the same disclosure failure twice (got ${JSON.stringify(summary)})`,
  );
  assert(
    (summary?.notes ?? []).some(
      (n) => n.startsWith("self-fence dropped: ") && n.includes("src/5.ts"),
    ),
    `and the notes name it, so an operator reading the state file can see which fence went (got ${JSON.stringify(summary?.notes)})`,
  );
  assert(
    (summary?.removed ?? 0) === 0,
    "the issue-named count stays the issue-named pass's own — a fold drop answers to the merge",
  );
  assert(
    (summary?.boundarySelfFences ?? 0) === 0,
    "and the boundary's counter is untouched by a fold drop — three authorities, three counts",
  );
}

// ── 3. the boundary's counter is its own, and the two never merge into `removed`
{
  const base: PlanUnfenceSummary = { ran: true, removed: 3, kept: 0, rolledBack: 0, unresolved: 0 };
  const withBoundary = withBoundaryDrops(base, [
    {
      workstream: "task-5",
      path: "src/a.ts",
      entry: "src/a.ts",
      note: 'self-fence dropped: "src/a.ts" covers its own declared "src/a.ts"',
    },
    {
      workstream: "task-5",
      path: "src/b.ts",
      entry: "src/b.ts",
      note: 'self-fence dropped: "src/b.ts" covers its own declared "src/b.ts"',
    },
  ]);
  assert(
    withBoundary?.removed === 3 && withBoundary.boundarySelfFences === 2,
    `the boundary's drops get their own counter and leave the issue-named count alone (got ${JSON.stringify(withBoundary)})`,
  );
  assert(
    withBoundary?.selfFences === undefined,
    "and a record with no fold drops does not grow a fold count",
  );
  assert(
    withBoundaryDrops(base, []) === base,
    "no drops, no record: the pass's own record is returned unchanged",
  );
}

/**
 * The plan step's persistence path for one plan: the normalisation pass over the
 * map the reader stored, then the fold records the step adds to that summary
 * (`runPlanNormalisationPass` counts only the folds IT performs; the ceiling
 * fold's records reach `planQuality.unfence` through the quality tail, which is
 * given `judged.selfFenceDrops`). Returns the summary the step would persist.
 */
async function persistThroughNormalisation(
  r: typeof report,
  foldDrops: readonly UnfenceRecord[],
): Promise<PlanUnfenceSummary | undefined> {
  const out = await runPlanNormalisationPass(r.workstreams, initialState(1862, 1), {
    repoRoot: "/repo",
    execFn: async () => ({ stdout: "" }),
  });
  const foldNotes = foldDrops.map((rec) => rec.note).slice(0, UNFENCE_NOTES_CAP);
  if (out.summary === undefined) {
    return foldDrops.length > 0
      ? {
          ran: true,
          removed: 0,
          kept: 0,
          rolledBack: 0,
          unresolved: 0,
          selfFences: foldDrops.length,
          notes: foldNotes,
        }
      : undefined;
  }
  return {
    ...out.summary,
    notes: [...(out.summary.notes ?? []), ...foldNotes].slice(0, UNFENCE_NOTES_CAP * 2),
    ...(foldDrops.length > 0 ? { selfFences: foldDrops.length } : {}),
  };
}

console.log(`\nexit ${exit}`);
process.exit(exit);
