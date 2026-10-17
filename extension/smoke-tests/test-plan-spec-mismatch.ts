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

import { correctivePlanSteer } from "../src/work-driver-plan-helpers.ts";
import {
  countMarkdownSections,
  findUncoveredDeliverables,
  planSpecMismatchReason,
} from "../src/work-driver-plan-spec-coverage.ts";
import { parseWorkstreams } from "../src/work-driver-plan-workstreams.ts";

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
  const m = planSpecMismatchReason(
    "## Workstreams\n### default\n- paths: install.sh\n",
    FABRICATED,
    SPEC_818,
  );
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
    planSpecMismatchReason("", correct, SPEC_818) === undefined,
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
    planSpecMismatchReason("", split, SPEC_818) === undefined,
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
    planSpecMismatchReason("", ws({ a: [] }), { deliverables: [{ id: "d1", paths: [] }] }) ===
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

// ---------------------------------- no spec / no deliverables = not judgeable

// biome-ignore lint/complexity/noUselessLoneBlockStatements: grouped test section
{
  assert(
    planSpecMismatchReason("", FABRICATED, undefined) === undefined,
    "no spec → the gate has nothing to say (it does not reject; it also does not claim a pass)",
  );
  assert(
    planSpecMismatchReason("", FABRICATED, { deliverables: [] }) === undefined,
    "a spec with zero deliverables → the gate does not fire",
  );
}

// ---------------------------------------------- multi-block: never first-wins

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
  assert(countMarkdownSections(BLOCK_A, "Workstreams") === 1, "one block counts as one");
  assert(
    countMarkdownSections(`${BLOCK_A}\n${BLOCK_B}\n${TAIL}`, "Workstreams") === 2,
    "two blocks count as two",
  );
  assert(
    countMarkdownSections(`${BLOCK_A}\n${BLOCK_B}\n${BLOCK_A}\n${TAIL}`, "Workstreams") === 3,
    "three blocks count as three (the #818 reply's shape)",
  );
  assert(
    countMarkdownSections("### Workstreams\n- paths: x\n", "Workstreams") === 0,
    "a ### subheading is not a ## section — no false ambiguity",
  );
  assert(countMarkdownSections("nothing here", "Workstreams") === 0, "no block counts as zero");
}

{
  // Both orders: the parser still returns the FIRST block (byte-unchanged
  // behaviour), which is exactly why the count must gate it.
  const fabricatedFirst = `${BLOCK_A}\n${BLOCK_B}\n${TAIL}`;
  const correctFirst = `${BLOCK_B}\n${BLOCK_A}\n${TAIL}`;
  assert(
    Object.keys(parseWorkstreams(fabricatedFirst))[0] === "task-bun",
    "parser: first-wins is still what sliceMarkdownSection does (documented, not relied on)",
  );
  assert(
    Object.keys(parseWorkstreams(correctFirst))[0] === "task-title",
    "parser: with the correct block first, first-wins happens to be right — which is why order cannot be the rule",
  );
  const a = planSpecMismatchReason(fabricatedFirst, parseWorkstreams(fabricatedFirst), SPEC_818);
  const b = planSpecMismatchReason(correctFirst, parseWorkstreams(correctFirst), SPEC_818);
  assert(
    a?.kind === "multiple-workstream-blocks" && a.blockCount === 2,
    "ambiguous reply (fabricated block first) → REJECTED as ambiguous, block count recorded",
  );
  assert(
    b?.kind === "multiple-workstream-blocks" && b.blockCount === 2,
    "ambiguous reply (correct block first) → REJECTED too: last-wins/first-wins is a guess, and #818 showed the blocks come in no semantic order",
  );
  assert(
    (a?.evidence ?? "").includes("exactly one"),
    "the ambiguity verdict tells the planner what to emit instead",
  );
}

{
  // The ambiguity branch runs BEFORE coverage: the parsed map of an ambiguous
  // reply is one arbitrary block's, so coverage over it is not a statement
  // about the plan.
  const ambiguousButCovering = `${BLOCK_B}\n## Workstreams\n### task-x\n- paths: extension/src/work-driver-handoff-subject.ts, extension/src/work-driver-commit.ts, extension/src/work-driver-prompts-early.ts, extension/smoke-tests/\n${TAIL}`;
  const m = planSpecMismatchReason(
    ambiguousButCovering,
    parseWorkstreams(ambiguousButCovering),
    SPEC_818,
  );
  assert(
    m?.kind === "multiple-workstream-blocks",
    "an ambiguous reply whose blocks TOGETHER cover the spec is still rejected on ambiguity, not judged on coverage",
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
    /exactly ONE `## Workstreams` section/.test(s),
    "the steer names the single-block rule so the corrective cannot repeat the ambiguity",
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
      planSpecMismatchReason("## Workstreams\n", w, s);
    } catch {
      threw = true;
    }
  }
  assert(
    !threw,
    "the gate is total over junk planner prose — it never throws (a throw costs the cycle)",
  );
}

process.exit(exit);
