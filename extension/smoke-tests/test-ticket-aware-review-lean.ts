#!/usr/bin/env bun
/**
 * Ticket-aware review, lean side: the issue reaches both lens passes and the fixer.
 *
 * Split from `test-ticket-aware-review.ts` along the two review paths
 * (AGENTS.md §12 file-size limit — each file is one review layer's prompt sites).
 * Read that file's header for the benchmark failure this exists for: a lens fix
 * replaced a fixed exception message the ticket REQUIRED, because neither the
 * lenses nor the fixer had ever seen the ticket.
 *
 * Two grains, both asserted:
 *   - the pure renderers (`lensContext`, `fixPrompt`) — what a brief contains,
 *     its bound, its disarm, and what it prints when there is no issue;
 *   - the STEP (`runReviewStep`) — that the one body it reads is handed to both
 *     lens passes and to the fixer it dispatches. The renderer alone cannot show
 *     that: a call site can drop the argument and leave the renderer perfect.
 *
 * Lean prints the body only. It has no cached title to print, and inventing one
 * would be the step claiming provenance it does not have — asserted below.
 */

import { fixPrompt, lensContext } from "../src/lean/review-deps.ts";
import { FIXER_DECLINE_RULE, ISSUE_DECLINE_MARKER } from "../src/work-driver-lens-issue.ts";
import { runReviewStep } from "./lib/lean-review-ticket-fixture.ts";
import { CONSTRAINT, ISSUE_BODY, OVER_BODY } from "./lib/ticket-issue-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

console.log("# lean: both lens passes and the fixer brief carry the issue");
{
  const full = lensContext(7, "full", { issueBody: ISSUE_BODY });
  const fix = lensContext(7, "fix", { issueBody: ISSUE_BODY });
  for (const [label, brief] of [
    ["full review", full],
    ["re-review of the fix", fix],
  ] as const) {
    assert(brief.includes(CONSTRAINT), `the lean ${label} lens brief contains the constraint`);
    assert(
      /NOT a finding/.test(brief),
      `and the ${label} lens carries the rule that a spec-contradicting finding is not a finding`,
    );
    assert(
      !/^### INJECT/m.test(brief),
      `and a heading in the body cannot open a line of the ${label} lens brief`,
    );
    assert(!brief.includes("undefined"), `and no "undefined" in the ${label} lens brief`);
  }
  for (const empty of [undefined, "", "   \n  "]) {
    const bare = lensContext(7, "full", { issueBody: empty });
    assert(
      !bare.includes("judge it against THIS") && !bare.includes("undefined"),
      `a ${JSON.stringify(empty)} issue body opens no block in the lean lens brief`,
    );
  }
  const big = lensContext(7, "full", { issueBody: OVER_BODY });
  const markers = big.match(/…\(issue truncated\)/g) ?? [];
  assert(
    markers.length === 1,
    `an over-cap lean lens body shows exactly one truncation marker (saw ${String(markers.length)})`,
  );
  assert(
    !/\[truncated at /.test(big),
    "and the fence's clip marker never appears in the lens brief",
  );
  // Lean prints the body only: no synthesised title line is invented.
  assert(
    !lensContext(7, "full", { issueBody: "just a body line" }).includes("title:"),
    "lean prints the body it was given and synthesises no title",
  );

  const fixerBase = {
    issue: 7,
    wave: "full" as const,
    gate: "six-lens review (ISSUES_FOUND)",
    findings: "- [HIGH] SECURITY a.ts:1: reword the exception",
    worktree: "/repo/.worktrees/lean-7-fix-l-1-0-1793451347919",
    repoRoot: "/repo",
    branch: "lean/issue-7",
    base: "b",
    head: "h",
    frozenPaths: ["tests/AC1.test.ts"],
    budget: { opts: {}, fired: () => undefined },
    stop: {},
  };
  const brief = fixPrompt({ ...fixerBase, issueBody: ISSUE_BODY } as never);
  assert(brief.includes(CONSTRAINT), "the lean fixer's brief contains the issue's constraint");
  assert(
    brief.includes(ISSUE_DECLINE_MARKER) && brief.includes(FIXER_DECLINE_RULE),
    "and the decline rule with the shared greppable marker",
  );
  assert(
    brief.includes("never a finding's own wording, and never the gate's prose"),
    "and the decline is scoped to a printed requirement, not the findings list or the gate's prose",
  );
  assert(!brief.includes("undefined"), 'and no "undefined" in the fixer brief');
  const noBody = fixPrompt({ ...fixerBase, issueBody: undefined } as never);
  assert(
    !noBody.includes("judge it against THIS") && !noBody.includes(ISSUE_DECLINE_MARKER),
    "a fixer brief with no issue body prints no block and no decline rule (nothing to cite)",
  );
  const bigBrief = fixPrompt({ ...fixerBase, issueBody: OVER_BODY } as never);
  assert(
    (bigBrief.match(/…\(issue truncated\)/g) ?? []).length === 1,
    "an over-cap body in the fixer brief shows exactly one truncation marker",
  );

  // Both lens passes through the STEP, not just the pure renderer: the step
  // reads one body and must hand the same text to both rounds.
  const { contexts, fixBriefs } = await runReviewStep(ISSUE_BODY);
  assert(
    contexts.length >= 2 &&
      contexts.every((c) => c.includes(CONSTRAINT)) &&
      contexts.some((c) => c.includes("full review of the branch")) &&
      contexts.some((c) => c.includes("re-review of the fix wave's commits")),
    "the step's own two lens passes both received the issue block through the step, not just the renderer",
  );
  assert(
    fixBriefs.length === 1 &&
      fixBriefs[0]?.includes(CONSTRAINT) &&
      fixBriefs[0]?.includes(ISSUE_DECLINE_MARKER),
    "and the fixer the step dispatched received the block and the marker",
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
