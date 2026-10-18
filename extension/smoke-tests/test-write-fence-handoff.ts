#!/usr/bin/env bun
/**
 * #1655 — the write fence's refusal count reaches a handoff through the handoff
 * step's own path (MEDIUM 1, MEDIUM 6).
 *
 * `runHandoff` is reached from run-step, not from routeStepOutcome, so a count
 * folded only at routeStepOutcome never reached a handoff's body. These drive
 * `runHandoff` directly, with refusal logs in the cycle's scratch dir, and assert
 * the total lands on the state and in the rendered body:
 *
 *   a. a readable refusal log is counted and rendered;
 *   b. a log that cannot be read (here, a directory named like one) makes the
 *      count unknown: the body says so, and is never a silent zero.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { deliverTerminalLine } from "../src/work-driver-terminal-delivery.ts";
import { scratchDir } from "../src/work-driver-workspace.ts";
import { cappedState, fakePi, mkFakeForge } from "./lib/handoff-provenance-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 626;
const dir = mkdtempSync(path.join(tmpdir(), "issue1655-handoff-"));
try {
  const scratch = scratchDir(dir, ISSUE);
  mkdirSync(scratch, { recursive: true });
  const refusal = `${JSON.stringify({ tool: "write", path: "../../bin/keep", reason: "r", at: 1 })}\n`;
  writeFileSync(path.join(scratch, "write-fence-7.jsonl"), refusal);

  const { forge } = mkFakeForge({ issueLabels: ["needs-human-attention"] });
  const ctx: DriverContext = {
    host: fakePi,
    repoRoot: dir,
    issue: ISSUE,
    dispatchFn: async () => ({
      role: "ops",
      ok: true,
      text: "posted and labelled.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/issues/626#issuecomment-999 label=applied",
      toolUses: [],
      ms: 10,
      exitCode: 0,
      transcriptPath: "/tmp/stub.json",
    }),
    forge,
  };

  // a. A readable log: the total is on the state and in the handoff body.
  const counted = await runHandoff(ctx, cappedState(ISSUE), Date.now());
  assert(
    counted.pipelineState.writeFenceRefusals === 1,
    "a: runHandoff folds the refusal total onto the state (the handoff does not route through routeStepOutcome)",
  );
  const countedBody = counted.eventLog.find((e) => e.kind === "handoff-emitted");
  assert(
    countedBody?.kind === "handoff-emitted" &&
      countedBody.body.includes("Writes refused by the write fence") &&
      countedBody.body.includes("1 write outside"),
    "a: the handoff body reports the refusal",
  );

  // b. A log the driver cannot read: the count is unknown, never a silent zero.
  mkdirSync(path.join(scratch, "write-fence-8.jsonl"));
  const unknown = await runHandoff(ctx, cappedState(ISSUE), Date.now());
  assert(
    unknown.pipelineState.writeFenceUnreadable === 1,
    "b: an unreadable refusal log is recorded as unreadable, not dropped",
  );
  const unknownBody = unknown.eventLog.find((e) => e.kind === "handoff-emitted");
  assert(
    unknownBody?.kind === "handoff-emitted" &&
      unknownBody.body.includes("Count unknown (1 refusal source unreadable or unlogged)"),
    "b: the handoff body says the count is unknown rather than reporting zero",
  );

  // c. The terminal line is the one path every terminal state takes, a resumed
  // cycle's included: the total it returns carries the same count.
  const delivered = await deliverTerminalLine(
    { repoRoot: dir, issue: ISSUE, host: fakePi },
    cappedState(ISSUE),
  );
  assert(
    delivered.pipelineState.writeFenceRefusals === 1 &&
      delivered.pipelineState.writeFenceUnreadable === 1,
    "c: the terminal line returns the refusal total, so a resumed cycle's state carries it",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (exit === 0) console.log("✓ all write-fence handoff assertions passed");
process.exit(exit);
