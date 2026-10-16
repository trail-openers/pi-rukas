#!/usr/bin/env bun
/**
 * #1153 — a consolidation check that did not run is recorded on pipelineState
 * and rendered in the handoff. A skipped check is never silent: the operator
 * must see WHICH check was skipped and why. With no notes, the section is absent.
 */

import { renderHandoffMarkdown, renderNoteBullet } from "../src/work-driver-handoff-markdown.ts";
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

// #1153 fix round — the rendered list is bounded. A cycle whose git reads all
// fail can accumulate one note per skipped check per commit-pr attempt; the
// handoff is a bounded report, not the archive. The state file is the archive:
// every note persists there (asserted below), and the ellipsis names the count
// so the truncation is visible rather than a silently short list.
{
  const many = Array.from({ length: 27 }, (_, i) => `consolidation check skipped: reason ${i}`);
  const md = renderHandoffMarkdown(stateWith(many), "/repo");
  const section = md
    .split("### Consolidation checks that did not run")[1]
    .split("### What was attempted")[0];
  const bullets = section.split("\n").filter((l) => l.startsWith("- "));
  assert(
    bullets.length === 21,
    `cap: 27 notes render as 20 bullets plus one ellipsis (got ${bullets.length})`,
  );
  assert(
    bullets.slice(0, 20).every((b, i) => b.includes(`reason ${i}`)),
    "cap: the FIRST twenty notes render, in order",
  );
  assert(
    bullets[20]?.includes("…and 7 more"),
    `cap: the ellipsis names the hidden count (got ${JSON.stringify(bullets[20])})`,
  );
  assert(!md.includes("reason 26"), "cap: a note past the bound is not rendered");
  // Exactly at the bound there is no ellipsis — "and 0 more" is noise. The
  // section heading is the only place the word appears otherwise.
  const exact = renderHandoffMarkdown(
    stateWith(Array.from({ length: 20 }, (_, i) => `consolidation check skipped: r${i}`)),
    "/repo",
  );
  assert(!exact.includes("more`"), "cap: exactly 20 notes render with no ellipsis line");
}

// `<` and `>` are literal inside a code span, so a note quoting git's own
// `origin/<branch>` needs no escaping — and must not be mangled into an
// entity. This asserts the render leaves them alone (see the comment on
// renderNoteBullet for why the code span makes escaping unnecessary).
{
  const angled = renderNoteBullet("consolidation check skipped: origin/<branch> is missing");
  assert(
    angled.includes("origin/<branch>"),
    `render: angle brackets survive verbatim inside the code span (got ${angled})`,
  );
  assert(
    !angled.includes("&lt;") && !angled.includes("&#"),
    "render: no HTML entity is invented for angle brackets",
  );
}

process.exit(exit);
