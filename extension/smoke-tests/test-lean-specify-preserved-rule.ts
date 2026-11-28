#!/usr/bin/env bun
/**
 * #2668: the green-only freeze rule, falsifiable in BOTH its copies.
 *
 * The rule is that a declared-preserved file joins the frozen contract as a must-pass file ONLY when the
 * red proof classified it `green` on the base. Three mutants of it (treat `infra` as the freezing kind,
 * also freeze `unclear`, drop the kind check) each survived the whole preservation suite, because every
 * through-the-step case that looked at an `unclear` row had its rows refused earlier — as malformed calls
 * — so the freeze rule never saw a verdict at all. A case that never reaches the rule cannot falsify it.
 *
 * So each arm of the rule is asked directly, and the step is driven again through the rule itself:
 *
 *   (a) `mustPassFiles` over a mixed `ProvedFile[]`: green, unclear, red and infra, declared and
 *       undeclared, with and without a red sibling under the same criterion. Each arm is the only thing
 *       that keeps one path out, so each is the assertion that kills its mutant.
 *   (b) `proofRule.keeps` — the step's copy of the same rule, asked per candidate over the verdicts the
 *       proof loop collects: the green half and the red-sibling half are each falsifiable.
 *   (c) through the REAL `specify` step: one declared-preserved row whose file the runner cannot classify
 *       (non-zero, output naming neither the path nor its basename), and nothing else standing between
 *       that file and the freeze rule. Nothing freezes, the criterion keeps its gap, the file is gone.
 *   (d) the same through the loop's keep/delete decision, where a real red proves the delete ran.
 *   (e) the disclosure bounds live in `test-lean-specify-preserved-disclosure.ts`, beside the clause's
 *       other renderings.
 *
 * Only the model is faked in (c) and (d): the repo, the runner, the proof and the commit are production
 * code. (a) and (b) are pure and call the same functions the step imports.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { proofRule, preservedCoverage } from "../src/lean-preserved-coverage.ts";
import { type ProvedFile, mustPassFiles } from "../src/lean-preserved-step.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  PANEL_CRITERIA,
  panelRepo,
  specBodyWith,
} from "./lib/lean-specify-preservation-fixture.ts";

/** A sixth criterion, so a case can carry an unclear row without stealing a panel criterion's coverage. */
const AC6 = { id: "AC6", text: "logs one line per retry window", verify: "test" as const };
/** A file the runner cannot classify: non-zero, and its output names neither the submitted path nor its basename. */
const unclearFile = (): string =>
  ["#!/bin/sh", 'echo "nothing here the runner could judge" 1>&2', "exit 3", ""].join("\n");
import { RUNNER } from "./lib/lean-specify-preservation-fixture.ts";
import {
  PANEL_IDS,
  type RowSpec,
  buildRows,
  greenFile,
  panelWrites,
  redFile,
  submitCalls,
  testRel,
} from "./lib/lean-panel-rows.ts";
import { configWith, runSpecify } from "./lib/lean-specify-fixture.ts";

/** A fresh fixture repo for one run: each case needs its own tree, its own base commit. */
const panelRepoFor = () => panelRepo();

const { assert, failures } = makeAssert();
const check = (msg: string, cond: boolean, detail?: string): void =>
  assert(cond, msg + (cond || detail === undefined ? "" : `\n    ${detail}`));

/** Runs the panel with the preserves switch at its default (unset = on). */
async function on<T>(body: () => Promise<T>): Promise<T> {
  let out!: T;
  await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: undefined }, async () => {
    out = await body();
  });
  return out;
}

const said = (r: Awaited<ReturnType<typeof runSpecify>>): string =>
  String(r.threw?.message ?? r.outcome?.reason ?? "");

const pf = (
  path: string,
  criterionId: string,
  kind: string,
  preserves: boolean,
): ProvedFile => ({ path, criterionId, kind, preserves });

const eq = (got: readonly string[], want: readonly string[]): boolean =>
  JSON.stringify(got) === JSON.stringify(want);


