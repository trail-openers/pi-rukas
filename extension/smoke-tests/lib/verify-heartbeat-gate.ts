/**
 * The verify-gate heartbeat harness: one develop-gate run whose project command
 * returns immediately, so the beat can be observed at its seam without a clock
 * being involved at all. The pump's own timing is pinned by the caller firing
 * its registered callback by hand; what this file owns is reaching the gate's
 * span with a real fixture, a real state file and a real emit sink.
 *
 * The executor is the shared one from `consolidated-verify-exec.ts`, so the gate
 * runs real git and only the project's verify command is canned — the same shape
 * `test-verify-run-events.ts` drives.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { verifyStepOutcome } from "../../src/work-driver-verify.ts";
import { createEmitSink } from "../../src/work-state-emit.ts";
import type { WorkEvent } from "../../src/workflow-state-events.ts";
import type { WorkState } from "../../src/workflow-state.ts";
import {
  type Counts,
  ctxFor,
  installVerifyCmd,
  makeExec,
  stateFor,
} from "./consolidated-verify-exec.ts";
import { fixture } from "./consolidated-verify-fixture.ts";
import { gitTestEnv } from "./git-test-env.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** What the run handed the heartbeat pump when it armed it. */
const execFileP = promisify(execFile);
// Real git, so the child names the scrub itself: an inherited `GIT_DIR` is
// honoured ahead of `cwd`, so the commit below would land in whoever's
// repository the variable names and exit 0 doing it.
const git = (cwd: string, args: string[]) =>
  execFileP("git", args, { cwd, env: gitTestEnv() });

type Heartbeat = Extract<WorkEvent, { kind: "verify-heartbeat" }>;
type GateCtx = Parameters<typeof verifyStepOutcome>[0];

/** What the run handed the heartbeat pump when it armed it. */
export type ArmedBeat = { step: string; command: string; intervalMs: number | undefined };

export interface GateRun {
  f: Fixture;
  cmd: string;
  state: WorkState;
  gate: Awaited<ReturnType<typeof verifyStepOutcome>> | undefined;
  /** The gate's own host lines — what its span put on the stream. */
  emitted: WorkEvent[];
  threw: boolean;
  armed: () => ArmedBeat[];
  stopped: () => number;
  beats: () => Heartbeat[];
}

/**
 * One gate run. `viaPump` runs the REAL pump through the ctx seam so the caller
 * can count what it wrote; otherwise the pump itself is injected, so the case
 * reads the arm/stop pair directly and no timer is ever armed.
 */
export async function runGate(
  root: string,
  name: string,
  issue: number,
  opts: { heartbeatMs?: number; fail?: boolean; viaPump?: boolean } = {},
): Promise<GateRun> {
  const f = await fixture(root, name, ["default"]);
  const cmd = installVerifyCmd(f.repo, "never-written.txt", { fail: opts.fail });
  // A committed change: a worktree with no diff fails the gate before any verify.
  const wt = f.worktrees.default as string;
  writeFileSync(path.join(wt, "a.txt"), "a\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "task: add a"]);

  const emitted: WorkEvent[] = [];
  // A sink that sees the gate's own write — `beginVerifyRun`'s persist — and
  // nothing after it. The bracket's end event is deliberately not stream-observed
  // here: `recordDevelopGateEvents` writes it later and its stamps (`at`, `ms`)
  // are run-specific, and the pair itself belongs to `test-verify-run-events.ts`
  // and `test-verify-gate-events.ts`.
  let watching = false;
  const emitSink = createEmitSink((e) => {
    if (watching) emitted.push(e);
  });
  const counts: Counts = { runs: [], repoRoot: f.repo };
  const exec = makeExec(counts, { fail: opts.fail });

  const armed: ArmedBeat[] = [];
  let stopped = 0;
  const ctx = {
    ...ctxFor(f.repo, issue, exec),
    emitSink,
    ...(opts.heartbeatMs === undefined ? {} : { verifyHeartbeatMs: opts.heartbeatMs }),
    ...(opts.viaPump === true
      ? {}
      : {
          verifyHeartbeat: (a: ArmedBeat) => {
            armed.push({ step: a.step, command: a.command, intervalMs: a.intervalMs });
            return () => {
              stopped++;
            };
          },
        }),
  } as unknown as GateCtx;

  const state = stateFor(f, issue);
  watching = true;
  let gate: Awaited<ReturnType<typeof verifyStepOutcome>> | undefined;
  const threw = await verifyStepOutcome(ctx, state, "develop").then(
    (g) => ((gate = g), false),
    () => true,
  );
  return {
    f,
    cmd,
    state,
    gate,
    emitted,
    threw,
    armed: () => armed,
    stopped: () => stopped,
    beats: () => emitted.filter((e): e is Heartbeat => e.kind === "verify-heartbeat"),
  };
}
