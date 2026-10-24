#!/usr/bin/env bun
/**
 * A handoff must say what actually happened.
 *
 * One measured cycle's adversarial loop ran three full rounds — three reviews, two fix
 * dispatches, twenty minutes — and the handoff comment posted to GitHub said:
 *
 *     **Rounds**: 0 of 3 review rounds
 *
 * `reviewRound` is the LENS counter; it is legitimately 0 when a cycle dies at
 * step 5 and never reaches step 7. Printing it under an adversarial cap tells
 * the reader nothing happened, when in fact everything had.
 *
 * The same comment explained the cap as "the diff still has issues the
 * adversarial-developer flagged" — without saying which — so the operator had
 * to dispatch an agent to read the transcripts and find out. The findings were
 * on the event the whole time.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FINDING =
  "extract_metadata false-match on ' | assumption:' in question text — sanitize.rs:127-134";

const state = (cap: string, extra: unknown[] = []): WorkState =>
  ({
    issue: 664,
    issues: [664],
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "adversarial",
      reviewRound: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-664-agenda",
    },
    eventLog: [
      { kind: "branch-created", at: 1, step: "branch" },
      ...extra,
      { kind: "cap-hit", at: 9, cap, reviewRound: 0, nextStep: "handoff" },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  }) as any as WorkState;

// -------------------------------------------- the adversarial cap reports itself

{
  const md = renderHandoffMarkdown(
    state("adversarial-loop", [
      { kind: "adversarial-rejected", at: 5, jobId: "j", rounds: 3, findings: FINDING },
    ]),
  );

  assert(
    !/\*\*Rounds\*\*: 0 of 3 review rounds/.test(md),
    "canary: the handoff no longer says '0 of 3 review rounds' after three adversarial rounds ran",
  );
  assert(
    /3 adversarial round\(s\)/.test(md),
    "...it reports the adversarial rounds that actually ran",
  );
  assert(
    md.includes(FINDING),
    "canary: the actual blocking finding is in the comment — an operator had to read transcripts for this",
  );
  assert(/What the reviewer objected to/.test(md), "...under a heading that says what it is");
}

// --------------------------------- a lens cap still reports the lens counter

{
  const s = state("review-rounds");
  s.pipelineState.reviewRound = 2;
  const md = renderHandoffMarkdown(s);
  assert(
    /\*\*Rounds\*\*: 2 of 3 review rounds/.test(md),
    "a lens-review cap still reports the review round — the fix is targeted, not a blanket rewrite",
  );
  assert(!/adversarial round/.test(md), "...and does not claim adversarial rounds it never ran");
}

// ------------------------------------------------- degrading without evidence

{
  // An adversarial cap with no rejection event (infra failure, or a state file
  // from before this change) must not fabricate a count.
  const md = renderHandoffMarkdown(state("adversarial-loop"));
  assert(
    /round count unrecorded/.test(md),
    "with no rejection event it says the count is unrecorded rather than printing a wrong number",
  );
  assert(
    !/What the reviewer objected to/.test(md),
    "...and prints no findings section when there are no findings",
  );
}

{
  // A rejection event carrying no findings must not emit an empty section.
  const md = renderHandoffMarkdown(
    state("adversarial-loop", [
      { kind: "adversarial-rejected", at: 5, jobId: "j", rounds: 2, findings: "   " },
    ]),
  );
  assert(/2 adversarial round\(s\)/.test(md), "the round count is still reported");
  assert(
    !/What the reviewer objected to/.test(md),
    "canary: blank findings render no section rather than an empty heading",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
