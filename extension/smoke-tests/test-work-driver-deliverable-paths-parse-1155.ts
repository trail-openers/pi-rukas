#!/usr/bin/env bun
/**
 * #1155 — the `[paths:]` grammar, from the parser side. Split from
 * test-work-driver-converge-alternatives-1155.ts (the converge-gate side) to
 * keep both files under the 500-line cap.
 *
 *   - `parseDeliverables` via `parseNormalisedSpec` — the `[paths:]` slot
 *     splits on comma AND on ` or ` / ` OR ` / `|`.
 *   - `findUncoveredDeliverables` (the #819 plan-to-spec gate) — the SAME
 *     parsing, so the two gates cannot disagree about one `[paths:]` slot.
 *
 * Offline: pure functions. No git, no dispatch, no fs.
 */

import { classifyDeliverables } from "../src/work-driver-converge.ts";
import { splitDeliverablePaths } from "../src/work-driver-deliverable-paths.ts";
import { parseNormalisedSpec } from "../src/work-driver-intent.ts";
import { findUncoveredDeliverables } from "../src/work-driver-plan-spec-coverage.ts";

/** The #1137 deliverable d2 exactly as the planner wrote it. */
const D1137 = "extension/src/work-driver-verify.ts or new work-driver-<name>.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
// ------------------- the parser: `[paths:]` splits alternatives ---------------

function specWith(pathsSlot: string): string {
  return [
    "INTENT-VERDICT: proceed",
    "",
    "## Spec",
    "",
    "### Intent",
    "do the thing",
    "",
    "### Deliverables",
    `- d1: the thing [paths: ${pathsSlot}]`,
    "",
    "### Acceptance criteria",
    "- it works",
    "",
    "### Evidence",
    "- claim — src.ts — confirmed",
  ].join("\n");
}

{
  const spec = parseNormalisedSpec(specWith(D1137));
  assert(
    spec?.deliverables[0]?.paths.length === 2 &&
      spec.deliverables[0].paths[0] === "extension/src/work-driver-verify.ts" &&
      spec.deliverables[0].paths[1] === "new work-driver-<name>.ts",
    "parseDeliverables: an ` or ` slot becomes TWO paths, not one comma-list string",
  );
  // The template stays the planner's text — the glob form is a matching-time
  // concept, so downstream prose (plan prompt, corrective prompt, PR body)
  // still sees `<name>` and knows it is a template.
  assert(
    spec?.deliverables[0]?.paths[1] === "new work-driver-<name>.ts",
    "parseDeliverables: a <name> template is NOT rewritten to '*' at parse time (prose keeps the template)",
  );
}

{
  const spec = parseNormalisedSpec(specWith("src/a.ts, src/b.ts or src/c.ts|src/d.ts"));
  assert(
    spec?.deliverables[0]?.paths.join(",") === "src/a.ts,src/b.ts,src/c.ts,src/d.ts",
    "parseDeliverables: comma, ' or ' and '|' all split, in declaration order",
  );
}

{
  // A bare `n/a` is prose, not a control signal (#792 doctrine) — and it is
  // still not a `[no-diff]` marker, so the slot must not silently become one.
  const spec = parseNormalisedSpec(specWith("n/a"));
  assert(
    spec?.deliverables[0]?.noDiff === undefined &&
      spec.deliverables[0]?.paths.length === 1 &&
      spec.deliverables[0].paths[0] === "n/a",
    "parseDeliverables: a bare 'n/a' slot stays prose (no auto-detected no-diff marker)",
  );
  const v = classifyDeliverables(
    [{ id: "d1", description: "x", paths: ["n/a — repo settings"] }],
    new Set(),
  );
  assert(
    v.absent.length === 0 && v.unmeasurable.length === 1,
    "classify: a path-shaped slot that parses to no measurable alternative is unmeasurable (the #1155 shape the old code parked on)",
  );
}

{
  // The splitter is the shared grammar, asserted directly so a change to the
  // separator set is a deliberate act and not a silent narrowing.
  const splitterProbe = splitDeliverablePaths("a.ts, b or c | d OR e").join(",");
  assert(
    splitterProbe === "a.ts,b,c,d,e",
    "splitDeliverablePaths: every decided separator splits (',', ' or ', ' OR ', '|')",
  );
}

// ---------- the #819 coverage gate uses the SAME parsing (AC: agreement) ------

const ws = (paths: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(paths).map(([id, p]) => [id, { paths: p }]));

{
  // A workstream that declared only ONE alternative of the deliverable's
  // either/or COVERS it — the converge gate calls the same slot delivered, so
  // the plan gate must not halt the cycle for work develop would pass.
  const r = findUncoveredDeliverables(ws({ a: ["src/b.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/a.ts or src/b.ts"] }],
  }, []);
  assert(
    r.checkedCount === 1 && r.uncovered.length === 0,
    "#819 agreement: a workstream declaring one alternative covers an either/or deliverable",
  );
  const c = classifyDeliverables(
    [{ id: "d1", description: "x", paths: ["src/a.ts or src/b.ts"] }],
    new Set(["src/b.ts"]),
  );
  assert(
    (c.deliverables[0].status === "implemented") === (r.uncovered.length === 0),
    "#819 agreement: coverage and converge verdicts cannot disagree for the same slot + file",
  );
}

