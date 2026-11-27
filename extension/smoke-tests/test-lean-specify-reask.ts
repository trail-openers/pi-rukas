#!/usr/bin/env bun
/**
 * The specify re-ask (`lean/specify-reask.ts`): a child that called `submit_tests` for some test
 * criteria and never for the others is asked once, on its own session, for exactly the missing ids.
 * The fixture is eight criteria with AC1-AC4 submitted (`lib/lean-specify-reask-golden.ts`).
 *
 *   (1) the re-ask names AC5-AC8 and the tool, resumes the same session id, and the run freezes all
 *       eight with the re-ask in the step log;
 *   (2) the re-asked child still does not submit: the specify gap for exactly those ids, two dispatches;
 *   (3) a child that submitted every test criterion is never re-asked;
 *   (4) the re-ask is bounded by the step's budget: a re-ask past the turns ceiling is a budget stop;
 *   (5) the retired `PI_ENSEMBLE_LEAN_SPECIFY_REASK=0` is ignored: the child is still re-asked;
 *   (6) an attempt the boundary refuses a row of takes the refusal retry, and the retry is never
 *       re-asked: two dispatches;
 *   (7) an attempt with an unreadable call is not re-asked;
 *   (8) a child whose session path moved is not re-asked.
 *
 * Real temp repos, real git, the real runner; the fake child is the only stub.
 */

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BUDGETS } from "../src/lean/config.ts";
import { reaskMissing, reaskPrompt } from "../src/lean/specify-reask.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  CONFIG,
  REASKED,
  ROOTS,
  report as reportShared,
  submit,
} from "./lib/lean-specify-fixture.ts";
import {
  IDS,
  MISSING,
  SUBMITTED,
  runPartial,
  submitted,
  writeAll,
} from "./lib/lean-specify-reask-golden.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const gaps = (ids: string[]): string[] => ids.map((id) => `criterion ${id} has no red test`);
const marked = (reason: string | undefined): boolean =>
  reason?.includes(`${REASKED} ${MISSING.join(", ")}`) === true;

