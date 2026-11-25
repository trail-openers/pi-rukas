#!/usr/bin/env bun
/**
 * The beat on the HOST's line stream. The pump writes through `persistCycle`,
 * and the host's NDJSON lines are produced by the emit sink behind that persist
 * (`work-state-emit.ts`), whose watermark fingerprints on `index|kind|at`. A
 * run carrying beats must therefore emit each of them exactly once, in order,
 * with no re-emission of the bracket — and each must render in `/work-status`
 * with its own elapsed, because that line is what tells an operator the gate is
 * healthy rather than stalled.
 *
 * A beat held in memory emits zero lines, which is how an earlier periodic watch
 * here passed while doing nothing: every assertion below runs against the REAL
 * emit sink and the real persist.
 *
 * Run: bun smoke-tests/test-verify-heartbeat-stream.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ctxFor, installVerifyCmd, makeExec, stateFor } from "./lib/consolidated-verify-exec.ts";
import { fixture } from "./lib/consolidated-verify-fixture.ts";
import { appendEvent, persistCycle } from "../src/workflow-state.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import { fmtEvent } from "../src/work-status-events.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const T0 = 1_700_000_000_000;
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-2625-stream-"));

try {
  const f = await fixture(root, "host-lines", ["default"]);
  installVerifyCmd(f.repo, "never-written.txt");
  const emitted: Parameters<ReturnType<typeof createEmitSink>["emit"]>[0][] = [];
  const ctx = {
    ...ctxFor(f.repo, 2629, makeExec({ runs: [], repoRoot: f.repo })),
    emitSink: createEmitSink((e) => emitted.push(e)),
  } as unknown as { repoRoot: string; emitSink: ReturnType<typeof createEmitSink> };

  const started = {
    kind: "verify-started" as const,
    at: T0,
    step: "develop" as const,
    command: "bash scripts/verify.sh",
    target: { kind: "consolidated" as const },
  };
  const beat = (at: number, elapsedSeconds: number) => ({
    kind: "verify-heartbeat" as const,
    at,
    step: "develop" as const,
    command: started.command,
    elapsedSeconds,
  });

  let state = stateFor(f, 2629);
  // One persist carrying the whole run: the log is what the sink replays, so a
  // beat whose `at` collided with a sibling's would surface here as one line.
  state = appendEvent(state, started, beat(T0 + 300_000, 300), beat(T0 + 600_000, 600), {
    kind: "verify-completed",
    at: T0 + 900_000,
    step: "develop",
    command: started.command,
    target: started.target,
    status: "success",
    ok: true,
    ms: 900_000,
  });
  await persistCycle(ctx, state);

  const kinds = emitted.map((e) => e.kind);
  assert(
    JSON.stringify(kinds) ===
      JSON.stringify(["verify-started", "verify-heartbeat", "verify-heartbeat", "verify-completed"]),
    `host: the stream carries started, both beats and the end, in order, with no re-emission (got ${JSON.stringify(kinds)})`,
  );

  const rendered = emitted.map((e) => fmtEvent(e));
  assert(
    rendered.filter((l) => l.includes("verify-heartbeat")).length === 2 &&
      rendered[3]?.includes("15m00s") === true,
    `host: /work-status renders each beat with its elapsed (${JSON.stringify(rendered)})`,
  );

  const findings = validateDiscriminants(state);
  assert(findings.length === 0, `host: a log carrying beats validates (${JSON.stringify(findings)})`);

  // A second persist of the same log must emit nothing: the beats are already
  // past the watermark, and re-emitting them would double the host's liveness
  // signal for a gate that has already ended.
  const before = emitted.length;
  await persistCycle(ctx, state);
  assert(emitted.length === before, "host: re-persisting the same log re-emits nothing");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
