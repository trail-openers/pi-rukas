#!/usr/bin/env bun
/**
 * #2668: the disclosure half of the preservation declaration — what the operator is told, and how much.
 *
 * A criterion the base proof called `green` is frozen as a must-pass file and DISCLOSED as preserved, in
 * the handback comment and the PR body. Two numbers bound that disclosure and neither was falsifiable
 * before: `PRESERVED_CAP` (how many ids one clause names before it says `(+N more)`) and
 * `RECORD_MAX_ENTRIES` (the longest `preserved` list the record accepts). A mutant that moved the cap to
 * 7 or 9 survived, because the earlier case only counted the ids it saw.
 *
 *   (a) `preservedClause` counts all of them, names at most the cap, and says nothing when there is
 *       nothing to disclose.
 *   (b) the record accepts a list at its bound and refuses one past it.
 *   (c) the handback comment — the rendering an operator actually reads — agrees with the clause on every
 *       id, in order, and the same cap governs both. A mutant of the cap moves the clause and the comment
 *       together, so this is where it dies.
 *   (d) a negative control for `test-lean-specify-preserved-rule.ts`, whose through-the-step cases once
 *       proved nothing: it built panel rows with `PANEL_IDS.map((row) => row.id)` over a list of STRINGS,
 *       so every row carried an `undefined` criterion, every `submit_tests` call was refused as malformed
 *       at the extractor, and the freeze rule never saw a verdict. A row with no criterion must therefore
 *       be refused at the boundary — if it ever reached the rule, a green row in that file would prove
 *       nothing and its assertions would go green on a run that never proved a file.
 *
 * (a)–(c) are pure or read the handback's own renderer. (d) runs the real `specify` step with only the
 * model faked.
 */

import { neededFromLog } from "../src/lean/handback.ts";
import { outcomeProblem } from "../src/lean/state-outcome.ts";
import type { Step } from "../src/lean/state.ts";
import { preservedClause } from "../src/preserved-disclose.ts";
import { RECORD_MAX_ENTRIES } from "../src/lean/state-outcome-maps.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { buildRows, redFile, submitCalls } from "./lib/lean-panel-rows.ts";
import {
  PANEL_BODY,
  RUNNER,
  panelRepo,
} from "./lib/lean-specify-preservation-fixture.ts";
import { configWith, runSpecify } from "./lib/lean-specify-fixture.ts";

const { assert, failures } = makeAssert();
const check = (msg: string, cond: boolean, detail?: string): void =>
  assert(cond, msg + (cond || detail === undefined ? "" : `\n    ${detail}`));

/** Runs the body with the preserves switch at its default (unset = on). */
async function on<T>(body: () => Promise<T>): Promise<T> {
  let out!: T;
  await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: undefined }, async () => {
    out = await body();
  });
  return out;
}

// ── (a) the clause: counts everything, names at most the cap
{
  const nine = Array.from({ length: 9 }, (_, i) => `AC${String(i + 1)}`);
  const clause = preservedClause(nine, { AC1: ["tests/AC1-guard.test.sh"] });
  check(
    "(a) the clause counts all nine and names eight",
    clause.startsWith("preserved 9: AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8 (+1 more)"),
    clause,
  );
  check(
    "(a) and does not print the ninth id",
    !/(^|[,)] )AC9(,|$)/.test(clause),
    clause,
  );
  const eight = preservedClause(nine.slice(0, 8));
  check(
    "(a) exactly at the cap there is no (+N more) clause",
    !eight.includes("more") && eight.includes("AC8"),
    eight,
  );
  check(
    "(a) and a run with nothing to disclose says nothing",
    preservedClause([]) === "" && preservedClause(undefined) === "",
  );
}

// ── (b) the record's ceiling on the same list
{
  const at = Array.from({ length: RECORD_MAX_ENTRIES }, (_, i) => `AC${String(i + 1)}`);
  const over = [...at, "AC99"];
  check(
    "(b) the record accepts a list at the bound",
    outcomeProblem({ kind: "ok", preserved: at }, "specify") === undefined,
    String(outcomeProblem({ kind: "ok", preserved: at }, "specify")),
  );
  check(
    "(b) and refuses one past it",
    outcomeProblem({ kind: "ok", preserved: over }, "specify") ===
      `outcome preserved must hold at most ${String(RECORD_MAX_ENTRIES)} criteria`,
    String(outcomeProblem({ kind: "ok", preserved: over }, "specify")),
  );
}

// ── (c) the handback comment is the same disclosure, at the same cap
{
  const nine = Array.from({ length: 9 }, (_, i) => `AC${String(i + 1)}`);
  const step = {
    state: "specify",
    key: "2713:specify:0",
    outcome: {
      kind: "red-test-gap",
      reason: "every test criterion is preserved",
      preserved: nine,
      tests: { AC1: ["tests/AC1-guard.test.sh"] },
    },
  } as unknown as Step;
  let text = "";
  await on(async () => {
    text = neededFromLog([step]);
  });
  check(
    "(c) the handback names the same eight ids in order, counting nine",
    text.includes(
      "preserved 9: AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8 (+1 more) (tests/AC1-guard.test.sh)",
    ) &&
      !/(^|[,)] )AC9(,|$)/.test(text),
    text,
  );
}

// ── (d) negative control for the rule's through-the-step cases
{
  const broken = buildRows([{ id: undefined as unknown as string, script: redFile() }]);
  let r: Awaited<ReturnType<typeof runSpecify>> | undefined;
  await on(async () => {
    r = await runSpecify({
      ...panelRepo(),
      issue: 2721,
      config: configWith({ fast: "true", test: RUNNER }),
      specBody: PANEL_BODY,
      writes: () => {},
      toolUses: submitCalls(broken),
    });
  });
  check(
    "(d) a row with no criterion is refused at the boundary, so a green row in the rule's file reached it",
    r !== undefined &&
      r.outcome?.kind !== "ok" &&
      String(r.outcome?.reason ?? "").includes("malformed") &&
      Object.keys(r.outcome?.frozen ?? {}).length === 0 &&
      r.outcome?.preserved === undefined,
    JSON.stringify(r?.outcome?.kind) + " " + JSON.stringify(r?.outcome?.reason),
  );
}

process.exit(failures());
