#!/usr/bin/env bun
/**
 * A session shutdown under a running /work cycle is not a step failure.
 *
 * The incident (tehas #97): Pi was quit while the driver awaited a lens-fix
 * developer. `session_shutdown` aborted the child, the driver read the abort
 * as the step failing, recorded `cap-hit: step-failed:lens-fix`, and entered
 * a handoff it could not finish — leaving `status: running, step: handoff`
 * and nothing that said why the cycle ended.
 *
 *   A. shutdown mid-dispatch: no cap-hit, no handoff, the write-ahead record
 *      left on disk, ONE line saying what happened — and the next run resumes.
 *   B. the control: the same abort WITHOUT a shutdown (`dispatch_kill`) keeps
 *      today's behaviour exactly — `step-failed:lens-fix` → handoff.
 *   C. a step that does not write-ahead: the record does not claim a resume
 *      the re-entry check would refuse; a terminalized step is left alone.
 *   D. no cycle starts once the session is shutting down.
 *
 * The shutdown is delivered through the real `session_shutdown` hook, so the
 * test also proves the hook is what sets the flag. No Pi spawn happens.
 */

import { exec } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAsyncJobsLifecycle } from "../src/async-jobs-lifecycle.ts";
import { clearSessionShutdownForTesting } from "../src/session-shutdown.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { interruptedByShutdown } from "../src/work-driver-shutdown.ts";
import { classifyRunningState } from "../src/work-driver-resume.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, workStateFile, writeState } from "../src/workflow-state.ts";
import { mkLensSummary, setupSpawnGuard } from "./test-helpers.ts";

const execp = promisify(exec);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
setupSpawnGuard();

/** A fake Pi that keeps the `session_shutdown` handler the extension registers. */
function makeFakePi() {
  const sent: string[] = [];
  let onShutdown: ((event?: { reason?: string }) => unknown) | undefined;
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
    on: (event: string, handler: (event?: { reason?: string }) => unknown) => {
      if (event === "session_shutdown") onShutdown = handler;
    },
  } as unknown as ExtensionAPI;
  registerAsyncJobsLifecycle(pi);
  return { pi, sent, quit: () => onShutdown?.({ reason: "quit" }) };
}

const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
});

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "developer",
    ok: true,
    text: "stub output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

/** What `spawn.ts` returns for a child whose abort signal fired. */
const aborted = () => mkResult({ ok: false, exitCode: null, text: "", killCause: "abort" });

/** A real repo with a feature branch, and a cycle parked at lens-fix round 1. */
async function seedAtLensFix(issue: number): Promise<{ dir: string; head: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-shutdown-"));
  const sh = (cmd: string) => execp(cmd, { cwd: dir, shell: "/bin/bash" });
  await sh('git init -q && git config user.email "t@t" && git config user.name "T"');
  await fs.writeFile(path.join(dir, "base.txt"), "hello\n");
  await sh("git add base.txt && git commit -q -m initial");
  await sh("git update-ref refs/remotes/origin/main HEAD");
  await sh("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
  await sh("git checkout -qb feature/shutdown-test");
  await fs.writeFile(path.join(dir, "feature.txt"), "const x = eval(input);\n");
  await sh("git add feature.txt && git commit -q -m feature");
  const head = (await sh("git rev-parse HEAD")).stdout.trim();
  let s = initialState(issue, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "lens-fix",
      lastCompletedStep: "commit-pr",
      worktrees: { default: dir },
      workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
      branchName: "feature/shutdown-test",
      prNumber: 5800,
      reviewRound: 1,
    },
    eventLog: [
      {
        kind: "lens-issues-found" as const,
        at: 2_000_000,
        jobId: "j-lens-1",
        round: 1,
        findings: JSON.stringify([
          {
            lens: "SECURITY",
            severity: "MEDIUM",
            path: "feature.txt",
            line: 1,
            title: "eval() usage",
            description: "Use of eval is unsafe",
            suggestion: "Replace with safe alternative",
          },
        ]),
        verdict: "ISSUES_FOUND" as const,
      },
    ],
  };
  await writeState(dir, s);
  return { dir, head };
}

