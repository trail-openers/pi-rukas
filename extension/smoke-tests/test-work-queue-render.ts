#!/usr/bin/env bun
/**
 * #1101 — the end-of-queue report distinguishes the two kinds of park.
 *
 * `test-work-queue-dlq.ts` owns the queue's DECISIONS (what parks, what halts,
 * what continues). This file owns the one thing those decisions are worth to the
 * operator: the text they read at the end of a run.
 *
 * The failure it guards is subtle and entirely operator-side. A parked group is
 * either a cycle that RAN and died somewhere — branch, diff, PR, findings, all
 * salvageable — or a group the queue never dispatched at all, which produced
 * literally nothing. Both landed under one `⏸ … cap …` line, so an operator
 * scanning for `⏸` to find work to rescue was shown groups containing none, and
 * the `at <step>` suffix the first kind needs was printed for the second as an
 * implication that a cycle had got somewhere. The counts are separated in the
 * headline for the same reason: `2 parked` is not one number's worth of
 * information.
 */

import { renderQueueSummary } from "../src/work-queue.ts";
import type { QueueSummary } from "../src/work-queue.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A summary with one merged group and the two parked kinds side by side. */
function mixed(): QueueSummary {
  return {
    entries: [
      { groupId: "group-a", issues: [1], outcome: "merged" },
      {
        groupId: "group-b",
        issues: [2],
        outcome: "parked",
        reason: "cap round-cap",
        failedStep: "lens-review",
        humanAction: "review the findings on #2's PR",
      },
      {
        groupId: "group-c",
        issues: [3],
        outcome: "parked",
        reason: "cap dependency-parked:#2",
        humanAction: "get #3's dependency #2 merged — nothing was built",
      },
    ],
    merged: 1,
    parked: 2,
    refused: 0,
    notStarted: [],
  };
}

// ============================= 1. The headline breaks the parks into two kinds
{
  const text = renderQueueSummary(mixed());
  assert(
    /2 parked \(1 never dispatched\)/.test(text),
    "the headline counts the never-dispatched parks separately from the parks that ran",
  );
  assert(/1 merged/.test(text), "merged groups are still counted in the same headline");

  // The parenthetical is an absence, not a zero — a queue with no ordering parks
  // must read exactly as it did before #1101.
  const noQueueParks: QueueSummary = {
    entries: [
      {
        groupId: "group-a",
        issues: [1],
        outcome: "parked",
        reason: "cap round-cap",
        failedStep: "adversarial-loop",
      },
    ],
    merged: 0,
    parked: 1,
    refused: 0,
    notStarted: [],
  };
  const plain = renderQueueSummary(noQueueParks);
  assert(
    /1 parked(?!\s*\()/.test(plain),
    "with no queue-level park there is no parenthetical at all (a zero is not printed)",
  );
}

// ==================== 2. The `at <step>` suffix belongs to one kind only
{
  const text = renderQueueSummary(mixed());
  assert(
    /at lens-review/.test(text),
    "a park that ran names the step it died on — that is where the salvage is",
  );
  assert(
    !/cap dependency-parked:#2 at /.test(text),
    "a park that never dispatched names NO step — there was no step to die on",
  );
  assert(
    text.includes("group-b") && text.includes("group-c"),
    "both parked groups still appear in full — the distinction never hides a group",
  );
}

// ============== 3. Every queue-level reason takes the never-dispatched shape
//
// All three reasons the QUEUE can raise, not just the one that fires most. A
// fourth reason added later without joining `QUEUE_PARK_REASONS` silently gets
// the running-cycle treatment and prints a step it never had.
{
  for (const reason of [
    "cap dependency-parked:#2",
    "cap dependency-timeout: dependency group(s) group-a never reached a terminal state",
    "cap dependency-cycle: group-c is part of an ordering cycle (waits on group-b)",
    // #1101 fix-round — the fourth queue-raised reason. It was missing from
    // `QUEUE_PARK_REASONS`, so a group the halt left in the wait list rendered
    // with the running-cycle glyph and a step suffix — the exact false report
    // this section exists to prevent. `sweepStranded` writes this shape.
    "cap queue-stranded:dependency group(s) group-a",
  ]) {
    const summary: QueueSummary = {
      entries: [
        {
          groupId: "group-c",
          issues: [3],
          outcome: "parked",
          reason,
          // Deliberately populated: if the renderer trusted this field over the
          // reason, every queue-level park would print a step.
          failedStep: "develop",
          humanAction: "resolve the blocker, then re-run",
        },
      ],
      merged: 0,
      parked: 1,
      refused: 0,
      notStarted: [],
    };
    const text = renderQueueSummary(summary);
    const label = reason.slice(0, 34);
    assert(
      !/ at develop$/.test(text.trim()),
      `"${label}" prints no step even when failedStep is set`,
    );
    assert(/1 never dispatched/.test(text), `"${label}" is counted as never dispatched`);
    assert(/resolve the blocker/.test(text), `"${label}" still shows its human action`);
  }
}

// =================== 4. A cross-group-conflict park is judged by its provenance
//
// `cross-group-conflict` is raised from two places, and they are different
// facts: the reactive plan-time check raises it from INSIDE a cycle that had
// already dispatched (there is a diff to read), while the queue raises it when
// an in-flight sibling never released its claim (there is nothing). One cap
// name, two provenances — so the renderer must not classify it by name, and a
// reason carrying the queue's own `in-flight sibling(s)` detail is the shape
// that earns the never-dispatched treatment.
{
  // `ranCycle` is scoped here rather than inlined into the summary: the point of
  // the case is a cycle that DID dispatch, and naming it is what the assertion
  // reads. It is also why each section is its own block — the two summaries in
  // this file must not be able to share a binding.
  const ranCycle: QueueSummary = {
    entries: [
      {
        groupId: "group-a",
        issues: [1],
        outcome: "parked",
        reason: "cap cross-group-conflict",
        failedStep: "plan",
      },
    ],
    merged: 0,
    parked: 1,
    refused: 0,
    notStarted: [],
  };
  const cycleText = renderQueueSummary(ranCycle);
  assert(
    /1 parked(?!\s*\()/.test(cycleText),
    "a plan-time cross-group-conflict is NOT counted as never dispatched — that cycle dispatched",
  );
  assert(
    / at plan/.test(cycleText),
    "and it keeps its step, which is where the collision surfaced",
  );
}

// ================================ 5. The other outcomes are untouched
{
  const text = renderQueueSummary({
    entries: [
      { groupId: "group-a", issues: [1, 2], outcome: "merged" },
      { groupId: "group-b", issues: [3], outcome: "not-started" },
      { groupId: "group-c", issues: [4], outcome: "halted", reason: "systemic: provider quota" },
    ],
    merged: 1,
    parked: 0,
    refused: 1,
    notStarted: ["group-b"],
  });
  assert(/#1, #2/.test(text), "a multi-issue group lists every issue it carries");
  assert(/never reached/.test(text), "the not-started count still appears in the headline");
  assert(/did not start/.test(text), "the refused count still appears in the headline");
  assert(text.includes("group-c"), "a halted group is still rendered");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
