#!/usr/bin/env bun
/**
 * #1024 (headless S4, review round 1) — interrupt handling and the process-group
 * boundary:
 *
 *   - a dispatch that honours the cycle's abort (it fails once the signal fires)
 *     exits 21 with exactly one `interrupted` event, and the aborted step leaves
 *     no dispatch-failed / cap-hit / handoff event behind;
 *   - after the signal fires, a driver persist of a stale `running` snapshot
 *     lands as `interrupted`, never `running` (the grace-expiry race);
 *   - an interactive spawn is NOT a process-group leader; a headless spawn is;
 *   - a group kill reaches a grandchild, and a non-group kill leaves the group alone;
 *   - there is no `--merge` (an unknown flag exits 40); merge authority comes from AGENTS.md only;
 *   - the NDJSON key index is the event's position in the state log.
 *
 * Offline: the dispatch is a stub, the issue body is a stub, gh is absent.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseHeadlessArgs } from "../src/headless/cli.ts";
import { createHeadlessHost } from "../src/headless/host.ts";
import { runHeadless } from "../src/headless/run.ts";
import { groupSpawnOpts, killProcessTree, registerChild } from "../src/spawn-kill.ts";
import type { DispatchResult } from "../src/types.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import {
  type WorkEvent,
  type WorkState,
  initialState,
  persistCycle,
  readState,
  writeState,
} from "../src/workflow-state.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const issueFetch = async () => ({ stdout: "title:\tmock\nstate:\tOPEN\n\nnon-empty mock body" });

function fakeSignals() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on(sig: string, fn: () => void) {
      if (!handlers.has(sig)) handlers.set(sig, new Set());
      handlers.get(sig)?.add(fn);
    },
    off(sig: string, fn: () => void) {
      handlers.get(sig)?.delete(fn);
    },
    fire(sig: string) {
      for (const fn of [...(handlers.get(sig) ?? [])]) fn();
    },
  };
}

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "headless-s4-"));
}

// ── 1. A dispatch that honours the abort: exit 21, one interrupted, no failure events.
{
  const repo = tmpRepo();
  try {
    const sig = fakeSignals();
    // The stub fires SIGTERM while the child is "in flight", then answers with the
    // failure an aborted child produces. The driver must not route that failure.
    const honouring = (_h: unknown, spec: { role: string }) => {
      sig.fire("SIGTERM");
      const failed: DispatchResult = {
        role: spec.role,
        ok: false,
        text: "",
        toolUses: [],
        ms: 1,
        exitCode: null,
      };
      return Promise.resolve(failed);
    };
    const result = await runHeadless({
      repoRoot: repo,
      issues: [61],
      restart: false,
      graceMs: 50,
      signalTarget: sig as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: honouring as never, issueBodyFetcherFn: issueFetch },
      write: () => undefined,
    });
    const state = (await readState(repo, 61)) as WorkState;
    const kinds = state.eventLog.map((e: WorkEvent) => e.kind);
    assert(result.exitCode === 21, `an honoured abort exits 21 (got ${result.exitCode})`);
    assert(state.pipelineState.status === "interrupted", "the state file reads interrupted");
    assert(kinds.filter((k) => k === "interrupted").length === 1, "exactly one interrupted event");
    assert(!kinds.includes("handoff-emitted"), "no handoff event for the aborted step");
    assert(!kinds.includes("cap-hit"), "no cap-hit event for the aborted step");
    assert(
      kinds.some((k) => k.startsWith("dispatch-failed")),
      "the aborted step's dispatch-failed stays in the log (events are never dropped)",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 2. Grace-expiry race: once the signal fired, a stale `running` snapshot lands as interrupted.
{
  const repo = tmpRepo();
  try {
    const ac = new AbortController();
    const sink = createEmitSink(() => undefined);
    const running = initialState(62);
    await writeState(repo, running);
    ac.abort("signal");
    await persistCycle({ repoRoot: repo, emitSink: sink, signal: ac.signal }, running);
    const onDisk = (await readState(repo, 62)) as WorkState;
    assert(
      onDisk.pipelineState.status === "interrupted",
      "a stale running persist after the signal writes interrupted, not running",
    );
    const merged = {
      ...onDisk,
      pipelineState: { ...onDisk.pipelineState, status: "merged" as const },
    };
    await persistCycle({ repoRoot: repo, emitSink: sink, signal: ac.signal }, merged);
    const after = (await readState(repo, 62)) as WorkState;
    assert(after.pipelineState.status === "merged", "a terminal status is written as given");
    await persistCycle({ repoRoot: repo, emitSink: sink }, running);
    const plain = (await readState(repo, 62)) as WorkState;
    assert(plain.pipelineState.status === "running", "no signal: a running snapshot stays running");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. Process groups: only a headless spawn is a group leader.
{
  assert(groupSpawnOpts(false).detached === false, "an interactive spawn is not detached");
  assert(groupSpawnOpts(true).detached === true, "a headless spawn is detached (own group)");

  const plain = spawn("sleep", ["30"], { stdio: "ignore" });
  const exitedPlain = new Promise((r) => plain.once("exit", r));
  registerChild(plain, false);
  killProcessTree(plain);
  await exitedPlain;
  assert(plain.signalCode === "SIGTERM", "a non-group kill reaches the leader");

  // A group kill reaches the grandchild the shell backgrounded.
  const grouped = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
    stdio: ["ignore", "pipe", "ignore"],
    ...groupSpawnOpts(true),
  });
  const pidLine = await new Promise<string>((resolve) => {
    grouped.stdout?.once("data", (d: Buffer) => resolve(d.toString().trim()));
  });
  const grandchild = Number(pidLine);
  const exitedGroup = new Promise((r) => grouped.once("exit", r));
  registerChild(grouped, true);
  killProcessTree(grouped);
  await exitedGroup;
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(grandchild, 0);
      await sleep(50);
    } catch {
      alive = false;
    }
  }
  assert(!alive, "a group kill reaches the grandchild");
}

// ── 4. --merge is no longer a flag: an agent or a human gets the same unknown-argument refusal.
{
  const parsed = parseHeadlessArgs(["7", "--merge"]);
  assert("error" in parsed && parsed.error.includes("--merge"), "--merge is an unknown argument");
  assert("error" in parseHeadlessArgs(["7", "--sandboxed"]), "--sandboxed is no longer a flag");
}

// ── 5. NDJSON key index is the event's position in the log.
{
  const lines: string[] = [];
  const host = createHeadlessHost(63, (l) => lines.push(l));
  host.emit({ kind: "interrupted", at: 500, reason: "signal" }, 4);
  const parsed = JSON.parse(lines[0] ?? "{}") as { key?: string };
  assert(parsed.key === "63:4:500", `the key carries the log position (got ${parsed.key})`);
}

if (exit === 0) console.log("\nAll headless S4 interrupt checks passed.");
process.exit(exit);