/** Run `fn` collecting what it writes to stderr (the driver's `quit` channel). */
async function captureStderr(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = real;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// A. Shutdown while the lens-fix developer is in flight.
// ---------------------------------------------------------------------------
{
  const issue = 580;
  const { dir, head } = await seedAtLensFix(issue);
  try {
    const fake = makeFakePi();
    const labels: string[] = [];
    let shuttingDown = true;
    const ctx: DriverContext = {
      host: fake.pi,
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        labels.push(opts?.label ?? spec.role);
        if (opts?.label?.startsWith("developer:lens-fix")) {
          if (!shuttingDown) return mkResult({ text: "Fixed." });
          // The hook fires, the child is aborted, and its dispatch returns.
          fake.quit();
          return aborted();
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`smoke: stop at ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          loopOutcome: "approved",
          adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
          text: "Adversarial APPROVED.",
        }),
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    };

    const stderr = await captureStderr(() => runWorkDriver(ctx));
    const after = await readState(dir, issue);
    const events = after?.eventLog ?? [];
    const ps = after?.pipelineState;

    assert(
      !events.some((e) => e.kind === "cap-hit"),
      `A: no cap-hit is recorded for the abort (got: ${events
        .filter((e) => e.kind === "cap-hit")
        .map((e) => (e as { cap: string }).cap)
        .join(", ")})`,
    );
    assert(!labels.includes("ops:handoff"), "A: no handoff dispatch is started");
    assert(
      ps?.status === "running" && ps?.currentStep === "lens-fix",
      `A: the state file stays at running/lens-fix (got ${ps?.status}/${ps?.currentStep})`,
    );
    assert(
      !events.some((e) => e.kind === "dispatch-failed"),
      "A: the aborted dispatch is not recorded as a failed one",
    );
    const verdict = after ? classifyRunningState(after) : undefined;
    assert(
      verdict?.action === "resume" && verdict.step === "lens-fix",
      `A: the write-ahead record survives, so re-entry resolves to resume (got ${verdict?.action})`,
    );
    const tail = events[events.length - 1];
    assert(
      tail?.kind === "cycle-interrupted" &&
        tail.step === "lens-fix" &&
        tail.reason === "quit" &&
        tail.resumable === true,
      `A: the tail event says the cycle was interrupted by the shutdown (got ${JSON.stringify(tail)})`,
    );
    assert(
      tail?.kind === "cycle-interrupted" &&
        tail.branch === "feature/shutdown-test" &&
        tail.headSha === head,
      "A: ...and names the branch and its head sha",
    );
    const said = stderr.filter((l) => l.includes("cycle interrupted"));
    assert(
      said.length === 1 &&
        said[0]?.includes(
          `cycle interrupted: session shutdown (quit) during lens-fix; state is resumable — run /work ${issue}`,
        ) === true,
      `A: exactly one line says why the cycle ended (got ${JSON.stringify(said)})`,
    );
    assert(!existsSync(`${workStateFile(dir, issue)}.sync.tmp`), "A: no temp file is left behind");

    // The next `/work <N>` — a new session, so the flag is gone.
    clearSessionShutdownForTesting();
    shuttingDown = false;
    labels.length = 0;
    const next = makeFakePi();
    await runWorkDriver({ ...ctx, host: next.pi }).catch(() => {});
    const resumed = await readState(dir, issue);
    assert(
      next.sent.some((m) => m.includes("kind=resume")),
      "A: the next run announces a resume",
    );
    assert(
      labels[0]?.startsWith("developer:lens-fix") === true,
      `A: ...and re-dispatches the interrupted lens-fix (got ${labels[0]})`,
    );
    assert(
      (resumed?.eventLog ?? []).some(
        (e) => e.kind === "dispatch-completed" && e.step === "lens-fix",
      ),
      "A: ...which completes this time",
    );
  } finally {
    clearSessionShutdownForTesting();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// B. Control — the same abort with no shutdown (an operator's dispatch_kill).
// ---------------------------------------------------------------------------
{
  const issue = 581;
  const { dir } = await seedAtLensFix(issue);
  try {
    const fake = makeFakePi();
    const labels: string[] = [];
    const ctx: DriverContext = {
      host: fake.pi,
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        labels.push(opts?.label ?? spec.role);
        if (opts?.label?.startsWith("developer:lens-fix")) return aborted();
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`smoke: stop at ${spec.role} / ${opts?.label}`);
      },
    };
    const stderr = await captureStderr(() => runWorkDriver(ctx).catch(() => {}));
    const after = await readState(dir, issue);
    const events = after?.eventLog ?? [];
    assert(
      events.some((e) => e.kind === "cap-hit" && e.cap === "step-failed:lens-fix"),
      "B: a kill without a shutdown is still step-failed:lens-fix",
    );
    assert(labels.includes("ops:handoff"), "B: ...and still hands off");
    assert(
      after?.pipelineState.status !== "running",
      `B: ...and still terminalizes (got ${after?.pipelineState.status})`,
    );
    assert(
      !events.some((e) => e.kind === "cycle-interrupted") &&
        !stderr.some((l) => l.includes("cycle interrupted")),
      "B: ...with no interruption recorded or announced",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// C. A step with no write-ahead (lens-review, adversarial): what is on disk is
//    the previous boundary, which the re-entry check reads as drift. The
//    record must not promise a resume that check would refuse.
// ---------------------------------------------------------------------------
{
  const issue = 582;
  const { dir } = await seedAtLensFix(issue);
  try {
    const seeded = await readState(dir, issue);
    if (!seeded) throw new Error("seed missing");
    const boundary = {
      ...seeded,
      pipelineState: { ...seeded.pipelineState, currentStep: "lens-review" as const },
      eventLog: [{ kind: "step-started" as const, step: "commit-pr" as const, at: 1_500_000 }],
    };
    await writeState(dir, boundary);
    const fake = makeFakePi();
    const ctx: DriverContext = { host: fake.pi, repoRoot: dir, issue };
    assert(
      interruptedByShutdown(ctx, boundary, "lens-review") === false,
      "C: a live session interrupts nothing",
    );
    fake.quit();
    let stopped = false;
    const stderr = await captureStderr(async () => {
      stopped = interruptedByShutdown(ctx, boundary, "lens-review");
    });
    const after = await readState(dir, issue);
    const tail = after?.eventLog[after.eventLog.length - 1];
    assert(
      stopped && tail?.kind === "cycle-interrupted" && tail.step === "lens-review",
      "C: the interruption is still recorded",
    );
    assert(
      tail?.kind === "cycle-interrupted" && tail.resumable === false,
      `C: ...without claiming a resume the re-entry check refuses (got ${JSON.stringify(tail)})`,
    );
    assert(
      stderr.some((l) => l.includes(`/work ${issue} will refuse this state`)) &&
        !stderr.some((l) => l.includes("state is resumable")),
      "C: ...and the line says so too",
    );
    assert(
      interruptedByShutdown(
        ctx,
        { ...boundary, pipelineState: { ...boundary.pipelineState, status: "merged" } },
        "merged",
      ) === false,
      "C: a step that reached a terminal status is left to the loop's terminal path",
    );
  } finally {
    clearSessionShutdownForTesting();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// D. Nothing starts once the session is shutting down (the queue's next group).
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-shutdown-start-"));
  try {
    const fake = makeFakePi();
    fake.quit();
    let dispatched = 0;
    const outcome = await runWorkDriver({
      host: fake.pi,
      repoRoot: dir,
      issue: 583,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async () => {
        dispatched += 1;
        return mkResult();
      },
    });
    assert(
      outcome.started === false && dispatched === 0 && !existsSync(workStateFile(dir, 583)),
      "D: a cycle asked to start during shutdown does not start, and writes no state",
    );
    assert(
      fake.sent.some((m) => m.includes("#583 not started") && m.includes("shutting down")),
      "D: the refusal tells the operator the cycle did not start and why",
    );
  } finally {
    clearSessionShutdownForTesting();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
