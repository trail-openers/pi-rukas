#!/usr/bin/env bun
/**
 * #543 F4 — typed cap causes (loop / token-budget).
 *
 * The taxonomy / explainCap / kill-detail switches are NOT compile-exhaustive:
 * a new cause without a case compiles clean and returns undefined at runtime.
 * This is the F7g canary — each new cause must yield a DEFINED reason line, a
 * defined kill-detail WHY line, a distinctly-tagged formatSingleReport, and a
 * buildCompletionEvent errorTail that names the CAP env vars (not the
 * inactivity knob, which the pre-#543 ternary would have rendered).
 */

import { formatSingleReport } from "../src/async-jobs-report.ts";
import { capHitForCapKill } from "../src/work-driver-adversarial-capkill.ts";
import type { AdversarialOutcome } from "../src/work-driver-adversarial-types.ts";
import {
  classifyFailureCause,
  failureCauseReason,
  failureCauseReasonForClass,
} from "../src/work-driver-failure-taxonomy.ts";
import { buildCompletionEvent } from "../src/work-driver-merged.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkEvent(
  overrides: Partial<{ kind: string; errorTail?: string; killCause?: string }> = {},
): { kind: string; errorTail?: string; killCause?: string } {
  return { kind: "dispatch-failed", errorTail: undefined, killCause: undefined, ...overrides };
}

// (c) loop / token-budget self-kills → shouldRetry FALSE, maxRetries 0 — NOT the
// crashed-shouldRetry:true fallback, NOT inactivity's retry.
for (const [cause, killCause] of [
  ["self-killed:loop", "loop"],
  ["self-killed:token-budget", "token-budget"],
] as const) {
  const cls = classifyFailureCause(mkEvent({ killCause, kind: "dispatch-failed" }));
  assert(
    cls.cause === cause && cls.shouldRetry === false && cls.maxRetries === 0,
    `${killCause} → ${cause}, no retry`,
  );
}

// A dispatch-failed with NO structured cause must NOT take the loop branch.
{
  const cls = classifyFailureCause(
    mkEvent({ kind: "dispatch-failed", errorTail: "non-zero exit, no structured signal" }),
  );
  assert(
    cls.cause === "crashed" && cls.shouldRetry === true,
    "no-cause → crashed, shouldRetry=true (not loop)",
  );
}

// (canary) each new cause yields a DEFINED failureCauseReason /
// failureCauseReasonForClass — a missing switch case would return undefined.
for (const [cause, killCause] of [
  ["self-killed:loop", "loop"],
  ["self-killed:token-budget", "token-budget"],
] as const) {
  const cls = classifyFailureCause(mkEvent({ killCause, kind: "dispatch-failed" }));
  const reason = failureCauseReason(mkEvent({ killCause, kind: "dispatch-failed" }));
  const reasonForClass = failureCauseReasonForClass(mkEvent({ killCause }), cls);
  assert(reason.length > 0, `failureCauseReason(${cause}) is defined: ${reason}`);
  assert(
    reasonForClass.length > 0,
    `failureCauseReasonForClass(${cause}) is defined: ${reasonForClass}`,
  );
}

// kill-detail WHY map: a loop / token kill renders a non-undefined WHY line.
{
  const { killDetail } = await import("../src/kill-detail.ts");
  const base = {
    schemaVersion: 1,
    resumable: false,
    issue: 543,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      currentStep: "handoff" as const,
      inFlightJobIds: [],
      worktrees: {},
      reviewRound: 1,
      plumbReports: [],
      status: "handoff" as const,
    },
  } as unknown as Parameters<typeof killDetail>[0];
  for (const [killCause, needle] of [
    ["loop", "looped on"],
    ["token-budget", "token budget"],
  ] as const) {
    const state = {
      ...base,
      eventLog: [
        {
          kind: "dispatch-failed",
          step: "develop" as const,
          role: "developer",
          jobId: "j",
          label: "developer",
          ms: 1,
          at: 2,
          killCause,
        },
      ],
    } as unknown as Parameters<typeof killDetail>[0];
    const lines = killDetail(state);
    assert(lines.length > 0, `kill-detail: ${killCause} kill produces lines`);
    assert(
      lines.join(" ").includes(needle),
      `kill-detail: ${killCause} WHY line names the cap (${needle})`,
    );
  }
}

// (a) the formatSingleReport consumer names the cap distinctly and is not a
// provider error (a self-kill is never reported as one).
for (const [killCause, needle] of [
  ["loop", "loop detected"],
  ["token-budget", "token budget"],
] as const) {
  const report = formatSingleReport(`f4-${killCause}`, "developer", {
    role: "developer",
    ok: false,
    text: "",
    toolUses: [],
    ms: 1000,
    exitCode: 143,
    killCause,
  });
  assert(report.includes(needle), `formatSingleReport: ${killCause} names the cap`);
  assert(
    !report.includes("FAILED-PROVIDER-ERROR"),
    `formatSingleReport: ${killCause} is NOT a provider error`,
  );
  assert(
    !report.includes("terminated mid-stream"),
    `formatSingleReport: ${killCause} does not emit the provider badge`,
  );
}

