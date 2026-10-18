#!/usr/bin/env bun
/**
 * #1465 (P2 of #1567) — the call budget and call-kill (spawn-call-budget.ts).
 *
 * Unit half: the budget arithmetic (own `timeout N` + 2 min, else max(floor,
 * 3 × the longest same-command run)), `ps` parsing, and naming the call's
 * process group from a process table.
 *
 * Spawn half (fake `pi` on PATH, the test-cancel.ts pattern): a child whose
 * bash call is stuck has the CALL killed, not the child, and is steered; a
 * second stuck run of the same command ends the child with `stuck-tool`; a
 * stuck call whose process cannot be named ends the child; a call that keeps
 * emitting update bytes is never stuck; and an in-flight call is not ended by
 * stdout silence (the tool-inactivity bound it replaces).
 *
 * The fake child runs each "call" as `setsid sleep 600`, which makes it a
 * process-group leader under the child, the shape Pi's bash tool gives every
 * call (`detached: true`). Skipped without `setsid` (util-linux).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProgress, type InFlightCall, commandFingerprint } from "../src/child-progress.ts";
import type { PiJsonEvent } from "../src/pi-event-shapes.ts";
import {
  applyCallBudget,
  callBudgetMs,
  findCallGroup,
  ownTimeoutMs,
  parseEtime,
  parsePs,
} from "../src/spawn-call-budget.ts";
import { spawnSpecialist } from "../src/spawn.ts";
import type { DispatchResult } from "../src/types.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { withEnv } from "./lib/env-scope.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) failed++;
}

const MIN = 60_000;
const call = (args: unknown, startedAt = 0): InFlightCall => ({
  toolCallId: "c1",
  toolName: "bash",
  fingerprint: "fp",
  args,
  startedAt,
  lastUpdateAt: startedAt,
});

console.log("\n[unit] attribution");
{
  const stuck = { stuckKilled: () => true, killedBudgetMs: 5, stop: () => undefined };
  const r1 = { ok: true, killCause: "timeout" } as unknown as DispatchResult;
  applyCallBudget(stuck, r1);
  assert(
    r1.killCause === "stuck-tool" && r1.ok === false && r1.killBudgetMs === 5,
    "stuck-tool outranks the backstop",
  );
  const r2 = { ok: false, killCause: "loop" } as unknown as DispatchResult;
  applyCallBudget(stuck, r2);
  assert(r2.killCause === "loop", "a structural cap keeps its cause");
  const r3 = { ok: true } as unknown as DispatchResult;
  applyCallBudget({ ...stuck, stuckKilled: () => false }, r3);
  assert(r3.killCause === undefined && r3.ok, "no stuck end, no change");
  const cls = classifyFailureCause({ kind: "dispatch-failed", killCause: "stuck-tool" });
  assert(
    cls.cause === "self-killed:stuck-tool" && !cls.shouldRetry,
    "stuck-tool is a self-kill off the retry ladder (a fresh child re-runs the same command)",
  );
}

console.log("\n[unit] budget");
assert(callBudgetMs(call({ command: "bun test" }), 20 * MIN) === 20 * MIN, "no history: the floor");
assert(
  callBudgetMs(call({ command: "bun test" }), 20 * MIN, 10 * MIN) === 30 * MIN,
  "3 × the longest same-command run when that exceeds the floor",
);
assert(
  callBudgetMs(call({ command: "bun test" }), 20 * MIN, 5 * MIN) === 20 * MIN,
  "the floor when 3 × the longest run is below it",
);
assert(
  callBudgetMs(call({ command: "timeout 300 bun test" }), 20 * MIN, 30 * MIN) === 7 * MIN,
  "own `timeout 300` → 5 min + 2 min, whatever the history",
);
assert(ownTimeoutMs({ command: "cd x && timeout 2m make" }) === 2 * MIN, "`timeout 2m` after `&&`");
assert(ownTimeoutMs({ command: "gtimeout -k 5 90 make" }) === 90_000, "gtimeout with a flag");
assert(
  ownTimeoutMs({ command: "bun test", timeout: 60 }) === 60_000,
  "the bash tool's own `timeout` argument (seconds)",
);
assert(ownTimeoutMs({ command: "echo timeouts 5 x" }) === undefined, "`timeouts` is not `timeout`");
assert(ownTimeoutMs({ path: "a" }) === undefined, "no command, no timeout");
assert(
  ownTimeoutMs({ command: "sleep 1 && timeout 30 git fetch && ./run-suite" }) === undefined,
  "a `timeout` further in bounds only part of the command, not the call",
);
assert(
  ownTimeoutMs({ command: "CI=1 timeout 90 make" }) === 90_000,
  "env assignments before `timeout`",
);

console.log("\n[unit] ps parsing");
assert(parseEtime("05") === undefined, "a bare number is not an etime");
assert(parseEtime("01:05") === 65_000, "mm:ss");
assert(parseEtime("2-03:04:05") === ((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000, "dd-hh:mm:ss");
const rows = parsePs(
  [
    "  100     1   100    10:00 pi --mode rpc",
    "  200   100   200    00:42 bash -c bun test",
    "junk",
  ].join("\n"),
);
assert(rows.length === 2 && rows[1]?.args === "bash -c bun test", "rows parse, junk is dropped");

console.log("\n[unit] naming the call's group");
const now = 1_000_000;
const table = parsePs(
  [
    "100 1 100 10:00 pi --mode rpc", // the child
    "150 100 150 09:59 mcp-server", // detached at session start
    "200 100 200 00:42 bash -c bun test", // the call's shell
    "201 200 200 00:42 bun test", // its worker, same group
    "300 100 100 00:42 helper", // not a group leader
    "400 1 400 00:42 bash -c bun test", // not under the child
  ].join("\n"),
);
const started = now - 42_000;
assert(
  findCallGroup(table, 100, call({ command: "bun test" }, started), now) === 200,
  "the descendant group leader that started with the call",
);
assert(
  findCallGroup(table, 100, call({ command: "bun test" }, now - 5 * MIN), now) === undefined,
  "no leader started with the call: nothing is named",
);
const twin = parsePs(
  [
    "100 1 100 10:00 pi",
    "200 100 200 00:42 bash -c bun test",
    "210 100 210 00:42 bash -c make all",
  ].join("\n"),
);
assert(
  findCallGroup(twin, 100, call({ command: "make all" }, started), now) === 210,
  "two calls started together: the command text picks one",
);
assert(
  findCallGroup(twin, 100, call({ command: "cargo test" }, started), now) === undefined,
  "two candidates and no text match: nothing is killed",
);
const execd = parsePs(["100 1 100 10:00 pi", "200 100 200 00:42 grep a b f"].join("\n"));
const grepCall = call({ command: 'grep "a b" f' }, started);
assert(
  findCallGroup(execd, 100, grepCall, now) === 200,
  "a lone candidate whose argv lost the quotes (bash exec'd it) is the call's",
);
assert(
  findCallGroup(execd, 100, grepCall, now, 1) === undefined,
  "...but not while another bash call is in flight that could own it",
);
assert(
  findCallGroup(table, 100, { ...call({ command: "bun test" }, started), toolName: "mcp" }, now) ===
    undefined,
  "a non-bash call names no group (it never kills a sibling bash call's)",
);

console.log("\n[unit] killed calls and late starts (child-progress)");
{
  let t = 0;
  const p = new ChildProgress(() => t);
  const open = (id: string, type = "message_end") =>
    p.observe({
      type,
      toolCallId: id,
      toolName: "bash",
      args: { command: "x" },
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: { command: "x" } }],
      },
    } as unknown as PiJsonEvent);
  const close = (id: string) =>
    p.observe({
      type: "message_end",
      message: { role: "toolResult", toolCallId: id },
    } as unknown as PiJsonEvent);
  open("a");
  t = 5_000;
  open("a", "tool_execution_start");
  assert(
    p.inFlightCalls()[0]?.startedAt === 5_000,
    "a call starts when Pi executes it, not when it was asked for",
  );
  t = 7_000;
  close("a");
  const fp = commandFingerprint("bash", { command: "x" });
  assert(p.longestCompletedMs(fp) === 2_000, "its run is measured from that start");
  open("b");
  p.markKilled("b");
  t = 99_000;
  close("b");
  assert(
    p.longestCompletedMs(fp) === 2_000,
    "a call-killed call is not recorded as a run of the command",
  );
}

const hasSetsid = (() => {
  try {
    execFileSync("sh", ["-c", "command -v setsid"]);
    return true;
  } catch {
    return false;
  }
})();

const fakeDir = mkdtempSync(join(tmpdir(), "pi-ensemble-fake-pi-1465-"));
const stdinLog = join(fakeDir, "stdin.log");
function writeFakePi(body: string): void {
  if (existsSync(stdinLog)) rmSync(stdinLog);
  writeFileSync(
    join(fakeDir, "pi"),
    ["#!/bin/sh", "exec 3<&0", `cat <&3 > ${stdinLog} &`, body].join("\n"),
  );
  chmodSync(join(fakeDir, "pi"), 0o755);
}
const callEnd = (id: string, command: string) =>
  `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"${id}","name":"bash","arguments":{"command":"${command}"}}]}}'`;
const resultEnd = (id: string) =>
  `echo '{"type":"message_end","message":{"role":"toolResult","toolName":"bash","toolCallId":"${id}","content":[]}}'`;

const env = {
  PATH: `${fakeDir}:${process.env.PATH}`,
  // The `pi` on PATH is a shell script: no tokens (same opt-out as test-cancel.ts).
  PI_ENSEMBLE_ALLOW_LIVE_SPAWN: "1",
  PI_ENSEMBLE_SPAWN_TIMEOUT_MS: "120000",
  PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: "1500",
  PI_ENSEMBLE_CALL_BUDGET_MS: "1000",
  PI_ENSEMBLE_CALL_STALE_MS: "1000",
  PI_ENSEMBLE_DISPATCH_CAPS: "0",
};

try {
  await withEnv(env, async () => {
    if (!hasSetsid) {
      console.log("\n[spawn] SKIP: no setsid on this host");
      return;
    }
    console.log("\n[spawn] a stuck call is killed, then a second stuck run ends the child");
    writeFakePi(
      [
        callEnd("call_1", "sleep 600"),
        "setsid sleep 600 & wait $!",
        resultEnd("call_1"),
        callEnd("call_2", "sleep 600"),
        "setsid sleep 600 & wait $!",
        resultEnd("call_2"),
        "sleep 60",
      ].join("\n"),
    );
    const t0 = Date.now();
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    const steered = existsSync(stdinLog) ? readFileSync(stdinLog, "utf8") : "";
    assert(
      r.killCause === "stuck-tool",
      `second stuck run → stuck-tool (got ${r.killCause ?? "none"})`,
    );
    assert(r.ok === false, "a stuck-tool child is not ok");
    assert(
      /killed your tool call `sleep 600`/.test(steered),
      "the child was steered after the first call-kill",
    );
    assert(
      /call-kill: `sleep 600`/.test(r.text),
      "the call-kill is recorded in the child's stderr",
    );
    assert(
      r.killBudgetMs === 1000,
      `the killed first run does not inflate the second budget: still the floor (got ${r.killBudgetMs})`,
    );
    assert(
      Date.now() - t0 < 30_000,
      `ended well before the inactivity or backstop paths (${Date.now() - t0}ms)`,
    );

    console.log("\n[spawn] a stuck call whose process cannot be named ends the child");
    writeFakePi([callEnd("call_1", "sleep 600"), "sleep 600"].join("\n"));
    const r2 = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assert(
      r2.killCause === "stuck-tool",
      `unnamed process → stuck-tool (got ${r2.killCause ?? "none"})`,
    );
    assert(/could not be found/.test(r2.text), "the reason names the missing process");
  });

  await withEnv({ ...env, PI_ENSEMBLE_CALL_BUDGET_MS: "1000" }, async () => {
    console.log("\n[spawn] a call emitting new update bytes is never stuck");
    const updates = Array.from(
      { length: 12 },
      (_, i) =>
        `sleep 0.3; echo '{"type":"tool_execution_update","toolCallId":"call_1","partialResult":{"n":${i}}}'`,
    );
    writeFakePi([callEnd("call_1", "make"), ...updates, resultEnd("call_1")].join("\n"));
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assert(
      r.killCause === undefined,
      `a progressing call is not killed (got ${r.killCause ?? "none"})`,
    );
  });

  await withEnv({ ...env, PI_ENSEMBLE_CALL_BUDGET_MS: "60000" }, async () => {
    console.log("\n[spawn] silence with a call in flight is not a kill (tool-inactivity is gone)");
    writeFakePi([callEnd("call_1", "sleep 4"), "sleep 4", resultEnd("call_1")].join("\n"));
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assert(
      r.killCause === undefined,
      `in-flight silence past the 1.5s model-silence bound (got ${r.killCause ?? "none"})`,
    );

    console.log("\n[spawn] silence with nothing in flight is still the model-silence kill");
    writeFakePi([callEnd("call_1", "true"), resultEnd("call_1"), "sleep 30"].join("\n"));
    const r2 = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assert(
      r2.killCause === "inactivity",
      `post-result silence → inactivity (got ${r2.killCause ?? "none"})`,
    );
  });
} finally {
  rmSync(fakeDir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
