#!/usr/bin/env bun
/**
 * #2668: only a file the red proof CLASSIFIED GREEN at the base may freeze as must-pass.
 *
 * The rule's whole claim is that a preserved file states behaviour the BASE ALREADY HAS, and the only
 * evidence the step has for that is the proof's own verdict: `green` means the runner exited 0 on the
 * base. An `unclear` verdict — a non-zero exit that never named the file — establishes nothing about the
 * base at all, so freezing it as a must-pass guard would be the step asserting a fact it never observed
 * and then billing `verify` for it at head. It is dropped with the same note an undeclared non-red file
 * earns today, and its criterion keeps the coverage gap.
 *
 *   (a) a declared-preserved row whose file the proof calls unclear is dropped, disclosed, unexcused,
 *       and its file is gone from the tree and from the commit;
 *   (b) the ordinary green-at-base declaration still freezes (the rule is not weakened);
 *   (c) the record's `preserved` list names only what actually froze, so a `preserves: true` row that
 *       was an ordinary red at base is not disclosed as a frozen must-pass file;
 *   (d) the committed reason counts the red files and names the preserved ids separately.
 *
 * Real `specify` step, real repo, real runner; only the model is faked.
 */

import { existsSync } from "node:fs";
import { git } from "./lib/lean-specify-fixture.ts";
import { neededFromLog } from "../src/lean/handback.ts";
import { buildOutcome, outcomeProblem } from "../src/lean/state-outcome.ts";
import { preservedClause, preservedIds } from "../src/preserved-disclose.ts";
import type { Step } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  PANEL_IDS,
  type PanelRow,
  greenFile,
  panelRows,
  runPanel,
  testRel,
} from "./lib/lean-specify-preservation-fixture.ts";
import { redFile } from "./lib/lean-specify-preservation-fixture.ts";

const { assert, failures } = makeAssert();
const check = (msg: string, cond: boolean, detail?: string): void =>
  assert(cond, msg + (cond || detail === undefined ? "" : `\n    ${detail}`));

const GREEN = "AC5";

async function on<T>(body: () => Promise<T>): Promise<T> {
  let out!: T;
  await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: undefined }, async () => {
    out = await body();
  });
  return out;
}

/** The step's recorded reason, or the error it threw. */
function said(r: Awaited<ReturnType<typeof runPanel>>): string {
  return String(r.threw?.message ?? r.outcome?.reason ?? "");
}

/**
 * A file the runner cannot classify: it exits non-zero and its output is one word the proof looks for in
 * neither form (`specify-proof` calls a non-zero exit that names neither the submitted path nor its
 * basename `unclear`). The word is deliberately not a substring of the test's own name.
 */
function unclearFile(): string {
  return ["#!/bin/sh", 'echo "nothing here the runner could judge" 1>&2', "exit 3", ""].join("\n");
}

/**
 * The acceptance tests in the tree at `ref`, read with the fixture's own git env.
 *
 * `execFileSync` with the ambient env reads a different repository view than the one the step wrote
 * (the fixture isolates HOME and XDG_CONFIG_HOME for every git child it and the product both run), so a
 * case that asked git itself would be reading the operator's config, not the run's tree.
 */
function committedFiles(r: Awaited<ReturnType<typeof runPanel>>): string[] {
  return git(r.worktree, "show", "--name-only", "--format=", "HEAD")
    .split("\n")
    .filter((l) => l.startsWith("tests/"));
}

const rowsWith = (id: string, script: string, preservedId?: string): PanelRow[] =>
  PANEL_IDS.map((row) => ({
    id: row.id,
    script: row.id === id ? script : redFile(),
    ...(row.id === preservedId ? { preserves: true } : {}),
  }));

// (a) an `unclear` verdict on a declared-preserved row is a drop, not a freeze.
{
  const r = await on(() => runPanel({ issue: 2700, rows: rowsWith(GREEN, unclearFile(), GREEN) }));
  check(
    "(a) an unclear declared-preserved file does not complete the run",
    r.outcome?.kind === "red-test-gap",
    `${String(r.outcome?.kind)} / ${said(r)}`,
  );
  check(
    "(a) its criterion keeps the coverage gap",
    said(r).includes(`criterion ${GREEN} has no red test`),
    said(r),
  );
  check(
    "(a) the drop carries the proof's own words, as an undeclared non-red file's does",
    (r.outcome?.failedRules ?? []).some((x) => x.startsWith(`criterion ${GREEN} has no red test`)),
    JSON.stringify(r.outcome?.failedRules),
  );
  check(
    "(a) nothing was frozen",
    Object.keys(r.outcome?.frozen ?? {}).length === 0,
    JSON.stringify(r.outcome?.frozen),
  );
  check(
    "(a) no preserved list, so nothing is disclosed as a must-pass file",
    r.outcome?.preserved === undefined,
    JSON.stringify(r.outcome?.preserved),
  );
  check(
    "(a) the unclear file is gone from the worktree",
    !existsSync(`${r.worktree}/${testRel(GREEN)}`),
    `${r.worktree}/${testRel(GREEN)} still there`,
  );
}

// (b) the rule still works for a file the proof really did classify green at base.
{
  const r = await on(() => runPanel({ issue: 2701, rows: panelRows(GREEN, GREEN) }));
  check("(b) a green-at-base declaration still freezes", r.outcome?.kind === "ok", said(r));
  check(
    "(b) and names the preserved criterion",
    JSON.stringify(r.outcome?.preserved) === JSON.stringify([GREEN]),
    JSON.stringify(r.outcome?.preserved),
  );
  check(
    "(b) its file is in the commit",
    committedFiles(r).includes(testRel(GREEN)),
    committedFiles(r).join(","),
  );
}

