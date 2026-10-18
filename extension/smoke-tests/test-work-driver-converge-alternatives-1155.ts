#!/usr/bin/env bun
/**
 * #1155 — a declared deliverable path is a LIST OF ALTERNATIVES, not a literal.
 *
 * The incident (.pi/work-state/1137.json, 2026-10-13): the plan wrote
 * `- d2: … [paths: extension/src/work-driver-verify.ts or new
 * work-driver-<name>.ts]`. The developers created
 * `extension/src/work-driver-acceptance-coverage.ts`, the verify gate passed,
 * and the converge gate still parked the cycle — the declared path was matched
 * as one literal string no `git diff --name-only` could contain, the corrective
 * re-dispatch spent 76 min trying to create a file literally named
 * `work-driver-<name>.ts`, and 154 min of cycle died.
 *
 * Three surfaces, one grammar, all asserted here (the issue's AC list):
 *   - `classifyDeliverables` — any-alternative matching, segment-anchored
 *     globs, and the unmeasurable-warning-not-park rule (with the control: a
 *     deliverable whose only concrete alternative is absent STILL parks).
 *   - `parseDeliverables` via `parseNormalisedSpec` — the `[paths:]` slot
 *     splits on comma AND on ` or ` / ` OR ` / `|`.
 *   - `findUncoveredDeliverables` (the #819 plan-to-spec gate) — the SAME
 *     parsing, so the two gates cannot disagree about one `[paths:]` slot.
 *
 * Offline: pure functions over (deliverables, path set, workstreams). No git,
 * no dispatch, no fs.
 */

import { classifyDeliverables } from "../src/work-driver-converge.ts";
import {
  declaredPathMatches,
  globMatchesSegments,
  splitDeliverablePaths,
} from "../src/work-driver-deliverable-paths.ts";
import { parseNormalisedSpec } from "../src/work-driver-intent.ts";
import { findUncoveredDeliverables } from "../src/work-driver-plan-spec-coverage.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The #1137 deliverable d2 exactly as the planner wrote it. */
const D1137 = "extension/src/work-driver-verify.ts or new work-driver-<name>.ts";
/** The file the developers actually shipped in that cycle. */
const SHIPPED = "extension/src/work-driver-acceptance-coverage.ts";

// ------------------- AC1: replaying the #1137 deliverables -------------------

{
  const v = classifyDeliverables(
    [
      { id: "d1", description: "coverage gate", paths: ["extension/src/work-driver-verify.ts"] },
      { id: "d2", description: "acceptance coverage", paths: [D1137] },
    ],
    new Set(["extension/src/work-driver-verify.ts", SHIPPED]),
  );
  assert(
    v.absent.length === 0,
    "AC1: replaying the #1137 deliverables against the #1137 diff yields NO missing deliverable",
  );
  assert(
    v.deliverables[0]?.status === "implemented" && v.absent.length === 0,
    "AC1: d2 reads `implemented` — its <name> template matched the sibling file the developers shipped",
  );
}

{
  // The same replay with only the TEMPLATE alternative in the diff: the
  // either/or must not require BOTH halves (the decided ANY-alternative rule).
  // The template form of the #1137 replay: the slot's own literal text stays
  // `…-<name>.ts` for the prose surfaces, and the GLOB form is what matches,
  // so a sibling the developers actually shipped satisfies the unit.
  const vTpl = classifyDeliverables(
    [{ id: "d2", description: "acceptance coverage", paths: ["src/handler-<name>.ts"] }],
    new Set(["src/handler-coverage.ts"]),
  );
  assert(
    vTpl.deliverables[0].status === "implemented" && vTpl.absent.length === 0,
    "either/or: only the template half landed → implemented, not absent, not partial",
  );
  // One alternative matching is ENOUGH even when the other half of the slot is
  // nowhere in the diff — that is the difference between "delivered when ANY
  // alternative matches" and an AND the issue explicitly refused. A template
  // whose directory the diff touched at all is a delivered unit: `src/<x>.ts`
  // is the planner saying "a file in src/", and any file there satisfies it —
  // the rule the #1137 replay depends on.
  const vHalf = classifyDeliverables(
    [{ id: "d1", description: "half landed", paths: ["src/a.ts or src/<x>.ts"] }],
    new Set(["src/b.ts"]),
  );
  assert(
    vHalf.deliverables[0].status === "implemented" &&
      vHalf.partial.length === 0 &&
      vHalf.absent.length === 0,
    "either/or: one alternative in the diff → implemented (never partial, never absent)",
  );
  // Two SEPARATE slots are still two pieces of declared work: one landing is a
  // partial, which is the accounting that keeps `a.ts, b.ts` honest.
  const twoSlots = classifyDeliverables(
    [{ id: "d1", description: "two slots", paths: ["src/a.ts", "src/b.ts"] }],
    new Set(["src/a.ts"]),
  );
  assert(
    twoSlots.partial.length === 1 && twoSlots.absent.length === 0,
    "two comma-separated slots with one landed → PARTIAL (slot, not alternative, is the unit of accounting)",
  );
}

