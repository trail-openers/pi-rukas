#!/usr/bin/env bun
/**
 * Gate-never-ran must not file an unreviewed spec (PR #635 lens MEDIUM 1).
 *
 * When the gap-gate dispatch FAILS (`!gate.ok` or `gate.errorStop`), the loop
 * `break`s. Before the fix, `capHit`, `capReason` and `residualForDisclosure`
 * were all left unset, and the Phase-5 guard is
 *
 *     !dryRun && capReason !== "unresolved-blocking"
 *
 * `undefined !== "unresolved-blocking"` is TRUE, so the spec FILED even though
 * the gap gate never reviewed it. No gap dispositions, no cap reason, no
 * filing failure — the operator could not distinguish it from a clean READY.
 *
 * This is the exact failure class the compiled /plan pipeline exists to
 * eliminate. D3 stops "verdict absent → pass"; this is "gate never ran →
 * pass", sitting two branches away.
 *
 * The fix adds a fourth capReason member, `gate-unavailable`, set in the
 * dispatch-failure branch, and does NOT file — the spec is surfaced to the
 * operator with the gate's failure reason, matching the deliberate-skip shape
 * `cap-surface` already uses. Rationale: we cannot assert a spec is clean
 * when nothing reviewed it, and the all-angles-failed path already halts for
 * the same reason.
 */

import { setPlanDispatch } from "../src/plan-driver.ts";
import { runPlanPipeline } from "../src/plan-driver.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import type { Forge } from "../src/forge.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface ForgeStubState {
  created: { title: string; body: string }[];
}
const forgeStub: ForgeStubState = { created: [] };

function installForgeStub() {
  const stub = {
    issueCreate: (title: string, body: string) => {
      forgeStub.created.push({ title, body });
      return Promise.resolve({ url: "https://github.com/test/test/issues/1" });
    },
  } as unknown as Forge;
  setPlanForge(() => Promise.resolve(stub));
}

/**
 * A dispatch stub in which EVERY angle succeeds (structured items) and the
 * gap-gate child FAILS — either `ok: false` or `ok: true` with `errorStop`
 * (the two failure shapes the driver's guard branches on).
 */
function makeGateFailingDispatch(mode: "not-ok" | "error-stop") {
  return ((_pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      if (mode === "not-ok") {
        return Promise.resolve({
          role: "adversarial-developer",
          ok: false,
          text: "",
          toolUses: [],
          ms: 1,
          exitCode: 1,
        } as never);
      }
      return Promise.resolve({
        role: "adversarial-developer",
        ok: true,
        text: "(provider terminated mid-stream)",
        toolUses: [],
        ms: 1,
        exitCode: 0,
        errorStop: { reason: "error", message: "Provider request error: 429 status code" },
      } as never);
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none — no overlapping open work",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "summary prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
        },
      ],
      ms: 1,
      exitCode: 0,
    } as never);
  }) as never;
}

installForgeStub();

for (const mode of ["not-ok", "error-stop"] as const) {
  const label = mode === "not-ok" ? "gate dispatch ok:false" : "gate dispatch errorStop";
  forgeStub.created.length = 0;
  setPlanDispatch(makeGateFailingDispatch(mode));
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  assert(
    r.filed === false,
    `gate-never-ran (${label}): the unreviewed spec is NOT FILED (got filed=${r.filed})`,
  );
  assert(
    forgeStub.created.length === 0,
    `gate-never-ran (${label}): issueCreate was never called (forge calls: ${forgeStub.created.length})`,
  );
  assert(
    r.capReason === "gate-unavailable",
    `gate-never-ran (${label}): capReason is 'gate-unavailable' (got ${String(r.capReason)})`,
  );
  // The operator-visible text (the FILING STATUS section) must name the gate
  // failure — not be silent, and not look like a clean READY.
  assert(
    r.filingFailure?.detail?.toLowerCase().includes("gap-gate") === true ||
      r.filingFailure?.detail?.toLowerCase().includes("gap gate") === true,
    `gate-never-ran (${label}): the filing failure detail names the gap-gate failure (got ${String(
      r.filingFailure?.detail,
    )})`,
  );
  setPlanDispatch(null);
}

setPlanForge(null);

console.log(`\nexit ${exit}`);
process.exit(exit);
