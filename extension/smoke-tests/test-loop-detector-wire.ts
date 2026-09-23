#!/usr/bin/env bun
/**
 * #772 — success-keyed counter WIRE fixtures (n)–(q).
 *
 * Moved verbatim from test-loop-detector.ts (file-size split): the
 * ingestEvent seam, toolResultFields extraction, the typed kill in the
 * dispatch report, and the #753 incident shape end-to-end through
 * createCapSession with a grace window.
 */

import { formatSingleReport } from "../src/async-jobs-report.ts";
import { SUCCESS_KILL_AT, SUCCESS_STEER_AT, createLoopDetector } from "../src/loop-detector.ts";
import type { PiContentBlock } from "../src/pi-event-shapes.ts";
import { emptyRunningState, ingestEvent, toolResultFields } from "../src/progress.ts";
import type { ToolResultObserver } from "../src/progress.ts";
import { capKillAttribution, createCapSession } from "../src/spawn-caps.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function tc(name: string, args: unknown, id?: string): PiContentBlock {
  return { type: "toolCall", id: id ?? "x", name, arguments: args };
}
function bash(command: string, id?: string): PiContentBlock {
  return tc("bash", JSON.stringify({ command }), id);
}
function read(path: string, id?: string): PiContentBlock {
  return tc("read", { path }, id);
}
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* (n) #772 — the WIRE: a synthetic agent transcript (assistant message_end
   + toolResult messages, in the exact shape the child's JSONL stream has —
   verified against real ensemble-runs transcripts) driven through the real
   ingestEvent seam. The success-keyed counter must fire through the seam
   that production uses: the detector only fires if ingestEvent's toolResult
   branch actually feeds toolResultObserver. Fails without the fix. */
{
  const det = createLoopDetector();
  const observed: Array<{ tool: string; id: string; text: string; error: boolean }> = [];
  const trObs: ToolResultObserver = (toolName, toolCallId, resultText, isError) => {
    const ev = det.observeToolResult(toolName, toolCallId, resultText, isError);
    observed.push({ tool: toolName, id: toolCallId, text: resultText, error: isError });
    if (ev) assert(ev.kind === "steer" || ev.kind === "kill", "#772(n): event flows from the seam");
  };
  const state = emptyRunningState("explore");
  const green = "All 4 tests passed in 0.9s";
  for (let i = 0; i < 8; i++) {
    const callId = `wire-${i}`;
    const asst = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: callId,
            name: "bash",
            arguments: '{"command":"bun run smoke-tests/test-a.ts"}',
          },
        ],
      },
    };
    ingestEvent(state, asst as never, 0, (blocks, turn) => det.observe(blocks, turn), trObs);
    const tr = {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: callId,
        content: [{ type: "text", text: green }],
        isError: false,
      },
    };
    ingestEvent(state, tr as never, 0, (blocks, turn) => det.observe(blocks, turn), trObs);
  }
  assert(state.turns === 8, "#772(n): 8 assistant turns ingested");
  assert(observed.length === 8, "#772(n): every toolResult reached the observer via ingestEvent");
  assert(
    observed.every((o) => o.text === green && !o.error),
    "#772(n): observer saw the identical green output",
  );
  // Count semantics: first green result seeds the counter (count 1), each
  // subsequent identical result increments. 8 re-issues → steer at 3, kill at 6,
  // both through the ingestEvent seam (the production path).
  const ev = det.current();
  assert(ev?.kind === "success", "#772(n): evidence is success-keyed");
  assert(ev?.count === 8, `#772(n): evidence count 8 (got ${ev?.count})`);
}

/* (o) #772 — toolResultFields: the extraction the success-keyed counter is
   fed. A toolResult message with toolName/toolCallId/content/isError is
   parsed into the observer's input; missing fields degrade safely. */
{
  const f = toolResultFields({
    toolName: "bash",
    toolCallId: "abc",
    content: [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
      { type: "image", text: "skip" },
    ],
    isError: false,
  });
  assert(f.toolName === "bash" && f.toolCallId === "abc", "#772(o): name + callId parsed");
  assert(f.resultText === "hello world", "#772(o): text blocks joined, non-text dropped");
  assert(f.isError === false, "#772(o): isError defaults false");
  const g = toolResultFields({ content: [{ type: "text", text: "boom" }], isError: true });
  assert(
    g.toolName === "unknown" && g.toolCallId === "",
    "#772(o): missing name/id degrade to unknown/empty",
  );
  assert(g.resultText === "boom" && g.isError === true, "#772(o): explicit error surfaced");
}