// ------------- AC2: 'a.ts or b.ts' / 'src/<x>.ts' are delivered --------------

{
  const v = classifyDeliverables(
    [{ id: "d1", description: "a or b", paths: ["src/a.ts or src/b.ts"] }],
    new Set(["src/b.ts"]),
  );
  assert(
    v.deliverables[0].status === "implemented" && v.absent.length === 0,
    "AC2: 'a.ts or b.ts' with b.ts in the diff is DELIVERED",
  );
}

{
  const v = classifyDeliverables(
    [{ id: "d1", description: "template", paths: ["src/<x>.ts"] }],
    new Set(["src/new.ts"]),
  );
  assert(
    v.deliverables[0].status === "implemented" && v.absent.length === 0,
    "AC2: 'src/<x>.ts' with src/new.ts is DELIVERED",
  );
}

{
  // `|` and ` OR ` are alternatives separators too (the decided rule names
  // all three); a comma list mixed with an `or` splits into both.
  const vBar = classifyDeliverables(
    [{ id: "d1", description: "bar", paths: ["src/a.ts|src/b.ts"] }],
    new Set(["src/b.ts"]),
  );
  assert(
    vBar.deliverables[0].status === "implemented",
    "alternatives: '|' separates alternatives like ' or '",
  );
  const vOr = classifyDeliverables(
    [{ id: "d1", description: "or upper", paths: ["src/a.ts OR src/b.ts"] }],
    new Set(["src/b.ts"]),
  );
  assert(
    vOr.deliverables[0].status === "implemented",
    "alternatives: ' OR ' (upper case) separates alternatives too",
  );
  const mixed = classifyDeliverables(
    [{ id: "d1", description: "mixed", paths: ["src/keep.ts, src/a.ts or src/b.ts"] }],
    new Set(["src/keep.ts", "src/b.ts"]),
  );
  assert(
    mixed.deliverables[0].status === "implemented",
    "alternatives: a comma list whose second slot is an either/or is fully delivered",
  );
}

{
  // The annotation still strips AFTER the split ("(new)" is planner prose).
  const v = classifyDeliverables(
    [{ id: "d1", description: "annotated", paths: ["src/a.ts (new) or src/b.ts (new)"] }],
    new Set(["src/b.ts"]),
  );
  assert(
    v.deliverables[0].status === "implemented",
    "alternatives: a '(new)' annotation is stripped from each alternative before matching",
  );
}

// ---- AC2c: an unparseable prose deliverable WARNS and does not park ----------

{
  const v = classifyDeliverables(
    [
      { id: "d1", description: "prose", paths: ["n/a — repo settings"] },
      { id: "d2", description: "sentence", paths: ["will land somewhere sensible"] },
    ],
    new Set(["src/unrelated.ts"]),
  );
  assert(
    v.absent.length === 0 &&
      v.deliverables.every((d) => d.status === "unmeasurable") &&
      v.unmeasurable.length === 2,
    "AC2: an unparseable prose deliverable is `unmeasurable` and NEVER joins `absent` (no park)",
  );
  assert(
    v.unmeasurable.every((d) => d.reason.includes("warning") && d.reason.includes("not a cap")),
    "AC2: the unmeasurable reason says it is a warning, not a cap (the handoff/PR body renders it)",
  );
}

{
  // #792 twin: a deliverable with NO paths at all keeps its existing
  // `unmeasurable` reason, and the no-diff marker still needs its evidence.
  const vProse = classifyDeliverables(
    [{ id: "d1", description: "no paths", paths: [] }],
    new Set<string>(),
  );
  assert(
    vProse.deliverables[0].status === "unmeasurable" &&
      vProse.deliverables[0].reason.includes("prose deliverable"),
    "#792 unchanged: a pathless deliverable keeps its `no declared paths (prose deliverable)` reason",
  );
  const vNoDiff = classifyDeliverables(
    [{ id: "d1", description: "toggle", paths: [], noDiff: true, noDiffEvidence: "gh api ..." }],
    new Set<string>(),
  );
  assert(
    vNoDiff.deliverables[0].status === "no-diff",
    "#792 unchanged: an honoured no-diff marker still classifies `no-diff`",
  );
  const vContradict = classifyDeliverables(
    [
      {
        id: "d1",
        description: "both",
        paths: ["src/gone.ts"],
        noDiff: true,
        noDiffEvidence: "because",
      },
    ],
    new Set<string>(),
  );
  assert(
    vContradict.deliverables[0].status === "absent",
    "#792 unchanged: contradictory marker + a concrete absent path → the paths win (absent)",
  );
}

