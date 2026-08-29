#!/usr/bin/env bun
/**
 * LIVE Pi-version shape test (#7, widened by #319).
 *
 * Spawns a real Pi child (with the pi-ensemble extension loaded, like a
 * parent PM session) and asserts that the JSON event shape we depend on
 * (per AGENTS.md §4 "Pi compatibility (load-bearing)") is intact for the
 * currently-pinned Pi version. CI does NOT run this — live tests cost real
 * tokens. Run it manually after bumping `@earendil-works/pi-coding-agent`
 * in `extension/package.json`:
 *
 *   bun run smoke-tests/test-pi-shape-live.ts
 *
 * What this catches: Pi changes a field name (e.g., `tool_use` → `toolCall`,
 * which has happened), drops an event type (e.g., agent_end), restructures
 * usage stats, or silently drops extension-registered tools from the
 * child's live toolset (the #571 incident — provider-side deferred tool
 * loading omitted registered tools while the extension otherwise worked).
 *
 * Coverage:
 *   1. agent_end event exists and has `messages` array — load-bearing for
 *      --mode rpc done-detection (#152)
 *   2. message_end events with `message.role` and `message.usage`
 *      (input/output/cacheRead/cacheWrite are numbers) — load-bearing for
 *      progress reporting + cost accounting
 *   3. Content blocks include `type: "text"` AND `type: "toolCall"` with
 *      non-empty `id`, `name`, `arguments` — the #319 target
 *   4. `tool_execution_start` / `tool_execution_end` events with
 *      `toolName` + `args` — the second half of the tool-call surface
 *   5. Tool-roster integrity — the child's active toolset (the surface
 *      offered to the model, captured by the roster-reporter fixture via
 *      `pi.getActiveTools()`) contains every tool the extension registers
 *      (#571 detection gap). Registry presence is separately proven by the
 *      fact that the fixture's own registered tool is callable (3a/4).
 *   6. Assistant message has `model` field — used by collapseEvents
 *
 * Cost: one short child spawn (two assistant turns + one no-op tool call)
 * — roughly the same wall-clock/token envelope as the previous PONG-only
 * run. The fixture extension (fixtures/shape-live-roster-reporter.ts) is
 * loaded into the child via `--extension`; no extra spawn is needed.
 *
 * The child is spawned DIRECTLY (not via spawnSpecialist) because
 * spawnSpecialist is the subagent path — it uses `--no-extensions` and
 * only loads pi-ensemble in strict mode. The #571 incident was about the
 * PARENT session's toolset, so this test spawns a parent-shaped child:
 * `--no-extensions` (suppress auto-discovery) + explicit `--extension`
 * for pi-ensemble + the fixture.
 *
 * Roster source-of-truth: `EXPECTED_ROSTER` below is the single list the
 * assertion checks against, and a canary below fails the test if the
 * `pi.registerTool` sites in `extension/src` diverge from it.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Parsed JSON event from the session file or the rpc stdout stream.
// Loosely typed on purpose (the event shape IS what this test asserts);
// every field is narrowed at its assert site.
type AnyEvent = Record<string, unknown>;

// The single source of truth for the extension-registered tool roster.
// MUST stay in sync with the `name:` at each `pi.registerTool` site in
// extension/src (index.ts registers every tool except the lens
// companion extensions report_finding / report_policy, which are loaded
// into lens children, not this child). The canary at the end of this
// test fails if src registrations diverge from this list.
const EXPECTED_ROSTER = [
  "agents_md_run",
  "adversarial_loop",
  "check_review_cap",
  "dispatch_peek",
  "dispatch_parallel",
  "dispatch_lens_review",
  "dispatch_specialist",
  "dispatch_steer",
  "dispatch_kill",
  "dispatch_status",
  "load_workflow_doctrine",
  "start_work_driver",
] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "shape-live-roster-reporter.ts");
const extSrcDir = path.join(here, "..", "src");
const extDir = path.resolve(here, "..");
const worktreeRoot = path.resolve(here, "..", "..");
const sessionDir = "/tmp/pi-ensemble-live-shape";
mkdirSync(sessionDir, { recursive: true });
const sessionPath = path.join(sessionDir, `pi-shape-live-${process.pid}-${Date.now()}.json`);

const prompt = [
  "You are running a deterministic shape test. Follow EXACTLY:",
  '1. Call the tool `shape_roster_report` exactly once, with the parameter note="pong".',
  "2. After the tool result arrives, reply with exactly one word: PONG.",
  "Do NOT call bash, read, or any other tool. Do NOT add any other text.",
].join("\n");

// Build the child argv: parent-shaped (pi-ensemble + fixture loaded).
const childArgs = [
  "--mode",
  "rpc",
  "--no-extensions",
  "--session",
  sessionPath,
  "--extension",
  extDir,
  "--extension",
  fixturePath,
];

console.log(`[test] spawning child: pi ${childArgs.join(" ")}`);
const child = spawn("pi", childArgs, {
  cwd: worktreeRoot,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (d: Buffer) => {
  stdout += d.toString();
});
child.stderr?.on("data", (d: Buffer) => {
  stderr += d.toString();
});

// Send the prompt via stdin RPC.
child.stdin?.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);

const start = Date.now();
const exitCode = await new Promise<number | null>((resolve) => {
  // Close stdin after a short delay to signal "no more commands".
  // Pi exits cleanly after the agent_end for the current prompt.
  const closeTimer = setTimeout(() => {
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }
  }, 30_000);
  child.on("exit", (code) => {
    clearTimeout(closeTimer);
    resolve(code);
  });
  // Hard backstop: kill after 120s.
  const backstop = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, 120_000);
  child.on("exit", () => clearTimeout(backstop));
});

const ms = Date.now() - start;
console.log(`[test] child exited in ${ms}ms, code=${exitCode}`);

if (stderr && stderr.length > 0) {
  console.log(`[test] child stderr (last 1000): ${stderr.slice(-1000)}`);
}

// Parse stdout for events (tool_execution_start/end are emitted on stdout,
// not in the session file).
const stdoutEvents: AnyEvent[] = [];
for (const line of stdout.split("\n")) {
  if (!line.trim()) continue;
  try {
    stdoutEvents.push(JSON.parse(line));
  } catch {
    /* non-JSON line */
  }
}

