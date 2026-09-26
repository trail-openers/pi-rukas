#!/usr/bin/env bun
/**
 * #893 — reporter-tool preflight and diagnostics.
 *
 * Pins:
 *  1. Pre-spawn stat: a missing reporter extension path fails the dispatch
 *     with the named error before any spawn (research + policy).
 *  2. All-silent run: every angle with 0 raw report_research_claim calls
 *     → halt reason `reporter-silent` (distinct from `no-structured-claims`).
 *  3. Partial silence (1 of 3 silent): the silent angle is named, the run
 *     does NOT halt.
 *  4. Schema-invalid calls (raw > 0, valid = 0): still `no-structured-claims`.
 *  5. Lens pre-spawn stat: a missing LENS_REPORTER_PATH blocks the lens
 *     with 0 attempts and the named error (no spawn).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RESEARCH_REPORTER_PATH,
  runResearchPipeline,
  setResearchDispatch,
} from "../src/research-driver.ts";
import {
  judgePolicy,
  askPolicy,
  MERGE_POLICY_QUESTION,
  policyReporterPath,
} from "../src/work-driver-policy.ts";
import { runLensChild } from "../src/lens-review-child.ts";
import { LENS_REPORTER_PATH } from "../src/lens-review.ts";
import {
  reporterMissingError,
  reporterPathFromArgs,
  statReporterPath,
} from "../src/reporter-preflight.ts";
import { PLAN_REPORTER_PATH } from "../src/plan-investigate.ts";
import {
  runPlanPipeline,
  setPlanDispatch,
  setPlanStatFn,
} from "../src/plan-driver.ts";
import type { ExecFn } from "../src/worktree.ts";
import type { RosterEntry } from "../src/lens-roster.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------- helpers

const FAKE_PI = { registerTool: () => {} } as never;

const execStub: ExecFn = async (cmd) => {
  if (cmd.startsWith("git rev-parse")) return { stdout: "feedbeef\n" };
  return { stdout: "" };
};
const fetchStub = (async () => ({ status: 200 })) as never;
const searchStub = (async () => ({ kind: "hits" as const, hits: [] })) as never;
const memoryStub = (async () => ({ outcome: "written" as const, id: "m1" })) as never;

async function freshRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reporter-preflight-"));
  await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
  return tmp;
}

function claimCall(kind: string, text: string, source: string, sourceKind: string) {
  return {
    name: "report_research_claim",
    arguments: { kind, text, source, sourceKind, confidence: "high", staleness: "stable" },
  };
}

// ============================================ 1. reporter-path helpers

{
  assert(
    reporterPathFromArgs(["--no-skills", "--extension", "/x/y.ts"]) === "/x/y.ts",
    "reporterPathFromArgs: extracts the path after --extension",
  );
  assert(
    reporterPathFromArgs(["--no-skills"]) === undefined,
    "reporterPathFromArgs: no --extension → undefined",
  );
  assert(
    reporterPathFromArgs(undefined) === undefined,
    "reporterPathFromArgs: undefined → undefined",
  );

  const expected = reporterMissingError("/some/path.ts");
  assert(
    expected === "reporter extension missing: /some/path.ts — run ./install.sh",
    `reporterMissingError produces the exact named string (got "${expected}")`,
  );

  // statReporterPath: a rejecting stub → the named error
  const rejectStat = async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
  let caught: string | undefined;
  try {
    await statReporterPath("/nonexistent.ts", rejectStat);
  } catch (e) {
    caught = (e as Error).message;
  }
  assert(
    caught === reporterMissingError("/nonexistent.ts"),
    "statReporterPath: ENOENT → named error",
  );

  // statReporterPath: a resolving stub → no throw
  let threw = false;
  try {
    await statReporterPath("/ok.ts", async () => ({}));
  } catch {
    threw = true;
  }
  assert(!threw, "statReporterPath: successful stat → no throw");
}

// ==================================== 2. research pre-spawn stat (missing path)

{
  // The real RESEARCH_REPORTER_PATH exists on disk (it's a source file).
  // To simulate a missing path we inject a rejecting statFn.
  const rejectStat = async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };

  let dispatchCount = 0;
  setResearchDispatch(((
    _pi: unknown,
    _spec: { role: string; prompt: string },
    _opts?: { label?: string },
  ) => {
    dispatchCount++;
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "should not reach here",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }) as never);

  const tmp = await freshRepo();
  const r = await runResearchPipeline(FAKE_PI, { topic: "test topic", tier: "quick" }, tmp, {
    execFn: execStub,
    fetchFn: fetchStub,
    vipuneSearchFn: searchStub,
    memoryWriteFn: memoryStub,
    statFn: rejectStat,
  });

  assert(dispatchCount === 0, `missing reporter → 0 spawns (got ${dispatchCount})`);
  assert(
    r.halt?.detail === reporterMissingError(RESEARCH_REPORTER_PATH),
    `missing reporter → halt detail is the named error (got "${r.halt?.detail}")`,
  );
  assert(
    r.halt?.reason === "reporter-missing",
    `missing reporter → halt reason reporter-missing (got ${r.halt?.reason})`,
  );
  assert(
    r.angles.every((a) => a.failure === reporterMissingError(RESEARCH_REPORTER_PATH)),
    "missing reporter → every angle failure carries the named error",
  );
  assert(
    r.angles.length > 0 && r.angles.every((a) => !a.ok),
    "missing reporter → all angles marked not-ok",
  );
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}

// ======================================== 3. all-silent → reporter-silent

{
  // All 3 angles return ok with toolUses: [] (0 raw report_research_claim calls).
  setResearchDispatch(((
    _pi: unknown,
    _spec: { role: string; prompt: string },
    _opts?: { label?: string },
  ) => {
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "I looked but found nothing to report.",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }) as never);

  const tmp = await freshRepo();
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "all silent", tier: "standard", angles: ["angle one", "angle two", "angle three"] },
    tmp,
    { execFn: execStub, fetchFn: fetchStub, vipuneSearchFn: searchStub, memoryWriteFn: memoryStub },
  );

  assert(
    r.halt?.reason === "reporter-silent",
    `all 3 angles with 0 raw calls → halt reason reporter-silent (got ${r.halt?.reason})`,
  );
  assert(
    r.halt?.detail.includes("reporting channel appears broken"),
    "reporter-silent detail names the broken reporting channel",
  );
  assert(
    r.halt?.reason !== "no-structured-claims",
    "reporter-silent is distinct from no-structured-claims",
  );
  assert(!r.artifactPath, "no artifact on the all-silent halt");
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}

// ======================================== 4. schema-invalid → no-structured-claims

{
  // All angles return ok with toolUses containing report_research_claim calls
  // that are schema-invalid (empty text → dropped by extractResearchClaims).
  // rawCalls > 0 but claims.length === 0 → no-structured-claims (unchanged).
  setResearchDispatch(((
    _pi: unknown,
    _spec: { role: string; prompt: string },
    _opts?: { label?: string },
  ) => {
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "I tried to report but got the schema wrong.",
      toolUses: [
        { name: "report_research_claim", arguments: { kind: "finding", text: "" } }, // invalid → dropped
      ],
      ms: 1,
      exitCode: 0,
    });
  }) as never);

  const tmp = await freshRepo();
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "schema invalid", tier: "standard", angles: ["a1", "a2", "a3"] },
    tmp,
    { execFn: execStub, fetchFn: fetchStub, vipuneSearchFn: searchStub, memoryWriteFn: memoryStub },
  );

  assert(
    r.halt?.reason === "no-structured-claims",
    `schema-invalid calls (raw>0, valid=0) → no-structured-claims (got ${r.halt?.reason})`,
  );
  assert(
    r.halt?.reason !== "reporter-silent",
    "schema-invalid is NOT reporter-silent (the tool WAS called)",
  );
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}

// ======================================== 5. partial silence (1 of 3)

{
  // 1 angle silent (toolUses: []), 2 angles report valid claims.
  const silentName = "custom-2";
  const silentLabel = `research-${silentName}`.slice(0, 24);
  setResearchDispatch(((
    _pi: unknown,
    spec: { role: string; prompt: string },
    opts?: { label?: string },
  ) => {
    const label = opts?.label ?? "";
    const isSilent = label === silentLabel;
    // #896 — vary the claim text per angle so cross-angle dedup does not merge them.
    const claimIdx = label.includes("custom-1") || label === "research-web-current" ? 1 : 2;
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: isSilent ? "nothing to report" : "found a claim",
      toolUses: isSilent ? [] : [claimCall("finding", `a valid claim ${claimIdx}`, "https://a/live", "url")],
      ms: 1,
      exitCode: 0,
    });
  }) as never);

  const tmp = await freshRepo();
  const r = await runResearchPipeline(
    FAKE_PI,
    {
      topic: "partial silence",
      tier: "standard",
      angles: ["angle-one", "angle-two", "angle-three"],
    },
    tmp,
    { execFn: execStub, fetchFn: fetchStub, vipuneSearchFn: searchStub, memoryWriteFn: memoryStub },
  );

  assert(!r.halt, "partial silence (1 of 3) → no halt");
  assert(
    r.claims.length === 2,
    `2 valid claims from the 2 reporting angles (got ${r.claims.length})`,
  );
  const silentRun = r.angles.find((a) => a.name === silentName);
  assert(silentRun !== undefined, "silent angle present in result");
  assert(silentRun?.ok === false, "silent angle marked not-ok");
  assert(
    silentRun?.failure ===
      "0 report_research_claim calls — reporter may not have loaded (check pi version / --extension)",
    `silent angle names the 0-call diagnostic (got "${silentRun?.failure}")`,
  );
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}

// ============= 5b. failed angle (ok=false) + 2 reporting angles → no mislabel

{
  // 2 angles report valid claims, 1 angle's dispatch FAILS (ok=false) with
  // an EMPTY toolUses list. The failed angle must keep "dispatch failed or
  // timed out" — the "reporter may not have loaded" diagnostic belongs
  // only to a DISPATCHED (ok=true) angle with 0 raw calls.
  const failedLabel = "research-custom-2";
  setResearchDispatch(((
    _pi: unknown,
    _spec: { role: string; prompt: string },
    opts?: { label?: string },
  ) => {
    const label = opts?.label ?? "";
    if (label === failedLabel) {
      return Promise.resolve({
        role: "explore",
        ok: false,
        text: "",
        toolUses: [],
        ms: 1,
        exitCode: 1,
      });
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "found a claim",
      // #896 — vary the claim text per angle so cross-angle dedup does not merge them.
      toolUses: [claimCall("finding", `${label} claim`, "https://a/live", "url")],
      ms: 1,
      exitCode: 0,
    });
  }) as never);

  const tmp = await freshRepo();
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "failed angle", tier: "standard", angles: ["angle-one", "angle-two", "angle-three"] },
    tmp,
    { execFn: execStub, fetchFn: fetchStub, vipuneSearchFn: searchStub, memoryWriteFn: memoryStub },
  );

  assert(!r.halt, "failed angle (1 of 3) → no halt (the other 2 reported)");
  assert(r.claims.length === 2, `2 valid claims from the 2 reporting angles (got ${r.claims.length})`);
  const failedRun = r.angles.find((a) => a.name === "custom-2");
  assert(failedRun !== undefined, "failed angle present in result");
  assert(failedRun?.ok === false, "failed angle marked not-ok");
  assert(
    failedRun?.failure === "dispatch failed or timed out",
    `failed angle keeps the dispatch-failure label (got "${failedRun?.failure}")`,
  );
  assert(
    failedRun?.failure !==
      "0 report_research_claim calls — reporter may not have loaded (check pi version / --extension)",
    "failed angle is NOT mislabelled as a silent reporter",
  );
  // The two reporting angles DID make raw calls, so the run-level all-silent
  // check stays false — the raw-vs-valid distinction holds even when one
  // angle was never dispatched (rawClaimCalls undefined for the fallback).
  assert(r.halt?.reason !== "reporter-silent", "mixed run is not reporter-silent");
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}

// ======================================== 6. policy pre-spawn stat (missing path)

{
  // judgePolicy with a rejecting statFn → the named error, no spawn.
  let spawnCount = 0;
  const rejectStat = async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };

  // We can't easily mock spawnSpecialist, so we test the statReporterPath
  // integration via judgePolicy's statFn parameter. The judge will throw
  // before calling spawnSpecialist.
  const judge = judgePolicy("/tmp", rejectStat);
  let caught: string | undefined;
  try {
    await judge("test question");
  } catch (e) {
    caught = (e as Error).message;
  }
  assert(
    caught === reporterMissingError(policyReporterPath()),
    `policy judge: missing reporter → named error before spawn (got "${caught}")`,
  );
}

// ======================================== 7. lens pre-spawn stat (missing path)

{
  // runLensChild with a rejecting statFn → blocked with the named error, 0 attempts.
  const rejectStat = async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };

  const fakeLens = {
    name: "security",
    skill: "code-review-security",
  } as never;
  const fakeRoster: RosterEntry[] = [{ name: "security", skill: "code-review-security" }] as never;

  // We need a skillsDir that exists for the skill stat check to pass.
  const tmp = await freshRepo();
  const skillsDir = path.join(tmp, "skills");
  await fs.mkdir(path.join(skillsDir, "code-review-security"), { recursive: true });
  await fs.writeFile(path.join(skillsDir, "code-review-security", "SKILL.md"), "# test skill\n");

  let batchCount = 0;
  const result = await runLensChild({
    lens: fakeLens,
    runId: "test-run",
    skillsDir,
    context: "test context",
    roster: fakeRoster,
    opts: { diff: "+test" },
    bumpBatch: () => batchCount++,
    statFn: rejectStat,
  });

  assert(result.ok === false, "lens: missing reporter → not ok");
  assert(result.blocked === true, "lens: missing reporter → blocked");
  assert(result.attempts === 0, `lens: missing reporter → 0 attempts (got ${result.attempts})`);
  assert(
    result.parseError === reporterMissingError(LENS_REPORTER_PATH),
    `lens: missing reporter → named error in parseError (got "${result.parseError}")`,
  );
  await fs.rm(tmp, { recursive: true, force: true });
}

// ======================================== 8. normal run (stat passes)

{
  // With a resolving statFn, the pipeline proceeds normally.
  const okStat = async () => ({});
  setResearchDispatch(((
    _pi: unknown,
    _spec: { role: string; prompt: string },
    _opts?: { label?: string },
  ) => {
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "found something",
      toolUses: [claimCall("finding", "a finding", "https://a/live", "url")],
      ms: 1,
      exitCode: 0,
    });
  }) as never);

  const tmp = await freshRepo();
  const r = await runResearchPipeline(FAKE_PI, { topic: "normal run", tier: "quick" }, tmp, {
    execFn: execStub,
    fetchFn: fetchStub,
    vipuneSearchFn: searchStub,
    memoryWriteFn: memoryStub,
    statFn: okStat,
  });

  assert(!r.halt, "normal run: no halt when stat passes");
  assert(r.claims.length === 1, `normal run: 1 claim extracted (got ${r.claims.length})`);
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log(`\nexit ${exit}`);
process.exit(exit);
