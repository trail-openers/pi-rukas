#!/usr/bin/env bun
/**
 * #1415 — the develop gate's verify ran for ~22 minutes per round with nothing
 * on the stream between the developer finishing and `develop` completing, so
 * an operator watching the cycle saw a stall that was not one. The gate now
 * brackets its run with `verify-started` / `verify-completed`:
 *
 *   a. `verify-started` reaches the host's emit sink BEFORE the command runs
 *      (the whole point: visible while it happens), carrying the command;
 *   b. `verify-completed` carries ok, the duration and the command;
 *   c. recording the gate after the run emits `verify-completed` and does NOT
 *      emit `verify-started` a second time (the emit sink's prefix match);
 *   d. a failing gate records `ok: false`;
 *   e. no discoverable verify command → no bracket at all (nothing ran);
 *   f. both kinds validate, render in /work-status, and are stable NDJSON.
 *
 * Real git, a real state file and a real emit sink; only the project's verify
 * command is replaced by the counting executor.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isStableKind } from "../src/headless/ndjson.ts";
import { fmtEvent } from "../src/work-status-events.ts";
import { recordDevelopGateEvents } from "../src/work-driver-verify-events.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { persistCycle } from "../src/workflow-state.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import {
  type Counts,
  ctxFor,
  installVerifyCmd,
  makeExec,
  stateFor,
} from "./lib/consolidated-verify-exec.ts";
import { fixture } from "./lib/consolidated-verify-fixture.ts";

const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

// Empty glob list disables the frontend-only classification (#1012) so the
// gate always reaches the verify chain in this fixture.
process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1415-"));

/** A gate run whose executor snapshots what the sink had emitted when the command ran. */
async function runGate(name: string, issue: number, opts: { fail?: boolean; noCmd?: boolean }) {
  const f = await fixture(root, name, ["default"]);
  const cmd = opts.noCmd ? undefined : installVerifyCmd(f.repo, "never-written.txt", opts);
  // A committed change: a worktree with no diff fails the gate before any verify.
  const wt = f.worktrees.default as string;
  writeFileSync(path.join(wt, "a.txt"), "a\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "task: add a"]);
  const emitted: WorkEvent[] = [];
  const emitSink = createEmitSink((e) => emitted.push(e));
  const counts: Counts = { runs: [], repoRoot: f.repo };
  const kindsAtRun: string[][] = [];
  const exec = makeExec(counts, {
    fail: opts.fail,
    onRun: () => kindsAtRun.push(emitted.map((e) => e.kind)),
  });
  const ctx = { ...ctxFor(f.repo, issue, exec), emitSink } as Parameters<
    typeof verifyStepOutcome
  >[0];
  const state = stateFor(f, issue);
  const gate = await verifyStepOutcome(ctx, state, "develop");
  return { f, cmd, ctx, state, gate, emitted, kindsAtRun };
}

try {
  // ------------------------------------------------------------ cases a–c
  {
    const r = await runGate("passing", 1415, {});
    assert(r.kindsAtRun.length > 0, "a: the verify command ran");
    assert(
      r.kindsAtRun.every((k) => k.includes("verify-started")),
      `a: verify-started was on the stream before every run (saw ${JSON.stringify(r.kindsAtRun)})`,
    );
    const [started, completed] = r.gate.verifyEvents ?? [];
    assert(
      started?.kind === "verify-started" && started.command === r.cmd,
      `a: verify-started names the command (got ${JSON.stringify(started)})`,
    );
    assert(
      completed?.kind === "verify-completed" &&
        completed.ok === true &&
        completed.command === r.cmd &&
        completed.ms >= 0 &&
        completed.ms === completed.at - (started?.at ?? Number.NaN),
      `b: verify-completed carries ok, ms and the command (got ${JSON.stringify(completed)})`,
    );

    const before = r.emitted.length;
    const recorded = recordDevelopGateEvents(r.state, r.gate);
    await persistCycle(r.ctx, recorded);
    const after = r.emitted.slice(before).map((e) => e.kind);
    assert(
      after.includes("verify-completed") && !after.includes("verify-started"),
      `c: recording the gate emits verify-completed once and not verify-started again (got ${JSON.stringify(after)})`,
    );
    const kinds = recorded.eventLog.map((e) => e.kind);
    assert(
      kinds.indexOf("verify-started") < kinds.indexOf("verify-completed") &&
        kinds.at(-1) === "verify-completed",
      `c: the bracket closes the gate's entries (log tail ${JSON.stringify(kinds.slice(-3))})`,
    );
  }

  // --------------------------------------------------------------- case d
  {
    const r = await runGate("failing", 1416, { fail: true });
    const completed = r.gate.verifyEvents?.[1];
    assert(r.kindsAtRun.length > 0 && !r.gate.ok, "d: the command ran and the gate fails");
    assert(
      completed?.kind === "verify-completed" && completed.ok === false,
      `d: verify-completed records ok: false (got ${JSON.stringify(completed)})`,
    );
  }

  // --------------------------------------------------------------- case e
  {
    const r = await runGate("no-cmd", 1417, { noCmd: true });
    assert(
      r.gate.verifyEvents === undefined && !r.emitted.some((e) => e.kind === "verify-started"),
      "e: no verify command → no bracket",
    );
  }

  // --------------------------------------------------------------- case f
  {
    const events: WorkEvent[] = [
      { kind: "verify-started", at: 1, step: "develop", command: "bash scripts/verify.sh" },
      {
        kind: "verify-completed",
        at: 1_347_001,
        step: "develop",
        command: "bash scripts/verify.sh",
        ok: true,
        ms: 1_347_000,
      },
    ];
    const r = await runGate("validate", 1418, {});
    const findings = validateDiscriminants({ ...r.state, eventLog: events });
    assert(findings.length === 0, `f: both kinds validate (${JSON.stringify(findings)})`);
    const lines = events.map((e) => fmtEvent(e));
    assert(
      lines[0]?.includes("verify-started") === true &&
        lines[1]?.includes("passed") === true &&
        lines[1]?.includes("22m27s") === true,
      `f: /work-status renders both (got ${JSON.stringify(lines)})`,
    );
    assert(
      isStableKind("verify-started") && isStableKind("verify-completed"),
      "f: both are stable NDJSON kinds",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
