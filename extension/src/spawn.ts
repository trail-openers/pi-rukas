import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { adapterFor } from "./model-adapters.ts";
import { resolveModel } from "./models.ts";
import { type RunningState, emptyRunningState, ingestEvent } from "./progress.ts";
import { ROLES, isRoleName } from "./roles.ts";
import type { DispatchResult, DispatchSpec } from "./types.ts";

interface SpawnOptions {
  /**
   * Hard cap on child wall-clock. Default 5 minutes. Critical: without a cap,
   * a stalled model API call (Cerebras / Copilot / Anthropic — any provider)
   * leaves the child hung forever and the parent's `await once(child, "exit")`
   * never resolves. Override with PI_ENSEMBLE_SPAWN_TIMEOUT_MS.
   */
  timeoutMs?: number;
  /**
   * Pi's tool-execute AbortSignal — fires when the user hits Esc to cancel
   * the running tool. We listen on this and kill the child with SIGTERM so
   * cancellation actually propagates instead of leaving Pi stuck.
   */
  signal?: AbortSignal;
  /**
   * Group children from the same dispatch_parallel call under a shared id so
   * their session files sort together on disk.
   */
  runId?: string;
  /** Sequence number within a parallel batch (helps disambiguate identical roles). */
  seq?: number;
  /**
   * Extra Pi CLI flags to insert before the positional prompt. Used by
   * specialised dispatchers (e.g. lens review pinning a specific --skill).
   */
  extraArgs?: string[];
  /**
   * Optional tag appended to the transcript filename (e.g. "security",
   * "performance"). Distinguishes children sharing the same role within a
   * single parallel batch.
   */
  tag?: string;
  /**
   * Live-progress callback. Fires every time the child emits a `message_end`
   * event with `role: "assistant"` — i.e. once per turn completion. The
   * snapshot is a defensive copy; safe to mutate downstream.
   */
  onProgress?: (snapshot: RunningState) => void;
}

