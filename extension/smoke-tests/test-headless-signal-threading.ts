#!/usr/bin/env bun
/**
 * #1024 (headless S4, review round 2) — every child a cycle starts honours the
 * cycle's signal and process-group policy, and an interrupt between groups is
 * reported, never dropped:
 *
 *   - every driver-path `dispatchCore(` / `spawnSpecialist(` call passes both
 *     `signal` and `processGroup` (the cycle-entry wrapper is the one exemption);
 *   - a handoff ops dispatch receives the cycle's signal and group policy, and
 *     aborting it leaves no process in the child's group;
 *   - a SIGTERM between groups reports every unreached issue as not-started
 *     with the interrupt exit code.
 *
 * Offline: the dispatch is a stub, the issue bodies are empty (R5: one group each).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHeadless } from "../src/headless/run.ts";
import { groupSpawnOpts, killProcessTree, registerChild } from "../src/spawn-kill.ts";
import type { DispatchResult } from "../src/types.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { runHandoffOpsDispatch } from "../src/work-driver-handoff-ops.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import { initialState, writeState } from "../src/workflow-state.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";

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

// ── 1. Static: every driver-path call site threads signal + processGroup.
{
  const SRC = path.resolve(import.meta.dir, "../src");
  // dispatch.ts's tool registrations are the interactive path (no group, no
  // cycle signal); its dispatchCore is covered by the cycle-entry wrapper.
  const DRIVER_PATH = /^(work-driver|work-develop|adversarial|lens-review)/;
  // The cycle-entry wrapper is where the two values are bound; it is exempt.
  const EXEMPT = new Set(["work-driver-cycle-entry.ts"]);
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && DRIVER_PATH.test(f));
  const offenders: string[] = [];
  let sites = 0;
  for (const file of files) {
    if (EXEMPT.has(file)) continue;
    const text = readFileSync(path.join(SRC, file), "utf8");
    const re = /\b(dispatchCore|spawnSpecialist)\(/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const linePrefix = text.slice(lineStart, m.index);
      if (/\bfunction\s*$/.test(linePrefix) || /^\s*(import|export)\b/.test(linePrefix)) continue;
      if (/^\s*(\*|\/\/)/.test(linePrefix)) continue;
      sites++;
      // The argument list: scan to the matching close paren.
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < text.length; end++) {
        const ch = text[end];
        if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) break;
      }
      const args = text.slice(m.index, end);
      const line = text.slice(0, m.index).split("\n").length;
      if (!/\bsignal\b/.test(args) || !/\bprocessGroup\b/.test(args)) {
        offenders.push(`${file}:${line}`);
      }
    }
  }
  assert(sites > 0, `the static scan found driver-path call sites (${sites})`);
  assert(
    offenders.length === 0,
    `every driver-path dispatchCore/spawnSpecialist passes signal + processGroup${
      offenders.length ? ` — offenders: ${offenders.join(", ")}` : ""
    }`,
  );
}

// ── 2. A handoff ops dispatch aborted by the cycle: its child's group is gone.
{
  const repo = mkdtempSync(path.join(tmpdir(), "headless-s4-handoff-"));
  try {
    const ac = new AbortController();
    let seen: { signal?: AbortSignal; processGroup?: boolean } = {};
    let pgid: number | undefined;
    const dispatchFn = (
      _host: unknown,
      spec: { role: string },
      opts: { signal?: AbortSignal; processGroup?: boolean },
    ) =>
      new Promise<DispatchResult>((resolve) => {
        seen = { signal: opts.signal, processGroup: opts.processGroup };
        const child = spawn("sh", ["-c", "sleep 30 & sleep 30"], {
          ...groupSpawnOpts(opts.processGroup === true),
          stdio: "ignore",
        });
        registerChild(child, opts.processGroup === true);
        pgid = child.pid;
        const stop = () => {
          killProcessTree(child);
          resolve({ role: spec.role, ok: false, text: "", toolUses: [], ms: 1, exitCode: null });
        };
        if (opts.signal?.aborted) stop();
        else opts.signal?.addEventListener("abort", stop, { once: true });
      });
    const state = initialState(71);
    await writeState(repo, state);
    const ctx = {
      repoRoot: repo,
      issue: 71,
      host: {},
      emitSink: createEmitSink(() => undefined),
      signal: ac.signal,
      processGroup: true,
      dispatchFn,
    } as unknown as CycleContext;
    const run = runHandoffOpsDispatch(ctx, state, path.join(repo, "handoff.md"));
    for (let i = 0; i < 300 && pgid === undefined; i++) await sleep(10);
    ac.abort("signal");
    await run;
    assert(seen.signal === ac.signal, "the handoff dispatch receives the cycle signal");
    assert(seen.processGroup === true, "the handoff dispatch receives the cycle's group policy");
    assert(pgid !== undefined, "the handoff dispatch started a child");
    let gone = false;
    for (let i = 0; i < 60 && !gone && pgid !== undefined; i++) {
      await sleep(100);
      try {
        process.kill(-pgid, 0);
      } catch {
        gone = true;
      }
    }
    assert(gone, "aborting a handoff dispatch leaves no process in the child's group");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. SIGTERM between groups: the unreached issue is reported, exit 21.
{
  const repo = mkdtempSync(path.join(tmpdir(), "headless-s4-between-"));
  try {
    // Issue 81 is already merged, so group 1 completes without dispatching.
    const merged = initialState(81);
    await writeState(repo, {
      ...merged,
      pipelineState: { ...merged.pipelineState, status: "merged" },
    });
    const sig = fakeSignals();
    const result = await runHeadless({
      repoRoot: repo,
      issues: [81, 82],
      restart: false,
      graceMs: 50,
      signalTarget: sig as unknown as NodeJS.Process,
      driverSeams: {
        dispatchFn: (() => Promise.reject(new Error("no dispatch expected"))) as never,
        issueBodyFetcherFn: issueFetch,
      },
      // The first line group 1 emits is its completion: the interrupt lands between groups.
      write: () => sig.fire("SIGTERM"),
    });
    const r82 = result.results.find((r) => r.issue === 82);
    assert(result.exitCode === 21, `a between-group interrupt exits 21 (got ${result.exitCode})`);
    assert(r82?.status === "not-started", "the unreached issue is reported as not-started");
    assert(r82?.exitCode === 21, "the unreached issue carries the interrupt exit code");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

process.exit(exit);
