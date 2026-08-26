#!/usr/bin/env bun
/**
 * Pure unit test for dispatch_steer (#153):
 *  - emit lifecycle "steered" line formats correctly (truncation + label)
 *  - formatLine shape across all five lifecycle kinds (dispatched/completed/
 *    failed/errored/steered) — errored added in #236 for provider-timeout
 *    visibility
 *
 * The tool's end-to-end execute path (lookup childHandle, write RPC command,
 * emit lifecycle) is exercised in the live smoke test (test-dispatch-steer-live.ts,
 * filed separately when the live setup catches a real running child).
 */

import { childHandles, jobs } from "../src/async-jobs-registry.ts";
import { formatSingleReport } from "../src/async-jobs.ts";
import { steerChild } from "../src/dispatch-steer.ts";
import { type LifecycleDetails, emitSteered, formatLine } from "../src/lifecycle-events.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// #543 F2 — a synthetic stdin that records the RPC lines written to it.
// spawn.ts / the tool only ever call `.write(text)` on these, so a minimal
// stub (not a real Writable) is the right shape: it captures synchronously and
// can throw synchronously to simulate EPIPE.
function makeStdin(opts: { fail?: boolean } = {}): { write: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(s: string) {
      if (opts.fail) throw new Error("write EPIPE");
      lines.push(s);
    },
  };
}

// 0. F2 — steerChild: the stdin line is exactly the JSON steer envelope.
{
  const stdin = makeStdin();
  childHandles.set("j-f2", { stdin: stdin as never, label: "developer", role: "developer" });
  const r = steerChild("j-f2", "stop and report status", "driver-budget");
  assert(r.delivered === true, "steerChild: delivered for a live direct jobId");
  assert(r.label === "developer", "steerChild: returns the steered child's label");
  assert(
    stdin.lines.length === 1 &&
      JSON.stringify(JSON.parse(stdin.lines[0])) ===
        JSON.stringify({ type: "steer", message: "stop and report status" }) &&
      stdin.lines[0] ===
        JSON.stringify({ type: "steer", message: "stop and report status" }) + "\n",
    "steerChild: the stdin line is exactly the {type:'steer', message} envelope",
  );
  assert(stdin.lines[0].endsWith("\n"), "steerChild: the RPC line is newline-terminated");
  childHandles.delete("j-f2");
}

// 0b. F2 — steerChild: EPIPE on a dead handle returns delivered:false, no throw.
{
  const dead = makeStdin({ fail: true });
  childHandles.set("j-dead", { stdin: dead as never, label: "developer", role: "developer" });
  let threw = false;
  let r: ReturnType<typeof steerChild> | undefined;
  try {
    r = steerChild("j-dead", "hello", "driver-loop-detector");
  } catch {
    threw = true;
  }
  assert(!threw, "steerChild: EPIPE does not throw");
  assert(r?.delivered === false, "steerChild: EPIPE → delivered:false");
  assert(r?.reason === "write EPIPE", "steerChild: EPIPE → reason carries the write error");
  childHandles.delete("j-dead");
}

// 0c. F2 — steerChild: no such job → delivered:false reason 'no-such-job'.
{
  const r = steerChild("j-ghost", "hello", "pm-tool");
  assert(
    r.delivered === false && r.reason === "no-such-job",
    "steerChild: unknown jobId → no-such-job",
  );
}

// 0d. F2 — steerChild: orchestrator-shaped jobId resolves to the active inner child.
{
  const inner = makeStdin();
  const jobId = "orch-f2";
  jobs.set(jobId, {
    kind: "single",
    jobId,
    role: "adversarial-loop",
    label: "adversarial_loop",
    startedAt: Date.now(),
    abort: new AbortController(),
    ownerKind: "driver",
    isOrchestrator: true,
    activeChild: {
      role: "adversarial-developer",
      label: "adversarial-developer",
      deckKey: "k",
      stdin: inner as never,
      startedAt: Date.now(),
    },
  });
  const r = steerChild(jobId, "refocus", "pm-tool");
  assert(r.delivered === true, "steerChild: orchestrator jobId resolves to active inner child");
  assert(
    r.label === "adversarial-developer",
    "steerChild: orchestrator steer reports the inner child label",
  );
  assert(
    inner.lines.length === 1 &&
      JSON.stringify(JSON.parse(inner.lines[0])) ===
        JSON.stringify({ type: "steer", message: "refocus" }) &&
      inner.lines[0] === JSON.stringify({ type: "steer", message: "refocus" }) + "\n",
    "steerChild: orchestrator steer writes the envelope to the inner child's stdin",
  );
  jobs.delete(jobId);
}

// 0e. F2 — steerChild: orchestrator between rounds → 'between-rounds', no throw.
{
  const jobId = "orch-f2-idle";
  jobs.set(jobId, {
    kind: "single",
    jobId,
    role: "adversarial-loop",
    label: "adversarial_loop",
    startedAt: Date.now(),
    abort: new AbortController(),
    ownerKind: "driver",
    isOrchestrator: true,
  });
  const r = steerChild(jobId, "refocus", "pm-tool");
  assert(
    r.delivered === false && r.reason === "between-rounds",
    "steerChild: orchestrator between rounds → between-rounds",
  );
  jobs.delete(jobId);
}

