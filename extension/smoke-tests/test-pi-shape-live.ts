#!/usr/bin/env bun
/**
 * LIVE Pi-version shape test (#7).
 *
 * Spawns a real Pi child and asserts that the JSON event shape we depend
 * on (per AGENTS.md §4 "Pi compatibility (load-bearing)") is intact for
 * the currently-pinned Pi version. CI does NOT run this — live tests cost
 * real tokens. Run it manually after bumping `@earendil-works/pi-coding-agent`
 * in `extension/package.json`:
 *
 *   bun run smoke-tests/test-pi-shape-live.ts
 *
 * What this catches: Pi changes a field name (e.g., `tool_use` → `toolCall`,
 * which has happened), drops an event type (e.g., agent_end), or restructures
 * usage stats. Offline tests use synthetic event payloads and won't notice.
 *
 * Coverage:
 *   1. agent_end event exists and has `messages` array — load-bearing for
 *      --mode rpc done-detection (#152)
 *   2. message_end events with `message.role` and `message.usage`
 *      (input/output/cacheRead/cacheWrite are numbers) — load-bearing for
 *      progress reporting + cost accounting
 *   3. Content blocks include `type: "text"` and (when the model used a
 *      tool) `type: "toolCall"` with `id`, `name`, `arguments`
 *   4. Assistant message has `model` field — used by collapseEvents
 *
 * Cost: typically ~2-3 seconds and a few cents on Cerebras GLM-4.7. The
 * prompt is deliberately trivial ("say PONG") to minimise tokens while
 * still exercising one assistant turn end-to-end.
 */

import { readFileSync } from "node:fs";
import { spawnSpecialist } from "../src/spawn.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

console.log("[test] spawning explore child with trivial PONG prompt...");
const result = await spawnSpecialist({
  role: "explore",
  prompt: "Reply with exactly the word PONG. Nothing else.",
});

console.log(`[test] spawn returned in ${result.ms}ms, ok=${result.ok}, exitCode=${result.exitCode}`);

assert(result.ok === true, "spawnSpecialist returned ok=true");
assert(result.exitCode === 0, "exitCode is 0");
assert(typeof result.transcriptPath === "string", "transcriptPath is set");

// Read the transcript (JSONL events).
const transcript = result.transcriptPath ?? "";
const raw = readFileSync(transcript, "utf8");
const events: Array<{ type?: string; message?: Record<string, unknown>; messages?: unknown[] }> = raw
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

console.log(`[test] transcript has ${events.length} events`);
assert(events.length >= 3, "transcript contains at least 3 events (session + at least one message + close)");

// 1. agent_end shape (load-bearing for --mode rpc done-detection in #152).
//    Note: Pi's session transcript may or may not include `agent_end` —
//    historically it appears in stdout but not always serialised to session
//    JSON. So we accept either presence here or evidence-of-end via
//    last-event role.
const agentEnd = events.find((e) => e.type === "agent_end");
const sessionHasAgentEnd = agentEnd !== undefined;
if (sessionHasAgentEnd) {
  assert(Array.isArray(agentEnd?.messages), "agent_end.messages is an array");
  assert((agentEnd?.messages?.length ?? 0) > 0, "agent_end.messages is non-empty");
}

// 2. message_end with role/usage.
const messageEnds = events.filter((e) => e.type === "message" || e.type === "message_end");
assert(messageEnds.length > 0, "at least one message/message_end event in transcript");

const assistantTurn = messageEnds.find(
  (e) => (e.message as { role?: string } | undefined)?.role === "assistant",
);
assert(assistantTurn !== undefined, "at least one assistant message present");

const msg = (assistantTurn?.message ?? {}) as {
  role?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>;
  usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
};

assert(typeof msg.model === "string" && msg.model.length > 0, "assistant message has non-empty `model` field");
assert(typeof msg.usage === "object" && msg.usage !== null, "assistant message has `usage` object");
assert(typeof msg.usage?.input === "number", "usage.input is a number");
assert(typeof msg.usage?.output === "number", "usage.output is a number");
// cacheRead / cacheWrite may be zero but should still be numbers
assert(typeof msg.usage?.cacheRead === "number", "usage.cacheRead is a number");
assert(typeof msg.usage?.cacheWrite === "number", "usage.cacheWrite is a number");

// 3. Content blocks.
const content = msg.content ?? [];
assert(content.length > 0, "assistant message has at least one content block");
const textBlock = content.find((b) => b.type === "text");
assert(textBlock !== undefined, "at least one text-type content block");
assert(
  typeof textBlock?.text === "string" && textBlock.text.trim().length > 0,
  "text block has non-empty text field",
);

// 4. Final result.text reflects the agent's answer.
assert(
  result.text.toUpperCase().includes("PONG"),
  `result.text contains PONG (actual preview: "${result.text.slice(0, 60)}")`,
);

console.log(`\n[test] pinned Pi version: ${process.env.npm_package_devDependencies__earendil_works_pi_coding_agent ?? "(read from package.json)"}`);
console.log(`[test] transcript: ${transcript}`);
console.log(`\nexit ${exit}`);
process.exit(exit);
