/**
 * work-driver-shutdown — a session shutdown is not a step failure.
 *
 * `session_shutdown` aborts every in-flight job, the driver's child included.
 * The driver used to read that as the step failing: it appended
 * `cap-hit: step-failed:<step>` — a diagnosis of its own abort — and entered
 * the handoff step, which needs an ops dispatch and forge calls that cannot
 * complete in a process that is exiting. The cycle was left at
 * `status: running, step: handoff` with a cap nobody had earned, and nothing
 * said why it ended (tehas #97: a reviewed, pushed change 47 s into its last
 * fix pass, reported as a failed lens fix).
 *
 * The driver now treats a shutdown as the crash #382 already knows how to
 * survive, plus one line saying so. It routes nothing and starts nothing; the
 * step's in-memory result is discarded, because every failure in it is the
 * abort's doing. What stays on disk is whatever the step last persisted — for
 * a step that write-aheads, `beginDispatch`'s record, which is exactly the
 * shape the next `/work <N>` resumes from once this process is gone. No new
 * status: `running` + a dead owner already means "resumable", and a caller
 * that wants to know whether a `running` file is live must read
 * `owner.pid`, as `classifyRunningState` does.
 *
 * Everything here is synchronous. The process may not outlive an `await`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { notifyAgent } from "./agent-message.ts";
import { sessionShutdownReason } from "./session-shutdown.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import * as workWidget from "./work-widget.ts";
import {
  WORK_STATE_SCHEMA_VERSION,
  type WorkState,
  type WorkStep,
  appendEvent,
  detectInconsistencies,
  workStateFile,
  writeStateSync,
} from "./workflow-state.ts";

/** True once `session_shutdown` has fired: no new cycle may start. */
export function sessionEnding(): boolean {
  return sessionShutdownReason() !== undefined;
}

/** The branch tip, when the cycle has a branch and git can still say. */
function headShaOf(repoRoot: string, branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  try {
    return (
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * If the session is shutting down, record that this cycle was interrupted at
 * `step` and tell the caller to stop — before a step starts, and when one
 * returns or throws. Returns false (and does nothing) while the session
 * lives, and for a step that reached a terminal status: a merge that landed
 * or a handoff that got its comment out has finished, and the loop's own
 * terminal path records it.
 *
 * The event is appended to the state ON DISK, not to `state`: a step that was
 * cut off returns a state describing the abort as its own failure.
 */
export function interruptedByShutdown(ctx: DriverContext, state: WorkState, step: WorkStep) {
  const reason = sessionShutdownReason();
  if (reason === undefined || state.pipelineState.status !== "running") return false;
  workWidget.clear(ctx.issue);
  const branch = state.pipelineState.branchName;
  const headSha = headShaOf(ctx.repoRoot, branch);
  // Why re-entry would refuse this file, if it would. A step that does not
  // write-ahead leaves the previous boundary on disk, which the resume check
  // reads as drift — true of a crash there too, and said rather than hidden.
  let refusal: string | undefined = "no readable state file";
  try {
    const disk = JSON.parse(readFileSync(workStateFile(ctx.repoRoot, ctx.issue), "utf8"));
    if (disk?.schemaVersion === WORK_STATE_SCHEMA_VERSION) {
      refusal = detectInconsistencies(disk as WorkState)[0];
      writeStateSync(
        ctx.repoRoot,
        appendEvent(disk as WorkState, {
          kind: "cycle-interrupted",
          at: Date.now(),
          step,
          reason,
          ...(branch ? { branch } : {}),
          ...(headSha ? { headSha } : {}),
          resumable: refusal === undefined,
        }),
      );
    }
  } catch (err) {
    trace(`work-driver: could not record the interruption: ${(err as Error).message}`);
  }
  const where = branch ? ` — work on ${branch}${headSha ? ` at ${headSha.slice(0, 8)}` : ""}` : "";
  const next =
    refusal === undefined
      ? `state is resumable — run /work ${ctx.issue}`
      : `/work ${ctx.issue} will refuse this state (${refusal})`;
  const line = `cycle interrupted: session shutdown (${reason}) during ${step}; ${next}${where}`;
  // `quit` tears the session down, so stderr is the one channel still read;
  // any other reason leaves a live TUI that a raw write would corrupt.
  if (reason === "quit") process.stderr.write(`[pi-rukas] ${line}\n`);
  else {
    try {
      notifyAgent(
        ctx.host,
        `pi-rukas:driver-event v1 kind=interrupted issue=${ctx.issue} at=${new Date().toISOString()}\npi-rukas: /work ${line}`,
      );
    } catch {
      /* the runtime that would deliver it is the one going away */
    }
  }
  return true;
}
