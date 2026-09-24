#!/usr/bin/env bun
/**
 * #799 (F2, task-b) — the per-step long-run operator notice.
 *
 * A step whose wall-clock elapsed time crosses the threshold earns ONE
 * operator notice via the existing PI_ENSEMBLE_NOTIFY_CMD hook (new
 * "running-slow" kind): a notice, never a kill. The notice is keyed on the
 * STEP's elapsed span, not any single child's — the #799 incident's silent
 * window was a fan-out whose children were each individually healthy, so a
 * per-child threshold would not have fired on the real shape and would have
 * alarmed on every healthy 19–73 min develop child.
 *
 * Unit cases (1–5) drive the timer with a fake clock + fake timer (no
 * wall-clock hazard) and a recording notify seam; the wiring cases (6–7) run
 * `runDevelopTopological` end-to-end with a real (slow/fast) fake dispatch
 * and observe the hook through PI_ENSEMBLE_NOTIFY_CMD itself, proving the
 * notice actually reaches the operator's command. The real hook's fails-open
 * contract is covered by test-work-notify.ts and unchanged here.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  armStepNotice,
  stepNoticeThresholdMs,
  type StepNoticeParams,
} from "../src/work-driver-step-notice.ts";
import { formatNotification, type Notification } from "../src/work-notify.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { DispatchResult } from "../src/types.ts";
import { initialState, type WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------- test-time seams

interface Ticks {
  now: () => number;
  advance: (ms: number) => void;
  schedule: NonNullable<StepNoticeParams["schedule"]>;
  /** Fire every armed timer whose due time is ≤ the current fake time. */
  flush: () => void;
}

function fakeTime(): Ticks {
  let t = 1_000_000;
  const pending: Array<{ due: number; fn: () => void }> = [];
  const fireDue = () => {
    for (let i = 0; i < 10_000; i++) {
      const due = pending.filter((p) => p.due <= t);
      if (due.length === 0) return;
      due.sort((a, b) => a.due - b.due);
      for (const d of due) {
        const k = pending.indexOf(d);
        if (k >= 0) pending.splice(k, 1);
      }
      for (const d of due) d.fn();
    }
  };
  return {
    now: () => t,
    advance: (ms) => {
      // Advance time and fire any timers that become due — matching real
      // setTimeout semantics where a 35ms timer fires during a 35ms wait.
      t += ms;
      fireDue();
    },
    schedule: (fn, ms) => {
      const due = t + Math.max(0, ms);
      const rec = { due, fn };
      pending.push(rec);
      return () => {
        const i = pending.indexOf(rec);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    flush: fireDue,
  };
}

const withEnv = async (key: string, value: string | undefined, fn: () => Promise<void>) => {
  const prev = process.env[key];
  if (value === undefined) process.env[key] = undefined;
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) process.env[key] = undefined;
    else process.env[key] = prev;
  }
};

const recordingNotify =
  (sent: Notification[]) =>
  async (n: Notification): Promise<{ sent: boolean; reason?: string }> => {
    sent.push(n);
    return { sent: true };
  };

const mkState = (): WorkState => initialState(799, 1_000_000);

// --------------------------------------------------------------- 1. cross

await withEnv("PI_ENSEMBLE_STEP_NOTICE_MS", "30", async () => {
  process.env.PI_ENSEMBLE_NOTIFY_CMD = "true"; // dummy — the notifyFn seam records the notice
  const clock = fakeTime();
  const sent: Notification[] = [];
  const p: StepNoticeParams = {
    state: mkState(),
    step: "develop",
    startedAt: clock.now(),
    now: clock.now,
    schedule: clock.schedule,
    notifyFn: recordingNotify(sent),
  };
  const cancel = armStepNotice(p);
  assert(stepNoticeThresholdMs() === 30, "threshold reads PI_ENSEMBLE_STEP_NOTICE_MS");
  clock.advance(10);
  clock.flush();
  assert(sent.length === 0, "under threshold → no notice yet");
  clock.advance(25); // 35ms elapsed
  clock.flush();
  assert(sent.length === 1, "crossing the threshold → exactly one notice");
  if (sent[0]) {
    assert(sent[0].kind === "running-slow", "the notice kind is running-slow");
    assert(sent[0].issues[0] === 799, "the notice names the issue");
    assert(/develop/.test(sent[0].reason), "the notice names the step");
    assert(/still running/.test(sent[0].reason), "the reason carries the elapsed span");
  }
  cancel();
});

// ------------------------------------------------------- 2. under: no noise