// Read the session transcript.
const raw = readFileSync(sessionPath, "utf8");
const events: AnyEvent[] = raw
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

console.log(`[test] session has ${events.length} events, stdout has ${stdoutEvents.length} events`);

// 0. Child exited cleanly.
assert(exitCode === 0, "child exit code is 0");

// 1. agent_end shape — check both session and stdout.
const agentEnd =
  events.find((e) => e.type === "agent_end") ?? stdoutEvents.find((e) => e.type === "agent_end");
if (agentEnd) {
  const messages = agentEnd.messages;
  assert(Array.isArray(messages), "agent_end.messages is an array");
  assert(Array.isArray(messages) && messages.length > 0, "agent_end.messages is non-empty");
}

// 2. message_end with role/usage (session file).
const messageEnds = events.filter((e) => e.type === "message" || e.type === "message_end");
assert(messageEnds.length > 0, "at least one message event in session");

const assistantTurn = messageEnds.find(
  (e) => (e.message as { role?: string } | undefined)?.role === "assistant",
);
assert(assistantTurn !== undefined, "at least one assistant message present");

const msg = (assistantTurn?.message ?? {}) as {
  role?: string;
  model?: string;
  content?: Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
  }>;
  usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
};

assert(
  typeof msg.model === "string" && msg.model.length > 0,
  "assistant message has non-empty `model` field",
);
assert(typeof msg.usage === "object" && msg.usage !== null, "assistant message has `usage` object");
assert(typeof msg.usage?.input === "number", "usage.input is a number");
assert(typeof msg.usage?.output === "number", "usage.output is a number");
assert(typeof msg.usage?.cacheRead === "number", "usage.cacheRead is a number");
assert(typeof msg.usage?.cacheWrite === "number", "usage.cacheWrite is a number");

// 3. Content blocks — the first assistant turn carries the toolCall.
const content = msg.content ?? [];
assert(content.length > 0, "assistant message has at least one content block");

// 3a. toolCall block — the #319 target.
const toolCallBlocks = content.filter((b) => b.type === "toolCall");
assert(
  toolCallBlocks.length > 0,
  "at least one toolCall-type content block in the assistant message",
);
const toolCallBlock = toolCallBlocks[0];
assert(
  typeof toolCallBlock?.id === "string" && toolCallBlock.id.length > 0,
  "toolCall block has non-empty `id`",
);
assert(
  typeof toolCallBlock?.name === "string" && toolCallBlock.name.length > 0,
  `toolCall block has non-empty \`name\` (actual: ${JSON.stringify(toolCallBlock?.name)})`,
);
assert(
  toolCallBlock?.name === "shape_roster_report",
  `toolCall block names the fixture tool (actual: ${JSON.stringify(toolCallBlock?.name)})`,
);
const toolCallArgs = toolCallBlock?.arguments;
assert(
  typeof toolCallArgs === "object" &&
    toolCallArgs !== null &&
    Object.keys(toolCallArgs as object).length > 0,
  "toolCall block has non-empty `arguments` object",
);

