#!/usr/bin/env bun
/**
 * #819 — the plan-to-spec gate, and the parser that must not take the first of
 * several workstream blocks.
 *
 * The incident (VERIFIED on disk, `.pi/work-state/818.json` + the preserved
 * `plan:corrective` artifact): the issue body, the explore reply, the
 * normalisedSpec and the FIRST plan were all correct. `planQualityReason`
 * flagged the correct one-workstream plan, the corrective reply came back with
 * THREE concatenated `## Workstreams` blocks — the first a fabricated
 * supply-chain decomposition matching no issue and no coherent view of the
 * base — and `parseWorkstreams` silently took the first. Four developers then
 * built a 2,239-line `package-lock.json`, a new `install-preflight.sh` and a
 * no-op docs rewrite for 45 minutes. Nothing between plan and develop asked
 * whether the workstreams were about the issue.
 *
 * Offline: pure functions over (reply text, workstreams, spec). No dispatch,
 * no git, no fs — the same shape `planQualityReason` is tested with.
 */

import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import { correctivePlanSteer } from "../src/work-driver-plan-helpers.ts";
import {
  findUncoveredDeliverables,
  planSpecMismatchReason,
} from "../src/work-driver-plan-spec-coverage.ts";
import { PLAN_WORKSTREAM_CALL_RULE } from "../src/work-driver-prompts-plan.ts";
import { planResultFromCalls } from "./lib/plan-workstream-calls.ts";

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

/** The #818 spec: deliverables d1–d5 on the title-derivation files. */
const SPEC_818 = {
  deliverables: [
    { id: "d1", paths: ["extension/src/work-driver-integrate.ts"] },
    { id: "d2", paths: ["extension/src/work-driver-handoff-subject.ts"] },
    { id: "d3", paths: ["extension/src/work-driver-commit.ts"] },
    { id: "d4", paths: ["extension/src/work-driver-prompts-early.ts"] },
    { id: "d5", paths: ["extension/smoke-tests/"] },
  ],
};

/** The fabricated block (a) from the #818 corrective reply. */
const FABRICATED = ws({
  "task-bun": ["extension/bunfig.toml", "extension/bun.lock"],
  "task-install": ["install.sh"],
  "task-docs": ["AGENTS.md", "CONTRIBUTING.md"],
  "task-npm": ["extension/.npmrc", "package-lock.json"],
});

// ------------------------------------------- the #818 incident as a fixture

{
  const r = findUncoveredDeliverables(FABRICATED, SPEC_818);
  assert(
    r.uncovered.length === 5 && r.checkedCount === 5,
    "#818 fixture: the fabricated supply-chain plan covers NONE of d1–d5 (all 5 measured, all 5 uncovered)",
  );
  assert(
    r.uncovered.every((u) => u.paths.length > 0),
    "#818 fixture: every uncovered row carries the paths a human needs to see",
  );
  const m = planSpecMismatchReason(FABRICATED, SPEC_818);
  assert(
    m?.kind === "uncovered-deliverables",
    "#818 fixture: the gate rejects the fabricated plan before branch/develop",
  );
  assert(
    (m?.evidence ?? "").includes("work-driver-integrate.ts"),
    "#818 fixture: the rejection NAMES the uncovered deliverables (the operator should not have to diff the workstreams by hand)",
  );
}

// ---------------------------------------------------------- a correct plan

{
  const correct = ws({
    default: [
      "extension/src/work-driver-integrate.ts",
      "extension/src/work-driver-handoff-subject.ts",
      "extension/src/work-driver-commit.ts",
      "extension/src/work-driver-prompts-early.ts",
      "extension/smoke-tests/",
    ],
  });
  assert(
    planSpecMismatchReason(correct, SPEC_818) === undefined,
    "a plan declaring every deliverable path passes the gate",
  );
  const split = ws({
    "task-a": ["extension/src/work-driver-integrate.ts", "extension/src/work-driver-commit.ts"],
    "task-b": [
      "extension/src/work-driver-handoff-subject.ts",
      "extension/src/work-driver-prompts-early.ts",
    ],
    "task-c": ["extension/smoke-tests/"],
  });
  assert(
    planSpecMismatchReason(split, SPEC_818) === undefined,
    "coverage is measured over the UNION of workstream paths, not per workstream (a correct N=3 plan passes)",
  );
}

