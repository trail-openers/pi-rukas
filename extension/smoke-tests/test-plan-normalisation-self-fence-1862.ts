#!/usr/bin/env bun
/**
 * #1862 (a) — after the plan step's normalisation, no surviving workstream
 * carries a fence that covers its own declared paths, and the drop is visible
 * in the state file.
 *
 * The field shape (reported on the issue from an external harness's headless
 * cycles): a documentation workstream merged into an implementer, and the
 * merged workstream kept the docs half's out-of-scope sentence over the very
 * subtree its own `paths` authorised. The developer was told not to touch what
 * it had to change, and a deliverable ended partial.
 *
 * The fixture's two halves share a file. That is deliberate, and it is what
 * makes the merge real: rule 1 of the coupling check (Jaccard ≥ 0.5 over the
 * declared path sets) is what merged the field's halves, so the plan here is
 * merged by the driver's own rules rather than by a fixture declaring its own
 * post-merge shape. `runPlanCouplingPass` is reached through
 * `runPlanNormalisationPass`, which is the seam the issue names.
 *
 * Why THIS seam and not `foldTwo` directly: `foldTwo` is the helper, but the
 * plan step's contract is what the develop gate and every downstream reader
 * see — and `foldTwo` runs in the coupling pass, BEFORE the issue-named unfence
 * (`runPlanNormalisationPass` owns that order precisely because both passes
 * rewrite `outOfScope`). A drop that only held inside the fold could be
 * reintroduced by the tail, which is the shape the issue's gap gate flagged:
 * the plan-time invariant has to be asserted over the map the plan step
 * RETURNS, using the plan step's own predicate (`findFenceContradictions`, the
 * one `planQualityReason` answers `contradictory-fence` with).
 *
 * The merge that produces the field shape is driven for real, through the
 * coupling rules (two workstreams over the same file set ⇒ Jaccard ≥ 0.5 ⇒
 * merged), not hand-assembled.
 *
 * Offline: no dispatch, no network. The `execFn` stub answers the identifier
 * grep so the issue-named pass runs without git.
 */

import { rm, writeFile } from "node:fs/promises";
import { findFenceContradictions } from "../src/work-driver-plan-paths.ts";
import { runPlanNormalisationPass } from "../src/work-driver-plan-coupling-pass.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The identifier-grep stub: every symbol resolves to exactly one file. */
function stubExec(definitions: Record<string, string[]>) {
  return async (_cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    if (argv[0] === "grep") {
      const name = argv[5] ?? "";
      return { stdout: (definitions[name] ?? []).map((f) => `${f}\0`).join("") };
    }
    if (argv[0] === "show") {
      const file = (argv[1] ?? "").split(":")[1] ?? "";
      const defining = Object.entries(definitions).find(([, files]) => files.includes(file))?.[0];
      return {
        stdout: defining ? `export function ${defining}(x: unknown) {\n  return 1;\n}\n` : "//\n",
      };
    }
    return { stdout: "" };
  };
}

const WS = (id: string, paths: string[], outOfScope: string[]): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

/**
 * The field's plan: an implementer and a docs workstream over one subtree, the
 * shape that made the harness merge them. The merge is driven for real through
 * the coupling rules rather than hand-assembled, so the two halves share
 * enough files for rule 1's Jaccard ≥ 0.5 to fire: both declare
 * `tests/test_x.py` and `agents/x.md`, and the driver keeps the surviving
 * half's id. `tests/test_y.py` is the docs half's own file, which the merge
 * must carry into the survivor's `paths`. `.ci/` names nothing either half
 * declares, which is what makes it the must-survive control in case 3.
 */
function fieldPlan(): Record<string, Workstream> {
  return {
    implement: WS("implement", ["tests/test_x.py", "agents/x.md"], [".ci/"]),
    document: WS("document", ["tests/test_x.py", "tests/test_y.py", "agents/x.md"], [
      "Every file under agents/ and tests/ — this workstream documents, it does not implement",
      "tests/",
      ".ci/",
    ]),
  };
}

const body = [
  "# Title",
  "",
  "## Resolved decisions",
  "- The seam lives in tests/test_x.py.",
  "",
  "## Out of scope",
  "- nothing else",
].join("\n");

