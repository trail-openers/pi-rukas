#!/usr/bin/env bun
/**
 * #1707 round-2/3 — markup is not a pattern.
 *
 * The plan-to-spec gate (#819) exempts a deliverable slot no plan may DECLARE
 * (a glob or a `<name>` template — `planDeclarableSlot`). The previous round
 * judged that exemption on the slot's RAW text, which failed twice:
 *
 *   - INERT: `parseDeliverables` already runs `normaliseDeclaredPath` on every
 *     slot, and that normaliser's markup strip (`[/`*\s]+` at each end) ate a
 *     trailing `*` — so the raw text the judge asked for never existed in
 *     production, and the tests that exercised it hand-built specs the parser
 *     cannot produce.
 *   - FAIL-OPEN: on raw text, `**extension/src/review-ledger.ts**` (markdown
 *     bold) and `*x*` carry a `*`, so a CONCRETE required path read as a
 *     pattern and exempted itself — the #819 gate silently disabled for exactly
 *     the slot it exists to hold the plan to.
 *
 * The fix is at the root: `normaliseDeclaredPath` now strips only PAIRED
 * wrappers, so a written wildcard survives normalisation and markup does not,
 * and the exemption is judged on that ONE normalised form. This file pins both
 * directions:
 *
 *   - an emphasised / inline-coded / annotated slot stays REQUIRED — refused
 *     when no workstream declares it, and named in the uncovered row by its
 *     normalised path;
 *   - an annotated slot whose parenthetical carries a pathspec character
 *     (`(created!)`, `(see docs?)`) stays required too, because the annotation
 *     is gone before the pattern question is asked;
 *   - the spec-ARTIFACT restore path (`validateSpec` bounds `d.paths` but does
 *     NOT normalise them) is judged after the gate normalises for itself.
 *
 * The glob half of the same rule (a written `*` reaches the judge and is
 * exempted, never demanded or repaired) lives in
 * `test-plan-spec-glob-coverage.ts`.
 *
 * Offline: pure functions over (workstreams, spec). No dispatch, no git, no fs.
 */

import { parseNormalisedSpec } from "../src/work-driver-intent.ts";
import {
  findUncoveredDeliverables,
  planDeclarableSlot,
  planSpecMismatchReason,
  undeclarableSlotsOf,
} from "../src/work-driver-plan-spec-coverage.ts";
import { normaliseDeclaredPath } from "../src/work-driver-declared-path.ts";

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

/** A one-deliverable spec, built through the real parser from real spec text. */
function specOf(pathsSlot: string, id = "d1") {
  return parseNormalisedSpec(
    [
      "INTENT-VERDICT: proceed",
      "",
      "## Spec",
      "",
      "### Intent",
      "x",
      "",
      "### Deliverables",
      `- ${id}: slots under test [paths: ${pathsSlot}]`,
      "",
      "### Acceptance criteria",
      "- x",
      "",
      "### Evidence",
      "- c — src/a.ts — confirmed",
    ].join("\n"),
  );
}

// ------------------------------- the normaliser, in isolation -----------------

{
  const cases: Array<[string, string]> = [
    ["**extension/src/review-ledger.ts**", "extension/src/review-ledger.ts"],
    ["*extension/src/review-ledger.ts*", "extension/src/review-ledger.ts"],
    ["`extension/src/review-ledger.ts`", "extension/src/review-ledger.ts"],
    ["**src/a.ts (new)**", "src/a.ts"],
    ["**src/a.ts** (new)", "src/a.ts"],
    ["`src/a.ts` (new)", "src/a.ts"],
    ["src/a.ts (created!)", "src/a.ts"],
    ["src/a.ts (see docs?)", "src/a.ts"],
    // A wildcard is NOT markup. These three are the whole point of #1707.
    ["src/foo/*", "src/foo/*"],
    ["src/review-ledger-*", "src/review-ledger-*"],
    ["src/*.ts", "src/*.ts"],
    // A glob at both ends survives too: stripping it would hand back `/foo`.
    ["*/foo/*", "*/foo/*"],
    ["**/*.ts", "**/*.ts"],
    // A directory written with a trailing `/**` keeps the glob here — the
    // fence grammar reads that spelling itself (`fenceCoveringBroader`).
    ["extension/src/**", "extension/src/**"],
    ["__tests__/foo.ts", "__tests__/foo.ts"],
  ];
  for (const [raw, want] of cases) {
    assert(
      normaliseDeclaredPath(raw) === want,
      `normaliseDeclaredPath(${JSON.stringify(raw)}) -> ${JSON.stringify(want)}`,
    );
  }
}

// --------------------- markup must NOT exempt a concrete slot -----------------

