#!/usr/bin/env bun
/**
 * The cycle must never adopt the mainline as its own branch.
 *
 * The branch step's ops fallback reads `git rev-parse --abbrev-ref HEAD` at
 * `repoRoot` and records whatever it finds as `ps.branchName`. That value
 * becomes the cycle's integration branch: `integrate()` runs
 * `git checkout -B <branchName> <baseSha>` and `git push -u origin <branchName>`
 * against it.
 *
 * A grep for a mainline check across `work-driver-integrate.ts` and
 * `work-driver-commit.ts` returned **zero** hits. The only downstream guard was
 * `!branchName || branchName.startsWith("(")` — a detached-HEAD check.
 *
 * The reachable shape is an ops child that creates the branch and worktrees and
 * then returns `repoRoot` to the mainline: `git rev-parse` reports `main`, and
 * the cycle would force-push its work over it. `detectMainline` already exists
 * in `work-driver-git.ts` for the merge step, so this reuses it rather than
 * teaching a second module what a mainline is.
 *
 * This also renders `plumbReports`, which was written in two places and read in
 * none — the write site's own comment says the operator should see them "in
 * handoff".
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

// ---------------------------------- plumb reports reach the human at handoff

{
  const state = {
    issue: 664,
    issues: [664],
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "adversarial",
      reviewRound: 1,
      inFlightJobIds: [],
      branchName: "feature/issue-664-agenda",
      plumbReports: [
        {
          step: "adversarial",
          role: "driver",
          body: "lens-fix push failed (non-blocking): remote rejected",
          at: 5,
        },
      ],
    },
    eventLog: [
      { kind: "branch-created", at: 1, step: "branch" },
      { kind: "cap-hit", at: 9, cap: "review-rounds", reviewRound: 1, nextStep: "handoff" },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  } as any as WorkState;

  const md = renderHandoffMarkdown(state);
  assert(
    md.includes("lens-fix push failed"),
    "canary: a plumb report reaches the handoff comment — written in two places, read in none",
  );
  assert(/Plumbing that failed/.test(md), "...under a heading that says what it is");
  assert(
    /the cycle continued anyway/i.test(md),
    "...and says the cycle carried on, which is why it matters: the PR may not contain the fix",
  );
}

{
  // A clean cycle grows no empty section.
  const clean = {
    issue: 664,
    issues: [664],
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "adversarial",
      reviewRound: 1,
      inFlightJobIds: [],
      branchName: "feature/issue-664-agenda",
      plumbReports: [],
    },
    eventLog: [
      { kind: "branch-created", at: 1, step: "branch" },
      { kind: "cap-hit", at: 9, cap: "review-rounds", reviewRound: 1, nextStep: "handoff" },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any as WorkState;
  assert(
    !/Plumbing that failed/.test(renderHandoffMarkdown(clean)),
    "no plumb reports renders no section",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
