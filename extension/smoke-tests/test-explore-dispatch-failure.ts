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
 * Measured: lantern #686 and #693 both recorded `dispatch-failed explore …
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
function noSignalPredicate() {
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
async function guardOrdering() {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  // #1094 — the attempt helper owns the completion/failure split; the run
  // file returns before the verdict router whenever no reply was produced.
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-explore-run.ts"),
    "utf8",
  );
  const helper = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-explore-dispatch.ts"),
    "utf8",
  );

  const replyIdx = helper.indexOf(
    'reply: event.kind === "dispatch-completed" ? exploreDispatch : undefined',
  );
  const guardIdx = src.indexOf("if (first.reply === undefined) return next;");
  const routerIdx = src.indexOf("let responseText = first.reply.text");
  // The helper appends the completion event on the success path and a
  // dispatch-failed event on the catch path, both before it returns.
  const successIdx = helper.indexOf(
    'const after = appendEvent(clearDispatch(next, begun.jobId), event);',
  );
  const catchIdx = helper.indexOf("} catch (err) {");
  const failedIdx = helper.indexOf('kind: "dispatch-failed"', catchIdx);
  assert(
    successIdx > 0 && catchIdx > 0 && failedIdx > catchIdx,
    "dispatchExploreAttempt: completion event on success, dispatch-failed on the catch path",
  );
  const catchReturnIdx = helper.indexOf("return {", catchIdx);
  assert(
    catchReturnIdx > catchIdx && catchReturnIdx < failedIdx && failedIdx < successIdx,
    "dispatchExploreAttempt: dispatch-failed is appended inside the catch return, before the success path",
  );

  assert(
    replyIdx > 0 && routerIdx > 0,
    "the reply is set only on completion and the verdict router is present",
  );
  assert(
    guardIdx > 0 && guardIdx < routerIdx,
    "canary: a failed dispatch returns BEFORE the verdict router — it fell through, and a timeout was reported as an underspecified issue",
  );
}

noSignalPredicate();
await guardOrdering();

console.log(`\nexit ${exit}`);
process.exit(exit);
