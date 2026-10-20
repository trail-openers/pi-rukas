#!/usr/bin/env bun
/**
 * #1642 run 6b — the plan-to-spec gate must not demand a path no plan may
 * declare, measured on the #1557 false refusal.
 *
 * The incident (VERIFIED on disk, `.pi/work-state/1557.json` + the two
 * preserved plan artifacts `.pi/work-state/1557/mvh1eqji-ngygqa-explore.txt`
 * and `mvh1hoxg-y3109x-explore.txt`): the spec's d1 declared four concrete
 * files PLUS `extension/src/review-ledger-*.ts` — the split the 500-line
 * ratchet forces — and BOTH plan replies declared all four concrete files
 * ("`paths` is the strict union of the three deliverables' concrete declared
 * files"). The gate parked the cycle with
 *
 *   plan-spec-mismatch — no workstream in this plan declares any path of 1
 *   deliverable(s) the spec requires: d1 (… , extension/src/review-ledger-*.ts)
 *
 * twice: the primary, then the one-shot corrective, then handoff. Nothing was
 * written; the cycle cost two planning dispatches.
 *
 * Why no plan could pass: a `report_workstream` `paths` entry must pass
 * `plannedPathProblem`, which refuses `* ? !` outright, so the planner is
 * FORBIDDEN from naming the glob; and `declaredPathsCoveredBy` runs its
 * template rule only pool→declaration, so a concrete pool entry (a real
 * `review-ledger-render.ts`) cannot cover a glob declaration either. The slot
 * was un-coverable by construction, and the single-workstream repair declined
 * it too (`work-driver-plan-repair.ts`: "not a single measurable file path").
 *
 * The rule this test pins: a slot no plan may declare is EXEMPT from the
 * requirement — it never blocks coverage and never appears in the uncovered
 * row. Everything else about the gate is unchanged: the concrete half of the
 * same deliverable is still demanded slot by slot, a glob-matching sibling
 * still covers nothing, and the glob stays measured at converge where a real
 * diff can answer it.
 *
 * Offline: pure functions over (workstreams, spec). No dispatch, no git, no fs.
 */

import { repairOmittedDeliverablePaths } from "../src/work-driver-plan-repair.ts";
import {
  findUncoveredDeliverables,
  planDeclarableSlot,
  planSpecMismatchReason,
} from "../src/work-driver-plan-spec-coverage.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ws = (paths: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(paths).map(([id, p]) => [id, { paths: p }]));

const D1_CONCRETE = [
  "extension/src/adversarial.ts",
  "extension/src/adversarial-ledger-capture.ts",
  "extension/src/adversarial-ledger.ts",
  "extension/src/review-ledger.ts",
];
const D1_GLOB = "extension/src/review-ledger-*.ts";
const D2 = "extension/smoke-tests/lib/arms/loop-behaviour.ts";
const D3 = [
  "extension/smoke-tests/test-review-ledger.ts",
  "extension/smoke-tests/test-adversarial-ledger-row-identity.ts",
  D2,
];

/** The spec exactly as `pipelineState.normalisedSpec.deliverables` stored it. */
const SPEC_1557 = {
  deliverables: [
    { id: "d1", description: "identity threading", paths: [...D1_CONCRETE, D1_GLOB] },
    { id: "d2", description: "identity-based row selection", paths: [D2] },
    { id: "d3", description: "pinning the identification strategy", paths: D3 },
  ],
};

/** The plan both replies reported: the strict union of the concrete files. */
const PLAN_1557 = ws({ default: [...D1_CONCRETE, D2, ...D3] });

// ------------------------------------------- the #1557 false refusal, pinned

{
  const r = findUncoveredDeliverables(PLAN_1557, SPEC_1557, []);
  assert(
    r.uncovered.length === 0,
    "#1557: the plan both replies actually reported covers d1–d3 (no uncovered row)",
  );
  assert(
    r.checkedCount === 3,
    "#1557: all three deliverables are still JUDGED — the exemption drops a slot, not the deliverable",
  );
  assert(
    planSpecMismatchReason(PLAN_1557, SPEC_1557, []) === undefined,
    "#1557: the gate does not reject the honest plan (pre-fix this returned kind=uncovered-deliverables on d1)",
  );
}

// ------------------------------------- what is declarable, and what is not

{
  assert(
    planDeclarableSlot(D1_GLOB) === false,
    "a `*` slot is not declarable: plannedPathProblem refuses `* ? !` in a report_workstream paths entry",
  );
  assert(
    planDeclarableSlot("extension/src/work-driver-<name>.ts") === false,
    "a `<name>` template slot is not declarable either (the #1137 shape the repair also refuses to write)",
  );
  assert(
    planDeclarableSlot("extension/src/adversarial.ts") === true,
    "a concrete file slot stays declarable",
  );
  assert(
    planDeclarableSlot("extension/src") === true,
    "a directory slot stays declarable (the #819 ownership claim a plan CAN make)",
  );
  assert(
    planDeclarableSlot("src/a.ts or src/new-*.ts") === true,
    "a slot with ONE concrete alternative among several stays declarable — declaring the concrete half covers it",
  );
  assert(
    findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
      deliverables: [{ id: "d1", paths: ["src/a.ts or src/new-*.ts"] }],
    }, []).uncovered.length === 0,
    "and such a slot IS covered by the plan that declared only its concrete half",
  );
}