await withEnv("PI_ENSEMBLE_STEP_NOTICE_MS", "1_000_000", async () => {
  process.env.PI_ENSEMBLE_NOTIFY_CMD = "true"; // dummy — the notifyFn seam records the notice
  const clock = fakeTime();
  const sent: Notification[] = [];
  const p: StepNoticeParams = {
    state: mkState(),
    step: "lens-review",
    startedAt: clock.now(),
    now: clock.now,
    schedule: clock.schedule,
    notifyFn: recordingNotify(sent),
  };
  const cancel = armStepNotice(p);
  clock.advance(700_000); // 700s elapsed — a 19-min healthy run, under the 16.7-min threshold
  clock.flush();
  assert(sent.length === 0, "a healthy run finishing under the threshold → NO notice");
  cancel();
});

// ------------------------------------------------------------- 3. fire-once

await withEnv("PI_ENSEMBLE_STEP_NOTICE_MS", "10", async () => {
  process.env.PI_ENSEMBLE_NOTIFY_CMD = "true"; // dummy — the notifyFn seam records the notice
  const clock = fakeTime();
  const sent: Notification[] = [];
  const p: StepNoticeParams = {
    state: mkState(),
    step: "adversarial",
    startedAt: clock.now(),
    now: clock.now,
    schedule: clock.schedule,
    notifyFn: recordingNotify(sent),
  };
  const cancel = armStepNotice(p);
  clock.advance(10);
  clock.flush();
  clock.advance(900_000); // still running, 16 min past the threshold
  clock.flush();
  assert(sent.length === 1, "a step still running long past the threshold → exactly ONE notice");
  cancel();
});

// ------------------------------------------- 4. cancel after firing = done

await withEnv("PI_ENSEMBLE_STEP_NOTICE_MS", "10", async () => {
  process.env.PI_ENSEMBLE_NOTIFY_CMD = "true"; // dummy — the notifyFn seam records the notice
  const clock = fakeTime();
  const sent: Notification[] = [];
  const p: StepNoticeParams = {
    state: mkState(),
    step: "develop",
    startedAt: clock.now(),
    schedule: clock.schedule,
    now: clock.now,
    notifyFn: recordingNotify(sent),
  };
  const cancel = armStepNotice(p);
  clock.advance(10);
  clock.flush();
  const first = sent.length;
  assert(first === 1, "fired once at the crossing");
  cancel();
  clock.advance(5000);
  clock.flush();
  assert(sent.length === first, "after cancel (step end) no further notices");
});

// ---------------------------------------------------- 5. disabled = no-op

await withEnv("PI_ENSEMBLE_STEP_NOTICE_MS", "0", async () => {
  assert(
    Number.isFinite(stepNoticeThresholdMs()) === false,
    "PI_ENSEMBLE_STEP_NOTICE_MS=0 → non-finite threshold (disabled)",
  );
  process.env.PI_ENSEMBLE_NOTIFY_CMD = "true"; // dummy — the notifyFn seam records the notice
  const clock = fakeTime();
  const sent: Notification[] = [];
  const p: StepNoticeParams = {
    state: mkState(),
    step: "develop",
    startedAt: clock.now(),
    now: clock.now,
    schedule: clock.schedule,
    notifyFn: recordingNotify(sent),
  };
  const cancel = armStepNotice(p);
  clock.advance(10_000_000);
  clock.flush();
  cancel();
  assert(sent.length === 0, "disabled → nothing armed, nothing sent");
});

// Hook unset is also inert (default threshold, no env)
{
  const clock = fakeTime();
  const sent: Notification[] = [];
  const prev = process.env.PI_ENSEMBLE_NOTIFY_CMD;
  process.env.PI_ENSEMBLE_NOTIFY_CMD = undefined;
  try {
    const p: StepNoticeParams = {
      state: mkState(),
      step: "develop",
      startedAt: clock.now(),
      now: clock.now,
      schedule: clock.schedule,
      notifyFn: recordingNotify(sent),
    };
    const cancel = armStepNotice(p);
    clock.advance(10_000_000);
    clock.flush();
    cancel();
    assert(sent.length === 0, "hook unset → notice inert (byte-identical to pre-#799)");
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_NOTIFY_CMD = undefined;
    else process.env.PI_ENSEMBLE_NOTIFY_CMD = prev;
  }
}

// ---------------------------------------------------------- the message shape

{
  const text = formatNotification({
    kind: "running-slow",
    issues: [799],
    reason: "develop still running at 2h 05m",
    action: "check #799 with /work-status, or dispatch_peek the running job",
  });
  assert(text.split("\n").length === 2, "running-slow renders as two lines like the other kinds");
  assert(/still running/.test(text), "it reads as an observation, not a failure");
}

// --------------------------------------------------------------- wiring (6–7)

