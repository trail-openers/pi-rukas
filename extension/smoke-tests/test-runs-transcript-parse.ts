#!/usr/bin/env bun
/**
 * `/runs` is where an operator is sent to find out what a child actually did.
 * It was reporting `tool calls: 0` for every transcript ever written.
 *
 * The parser matched Anthropic's `tool_use` / `tool_result` block names and
 * expected tool results to arrive as blocks inside a `user` message. Pi does
 * neither: it emits `toolCall` blocks with an `arguments` string, and gives
 * tool results their own `toolResult` role. The local `SessionEvent` type even
 * declared `role: "user" | "assistant"`, so the branch could never have run.
 *
 * The fixture below is copied from the measured shape of a real transcript
 * (`mspr5ylf-eg4d66-explore-daphne-arch-0.json`, 63 assistant turns / 41 tool
 * calls) — the run whose report said "1 turns · (no output)" and sent an
 * operator to `/runs`, which then told them there had been no tool calls.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { summariseTranscript } from "../src/runs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const rows = [
  {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "research daphne" }] },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Looking at the tests." },
        {
          type: "toolCall",
          id: "79a6111c5",
          name: "bash",
          arguments: "{'command': 'find . -name *.py'}",
        },
      ],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "79a6111c5",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "/daphne/tests/unit/test_tool_overflow_error.py" }],
    },
  },
  {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Found the overflow tests." }] },
  },
];

const dir = mkdtempSync(path.join(os.tmpdir(), "runs-parse-"));
const file = path.join(dir, "transcript.json");
writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));

const parsed = await summariseTranscript(file);

assert(parsed.turns === 2, `assistant turns counted: ${parsed.turns} (want 2)`);
assert(
  parsed.toolCalls.length === 1,
  `canary: Pi's \`toolCall\` blocks are counted — got ${parsed.toolCalls.length}, pre-fix this was 0 for every transcript`,
);
assert(parsed.toolCalls[0]?.name === "bash", "...with the tool name");
assert(
  typeof parsed.toolCalls[0]?.input === "string" &&
    /find \./.test(parsed.toolCalls[0].input as string),
  "...and the `arguments` payload, which is a JSON string on a toolCall block",
);
assert(
  parsed.toolResults.length === 1,
  `canary: a \`toolResult\`-role message is captured — got ${parsed.toolResults.length}, pre-fix 0 (the type did not even permit the role)`,
);
assert(
  /test_tool_overflow_error\.py/.test(parsed.toolResults[0]?.preview ?? ""),
  "...carrying what the tool actually returned — the gathered material the report claimed did not exist",
);
assert(parsed.userPrompt.includes("research daphne"), "the user prompt still parses");
assert(
  parsed.assistantText.includes("Found the overflow tests"),
  "assistant prose still parses — the Anthropic branch was widened, not replaced",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