// (c) a `preserves: true` on a row that was an ordinary RED at base is not disclosed as preserved.
{
  const r = await on(() =>
    runPanel({
      issue: 2702,
      rows: PANEL_IDS.map((id) => ({
        id,
        script: redFile(),
        ...(id === GREEN ? { preserves: true } : {}),
      })),
    }),
  );
  check("(c) the run still freezes its reds", r.outcome?.kind === "ok", said(r));
  check(
    "(c) a no-op declaration is not recorded as preserved",
    r.outcome?.preserved === undefined,
    JSON.stringify(r.outcome?.preserved),
  );
  check(
    "(c) and the reason does not name it as a must-pass freeze",
    !String(r.outcome?.reason ?? "").includes("preserved 1"),
    String(r.outcome?.reason),
  );
}

// (d) the committed reason counts reds and names preserved ids apart.
{
  const r = await on(() => runPanel({ issue: 2703, rows: panelRows(GREEN, GREEN) }));
  const reason = String(r.outcome?.reason ?? "");
  check(
    "(d) the reason counts the four RED files, not the five it froze",
    reason.includes("froze 4 red test file(s)"),
    reason,
  );
  check(
    "(d) and names the preserved ids separately",
    reason.includes(`preserved 1 criterion/criteria (${GREEN})`),
    reason,
  );
  check(
    "(d) the frozen map still holds all five files",
    Object.keys(r.outcome?.frozen ?? {}).length === 5,
    JSON.stringify(Object.keys(r.outcome?.frozen ?? {})),
  );
}

// (e) an all-preserved gap discloses its reason and the hint through the handback.
//
// The handback's second reading is keyed today on the reason containing `exited 0 on base`, which the
// all-preserved reason never says — so the operator gets the cause with no hint at all. The clause must
// key on the record's own preserved list.
{
  const r = await on(() =>
    runPanel({
      issue: 2704,
      rows: PANEL_IDS.map((id) => ({ id, script: greenFile(), preserves: true })),
    }),
  );
  check("(e) an all-preserved spec is refused", r.outcome?.kind === "red-test-gap", said(r));
  const text = neededFromLog([
    {
      state: "specify",
      key: "2704:specify:0",
      outcome: {
        ...(r.outcome ?? {}),
        kind: "red-test-gap",
      },
    } as unknown as Step,
  ]);
  check(
    "(e) the handback names the all-preserved reason",
    text.includes("every test criterion is preserved"),
    text,
  );
  check(
    "(e) and hands the operator the hint to declare a criterion as preserved",
    text.includes("declare it as preserved when submitting"),
    text,
  );
  check(
    "(e) it names the criteria the child claimed",
    text.includes(PANEL_IDS.join(", ")),
    text.slice(0, 300),
  );
}

// (f) the record's own rules, driven through the loader path that rebuilds an outcome field by field.
{
  const rebuilt = (oc: Record<string, unknown>): Record<string, unknown> =>
    buildOutcome(oc) as unknown as Record<string, unknown>;
  check(
    "(f) a list of ids rebuilds to that list",
    JSON.stringify(rebuilt({ kind: "ok", preserved: ["AC4", "AC5"] }).preserved) ===
      JSON.stringify(["AC4", "AC5"]),
    JSON.stringify(rebuilt({ kind: "ok", preserved: ["AC4", "AC5"] })),
  );
  // The validator refuses a written `[]`; the rebuilder must agree, or a record whose every entry was
  // invalid would carry a key claiming the field existed and named nothing.
  check(
    "(f) an empty list rebuilds to NO key, as the validator refuses it",
    !("preserved" in rebuilt({ kind: "ok", preserved: [] })),
    JSON.stringify(rebuilt({ kind: "ok", preserved: [] })),
  );
  check(
    "(f) a wholly invalid list rebuilds to NO key either",
    !("preserved" in rebuilt({ kind: "ok", preserved: ["nope", 7] })),
    JSON.stringify(rebuilt({ kind: "ok", preserved: ["nope", 7] })),
  );
  check(
    "(f) the key order is the one a resumed state file keeps: preserved last, beside derivedSpec",
    Object.keys(rebuilt({ kind: "ok", preserved: ["AC4"] })).at(-1) === "preserved",
    Object.keys(rebuilt({ kind: "ok", preserved: ["AC4"] })).join(","),
  );
  check(
    "(f) a non-array refusal names the problem rather than collapsing it",
    outcomeProblem({ kind: "ok", preserved: "AC4" }, "specify") ===
      "outcome preserved must be a string[]",
    String(outcomeProblem({ kind: "ok", preserved: "AC4" }, "specify")),
  );
  check(
    "(f) and so does an empty one",
    outcomeProblem({ kind: "ok", preserved: [] }, "specify") ===
      "outcome preserved must be absent rather than empty",
    String(outcomeProblem({ kind: "ok", preserved: [] }, "specify")),
  );
  check(
    "(f) and one holding a name that is not AC<n>",
    outcomeProblem({ kind: "ok", preserved: ["nope"] }, "specify") ===
      "outcome preserved holds a name that is not AC<n>",
    String(outcomeProblem({ kind: "ok", preserved: ["nope"] }, "specify")),
  );
  // The disclosure reads the record back, so it must survive a value the validator would never have
  // written — the same `Array.isArray` guard the validator carries.
  check(
    "(f) a non-array preserved value discloses nothing rather than throwing",
    preservedClause("AC4" as unknown as string[]) === "" &&
      preservedIds("AC4" as unknown as string[]).length === 0,
  );
}

process.exit(failures());