/* (p) #772 — the typed kill in the dispatch report: capKillAttribution
   carries loopEvidence with kind: "success", and formatSingleReport's
   headline says "repeated an already-successful command" — NOT the generic
   "loop detected" and NOT a timeout. Fails without the fix (the seam
   dropped `kind`, so the headline fell back to the generic wording). */
{
  const killedSigs: string[] = [];
  const child = { killed: killedSigs, kill: (sig: string) => killedSigs.push(sig) } as never;
  const s = createCapSession({
    role: "developer",
    child,
    onSteer: () => {},
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 0,
    childExited: () => false,
  });
  const green = "All tests passed";
  // 6 identical green re-issues through the session's observer → success-kill.
  for (let i = 0; i < 6; i++) {
    const callId = `p-${i}`;
    s.loopObserver?.([bash("bun test", callId)], i);
    s.toolResultObserver?.("bash", callId, green, false);
  }
  assert(s.loopKilled(), "#772(p): success-keyed kill fires through the CapSession seam");
  const result: DispatchResult = {
    role: "developer",
    ok: true,
    text: "",
    toolUses: [],
    ms: 10,
    exitCode: 0,
  };
  const stdErrLines: string[] = [];
  capKillAttribution(s, { role: "developer" }, 0, (l) => stdErrLines.push(l), result);
  assert(result.killCause === "loop", "#772(p): killCause is loop (never a generic timeout)");
  assert(result.loopEvidence?.kind === "success", "#772(p): loopEvidence carries kind:success");
  assert(
    stdErrLines.some((l) => l.includes("already-successful")),
    "#772(p): stderr line names the already-successful shape",
  );
  const report = formatSingleReport("jp", "developer", result);
  assert(
    report.includes("repeated an already-successful command"),
    "#772(p): report headline names the already-successful shape",
  );
  assert(!report.includes("wall-clock timeout"), "#772(p): NOT reported as a timeout");
  assert(
    !report.includes("FAILED (self-killed: loop detected)"),
    "#772(p): not the generic loop headline",
  );
  s.cleanup();
  // A streak-keyed kill keeps the generic headline (the distinction is real).
  const killedSigs2: string[] = [];
  const child2 = { killed: killedSigs2, kill: (sig: string) => killedSigs2.push(sig) } as never;
  const s2 = createCapSession({
    role: "developer",
    child2,
    onSteer: () => {},
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 0,
    childExited: () => false,
  });
  for (let i = 0; i < 10; i++) s2.loopObserver?.([bash('rg "x" src/')], i);
  const r2: DispatchResult = {
    role: "developer",
    ok: true,
    text: "",
    toolUses: [],
    ms: 10,
    exitCode: 0,
  };
  capKillAttribution(s2, { role: "developer" }, 0, () => {}, r2);
  assert(
    r2.killCause === "loop" && r2.loopEvidence?.kind === "streak",
    "#772(p): streak kill keeps kind:streak",
  );
  assert(
    formatSingleReport("jq", "developer", r2).includes("loop detected"),
    "#772(p): streak kill uses the generic headline",
  );
  s2.cleanup();
}

/* (q) #772 — the #753 incident shape end-to-end through createCapSession
   with a grace window: the green test re-issued non-adjacently (reads
   interleaved), the success steer fires ONCE at 3, the kill arms at 6, and
   the grace window defers the kill (the child gets its report window).

   Moved verbatim from test-loop-detector.ts (file-size split); the only
   change here is the top-level await this file now needs (the original's
   `s!` non-null assertions became optional chains under biome). */
