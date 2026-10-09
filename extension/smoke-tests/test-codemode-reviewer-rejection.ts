#!/usr/bin/env bun
/**
 * LIVE codemode-reviewer-rejection smoke test (#1030 / epic #1026).
 *
 * Spawns TWO real Pi children shaped like reviewer-role subagents. The
 * reviewer child is what production actually gives a reviewer:
 *
 *   - Pi's DEFAULT tool set (read, bash, edit, write) — NO `--tools`
 *     restriction. This is the load-bearing difference from the test's
 *     earlier shape: `--tools codemode,…` would leave write/edit inactive
 *     on its own, so a pass would not prove `--exclude-tools` did anything.
 *     In a reviewer child, write/edit are ACTIVE by default and are
 *     removed ONLY by `--exclude-tools write,edit,multiedit`.
 *   - codemode activated the production way: `-e builtin:codemode` on the
 *     argv plus the companion `extension/src/child-guards.ts` via
 *     `--extension` (its `session_start` handler appends codemode to the
 *     active set — exactly what buildChildArgs / childArgsBase() produce).
 *   - the fixture `codemode-rejection-reporter` via a second `--extension`
 *     (roster capture + the `codemode_rejection_report` tool).
 *
 * Arms:
 *
 *   A. EXCLUSION ARM (the test body) — the child is told to call the
 *      codemode tool with a script that attempts `tools.write` /
 *      `tools.edit`, and to call NO other tool. The structural gate must
 *      hold:
 *
 *        1. Pre-script roster — the child's active toolset (captured by
 *           the fixture on `agent_start`) must NOT include `write`,
 *           `edit` or `multiedit` while `read` and `bash` ARE present
 *           (proof the child has the default tool set, i.e. the exclusion
 *           is the only thing standing between the model and write/edit).
 *
 *        2. Post-script roster — after the codemode script runs, the
 *           fixture re-reads `pi.getActiveTools()` via
 *           `codemode_rejection_report`; write/edit must be STILL absent
 *           (the rejected calls did not resurrect them).
 *
 *        3. No direct toolCall named write/edit/multiedit/bash in the
 *           session or the rpc stdout stream — bash is ACTIVE for this
 *           child (a real write path around the rejected tool), so a bash
 *           call would both break the prompt and be a write path; it
 *           fails the test, it is not counted as a pass.
 *
 *        4. No file was written — the sentinel path is checked from the
 *           test process via fs (the only write paths are the excluded
 *           write tool and bash, both asserted absent).
 *
 *   B. POSITIVE CONTROL (same file, second spawn) — identical argv
 *      EXCEPT without `--exclude-tools`. Here the same codemode script's
 *      `tools.write` MUST SUCCEED (sentinel created, then deleted by the
 *      test). If the control arm does not write the file, the whole test
 *      fails — a gate never observed to fail is worthless.
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
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
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
// The production companion that activates codemode on session_start for
// trust-mode children (child-guards.ts → enableChildCodemode). Loaded via
// --extension exactly as buildChildArgs() (childGuardsArgs) does — the
// test must not hard-code the path here; the source file is the single
// source of truth.
const childGuardsPath = path.resolve(here, "..", "src", "child-guards.ts");
const worktreeRoot = path.resolve(here, "..", "..");

// All scratch under one temp dir, removed in finally — the test must not
// leak session files or the sentinel across runs.
const workDir = path.join(os.tmpdir(), `pi-ensemble-codemode-reject-${process.pid}-${Date.now()}`);

// Build the reviewer-shaped child argv. Mirrors what buildChildArgs
// (childArgsBase + childGuardsArgs) produces for a reviewer role: default
// tool set, --exclude-tools write,edit,multiedit, -e builtin:mcp,
// -e builtin:codemode, the companion extension, and the fixture. Deliberate
// difference: NO --tools restriction — see the file header. The exclusion
// arm and the positive-control arm are identical except for --exclude-tools.
function childArgvFor(opts: { exclude: boolean; sessionPath: string }): string[] {
  const args = [
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    "builtin:mcp",
    "-e",
    "builtin:codemode",
    "--provider",
    liveProvider,
    "--model",
    liveModel,
    "--session",
    opts.sessionPath,
  ];
  if (opts.exclude) args.push("--exclude-tools", "write,edit,multiedit");
  args.push("--extension", childGuardsPath, "--extension", fixturePath);
  return args;
}

interface ArmResult {
  exitCode: number | null;
  spawnError: Error | null;
  stderr: string;
  stdoutEvents: AnyEvent[];
  events: AnyEvent[];
}

async function runArm(label: string, opts: { exclude: boolean; sessionPath: string }): Promise<ArmResult> {
  const childArgs = childArgvFor(opts);
  console.log(`[test] spawning ${label} child: pi ${childArgs.join(" ")}`);
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
  child.stdin?.write(`${JSON.stringify({ type: "prompt", message: armPrompt(opts.exclude) })}\n`);

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
  console.log(`[test] ${label} child exited in ${Date.now() - start}ms, code=${exitCode}`);

  if (spawnError) {
    console.error(`✗ failed to spawn pi (${label}): ${spawnError.message}`);
    process.exit(1);
  }

  if (stderr && stderr.length > 0) {
    console.log(`[test] ${label} child stderr (last 1000): ${stderr.slice(-1000)}`);
  }

  // Parse stdout for events (tool_execution_start/end are on the rpc
  // stream, not always in the session file).
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
    const raw = readFileSync(opts.sessionPath, "utf8");
    events = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch (err) {
    console.error(`✗ could not read session file (${label}): ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(
    `[test] ${label}: session has ${events.length} events, stdout has ${stdoutEvents.length} events`,
  );

  return { exitCode, spawnError: null, stderr, stdoutEvents, events };
}

// The codemode script body is identical in both arms — the ONLY
// difference between the arms is the --exclude-tools flag.
function armPrompt(exclude: boolean): string {
  const sentinelPath = path.join(workDir, "sentinel.txt");
  const lines = [
    "Follow EXACTLY, nothing else:",
    "1. Call the codemode tool exactly once with this raw JavaScript as its input (verbatim, no changes):",
    `    const w = await tools.write({path:'${sentinelPath}',content:'SENTINEL'}).catch(e=>'WRITE-REJECTED:'+String(e));`,
    `    const e = await tools.edit({path:'${sentinelPath}',oldText:'a',newText:'b'}).catch(e2=>'EDIT-REJECTED:'+String(e2));`,
    "    return { w, e };",
    "2. After the codemode result arrives, call the tool `codemode_rejection_report` exactly once, with the parameter outcome set to the JSON the codemode script returned (or the script's error text).",
    "3. Then reply with exactly one word: PONG.",
    "Do NOT call bash, read, edit, multiedit, or any other tool directly. Do NOT add any other text.",
  ];
  if (exclude) {
    lines.splice(
      7,
      0,
      "You have NO write or edit tool — they are excluded from your toolset. Do NOT try to call them.",
    );
  }
  return lines.join("\n");
}

// Every direct toolCall named write/edit/multiedit/bash in the session or
// the rpc stdout stream (the two surfaces where assistant toolCall blocks
// appear).
function directToolCalls(result: ArmResult): string[] {
  const names: string[] = [];
  for (const e of [...result.events, ...result.stdoutEvents]) {
    if (e.type !== "message") continue;
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (
        (b as { type?: string })?.type === "toolCall" &&
        ["write", "edit", "multiedit", "bash"].includes((b as { name?: string }).name ?? "")
      ) {
        names.push((b as { name?: string }).name as string);
      }
    }
  }
  return names;
}

try {
  // --- ARM A: the exclusion arm (the production reviewer shape) ---
  const excludeSessionPath = path.join(workDir, `exclude-${process.pid}.json`);
  const controlSessionPath = path.join(workDir, `control-${process.pid}.json`);

  const excludeResult = await runArm("exclusion", { exclude: true, sessionPath: excludeSessionPath });
  const sentinelExclude = path.join(workDir, "sentinel.txt");

  // 0. Child exited cleanly.
  assert(excludeResult.exitCode === 0, "[exclusion] child exit code is 0");

  // 1. Pre-script roster — captured by the fixture on agent_start, BEFORE
  //    the model has a chance to call codemode.
  const preEvents = excludeResult.events.filter(
    (e) => e.type === "custom" && e.customType === "codemode-reviewer-roster",
  );
  assert(preEvents.length >= 1, "[exclusion] fixture captured pre-script roster entry");
  const preData = preEvents[0]?.data as { tools?: unknown } | undefined;
  const preTools: string[] = Array.isArray(preData?.tools) ? (preData?.tools as string[]) : [];
  assert(preTools.length > 0, "[exclusion] pre-script roster is non-empty");

  // THE CORE ASSERTION 1: write/edit/multiedit are ABSENT from the active
  // set BEFORE any codemode script runs — the production reviewer property
  // (in this child the default tool set makes write/edit ACTIVE, so
  // --exclude-tools is the only thing removing them).
  assert(
    !preTools.includes("write"),
    "[exclusion] write ABSENT from active tools pre-script (--exclude-tools applied)",
  );
  assert(
    !preTools.includes("edit"),
    "[exclusion] edit ABSENT from active tools pre-script (--exclude-tools applied)",
  );
  assert(
    !preTools.includes("multiedit"),
    "[exclusion] multiedit ABSENT from active tools pre-script (--exclude-tools applied)",
  );
  // The child must actually have the DEFAULT tool set — if write/edit are
  // absent because --tools (or similar) stripped everything, the test
  // proves nothing. read and bash are the proof the default set is live.
  assert(preTools.includes("read"), "[exclusion] read PRESENT in active tools (default tool set live)");
  assert(
    preTools.includes("bash"),
    "[exclusion] bash PRESENT in active tools (default tool set live, only --exclude-tools applies)",
  );

  // 2. Post-script roster — captured by the fixture when the model calls
  //    codemode_rejection_report, AFTER the codemode script has run.
  const postEvents = excludeResult.events.filter(
    (e) => e.type === "custom" && e.customType === "codemode-reviewer-roster-post",
  );
  assert(postEvents.length >= 1, "[exclusion] fixture captured post-script roster entry");
  const postData = postEvents[0]?.data as { tools?: unknown } | undefined;
  const postTools: string[] = Array.isArray(postData?.tools) ? (postData?.tools as string[]) : [];
  assert(postTools.length > 0, "[exclusion] post-script roster is non-empty");

  // THE CORE ASSERTION 2: write/edit/multiedit are STILL ABSENT after the
  // codemode script ran. The script's rejected calls did not resurrect them.
  assert(
    !postTools.includes("write"),
    "[exclusion] write STILL ABSENT from active tools post-script (rejected call did not resurrect it)",
  );
  assert(
    !postTools.includes("edit"),
    "[exclusion] edit STILL ABSENT from active tools post-script (rejected call did not resurrect it)",
  );

  // 3. No direct toolCall named write/edit/multiedit/bash. bash is ACTIVE
  //    for this child (asserted above), so a direct bash call would be a
  //    real write path around the rejected tool — the prompt was not
  //    followed, and that is a test failure, not a pass.
  const excludeDirect = directToolCalls(excludeResult);
  assert(
    excludeDirect.length === 0,
    `[exclusion] NO direct toolCall named write/edit/multiedit/bash in session or stdout (actual: [${excludeDirect.join(", ")}])`,
  );

  // 4. No file was written. The codemode script attempted tools.write on
  //    the sentinel path; write was excluded, so the call rejected with
  //    "does not exist", and bash (the other write path) was never called
  //    (assertion 3). The host fs check is the ground truth.
  assert(
    !existsSync(sentinelExclude),
    `[exclusion] sentinel file NOT written (tools.write was rejected; path: ${sentinelExclude})`,
  );

  // 5. The codemode tool itself was called (proves the script actually ran
  //    and was not skipped).
  const codemodeExecs = excludeResult.stdoutEvents.filter(
    (e) => e.type === "tool_execution_start" && e.toolName === "codemode",
  );
  assert(codemodeExecs.length >= 1, "[exclusion] codemode tool was invoked (script actually ran)");

  // 6. The fixture report tool was called (proves the model completed the
  //    full flow: codemode → report).
  const reportExecs = excludeResult.stdoutEvents.filter(
    (e) => e.type === "tool_execution_start" && e.toolName === "codemode_rejection_report",
  );
  assert(
    reportExecs.length >= 1,
    "[exclusion] codemode_rejection_report tool was invoked (full flow completed)",
  );

  // 7. PONG in the last assistant message.
  const lastAssistant = [...excludeResult.events]
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
    `[exclusion] last assistant text contains PONG (actual: "${lastText.slice(0, 60)}")`,
  );

  console.log(`\n[test] [exclusion] pre-script tools (${preTools.length}): ${preTools.join(", ")}`);
  console.log(`[test] [exclusion] post-script tools (${postTools.length}): ${postTools.join(", ")}`);
  console.log(`[test] [exclusion] session: ${excludeSessionPath}`);

  // --- ARM B: positive control — same argv WITHOUT --exclude-tools ---
  // The same codemode script's tools.write must SUCCEED here: write is in
  // the default tool set and nothing removes it. If this arm does NOT
  // write the sentinel, the test cannot fail, and a gate that cannot
  // fail is worthless — fail the whole test.
  const controlResult = await runArm("control", { exclude: false, sessionPath: controlSessionPath });
  const sentinelControl = path.join(workDir, "sentinel.txt");

  assert(controlResult.exitCode === 0, "[control] child exit code is 0");

  // THE POSITIVE-CONTROL CORE: tools.write SUCCEEDED — the sentinel file
  // exists with the sentinel content. This proves the script's tools.write
  // call path works when write is active, so the exclusion arm's absence
  // of the file is the --exclude-tools flag working, not the script
  // failing silently.
  assert(
    existsSync(sentinelControl),
    `[control] tools.write SUCCEEDED and wrote the sentinel (proves the test can fail; path: ${sentinelControl})`,
  );
  if (existsSync(sentinelControl)) {
    const body = readFileSync(sentinelControl, "utf8");
    assert(
      body.includes("SENTINEL"),
      `[control] sentinel content is the script's SENTINEL string (actual: "${body.slice(0, 60)}")`,
    );
  }

  // The control arm's direct-write assertion is the mirror image: with
  // write active, the script wrote via tools.write (inside codemode), and
  // the model was still told not to call bash directly. If it called bash
  // anyway, the prompt was not followed — the same failure rule as the
  // exclusion arm, and it would also muddy the control's purpose.
  const controlDirect = directToolCalls(controlResult).filter((n) => n === "bash");
  assert(
    controlDirect.length === 0,
    `[control] NO direct bash toolCall in session or stdout (actual: [${controlDirect.join(", ")}])`,
  );

  console.log(`[test] [control] session: ${controlSessionPath}`);
} finally {
  // Clean up after itself: the temp dir (sessions, sentinels of both
  // arms) is removed unconditionally.
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort — the dir is under os.tmpdir() */
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
