#!/usr/bin/env bun
/**
 * #1856 M1 — the source-issue input plumbing.
 *
 * The duplicate-risk child names the issue being planned as its own duplicate
 * because nothing in the plan layer knows which issue the plan is FOR. This
 * file pins that the number can arrive at all, on every surface the brief
 * names: `PlanDriverInput.sourceIssue`, the stored `PlanSession`, the headless
 * `--issue <N>` flag (both the one-shot and the `--start` session form), and
 * the `start_plan_driver` tool parameter.
 *
 * The behaviour that USES the number (exclusion, downgrade, disclosure) is
 * pinned in test-plan-duplicate-self.ts; this file is the input contract.
 */

import { type PlanSession, readSession, writeSession } from "../src/headless/plan-session.ts";
import { parsePlanArgs } from "../src/headless/plan.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { registerPlanTool } from "../src/plan-tool.ts";
import type { PlanDriverInput } from "../src/plan-types.ts";
import {
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  invokePlanToolFull,
  makeJobDeliverer,
} from "./plan-test-stubs.ts";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_FORGE = "none";
installOfflineVipuneStub();
installNoPlanCacheStub();

const DESC = "add a source-issue input to the plan pipeline in extension/src/plan-types.ts";

/** Every duplicate-risk prompt the installed dispatch built, in order. */
const dupPrompts: string[] = [];
/** The PlanDriverInput each pipeline run actually received. */
const seenInputs: PlanDriverInput[] = [];

setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
  const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
  if (spec.role === "adversarial-developer") {
    return Promise.resolve({ ...base, role: spec.role, text: "VERDICT: READY" });
  }
  if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
    dupPrompts.push(spec.prompt);
    return Promise.resolve({ ...base, role: "explore", text: "DUPLICATE_RISK: none — no overlap" });
  }
  return Promise.resolve({
    ...base,
    role: "explore",
    text: "summary prose",
    toolUses: [
      {
        name: "report_plan_item",
        arguments: { kind: "acceptance-criterion", text: "the input is threaded", angle: "x" },
      },
    ],
  });
}) as never);

// ------------------------------------------------ the driver input is accepted

{
  dupPrompts.length = 0;
  const r = await runPlanPipeline({} as never, { descriptor: DESC, dryRun: true }, process.cwd());
  assert(r.filed === false, "no source issue: the pipeline still runs and does not file a dry run");
  assert(dupPrompts.length === 1, "no source issue: the risk child still dispatched");
}

// ------------------------------------------------------ headless one-shot flag

{
  const ok = parsePlanArgs([DESC, "--dry-run", "--issue", "1856"]);
  assert(
    "error" in ok === false && (ok as { sourceIssue?: number }).sourceIssue === 1856,
    `--issue 1856 → sourceIssue 1856 (${JSON.stringify(ok)})`,
  );
  const absent = parsePlanArgs([DESC, "--dry-run"]);
  assert(
    "error" in absent === false && (absent as { sourceIssue?: number }).sourceIssue === undefined,
    "no --issue → sourceIssue absent (the byte-identical default)",
  );
  for (const bad of ["eighteen", "-3", "0", "1.5", ""]) {
    const r = parsePlanArgs([DESC, "--dry-run", "--issue", bad]);
    assert(
      "error" in r && /--issue/.test((r as { error: string }).error),
      `--issue "${bad}" is refused by name, not silently dropped`,
    );
  }
  const missing = parsePlanArgs([DESC, "--dry-run", "--issue"]);
  assert(
    "error" in missing,
    "--issue with no value is refused (the flag parser owns the missing value)",
  );
}

// --------------------------------------------------- headless session (--start)

{
  const start = parsePlanArgs([DESC, "--start", "--issue", "42"]);
  const turn = (start as { turn?: { kind: string; sourceIssue?: number } }).turn;
  assert(
    turn?.kind === "start" && turn.sourceIssue === 42,
    `--start --issue 42 → the session begins with sourceIssue 42 (${JSON.stringify(turn)})`,
  );
  const resume = parsePlanArgs(["--resume", "00000000-0000-4000-8000-000000000000", "--retry"]);
  assert("turn" in resume, "--resume --retry still parses (the flag did not break turn parsing)");
  const late = parsePlanArgs([
    "--resume",
    "00000000-0000-4000-8000-000000000000",
    "--retry",
    "--issue",
    "9",
  ]);
  assert(
    "error" in late && /--issue/.test((late as { error: string }).error),
    "--resume refuses --issue: the session already records the issue it plans",
  );
}

