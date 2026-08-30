/**
 * work-driver-resume-reattach — session re-attach capability for crash-resume.
 *
 * Extracted from work-driver.ts (attemptReattachInResume) and
 * work-driver-resume.ts (attemptReattach + spawn helpers) as part of
 * issue #171 file-size hygiene.
 *
 * #543 F3a — session re-attach (capability, DEFAULT-OFF).
 */

import { spawn } from "node:child_process";
import { notifyAgent } from "./agent-message.ts";
import { emitStepCompleted } from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { nextStep } from "./work-driver-context.ts";
import {
  FAN_OUT_STEPS,
  classifyRunningState as _classifyRunningState,
  clearForResume as _clearForResume,
  explainRefusal as _explainRefusal,
  explainResume as _explainResume,
  reattachPrompt as _reattachPrompt,
  resolveReattach as _resolveReattach,
  resumeEnabled as _resumeEnabled,
} from "./work-driver-resume.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import { writeState } from "./workflow-state.ts";

// Re-export resume helpers that work-driver.ts still needs.
export function resolveReattach(
  step: WorkStep,
  inFlight: { jobId: string; transcriptPath?: string }[],
  now: number,
  originalTimeoutMs?: number,
  dispatchStartedAt?: number,
  opts?: { fs?: { existsSync: (p: string) => boolean } },
): { mode: "re-dispatch" } | { mode: "reattach"; transcriptPath: string; grantMs: number } {
  return _resolveReattach(step, inFlight, now, originalTimeoutMs, dispatchStartedAt, opts ?? {});
}

export function reattachPrompt(step: WorkStep, role: string): string {
  return _reattachPrompt(step, role);
}

export function resumeEnabled(): boolean {
  return _resumeEnabled();
}

export function clearForResume(state: WorkState): WorkState {
  return _clearForResume(state);
}

export function classifyRunningState(state: WorkState, selfPid?: number) {
  return _classifyRunningState(state, selfPid);
}

export function explainRefusal(issue: number, ownerPid: number): string {
  return _explainRefusal(issue, ownerPid);
}

export function explainResume(issue: number, step: WorkStep, lost: number): string {
  return _explainResume(issue, step, lost);
}

export interface ReattachResult {
  result: DispatchResult;
  reattach: true;
}

export async function attemptReattach(
  transcriptPath: string,
  step: WorkStep,
  role: string,
  grantMs: number,
  spawnReattach: (
    args: string[],
    env: Record<string, string>,
    prompt: Record<string, string>,
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }> = defaultSpawnReattach,
): Promise<ReattachResult | { reattach: false }> {
  const resumePromptText = reattachPrompt(step, role);
  const childArgs = ["--mode", "rpc", "--no-extensions", "--session", transcriptPath];
  const currentScript = process.argv[1];
  const looksLikePiCli =
    currentScript &&
    !currentScript.startsWith("/$bunfs/") &&
    /pi-coding-agent.*\/(dist\/(?:cli\.)?c?js|mjs)$/i.test(currentScript);
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }

  if (spawnReattach !== defaultSpawnReattach) {
    return spawnReattach(childArgs, childEnv, { type: "prompt", message: resumePromptText })
      .then((out): ReattachResult | { reattach: false } =>
        out.exitCode === 0
          ? buildReattachResult(role, transcriptPath, grantMs, out.stdout)
          : { reattach: false },
      )
      .catch((): ReattachResult | { reattach: false } => ({ reattach: false }));
  }
  return realSpawnReattach(childArgs, childEnv, resumePromptText, grantMs);
}

async function realSpawnReattach(
  childArgs: string[],
  childEnv: Record<string, string>,
  resumePromptText: string,
  grantMs: number,
): Promise<ReattachResult | { reattach: false }> {
  const currentScript = process.argv[1];
  const looksLikePiCli =
    currentScript &&
    !currentScript.startsWith("/$bunfs/") &&
    /pi-coding-agent.*\/(dist\/(?:cli\.)?c?js|mjs)$/i.test(currentScript);
  let command: string;
  let args: string[];
  if (looksLikePiCli) {
    command = process.execPath;
    args = [currentScript, ...childArgs];
  } else {
    command = "pi";
    args = childArgs;
  }

  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
  const stdoutChunks: Buffer[] = [];
  let stdoutSize = 0;
  const MAX_STDOUT = 1024 * 1024;

  child.stdout?.on("data", (d: Buffer) => {
    stdoutChunks.push(d);
    stdoutSize += d.length;
    while (stdoutSize > MAX_STDOUT && stdoutChunks.length > 1) {
      const evicted = stdoutChunks.shift();
      if (evicted) stdoutSize -= evicted.length;
    }
  });
  child.stderr?.on("data", () => {
    /* discarded */
  });

  try {
    child.stdin?.write(`${JSON.stringify({ type: "prompt", message: resumePromptText })}\n`);
  } catch {
    /* child already gone */
  }

  const maxWait = grantMs + 30_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, maxWait);

  const [exitCode] = (await new Promise<[number | null]>((resolve) => {
    child.on("exit", (code) => resolve([code]));
  })) as [number | null];
  clearTimeout(timeout);
  try {
    child.kill("SIGKILL");
  } catch {
    /* best-effort */
  }

  if (timedOut || exitCode !== 0) return { reattach: false };
  const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
  return buildReattachResult("", "", maxWait, rawStdout);
}