// ── (a) mustPassFiles, the rule's own arms, one file each
{
  const mixed: ProvedFile[] = [
    // Declared, green at base, no red under its criterion: the ONE case that freezes.
    pf("tests/AC1-guard.test.sh", "AC1", "green", true),
    // Declared but the child did not earn it: no declaration, no freeze.
    pf("tests/AC2-green.test.sh", "AC2", "green", false),
    // Declared, unclear: a non-zero exit that named nothing observes nothing about the base.
    pf("tests/AC3-unclear.test.sh", "AC3", "unclear", true),
    // Declared, red: an ordinary red test, the declaration changes nothing.
    pf("tests/AC4-red.test.sh", "AC4", "red", true),
    // Declared, infra: an unrunnable runner is refused as infrastructure before this, and must never freeze.
    pf("tests/AC5-infra.test.sh", "AC5", "infra", true),
    // Declared, green, but a SIBLING of the same criterion proved red: ordinary green, not a guard.
    pf("tests/AC6-green.test.sh", "AC6", "green", true),
    pf("tests/AC6-red.test.sh", "AC6", "red", true),
  ];
  const got = mustPassFiles(mixed);
  check(
    "(a) only a declared file the proof called green at base freezes",
    eq(got, ["tests/AC1-guard.test.sh"]),
    JSON.stringify(got),
  );
  // Each arm below is the whole reason one path stays out, so each is the assertion its mutant dies on.
  check(
    "(a) an unclear declared file does not freeze, whatever else the set holds",
    mustPassFiles([pf("tests/x.test.sh", "AC1", "unclear", true)]).length === 0,
  );
  check(
    "(a) an infra declared file does not freeze",
    mustPassFiles([pf("tests/x.test.sh", "AC1", "infra", true)]).length === 0,
  );
  check(
    "(a) a red declared file does not freeze (it is frozen as red, not as must-pass)",
    mustPassFiles([pf("tests/x.test.sh", "AC1", "red", true)]).length === 0,
  );
  check(
    "(a) an undeclared green does not freeze",
    mustPassFiles([pf("tests/x.test.sh", "AC1", "green", false)]).length === 0,
  );
  check(
    "(a) a green under a criterion with a real red does not freeze, in either order",
    mustPassFiles([
      pf("tests/x.test.sh", "AC1", "green", true),
      pf("tests/y.test.sh", "AC1", "red", true),
    ]).length === 0 &&
      mustPassFiles([
        pf("tests/y.test.sh", "AC1", "red", true),
        pf("tests/x.test.sh", "AC1", "green", true),
      ]).length === 0,
  );
  check(
    "(a) a kind the proof never returns freezes nothing",
    mustPassFiles([pf("tests/x.test.sh", "AC1", "unknown-to-the-proof", true)]).length === 0,
  );
  check(
    "(a) two declared green files of one criterion both freeze, and each path appears once",
    eq(
      mustPassFiles([
        pf("tests/a.test.sh", "AC1", "green", true),
        pf("tests/b.test.sh", "AC1", "green", true),
        pf("tests/a.test.sh", "AC1", "green", true),
      ]),
      ["tests/a.test.sh", "tests/b.test.sh"],
    ),
  );
  check("(a) nothing proved means nothing frozen", mustPassFiles([]).length === 0);
}