// ---------------- AC3 (CONTROL): a real gap still parks ----------------------

{
  // The control's template names a NARROWER shape than the one file that
  // landed, so NEITHER alternative matches — the case the gate must still park.
  const v = classifyDeliverables(
    [{ id: "d1", description: "real gap", paths: ["src/gone.ts or src/missing-<x>.ts"] }],
    new Set(["src/unrelated.ts"]),
  );
  assert(
    v.absent.length === 1 && v.absent[0].id === "d1",
    "AC3 CONTROL: a deliverable whose only concrete path is absent (and whose template matches nothing) STILL parks",
  );
  assert(
    (v.absent[0]?.missing ?? []).some((m) => m.includes("src/gone.ts")) &&
      (v.absent[0]?.missing ?? []).some((m) => m.includes("<x>")),
    "AC3: the absent row names BOTH alternatives, template included, so the corrective sees the whole either/or",
  );
  assert(
    (v.deliverables[0]?.missing ?? []).length > 0,
    "AC3: a parked deliverable always reports its missing paths (never an empty `missing` on an absent row)",
  );
  // A concrete path plus a template whose directory nothing touched — the
  // other way a real gap stays a gap.
  const v2 = classifyDeliverables(
    [{ id: "d1", description: "gap", paths: ["src/gone.ts or src/deep/<x>.ts"] }],
    new Set(["src/unrelated.ts"]),
  );
  assert(
    v2.absent.length === 1,
    "AC3 CONTROL: a template whose directory the diff never touched does not rescue an absent concrete path",
  );
}

{
  // Segment anchoring: a template must not reach across a directory boundary,
  // or the false pass lets a deliverable about one directory be satisfied by
  // work in another.
  const v = classifyDeliverables(
    [{ id: "d1", description: "anchored", paths: ["extension/src/work-driver-*.ts"] }],
    new Set(["extension/src/deep/work-driver-x.ts"]),
  );
  assert(
    v.absent.length === 1,
    "glob: a template does NOT match beneath its directory (segment-anchored, not path-wide)",
  );
  assert(
    globMatchesSegments("src/work-driver-*.ts", "src/work-driver-a.ts") &&
      !globMatchesSegments("src/<x>.ts", "src/a/b.ts") &&
      !globMatchesSegments("src/<x>.ts", "src/a.tsx"),
    "glob: '*' is exactly one segment — matches a sibling, rejects a nested file and a near-miss name",
  );
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
  });
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
  });
  assert(
    r.checkedCount === 1 && r.uncovered.length === 1,
    "#819: a concrete declaration outside a template's directory does not cover it",
  );
  // And the other direction: a workstream that declared the TEMPLATE covers a
  // deliverable naming the concrete file it produced.
  const rTplPool = findUncoveredDeliverables(ws({ a: ["src/handler-<name>.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/handler-coverage.ts"] }],
  });
  assert(
    rTplPool.checkedCount === 1 && rTplPool.uncovered.length === 0,
    "#819 agreement: a workstream's <template> covers a deliverable naming a file that fits it",
  );
  const rBad = findUncoveredDeliverables(ws({ a: ["other/new.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/dir/<x>.ts"] }],
  });
  assert(
    rBad.uncovered.length === 1,
    "#819: a template in another directory is still UNCOVERED (segment anchoring holds at plan time too)",
  );
  // The self-match guard: a non-empty workstream pool must not cover every
  // deliverable by construction — the bug an earlier draft shipped when the
  // ownership relation was asked in both directions and a path matched itself.
  const unrelated = findUncoveredDeliverables(ws({ a: ["extension/bun.lock"] }), {
    deliverables: [{ id: "d1", paths: ["src/gone.ts"] }],
  });
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
  });
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
  });
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
  });
  assert(
    allUncovered.checkedCount === 1 && allUncovered.uncovered.length === 0,
    "#819: an either/or nobody declared is judged but not rejected — the diff decides, not the plan",
  );
  const proseHalf = findUncoveredDeliverables(ws({ a: ["src/gone.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/gone.ts or src/other-<x>.ts"] }],
  });
  assert(
    proseHalf.checkedCount === 1 && proseHalf.uncovered.length === 0,
    "#819: a prose half does not sink a deliverable whose concrete alternative IS declared — it is covered",
  );
}

// -------- #1137 d2 attribution still works through the new grammar -----------

{
  const v = classifyDeliverables(
    [{ id: "d1", description: "x", paths: ["src/a.ts or src/b.ts"] }],
    new Set(["src/b.ts"]),
    { "task-a": ["src/a.ts or src/b.ts"] },
  );
  assert(
    v.deliverables[0].status === "implemented" &&
      v.deliverables[0].deliveredBy?.join(",") === "task-a",
    "#1137 d2: a workstream that declared the same either/or is credited with delivering it",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