function buildReattachResult(
  role: string,
  transcriptPath: string,
  grantMs: number,
  rawStdout: string,
): ReattachResult | { reattach: false } {
  const lines = rawStdout
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length === 0) return { reattach: false };

  let lastText = "";
  let toolCallCount = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "message_end") {
        const msg = event.message as Record<string, unknown> | undefined;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content as Array<Record<string, unknown>>) {
            if (block.type === "text") lastText += `${block.text ?? ""}\n`;
            else if (block.type === "toolCall") toolCallCount++;
          }
        }
      }
    } catch {
      /* Not JSON */
    }
  }
  if (!lastText.trim()) return { reattach: false };

  return {
    result: {
      role,
      ok: true,
      text: lastText.trim(),
      toolUses: new Array(toolCallCount).fill(null),
      ms: grantMs,
      exitCode: 0,
      transcriptPath,
    } as DispatchResult,
    reattach: true,
  };
}

async function defaultSpawnReattach(): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return { exitCode: 0, stdout: "", stderr: "" };
}

/**
 * #573 — attempt reattach in the crash-resume path. Returns whether the
 * resumed child produced a valid result (skip runStep) and the updated state.
 *
 * The resume path reads `transcriptPath` from the in-flight `dispatch-started`
 * event, calls `resolveReattach` to check if reattach is possible, and
 * `attemptReattach` to actually reconnect. On success, emits a
 * `dispatch-completed` event and advances to the next step.
 */
export async function attemptReattachInResume(
  ctx: { repoRoot: string },
  state: WorkState,
  verdict: { step: WorkStep; jobIds: string[] },
  inFlightEvents: Array<Record<string, unknown>>,
): Promise<{ shouldSkipStep: boolean; nextState: WorkState | undefined }> {
  const startedEvt = inFlightEvents.find(
    (e) => (e as { jobId?: string })?.jobId === verdict.jobIds[0],
  ) as (WorkEvent & { jobId?: string; transcriptPath?: string; role?: string }) | undefined;
  const reattachStep = verdict.step;
  const reattachRole = startedEvt?.role ?? verdict.step;
  const reattachNow = Date.now();
  const originalTimeoutMs = (startedEvt as { dispatchTimeoutMs?: number })?.dispatchTimeoutMs;
  const dispatchStartedAt = startedEvt?.at;
  const reattach = resolveReattach(
    reattachStep,
    inFlightEvents.map((e) => ({
      jobId: (e as { jobId?: string })?.jobId ?? "",
      transcriptPath: (e as { transcriptPath?: string })?.transcriptPath,
    })),
    reattachNow,
    originalTimeoutMs,
    dispatchStartedAt,
    {},
  );
  if (reattach.mode !== "reattach") return { shouldSkipStep: false, nextState: undefined };

  trace(
    `work-driver: crash-resume → reattach ${reattachStep} (transcriptPath=${reattach.transcriptPath}, grant=${reattach.grantMs}ms)`,
  );
  const reattachResult = await attemptReattach(
    reattach.transcriptPath,
    reattachStep,
    reattachRole,
    reattach.grantMs,
  );
  if ("result" in reattachResult && reattachResult.reattach) {
    trace(`work-driver: crash-resume reattach succeeded for ${reattachStep} — skipping step body`);
    let next = appendEvent(state, {
      kind: "dispatch-completed",
      step: reattachStep,
      role: reattachRole,
      jobId: verdict.jobIds[0] ?? "",
      label: reattachRole,
      ok: true,
      ms: reattach.grantMs,
      at: reattachNow,
      summary: "crash-resume reattach",
    });
    const decision = nextStep(next);
    if (decision.kind === "done") return { shouldSkipStep: true, nextState: next };
    if (decision.kind !== "step") return { shouldSkipStep: false, nextState: undefined };
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, currentStep: decision.step },
    };
    await writeState(ctx.repoRoot, next);
    emitStepCompleted(reattachStep, 0, 9, reattach.grantMs);
    return { shouldSkipStep: true, nextState: next };
  }
  trace(
    `work-driver: crash-resume reattach failed for ${reattachStep} — falling through to re-dispatch`,
  );
  return { shouldSkipStep: false, nextState: undefined };
}