// 0f. F2 — the lifecycle 'steered' line is tagged with the source.
{
  const tagged: LifecycleDetails = {
    kind: "steered",
    jobId: "x",
    label: "developer",
    role: "developer",
    steerMessage: "wrap up now",
    steerSource: "driver-budget",
  };
  const line = formatLine(tagged);
  assert(line.includes("[driver-budget]"), "steered line tags the source (driver-budget)");
  assert(line.includes("⤳ steered developer"), "steered line keeps the label");

  // The PM tool path omits the source → the line is byte-identical to pre-#543.
  const pm: LifecycleDetails = {
    kind: "steered",
    jobId: "x",
    label: "developer",
    role: "developer",
    steerMessage: "wrap up now",
  };
  const pmLine = formatLine(pm);
  assert(!pmLine.includes("["), "pm-tool steer (no source) renders no source tag");
  assert(
    pmLine === '▸ ensemble: ⤳ steered developer · "wrap up now"',
    "pm-tool steer line is byte-identical to the pre-#543 shape",
  );

  const loop: LifecycleDetails = {
    kind: "steered",
    jobId: "x",
    label: "code-review-specialist",
    role: "code-review-specialist",
    steerMessage: "stop the repeated grep",
    steerSource: "driver-loop-detector",
  };
  assert(
    formatLine(loop).includes("[driver-loop-detector]"),
    "loop-detector steer tags the source",
  );
}

// 1. formatLine handles all five lifecycle kinds.
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

  const errored: LifecycleDetails = {
    kind: "errored",
    jobId: "x",
    label: "developer",
    role: "developer",
    elapsedMs: 540_000,
    totalTokens: 280_000,
  };
  const erroredLine = formatLine(errored);
  assert(
    erroredLine.includes("⚠ developer terminated mid-stream"),
    "errored line uses ⚠ marker + 'terminated mid-stream' phrase (PR #236)",
  );
  assert(erroredLine.includes("9m00s"), "errored line includes formatted elapsed");
  assert(erroredLine.includes("280k tokens"), "errored line includes token total");
  // #299 reworded the blanket "provider request error" to name the actual
  // failure class — the shape is a transport-level verdict, not proof the
  // endpoint is down.
  assert(
    erroredLine.includes("provider/transport error"),
    "errored line names the failure category for user scrollback",
  );

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

// 5. formatSingleReport surfaces provider error-stops as FAILED-PROVIDER-ERROR (#236).
//    Reproduces the failure mode where pi-ai turned an HTTP timeout into a synthetic
//    empty assistant message; without this signal the dispatch report mistakes the
//    last successful thinking block for the agent's final reply.
{
  const okResult: DispatchResult = {
    role: "developer",
    ok: true,
    text: "Implementation complete.",
    toolUses: [],
    ms: 60_000,
    exitCode: 0,
  };
  const okReport = formatSingleReport("j1", "developer", okResult);
  assert(okReport.includes("finished"), "ok result renders as `finished`");
  assert(!okReport.includes("FAILED-PROVIDER-ERROR"), "ok result is NOT marked as provider error");

  const erroredResult: DispatchResult = {
    role: "developer",
    ok: false,
    text: "Step 2: Find the sweep writer",
    toolUses: [],
    ms: 540_000,
    exitCode: 0,
    errorStop: { reason: "error", message: "Request timed out after 180000ms" },
  };
  const erroredReport = formatSingleReport("j2", "developer", erroredResult);
  assert(
    erroredReport.includes("FAILED-PROVIDER-ERROR"),
    "errorStop result is marked as FAILED-PROVIDER-ERROR",
  );
  assert(
    erroredReport.includes("Request timed out after 180000ms"),
    "errored report surfaces the pi-ai errorMessage so user can see WHY",
  );
  assert(
    erroredReport.includes("VERIFY DIRECTLY"),
    "errored report warns user the worktree may be unchanged",
  );
  assert(
    erroredReport.includes("Step 2: Find the sweep writer"),
    "errored report still includes the pre-failure text so user has context",
  );

  const erroredResultNoMessage: DispatchResult = {
    role: "developer",
    ok: false,
    text: "(no output)",
    toolUses: [],
    ms: 540_000,
    exitCode: 0,
    errorStop: { reason: "error" }, // message omitted
  };
  const noMsgReport = formatSingleReport("j3", "developer", erroredResultNoMessage);
  assert(
    noMsgReport.includes("FAILED-PROVIDER-ERROR"),
    "errorStop without message still classified as provider error",
  );
  assert(
    noMsgReport.includes("no error message captured"),
    "errored report degrades gracefully when pi-ai didn't surface a message",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