async function normalise(plan: Record<string, Workstream>) {
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/plan-self-fence-1862-${process.pid}-${Math.random().toString(36).slice(2)}.md`;
  await writeFile(tmp, body);
  try {
    const state = {
      ...initialState(1862, 1_000_000),
      pipelineState: {
        ...initialState(1862, 1_000_000).pipelineState,
        issueBodyArtifact: tmp,
        baseSha: "HEAD",
      },
    };
    return await runPlanNormalisationPass(plan, state, {
      repoRoot: "/repo",
      execFn: stubExec({}),
    });
  } finally {
    await rm(tmp, { force: true });
  }
}

// ────────────────────────────── 1. the merge happens (the fixture is real),
// and no SURVIVING workstream carries a fence covering its own paths.
{
  const out = await normalise(fieldPlan());
  const ids = Object.keys(out.workstreams);
  assert(ids.length === 1, `the coupling rules merged the two halves into one workstream (got ${JSON.stringify(ids)})`);
  const ws = out.workstreams[ids[0] ?? ""];
  assert(
    (ws?.paths ?? []).includes("tests/test_x.py") && (ws?.paths ?? []).includes("tests/test_y.py"),
    `the merged workstream owns both halves' files (got ${JSON.stringify(ws?.paths)})`,
  );  const still = findFenceContradictions(out.workstreams);
  assert(
    still.length === 0,
    `the plan step's own predicate finds no fence covering a workstream's own paths (got ${JSON.stringify(still)})`,
  );
  assert(
    !ws?.outOfScope.some((e) => e.startsWith("Every file under agents/") || e === "tests/"),
    `the docs half's fence over the merged subtree is gone (got ${JSON.stringify(ws?.outOfScope)})`,
  );
}

// ────────────────────────────── 2. the drop is in the STATE FILE, not only in
// trace(): `planQuality.unfence.selfFences` counts the fold's removals and the
// notes carry the wording an operator reads. A merge is required to make this
// count fire, which is why the fixture above shares a file.
{
  const out = await normalise(fieldPlan());
  const summary = out.summary;
  assert(summary?.ran === true, "the unfence record says the plan step normalised this plan");
  assert(
    (summary?.selfFences ?? 0) >= 2,
    `the record counts BOTH self-fences the fold dropped — the prose sentence and the directory spelling (got ${JSON.stringify(summary)})`,
  );
  assert(
    (summary?.notes ?? []).some(
      (n) => n.startsWith("self-fence dropped: ") && n.includes("(merged workstream)"),
    ),
    `and the notes carry the drop wording (got ${JSON.stringify(summary?.notes)})`,
  );
  assert(
    (summary?.removed ?? 0) === 0,
    "the issue-named count is untouched by a fold drop — the two rules answer to different authorities",
  );
}

// ────────────────────────────── 3. the drop does NOT widen the plan. A fence
// naming a subtree NO workstream declares stays, so the merged workstream is
// still refused if it wanders into it. `.ci/` is that control — no half of the
// field plan declares anything under it and the issue never names it. (`docs/`
// cannot be the control: the merge reduces this plan to one workstream, and the
// #1250 N=1 docs/test rule opens a docs fence on its own authority — that rule
// has its own suite, and its knob is turned off for this case so the assertion
// judges THIS fix.) The issue-named `removed` count is pinned apart from
// `selfFences` for the same reason: two authorities, two counts, and a fold
// drop must never inflate the number that says "the issue named this".
{
  const prev = process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS;
  process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS = "0";
  try {
    const out = await normalise(fieldPlan());
    const ws = out.workstreams[Object.keys(out.workstreams)[0] ?? ""];
    assert(
      ws?.outOfScope.includes(".ci/") === true,
      `the fence naming a subtree nobody declared survives (got ${JSON.stringify(ws?.outOfScope)})`,
    );
    assert(
      (out.summary?.removed ?? 0) === 0,
      `the issue-named count is untouched by a fold drop — two authorities, two counts (got ${JSON.stringify(out.summary)})`,
    );
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS;
    else process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS = prev;
  }
}

// ────────────────────────────── 4. the invariant over a plan that needs no
// merge: each workstream keeps its sibling's fence (the #572 cross-declaration
// contract), so this fix cannot become a fence-wipe for every plan.
{
  const disjoint = {
    a: WS("a", ["src/a.ts"], ["src/b.ts"]),
    b: WS("b", ["src/b.ts"], ["src/a.ts"]),
  };
  const out = await normalise(disjoint);
  assert(
    out.workstreams.a?.outOfScope.includes("src/b.ts") === true &&
      out.workstreams.b?.outOfScope.includes("src/a.ts") === true,
    `sibling fences survive a normalised plan (a: ${JSON.stringify(out.workstreams.a?.outOfScope)}, b: ${JSON.stringify(out.workstreams.b?.outOfScope)})`,
  );
  assert(out.summary?.selfFences === undefined, "and nothing is recorded as a fold drop");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
