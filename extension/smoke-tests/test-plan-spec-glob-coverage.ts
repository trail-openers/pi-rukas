#!/usr/bin/env bun
/**
 * #1642 run 6b — the plan-to-spec gate must not demand a path no plan may
 * declare, measured on the #1557 false refusal.
 *
 * The incident (VERIFIED on disk, the cycle's `.pi/work-state/<issue>.json` + the two
 * preserved plan artifacts `.pi/work-state/<issue>/<runId>-explore.txt`
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

import { parseNormalisedSpec } from "../src/work-driver-intent.ts";
import { repairOmittedDeliverablePaths } from "../src/work-driver-plan-repair.ts";
import {
  findUncoveredDeliverables,
  planDeclarableSlot,
  planSpecMismatchReason,
  undeclarableSlotsOf,
} from "../src/work-driver-plan-spec-coverage.ts";
import { hasPathspecChar, plannedPathProblem } from "../src/plan-path-shape.ts";

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

/**
 * The spec text as the resolver actually wrote it on #1557 (the artifact and
 * both preserved plan replies agree on these slots), and the spec the driver
 * held. Built THROUGH `parseNormalisedSpec`, not hand-written: a hand-built
 * spec is a shape the parser cannot produce, and the #1707 round-2 finding was
 * exactly that — the previous round's tests fed the judge raw slots with a
 * trailing `*` that `parseDeliverables` had already normalised, so they pinned
 * a code path production never reaches.
 */
const SPEC_1557_TEXT = [
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "thread the row identity through the ledger",
  "",
  "### Deliverables",
  `- d1: identity threading [paths: ${[...D1_CONCRETE, D1_GLOB].join(", ")}]`,
  `- d2: identity-based row selection [paths: ${D2}]`,
  `- d3: pinning the identification strategy [paths: ${D3.join(", ")}]`,
  "",
  "### Acceptance criteria",
  "- the ledger identifies a row by its own identity",
  "",
  "### Evidence",
  "- review-ledger holds the rows — extension/src/review-ledger.ts — confirmed",
].join("\n");

const SPEC_1557 = parseNormalisedSpec(SPEC_1557_TEXT) ?? {
  intent: "",
  deliverables: [],
  acceptanceCriteria: [],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "park" as const,
  rationale: "",
};

// The fixture is only a fixture if it parses — and the slot that caused the
// park must survive the parser with its wildcard INTACT, which is what the
// round-2 fix is about: `normaliseDeclaredPath` used to eat the trailing `*`
// and hand the judge `extension/src/review-ledger-`, a concrete-looking path.
assert(
  SPEC_1557.deliverables.length === 3,
  "fixture: the #1557 spec parses through parseNormalisedSpec (3 deliverables)",
);
assert(
  SPEC_1557.deliverables[0]?.paths.includes(D1_GLOB) === true,
  `fixture: the trailing-star slot survives normalisation intact (got ${JSON.stringify(SPEC_1557.deliverables[0]?.paths)})`,
);

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

// The slot literals this file exempts. The drift pin below reads this list:
// every slot `planDeclarableSlot` exempts must be a slot `plannedPathProblem`
// refuses — the exemption is only sound while it is a subset of the planner's
// own refusals. The two share `hasPathspecChar`, so the refusal mechanism
// cannot drift; this asserts the SET cannot either.
const EXEMPT_SLOT_LITERALS = [
  D1_GLOB,
  "extension/src/work-driver-<name>.ts",
  "src/review-ledger-*",
  "src/foo/*",
  "src/dir/?one.ts",
  "src/a!b.ts",
];

{
  for (const slot of EXEMPT_SLOT_LITERALS) {
    assert(
      planDeclarableSlot(slot) === false,
      `exempt slot ${JSON.stringify(slot)}: planDeclarableSlot says no plan may declare it`,
    );
    const problem = plannedPathProblem(slot);
    assert(
      problem !== undefined,
      `drift pin: plannedPathProblem refuses the exempt slot ${JSON.stringify(slot)} too — an exemption wider than the planner's grammar would demand a path a plan MAY name`,
    );
    // One predicate on both sides, not a regex copy in the test either: the
    // assertion below is only a drift pin if it asks the same question the
    // exemption asks.
    if (hasPathspecChar(slot)) {
      assert(
        (problem ?? "").includes("glob or pathspec"),
        `drift pin: the refusal of ${JSON.stringify(slot)} is the GLOB clause specifically (one hasPathspecChar, both sides)`,
      );
    }
  }
}