{
  // The reverse direction is CONCRETE-only, and this is the guard that proves
  // it: `src/dir/<x>.ts` is a template, so no pool entry — not even one that
  // happens to sit under it — may be covered by it. Only a pool entry that
  // names the template's own shape does (the next case).
  const r = findUncoveredDeliverables(ws({ a: ["src/dir/new.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/dir/<x>.ts"] }],
  }, []);
  assert(
    r.checkedCount === 1 && r.uncovered.length === 1,
    "#819: a concrete declaration outside a template's directory does not cover it",
  );
  // And the other direction: a workstream that declared the TEMPLATE covers a
  // deliverable naming the concrete file it produced.
  const rTplPool = findUncoveredDeliverables(ws({ a: ["src/handler-<name>.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/handler-coverage.ts"] }],
  }, []);
  assert(
    rTplPool.checkedCount === 1 && rTplPool.uncovered.length === 0,
    "#819 agreement: a workstream's <template> covers a deliverable naming a file that fits it",
  );
  const rBad = findUncoveredDeliverables(ws({ a: ["other/new.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/dir/<x>.ts"] }],
  }, []);
  assert(
    rBad.uncovered.length === 1,
    "#819: a template in another directory is still UNCOVERED (segment anchoring holds at plan time too)",
  );
  // The self-match guard: a non-empty workstream pool must not cover every
  // deliverable by construction — the bug an earlier draft shipped when the
  // ownership relation was asked in both directions and a path matched itself.
  const unrelated = findUncoveredDeliverables(ws({ a: ["extension/bun.lock"] }), {
    deliverables: [{ id: "d1", paths: ["src/gone.ts"] }],
  }, []);
  assert(
    unrelated.checkedCount === 1 && unrelated.uncovered.length === 1,
    "#819: an unrelated workstream declaration does NOT cover a deliverable (no self-match shortcut)",
  );
}

{
  // The unmeasurable rule on the plan side: a deliverable nothing can check
  // must not be counted, or the plan is rejected for a defect in the spec's
  // slot (the same judgement the converge gate makes with `unmeasurable`).
  const r = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [
      { id: "d1", paths: ["n/a — repo settings"] },
      { id: "d2", paths: ["will land somewhere sensible"] },
    ],
  }, []);
  assert(
    r.checkedCount === 0 && r.uncovered.length === 0,
    "#819: an unparseable prose deliverable is not judged and cannot reject the plan",
  );
  // #819 round-2 (unchanged by #1155): a literal non-path slot disqualifies
  // the whole deliverable, so it is not judged and cannot reject the plan. And
  // the #1155 half of the same rule: an either/or whose alternatives are all
  // uncovered is still NOT reported, because the gate only rejects a plan when
  // NO workstream claims the work at all — that judgement belongs to converge,
  // which sees the diff.
  // Two comma-separated slots are NOT one either/or: `src/gone.ts,
  // src/missing-<x>.ts` is two pieces of declared work. The plan-time gate
  // judges it and reports it uncovered (a template is judgeable — it names a
  // directory), whereas the CONVERGE gate, which holds the diff to the plan,
  // counts it `partial` rather than passing it. #1155 changes the alternatives
  // WITHIN a unit; it does not turn an unclaimed unit into a claimed one.
  const mixedSlot = findUncoveredDeliverables(ws({ a: ["src/gone.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/gone.ts", "n/a"] }],
  }, []);
  assert(
    mixedSlot.checkedCount === 0 && mixedSlot.uncovered.length === 0,
    "#819 round-2: a literal placeholder unit keeps the whole deliverable out of judgement (units, not slots, are the unit of judgement)",
  );
  // The #1155 half of the #819 rule: an either/or whose alternatives are all
  // uncovered is judged but NOT reported, because the plan-time gate only
  // rejects when NO workstream claims the work at all — whether the work was
  // then built is the converge gate's question, and it is the one #1155 was
  // about. A plan that names the work is a good plan even when develop later
  // fails to deliver it.
  const allUncovered = findUncoveredDeliverables(ws({ a: ["src/gone.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/gone.ts or src/missing-<x>.ts"] }],
  }, []);
  assert(
    allUncovered.checkedCount === 1 && allUncovered.uncovered.length === 0,
    "#819: an either/or nobody declared is judged but not rejected — the diff decides, not the plan",
  );
  const proseHalf = findUncoveredDeliverables(ws({ a: ["src/gone.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/gone.ts or src/other-<x>.ts"] }],
  }, []);
  assert(
    proseHalf.checkedCount === 1 && proseHalf.uncovered.length === 0,
    "#819: a prose half does not sink a deliverable whose concrete alternative IS declared — it is covered",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
