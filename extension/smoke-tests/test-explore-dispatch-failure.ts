#!/usr/bin/env bun
/**
 * A timed-out explore is an infrastructure fault, not a bad issue.
 *
 * `runExplore` appended the completion event and then continued straight into
 * the verdict router without checking whether the dispatch had FAILED. A
 * timed-out explore has empty text, so no `## Spec` block parses and no legacy
 * verdict is found — and `exploreProducedNoSignal` then emitted
 * `cap-hit: explore-needs-clarification`, which becomes the event-log tail and
 * overrides the `dispatch-failed` event the step router would have classified.
 *
 * Measured: nessie #686 and #693 both recorded `dispatch-failed explore …
 * killCause: timeout` immediately followed by `cap-hit
 * explore-needs-clarification`. The operator was told to go add acceptance
 * criteria to two issues that were already fully specified.
 *
 * Honest scoping: both were `killCause: "timeout"`, which the taxonomy
 * classifies `shouldRetry: false`, so this masking cost DIAGNOSIS rather than
 * retries. That is still the expensive kind of wrong — it sends a human to fix
 * the wrong thing.
 */

import { exploreProducedNoSignal } from "../src/work-driver-explore.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The no-signal predicate is still correct for its own case — a COMPLETED
// dispatch whose reply carried no decision. What changed is that a FAILED
// dispatch never reaches it.
{
  assert(
    exploreProducedNoSignal(true, null),
    "a COMPLETED explore that returned no decision is still no signal",
  );
  assert(
    !exploreProducedNoSignal(true, "NEEDS_WORK"),
    "...and a legacy verdict is still a decision",
  );
}

// The guard itself: the source must return before the verdict router whenever
// the completion event is not a success. This is a structural assertion because
// the failure is one of ORDERING — the predicate is fine, it was simply
// reachable from a state it must never see.
{
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-explore-run.ts"),
    "utf8",
  );

  const appendIdx = src.indexOf("appendEvent(clearDispatch(next, begun.jobId), event)");
  const guardIdx = src.indexOf('if (event.kind !== "dispatch-completed") return next;');
  const routerIdx = src.indexOf("const responseText = exploreDispatch.text");

  assert(appendIdx > 0 && routerIdx > 0, "the append and the verdict router are both present");
  assert(
    guardIdx > appendIdx && guardIdx < routerIdx,
    "canary: a failed dispatch returns BEFORE the verdict router — it fell through, and a timeout was reported as an underspecified issue",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
