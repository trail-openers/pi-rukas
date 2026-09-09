#!/usr/bin/env bun
/**
 * The /plan pipeline's latency contract (the serial-dispatch-tax fix).
 *
 * The structural cost audit (outputs/spec-driven-plan-driver-gap.md §4) put
 * the driver's 20–30-minute-per-ticket experience on four strictly
 * serialized dispatch barriers. This suite pins the restructure:
 *
 *   - the duplicate-risk explore and the angle fan-out dispatch as ONE
 *     barrier (an angle starts BEFORE the duplicate-risk child resolves —
 *     with the old serial shape the angles could not start until the
 *     duplicate check returned),
 *   - the HIGH-risk hard stop survives the move: a HIGH verdict still
 *     refuses to file, now applied after the barrier,
 *   - every plan dispatch is bounded (timeoutMs = PLAN_DISPATCH_TIMEOUT_MS,
 *     not the 2-hour spawn backstop) and pinned to the repo root (cwd),
 *   - marker-line children (duplicate-risk, gap gate) run --no-skills with
 *     no reporter extension; angle children keep --no-skills + reporter,
 *   - the result carries per-phase timings (inventory / investigate /
 *     gap-gate / total) — research next-step #1: measure, then cut.
 */

import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { PLAN_DISPATCH_TIMEOUT_MS } from "../src/plan-investigate.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Keep the mechanical inventory offline (no forge detection / gh search).
process.env.PI_ENSEMBLE_FORGE = "none";

interface SeenDispatch {
  role: string;
  prompt: string;
  cwd?: string;
  label?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}

const seen: SeenDispatch[] = [];
let angleStarted = false;
let angleStartedBeforeDupResolved = false;
let dupLevel = "none";

const ANGLE_TOOL_USE = {
  name: "report_plan_item",
  arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
};

setPlanDispatch(((
  _pi: unknown,
  spec: { role: string; prompt: string; cwd?: string },
  opts?: { label?: string; timeoutMs?: number; extraArgs?: string[] },
) => {
  seen.push({
    role: spec.role,
    prompt: spec.prompt,
    cwd: spec.cwd,
    label: opts?.label,
    timeoutMs: opts?.timeoutMs,
    extraArgs: opts?.extraArgs,
  });
  if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
    // Resolve only after an angle has been OBSERVED to start (1s fallback so
    // a serial regression fails the assertion instead of hanging the test).
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (angleStarted || Date.now() - t0 > 1000) {
          clearInterval(iv);
          angleStartedBeforeDupResolved = angleStarted;
          resolve({
            role: "explore",
            ok: true,
            text: `DUPLICATE_RISK: ${dupLevel} — checked open and closed issues`,
            toolUses: [],
            ms: 1,
            exitCode: 0,
          });
        }
      }, 5);
    });
  }
  if (spec.role === "adversarial-developer") {
    return Promise.resolve({
      role: "adversarial-developer",
      ok: true,
      text: "VERDICT: READY",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }
  angleStarted = true;
  return Promise.resolve({
    role: "explore",
    ok: true,
    text: "summary prose",
    toolUses: [ANGLE_TOOL_USE],
    ms: 1,
    exitCode: 0,
  });
}) as never);

const FAKE_PI = { registerTool: () => {} } as never;
const REPO_ROOT = process.cwd();
const DESCRIPTOR = "add a start_plan_driver latency probe in extension/src/plan-tool.ts";

{
  const result = await runPlanPipeline(
    FAKE_PI,
    { descriptor: DESCRIPTOR, dryRun: true },
    REPO_ROOT,
  );

  assert(
    angleStartedBeforeDupResolved,
    "duplicate-risk ∥ angles: an angle dispatch started BEFORE the duplicate-risk child resolved (one barrier, not two)",
  );

  const dup = seen.find((s) => s.prompt.includes("DUPLICATE RISK CHECK"));
  const gates = seen.filter((s) => s.role === "adversarial-developer");
  const angles = seen.filter(
    (s) => s.role === "explore" && !s.prompt.includes("DUPLICATE RISK CHECK"),
  );
  assert(!!dup && angles.length >= 2 && gates.length >= 1, "all three dispatch kinds observed");

  for (const s of seen) {
    assert(
      s.timeoutMs === PLAN_DISPATCH_TIMEOUT_MS,
      `bounded dispatch: ${s.label ?? s.role} carries timeoutMs=${s.timeoutMs} (expected PLAN_DISPATCH_TIMEOUT_MS)`,
    );
    assert(s.cwd === REPO_ROOT, `cwd pinned to repoRoot on ${s.label ?? s.role}`);
  }

  assert(
    (dup?.extraArgs ?? []).join(",") === "--no-skills",
    "duplicate-risk child: --no-skills, no reporter extension",
  );
  for (const g of gates) {
    assert(
      (g.extraArgs ?? []).join(",") === "--no-skills",
      "gap-gate child: --no-skills, no reporter extension",
    );
  }
  for (const a of angles) {
    const args = a.extraArgs ?? [];
    assert(
      args.includes("--no-skills") && args.includes("--extension"),
      `angle child ${a.label}: --no-skills + reporter extension`,
    );
  }

  const phases = (result.timings ?? []).map((t) => t.phase);
  for (const p of ["inventory", "investigate", "gap-gate", "total"]) {
    assert(phases.includes(p), `timings: phase "${p}" recorded`);
  }
  assert(
    (result.timings ?? []).every((t) => typeof t.ms === "number" && t.ms >= 0),
    "timings: every phase carries a non-negative ms",
  );
}

{
  // The HIGH-risk hard stop survives the barrier move: still refuses to file.
  seen.length = 0;
  angleStarted = false;
  dupLevel = "high";
  let threw = "";
  try {
    await runPlanPipeline(FAKE_PI, { descriptor: DESCRIPTOR, dryRun: true }, REPO_ROOT);
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(
    /duplicate risk HIGH/.test(threw),
    `HIGH duplicate risk still hard-stops after the barrier (got: ${threw.slice(0, 60) || "no throw"})`,
  );
}

setPlanDispatch(null);
delete process.env.PI_ENSEMBLE_FORGE;

console.log(`\nexit ${exit}`);
process.exit(exit);
