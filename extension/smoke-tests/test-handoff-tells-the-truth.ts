#!/usr/bin/env bun
/**
 * The handoff must say what the review found, and admit when we did the killing.
 *
 * **The findings.** The six-pass review produces structured findings and stores
 * them on `lens-issues-found`. Every surface then discarded them: the GitHub
 * body printed *"Review the JSON findings in the state file's most recent
 * `lens-issues-found` event"*, the in-chat message printed nothing at all, and
 * `/work-status` printed a count. Measured cost — across four nessie cycles the
 * operator's PM rediscovered by hand, from the diff, exactly what the lenses
 * had already reported: a SECURITY CRITICAL for a deleted `src/config/mod.rs`,
 * a SIMPLICITY HIGH for duplicate `persist_lock` mutexes, and an
 * ERROR_HANDLING CRITICAL that was then refiled as a brand-new issue. The
 * conclusion drawn was "review approval proved a weak signal". The reviews were
 * not weak; nobody was ever shown them.
 *
 * **The kills.** `killCause` and an `errorTail` naming the budget are written
 * onto `dispatch-failed` and were rendered by nothing — `grep errorTail` across
 * all three surfaces returned zero hits. nessie #686 and #693 were both killed
 * at 31m08s having produced nothing, and both were described to their operator
 * as issue-quality problems, inviting the editing of two good issues.
 *
 * **The recovery commands.** A cycle that halts before the branch step has no
 * branch, no worktree and no PR, but fell through to a generic block offering
 * `git status`, "keep the worktree changes", and `git push -u origin <branch>`.
 * That had been special-cased once, for `intent-park`; every later pre-branch
 * cap fell through to the same wrong text. The predicate is now the state — no
 * branch name — rather than an enumeration of caps that will always lag.
 */

import { killDetail } from "../src/kill-detail.ts";
import { renderLensFindings } from "../src/lens-findings-render.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { sliceMarkdownSection } from "../src/work-driver-plan.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The real #663 finding, in the shape the event actually stores. */
const FINDINGS = JSON.stringify([
  {
    lens: "CLAIM_SCAN",
    severity: "MEDIUM",
    path: "AGENTS.md",
    line: 357,
    title: "Unsourced path: src/memory.rs",
  },
  {
    lens: "SECURITY",
    severity: "CRITICAL",
    path: "src/config/mod.rs",
    line: 0,
    title: "Entire config module root deleted — all config validation lost",
  },
]);

const mkState = (over: Partial<WorkState["pipelineState"]>, events: WorkEvent[]): WorkState =>
  ({
    issue: 663,
    eventLog: events,
    pipelineState: {
      currentStep: "handoff",
      lastCompletedStep: "lens-review",
      status: "handoff",
      reviewRound: 3,
      plumbReports: [],
      ...over,
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only read fields matter
  }) as any;

const issuesFound: WorkEvent = {
  kind: "lens-issues-found",
  at: 1,
  jobId: "j",
  round: 3,
  findings: FINDINGS,
  verdict: "CRITICAL_ISSUES_FOUND",
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
} as any;

// ------------------------------------------ the findings reach both surfaces

{
  const state = mkState({ branchName: "feature/issue-663", prNumber: 694 }, [issuesFound]);
  for (const [name, text] of [
    ["markdown", renderHandoffMarkdown(state)],
    ["message", renderHandoffUserMessage(state, "/repo", "/scratch")],
  ] as const) {
    assert(
      text.includes("Entire config module root deleted"),
      `canary: the ${name} handoff names the CRITICAL finding — it printed a pointer to the state file, or nothing`,
    );
    assert(
      text.includes("CRITICAL") && text.includes("src/config/mod.rs"),
      `canary: ...with its severity and path, in ${name}`,
    );
  }
}

{
  // Worst first: an operator scanning the top of a handoff must meet the
  // CRITICAL, not the MEDIUM that happens to be first in the array.
  const rendered = renderLensFindings(FINDINGS, "CRITICAL_ISSUES_FOUND").join("\n");
  assert(
    rendered.indexOf("CRITICAL") < rendered.indexOf("MEDIUM"),
    "findings render worst-severity-first, not in array order",
  );
  assert(/2 CRITICAL|1 CRITICAL, 1 MEDIUM/.test(rendered), "...under a severity tally");
  // A renderer that throws costs the whole handoff — the exact failure this
  // module exists to prevent.
  assert(renderLensFindings("{not json", "x").length === 0, "a malformed blob renders nothing");
  assert(renderLensFindings(undefined).length === 0, "...and so does an absent one");
}

// ----------------------------------------------- we admit our own kills

{
  const killed: WorkEvent = {
    kind: "dispatch-failed",
    at: 2,
    step: "explore",
    role: "explore",
    jobId: "k",
    killCause: "timeout",
    errorTail: "[pi-rukas] killed after 1868000ms timeout (override: PI_ENSEMBLE_SPAWN_TIMEOUT_MS)",
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
  const detail = killDetail(mkState({}, [killed])).join("\n");
  assert(
    /timeout|wall-clock/i.test(detail) && /OUR kill/.test(detail),
    `canary: a timeout kill is described as ours (got ${JSON.stringify(detail.slice(0, 90))})`,
  );
  assert(killDetail(mkState({}, [issuesFound])).length === 0, "no kill, no kill section");

  // The #686/#693 shape: killed at explore, so no branch was ever created.
  const state = mkState({ branchName: undefined, lastCompletedStep: undefined }, [killed]);
  for (const [name, text] of [
    ["markdown", renderHandoffMarkdown(state)],
    ["message", renderHandoffUserMessage(state, "/repo", "/scratch")],
  ] as const) {
    assert(
      /timeout|wall-clock/i.test(text),
      `canary: the ${name} handoff says a timeout happened — it said only that a step "failed"`,
    );
    assert(
      !/push -u origin/.test(text),
      `canary: ...and offers no push for a branch that was never created (${name})`,
    );
  }
  // A cycle that DID create a branch still gets the takeover commands.
  const withBranch = renderHandoffMarkdown(
    mkState({ branchName: "feature/issue-663" }, [issuesFound]),
  );
  assert(
    /push -u origin feature\/issue-663/.test(withBranch),
    "a cycle that has a branch still gets the manual-takeover commands",
  );
}

// ------------------------------------------- section slicing drops the rule

{
  const doc = "## Rationale\nThe intent is clear.\n\n---\n\n## Workstreams\n- a\n";
  const rationale = sliceMarkdownSection(doc, "Rationale") ?? "";
  assert(
    !/-{3,}/.test(rationale),
    `canary: a \`---\` separator does not ride along on the section above (got ${JSON.stringify(rationale)})`,
  );
  assert(rationale.includes("The intent is clear."), "...while the section body survives intact");
  // A rule that is genuinely part of the prose, mid-section, is not ours to remove.
  const mid = sliceMarkdownSection("## R\nbefore\n---\nafter\n\n## Next\n", "R") ?? "";
  assert(mid.includes("---"), "a rule INSIDE the section is left alone");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
