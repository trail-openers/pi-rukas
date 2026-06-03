#!/usr/bin/env bun
/**
 * Pure unit test for dispatch_steer (#153):
 *  - emit lifecycle "steered" line formats correctly (truncation + label)
 *  - formatLine shape across all four lifecycle kinds (dispatched/completed/
 *    failed/steered)
 *
 * The tool's end-to-end execute path (lookup childHandle, write RPC command,
 * emit lifecycle) is exercised in the live smoke test (test-dispatch-steer-live.ts,
 * filed separately when the live setup catches a real running child).
 */

import { type LifecycleDetails, emitSteered, formatLine } from "../src/lifecycle-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. formatLine handles all four lifecycle kinds.
{
  const dispatched: LifecycleDetails = {
    kind: "dispatched",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
  };
  assert(
    formatLine(dispatched) === "▸ ensemble: dispatched developer · df8a-7r",
    "dispatched line includes ▸ prefix + label + jobId",
  );

  const completed: LifecycleDetails = {
    kind: "completed",
    jobId: "x",
    label: "developer",
    role: "developer",
    elapsedMs: 12_000,
    totalTokens: 5500,
  };
  const completedLine = formatLine(completed);
  assert(completedLine.includes("✓ developer finished"), "completed line uses ✓ marker");
  assert(completedLine.includes("12.0s"), "completed line includes formatted elapsed");
  assert(completedLine.includes("5.5k tokens"), "completed line includes token total");

  const failed: LifecycleDetails = {
    kind: "failed",
    jobId: "x",
    label: "ops",
    role: "ops",
    elapsedMs: 60_000,
    exitCode: 1,
  };
  const failedLine = formatLine(failed);
  assert(failedLine.includes("✗ ops failed"), "failed line uses ✗ marker");
  assert(failedLine.includes("exit 1"), "failed line includes exit code");

  const steered: LifecycleDetails = {
    kind: "steered",
    jobId: "x",
    label: "developer",
    role: "developer",
    steerMessage: "stop investigating main's git history and report what you have",
  };
  const steeredLine = formatLine(steered);
  assert(steeredLine.startsWith("▸ ensemble: ⤳ steered"), "steered line uses ⤳ marker");
  assert(steeredLine.includes("developer"), "steered line includes label");
  assert(
    steeredLine.includes("stop investigating main's git history"),
    "steered line includes the message",
  );
}

// 2. Steer message truncation at 80 chars + newline flattening.
{
  const longMsg = "abcdef ".repeat(20); // 140 chars
  const steered: LifecycleDetails = {
    kind: "steered",
    jobId: "x",
    label: "developer",
    role: "developer",
    steerMessage: longMsg,
  };
  const line = formatLine(steered);
  const inner = line.match(/"(.*)"$/)?.[1] ?? "";
  assert(inner.length <= 80, `truncated message ≤80 chars (got ${inner.length})`);
  assert(inner.endsWith("…"), "truncation marker present");

  const newlines: LifecycleDetails = {
    kind: "steered",
    jobId: "x",
    label: "developer",
    role: "developer",
    steerMessage: "line one\nline two\nline three",
  };
  const flat = formatLine(newlines);
  assert(!flat.includes("\n", "▸".length), "newlines flattened to spaces in message");
}

// 3. Steer with empty message renders as empty quoted string (no crash).
{
  const empty: LifecycleDetails = {
    kind: "steered",
    jobId: "x",
    label: "developer",
    role: "developer",
    steerMessage: "",
  };
  const line = formatLine(empty);
  assert(line.includes('""') || line.endsWith('""'), "empty message rendered as empty quotes");
}

// 4. emitSteered constructs a valid LifecycleDetails shape (smoke test only;
//    actual sendMessage is exercised via attach()/detach() in test-lifecycle-events).
{
  // emitSteered is bound to module-level activePi which is unset here;
  // calling it should be a no-op (logged via trace), not a crash.
  let threw = false;
  try {
    emitSteered("job-x", "developer", "developer", "test message");
  } catch {
    threw = true;
  }
  assert(!threw, "emitSteered before attach is a safe no-op");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