// --------------------------------- directory containment + prose-annotated

// biome-ignore lint/complexity/noUselessLoneBlockStatements: grouped test section
{
  assert(
    findUncoveredDeliverables(ws({ a: ["extension/src"] }), {
      deliverables: [{ id: "d1", paths: ["extension/src/work-driver-integrate.ts"] }],
    }).uncovered.length === 0,
    "a workstream declaring the directory covers a deliverable file beneath it (startsWith(p + '/'))",
  );
  assert(
    findUncoveredDeliverables(ws({ a: ["extension/src/work-driver-integrate.ts"] }), {
      deliverables: [{ id: "d1", paths: ["extension/src"] }],
    }).uncovered.length === 0,
    "containment goes both ways: a deliverable declaring the directory is covered by a workstream naming the file in it",
  );
  assert(
    findUncoveredDeliverables(ws({ a: ["extension/src"] }), {
      deliverables: [{ id: "d1", paths: ["extension/srcother/foo.ts"] }],
    }).uncovered.length === 1,
    "the separator is load-bearing: extension/src does not cover extension/srcother/foo.ts",
  );
  assert(
    findUncoveredDeliverables(ws({ a: ["extension/src/work-driver-verify.ts (new)"] }), {
      deliverables: [{ id: "d1", paths: ["extension/src/work-driver-verify.ts"] }],
    }).uncovered.length === 0,
    "prose-annotated declared paths (`… (new)`) normalise before comparison — no false mismatch (the #810 shape)",
  );
  assert(
    findUncoveredDeliverables(ws({ a: ["`extension/src/foo.ts`", "extension/src/bar.ts "] }), {
      deliverables: [{ id: "d1", paths: ["extension/src/foo.ts", "extension/src/bar.ts"] }],
    }).uncovered.length === 0,
    "backticks and stray whitespace in a planner's list do not fabricate a mismatch",
  );
}

// --------------------------------------- EVERY-path policy + exclusions

{
  // Partial coverage is NOT coverage: d1 declares two paths, the plan covers one.
  const partial = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/a.ts", "src/b.ts"] }],
  });
  assert(
    partial.uncovered.length === 1 && partial.uncovered[0]?.paths.length === 2,
    "partial coverage does not cover: EVERY declared path must be in the workstream union (stated policy)",
  );
  // Pathless deliverables are excluded entirely.
  const pathless = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [
      { id: "d1", paths: [] },
      { id: "d2", paths: ["  "] },
    ],
  });
  assert(
    pathless.uncovered.length === 0 && pathless.checkedCount === 0,
    "a spec whose deliverables declare NO paths is not checkable: 0 measured, 0 uncovered — never a false mismatch",
  );
  assert(
    planSpecMismatchReason(ws({ a: [] }), { deliverables: [{ id: "d1", paths: [] }] }) ===
      undefined,
    "an empty plan against an all-pathless spec is not rejected (nothing to cover)",
  );
  // #792 no-diff deliverables are excluded when honoured.
  const noDiff = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [
      { id: "d1", paths: ["src/a.ts"] },
      { id: "d2", paths: [], noDiff: true, noDiffEvidence: "settings toggle in .pi/verify-cmd" },
    ],
  });
  assert(
    noDiff.uncovered.length === 0 && noDiff.checkedCount === 1,
    "an honoured [no-diff: evidence] deliverable is excluded from the comparison (matches classifyDeliverables)",
  );
  // A no-diff marker WITH paths is contradictory: the paths win (same rule).
  const contradictory = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/z.ts"], noDiff: true, noDiffEvidence: "n/a" }],
  });
  assert(
    contradictory.uncovered.length === 1,
    "a contradictory marker (noDiff + real paths) is judged by its paths, exactly as the converge gate does",
  );
  // A bare marker with no evidence is NOT honoured.
  const unevidenced = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/z.ts"], noDiff: true, noDiffEvidence: "  " }],
  });
  assert(
    unevidenced.uncovered.length === 1,
    "an un-evidenced no-diff marker does not exempt a deliverable that declares paths",
  );
}

