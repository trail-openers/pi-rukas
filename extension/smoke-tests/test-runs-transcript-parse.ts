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

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { summariseTranscript } from "../src/runs.ts";
import { buildViewerText, findTranscriptPath } from "../src/dispatch-deck-interactive.ts";

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

// --- #607 d2: the deck transcript viewer reuses the /runs renderer ---
// findTranscriptPath resolves a direct child's deck key (== jobId) to the
// on-disk transcript by basename prefix; batch/orchestrator keys (containing
// "/") and missing roots resolve to undefined.
{
  const vdir = mkdtempSync(path.join(os.tmpdir(), "runs-viewer-"));
  const datedir = path.join(vdir, "2026-01-01");
  mkdirSync(datedir);
  // Direct child: basename starts with `<jobId>-`.
  writeFileSync(
    path.join(datedir, "abc123-developer.json"),
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  // An unrelated job in the same dir.
  writeFileSync(path.join(datedir, "zzz999-explore.json"), "{}");
  const found = await findTranscriptPath("abc123", vdir);
  assert(
    found === path.join(datedir, "abc123-developer.json"),
    "findTranscriptPath resolves a direct child key to its transcript file",
  );
  assert(
    (await findTranscriptPath("zzz999", vdir)) === path.join(datedir, "zzz999-explore.json"),
    "findTranscriptPath resolves a different direct child key",
  );
  assert(
    (await findTranscriptPath("runIdX/tag", vdir)) === undefined,
    "findTranscriptPath: orchestrator-shaped keys (contain '/') are not resolvable",
  );
  assert(
    (await findTranscriptPath("nope", vdir)) === undefined,
    "findTranscriptPath: unknown key → undefined",
  );
}

{
  const missing = await findTranscriptPath(
    "abc123",
    path.join(os.tmpdir(), "definitely-not-here-xyz"),
  );
  assert(missing === undefined, "findTranscriptPath: missing root dir → undefined (no throw)");
}

// buildViewerText renders the same output as /runs' level-3 view for the
// same file, and degrades to an explicit no-transcript note when the file
// is absent.
{
  const vdir2 = mkdtempSync(path.join(os.tmpdir(), "runs-viewer2-"));
  const datedir2 = path.join(vdir2, "2026-01-02");
  mkdirSync(datedir2);
  writeFileSync(
    path.join(datedir2, "jobV-developer.json"),
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  const viewerText = await buildViewerText(
    "jobV",
    "developer",
    { role: "developer", sizeBytes: 0 },
    vdir2,
  );
  assert(viewerText.includes("# developer"), "viewer text has the /runs renderTranscript header");
  assert(viewerText.includes("runId:   jobV"), "viewer text carries the run id");
  assert(viewerText.includes("tool calls: 1"), "viewer text reports the parsed tool-call count");
  assert(viewerText.includes("## final answer"), "viewer text has the final-answer section");
  assert(
    viewerText.includes("Found the overflow tests"),
    "viewer text includes the assistant prose",
  );
  assert(viewerText.includes("Press Esc to close"), "viewer text is the read-only viewer footer");

  const noFile = await buildViewerText("ghost", "ops", { role: "ops", sizeBytes: 0 }, vdir2);
  assert(
    noFile.includes("no transcript found"),
    "absent transcript degrades to the no-transcript note",
  );
  assert(noFile.includes("job ghost"), "no-transcript note names the job");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
