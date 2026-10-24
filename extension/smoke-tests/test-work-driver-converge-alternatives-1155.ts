#!/usr/bin/env bun
/**
 * #1155 — a declared deliverable path is a LIST OF ALTERNATIVES, not a literal.
 *
 * The incident (one measured cycle's state file): the plan wrote
 * `- d2: … [paths: extension/src/work-driver-verify.ts or new
 * work-driver-<name>.ts]`. The developers created
 * `extension/src/work-driver-acceptance-coverage.ts`, the verify gate passed,
 * and the converge gate still parked the cycle — the declared path was matched
 * as one literal string no `git diff --name-only` could contain, the corrective
 * re-dispatch spent 76 min trying to create a file literally named
 * `work-driver-<name>.ts`, and 154 min of cycle died.
 *
 * Three surfaces, one grammar (the issue's AC list):
 *   - `classifyDeliverables` — any-alternative matching, segment-anchored
 *     globs, and the unmeasurable-warning-not-park rule (with the control: a
 *     deliverable whose only concrete alternative is absent STILL parks).
 *   - the `[paths:]` parser and the #819 coverage gate's agreement with it
 *     live in test-work-driver-deliverable-paths-parse-1155.ts.
 *
 * Offline: pure functions over (deliverables, path set, workstreams). No git,
 * no dispatch, no fs.
 */

import { classifyDeliverables } from "../src/work-driver-converge.ts";
import { globMatchesSegments } from "../src/work-driver-deliverable-paths.ts";

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