const realSh = async (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

function mkDevelopFixture(): { repo: string; wt: string; state: WorkState } {
  const repo = mkdtempSync(path.join(tmpdir(), "pi-ens-799w-"));
  const wt = path.join(repo, "wt");
  execSync(
    "git init -q --initial-branch=main && git config user.email t@t && git config user.name T && git commit -q --allow-empty -m base",
    { cwd: repo },
  );
  execSync(`git worktree add -q --detach ${wt} HEAD`, { cwd: repo });
  const baseSha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  const state: WorkState = {
    ...initialState(799),
    pipelineState: {
      ...initialState(799).pipelineState,
      baseSha,
      worktrees: { default: wt },
      workstreams: { default: { id: "default", scope: "s", paths: [], outOfScope: [] } },
      currentStep: "develop" as const,
    },
  };
  return { repo, wt, state };
}

const mkDispatch =
  (delayMs: number): NonNullable<DriverContext["dispatchFn"]> =>
  async (_pi: unknown, spec: { role: string }): Promise<DispatchResult> => {
    await new Promise((r) => setTimeout(r, delayMs));
    return {
      role: spec.role,
      ok: true,
      text: "done",
      toolUses: [],
      ms: 1,
      exitCode: 0,
      transcriptPath: "/tmp/x",
    };
  };

/** Run runDevelopTopological with the hook pointed at a recorder; return the
 * recorder's captured stdout. */
async function runWithRecorder(
  repo: string,
  state: WorkState,
  dispatchFn: NonNullable<DriverContext["dispatchFn"]>,
): Promise<string> {
  const recorder = path.join(repo, "recorder.sh");
  writeFileSync(recorder, "#!/bin/sh\ncat\n");
  const out = path.join(repo, "notices.log");
  const prev = process.env.PI_ENSEMBLE_NOTIFY_CMD;
  process.env.PI_ENSEMBLE_NOTIFY_CMD = `sh ${recorder} >> ${out}`;
  const ctx: DriverContext = {
    pi: {},
    issue: 799,
    issues: [799],
    repoRoot: repo,
    dispatchFn,
    verifyExecFn: realSh,
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture — the pi binding is never touched on this path
  } as unknown as DriverContext;
  try {
    await runDevelopTopological(
      ctx,
      state,
      ["default"],
      state.pipelineState.workstreams as never,
      [799],
      dispatchFn,
      realSh,
      Date.now(),
      "job-799",
    );
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_NOTIFY_CMD = undefined;
    else process.env.PI_ENSEMBLE_NOTIFY_CMD = prev;
  }
  return existsSync(out) ? readFileSync(out, "utf8") : "";
}

// W1 — a slow develop step crossing the threshold → the hook received it
await withEnv("PI_ENSEMBLE_STEP_NOTICE_MS", "150", async () => {
  const { repo, state } = mkDevelopFixture();
  const text = await runWithRecorder(repo, state, mkDispatch(400));
  const count = (text.match(/still running/g) ?? []).length;
  assert(
    count === 1,
    `slow develop step (400ms > 150ms threshold) → exactly ONE running-slow notice (hook output: ${JSON.stringify(text.slice(0, 160))})`,
  );
});

// W2 — a fast develop step finishing well under the threshold → NO notice
await withEnv("PI_ENSEMBLE_STEP_NOTICE_MS", "60_000", async () => {
  const { repo, state } = mkDevelopFixture();
  const text = await runWithRecorder(repo, state, mkDispatch(50));
  assert(
    text.trim() === "",
    `fast develop step (50ms << 60s threshold) → NO notice (hook output: ${JSON.stringify(text.slice(0, 120))})`,
  );
});

// W3 — a broken hook cannot hurt the step (the fails-open contract at the
// seam: a missing binary resolves to a failed notify, and the step still
// completes normally — no throw, no extra notice).
await withEnv("PI_ENSEMBLE_STEP_NOTICE_MS", "150", async () => {
  const { repo, state } = mkDevelopFixture();
  const dispatchFn = mkDispatch(400);
  const prev = process.env.PI_ENSEMBLE_NOTIFY_CMD;
  process.env.PI_ENSEMBLE_NOTIFY_CMD = "this-binary-does-not-exist-799f";
  try {
    await runDevelopTopological(
      // biome-ignore lint/suspicious/noExplicitAny: driver fixture — the pi binding is never touched on this path
      ({ pi: {}, issue: 799, issues: [799], repoRoot: repo, dispatchFn, verifyExecFn: realSh }) as any,
      state,
      ["default"],
      state.pipelineState.workstreams as never,
      [799],
      dispatchFn,
      realSh,
      Date.now(),
      "job-799",
    );
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_NOTIFY_CMD = undefined;
    else process.env.PI_ENSEMBLE_NOTIFY_CMD = prev;
  }
  assert(true, "W3: a broken hook did not throw and the step completed (no exception reached here)");
});

console.log(`\nexit ${exit}`);
process.exit(exit);
