/**
 * Child Pi spawn — the single seam between the orchestrator extension
 * and every specialist subagent. All dispatch tools (single / parallel /
 * lens-review / adversarial) eventually call `spawnSpecialist` here.
 *
 * Responsibilities:
 *
 *   1. `--mode rpc` protocol — children run with stdin held open so we
 *      can inject `{type:"prompt"|"steer"|"abort"|"follow_up", …}` JSON
 *      commands. The initial prompt is sent via stdin after spawn, not as
 *      argv, so `dispatch_steer` (#152) shares the same channel.
 *
 *   2. Extension auto-forward — `discoverInstalledExtensions` scans
 *      `$PI_AGENT_DIR/extensions/` (default `~/.pi/agent/extensions/`)
 *      and re-injects every installed extension into the child via
 *      `--extension <real-path>` except pi-ensemble itself. That keeps
 *      `pi-claude-auth`, MCP bridges, etc. reaching subagents without
 *      env-var wiring. `PI_ENSEMBLE_USER_EXTENSION` is an additional
 *      escape hatch for extensions outside the canonical location;
 *      `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1` opts out entirely.
 *
 *   3. JSONL event stream parsing — children emit `agent_end`,
 *      `message_end`, `toolCall`, `usage` events to stdout. We parse
 *      them via `ingestEvent` (progress.ts) for live `onProgress`
 *      callbacks, the dispatch deck footer (#117), and the consolidated
 *      report formatter (async-jobs.ts). The Pi event shape is pinned
 *      and verified by `test-pi-shape-live.ts` (#7).
 *
 *   4. Done detection + transcript path — closes stdin on `agent_end`
 *      so the child exits cleanly; saves the session JSONL under
 *      `$PI_AGENT_DIR/ensemble-runs/<date>/<runId>-<role>[-<tag>].json`
 *      for `/runs` introspection.
 *
 * Subagents do NOT inherit pi-ensemble's permission interceptor — `--no-
 * extensions` suppresses our own load inside the child (so we can't
 * recursively spawn). Their prompt-layer doctrine is the only constraint;
 * MCP server credentials remain the real capability boundary.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { adapterFor } from "./model-adapters.ts";
import { resolveModel } from "./models.ts";
import { type RunningState, emptyRunningState, ingestEvent } from "./progress.ts";
import { ROLES, isRoleName } from "./roles.ts";
import { trace } from "./trace.ts";
import type { DispatchResult, DispatchSpec } from "./types.ts";

interface SpawnOptions {
  /**
   * Hard cap on child wall-clock. Default 30 minutes (DEFAULT_SPAWN_TIMEOUT_MS).
   * Critical: without a cap, a stalled model API call (Cerebras / Copilot /
   * Anthropic — any provider) leaves the child hung forever and the parent's
   * `await once(child, "exit")` never resolves.
   *
   * NOT a PM-callable knob. No agent-facing dispatch tool schema exposes
   * `timeoutMs` — verified across dispatch_specialist, dispatch_parallel,
   * dispatch_lens_review, adversarial_loop. This field exists for internal
   * callers (currently unused in production) and for smoke tests that
   * deliberately use short timeouts to exercise cancel/timeout paths
   * (e.g. test-cancel.ts uses 2s to assert SIGTERM behaviour).
   *
   * Operator/CI override: `PI_ENSEMBLE_SPAWN_TIMEOUT_MS` env var. Not
   * settable by the agent (PM cannot set env vars at runtime).
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
  /**
   * Stdin-handle callback (#153). Fires once after the child process has
   * been spawned and its stdio attached, BEFORE the initial prompt is
   * written. Callers use this to register the stdin handle in a registry
   * (e.g., async-jobs's `childHandles` map) so dispatch_steer can write
   * `{ type: "steer", message }` RPC commands later.
   *
   * The handle's lifetime is the child's lifetime. spawnSpecialist closes
   * stdin on agent_end (done-detection) or process exit; downstream code
   * MUST handle EPIPE / closed-stream errors gracefully.
   */
  onStdin?: (stdin: import("node:stream").Writable) => void;
}