// ------------------------- #819 round-2: prose in a `paths:` slot is not a path

// biome-ignore lint/complexity/noUselessLoneBlockStatements: grouped test section
{
  // The defect: `"n/a"`, `"tbd"` and a whole sentence all survive
  // `normaliseDeclaredPath` (it strips annotations, backticks and slashes, not
  // English), so they reached the coverage comparison as paths no workstream
  // could ever declare — and the gate rejected an honest plan for a slot the
  // SPEC author filled with prose. `isPlainRepoRelativePath` is the same
  // predicate the shape gate uses for `invalid-path` on the workstream side;
  // both sides now judge a slot by it.
  const PROSE_SPEC = {
    deliverables: [
      { id: "d1", paths: ["n/a"] },
      { id: "d2", paths: ["the developer will decide where this lands"] },
    ],
  };
  const prose = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), PROSE_SPEC);
  assert(
    prose.checkedCount === 0,
    "#819 round-2: a deliverable whose paths slot is prose is NOT measurable — checkedCount stays 0",
  );
  assert(
    prose.uncovered.length === 0,
    "#819 round-2: prose in the paths slot produces no uncovered row (the planner cannot act on it)",
  );
  assert(
    planSpecMismatchReason(ws({ a: ["src/a.ts"] }), PROSE_SPEC) === undefined,
    "#819 round-2: a spec whose only paths are prose never rejects the plan (the gate has nothing to judge)",
  );
  // Absolute / traversing slots are non-paths too (same predicate).
  for (const bad of ["/etc/passwd", "src/../secrets.ts", "src/fo o.ts"]) {
    const r = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
      deliverables: [{ id: "d1", paths: [bad] }],
    });
    assert(
      r.checkedCount === 0 && r.uncovered.length === 0,
      `#819 round-2: a non-path slot (${JSON.stringify(bad)}) is not measurable, not a rejection`,
    );
  }
  // A deliverable mixing a real path with prose is excluded WHOLESALE: the
  // EVERY-path rule would reject the plan for the prose half regardless, so
  // judging the measurable half would only produce a rejection nobody can fix.
  const mixed = findUncoveredDeliverables(ws({ a: ["src/a.ts"] }), {
    deliverables: [{ id: "d1", paths: ["src/a.ts", "n/a"] }],
  });
  assert(
    mixed.checkedCount === 0 && mixed.uncovered.length === 0,
    "#819 round-2: one non-path slot disqualifies the whole deliverable (no partial judgement, no false rejection)",
  );
}

// ---------------------------------- no spec / no deliverables = not judgeable

// biome-ignore lint/complexity/noUselessLoneBlockStatements: grouped test section
{
  assert(
    planSpecMismatchReason(FABRICATED, undefined) === undefined,
    "no spec → the gate has nothing to say (it does not reject; it also does not claim a pass)",
  );
  assert(
    planSpecMismatchReason(FABRICATED, { deliverables: [] }) === undefined,
    "a spec with zero deliverables → the gate does not fire",
  );
}

// ---------------- #1652: the prose is not read; the tool calls are the plan

const BLOCK_A = [
  "## Workstreams",
  "",
  "### task-bun — supply chain",
  "- paths: extension/bunfig.toml, extension/bun.lock",
  "",
].join("\n");
const BLOCK_B = [
  "## Workstreams",
  "",
  "### task-title — commit title derivation",
  "- paths: extension/src/work-driver-integrate.ts",
  "",
].join("\n");
const TAIL = "## Verification\n- run the suite\n";

// biome-ignore lint/complexity/noUselessLoneBlockStatements: grouped test section
{
  // The #818 reply's shape — three markdown blocks in the prose — through the
  // channel that replaced it. The prose is not read for workstreams, so it can
  // neither make the plan ambiguous nor change what the gate judges: the calls
  // are the plan, and the calls cover the spec.
  const covering = [
    {
      id: "task-title",
      scope: "commit title derivation",
      paths: [
        "extension/src/work-driver-integrate.ts",
        "extension/src/work-driver-handoff-subject.ts",
        "extension/src/work-driver-commit.ts",
        "extension/src/work-driver-prompts-early.ts",
        "extension/smoke-tests/",
      ],
      outOfScope: [],
    },
  ];
  const reply = `${BLOCK_A}\n${BLOCK_B}\n${BLOCK_A}\n${TAIL}`;
  const report = workstreamCallsOf(planResultFromCalls(covering, reply));
  assert(
    report.accepted === 1 && Object.keys(report.workstreams)[0] === "task-title",
    "#1652: three markdown blocks in the prose and one valid call → the plan is the one call",
  );
  assert(
    planSpecMismatchReason(report.workstreams, SPEC_818) === undefined,
    "#1652: the covering call passes the gate — the prose's blocks do not reject it",
  );
}