// ---------------------------- the exemption must not WIDEN what counts as covered

{
  const globOnly = ws({ default: ["extension/src/review-ledger-render.ts"] });
  const r = findUncoveredDeliverables(globOnly, SPEC_1557, []);
  assert(
    r.uncovered.some((u) => u.id === "d1"),
    "a glob-matching sibling does NOT stand in for the concrete slots: d1 stays uncovered",
  );
  assert(
    !(r.uncovered.find((u) => u.id === "d1")?.paths ?? []).includes(D1_GLOB),
    "and the uncovered row names only the four declarable slots — never the glob the planner may not write",
  );
  assert(
    (r.uncovered.find((u) => u.id === "d1")?.paths ?? []).length === D1_CONCRETE.length,
    "the row carries exactly the concrete half of the deliverable",
  );
}

{
  // EVERY-path over the concrete slots is unchanged: omitting one real file is
  // still a refusal, with or without a glob in the same deliverable.
  const omitted = D1_CONCRETE.slice(1);
  const r = findUncoveredDeliverables(ws({ default: [...omitted, D2, ...D3] }), SPEC_1557, []);
  assert(
    r.uncovered.length === 1 && r.uncovered[0]?.id === "d1",
    "a plan that really did omit one concrete file is still refused (the gate keeps its bite)",
  );
  assert(
    planSpecMismatchReason(ws({ default: [...omitted, D2, ...D3] }), SPEC_1557, [])?.kind ===
      "uncovered-deliverables",
    "and the refusal still reaches the cap for a genuine omission",
  );
}

{
  // A fabricated plan (#818's shape) is still refused even when the spec's
  // deliverable mixes concrete paths with a glob: the exemption exempts a
  // slot, it never rescues a plan that names none of the real work.
  const fabricated = ws({
    "task-bun": ["extension/bunfig.toml", "extension/bun.lock"],
    "task-install": ["install.sh"],
  });
  assert(
    planSpecMismatchReason(fabricated, SPEC_1557, [])?.kind === "uncovered-deliverables",
    "#818 still stops: a plan naming none of the deliverable's concrete files is refused despite the exempt glob",
  );
}

// --------------------------------------------- an all-template deliverable

{
  const SPEC = {
    deliverables: [
      { id: "d1", paths: ["extension/src/work-driver-<name>.ts", "extension/src/review-ledger-*.ts"] },
    ],
  };
  const r = findUncoveredDeliverables(ws({ a: ["src/anything.ts"] }), SPEC, []);
  assert(
    r.checkedCount === 0 && r.uncovered.length === 0,
    "a deliverable whose every slot is a template has nothing a plan could declare: 0 judged, 0 uncovered",
  );
  assert(
    planSpecMismatchReason(ws({ a: ["src/anything.ts"] }), SPEC, []) === undefined,
    "and the gate is silent about it (silence = nothing to judge, never a pass it earned)",
  );
  // A real deliverable beside it is still judged.
  const mixedSpec = {
    deliverables: [
      { id: "d1", paths: ["extension/src/review-ledger-*.ts"] },
      { id: "d2", paths: ["src/real.ts"] },
    ],
  };
  const mixed = findUncoveredDeliverables(ws({ a: ["src/other.ts"] }), mixedSpec, []);
  assert(
    mixed.checkedCount === 1 && mixed.uncovered.length === 1 && mixed.uncovered[0]?.id === "d2",
    "one exempt deliverable does not blind the gate to the deliverable it CAN judge",
  );
}

// ------------------------- the repair no longer declines on the exempt slot

{
  // Pre-fix this repair DECLINED outright: the uncovered row carried the glob
  // and `work-driver-plan-repair.ts` refuses a slot that is not a single
  // measurable file path, so one template poisoned the repair for the whole
  // deliverable and the cycle fell through to the corrective and then the cap.
  const omitted = D1_CONCRETE.slice(1);
  const refusals: string[] = [];
  const repaired = repairOmittedDeliverablePaths(
    {
      default: {
        id: "default",
        scope: "identity threading",
        paths: [...omitted, D2, ...D3],
        outOfScope: [],
      },
    },
    SPEC_1557,
    [],
    (reason) => refusals.push(reason),
  );
  assert(
    repaired !== undefined,
    "the single-workstream repair now runs instead of declining on the glob slot",
  );
  assert(
    repaired?.added.join(",") === "extension/src/adversarial.ts",
    "and appends exactly the one omitted concrete file, not the template",
  );
  assert(
    refusals.length === 0,
    `the repair reports no refusal (got: ${JSON.stringify(refusals)})`,
  );
  assert(
    planSpecMismatchReason(repaired?.workstreams ?? {}, SPEC_1557, []) === undefined,
    "the repaired plan passes the gate, so the one-shot corrective is never spent",
  );
}

process.exit(exit);
