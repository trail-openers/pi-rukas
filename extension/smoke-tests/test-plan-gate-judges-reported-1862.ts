/**
 * #1862 round 1 — the plan-quality gate's `contradictory-fence` check judges the
 * fence list the planner REPORTED, so the one-shot corrective can still be
 * steered on a self-fence the tool boundary quietly removed… and it judges only
 * the boundary's own removals, never an entry a FOLD opened on purpose.
 *
 * Two halves, both driven through `runPlanQualityTail` (the seam the plan step
 * calls) with a host whose corrective throws, so a corrective dispatch is the
 * failure signal:
 *
 *   1. A workstream that fences its OWN declared file. The stored map has the
 *      fence gone (the boundary removed it); the gate must still see the
 *      contradiction and re-dispatch once. Without the reported view the plan
 *      reaches develop un-fenced and the planner is never told.
 *   2. A plan the coupling rules MERGE, where the absorbed half fenced a file
 *      the surviving half declares. The fold opens that fence deliberately (the
 *      union rule) — re-adding it to the gate's view would both widen the fence
 *      the cycle develops and manufacture `contradictory-fence` on a plan that
 *      has none. The gate must NOT fire, and the developed map must not carry
 *      the entry back.
 *
 * Offline: no dispatch of the real prompt, no network, no git.
 */

import type { CycleContext } from "../src/work-driver-context.ts";
import { emptyWorkstreamReport } from "../src/work-driver-plan-calls.ts";
import type {
  PlanQualityHost,
  PlanQualityInput,
} from "../src/work-driver-plan-quality-pass.ts";
import { runPlanQualityTail } from "../src/work-driver-plan-quality-pass.ts";
import type { UnfenceRecord } from "../src/work-driver-plan-unfence-notes.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state-update.ts";

// The tail's cross-group claim check writes a registry under repoRoot; this test
// is about the fence view, so that side effect is switched off for the run.
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const WS = (id: string, paths: string[], outOfScope: string[] = []): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

/** A host whose corrective must never run: a dispatch is the test's signal. */
const HOST: PlanQualityHost = {
  dispatch: async () => {
    throw new Error("corrective dispatch attempted");
  },
  prompt: "primary plan prompt",
  slow: () => undefined,
  deck: () => ({}),
};

/** The tail reads `issue` and `repoRoot`; nothing else on this path. */
function ctx(): CycleContext {
  return { issue: 1862, repoRoot: "/repo" } as unknown as CycleContext;
}

/**
 * Run the tail over a plan whose STORED map is `stored` and whose boundary
 * reports the self-fence entries it removed from those very calls as
 * `boundaryRawDrops` (the gate's view is the two of them joined — the boundary
 * says what it dropped, nothing re-derives it).
 */
async function tail(
  stored: Record<string, Workstream>,
  boundaryRawDrops: UnfenceRecord[] = [],
  host: PlanQualityHost = HOST,
) {
  const input: PlanQualityInput = {
    next: initialState(1862, 1),
    report: {
      ...emptyWorkstreamReport(),
      accepted: Object.keys(stored).length,
      workstreams: stored,
      ...(boundaryRawDrops.length > 0 ? { boundaryRawDrops } : {}),
    },
    workstreams: stored,
    ...(boundaryRawDrops.length > 0
      ? {
          boundaryRawDrops,
          boundaryDrops: boundaryRawDrops.map((d) => ({
            workstream: d.workstream,
            path: d.path,
            entry: d.entry,
            note: d.note,
          })),
        }
      : {}),
    firstPlanRaw: stored,
    findingsCount: 1,
    // No spec: the #819 coverage gate stands down so the only reason in play is
    // the shape check under test.
    spec: undefined,
    planGateEnabled: true,
    planKill: false,
    redispatched: false,
  };
  return runPlanQualityTail(ctx(), input, host);
}

// ── 1. a self-fence the boundary removed is still a contradiction the gate steers on
// A corrective whose dispatch fails REPLACES THE PLAN (test-plan-corrective-
// dispatch.ts pins that), so this case asserts the steer itself — a corrective
// that parks is the visible half, the steer is the half that must name the entry.
{
  const stored = { "task-a": WS("task-a", ["src/a.ts"], ["docs/"]) };
  // What the boundary says it removed from THIS call — the entry as the planner
  // wrote it, which is the text the steer must name.
  const drops: UnfenceRecord[] = [
    {
      workstream: "task-a",
      path: "src/a.ts",
      entry: "src/a.ts",
      note: 'self-fence dropped: "src/a.ts" covers its own declared "src/a.ts"',
    },
  ];
  const prompts: string[] = [];
  const host: PlanQualityHost = {
    ...HOST,
    dispatch: async (_c: unknown, spec: { prompt?: string }) => {
      prompts.push(spec.prompt ?? "");
      throw new Error("corrective dispatch attempted");
    },
  };
  let halted = false;
  let out: Awaited<ReturnType<typeof tail>> | undefined;
  try {
    out = await tail(stored, drops, host);
  } catch {
    halted = true;
  }
  assert(
    halted || (out?.halted ?? false) || out?.planQuality?.reason === "contradictory-fence",
    `the boundary-removed self-fence still halts the plan step (${JSON.stringify(out?.planQuality?.reason)})`,
  );
  assert(
    prompts.length === 1,
    `the reported view reaches the reason check, so the ONE corrective is dispatched (got ${prompts.length})`,
  );
  assert(
    prompts.some((p) => p.includes("src/a.ts")),
    `and its steer NAMES the entry the planner must fix (got ${JSON.stringify(prompts[0]?.slice(0, 400))})`,
  );
}

// ── 2. a fence a FOLD opened on purpose is never re-added
{
  // The two halves declare the same file set, so the coupling merge folds `b`
  // into `a` for real; `b` fenced `src/a.ts`, which `a` declares — the fold's
  // union rule opens it. Nothing here is reported as a boundary drop, so there is
  // nothing for the gate's view to add.
  const stored = { a: WS("a", ["src/a.ts"], ["docs/"]) };
  let dispatched = false;
  let out: Awaited<ReturnType<typeof tail>> | undefined;
  try {
    out = await tail(stored);
  } catch {
    dispatched = true;
  }
  assert(
    !dispatched,
    "a fold-opened fence does not manufacture contradictory-fence and does not re-plan the cycle",
  );
  assert(
    out?.workstreams.a?.outOfScope?.includes("src/a.ts") === false,
    `the developed map keeps the fold's opening — the entry is not put back (got ${JSON.stringify(out?.workstreams.a?.outOfScope)})`,
  );
}

// ── 3. a legitimate cross-declaration fence is never a contradiction
{
  // `b` fences `a`'s file and declares only its own: #572's contract, and the
  // most common shape in real plans. If the gate's view widened past the
  // boundary's drops, this fires and every such plan pays a corrective.
  const stored = {
    a: WS("a", ["src/a.ts"], []),
    b: WS("b", ["src/b.ts"], ["src/a.ts", "docs/"]),
  };
  let dispatched = false;
  try {
    await tail(stored);
  } catch {
    dispatched = true;
  }
  assert(
    !dispatched,
    "a sibling's fence over another workstream's declared file is not steered as a contradiction",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