{
  // Zero calls is not judged by the coverage gate: there is no plan to judge,
  // and the plan step's one corrective owns that case (no `default` fallback).
  assert(
    planSpecMismatchReason({}, SPEC_818) === undefined,
    "#1652: a plan with no accepted call is silent here — the plan step's corrective owns it",
  );
  const onlyD1 = {
    "task-d1": { paths: ["extension/src/work-driver-integrate.ts"] },
  };
  const m = planSpecMismatchReason(onlyD1, SPEC_818);
  assert(
    m?.kind === "uncovered-deliverables" && (m.uncovered?.length ?? 0) === 4,
    "#1652: the coverage verdict still names every deliverable the calls leave uncovered",
  );
}

// --------------------------------------------------- the steer's own contract

{
  const s = correctivePlanSteer("plan-spec-mismatch", 5, 4);
  assert(
    s.includes("Do NOT invent new work") && s.includes("Do NOT change WHAT is built"),
    "the corrective steer forbids re-choosing WHAT gets built — the #818 failure mode",
  );
  assert(
    s.includes(PLAN_WORKSTREAM_CALL_RULE),
    "the steer names the one-call-per-workstream rule so the corrective reports through the tool",
  );
  assert(!s.includes("undefined"), "the steer renders with no details and leaks no 'undefined'");
}

// ---------------------------------------- the gate never throws on junk input

{
  const junk = [
    [ws({}), SPEC_818],
    [ws({ a: [""] }), SPEC_818],
    [ws({ a: ["( )", "..."] }), { deliverables: [{ id: "d", paths: ["???"] }] }],
  ] as const;
  let threw = false;
  for (const [w, s] of junk) {
    try {
      planSpecMismatchReason(w, s);
    } catch {
      threw = true;
    }
  }
  assert(
    !threw,
    "the gate is total over junk planner prose — it never throws (a throw costs the cycle)",
  );
}

// #1642 — every measurable deliverable deferred as a protected path the grant
// does not admit: nothing was judged, so the gate must not pass silently.
{
  const PROTECTED_SPEC = {
    deliverables: [{ id: "d1", paths: [".github/workflows/ci.yml"] }],
  };
  const m = planSpecMismatchReason(ws({ a: ["src/a.ts"] }), PROTECTED_SPEC);
  assert(
    m?.kind === "uncovered-deliverables",
    "all deferred: the gate returns a mismatch, not silence",
  );
  assert(
    (m?.evidence ?? "").includes(".github/workflows/ci.yml") &&
      (m?.evidence ?? "").includes("--allow-protected"),
    "all deferred: the evidence names the deferred path and the --allow-protected re-run",
  );
  assert(
    m?.uncovered?.[0]?.id === "d1",
    "all deferred: the deferred deliverable is carried in the uncovered list",
  );
  assert(
    planSpecMismatchReason(
      ws({ a: [".github/workflows/ci.yml"] }),
      PROTECTED_SPEC,
      [".github/workflows/ci.yml"],
    ) === undefined,
    "all deferred, but granted and covered: the gate passes",
  );
  // Partial deferral: d2 is checkable and covered, so the gate still passes.
  const PARTIAL_SPEC = {
    deliverables: [
      { id: "d1", paths: [".github/workflows/ci.yml"] },
      { id: "d2", paths: ["src/a.ts"] },
    ],
  };
  assert(
    planSpecMismatchReason(ws({ a: ["src/a.ts"] }), PARTIAL_SPEC) === undefined,
    "partial deferral: a checked and covered deliverable still passes the gate",
  );
}

process.exit(exit);
