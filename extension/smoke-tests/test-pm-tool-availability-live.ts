#!/usr/bin/env bun
/**
 * LIVE PM-tool-availability smoke test (#591).
 *
 * Spawns a real Pi child with the pi-ensemble extension loaded (like a parent
 * PM session) and asserts that when `armPmMode()` fires, the active toolset
 * is stripped of `edit` and `write` via `setActiveTools()`.
 *
 * CI does NOT run this — live tests cost real tokens. Run manually when
 * verifying the PM tool-stripping implementation:
 *
 *   bun run smoke-tests/test-pm-tool-availability.ts
 *
 * What this catches:
 *   1. `setActiveTools()` is called with a list excluding `edit` + `write`
 *   2. All other built-in tools (`read`, `bash`, `grep`, `find`, `ls`) remain
 *   3. Extension tools (`dispatch_specialist`, `dispatch_parallel`, etc.)
 *      survive the `setActiveTools` REPLACE call
 *   4. `getActiveTools()` after armPmMode returns 0 tools that can write
 *
 * The fixture extension (fixtures/pm-tool-availability-fixture.ts) arms PM
 * mode on `agent_start` (mirroring armPmMode's setActiveTools call) and
 * captures the live toolset at two points: session-level capture and
 * tool-call-level capture. The test asserts the captured data.
 *
 * The child is spawned DIRECTLY (not via spawnSpecialist) because
 * spawnSpecialist is the subagent path — it uses `--no-extensions` and
 * only loads pi-ensemble in strict mode. This test needs a parent-shaped
 * child with pm-mode active.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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

type AnyEvent = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "pm-tool-availability-fixture.ts");
const extDir = path.resolve(here, "..");
const worktreeRoot = path.resolve(here, "..", "..");
const sessionDir = "/tmp/pi-ensemble-live-pm-tools";
mkdirSync(sessionDir, { recursive: true });
const sessionPath = path.join(sessionDir, `pm-tool-avail-${process.pid}-${Date.now()}.json`);

const prompt = [
  "You are running a deterministic smoke test.",
  '1. Call the tool `pm_tools_report` exactly once, with the parameter reason="availability-check".',
  "2. After the tool result arrives, reply with exactly one word: PONG.",
  "Do NOT call bash, read, or any other tool. Do NOT add any other text.",
].join("\n");

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

child.stdin?.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);

const start = Date.now();
const exitCode = await new Promise<number | null>((resolve) => {
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

// Parse stdout for events.
const stdoutEvents: AnyEvent[] = [];
for (const line of stdout.split("\n")) {
  if (!line.trim()) continue;
  try {
    stdoutEvents.push(JSON.parse(line));
  } catch {
    /* non-JSON line */
  }
}

// Read session transcript.
const raw = readFileSync(sessionPath, "utf8");
const events: AnyEvent[] = raw
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

console.log(`[test] session has ${events.length} events, stdout has ${stdoutEvents.length} events`);

// 0. Child exited cleanly.
assert(exitCode === 0, "child exit code is 0");

// 1. PM-mode capture entry from fixture (session-level, fired on agent_start).
const pmModeEvents = events.filter(
  (e) => e.type === "custom" && e.customType === "pm-tool-availability",
);
assert(
  pmModeEvents.length >= 1,
  `fixture captured pm-tool-availability entry (found ${pmModeEvents.length})`,
);

// 2. Tool-call capture entry (from pm_tools_report tool execution).
const captureEvents = events.filter(
  (e) => e.type === "custom" && e.customType === "pm-tool-availability-capture",
);
assert(
  captureEvents.length >= 1,
  `fixture captured tool-call-level toolset (found ${captureEvents.length})`,
);

// 3. Both captures should agree on the active toolset.
const sessionTools = pmModeEvents[0]?.data as { activeTools?: unknown } | undefined;
const capturedTools = captureEvents[0]?.data as { activeTools?: unknown } | undefined;
const sessionActive: string[] = Array.isArray(sessionTools?.activeTools)
  ? (sessionTools?.activeTools as string[])
  : [];
const captureActive: string[] = Array.isArray(capturedTools?.activeTools)
  ? (capturedTools?.activeTools as string[])
  : [];

assert(sessionActive.length > 0, "session-level capture has non-empty active toolset");
assert(captureActive.length > 0, "tool-call-level capture has non-empty active toolset");
assert(
  JSON.stringify(sessionActive.sort()) === JSON.stringify(captureActive.sort()),
  "session-level and tool-call-level captures agree on active toolset",
);

// 4. THE CORE ASSERTION: `edit` and `write` are NOT active after PM mode.
assert(!sessionActive.includes("edit"), "edit is NOT in active tools after armPmMode");
assert(!sessionActive.includes("write"), "write is NOT in active tools after armPmMode");

// 5. All other Pi defaults should remain active.
const REQUIRED_BUILTIN = ["read", "bash", "grep", "find", "ls"];
for (const tool of REQUIRED_BUILTIN) {
  assert(sessionActive.includes(tool), `built-in tool ${tool} remains active`);
}

// 6. Extension tools must survive the REPLACE call.
//    (These are the tools this extension registers; if setActiveTools
//    silently drops extension tools, we'd be unable to dispatch subagents.)
// The fixture's own test tool IS present — that's the primary check.
assert(
  sessionActive.includes("pm_tools_report"),
  "fixture-registered test tool is present (extension mechanism works)",
);

// Verify known extension tools survive the setActiveTools REPLACE.
const EXT_TOOLS_TO_CHECK = [
  "dispatch_specialist",
  "dispatch_parallel",
  "adversarial_loop",
  "start_work_driver",
  "check_review_cap",
];
for (const tool of EXT_TOOLS_TO_CHECK) {
  assert(sessionActive.includes(tool), `extension tool ${tool} survives setActiveTools REPLACE`);
}

// 7. Zero write-capable tools remain active.
const writeTools = ["edit", "write"];
const activeWriteTools = writeTools.filter((t) => sessionActive.includes(t));
assert(
  activeWriteTools.length === 0,
  `no write-capable tools active after PM mode (found: [${activeWriteTools.join(", ")}]`,
);

// 8. Tool execution events — verify the fixture tool was actually called.
const execStarts = stdoutEvents.filter((e) => e.type === "tool_execution_start");
assert(execStarts.length > 0, "at least one tool_execution_start event");
const pmToolExec = execStarts.find((e) => e.toolName === "pm_tools_report");
assert(pmToolExec !== undefined, "pm_tools_report was called");

const execEnds = stdoutEvents.filter((e) => e.type === "tool_execution_end");
assert(
  execEnds.some((e) => e.toolName === "pm_tools_report" && e.status === "ok"),
  "pm_tools_report executed with status ok",
);

// 9. PONG in the last assistant message.
const lastAssistant = [...events]
  .reverse()
  .find(
    (e) =>
      e.type === "message" && (e.message as { role?: string } | undefined)?.role === "assistant",
  );
const lastText =
  (lastAssistant?.message as { content?: Array<{ type?: string; text?: string }> })?.content?.find(
    (b) => b.type === "text",
  )?.text ?? "";
assert(
  lastText.toUpperCase().includes("PONG"),
  `last assistant text contains PONG (actual: "${lastText.slice(0, 60)}")`,
);

console.log(`\n[test] active tools (${sessionActive.length} total): ${sessionActive.join(", ")}`);
console.log(`\nexit ${exit}`);
process.exit(exit);
