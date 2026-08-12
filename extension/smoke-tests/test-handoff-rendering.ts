#!/usr/bin/env bun
/**
 * #398 — what the handoff actually says to the operator.
 *
 * **No test anywhere asserted on rendered handoff content**, which is why this
 * shipped: `intent-park` fires in `explore`, before the branch step — no
 * branch, no worktree, no PR, nothing written — and it inherited a recovery
 * block written for `developer-timeout`. A real run on #337 told the operator
 * to retry a timeout that never happened, keep worktree changes that did not
 * exist, and run:
 *
 *     git push -u origin (branch not captured)
 *
 * — a literal placeholder inside a copy-pasteable command.
 *
 * The `&&` assertions are not cosmetic. These lines land in the Pi chat via
 * `sendUserMessage`, and per `modules/core/oo-command-runner.md:107-125` the
 * permission matcher cannot wildcard a chained shape, so every unique chain
 * re-prompts the operator.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A cycle that parked at intent resolution: nothing ran past explore. */
function intentParkState(parkReason = "underspecified"): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 337,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "explore",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      // branchName deliberately absent — no branch was ever created.
      normalisedSpec: {
        intent: "Fix the release-please CI gate.",
        deliverables: [],
        acceptanceCriteria: [],
        outOfScope: [],
        assumptions: [],
        openQuestions: [],
        evidence: [],
        verdict: "park",
        parkReason,
        rationale: "The mechanism is confirmed via executed evidence.",
      },
    },
    eventLog: [{ kind: "cap-hit", at: 3, cap: "intent-park", reviewRound: 0, nextStep: "handoff" }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
  } as any;
}

const REPO = "/Users/x/repo";

for (const [name, render] of [
  ["chat", (s: WorkState) => renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-337`)],
  ["markdown", (s: WorkState) => renderHandoffMarkdown(s, REPO)],
] as const) {
  const out = render(intentParkState());

  // ---- the four things the #337 handoff got wrong

  assert(!/git push/.test(out), `${name}: no 'git push' — the cycle never created a branch`);
  assert(
    !/\(branch not captured\)/.test(out.replace(/\*\*Branch\*\*:[^\n]*/g, "")),
    `${name}: the '(branch not captured)' fallback never reaches a command`,
  );
  assert(
    !/longer per-spawn cap/.test(out),
    `${name}: no 'retry with a longer per-spawn cap' — nothing timed out`,
  );
  assert(
    !/keep the worktree changes|keep worktree/.test(out),
    `${name}: does not offer to keep worktree changes that do not exist`,
  );

  // ---- and what it should say instead

  assert(/intent resolution/i.test(out), `${name}: says the cycle halted at intent resolution`);
  assert(
    /add acceptance criteria|concrete description/i.test(out),
    `${name}: carries parkAction's text for the recorded reason`,
  );
  assert(/spec\.txt/.test(out), `${name}: points at the resolver's own reasoning`);

  // ---- no chained shell commands anywhere in the rendered output

  const shellLines = out
    .split("\n")
    .filter((l) => /^\s*(#\s)?\s*(git|gh|rm|export|cat|\/work)\b/.test(l.trim()));
  const chained = shellLines.filter((l) => /&&|\|\||;\s|\|/.test(l));
  assert(
    chained.length === 0,
    `${name}: no chained commands — each re-prompts the operator (${chained[0]?.trim() ?? "none"})`,
  );
  assert(
    shellLines.length > 0,
    `${name}: ...and there ARE commands to check, so the assertion is not vacuous`,
  );
}

// ------------------------------------- the park reason reaches the action

{
  const a = renderHandoffUserMessage(intentParkState("too-large"), REPO, `${REPO}/tmp`);
  const b = renderHandoffUserMessage(intentParkState("already-implemented"), REPO, `${REPO}/tmp`);
  assert(/split/i.test(a), "a `too-large` park says to split the issue");
  assert(/close/i.test(b), "an `already-implemented` park says to confirm and close");
  assert(a !== b, "different park reasons produce different handoffs");
}

// -------------------------- a real branch still gets the takeover commands

{
  const s = intentParkState();
  s.pipelineState.branchName = "feature/issue-337-x";
  s.eventLog = [
    { kind: "cap-hit", at: 3, cap: "developer-timeout", reviewRound: 0, nextStep: "handoff" },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  ] as any;
  const out = renderHandoffUserMessage(s, REPO, `${REPO}/tmp`);
  assert(
    /git .*push -u origin feature\/issue-337-x/.test(out),
    "a post-branch cap DOES get the takeover command, with the real branch name",
  );
  assert(
    !/&&/.test(
      out
        .split("\n")
        .filter((l) => /^\s*git\b/.test(l.trim()))
        .join("\n"),
    ),
    "...still unchained",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