// Hard 30-minute cap on subagent wall-clock (issue #114). Long enough for
// real work (a 6-pass lens review, a multi-round adversarial loop, a deep
// /research sweep) without being unbounded. Operators can tune via the env
// var; PM cannot influence it (no tool schema exposes timeout).
const DEFAULT_SPAWN_TIMEOUT_MS = (() => {
  const env = Number(process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 30 * 60_000;
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

export function applyUserExtension(childArgs: string[], role: string): void {
  const userExt = process.env.PI_ENSEMBLE_USER_EXTENSION;
  if (!userExt) return;
  const isNpmRef = userExt.startsWith("npm:");
  const isAbsPath = userExt.startsWith("/") || userExt.startsWith("~");
  if (!isNpmRef && !isAbsPath) {
    const msg = `pi-ensemble: PI_ENSEMBLE_USER_EXTENSION='${userExt}' rejected (must start with 'npm:' or be an absolute path) — MCP extension will NOT be loaded`;
    console.warn(msg);
    trace(`spawn[${role}]: ${msg}`);
  } else {
    childArgs.push("--extension", userExt);
    trace(`spawn[${role}]: --extension ${userExt}`);
  }
}

// pi-ensemble's own package name. Used by discoverInstalledExtensions to skip
// forwarding ourselves into subagents — otherwise a subagent could call
// dispatch_specialist and recursively spawn another subagent.
const PI_ENSEMBLE_PACKAGE_NAME = "@randomm/pi-ensemble";

interface ExtensionPackageJson {
  name?: string;
  pi?: {
    extensions?: string[];
  };
}

/**
 * Scan `~/.pi/agent/extensions/` (or `$PI_AGENT_DIR/extensions`) for installed
 * Pi extensions and return absolute paths suitable for `--extension <path>`.
 *
 * Subagents launch with `--no-extensions`, which suppresses every installed
 * extension. That breaks anything that depends on extension-injected provider
 * config — most importantly `pi-claude-auth`, which adds the Claude Code
 * identity headers Anthropic now enforces server-side. Auto-forwarding lets
 * subagents inherit the same provider/auth setup the main agent has.
 *
 * Rules:
 *  - Skip if `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1` (global opt-out).
 *  - Skip entries without a readable `package.json`.
 *  - Skip entries whose `package.json` has no `pi.extensions` manifest (not
 *    a Pi extension — e.g. stray directories, half-installed packages).
 *  - Skip pi-ensemble itself by package name (prevents recursive spawn).
 *  - Resolve through `realpathSync` because `~/.pi/agent/extensions/<name>`
 *    is typically a symlink to the source checkout.
 */
export function discoverInstalledExtensions(role: string): string[] {
  if (process.env.PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD === "1") {
    trace(
      `spawn[${role}]: extension auto-forward disabled via PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD`,
    );
    return [];
  }

  const piAgentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const extensionsDir = path.join(piAgentDir, "extensions");

  let entries: string[];
  try {
    entries = readdirSync(extensionsDir);
  } catch {
    return [];
  }

  const forwarded: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(extensionsDir, entry);
    const pkgPath = path.join(entryPath, "package.json");

    let pkg: ExtensionPackageJson;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as ExtensionPackageJson;
    } catch {
      continue;
    }

    if (!pkg.pi?.extensions || pkg.pi.extensions.length === 0) continue;
    if (pkg.name === PI_ENSEMBLE_PACKAGE_NAME) continue;

    let resolved: string;
    try {
      resolved = realpathSync(entryPath);
    } catch {
      resolved = entryPath;
    }
    forwarded.push(resolved);
    trace(`spawn[${role}]: auto-forward --extension ${resolved} (${pkg.name ?? entry})`);
  }
  return forwarded;
}

// Pi event shape (Pi 0.75.3) — emitted by `--mode rpc` to stdout as JSONL.
// The canonical assembled answer is at agent_end.messages[]; usage stats
// come from message_end.message.usage on assistant messages.
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
    // --mode rpc keeps stdin open for JSON command injection (#152). The
    // initial prompt is sent via stdin as a `{ type: "prompt", message }`
    // RPC command, not positional argv — this is the foundation that
    // dispatch_steer (#153) will use to inject mid-flight steers via the
    // `{ type: "steer", message }` command.
    "--mode",
    "rpc",
    "--no-extensions",
    "--session",
    transcriptPath,
    "--append-system-prompt",
    tmpPromptFile,
  ];
  if (modelChoice.model) {
    childArgs.push("--model", modelChoice.model);
  }
  // Re-inject extensions Pi just suppressed via --no-extensions. Order matters:
  // install-dir extensions (pi-claude-auth, MCP bridges) come first, then any
  // dev-mode extension pinned via PI_ENSEMBLE_USER_EXTENSION, then specialised
  // per-call args (e.g. lens-review's reporter) via opts.extraArgs.
  for (const ext of discoverInstalledExtensions(spec.role)) {
    childArgs.push("--extension", ext);
  }
  applyUserExtension(childArgs, spec.role);
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    childArgs.push(...opts.extraArgs);
  }
  // No positional prompt — sent over stdin RPC channel below.
  const invocation = getPiInvocation(childArgs);

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    // stdin "pipe" (not "ignore") so we can send the initial prompt and
    // any subsequent RPC commands (steer, abort, …). Closing stdin signals
    // "no more commands" — Pi exits cleanly once the current prompt's
    // agent_end has fired.
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_ENSEMBLE_ROLE: spec.role },
  });

  const start = Date.now();
  const events: PiJsonEvent[] = [];
  let stderr = "";
  // Running state shared with the parent's onProgress callback. Each child
  // gets its own state; lens-review aggregates over 6 of them in parallel.
  const runningState = emptyRunningState(spec.role, opts.tag);

  if (!child.stdout || !child.stderr || !child.stdin) {
    throw new Error("Failed to attach to child stdio");
  }

  // Hand the stdin handle to the caller (#153) BEFORE writing the kickoff
  // prompt — this lets the dispatch_steer registry observe a stdin for the
  // child's entire lifetime, not just after the initial prompt.
  opts.onStdin?.(child.stdin);

  // Send the kickoff prompt via the RPC channel. Pi treats this as the
  // first user turn for the agent.
  try {
    child.stdin.write(`${JSON.stringify({ type: "prompt", message: spec.prompt })}\n`);
  } catch (err) {
    trace(`spawn[${spec.role}]: initial stdin.write failed: ${(err as Error).message}`);
  }

  // Done-detection: in --mode rpc the child stays alive after the prompt's
  // agent_end (waiting for more commands). For our fire-and-forget contract
  // we close stdin on agent_end — Pi exits cleanly. promptCompleted guards
  // against double-trigger if Pi emits agent_end more than once for some
  // reason.
  let promptCompleted = false;
  const completePrompt = () => {
    if (promptCompleted) return;
    promptCompleted = true;
    try {
      child.stdin?.end();
    } catch {
      /* child already gone */
    }
  };

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
    // agent_end is the canonical "prompt fully processed" signal in Pi's
    // event stream. Close stdin to release the child.
    if (parsed.type === "agent_end") completePrompt();
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