// ── (1) the missing ids are asked for, and their submission freezes ─────────
{
  const EXTRA = "tests/AC1-extra.test.sh";
  const prompts: string[] = [];
  const runIds: (string | undefined)[] = [];
  const r = await runPartial(31, {
    writes: (wt, d) => {
      writeAll(wt, d);
      if (d === 2) writeFileSync(path.join(wt, EXTRA), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    },
    // The re-asked child also resubmits AC1, which it was not asked for.
    toolUses: (d) =>
      d === 1 ? submitted(SUBMITTED) : [...submitted(MISSING), submit("AC1", [EXTRA])],
    prompts,
    runIds,
  });
  reportShared(r, "(1)", assert);
  assert(
    r.outcome?.kind === "ok",
    `(1) all eight freeze (got ${r.outcome?.kind}: ${r.outcome?.reason})`,
  );
  assert(r.dispatched === 2, `(1) one re-ask, no retry (got ${r.dispatched})`);
  assert(prompts[1] === reaskPrompt(MISSING), "(1) the re-ask is the follow-up prompt alone");
  assert(
    prompts[1]?.includes("AC5, AC6, AC7, AC8") === true &&
      prompts[1]?.includes("submit_tests") === true &&
      !/AC[1-4]/.test(prompts[1] ?? ""),
    `(1) it names exactly the missing ids and the tool (got ${prompts[1]})`,
  );
  assert(
    runIds[0] !== undefined && runIds[1] === runIds[0],
    `(1) the re-ask resumes the first child's session (got ${JSON.stringify(runIds)})`,
  );
  assert(
    marked(r.outcome?.reason),
    `(1) the step log records the re-ask (got ${r.outcome?.reason})`,
  );
  assert(r.outcome?.dispatches?.length === 2, "(1) both dispatches are billed to the step");
  assert(
    r.outcome?.kind === "ok" && !Object.keys(r.outcome.frozen ?? {}).includes(EXTRA),
    `(1) only the asked ids are taken from the re-ask (got ${JSON.stringify(r.outcome)})`,
  );
}

// ── (2) a child that still does not submit gets the specify gap ─────────────
{
  const r = await runPartial(32);
  reportShared(r, "(2)", assert);
  assert(r.outcome?.kind === "red-test-gap", `(2) is the gap (got ${r.outcome?.kind})`);
  assert(
    JSON.stringify(r.outcome?.failedRules) === JSON.stringify(gaps(MISSING)),
    `(2) for exactly the missing ids (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(r.dispatched === 2, `(2) two dispatches, never a third (got ${r.dispatched})`);
  assert(
    r.outcome?.reason?.startsWith("criterion AC5 has no red test") === true &&
      marked(r.outcome?.reason),
    `(2) the cause leads and the re-ask is recorded (got ${r.outcome?.reason})`,
  );
}

// ── (3) a child that submitted everything is never re-asked ─────────────────
{
  const r = await runPartial(33, { toolUses: () => submitted(IDS) });
  reportShared(r, "(3)", assert);
  assert(r.outcome?.kind === "ok", `(3) freezes (got ${r.outcome?.kind})`);
  assert(r.dispatched === 1, `(3) one dispatch, no re-ask (got ${r.dispatched})`);
  assert(r.outcome?.reason?.includes(REASKED) !== true, "(3) and no re-ask note");
}

// ── (4) the re-ask is bounded by the step's budget ──────────────────────────
{
  const config = {
    ...CONFIG,
    budgets: { ...DEFAULT_BUDGETS, specify: { turns: 2, tokens: 0, minutes: 0 } },
  };
  const r = await runPartial(34, {
    config,
    toolUses: (d) => submitted(d === 1 ? SUBMITTED : MISSING),
    progressTurns: (d: number) => (d === 2 ? 9 : 0),
  });
  reportShared(r, "(4)", assert);
  assert(
    r.outcome?.kind === "budget",
    `(4) a re-ask past the ceiling stops (got ${r.outcome?.kind})`,
  );
  assert(r.dispatched === 2, `(4) and nothing is dispatched after it (got ${r.dispatched})`);
  assert(r.outcome?.dispatches?.length === 2, "(4) both children are billed");
}

// ── (5) the retired switch set to "0" is ignored ─────────────────────────────
await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_REASK: "0" }, async () => {
  const runIds: (string | undefined)[] = [];
  const r = await runPartial(36, { runIds });
  assert(
    r.dispatched === 2 && runIds[0] !== undefined && runIds[1] === runIds[0],
    `(5) "0" still re-asks on the first child's session (got ${r.dispatched}, ${JSON.stringify(runIds)})`,
  );
});

// ── (6) a refused row takes the refusal retry, and the retry is never re-asked ─
{
  const prompts: string[] = [];
  const r = await runPartial(37, {
    // Attempt 1 declares a file that does not exist: a drop. The retry submits AC1-AC4 cleanly.
    toolUses: (d) => (d === 1 ? [submit("AC1", ["tests/AC1-gone.test.sh"])] : submitted(SUBMITTED)),
    writes: (wt, d) => writeAll(wt, d === 2 ? 1 : d),
    prompts,
  });
  reportShared(r, "(6)", assert);
  assert(r.dispatched === 2, `(6) child, refusal retry, no re-ask (got ${r.dispatched})`);
  assert(
    prompts.every((p) => !p.includes("Criteria you never submitted")),
    "(6) neither attempt is re-asked",
  );
  assert(r.outcome?.reason?.includes(REASKED) !== true, "(6) and no re-ask note");
}

// ── (7) an unreadable call is not re-asked ──────────────────────────────────
{
  const r = await runPartial(38, {
    toolUses: (d) =>
      d === 1
        ? [...submitted(SUBMITTED), { name: "submit_tests", arguments: { criterionId: "AC5" } }]
        : [],
  });
  reportShared(r, "(7)", assert);
  assert(r.dispatched === 1, `(7) one dispatch (got ${r.dispatched})`);
}

// ── (8) a session that moved is not resumed ─────────────────────────────────
{
  let called = 0;
  const got = await reaskMissing({
    dispatch: async () => {
      called++;
      throw new Error("must not dispatch");
    },
    first: { role: "developer", transcriptPath: "/elsewhere.json" } as DispatchResult,
    runId: "run-moved",
    missing: ["AC5"],
    declared: 1,
    skipped: 0,
    refuses: async () => false,
    budget: undefined,
    wt: "/nowhere",
    repoRoot: "/nowhere",
    issue: 39,
  });
  assert(got === undefined && called === 0, `(8) no re-ask (dispatched ${called})`);
}

for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
process.exit(exit);