// (k) buildCompletionEvent: a loop / token-budget kill's errorTail names the
// CAP env vars (PI_ENSEMBLE_DISPATCH_CAPS + PI_ENSEMBLE_CAP_KILL_GRACE_MS), NOT
// PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS — the pre-#543 ternary would have rendered
// the inactivity knob for them, which is actively wrong.
{
  const ctx = {
    repoRoot: "/tmp/f4",
    issue: 543,
  } as unknown as Parameters<typeof buildCompletionEvent>[0];
  for (const [killCause, needle] of [
    ["loop", "PI_ENSEMBLE_DISPATCH_CAPS"],
    ["token-budget", "PI_ENSEMBLE_CAP_KILL_GRACE_MS"],
  ] as const) {
    const ev = await buildCompletionEvent(ctx, "develop", "developer", "developer", {
      role: "developer",
      ok: false,
      text: "",
      toolUses: [],
      ms: 1000,
      exitCode: 143,
      killCause,
      killBudgetMs: 300_000,
    });
    if (ev.kind === "dispatch-failed") {
      assert(
        ev.errorTail?.includes(needle) === true,
        `buildCompletionEvent: ${killCause} names ${needle} (got: ${ev.errorTail})`,
      );
      assert(
        !ev.errorTail?.includes("PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS"),
        `buildCompletionEvent: ${killCause} does NOT name the inactivity knob`,
      );
      assert(ev.killCause === killCause, `buildCompletionEvent: ${killCause} killCause preserved`);
    } else {
      assert(false, `buildCompletionEvent: ${killCause} kill → dispatch-failed (got ${ev.kind})`);
    }
  }
}

// (M3) evidence threading: the adversarial cap-kill adapter threads the
// loop outcome's loopEvidence / tokenBudget into the cap-hit's CapEvidence
// (kind + count for loop; budgetTokens/usedTokens for token-budget) so
// explainCap renders the trigger detail. Pre-fix the evidence was never
// written — explainCap rendered the fallback sentence for every kill.
{
  const baseOutcome = (over: Partial<AdversarialOutcome>): AdversarialOutcome =>
    ({
      id: "task-a",
      ok: false,
      rounds: 3,
      records: [],
      infra: true,
      threw: false,
      skipped: false,
      priorInfra: false,
      ...over,
    }) as AdversarialOutcome;

  const loopKill = capHitForCapKill(
    baseOutcome({ killCause: "loop", loopEvidence: { tool: "bash", count: 12 } }),
    2,
  );
  assert(loopKill !== undefined, "M3: loop cap kill → cap-hit (not an infra cap)");
  if (loopKill) {
    assert(loopKill.event.cap === "loop-detected", "M3: loop kill → fixed literal 'loop-detected'");
    assert(
      loopKill.event.role === "adversarial-developer",
      "M3: the role travels in the role field, never in the cap string",
    );
    assert(
      loopKill.evidence?.kind === "loop" &&
        loopKill.evidence.count === 12 &&
        loopKill.evidence.tool === "bash",
      "M3: loopEvidence threaded into capEvidence (kind/count/tool)",
    );
  }

  const budgetKill = capHitForCapKill(
    baseOutcome({ killCause: "token-budget", tokenBudget: { budget: 200_000, used: 210_400 } }),
    2,
  );
  assert(budgetKill !== undefined, "M3: token-budget cap kill → cap-hit");
  if (budgetKill) {
    assert(
      budgetKill.event.cap === "token-budget",
      "M3: token-budget kill → fixed literal 'token-budget'",
    );
    assert(
      budgetKill.evidence?.kind === "token-budget" &&
        budgetKill.evidence.budgetTokens === 200_000 &&
        budgetKill.evidence.usedTokens === 210_400,
      "M3: tokenBudget threaded into capEvidence (budgetTokens/usedTokens)",
    );
  }

  // A genuine infra failure (no cap killCause) is NOT a cap — it must not
  // take the cap path (the F4(g) precision: only loop/token-budget do).
  assert(
    capHitForCapKill(baseOutcome({}), 2) === undefined,
    "M3: a plain infra failure (no cap killCause) is NOT a cap kill",
  );
  assert(
    capHitForCapKill(baseOutcome({ ok: true, infra: false, priorVerdict: "approved" }), 2) ===
      undefined,
    "M3: an approved outcome is never a cap kill",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