// ── (b) proofRule.keeps — the step's own copy of the same two halves
{
  const cand = (path: string, criterionId: string) => ({ path, criterionId });
  const kinds = new Map<string, { kind: string }>([
    ["tests/green.test.sh", { kind: "green" }],
    ["tests/unclear.test.sh", { kind: "unclear" }],
    ["tests/infra.test.sh", { kind: "infra" }],
    ["tests/red-a.test.sh", { kind: "red" }],
    ["tests/green-sibling.test.sh", { kind: "green" }],
  ]);
  // AC1 is a criterion whose proof returned no red at all: its declared green freezes, and its unclear and
  // infra siblings are dropped. AC5 carries the green that shares its criterion with a real red — the only
  // state where the rule's sibling clause is the whole decision. AC2 is the same green, undeclared.
  const kept = [{ criterionId: "AC1", preserves: true }, { criterionId: "AC2" }];
  const candidates = [
    cand("tests/green.test.sh", "AC1"),
    cand("tests/unclear.test.sh", "AC1"),
    cand("tests/infra.test.sh", "AC1"),
    cand("tests/green.test.sh", "AC2"),
    cand("tests/red-a.test.sh", "AC1"),
    cand("tests/green-sibling.test.sh", "AC1"),
  ];
  const rule = proofRule(kept, candidates, kinds);
  // The step's copy of the rule. The loop asks it at `specify-run.ts` line 305 in the form
  // `if (rule.isPreserved(id) && !rule.keeps(cand)) continue;`: a DECLARED non-red candidate is kept (and
  // so frozen) only when its own verdict was `green` AND some file of its criterion proved red. The second
  // half reads positively, so asking about a candidate the proof called RED is not a state the rule is ever
  // consulted for — the loop took its red arm and continued. Each check below is a state the step does ask
  // about, and each is the one a mutant of one half survives without.
  const keeps = (path: string, criterionId: string): boolean =>
    rule.keeps(cand(path, criterionId));
  check(
    "(b) a declared green with no red under its criterion keeps its place, and so freezes",
    keeps("tests/green.test.sh", "AC1") === true,
  );
  check(
    "(b) a declared unclear is dropped: the green half of the rule is load-bearing",
    keeps("tests/unclear.test.sh", "AC1") === false,
  );
  check(
    "(b) a declared infra is dropped: an unrunnable runner freezes nothing",
    keeps("tests/infra.test.sh", "AC1") === false,
  );
  check(
    "(b) a declared green whose criterion has a real red keeps nothing: the sibling half decides it alone",
    keeps("tests/green-sibling.test.sh", "AC5") === false,
  );
  check(
    "(b) an undeclared green is not excused by the rule: it stays an ordinary non-red the loop discloses",
    rule.isPreserved("AC2") === false && keeps("tests/green.test.sh", "AC2") === false,
  );
  check(
    "(b) a candidate the proof never judged is not a keeper",
    rule.keeps(cand("tests/never-proved.test.sh", "AC1")) === false,
  );
  check(
    "(b) isPreserved reads the kept rows, not the candidates",
    rule.isPreserved("AC1") === true && rule.isPreserved("AC2") === false,
  );
  // The coverage half reads the same verdicts: an unclear declared row freezes nothing and excuses nothing.
  const cov = preservedCoverage({
    candidates: [{ path: "tests/g.test.sh", criterionId: "AC1" }],
    kinds: new Map([["tests/g.test.sh", { kind: "green" }]]),
    rows: [{ criterionId: "AC1", preserves: true }],
    wanted: ["AC1"],
  });
  check(
    "(b) the coverage half freezes the green and excuses its criterion",
    eq(cov.mustPass, ["tests/g.test.sh"]) &&
      eq(cov.preservedIds, ["AC1"]) &&
      cov.missing.length === 0,
    JSON.stringify(cov),
  );
  const covUnclear = preservedCoverage({
    candidates: [{ path: "tests/g.test.sh", criterionId: "AC1" }],
    kinds: new Map([["tests/g.test.sh", { kind: "unclear" }]]),
    rows: [{ criterionId: "AC1", preserves: true }],
    wanted: ["AC1"],
  });
  check(
    "(b) and for an unclear verdict freezes nothing and excuses nothing",
    covUnclear.mustPass.length === 0 &&
      covUnclear.preservedIds.length === 0 &&
      covUnclear.contract.length === 0 &&
      eq(covUnclear.missing, ["AC1"]),
    JSON.stringify(covUnclear),
  );
}