const DEFAULT_SPAWN_TIMEOUT_MS = (() => {
  const env = Number(process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 5 * 60_000;
})();

/**
 * Where per-child transcripts live. One file per spawned specialist, grouped
 * by date so old runs are easy to prune. The user can `pi --session <path>`
 * to replay or just open the JSON.
 */
function transcriptPathFor(role: string, runId: string, seq?: number, tag?: string): string {
  const piAgentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const parts = [role];
  if (tag) parts.push(tag);
  if (seq != null) parts.push(String(seq));
  return path.join(piAgentDir, "ensemble-runs", date, `${runId}-${parts.join("-")}.json`);
}

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Pi --mode json event shape (Pi 0.75.3). The canonical assembled answer is at
// agent_end.messages[]; usage stats come from message_end.message.usage on
// assistant messages.
interface PiContentBlock {
  type: "text" | "thinking" | "toolCall" | string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}
interface PiMessage {
  role: "user" | "assistant";
  content?: PiContentBlock[];
  toolResults?: unknown[];
  usage?: PiUsage;
  model?: string;
  provider?: string;
  api?: string;
  stopReason?: string;
}
interface PiJsonEvent {
  type?: string;
  messages?: PiMessage[];
  message?: PiMessage;
}

/**
 * Resolve the pi binary. When this code runs inside a pi process (the
 * extension is loaded), argv[1] is Pi's CLI entry script and we re-invoke the
 * SAME pi build (avoids PATH ambiguity, matches Pi's own subagent example).
 *
 * When this code runs outside Pi (smoke tests under `bun run`), argv[1] is the
 * test file and we'd recursively spawn ourselves — guard against that by only
 * trusting argv[1] when it looks like a Pi CLI entrypoint.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const looksLikePiCli =
    currentScript &&
    !currentScript.startsWith("/$bunfs/") &&
    /pi-coding-agent.*\/(dist\/)?cli\.(js|cjs|mjs)$/i.test(currentScript);
  if (looksLikePiCli) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  // Fall back to `pi` on PATH — works for smoke tests and any other context
  // where argv[1] isn't a Pi CLI script.
  return { command: "pi", args };
}

export async function spawnSpecialist(
  spec: DispatchSpec,
  opts: SpawnOptions = {},
): Promise<DispatchResult> {
  if (!isRoleName(spec.role)) throw new Error(`Unknown role: ${spec.role}`);
  const role = ROLES[spec.role];
  const systemPrompt = await fs.readFile(role.promptFile, "utf8");
  const cwd = spec.cwd ?? process.cwd();

  // Write role prompt to a temp file; Pi's --append-system-prompt accepts a
  // file path and appends file contents to its default safety prompt. This
  // both keeps Pi's tool-use guidance intact and avoids stuffing 15K through
  // argv.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-"));
  const tmpPromptFile = path.join(tmpDir, `${spec.role}.md`);
  await fs.writeFile(tmpPromptFile, systemPrompt);

  // Per-child transcript path. Pi will write its native session JSON here so
  // the user can inspect/replay the child's full event log post-hoc.
  const runId = opts.runId ?? makeRunId();
  const transcriptPath = transcriptPathFor(spec.role, runId, opts.seq, opts.tag);
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

  // Resolve which model this child should run on (spec > role env > global env > Pi default)
  const modelChoice = resolveModel(spec.role, spec.model);

  const childArgs = [
    "--mode",
    "json",
    "-p",
    "--no-extensions",
    "--session",
    transcriptPath,
    "--append-system-prompt",
    tmpPromptFile,
  ];
  if (modelChoice.model) {
    childArgs.push("--model", modelChoice.model);
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    childArgs.push(...opts.extraArgs);
  }
  childArgs.push(spec.prompt); // positional prompt — canonical form
  const invocation = getPiInvocation(childArgs);

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    // stdin "ignore" is critical: leaving stdin open as a pipe makes Pi wait
    // for input even in -p mode and the spawn hangs forever.
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const start = Date.now();
  const events: PiJsonEvent[] = [];
  let stderr = "";
  // Running state shared with the parent's onProgress callback. Each child
  // gets its own state; lens-review aggregates over 6 of them in parallel.
  const runningState = emptyRunningState(spec.role, opts.tag);

  if (!child.stdout || !child.stderr) {
    throw new Error("Failed to attach to child stdio");
  }

  const stdoutRl = createInterface({ input: child.stdout });
  stdoutRl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: PiJsonEvent | null = null;
    try {
      parsed = JSON.parse(trimmed) as PiJsonEvent;
    } catch {
      stderr += `${trimmed}\n`;
      return;
    }
    events.push(parsed);
    // Stream into the running state. ingestEvent returns true only when an
    // assistant turn completed (the right cadence to surface to the user).
    if (ingestEvent(runningState, parsed as Parameters<typeof ingestEvent>[1], start)) {
      opts.onProgress?.({ ...runningState, usage: { ...runningState.usage } });
    }
  });
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });

  // Always cap wall-clock — see DEFAULT_SPAWN_TIMEOUT_MS comment. A stalled
  // child without a timeout hangs the parent indefinitely (observed in the
  // wild: overnight stuck session).
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    // Escalate to SIGKILL if the child ignores SIGTERM for 5s.
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);

  // Propagate Pi's user-cancel (Esc) signal: kill the child so the tool
  // execute promise resolves and Pi un-stuck immediately.
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let exitCode: number | null = null;
  try {
    [exitCode] = (await once(child, "exit")) as [number | null];
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
    // Best-effort cleanup of the temp prompt file; ignore errors.
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (timedOut) {
    stderr += `\n[pi-ensemble] killed after ${timeoutMs}ms timeout`;
  }
  if (aborted) {
    stderr += "\n[pi-ensemble] cancelled by user (Esc)";
  }

  const ms = Date.now() - start;
  const result = collapseEvents(events, spec.role, ms, exitCode, stderr);
  result.transcriptPath = transcriptPath;
  result.modelSource = modelChoice.source;
  if (modelChoice.model && !result.model) {
    // collapseEvents only sets `model` from assistant message metadata, which
    // is present when the child actually got a reply. If the child failed
    // before any assistant turn (rare), surface the requested model anyway.
    result.model = modelChoice.model;
  }

  // Final onProgress emit — flips the child from running to done so the
  // aggregator's last render shows the resolved icon (✓ / ✗) instead of the
  // running spinner.
  runningState.done = true;
  runningState.ok = result.ok;
  runningState.elapsedMs = ms;
  if (result.model && !runningState.model) runningState.model = result.model;
  opts.onProgress?.({ ...runningState, usage: { ...runningState.usage } });
  return result;
}

function collapseEvents(
  events: PiJsonEvent[],
  role: string,
  ms: number,
  exitCode: number | null,
  stderr: string,
): DispatchResult {
  // Prefer agent_end's assembled messages; fall back to last assistant
  // message_end if agent_end is missing.
  const agentEnd = [...events].reverse().find((e) => e.type === "agent_end");
  let messages: PiMessage[] = agentEnd?.messages ?? [];
  if (messages.length === 0) {
    const lastMessageEnd = [...events]
      .reverse()
      .find((e) => e.type === "message_end" && e.message?.role === "assistant");
    if (lastMessageEnd?.message) messages = [lastMessageEnd.message];
  }

  const textParts: string[] = [];
  const toolUses: PiContentBlock[] = [];
  let turns = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let model: string | undefined;
  let provider: string | undefined;
  let api: string | undefined;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    turns++;
    if (msg.model && !model) model = msg.model;
    if (msg.provider && !provider) provider = msg.provider;
    if (msg.api && !api) api = msg.api;
    if (msg.usage) {
      usage.input += msg.usage.input ?? 0;
      usage.output += msg.usage.output ?? 0;
      usage.cacheRead += msg.usage.cacheRead ?? 0;
      usage.cacheWrite += msg.usage.cacheWrite ?? 0;
      usage.cost += msg.usage.cost?.total ?? 0;
    }
    // Per-message model adapter: handles quirks specific to the LLM family
    // that emitted this message (e.g. GLM's "None" placeholder text blocks).
    // Default adapter is no-op, so unknown models pass through unchanged.
    const adapter = adapterFor(msg.model, msg.provider);
    for (const block of msg.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        if (adapter.isArtifactText?.(block.text)) continue;
        textParts.push(block.text);
      } else if (block.type === "toolCall") {
        toolUses.push(block);
      }
    }
  }

  // Join with double-newline so distinct text blocks across turns (separated
  // by tool calls in between) stay visually delimited instead of concatenated.
  const text = textParts.filter((t) => t.trim()).join("\n\n");
  return {
    role,
    ok: exitCode === 0,
    text: text || stderr || "(no output)",
    toolUses,
    ms,
    exitCode,
    usage: { ...usage, turns },
    model,
    provider,
    api,
  };
}