{
  const MARKUP_SLOTS = [
    "**extension/src/review-ledger.ts**",
    "`extension/src/review-ledger.ts`",
    "*extension/src/review-ledger.ts*",
    "src/a.ts (created!)",
    "src/a.ts (see docs?)",
    "**src/a.ts (new)**",
  ];
  for (const slot of MARKUP_SLOTS) {
    assert(
      planDeclarableSlot(slot) === true,
      `#1707 round-2: ${JSON.stringify(slot)} is a CONCRETE slot — markup and annotation are not a pattern, so it stays declarable and therefore REQUIRED`,
    );
  }
  // And it is never traced as an exemption — the trace is for what the gate
  // dropped, and this is nothing the gate dropped.
  assert(
    undeclarableSlotsOf({
      deliverables: [{ id: "d1", paths: MARKUP_SLOTS }],
    }).length === 0,
    "none of the markup/annotated slots is traced as exempted — the gate judged every one",
  );
}

{
  // The end-to-end shape: a deliverable whose three slots are written with
  // emphasis, an annotation carrying a `!`, and inline code with an annotation
  // carrying a `?`. Pre-fix, ALL THREE exempted themselves on raw text and the
  // gate passed a plan that declared none of them.
  const spec = specOf(
    "**extension/src/review-ledger.ts**, src/a.ts (created!), `src/b.ts` (see docs?)",
  );
  assert(
    spec?.deliverables[0]?.paths.join(",") ===
      "extension/src/review-ledger.ts,src/a.ts,src/b.ts",
    `parser: emphasis and annotations strip to the concrete paths the plan owes (got ${JSON.stringify(spec?.deliverables[0]?.paths)})`,
  );
  const refused = planSpecMismatchReason(ws({ a: ["src/unrelated.ts"] }), spec, []);
  assert(
    refused?.kind === "uncovered-deliverables",
    "#1707 round-2: an emphasised/annotated slot no workstream declares is REFUSED — markup does not exempt a required path (pre-fix this returned undefined: every slot read as a glob)",
  );
  assert(
    (refused?.uncovered?.[0]?.paths ?? []).join(",") ===
      "extension/src/review-ledger.ts,src/a.ts,src/b.ts",
    `and the uncovered row names the normalised concrete paths, never the markup (got ${JSON.stringify(refused?.uncovered?.[0]?.paths)})`,
  );
  assert(
    planSpecMismatchReason(
      ws({ a: ["extension/src/review-ledger.ts", "src/a.ts", "src/b.ts"] }),
      spec,
      [],
    ) === undefined,
    "and the plan that declares all three passes — the slots were required, not waived",
  );
}

{
  // The mixed deliverable keeps its bite in BOTH directions: markup stays
  // required, the real glob in the same list stays exempt. One representation
  // on the slot, two honest verdicts.
  const spec = specOf("**src/a.ts**, src/patterns-*.ts");
  const r = findUncoveredDeliverables(ws({ a: ["src/other.ts"] }), spec, []);
  const row = r.uncovered.find((d) => d.id === "d1")?.paths ?? [];
  assert(
    row.join(",") === "src/a.ts",
    `the row demands the emphasised concrete path and exempts only the glob (got ${JSON.stringify(row)})`,
  );
  assert(
    r.checkedCount === 1,
    "the deliverable is still JUDGED — exempting a slot never drops the deliverable",
  );
}

// ------------------- the artifact-restore path (un-normalised slots) ----------

{
  // `validateSpec` restores a persisted spec with `paths: d.paths.map(boundReadText)`
  // — bounded, but NEVER normalised. So the gate can be handed the planner's
  // raw text straight off disk, and it must normalise for itself rather than
  // assume `parseDeliverables` already ran.
  const restored = {
    deliverables: [{ id: "d1", paths: [" **src/a.ts** ", "src/b.ts (new)", "src/*.ts"] }],
  };
  assert(
    planDeclarableSlot(normaliseDeclaredPath(restored.deliverables[0]?.paths[0] ?? "")) === true,
    "artifact path: an emphasised slot is declarable once normalised",
  );
  const r = findUncoveredDeliverables(ws({ a: ["src/other.ts"] }), restored, []);
  const row = r.uncovered.find((d) => d.id === "d1")?.paths ?? [];
  assert(
    row.join(",") === "src/a.ts,src/b.ts",
    `artifact path: the gate normalises the slots it was handed, and the glob is excluded from the row (got ${JSON.stringify(row)})`,
  );
  assert(
    r.checkedCount === 1,
    "artifact path: a deliverable with at least one declarable slot is still judged",
  );
  const covered = findUncoveredDeliverables(
    ws({ a: ["src/a.ts", "src/b.ts"] }),
    restored,
    [],
  );
  assert(
    covered.uncovered.length === 0,
    "artifact path: the plan that declares the two concrete slots covers the restored deliverable",
  );
}

process.exit(exit);
