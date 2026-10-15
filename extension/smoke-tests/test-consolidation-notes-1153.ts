#!/usr/bin/env bun
/**
 * #1153 — a consolidation check that did not run is recorded on pipelineState
 * and rendered in the handoff. A skipped check is never silent: the operator
 * must see WHICH check was skipped and why. With no notes, the section is absent.
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

function stateWith(notes?: string[]): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 1153,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "commit-pr",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-1153-git-plumbing",
      worktrees: {},
      plumbReports: [],
      ...(notes ? { consolidationNotes: notes } : {}),
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 3,
        cap: "verify-failed:commit-pr",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
  };
}

const NOTE =
  "consolidation check skipped: origin/feature/issue-1153-git-plumbing not found in this clone — the branch was not pushed from here";

{
  const md = renderHandoffMarkdown(stateWith([NOTE]), "/repo");
  assert(
    md.includes("### Consolidation checks that did not run"),
    "handoff: the skipped-check section is rendered",
  );
  assert(md.includes(NOTE), "handoff: the skipped check's note appears verbatim");
}
{
  const md = renderHandoffMarkdown(stateWith(undefined), "/repo");
  assert(
    !md.includes("Consolidation checks that did not run"),
    "handoff: no section when no check was skipped",
  );
}

process.exit(exit);
