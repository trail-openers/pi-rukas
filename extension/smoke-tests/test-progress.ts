#!/usr/bin/env bun
/**
 * Pure unit test for the progress-rendering pipeline:
 *   - emptyRunningState seeds a clean state
 *   - ingestEvent only advances on message_end with assistant role
 *   - formatTokens / formatElapsed / formatUsage produce expected strings
 *   - renderSingle / renderBatch produce the right shape for the parent TUI
 *
 * No Pi spawns. Just feeds synthetic events into the state machine.
 */

import {
  emptyRunningState,
  formatElapsed,
  formatTokens,
  formatUsage,
  ingestEvent,
  renderBatch,
  renderSingle,
  type RunningState,
} from "../src/progress.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. formatTokens
assert(formatTokens(0) === "0", "0 tokens → '0'");
assert(formatTokens(42) === "42", "<1k → plain integer");
assert(formatTokens(1234) === "1.2k", "1.2k formatted with one decimal");
assert(formatTokens(42000) === "42k", "≥10k → no decimal");
assert(formatTokens(2_500_000) === "2.5M", "millions formatted with one decimal");

// 2. formatElapsed
assert(formatElapsed(345) === "345ms", "sub-second elapsed in ms");
assert(formatElapsed(1500) === "1.5s", "seconds with one decimal");
assert(formatElapsed(75_000) === "1m15s", "minutes+seconds combined");

// 3. ingestEvent — only advances on message_end with assistant role
{
  const s = emptyRunningState("developer");
  const start = Date.now();

  // session event — should not advance
  const advanced1 = ingestEvent(s, { type: "session" }, start);
  assert(advanced1 === false, "session event does not advance state");
  assert(s.turns === 0, "turn count still 0");

  // user message_end — should not advance
  const advanced2 = ingestEvent(
    s,
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    start,
  );
  assert(advanced2 === false, "user message_end does not advance");
  assert(s.turns === 0, "turn count still 0 after user message_end");

  // assistant message_end — should advance, update usage + last tool
  const advanced3 = ingestEvent(
    s,
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "test-model",
        usage: {
          input: 1000,
          output: 250,
          cacheRead: 500,
          cost: { total: 0.0123 },
        },
        content: [
          { type: "text", text: "Reading the file..." },
          { type: "toolCall", name: "read" },
        ],
      },
    },
    start,
  );
  assert(advanced3 === true, "assistant message_end advances state (returns true)");
  assert(s.turns === 1, "turn count incremented to 1");
  assert(s.toolUses === 1, "tool-uses counter incremented");
  assert(s.lastToolName === "read", "last tool name captured");
  assert(s.lastText === "Reading the file...", "last assistant text captured");
  assert(s.model === "test-model", "model captured");
  assert(s.usage.input === 1000, "usage.input accumulated");
  assert(s.usage.cost === 0.0123, "usage.cost accumulated");

  // second assistant turn — usage should sum
  ingestEvent(
    s,
    {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 500, output: 100, cost: { total: 0.0034 } },
        content: [{ type: "toolCall", name: "bash" }],
      },
    },
    start,
  );
  assert(s.turns === 2, "turn count = 2 after second assistant message");
  assert(s.toolUses === 2, "tool-uses = 2");
  assert(s.lastToolName === "bash", "last tool name updates to bash");
  assert(s.usage.input === 1500, "input tokens summed across turns");
  assert(Math.abs(s.usage.cost - 0.0157) < 0.0001, "cost summed across turns");
}

// 4. formatUsage — only includes non-zero fields
{
  const s: RunningState = {
    role: "explore",
    turns: 2,
    toolUses: 3,
    usage: { input: 1500, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 2 },
    model: "zai-glm-4.7",
    elapsedMs: 3200,
    done: false,
  };
  const text = formatUsage(s);
  assert(text.includes("2 turns"), "formatUsage includes turn count");
  assert(text.includes("3.2s"), "formatUsage includes elapsed");
  assert(text.includes("↑1.5k"), "formatUsage includes input tokens with up-arrow");
  assert(text.includes("↓400"), "formatUsage includes output tokens with down-arrow");
  assert(text.includes("$0.0050"), "formatUsage includes cost");
  assert(text.includes("zai-glm-4.7"), "formatUsage includes model");
  assert(!text.includes("R0"), "zero cacheRead omitted");
  assert(!text.includes("W0"), "zero cacheWrite omitted");
}

// 5. renderSingle — shows running spinner + current action
{
  const s: RunningState = {
    role: "developer",
    turns: 1,
    toolUses: 1,
    lastToolName: "read",
    usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    elapsedMs: 1200,
    done: false,
  };
  const out = renderSingle(s);
  assert(out.startsWith("⏳"), "running child rendered with hourglass icon");
  assert(out.includes("developer"), "role name in render");
  assert(out.includes("running read"), "current tool name in render");
}

// 6. renderSingle — done child shows ✓ / ✗ icon
{
  const ok: RunningState = {
    role: "ops",
    turns: 1,
    toolUses: 0,
    usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    elapsedMs: 800,
    done: true,
    ok: true,
  };
  assert(renderSingle(ok).startsWith("✓"), "done-ok child rendered with check");

  const fail: RunningState = { ...ok, ok: false };
  assert(renderSingle(fail).startsWith("✗"), "done-fail child rendered with cross");
}

// 7. renderBatch — header + per-child blocks
{
  const states: RunningState[] = [
    {
      role: "code-review-specialist",
      tag: "security",
      turns: 2,
      toolUses: 1,
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.002, turns: 2 },
      elapsedMs: 3000,
      done: true,
      ok: true,
    },
    {
      role: "code-review-specialist",
      tag: "errors",
      turns: 1,
      toolUses: 0,
      lastText: "Examining error boundaries",
      usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      elapsedMs: 1500,
      done: false,
    },
  ];
  const out = renderBatch("dispatch_lens_review", states);
  assert(out.startsWith("dispatch_lens_review · 1/2 done, 1 running"), "batch header correct");
  assert(out.includes("(security)"), "first child labelled with tag");
  assert(out.includes("(errors)"), "second child labelled with tag");
  assert(out.includes("✓"), "done child still shows check");
  assert(out.includes("⏳"), "running child still shows hourglass");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
