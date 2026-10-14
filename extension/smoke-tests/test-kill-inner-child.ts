#!/usr/bin/env bun
/**
 * The id a slow-run notice and `dispatch_peek` print must be an id
 * `dispatch_kill` acts on.
 *
 * Adversarial round children (and lens children) own no job: they are
 * `spawnSpecialist` calls keyed by a deck key (`<runId>/<tag>`). The slow-run
 * notice names that key and `dispatch_peek` lists it, but `killJob` looked
 * only in the `jobs` map — so a PM that did exactly what the notice said got
 * "No such job … already finished or never existed" for a child that was
 * still running. On the driver path nothing else could stop it either: the
 * driver hands the loop a signal that is never aborted.
 *
 * This drives the REAL `runAdversarialLoop` with a mocked spawn that hangs
 * until its signal aborts (a child stuck in a tool call), with the driver's
 * shape — a never-aborting loop signal and an orchestrator id that is no job.
 * The id is read from the deck snapshot (what `dispatch_peek` shows), passed
 * to `killJob` (what `dispatch_kill` calls), and the waiting loop must settle
 * as a failed dispatch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { mock } from "bun:test";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type SpawnOpts = { signal?: AbortSignal; onStdin?: (stdin: PassThrough) => void };
let spawns = 0;
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-kill",
  // A child hung inside one tool call: it answers nothing until it is killed.
  spawnSpecialist: (spec: { role: string }, opts: SpawnOpts) => {
    spawns++;
    opts.onStdin?.(new PassThrough());
    return new Promise((resolve) => {
      const done = () =>
        resolve({
          role: spec.role,
          ok: false,
          text: "",
          toolUses: [],
          ms: 10,
          exitCode: null,
          killCause: "abort",
        });
      if (opts.signal?.aborted) done();
      else opts.signal?.addEventListener("abort", done, { once: true });
    });
  },
}));

const { runAdversarialLoop } = await import("../src/adversarial.ts");
const { killJob, clearJobsForTesting } = await import("../src/async-jobs-lifecycle.ts");
const { childHandles, registerChildHandle } = await import("../src/async-jobs-registry.ts");
const { snapshot } = await import("../src/dispatch-deck.ts");
const { steerChild } = await import("../src/dispatch-steer.ts");

const tmp = mkdtempSync(path.join(os.tmpdir(), "kill-inner-"));
const priorLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
const priorSlow = process.env.PI_ENSEMBLE_SLOW_NOTICE;
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(tmp, "ledger.json");
process.env.PI_ENSEMBLE_SLOW_NOTICE = "0";
try {
  clearJobsForTesting();

  // 1. The registry seam: a handle with a kill is killable by its id; one
  //    without (a startJob child — its job owns the abort) is not a job here.
  {
    let killed = 0;
    registerChildHandle("r/with-kill", new PassThrough(), "l", "developer", () => killed++);
    registerChildHandle("r/no-kill", new PassThrough(), "l", "developer");
    assert(killJob("r/with-kill") === true && killed === 1, "1a: an inner child id is killable");
    assert(killJob("r/no-kill") === false, "1b: a handle with no kill is not reported killed");
    assert(killJob("r/unknown") === false, "1c: an unknown id still reports false");
    childHandles.clear();
  }

  // 2. The incident shape: driver-owned loop, never-aborting signal.
  {
    let settled = false;
    const loop = runAdversarialLoop(
      { diff: "diff --git a/x b/x\n+changed\n", context: "ctx", reportOnly: true },
      new AbortController().signal,
      "driver-orchestrator-not-a-job",
    ).then((r) => {
      settled = true;
      return r;
    });
    for (let i = 0; i < 200 && snapshot().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const peeked = snapshot().map((e) => e.key);
    assert(
      peeked.length === 1 && peeked[0] === "run-kill/round1-review",
      `2a: peek lists the round child by its deck key (got ${JSON.stringify(peeked)})`,
    );
    const id = peeked[0] ?? "";
    assert(
      steerChild(id, "status?", "pm-tool").delivered === true,
      "2b: dispatch_steer accepts the peeked id",
    );
    assert(settled === false, "2c: the loop is still waiting on the hung child");
    assert(killJob(id) === true, "2d: dispatch_kill accepts the SAME id (was: No such job)");
    const result = await Promise.race([
      loop,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 5_000)),
    ]);
    assert(result !== undefined, "2e: the kill settles the loop the driver step awaits");
    assert(
      result?.ok === false && result.loopOutcome === "infra-failure",
      `2f: …as a failed dispatch, not a verdict (ok=${result?.ok}, outcome=${result?.loopOutcome})`,
    );
    assert(spawns === 1, `2g: a killed child is not silently re-spawned (spawns=${spawns})`);
    assert(snapshot().length === 0, "2h: the deck row is gone");
    assert(killJob(id) === false, "2i: the id is no longer killable once the child settled");
  }
} finally {
  if (priorLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = priorLedger;
  if (priorSlow === undefined) delete process.env.PI_ENSEMBLE_SLOW_NOTICE;
  else process.env.PI_ENSEMBLE_SLOW_NOTICE = priorSlow;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
