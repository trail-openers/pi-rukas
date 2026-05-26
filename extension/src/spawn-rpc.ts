import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ResolvedModelChoice, resolveModel } from "./models.ts";
import { ROLES, isRoleName } from "./roles.ts";
import { trace } from "./trace.ts";

/**
 * Long-lived Pi child running in `--mode rpc`. Unlike spawnSpecialist (which
 * is fire-and-forget `pi -p --mode json`), this child stays alive across
 * multiple prompts and is wired bidirectionally: we send JSONL commands on
 * stdin, it streams JSONL events on stdout.
 *
 * Use cases:
 *   1. Pair-watch: two RPC children where one observer can interrupt the other
 *   2. Future: any pattern that needs to steer or follow-up mid-task
 *
 * The client emits Pi event objects verbatim on the "event" channel so
 * callers can filter/parse as needed. Each command returns a Promise that
 * resolves with Pi's `response` message (matched by request id).
 *
 * IMPORTANT: All output is strict JSONL on \n boundaries (not \r\n; not the
 * Unicode line separators Node's default readline interprets). Pi's docs flag
 * this explicitly — using readline.createInterface would silently split on
 * U+2028/U+2029 which can appear inside JSON strings.
 */

const RPC_DEFAULT_TIMEOUT_MS = (() => {
  const env = Number(process.env.PI_ENSEMBLE_RPC_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 10 * 60_000;
})();

export interface RpcSpawnSpec {
  role: string;
  cwd?: string;
  model?: string;
  /**
   * Extra Pi CLI flags appended before the entry to `--mode rpc`. The
   * canonical use is `--extension <path>` to load tools into the child
   * (e.g., pair-watch-tools.ts).
   */
  extraArgs?: string[];
}

export interface RpcSpawnOptions {
  /** Wall-clock cap; child is SIGTERMed if exceeded. */
  timeoutMs?: number;
  /** Caller-side cancellation. */
  signal?: AbortSignal;
  /** Optional disambiguation tag baked into the transcript filename. */
  tag?: string;
  /** Shared run id so paired children sort together on disk. */
  runId?: string;
}

export interface PiRpcEvent {
  type?: string;
  // Untyped on purpose — callers parse only the fields they need.
  [k: string]: unknown;
}

export interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  id?: string;
  data?: unknown;
}

interface PendingResponse {
  resolve: (r: RpcResponse) => void;
  reject: (err: Error) => void;
}

export interface RpcClient extends EventEmitter {
  readonly role: string;
  readonly transcriptPath: string;
  readonly model: ResolvedModelChoice;
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<RpcResponse>;
  steer(message: string): Promise<RpcResponse>;
  abort(): Promise<RpcResponse>;
  /** Resolves when the child exits (cleanly or otherwise). */
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM the child. Idempotent. */
  dispose(): void;
}

function transcriptPathFor(role: string, runId: string, tag?: string): string {
  const piAgentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const date = new Date().toISOString().slice(0, 10);
  const parts = [role];
  if (tag) parts.push(tag);
  return path.join(piAgentDir, "ensemble-runs", date, `${runId}-${parts.join("-")}.json`);
}

function makeRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const looksLikePiCli =
    currentScript &&
    !currentScript.startsWith("/$bunfs/") &&
    /pi-coding-agent.*\/(dist\/)?cli\.(js|cjs|mjs)$/i.test(currentScript);
  if (looksLikePiCli) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

/**
 * Spawn a Pi child in RPC mode. Returns a typed client. The child does NOT
 * start streaming until the caller sends the first `prompt`.
 */
export async function spawnRpcChild(
  spec: RpcSpawnSpec,
  opts: RpcSpawnOptions = {},
): Promise<RpcClient> {
  if (!isRoleName(spec.role)) throw new Error(`Unknown role: ${spec.role}`);
  const role = ROLES[spec.role];
  const systemPrompt = await fs.readFile(role.promptFile, "utf8");
  const cwd = spec.cwd ?? process.cwd();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-rpc-"));
  const tmpPromptFile = path.join(tmpDir, `${spec.role}.md`);
  await fs.writeFile(tmpPromptFile, systemPrompt);

  const runId = opts.runId ?? makeRunId();
  const transcript = transcriptPathFor(spec.role, runId, opts.tag);
  await fs.mkdir(path.dirname(transcript), { recursive: true });

  const modelChoice = resolveModel(spec.role, spec.model);

  const childArgs = [
    "--mode",
    "rpc",
    "--no-extensions", // disable auto-discovery — only explicit --extension below
    "--session",
    transcript,
    "--append-system-prompt",
    tmpPromptFile,
  ];
  if (modelChoice.model) childArgs.push("--model", modelChoice.model);
  if (spec.extraArgs?.length) childArgs.push(...spec.extraArgs);
  const invocation = getPiInvocation(childArgs);

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    // stdin "pipe" — we send JSONL commands. stdout/stderr "pipe" — we read events/errors.
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  trace(`spawn-rpc[${spec.role}] pid=${child.pid} runId=${runId} transcript=${transcript}`);

  return wireClient(child, spec, modelChoice, transcript, tmpDir, opts);
}