// ── (c) through the real step: an unclear declared-preserved row, nothing else in the way
//
// The rows come from the shared helper, which takes a criterion ID. The shape that used to build them,
// `PANEL_IDS.map((row) => row.id)` over a list of STRINGS, gave every row an `undefined` criterion, so all
// five calls were refused as malformed at the extractor and the step proved nothing — no verdict, no freeze
// rule, no disclosure. That is how three mutants of this rule passed the whole suite, so every check here
// reads the PROOF's words, which a boundary refusal cannot produce.
{
  // Two declared criteria, so both halves of the rule decide something observable. AC5 carries the
  // declared UNCLEAR file under test: the shipped rule drops it and leaves AC5 uncovered, and a rule that
  // froze it would name AC5 preserved and add a sixth frozen file. AC1 is declared, covered by its own
  // red, and carries a GREEN sibling — the red-sibling half is the only thing keeping that green out of
  // the contract, so a mutant that drops it shows in the frozen set rather than only in prose.
  const rows2 = buildRows([
    { id: "AC1", script: redFile(), rel: testRel("AC1"), preserves: true },
    { id: "AC1", script: greenFile(), rel: "tests/AC1-sibling-green.test.sh", preserves: true },
    { id: "AC2", script: redFile() },
    { id: "AC3", script: redFile() },
    { id: "AC4", script: redFile() },
    { id: "AC5", script: redFile() },
    { id: "AC6", script: unclearFile(), rel: "tests/AC6-unclear.test.sh", preserves: true },
  ]);
  const r = await on(() =>
    runSpecify({
      ...panelRepoFor(),
      issue: 2710,
      config: configWith({ fast: "true", test: RUNNER }),
      specBody: specBodyWith([...PANEL_CRITERIA, AC6]),
      writes: panelWrites(rows2),
      toolUses: submitCalls(rows2),
    }),
  );

  check(
    "(c) the step proved the unclear row: the child was dispatched once and no row was refused as malformed",
    r.dispatched === 1 && said(r).includes("malformed") === false,
    `${String(r.dispatched)} / ${said(r)}`,
  );
  check(
    "(c) AC1's green sibling was refused by the red-sibling half, in the proof's own words",
    said(r).includes("tests/AC1-sibling-green.test.sh: exited 0 on base"),
    said(r),
  );
  check(
    "(c) the run is refused: only a wrong freeze could have covered AC5",
    r.outcome?.kind === "red-test-gap",
    said(r),
  );

  check(
    "(c) nothing froze: no unclear file joined the contract, and no green sibling did either",
    Object.keys(r.outcome?.frozen ?? {}).length === 0,
    JSON.stringify(r.outcome?.frozen),
  );
  check(
    "(c) and nothing is disclosed as preserved",
    r.outcome?.preserved === undefined,
    JSON.stringify(r.outcome?.preserved),
  );
  // The keep rule's own words are the reason the file is NOT disclosed: a non-red the rule REFUSES is
  // noted and deleted, while a declared non-red the rule DROPS is silent and stays for the commit to
  // reject. That asymmetry is what a mutant that freezes the unclear file loses, and it is what this
  // case pins: the file the rule dropped is the file the commit could not hold.
  check(
    "(c) the unclear file stayed in the tree: the keep rule dropped it BEFORE the note and the delete",
    existsSync(`${r.worktree}/tests/AC6-unclear.test.sh`),
    `${r.worktree}/tests/AC6-unclear.test.sh`,
  );
  check(
    "(c) and AC1's refused green was deleted too",
    !existsSync(`${r.worktree}/tests/AC1-sibling-green.test.sh`),
  );
}

