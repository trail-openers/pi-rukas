#!/usr/bin/env bun
/**
 * Offline unit test for pair-watch event routing + cap enforcement.
 *
 * Strategy: don't spawn real Pi children. Instead we construct EventEmitter
 * stand-ins that implement enough of the RpcClient surface (event channel +
 * steer/prompt/dispose) for the wiring functions to operate on. We then fire
 * fake Pi events on the developer/adversarial mocks and assert that
 *   - dev message_end → adversarial.steer fired with a summary
 *   - adversarial tool_execution_start(interrupt_developer) → developer.steer fired
 *   - approve / escalate tool calls set state.verdict
 *   - cost cap and interrupt cap fire as expected
 *
 * No Pi process, no network.
 */

import { EventEmitter } from "node:events";
import {
  type PairCaps,
  createSessionState,
  wireAdversarialEvents,
  wireDeveloperEvents,
} from "../src/pair-watch.ts";
import type { RpcClient } from "../src/spawn-rpc.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface StubSteer {
  message: string;
  at: number;
}

function makeMockClient(role: string): { client: RpcClient; steers: StubSteer[] } {
  const ee = new EventEmitter() as unknown as RpcClient;
  // We capture both `.steer(msg)` and `.prompt(msg, "steer")` into the same
  // array because they are interchangeable inter-agent delivery paths. The
  // orchestrator currently uses prompt+steer (works in both idle/streaming
  // states); historical code used raw steer (which only worked when streaming).
  const steers: StubSteer[] = [];
  Object.defineProperty(ee, "role", { value: role });
  Object.defineProperty(ee, "transcriptPath", { value: `/tmp/fake-${role}.json` });
  Object.defineProperty(ee, "model", { value: { source: "default" } });
  Object.defineProperty(ee, "steer", {
    value: async (message: string) => {
      steers.push({ message, at: Date.now() });
      return { type: "response", command: "steer", success: true };
    },
  });
  Object.defineProperty(ee, "prompt", {
    value: async (message: string, streamingBehavior?: "steer" | "followUp") => {
      // Only capture as a "steer" delivery if streamingBehavior says so — the
      // initial role-prompt is sent without behaviour and should NOT be
      // counted as a partner steer.
      if (streamingBehavior === "steer") steers.push({ message, at: Date.now() });
      return { type: "response", command: "prompt", success: true };
    },
  });
  Object.defineProperty(ee, "abort", {
    value: async () => ({ type: "response", command: "abort", success: true }),
  });
  Object.defineProperty(ee, "exited", { value: new Promise(() => undefined) });
  Object.defineProperty(ee, "dispose", { value: () => undefined });
  return { client: ee, steers };
}

const caps: PairCaps = { wallClockMs: 60_000, maxInputTokens: 1_000_000, maxInterrupts: 3 };

// ---------------------------------------------------------------------------
// Test 1 — dev message_end is summarised + steered to adversarial
// ---------------------------------------------------------------------------
{
  const state = createSessionState();
  const dev = makeMockClient("developer");
  const adv = makeMockClient("adversarial");
  wireDeveloperEvents(dev.client, adv.client, state, caps);

  // Emit a fake dev assistant message — text + tool call with file arg
  dev.client.emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'm implementing the foo() function." },
        { type: "toolCall", name: "edit", arguments: { path: "src/foo.rs" } },
      ],
      usage: { input: 1200, output: 80, cacheRead: 200, cacheWrite: 0 },
      model: "zai-glm-4.7",
      provider: "cerebras",
    },
  });

  await new Promise((r) => setTimeout(r, 30));
  assert(state.devSummaries.length === 1, "one dev summary captured");
  assert(state.devTokens.input === 1200, "dev input tokens accumulated");
  assert(state.devModel === "zai-glm-4.7", "dev model captured");
  assert(state.devProvider === "cerebras", "dev provider captured");
  assert(adv.steers.length === 1, "exactly one steer queued to adversarial");
  assert(adv.steers[0].message.includes("[pair:developer-turn 1]"), "steer carries dev-turn tag");
  assert(adv.steers[0].message.includes("implementing the foo"), "steer body contains dev text");
  assert(
    adv.steers[0].message.includes("[edit: src/foo.rs]"),
    "steer body shows tool arg, not just tool name",
  );
}