// 3b. text block across all turns.
const anyTextBlock = messageEnds
  .map(
    (e) =>
      (e.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content,
  )
  .filter((c): c is Array<{ type?: string; text?: string }> => Array.isArray(c))
  .flat()
  .find((b) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0);
assert(anyTextBlock !== undefined, "at least one text-type content block across the session");

// 4. tool_execution_start / tool_execution_end — these are emitted on
//    stdout (rpc event stream). The session file may also carry them.
const execStarts = [
  ...stdoutEvents.filter((e) => e.type === "tool_execution_start"),
  ...events.filter((e) => e.type === "tool_execution_start"),
];
const execEnds = [
  ...stdoutEvents.filter((e) => e.type === "tool_execution_end"),
  ...events.filter((e) => e.type === "tool_execution_end"),
];

assert(execStarts.length > 0, "at least one tool_execution_start event");
const execStart = execStarts[0];
assert(
  typeof execStart?.toolName === "string" && execStart.toolName.length > 0,
  `tool_execution_start has non-empty \`toolName\` (actual: ${JSON.stringify(execStart?.toolName)})`,
);
assert(
  execStart?.toolName === "shape_roster_report",
  "tool_execution_start names the fixture tool",
);
const execStartArgs = execStart?.args;
assert(
  typeof execStartArgs === "object" &&
    execStartArgs !== null &&
    Object.keys(execStartArgs as object).length > 0,
  "tool_execution_start has non-empty `args` object",
);
assert(
  typeof execStart?.toolCallId === "string" && execStart.toolCallId.length > 0,
  "tool_execution_start has non-empty `toolCallId`",
);
assert(execEnds.length > 0, "at least one tool_execution_end event");
assert(
  execEnds.every(
    (e) =>
      typeof e.toolName === "string" &&
      (e.toolName as string).length > 0 &&
      typeof e.toolCallId === "string" &&
      (e.toolCallId as string).length > 0,
  ),
  "every tool_execution_end carries toolName + toolCallId",
);

// 5. Tool-roster integrity (#571 detection gap): the fixture extension
//    captured pi.getActiveTools() at agent_start into a session entry.
//    This is the surface offered to the model (agent.state.tools) — the
//    half of #571 the call-path assertions (3a/4) cannot see.
const rosterEvents = events.filter(
  (e) => e.type === "custom" && e.customType === "shape-live-roster",
);
assert(rosterEvents.length === 1, "exactly one shape-live-roster entry from the live child");
const rosterData = rosterEvents[0]?.data as { tools?: unknown } | undefined;
const liveTools: string[] = Array.isArray(rosterData?.tools) ? (rosterData?.tools as string[]) : [];
assert(liveTools.length > 0, "live child toolset is non-empty");

// The fixture's own tool must be present — if extension tools are being
// silently dropped (the #571 class), this is the first one to go.
assert(
  liveTools.includes("shape_roster_report"),
  "fixture-registered tool present in live child toolset (extension mechanism works)",
);

for (const tool of EXPECTED_ROSTER) {
  assert(
    liveTools.includes(tool),
    `extension-registered tool present in live child toolset: ${tool}`,
  );
}

// 5b. Canary: EXPECTED_ROSTER must match extension/src registrations.
const registered: string[] = [];
for (const file of readdirSync(extSrcDir)) {
  if (!file.endsWith(".ts")) continue;
  const body = readFileSync(path.join(extSrcDir, file), "utf8");
  if (!body.includes("registerTool(")) continue;
  for (const m of body.matchAll(/registerTool\(\s*\{[\s\S]*?name:\s*"([a-z][a-z0-9_]*)"/g)) {
    registered.push(m[1]);
  }
}
const COMPANION_TOOLS = new Set(["report_finding", "report_policy"]);
const expectedSet = new Set<string>([...EXPECTED_ROSTER, ...COMPANION_TOOLS]);
const registeredSet = new Set(registered);
const missingFromList = [...registeredSet].filter((n) => !expectedSet.has(n));
const missingFromSource = [...expectedSet].filter((n) => !registeredSet.has(n));
assert(
  missingFromList.length === 0 && missingFromSource.length === 0,
  `EXPECTED_ROSTER matches extension/src registrations (missing from list: [${missingFromList}], missing from source: [${missingFromSource}], source found: [${[...registeredSet].sort()}])`,
);

// 6. PONG in the last assistant message.
const lastAssistant = [...messageEnds]
  .reverse()
  .find((e) => (e.message as { role?: string } | undefined)?.role === "assistant");
const lastText =
  (lastAssistant?.message as { content?: Array<{ type?: string; text?: string }> })?.content?.find(
    (b) => b.type === "text",
  )?.text ?? "";
assert(
  lastText.toUpperCase().includes("PONG"),
  `last assistant text contains PONG (actual: "${lastText.slice(0, 60)}")`,
);

console.log(`\n[test] session: ${sessionPath}`);
console.log(`\nexit ${exit}`);
process.exit(exit);