// ── (d) the same state where the step DOES commit: the freeze rule alone decides the contract
//
// AC1 is declared and carries its own red plus a green sibling; AC5 is declared and its proof came back
// unclear, and it is covered by nothing — except a freeze. So the four ordinary reds cover AC2–AC4, the
// commit runs, and the only thing deciding whether the unclear file joins the contract (and whether AC5 is
// named as preserved) is the rule. A mutant that freezes on any kind turns this `ok` run into one holding a
// sixth frozen file with AC5 disclosed as a guard.
{
  const rows = buildRows([
    { id: "AC1", script: redFile(), rel: testRel("AC1"), preserves: true },
    { id: "AC1", script: greenFile(), rel: "tests/AC1-sibling-green.test.sh", preserves: true },
    { id: "AC2", script: redFile() },
    { id: "AC3", script: redFile() },
    { id: "AC4", script: redFile() },
    { id: "AC5", script: redFile() },
    { id: "AC6", script: unclearFile(), rel: "tests/AC6-unclear.test.sh", preserves: true },
  ]);
  const r = await on(() =>
    runSpecify({
      ...panelRepoFor(),
      issue: 2711,
      config: configWith({ fast: "true", test: RUNNER }),
      specBody: specBodyWith([...PANEL_CRITERIA, AC6]),
      writes: panelWrites(rows),
      toolUses: submitCalls(rows),
    }),
  );
  check(
    "(d) the run was refused, and AC6 is the only criterion it could not cover",
    r.outcome?.kind === "red-test-gap" &&
      (r.outcome?.failedRules ?? []).some((x) => x.startsWith("criterion AC6 has no red test")) &&
        (r.outcome?.failedRules ?? []).length === 1,
    JSON.stringify(r.outcome?.failedRules),
  );
  const committed = execFileSync(
    "git",
    ["-C", r.worktree, "show", "--name-only", "--format=", "HEAD"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((l) => l.startsWith("tests/"));
  // A mutant that lets the unclear file freeze makes AC6 covered, so the run COMMITS and this list is the
  // six reds plus that file. Under the shipped rule there is no contract at all: nothing was committed, and
  // `preserved` is absent for the same reason.
  check(
    "(d) no contract was committed: only a wrong freeze could have covered AC6",
    committed.length === 0 && Object.keys(r.outcome?.frozen ?? {}).length === 0,
    `${committed.join(",")} / ${JSON.stringify(r.outcome?.frozen)}`,
  );
  check(
    "(d) and the record discloses no preserved criterion: a declaration earned no freeze",
    r.outcome?.preserved === undefined,
    JSON.stringify(r.outcome?.preserved),
  );
  check(
    "(d) the green sibling the rule refused IS disclosed, and the unclear file it dropped is not",
    said(r).includes("tests/AC1-sibling-green.test.sh: exited 0 on base") &&
      said(r).includes("without naming") === false,
    said(r),
  );
  check(
    "(d) and the dropped file stayed in the tree, which is what made the commit impossible",
    existsSync(`${r.worktree}/tests/AC6-unclear.test.sh`),
    `${r.worktree}/tests/AC6-unclear.test.sh`,
  );
  // The same shape with a GREEN declared file is the rule's positive arm through the real step: the file
  // freezes, its criterion is named, and the contract grows by exactly one file.
  const greenRows = buildRows([
    { id: "AC1", script: redFile(), rel: testRel("AC1"), preserves: true },
    { id: "AC1", script: greenFile(), rel: "tests/AC1-sibling-green.test.sh", preserves: true },
    { id: "AC2", script: redFile() },
    { id: "AC3", script: redFile() },
    { id: "AC4", script: redFile() },
    { id: "AC5", script: redFile() },
    { id: "AC6", script: greenFile(), rel: "tests/AC6-unclear.test.sh", preserves: true },
  ]);
  const still = await on(() =>
    runSpecify({
      ...panelRepoFor(),
      issue: 2712,
      config: configWith({ fast: "true", test: RUNNER }),
      specBody: specBodyWith([...PANEL_CRITERIA, AC6]),
      writes: panelWrites(greenRows),
      toolUses: submitCalls(greenRows),
    }),
  );
  check(
    "(d) a declared green with no red of its own DOES freeze, and is disclosed beside the six reds",
    still.outcome?.kind === "ok" &&
      Object.keys(still.outcome?.frozen ?? {}).length === 6 &&
      said(still).includes("froze 5 red test file(s)") &&
      said(still).includes("preserved 1 criterion/criteria (AC6)"),
    `${said(still)} / ${JSON.stringify(Object.keys(still.outcome?.frozen ?? {}))}`,
  );
}


process.exit(failures());