// ---------------------------------------------------------------------------
// Test 2 — adversarial interrupt_developer tool call is routed to dev as steer
// ---------------------------------------------------------------------------
{
  const state = createSessionState();
  const dev = makeMockClient("developer");
  const adv = makeMockClient("adversarial");
  wireAdversarialEvents(adv.client, dev.client, state, caps);

  adv.client.emit("tool_execution_start", {
    toolName: "interrupt_developer",
    args: { message: "Stop — that function is racy; wrap the access in a lock." },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert(state.interrupts.length === 1, "interrupt recorded in state");
  assert(dev.steers.length === 1, "one steer routed to developer");
  assert(dev.steers[0].message.startsWith("[pair:adversarial]"), "dev steer tagged correctly");
  assert(dev.steers[0].message.includes("wrap the access in a lock"), "dev steer carries message");
}

// ---------------------------------------------------------------------------
// Test 3 — interrupt cap halts further routing
// ---------------------------------------------------------------------------
{
  const state = createSessionState();
  const dev = makeMockClient("developer");
  const adv = makeMockClient("adversarial");
  const tight: PairCaps = { ...caps, maxInterrupts: 2 };
  wireAdversarialEvents(adv.client, dev.client, state, tight);

  for (let i = 0; i < 5; i++) {
    adv.client.emit("tool_execution_start", {
      toolName: "interrupt_developer",
      args: { message: `interrupt #${i}` },
    });
  }
  await new Promise((r) => setTimeout(r, 20));
  assert(state.interrupts.length === 2, `interrupts capped at 2 (got ${state.interrupts.length})`);
  assert(dev.steers.length === 2, "only 2 steers reached developer");
  assert(state.verdict === "CAP_HIT", "cap_hit verdict set");
  assert((state.verdictReason ?? "").includes("interrupt cap"), "reason cites interrupt cap");
}

// ---------------------------------------------------------------------------
// Test 4 — approve_developer sets APPROVED verdict
// ---------------------------------------------------------------------------
{
  const state = createSessionState();
  const dev = makeMockClient("developer");
  const adv = makeMockClient("adversarial");
  wireAdversarialEvents(adv.client, dev.client, state, caps);

  adv.client.emit("tool_execution_start", {
    toolName: "approve_developer",
    args: { summary: "All checks passed and no issues observed." },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(state.verdict === "APPROVED", "verdict APPROVED");
  assert((state.verdictReason ?? "").includes("All checks"), "approve summary recorded");
}

// ---------------------------------------------------------------------------
// Test 5 — escalate_to_user sets ESCALATED verdict
// ---------------------------------------------------------------------------
{
  const state = createSessionState();
  const dev = makeMockClient("developer");
  const adv = makeMockClient("adversarial");
  wireAdversarialEvents(adv.client, dev.client, state, caps);

  adv.client.emit("tool_execution_start", {
    toolName: "escalate_to_user",
    args: { reason: "Developer keeps reintroducing the same bug after 2 interrupts." },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(state.verdict === "ESCALATED", "verdict ESCALATED");
  assert((state.verdictReason ?? "").includes("reintroducing"), "escalation reason captured");
}

// ---------------------------------------------------------------------------
// Test 6 — input-token cap fires across both children
// ---------------------------------------------------------------------------
{
  const state = createSessionState();
  const dev = makeMockClient("developer");
  const adv = makeMockClient("adversarial");
  const tight: PairCaps = { ...caps, maxInputTokens: 1000 };
  wireDeveloperEvents(dev.client, adv.client, state, tight);
  wireAdversarialEvents(adv.client, dev.client, state, tight);

  // Push dev input to 800 — under cap
  dev.client.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "first turn" }],
      usage: { input: 800, output: 100, cacheRead: 0, cacheWrite: 0 },
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert(!state.verdict, "token cap not hit after first turn");

  // Push adv input to 500 → total 1300 > 1000 cap
  adv.client.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "watching" }],
      usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(state.verdict === "CAP_HIT", "input-token cap fired (CAP_HIT verdict)");
  assert(
    (state.verdictReason ?? "").includes("input-token cap"),
    "reason cites input-token cap",
  );
}

// ---------------------------------------------------------------------------
// Test 7 — dev assistant message without content emits no summary
// ---------------------------------------------------------------------------
{
  const state = createSessionState();
  const dev = makeMockClient("developer");
  const adv = makeMockClient("adversarial");
  wireDeveloperEvents(dev.client, adv.client, state, caps);

  // Non-assistant role should be ignored
  dev.client.emit("message_end", {
    message: { role: "user", content: [{ type: "text", text: "ignored" }] },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(state.devSummaries.length === 0, "user-role message ignored");

  // Empty assistant message should be ignored
  dev.client.emit("message_end", {
    message: { role: "assistant", content: [] },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(state.devSummaries.length === 0, "empty-content assistant ignored");
}

// ---------------------------------------------------------------------------
// Test 8 — dev message text >500 chars is truncated in the steer
// ---------------------------------------------------------------------------
{
  const state = createSessionState();
  const dev = makeMockClient("developer");
  const adv = makeMockClient("adversarial");
  wireDeveloperEvents(dev.client, adv.client, state, caps);

  const longText = "x".repeat(2000);
  dev.client.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: longText }],
      usage: { cost: { total: 0.001 } },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(adv.steers.length === 1, "one steer fired");
  // Steer envelope ≤ 500 chars of text + the [pair:developer-turn N] header.
  assert(adv.steers[0].message.length < 600, `steer bounded to <600 chars (got ${adv.steers[0].message.length})`);
  assert(adv.steers[0].message.includes("..."), "truncation marker present");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
