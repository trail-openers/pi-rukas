#!/usr/bin/env bun
/**
 * LIVE codemode-reviewer-rejection smoke test (#1030 / epic #1026).
 *
 * Spawns a real Pi child shaped like a reviewer-role subagent (write/edit/
 * multiedit excluded via `--exclude-tools`, codemode enabled via
 * `-e builtin:codemode`) and proves the structural write-gate holds even
 * when codemode scripts are in play:
 *
 *   1. Pre-script roster — the child's active toolset (captured by the
 *      fixture on `agent_start`) must NOT include `write` or `edit`. The
 *      `--exclude-tools write,edit,multiedit` applied to the reviewer role
 *      has already stripped them from the live surface BEFORE any codemode
 *      script runs.
 *
 *   2. Post-script rejection — the child is told to call the codemode tool
 *      with a script that attempts `tools.write` / `tools.edit`. The
 *      sandbox rejects the calls (excluded tools are not in the registry,
 *      so they cannot be reached from scripts), and the child reports the
 *      rejection via the fixture's `codemode_rejection_report` tool. The
 *      fixture re-reads `pi.getActiveTools()` at that later point and
 *      writes it to the session. The test asserts `write` / `edit` are
 *      STILL absent — the rejected calls did not resurrect them.
 *
 *   3. No file was written — the sentinel path is checked from the test
 *      process via fs (the child's sandbox cannot touch the host fs
 *      directly; the only write path is the `write` tool, which was
 *      rejected).
 *
 * CI does NOT run this — live tests cost real tokens. Run manually after
 * the codemode argv change (task-a) lands, or to verify the structural
 * gate after any `--exclude-tools` / codemode change:
 *
 *   bun run smoke-tests/test-codemode-reviewer-rejection.ts
 *
 * Provider/model are read from `PI_ENSEMBLE_LIVE_PROVIDER` /
 * `PI_ENSEMBLE_LIVE_MODEL` env (default: `trailopeners-h100` /
 * `RedHatAI/Qwen3.8-27B-INT4`, the host's configured subagent model from
 * ~/.pi/agent/ensemble-models.json). Live tests are excluded from the
 * offline pre-push gate (PI_ENSEMBLE_FORBID_LIVE_SPAWN=1), so the model
 * does not need to be the production one.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function skip(msg: string): never {
  console.log(`⊘ LIVE skipped: ${msg}`);
  process.exit(0);
}

// Offline gate guard: when PI_ENSEMBLE_FORBID_LIVE_SPAWN=1 (set by
// verify-loop.sh for every offline test), skip without failing. The test
// does not end in `-live.ts` (the issue specifies the exact name), so it
// is not excluded by the suffix convention — the guard is the exclusion
// mechanism instead. Run manually with PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1.
if (process.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN === "1") {
  skip("offline gate active (PI_ENSEMBLE_FORBID_LIVE_SPAWN=1)");
}
if (process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN !== "1") {
  skip("set PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1 to spawn a real child");
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Parsed JSON event from the session file or the rpc stdout stream.
type AnyEvent = Record<string, unknown>;

// Provider/model for the live child. Read from env so the test works
// regardless of which model the host has quota for; defaults to the
// trailopeners-h100 model that the host's ensemble-models.json already
// configures for all subagents.
const liveProvider = process.env.PI_ENSEMBLE_LIVE_PROVIDER ?? "trailopeners-h100";
const liveModel = process.env.PI_ENSEMBLE_LIVE_MODEL ?? "RedHatAI/Qwen3.8-27B-INT4";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "codemode-reviewer-rejection-fixture.ts");
const worktreeRoot = path.resolve(here, "..", "..");
const sessionDir = "/tmp/pi-ensemble-live-shape";
mkdirSync(sessionDir, { recursive: true });
const sessionPath = path.join(sessionDir, `codemode-reject-${process.pid}-${Date.now()}.json`);

// Sentinel file the codemode script tries to write. Must NOT exist after
// the child runs — the `write` tool was excluded, so the script's
// `tools.write` call rejects with "does not exist" and no file is created.
const sentinelDir = "/tmp/pi-ensemble-codemode-rejection";
const sentinelPath = path.join(sentinelDir, "sentinel.txt");
mkdirSync(sentinelDir, { recursive: true });
if (existsSync(sentinelPath)) rmSync(sentinelPath);

const prompt = [
  "Follow EXACTLY, nothing else:",
  "1. Call the codemode tool exactly once with this raw JavaScript as its input (verbatim, no changes):",
  "    const w = await tools.write({path:'/tmp/pi-ensemble-codemode-rejection/sentinel.txt',content:'SENTINEL'}).catch(e=>'WRITE-REJECTED:'+String(e));",
  "    const e = await tools.edit({path:'/tmp/pi-ensemble-codemode-rejection/sentinel.txt',oldText:'a',newText:'b'}).catch(e2=>'EDIT-REJECTED:'+String(e2));",
  "    return { w, e };",
  "2. After the codemode result arrives, call the tool `codemode_rejection_report` exactly once, with the parameter outcome set to the JSON the codemode script returned (or the script's error text).",
  "3. Then reply with exactly one word: PONG.",
  "You have ONLY two tools available: `codemode` and `codemode_rejection_report`. Do NOT try to call bash, read, write, edit, or any other tool — they are not in your toolset. Do NOT add any other text.",
].join("\n");

// Build the child argv: reviewer-role shaped (write/edit/multiedit excluded,
// codemode enabled, and the active set restricted to ONLY codemode + the
// fixture tool via --tools). The --tools restriction is load-bearing: it
// removes the model's own bash/read/write/edit from the active set, so the
// ONLY path to the sentinel file is through the codemode script's
// tools.write — which is what we are proving gets rejected. This mirrors
// what spawnSpecialist produces for a reviewer role once the codemode argv
// change (task-a) lands: childArgsBase() + -e builtin:codemode +
// --exclude-tools write,edit,multiedit + the companion extension. The
// --tools restriction is a test-only addition (production does not
// restrict to codemode+fixture; it relies on the role's exclude list).
const childArgs = [
  "--mode",
  "rpc",
  "--no-extensions",
  "-e",
  "builtin:mcp",
  "-e",
  "builtin:codemode",
  "--tools",
  "codemode,codemode_rejection_report",
  "--provider",
  liveProvider,
  "--model",
  liveModel,
  "--session",
  sessionPath,
  "--exclude-tools",
  "write,edit,multiedit",
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

// A missing `pi` binary would otherwise hang the whole test until the
// backstop fires; fail fast with the spawn error instead.
let spawnError: Error | null = null;
child.on("error", (err) => {
  spawnError = err;
});

// Send the prompt via stdin RPC.
child.stdin?.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);

const start = Date.now();
const exitCode = await new Promise<number | null>((resolve) => {
  const closeTimer = setTimeout(() => {
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }
  }, 50_000);
  child.on("exit", (code) => {
    clearTimeout(closeTimer);
    resolve(code);
  });
  const backstop = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, 140_000);
  child.on("exit", () => clearTimeout(backstop));
});

const ms = Date.now() - start;
console.log(`[test] child exited in ${ms}ms, code=${exitCode}`);

// A missing `pi` binary would otherwise hang the whole test until the
// backstop fires; fail fast with the spawn error instead.
if (spawnError) {
  console.error(`✗ failed to spawn pi: ${spawnError.message}`);
  process.exit(1);
}

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

// Read the session transcript.
let events: AnyEvent[] = [];
try {
  const raw = readFileSync(sessionPath, "utf8");
  events = raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
} catch (err) {
  console.error(`✗ could not read session file: ${(err as Error).message}`);
  process.exit(1);
}

console.log(`[test] session has ${events.length} events, stdout has ${stdoutEvents.length} events`);

// 0. Child exited cleanly.
assert(exitCode === 0, "child exit code is 0");

// 1. Pre-script roster — captured by the fixture on agent_start, BEFORE the
//    model has a chance to call codemode.
const preEvents = events.filter(
  (e) => e.type === "custom" && e.customType === "codemode-reviewer-roster",
);
assert(preEvents.length >= 1, "fixture captured pre-script roster entry");
const preData = preEvents[0]?.data as { tools?: unknown } | undefined;
const preTools: string[] = Array.isArray(preData?.tools) ? (preData?.tools as string[]) : [];
assert(preTools.length > 0, "pre-script roster is non-empty");

// THE CORE ASSERTION 1: write/edit/multiedit are ABSENT from the active
// set BEFORE any codemode script runs. This proves the --exclude-tools
// flag applied to the reviewer role has stripped them from the live
// surface — the same surface codemode scripts see via tools.*.
assert(!preTools.includes("write"), "write ABSENT from active tools pre-script (--exclude-tools applied)");
assert(!preTools.includes("edit"), "edit ABSENT from active tools pre-script (--exclude-tools applied)");
assert(
  !preTools.includes("multiedit"),
  "multiedit ABSENT from active tools pre-script (--exclude-tools applied)",
);

// 2. Post-script roster — captured by the fixture when the model calls
//    codemode_rejection_report, AFTER the codemode script has run.
const postEvents = events.filter(
  (e) => e.type === "custom" && e.customType === "codemode-reviewer-roster-post",
);
assert(postEvents.length >= 1, "fixture captured post-script roster entry");
const postData = postEvents[0]?.data as { tools?: unknown } | undefined;
const postTools: string[] = Array.isArray(postData?.tools) ? (postData?.tools as string[]) : [];
assert(postTools.length > 0, "post-script roster is non-empty");

// THE CORE ASSERTION 2: write/edit/multiedit are STILL ABSENT after the
// codemode script ran. The script's rejected calls did not resurrect them.
assert(
  !postTools.includes("write"),
  "write STILL ABSENT from active tools post-script (rejected call did not resurrect it)",
);
assert(
  !postTools.includes("edit"),
  "edit STILL ABSENT from active tools post-script (rejected call did not resurrect it)",
);

// 3. No file was written. The codemode script attempted tools.write on the
//    sentinel path; because write was excluded, the call rejected with
//    "does not exist" and no file was created. The host fs check is the
//    ground truth — the sandbox cannot touch the host directly, so the
//    only write path was the (rejected) write tool.
assert(
  !existsSync(sentinelPath),
  `sentinel file NOT written (tools.write was rejected; path: ${sentinelPath})`,
);

// 4. The codemode tool itself was called (proves the script actually ran
//    and was not skipped).
const codemodeExecs = stdoutEvents.filter(
  (e) => e.type === "tool_execution_start" && e.toolName === "codemode",
);
assert(codemodeExecs.length >= 1, "codemode tool was invoked (script actually ran)");

// 5. The fixture report tool was called (proves the model completed the
//    full flow: codemode → report).
const reportExecs = stdoutEvents.filter(
  (e) => e.type === "tool_execution_start" && e.toolName === "codemode_rejection_report",
);
assert(reportExecs.length >= 1, "codemode_rejection_report tool was invoked (full flow completed)");

// 6. PONG in the last assistant message.
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

console.log(`\n[test] pre-script tools (${preTools.length}): ${preTools.join(", ")}`);
console.log(`[test] post-script tools (${postTools.length}): ${postTools.join(", ")}`);
console.log(`\n[test] session: ${sessionPath}`);
console.log(`\nexit ${exit}`);
process.exit(exit);