async function fixture772q(): Promise<void> {
  const killedSigs: string[] = [];
  const child = { killed: killedSigs, kill: (sig: string) => killedSigs.push(sig) } as never;
  let s: ReturnType<typeof createCapSession>;
  const steers: Array<{ msg: string; src: string }> = [];
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "2000" }, () => {
    s = createCapSession({
      role: "explore",
      child,
      onSteer: (m, src) => steers.push({ msg: m, src: String(src) }),
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 2000,
      childExited: () => false,
    });
  });
  const green = "All 5 tests passed in 1.2s";
  let steeredAt: number | null = null;
  let armedAt: number | null = null;
  for (let i = 0; i < 6; i++) {
    const callId = `q-${i}`;
    s.loopObserver?.([bash("bun run smoke-tests/test-a.ts", callId)], i * 2);
    const before = s.loopArmedFingerprint();
    s.toolResultObserver?.("bash", callId, green, false);
    if (!before && s.loopArmedFingerprint() && armedAt === null) armedAt = i;
    if (i < 5) s.loopObserver?.([read(`src/file${i}.ts`, `q-r${i}`)], i * 2 + 1);
    if (steeredAt === null && steers.length > 0) steeredAt = i;
  }
  assert(
    steeredAt === SUCCESS_STEER_AT - 1,
    `#772(q): success steer fired on re-issue #${SUCCESS_STEER_AT} (got #${(steeredAt ?? -1) + 1})`,
  );
  assert(steers.length === 1, "#772(q): exactly one steer (the report-demanding one)");
  assert(
    steers[0]?.src === "driver-success-keyed",
    "#772(q): steer tagged driver-success-keyed (distinct from the streak source)",
  );
  assert(
    armedAt === SUCCESS_KILL_AT - 1,
    `#772(q): kill armed on re-issue #${SUCCESS_KILL_AT} (got #${(armedAt ?? -1) + 1})`,
  );
  assert(!s.loopKilled(), "#772(q): kill deferred — grace window open (the report window)");
  await new Promise((r) => setTimeout(r, 2400));
  assert(s.loopKilled(), "#772(q): kill fires after the grace window");
  assert(s.killCause() === "loop", "#772(q): killCause loop");
  assert(s.loopEvidence()?.kind === "success", "#772(q): evidence kind success at kill");
  s?.cleanup();
}
await fixture772q();

/* (r) #772 R1 — the grace deferral is keyed on a DISTINCT fingerprint, not
   on any message_end. The #753 shape the ticket describes is a child that
   keeps re-issuing the looping command (each a new message_end). If the
   deferral re-armed on every message_end, such a child would reset the grace
   clock indefinitely and the kill would never fire — the "chance to report"
   that in practice becomes "the loop runs forever" (fixture (q) passes only
   because its scripted stream STOPS after re-issue #6; a realistic looping
   child does not). Distinct calls still re-arm (the #296 shape the deferral
   exists for). */
async function fixture772r(): Promise<void> {
  const child = { kill: (_sig: string) => {} } as never;
  let s: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "2000" }, async () => {
    s = createCapSession({
      role: "developer",
      child,
      onSteer: () => {},
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 2000,
      childExited: () => false,
    });
    // 10 identical re-issues → streak kill arms at the 10th.
    for (let i = 0; i < 10; i++) s?.loopObserver?.([bash("git status --porcelain", `r-${i}`)], i);
    assert(s?.loopArmedFingerprint() !== undefined, "#772(r): kill armed at 10 repeats");
    // The #753 shape: the child keeps re-issuing the SAME looping command.
    // Each is a new message_end, but none is distinct — the grace clock must
    // NOT reset, so the kill fires when the 2s window elapses.
    for (let i = 10; i < 16; i++) s?.loopObserver?.([bash("git status --porcelain", `r-${i}`)], i);
    await new Promise((r) => setTimeout(r, 2600));
    assert(s?.loopKilled(), "#772(r): repeats of the looping command do NOT defer the kill");
    assert(s?.killCause() === "loop", "#772(r): killCause loop after the window");
    s?.cleanup();
  });
  // Distinct fingerprint re-arms: the loop ended, the kill would discard new
  // work — the #296 shape the deferral exists for.
  const child2 = { kill: (_sig: string) => {} } as never;
  let s2: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "30000" }, async () => {
    s2 = createCapSession({
      role: "developer",
      child: child2,
      onSteer: () => {},
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 30_000,
      childExited: () => false,
    });
    for (let i = 0; i < 10; i++) s2?.loopObserver?.([bash("git status --porcelain", `r2-${i}`)], i);
    // A distinct call arrives after arming (the loop ended).
    s2?.loopObserver?.([bash("cargo test", "r2-d")], 10);
    // 2600ms < the 30s window: without the reset the kill would have fired.
    await new Promise((r) => setTimeout(r, 2600));
    assert(!s2?.loopKilled(), "#772(r): a DISTINCT message_end re-arms the grace window");
    s2?.cleanup();
  });
}
await fixture772r();

