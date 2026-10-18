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
  /declinedLabelSeed\(\s*next\.pipelineState/.test(read("work-driver-handoff.ts")) &&
    /if \(!declinesAttentionLabel\(ps\)\)/.test(read("work-driver-handoff-post.ts")),
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
// #1472 placement, and WHY it is where it is: `work-driver.ts` is pinned at the
// repo's 500-line hard limit, so the step loop cannot grow — the step-boundary
// park lives in `runStep`, the single funnel every step passes through, and it
// returns BEFORE the step switch dispatches any child. The cycle-entry refusal
// keeps its own `DriverOutcome`-shaped form in the lifecycle module.
const loop = read("work-driver.ts");
assert(
  !/refuseClosedIssue|parkIfIssueClosed/.test(loop),
  "work-driver.ts stays at main exactly — the gate does NOT live in the capped file",
);
assert(
  /const issueGate = await parkIfIssueClosed\(ctx, state, step\)/.test(runStep),
  "runStep parks a CLOSED issue",
);
// The fail-open contract, asserted as TEXTURE not vibes: only a state that is
// NOT the one we handed in counts as a park. An unreadable issue returns the
// same object, so the step must run — a plumb-report note appended to the state
// would otherwise be truthy and abort the cycle on a transient gh outage.
assert(
  /if \(issueGate && issueGate !== state\) return issueGate;[\s\S]*?if \(step !== "handoff"/.test(
    runStep,
  ),
  "the park returns before the step gate, and ONLY when the state actually changed",
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
