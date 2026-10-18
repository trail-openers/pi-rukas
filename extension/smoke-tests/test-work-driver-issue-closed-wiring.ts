#!/usr/bin/env bun
/**
 * #1472 wiring canary — a SOURCE-TEXT assertion, in the style of
 * test-pr-gone-during-review.ts's :443-460 canary. The behavioural test
 * (test-work-driver-issue-closed.ts) would keep passing if someone deleted the
 * gate's CALL SITES, because it exercises the gate directly. This asserts the
 * driver actually consults it, so a refactor cannot silently un-gate the cycle.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
const SRC = path.join(import.meta.dirname, "..", "src");
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");
const runStep = read("work-driver-run-step.ts");
assert(
  /await endIfIssueClosed\(ctx, state, step\)/.test(runStep),
  "runStep awaits endIfIssueClosed at the step boundary",
);
assert(
  /step !== "handoff"[\s\S]*step !== "merged"/.test(runStep),
  "runStep excludes handoff and merged from the gate (the park IS a handoff; a merge acts on the PR)",
);
assert(
  /if \(gate\.ended\) return gate\.ended/.test(runStep),
  "an ended gate returns before any child is dispatched",
);
assert(
  /declinesAttentionLabel\(next\.pipelineState\)/.test(read("work-driver-handoff.ts")),
  "handoff seeds labelApplied from the decline, so all four writers honour it",
);
assert(
  /handoffOpsPromptWithoutLabel/.test(read("work-driver-prompts-late.ts")),
  "the @ops prompt can be built WITHOUT the label command (the 4th writer)",
);
assert(
  /state\.pipelineState\.handoffLabelSkipped === true/.test(read("work-driver-handoff-ops.ts")),
  "the ops dispatch passes the decline into the prompt",
);
// The refusal is CALLED from the step loop in work-driver.ts (pinned at the
// 500-line cap, so its body lives in work-driver-lifecycle.ts) and BEFORE
// runStep, so a CLOSED issue never pays for a child.
const loop = read("work-driver.ts");
assert(
  /const closed = await refuseClosedIssue\(ctx, state\)/.test(loop),
  "the step loop refuses a CLOSED issue",
);
assert(
  /if \(closed\) return closed;[\s\S]*?await runStep\(ctx, state, step\)/.test(loop) &&
    /const closed = await refuseClosedIssue\(ctx, state\)/.test(loop),
  "the refusal returns BEFORE runStep dispatches a child",
);
// The step boundary itself must be gated, not just entry: a mid-cycle CLOSE has
// to stop the NEXT step. Asserted per ungated step so deleting the call for one
// of them fails here rather than slipping through a single-site assertion.
{
  const rs = read("work-driver-run-step.ts");
  assert(
    /await endIfIssueClosed\(ctx, state, step\)/.test(rs),
    "runStep consults the closed-issue gate at the boundary",
  );
  assert(
    /if \(gate\.ended\) return gate\.ended/.test(rs),
    "an ended gate short-circuits before the step switch dispatches",
  );
  assert(
    /gatedState/.test(rs) && (rs.match(/ctx, gatedState, now/g) ?? []).length >= 6,
    "every pre-review step runs on the GATED state (a dropped note would be lost)",
  );
  assert(
    /endIfPrGone\(ctx, gatedState, step\)/.test(rs),
    "the PR gate reads the issue-gated state too, so the note survives",
  );
}
assert(
  /export async function refuseClosedIssue/.test(read("work-driver-lifecycle.ts")),
  "the refusal body lives outside the capped file",
);
assert(
  /checkIssueStatesAtEntry/.test(read("work-driver-lifecycle.ts")),
  "entry answers label + state in ONE issueView per issue",
);
const caps = read("workflow-state-events-caps.ts");
assert(/`issue-closed:\$\{WorkStep\}`/.test(caps), "issue-closed:<step> is in WorkCapLiteral");
assert(
  /"issue-closed": "step"/.test(read("headless/caps.ts")),
  "issue-closed is published in CAP_TEMPLATES (tsc fails if it is not)",
);
assert(
  // The queue's human-action table moved to work-queue-cap.ts (#1563-era
  // size split); assert on both so the check survives the next relocation
  // rather than going silently vacuous on a file move.
  /issue-closed/.test(read("work-queue-cap.ts")) || /issue-closed/.test(read("work-queue.ts")),
  "the work queue names a human action for an issue-closed park",
);
console.log(exit === 0 ? "\nAll #1472 wiring canaries passed." : "\nFAILED");
process.exit(exit);