/* (s) #772 — the PRODUCTION seam: the success-keyed counter must fire when
   a fake child emits the #753 shape (assistant message_end + toolResult
   lines, the exact JSONL shape of a real Pi child — verified against real
   ensemble-runs transcripts) through spawnSpecialist's real line handler.
   Fixtures (n)-(q) hand-wire the observer into ingestEvent/createCapSession,
   which proves the components accept the wiring but not that spawn.ts
   passes it. This test drives the actual production call site: a missing
   5th argument to ingestEvent in spawn.ts makes the counter inert and this
   fails — the #821/#814 "test checks a copy of the logic" class the repo
   has shipped before. Grace=0 so the kill is immediate; the child is
   SIGTERM'd and the kill carries the typed success evidence. */
{
  const { chmodSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSpecialist } = await import("../src/spawn.ts");
  const fakeDir = mkdtempSync(join(tmpdir(), "pi-ensemble-fake-pi-772-"));
  const savedPath = process.env.PATH;
  const savedInactivity = process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS;
  const savedGrace = process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS;
  // A fake `pi` that emits the #753 shape: six identical bash tool calls,
  // each returning the same green output, then a text-only turn (the
  // "report" the child was steered to write). The lines are the raw JSONL
  // the real line handler parses (type "message", message.role
  // "assistant"/"toolResult" — Pi emits tool results as their own message
  // role; spawn's type guard lets the shape through).
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `s-${i}`,
              name: "bash",
              arguments: '{"command":"bun run smoke-tests/test-a.ts"}',
            },
          ],
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: `s-${i}`,
          content: [{ type: "text", text: "All 5 tests passed in 1.2s" }],
          isError: false,
        },
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
  );
  writeFileSync(
    join(fakeDir, "pi"),
    ["#!/bin/sh", ...lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`)].join("\n"),
  );
  chmodSync(join(fakeDir, "pi"), 0o755);
  process.env.PATH = `${fakeDir}:${savedPath}`;
  process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "0";
  process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = "0";
  try {
    const r = await spawnSpecialist({ role: "explore", prompt: "x" }, { timeoutMs: 30_000 });
    assert(
      r.killCause === "loop",
      `#772(s): production seam kills the #753 shape (got ${r.killCause ?? "none"})`,
    );
    assert(
      r.loopEvidence?.kind === "success",
      `#772(s): kill evidence is the success-keyed counter (got ${JSON.stringify(r.loopEvidence)})`,
    );
    assert(
      r.loopEvidence?.count === 6,
      `#772(s): counter ran to the kill threshold (got ${r.loopEvidence?.count})`,
    );
  } finally {
    process.env.PATH = savedPath ?? "";
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = savedInactivity ?? "";
    process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = savedGrace ?? "";
  }
}

/* (w6) #772 R3 — a SUCCESS-keyed kill armed from the toolResult feed must
   NOT have its grace window re-armed by later message_end traffic. The
   #753-shape child keeps re-issuing the looping command (each a new
   message_end with a DISTINCT fingerprint because the call args differ
   slightly — e.g. a path that changes). The re-key in loopObserver only
   applies to STREAK-armed kills; a success-armed kill must fire after
   graceMs regardless of the re-issuing traffic. */
async function fixture772w6(): Promise<void> {
  const child = { kill: (_sig: string) => {} } as never;
  let s: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "2000" }, async () => {
    s = createCapSession({
      role: "developer",
      child,
      onSteer: () => {},
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 2000,
      childExited: () => false,
    });
    const green = "All tests passed";
    // Arm a success-keyed kill: 6 identical green results through the
    // toolResult feed (each a distinct call id but identical fingerprint).
    for (let i = 0; i < 6; i++) {
      const callId = `w6-${i}`;
      s.loopObserver?.([bash("bun test", callId)], i * 2);
      s.toolResultObserver?.("bash", callId, green, false);
    }
    assert(s.loopArmedFingerprint() !== undefined, "#772(w6): success kill armed");
    assert(!s.loopKilled(), "#772(w6): kill deferred — grace window open");
    // The #753-shape traffic: the child keeps re-issuing the command, each
    // with a DISTINCT fingerprint (a changing path). Under the old code
    // (re-arm on any distinct message_end) the grace clock would reset
    // indefinitely and the kill would never fire. Under the fix, the
    // success-armed kill is immune to this traffic.
    for (let i = 6; i < 14; i++) {
      s.loopObserver?.([bash(`bun test --filter=case-${i}`, `w6-d${i}`)], i * 2);
    }
    await new Promise((r) => setTimeout(r, 2400));
    assert(s.loopKilled(), "#772(w6): success-armed kill fires after grace (NOT re-armed by re-issuing traffic)");
    assert(s.killCause() === "loop", "#772(w6): killCause loop");
    assert(s.loopEvidence()?.kind === "success", "#772(w6): evidence kind success at kill");
    s?.cleanup();
  });
}
await fixture772w6();

console.log(`\nexit ${exit}`);
process.exit(exit);