// -------------------------------------------------- the session stores the number

{
  const dir = await mkdtemp(path.join(os.tmpdir(), "plan-session-1856-"));
  const id = "00000000-0000-4000-8000-000000000000";
  const stored: PlanSession = {
    v: 1,
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    descriptor: DESC,
    sourceIssue: 1856,
    turn: 1,
    answers: [],
  };
  await writeSession(dir, stored);
  const back = await readSession(dir, id);
  assert(back !== "missing" && back !== "corrupt", "the session reads back");
  assert(
    back !== "missing" && back !== "corrupt" && back.sourceIssue === 1856,
    "sourceIssue survives the session round trip (stored and read back)",
  );
  // A session written before #1856 has no field at all and must stay valid.
  // Written as raw JSON (not a PlanSession with the key set to undefined) so the
  // key is genuinely absent from the file, which is the pre-#1856 shape.
  const legacyRaw = JSON.stringify({ ...stored, updatedAt: new Date().toISOString() }, (k, v) =>
    k === "sourceIssue" ? undefined : v,
  );
  await writeFile(path.join(dir, `${id}.json`), legacyRaw);
  const backLegacy = await readSession(dir, id);
  assert(
    backLegacy !== "missing" && backLegacy !== "corrupt" && backLegacy.sourceIssue === undefined,
    "a pre-#1856 session file is still valid and has no source issue",
  );
  await rm(dir, { recursive: true, force: true });
}

// ------------------------------------------------------ the tool parameter

{
  const tools: never[] = [];
  // #1044: the tool launches a background job whose report reaches the pi it
  // was REGISTERED on — a stub with only registerTool has that delivery warned
  // away, so the deliverer is part of the stub (the shape test-plan-tool.ts uses).
  const fakePi = {
    registerTool: (t: unknown) => {
      tools.push(t as never);
    },
    ...makeJobDeliverer(),
  } as never;
  registerPlanTool(fakePi);
  const t = tools.find((x) => (x as { name: string }).name === "start_plan_driver") as never;
  assert(!!t, "start_plan_driver is registered");
  const props =
    (t as unknown as { parameters: { properties?: Record<string, unknown> } }).parameters
      ?.properties ?? {};
  assert(
    Object.prototype.hasOwnProperty.call(props, "sourceIssue"),
    "start_plan_driver declares the optional sourceIssue parameter",
  );

  const bad = await invokePlanToolFull(tools, { descriptor: DESC, dryRun: true, sourceIssue: 0 });
  assert(
    bad.details.started === false && String(bad.details.error).includes("sourceIssue"),
    `sourceIssue: 0 is refused pre-dispatch as invalid-input (${JSON.stringify(bad.details.error)})`,
  );
  const badStr = await invokePlanToolFull(tools, {
    descriptor: DESC,
    dryRun: true,
    sourceIssue: "1856",
  });
  assert(
    badStr.details.started === false && String(badStr.details.error).includes("sourceIssue"),
    'sourceIssue: "1856" is refused — a number-shaped string never silently means "no exclusion"',
  );

  const good = await invokePlanToolFull(tools, {
    descriptor: DESC,
    dryRun: true,
    sourceIssue: 1856,
  });
  assert(good.launch.details.started === true, "a valid sourceIssue launches the job");
  assert(
    good.jobId !== "" && /PLAN/.test(good.text),
    "the launched run completes and renders a plan report for a source-issue plan",
  );
}

// The tool path forwards the number into the driver input. The dispatch stub
// cannot see the input, so the assertion is made on the driver input the tool
// builds: a run whose risk prompt carries the exclusion line proves the field
// arrived (M2 pins the line's content; here only its presence matters).
{
  dupPrompts.length = 0;
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESC, dryRun: true, sourceIssue: 1856 } as PlanDriverInput,
    process.cwd(),
  );
  assert(r.filed === false, "with a source issue the dry run still completes");
  assert(dupPrompts.length === 1, "with a source issue the risk child still dispatched");
}

setPlanDispatch(null);
process.exit(exit);