{
  // #1707 — the trailing-star shapes, driven THROUGH THE PARSER. The old strip
  // (`[/`*\s]+` at each end) turned `src/review-ledger-*` into
  // `src/review-ledger-` and `src/foo/*` into `src/foo`, so the judge read a
  // concrete path, DEMANDED it of the plan, and the single-workstream repair
  // appended the mangled name verbatim.
  const spec = parseNormalisedSpec(
    [
      "INTENT-VERDICT: proceed",
      "",
      "## Spec",
      "",
      "### Intent",
      "x",
      "",
      "### Deliverables",
      "- d1: mixed [paths: src/real.ts, src/foo/*, src/review-ledger-*]",
      "",
      "### Acceptance criteria",
      "- x",
      "",
      "### Evidence",
      "- c — src/real.ts — confirmed",
    ].join("\n"),
  );
  assert(
    spec?.deliverables[0]?.paths.join(",") === "src/real.ts,src/foo/*,src/review-ledger-*",
    `parser: all three slots keep their text, wildcards included (got ${JSON.stringify(spec?.deliverables[0]?.paths)})`,
  );
  assert(
    planDeclarableSlot("src/review-ledger-*") === false,
    "#1707: a slot whose only wildcard is TRAILING is exempted (pre-fix the star-strip hid it)",
  );
  assert(
    planDeclarableSlot("src/foo/*") === false,
    "#1707: a directory-splat slot is exempted for the same reason",
  );
  const r = findUncoveredDeliverables(ws({ a: ["src/other.ts"] }), spec, []);
  const row = r.uncovered.find((u) => u.id === "d1")?.paths ?? [];
  assert(
    row.length === 1 && row[0] === "src/real.ts",
    `#1707: the uncovered row names only the concrete slot — never the star-stripped src/foo or src/review-ledger- (got ${JSON.stringify(row)})`,
  );
  // The repair must never append a star-stripped path either.
  const repaired = repairOmittedDeliverablePaths(
    {
      default: {
        id: "default",
        scope: "trailing-star spec",
        paths: ["src/witness.ts", "src/other.ts"],
        outOfScope: [],
      },
    },
    parseNormalisedSpec(
      [
        "INTENT-VERDICT: proceed",
        "",
        "## Spec",
        "",
        "### Intent",
        "x",
        "",
        "### Deliverables",
        "- d1: mixed [paths: src/witness.ts, src/missing.ts, src/foo/*, src/review-ledger-*]",
        "",
        "### Acceptance criteria",
        "- x",
        "",
        "### Evidence",
        "- c — src/witness.ts — confirmed",
      ].join("\n"),
    ),
    [],
  );
  assert(
    repaired?.added.join(",") === "src/missing.ts",
    `#1707: the repair appends only the genuinely missing file — never a star-stripped src/foo or src/review-ledger- (got ${JSON.stringify(repaired?.added)})`,
  );
}

// #1707 round-2 — the FAIL-OPEN that round closed (judging the exemption on
// raw text, so `**extension/src/x.ts**` read as a glob and a concrete required
// slot exempted itself) is pinned in `test-plan-spec-markup-slots.ts`: markdown
// emphasis, inline code, and an annotated parenthetical carrying a pathspec
// character must all stay REQUIRED, and the spec-ARTIFACT restore path — where
// `validateSpec` bounds `d.paths` but never normalises them — must be judged
// after the gate normalises for itself.

{
  // #1707 — a slot exempted as undeclarable is TRACED, mirroring
  // protectedDeferralsOf, so a gate that judged nothing is visible.
  const r = undeclarableSlotsOf({
    deliverables: [
      { id: "d1", paths: ["src/real.ts", D1_GLOB] },
      { id: "d2", paths: ["src/only-a-template-<name>.ts"] },
      { id: "d3", paths: ["src/concrete.ts"] },
    ],
  });
  assert(
    r.length === 2,
    `#1707: the exempted-slot trace covers exactly the deliverables that carry an exempt slot (got ${JSON.stringify(r)})`,
  );
  assert(
    r.find((d) => d.id === "d1")?.paths.join(",") === D1_GLOB,
    "the trace names the deliverable and the exempt slot itself, not the whole paths list",
  );
  assert(
    r.find((d) => d.id === "d2")?.paths.length === 1,
    "an all-template deliverable is traceable — this is the case where the gate judged NOTHING and the checkedCount silently dropped it",
  );
  assert(
    !r.some((d) => d.id === "d3"),
    "a fully concrete deliverable is not traced",
  );
  assert(
    undeclarableSlotsOf(undefined).length === 0,
    "no spec, no trace lines",
  );
  // A placeholder-only deliverable is not measurable, so it is not traced
  // either — the measurable() gate owns that case, not this one.
  // #1707 round-3 — a bare `*` slot used to normalise to the empty string (the
  // markup strip ate it), which made the deliverable unmeasurable and dropped
  // it from `checkedCount` with nothing said. A `*` that survives normalisation
  // is honest about what it is: a pattern, measurable at converge, exempt from
  // the plan requirement, and TRACED.
  assert(
    undeclarableSlotsOf({ deliverables: [{ id: "d1", paths: ["*"] }] }).length === 1,
    "a `*` slot is now traced as an exemption rather than silently normalising away",
  );
}

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