function wireClient(
  child: ChildProcess,
  spec: RpcSpawnSpec,
  modelChoice: ResolvedModelChoice,
  transcript: string,
  tmpDir: string,
  opts: RpcSpawnOptions,
): RpcClient {
  const emitter = new EventEmitter();
  const pending = new Map<string, PendingResponse>();
  let nextId = 1;
  let disposed = false;
  let stderrBuf = "";

  // Strict JSONL on \n. See file header comment.
  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (true) {
      const nl = stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      let line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      handleLine(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  function handleLine(line: string) {
    let parsed: PiRpcEvent | RpcResponse | null = null;
    try {
      parsed = JSON.parse(line) as PiRpcEvent | RpcResponse;
    } catch {
      // Non-JSON output goes to stderr buffer for diagnostic surfacing.
      stderrBuf += `${line}\n`;
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.type === "response") {
      const resp = parsed as RpcResponse;
      const reqId = resp.id;
      if (reqId && pending.has(reqId)) {
        pending.get(reqId)?.resolve(resp);
        pending.delete(reqId);
      }
      return;
    }
    emitter.emit("event", parsed);
    if (typeof parsed.type === "string") emitter.emit(parsed.type, parsed);
  }

  // Wall-clock cap + abort signal — same shape as spawn.ts.
  const timeoutMs = opts.timeoutMs ?? RPC_DEFAULT_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => {
    trace(`spawn-rpc[${spec.role}] wall-clock cap ${timeoutMs}ms hit; killing`);
    dispose();
  }, timeoutMs);
  const onAbort = () => {
    trace(`spawn-rpc[${spec.role}] external abort; killing`);
    dispose();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, sig) => {
        clearTimeout(timeoutHandle);
        opts.signal?.removeEventListener("abort", onAbort);
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        // Reject any still-pending requests
        for (const p of pending.values()) {
          p.reject(new Error(`pi child exited before responding (code=${code}, signal=${sig})`));
        }
        pending.clear();
        if (stderrBuf.trim())
          trace(`spawn-rpc[${spec.role}] stderr tail: ${stderrBuf.slice(-300)}`);
        resolve({ exitCode: code, signal: sig });
      });
    },
  );

  function send(payload: object): Promise<RpcResponse> {
    if (disposed || !child.stdin || child.stdin.destroyed) {
      return Promise.reject(new Error(`spawn-rpc[${spec.role}] cannot send: child is gone`));
    }
    const id = `req-${nextId++}`;
    const line = `${JSON.stringify({ ...payload, id })}\n`;
    return new Promise<RpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin?.write(line, (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
      // Per-request safety net — if Pi never responds, fail loud instead of hanging.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(
            new Error(`spawn-rpc[${spec.role}] command timed out: ${JSON.stringify(payload)}`),
          );
        }
      }, 30_000).unref();
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5_000).unref();
  }

  const client = emitter as RpcClient;
  Object.defineProperty(client, "role", { value: spec.role });
  Object.defineProperty(client, "transcriptPath", { value: transcript });
  Object.defineProperty(client, "model", { value: modelChoice });
  Object.defineProperty(client, "exited", { value: exited });
  Object.defineProperty(client, "dispose", { value: dispose });
  Object.defineProperty(client, "prompt", {
    value: (message: string, streamingBehavior?: "steer" | "followUp") => {
      const cmd: Record<string, unknown> = { type: "prompt", message };
      if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
      return send(cmd);
    },
  });
  Object.defineProperty(client, "steer", {
    value: (message: string) => send({ type: "steer", message }),
  });
  Object.defineProperty(client, "abort", {
    value: () => send({ type: "abort" }),
  });
  return client;
}
