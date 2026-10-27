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

import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import { withBoundaryDrops } from "../src/plan-fence-self-entry.ts";
import { runPlanNormalisationPass } from "../src/work-driver-plan-coupling-pass.ts";
import type { PlanUnfenceSummary } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";
import { planResultFromCalls } from "./lib/plan-workstream-calls.ts";
import { VALID } from "./lib/plan-outofscope-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Seven calls, one more than the ceiling of six, so the seventh FOLDS. The
 * folded call fences `src/a.ts`, which the surviving workstream declares: after
 * the union that file is the merged workstream's own scope, so the fold drops
 * the entry and records why. */
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
      outOfScope: ["src/0.ts", "src/extra.ts"],
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
const report = withMaxWorkstreams(4, () =>
  workstreamCallsOf(planResultFromCalls(callsBeyondCeiling())),
);

/** The merged workstream's scope annotation names the call the ceiling folded
 * away, and `task-0` — declared by that surviving workstream, fenced by the
 * absorbed one — is the entry the fold must have removed. Both together prove
 * the FOLD ran, which is the precondition every assertion below rests on (an
 * environment that pinned the ceiling higher would make the rest vacuous). */
function foldRan(): boolean {
  const merged = report.workstreams["task-3"];
  return (
    Object.keys(report.workstreams).length === 4 &&
    (merged?.scope.includes("+folded: task-4") ?? false) &&
    (merged?.paths.includes("src/0.ts") ?? false)
  );
}

// ── 1. the fold ran and reported its own removals
{
  assert(foldRan(), "the ceiling folded task-4 into task-3 (scope annotated, paths unioned)");
  const merged = report.workstreams["task-3"];
  assert(
    Object.keys(report.workstreams).length === 4 && report.accepted === 5,
    `five accepted calls folded to the ceiling of four (${Object.keys(report.workstreams).length})`,
  );
  assert(
    merged !== undefined && !merged.outOfScope.includes("src/0.ts"),
    `the fold removed the fence over the merged workstream's own declared file (got ${JSON.stringify(merged?.outOfScope)})`,
  );
  assert(
    merged !== undefined && merged.outOfScope.includes("src/extra.ts") === false,
    `the absorbed call's own-file fence went too — the boundary's rule, applied to its own call (got ${JSON.stringify(merged?.outOfScope)})`,
  );
  assert(
    (report.selfFenceDrops ?? []).some(
      (r) => r.entry === "src/0.ts" && r.workstream === "task-3",
    ),
    `the ceiling fold REPORTS the removal — a record naming the surviving workstream and the entry (got ${JSON.stringify(report.selfFenceDrops)})`,
  );
  assert(
    (report.boundaryDrops ?? []).every((r) => r.entry !== "src/0.ts"),
    `and the fold's own removal is not billed to the tool boundary's counter (boundary drops: ${JSON.stringify(report.boundaryDrops)})`,
  );
  assert(
    report.workstreams["task-3"]?.outOfScope.includes("docs/3.md") === true,
    `a fence over a path NO workstream declares survives the fold (got ${JSON.stringify(report.workstreams["task-3"]?.outOfScope)})`,
  );
}

// ── 2. the drop lands in the PERSISTED record, not only in the return value
{
  const summary = await persistThroughNormalisation(report);
  assert(
    summary?.ran === true && (summary.selfFences ?? 0) >= 1,
    `planQuality.unfence counts the ceiling fold's removals (got ${JSON.stringify(summary)})`,
  );
  assert(
    (summary?.notes ?? []).some(
      (n) => n.startsWith("self-fence dropped: ") && n.includes("src/0.ts"),
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
 * Run the plan step's normalisation over the reader's map — the same call
 * `runPlan` makes — and return the summary it would persist.
 */
async function persistThroughNormalisation(r: typeof report): Promise<
  PlanUnfenceSummary | undefined
> {
  const out = await runPlanNormalisationPass(r.workstreams, initialState(1862, 1), {
    repoRoot: "/repo",
    execFn: async () => ({ stdout: "" }),
  });
  return out.summary;
}

console.log(`\nexit ${exit}`);
process.exit(exit);
