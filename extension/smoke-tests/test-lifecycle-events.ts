#!/usr/bin/env bun
/**
 * Pure unit test for lifecycle scrollback events (#118):
 *  - formatLine produces the expected three shapes (dispatched/completed/failed)
 *  - tokens/elapsed shown only when present
 *  - exit code shown only on failed
 *  - emitX functions push exactly one sendMessage call with the right customType,
 *    display: true, content, and details payload
 *  - PI_ENSEMBLE_QUIET_LIFECYCLE=1 short-circuits everything
 *
 * No Pi spawns. The sendMessage path is exercised by attaching a fake
 * ExtensionAPI that records calls.
 */

import {
  type LifecycleDetails,
  attach,
  detach,
  emitCompleted,
  emitDispatched,
  emitFailed,
  formatLine,
} from "../src/lifecycle-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
  details: LifecycleDetails;
}

function fakePi(): { sentMessages: SentMessage[]; pi: Parameters<typeof attach>[0] } {
  const sentMessages: SentMessage[] = [];
  const pi = {
    sendMessage: (m: SentMessage) => {
      sentMessages.push(m);
    },
    // No registerMessageRenderer — exercised separately
  } as unknown as Parameters<typeof attach>[0];
  return { sentMessages, pi };
}

// 1. formatLine — dispatched shape.
{
  const text = formatLine({
    kind: "dispatched",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
  });
  assert(text.startsWith("▸ ensemble: dispatched"), "dispatched line uses ▸ ensemble: dispatched prefix");
  assert(text.includes("developer"), "dispatched line includes label");
  assert(text.includes("df8a-7r"), "dispatched line includes jobId");
  assert(!text.includes("ms"), "dispatched line has no elapsed");
  assert(!text.includes("token"), "dispatched line has no token count");
}

// 2. formatLine — completed with tokens + elapsed.
{
  const text = formatLine({
    kind: "completed",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
    elapsedMs: 151000,
    totalTokens: 14300,
  });
  assert(text.includes("✓"), "completed line uses ✓");
  assert(text.includes("developer"), "completed line includes label");
  assert(text.includes("2m31s"), "completed line includes formatted elapsed");
  // formatTokens rounds 14300 → "14k" (≥10k uses no decimals — see progress.ts).
  assert(text.includes("14k tokens"), "completed line includes formatted token count");
  assert(text.includes("finished"), "completed line says finished");
}

// 3. formatLine — completed with zero tokens drops the token suffix.
{
  const text = formatLine({
    kind: "completed",
    jobId: "x",
    label: "ops",
    role: "ops",
    elapsedMs: 1000,
    totalTokens: 0,
  });
  assert(!text.includes("token"), "zero tokens omitted from completed line");
}

// 4. formatLine — failed with exit code + elapsed.
{
  const text = formatLine({
    kind: "failed",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
    elapsedMs: 151000,
    exitCode: 1,
  });
  assert(text.includes("✗"), "failed line uses ✗");
  assert(text.includes("failed"), "failed line says failed");
  assert(text.includes("2m31s"), "failed line includes elapsed");
  assert(text.includes("exit 1"), "failed line includes exit code");
  assert(text.includes("see report"), "failed line points at the report");
}

// 5. formatLine — failed without exit code (work threw before child started).
{
  const text = formatLine({
    kind: "failed",
    jobId: "x",
    label: "ops",
    role: "ops",
    elapsedMs: 1000,
  });
  assert(!text.includes("exit "), "no exit code when undefined");
}

// 6. emitDispatched/Completed/Failed push sendMessage with expected payload.
{
  const { sentMessages, pi } = fakePi();
  attach(pi);
  emitDispatched("job-1", "developer", "developer");
  emitCompleted("job-1", "developer", "developer", 8000, 5000);
  emitFailed("job-2", "ops", "ops", 12000, 1);
  assert(sentMessages.length === 3, "three emits → three sendMessage calls");
  assert(
    sentMessages.every((m) => m.customType === "ensemble:lifecycle"),
    "every message uses ensemble:lifecycle customType",
  );
  assert(
    sentMessages.every((m) => m.display === true),
    "every message has display: true",
  );
  assert(sentMessages[0]?.details.kind === "dispatched", "first message details.kind = dispatched");
  assert(sentMessages[1]?.details.kind === "completed", "second message details.kind = completed");
  assert(sentMessages[2]?.details.kind === "failed", "third message details.kind = failed");
  assert(sentMessages[1]?.content.includes("✓"), "completed message content has ✓");
  assert(sentMessages[2]?.content.includes("✗"), "failed message content has ✗");
  detach();
}

// 7. PI_ENSEMBLE_QUIET_LIFECYCLE=1 suppresses sends.
{
  const { sentMessages, pi } = fakePi();
  attach(pi);
  process.env.PI_ENSEMBLE_QUIET_LIFECYCLE = "1";
  emitDispatched("muted", "developer", "developer");
  emitCompleted("muted", "developer", "developer", 1000, 100);
  assert(sentMessages.length === 0, "quiet env var prevents sendMessage");
  delete process.env.PI_ENSEMBLE_QUIET_LIFECYCLE;
  emitDispatched("audible", "developer", "developer");
  assert(sentMessages.length === 1, "emits resume when env var unset");
  detach();
}

// 8. Without attach, emit is a no-op (don't throw).
{
  detach();
  let threw = false;
  try {
    emitDispatched("orphan", "ops", "ops");
  } catch {
    threw = true;
  }
  assert(!threw, "emit before attach does not throw");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
