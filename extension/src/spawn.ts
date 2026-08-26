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
 *
 * Split (#171) across several files to stay under the module-size guideline
 * (AGENTS.md §12): type/interface definitions live in `pi-event-shapes.ts`,
 * timeout/transcript-path/pi-invocation helpers live in `spawn-support.ts`,
 * extension auto-forward helpers live in `spawn-extension-forward.ts`, event
 * collapsing lives in `spawn-collapse-events.ts`, and this file keeps
 * `spawnSpecialist` — the spawn + parsing contract itself.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { type ResolvedModelChoice, resolveModel } from "./models.ts";
import { type BrokerHandle, startBroker } from "./permission-broker.ts";
import { isParentInTrustMode, makeBrokerDeps } from "./permission-guard.ts";
import type { PiJsonEvent, SpawnOptions } from "./pi-event-shapes.ts";
import { emptyRunningState, ingestEvent } from "./progress.ts";
import { excludeToolsFor } from "./role-tools.ts";
import { ROLES, type RoleName, isRoleName } from "./roles.ts";
import { type CapSession, capKillAttribution, createCapSession } from "./spawn-caps.ts";
import { collapseEvents } from "./spawn-collapse-events.ts";
import {
  applyUserExtension,
  discoverInstalledExtensions,
  piEnsembleExtensionPath,
} from "./spawn-extension-forward.ts";
import { withSpawnSlot } from "./spawn-semaphore.ts";
import {
  STDERR_TAIL_BYTES,
  assertLiveSpawnAllowed,
  buildChildArgs,
  buildCwdHint,
  capKillGraceMs,
  getPiInvocation,
  inactivityTimeoutMs,
  makeRunId,
  reconcileObservedCounts,
  spawnBackstopMs,
  transcriptPathFor,
  willRetryAfter,
} from "./spawn-support.ts";
import { trace } from "./trace.ts";
import type { DispatchResult, DispatchSpec } from "./types.ts";
import { vipuneChildEnv } from "./vipune.ts";

// `buildChildArgs` lives in spawn-support.ts (§12): argument construction is
// invocation plumbing, which that module already holds. Re-exported here
// because smoke tests assert on the argument ORDER, which is load-bearing.
export { buildChildArgs, buildCwdHint, makeRunId };

/**
 * Spawn one specialist child, bounded by the global spawn semaphore.
 *
 * The cap wraps THIS function rather than `startJob` because
 * `lens-review.ts` and `adversarial.ts` call it directly and bypass the job
 * registry entirely — they are exactly the fanout that needs bounding.
 */
export async function spawnSpecialist(
  spec: DispatchSpec,
  opts: SpawnOptions = {},
): Promise<DispatchResult> {
  return withSpawnSlot(() => spawnSpecialistInner(spec, opts));
}

async function spawnSpecialistInner(
  spec: DispatchSpec,
  opts: SpawnOptions = {},
): Promise<DispatchResult> {
  if (!isRoleName(spec.role)) throw new Error(`Unknown role: ${spec.role}`);

  assertLiveSpawnAllowed(spec.role);

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

  // Subagent-permission plumbing: per-spawn Unix socket + broker.
  //
  // The subagent's pi-ensemble (forwarded below via --extension and gated by
  // PI_ENSEMBLE_SUBAGENT_MODE=1) escalates `ask` verdicts over this socket.
  // The parent broker prompts the user via ctx.ui.select, caches via the
  // existing decisions.json plumbing, and replies on the socket. Both the
  // forward and the broker are opt-out via PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD=1.
  // Subagent guard wiring depends on parent's trust state:
  //   - Sandbox or interactive host (trust mode): subagent gets PI_ENSEMBLE_TRUST_MODE=1,
  //     no broker socket, no pi-ensemble extension forward — subagent's permission-guard
  //     short-circuits the same way the parent does.
  //   - Headless / strict-opt-in: full broker socket + pi-ensemble extension forward so
  //     subagent escalates `ask` verdicts to the parent (or hard-denies if no UI).
  //   - PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD=1: forces guard off (debugging escape hatch).
  const parentTrustMode = isParentInTrustMode();
  const subagentGuardEnabled =
    process.env.PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD !== "1" && !parentTrustMode;
  let permSocketPath: string | undefined;
  let broker: BrokerHandle | undefined;
  if (subagentGuardEnabled) {
    permSocketPath = path.join(os.tmpdir(), `pi-ensemble-perm-${runId}-${spec.role}.sock`);
    const deps = makeBrokerDeps();
    if (deps) {
      broker = startBroker(permSocketPath, deps);
    } else {
      trace(
        `spawn[${spec.role}]: parent guard not ready — subagent permissions will headless-deny on ask`,
      );
      // Don't pass the socket env var if we couldn't start a broker; the
      // subagent guard will fall through to headless-deny cleanly.
      permSocketPath = undefined;
    }
  }

  const childArgs = buildChildArgs(
    spec.role,
    tmpPromptFile,
    transcriptPath,
    modelChoice,
    subagentGuardEnabled,
    opts.extraArgs,
  );
  // No positional prompt — sent over stdin RPC channel below.
  const invocation = getPiInvocation(childArgs);

  const childEnv: Record<string, string> = { ...process.env, PI_ENSEMBLE_ROLE: spec.role };
  Object.assign(childEnv, vipuneChildEnv());
  if (subagentGuardEnabled) {
    childEnv.PI_ENSEMBLE_SUBAGENT_MODE = "1";
    if (permSocketPath) {
      childEnv.PI_ENSEMBLE_PERM_SOCKET = permSocketPath;
    }
  } else if (parentTrustMode) {
    // Propagate trust mode so any future subagent-side pi-ensemble load (e.g.
    // if --extension forwarding is re-enabled) short-circuits the same way the
    // parent does. Sandbox already sets PI_ENSEMBLE_SANDBOX_MODE on every child
    // via the wrapper env; this covers the interactive-host case.
    childEnv.PI_ENSEMBLE_TRUST_MODE = "1";
  }

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    // stdin "pipe" (not "ignore") so we can send the initial prompt and
    // any subsequent RPC commands (steer, abort, …). Closing stdin signals
    // "no more commands" — Pi exits cleanly once the current prompt's
    // agent_end has fired.
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });

  const start = Date.now();
  // Bounded per-spawn buffers: unbounded `events[]` / `stderr +=` accumulators
  // caused parent OOM at ~3.7GB during long /work cycles (V8 SlowFlatten on the
  // ConsString tree, blown up by the next regex match). The cost is that this
  // holds the last agent_end SEGMENT, not the session — Pi emits one per retry
  // boundary. reconcileObservedCounts restores the true counts from
  // runningState; see its docstring for what the gap hid.
  let lastAgentEnd: PiJsonEvent | null = null;
  let lastAssistantMessageEnd: PiJsonEvent | null = null;
  // stderr is surfaced only as a tail in failure reports. Keep the most
  // recent ~STDERR_TAIL_BYTES of bytes via a ring of Buffers; concat once
  // at end-of-spawn to a flat string (no ConsString tree → no SlowFlatten).
  const stderrChunks: Buffer[] = [];
  let stderrSize = 0;
  const appendStderr = (chunk: Buffer | string): void => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    stderrChunks.push(buf);
    stderrSize += buf.length;
    while (stderrSize > STDERR_TAIL_BYTES && stderrChunks.length > 1) {
      const evicted = stderrChunks.shift();
      if (evicted) stderrSize -= evicted.length;
    }
  };
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
  //
  // When the caller passed `spec.cwd`, prepend a runtime context note so
  // the subagent knows its concrete working directory from line 1. This
  // exists because weak local models (Qwen3-class) skim past generic
  // doctrine ("do not cd"); a concrete absolute path in the runtime prompt
  // is a much harder cue to ignore. See PR #192 + arxiv 2505.18135 on the
  // measured strength of runtime context vs. system-prompt-only steering.
  const cwdHint = buildCwdHint(spec.cwd);
  try {
    child.stdin.write(`${JSON.stringify({ type: "prompt", message: cwdHint + spec.prompt })}\n`);
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

  // #543 F1/F6 — dispatch caps (loop detector + token budget). The cap
  // session (spawn-caps.ts) owns the per-spawn detector/tracker state, the
  // grace-window timers and the killCause priority (loop > inactivity >
  // timeout > token-budget > abort — the most specific wins). Created
  // BEFORE `createInterface` below because the line handler references
  // `caps` on the first stdout line: a `const caps` initialized after the
  // attach would be in the TDZ for any early line (ReferenceError).
  let timedOut = false;
  let inactivityKilled = false;
  let aborted = false;
  // #543 H1 — grace-window kill race: observed EXITS (exit + 'close') set
  // childExited immediately, before the `once(child, "exit")` await below
  // can resolve. The guard relies on the `exit` event's ordering (it fires
  // before the process is reaped); `close` is belt-and-braces — it fires
  // only after `exit`, once stdio is fully drained.
  let childExited = false;
  child.on("exit", () => {
    childExited = true;
  });
  child.on("close", () => {
    childExited = true;
  });
  const caps: CapSession = createCapSession({
    role: spec.role,
    child,
    onSteer: opts.onSteer,
    totalTokens: () => runningState.totalTokens,
    timedOut: () => timedOut,
    inactivityKilled: () => inactivityKilled,
    aborted: () => aborted,
    capKillGraceMs: capKillGraceMs(),
    childExited: () => childExited,
  });

  // Inactivity watchdog state (#296): ANY stdout line counts as life —
  // parseable or not. Checked on a coarse interval below.
  let lastActivityAt = Date.now();
  // The SHAPE of the silence, so a kill can be attributed rather than merely
  // tuned: `linesSeen: 0` is a provider stall or auth failure, not a hang.
  // Full reasoning in test-kill-attribution.ts.
  let lastActivityKind = "nothing yet";
  let stdoutLines = 0;

  const stdoutRl = createInterface({ input: child.stdout });
  stdoutRl.on("line", (line) => {
    lastActivityAt = Date.now();
    stdoutLines += 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    lastActivityKind = "unparsed stdout";
    let parsed: PiJsonEvent | null = null;
    try {
      parsed = JSON.parse(trimmed) as PiJsonEvent;
    } catch {
      appendStderr(`${trimmed}\n`);
      return;
    }
    // Stream into the running state. ingestEvent returns true only when an
    // assistant turn completed (the right cadence to surface to the user).
    // #543 F1 — pass the full block list to the loop detector (ops-role
    // children are exempt: the cap session returns no observer for them).
    if (
      ingestEvent(
        runningState,
        parsed as Parameters<typeof ingestEvent>[1],
        start,
        caps.loopObserver,
      )
    ) {
      // #543 F6 — check the token budget on every assistant turn end.
      caps.tokenBudgetTracker?.check(Date.now());
      caps.tokenBudgetTracker?.onMessageEnd(Date.now());
      opts.onProgress?.({ ...runningState, usage: { ...runningState.usage } });
    }
    // Retain only the two events collapseEvents actually reads (the latest
    // agent_end + the latest assistant message_end as fallback). Everything
    // else is already absorbed by ingestEvent into runningState above, and
    // dropping the rest keeps per-spawn memory bounded.
    lastActivityKind = parsed.type ?? "unknown event";
    if (parsed.type === "agent_end") {
      lastAgentEnd = parsed;
      // Not while the child is retrying — see `willRetryAfter`.
      if (!willRetryAfter(parsed)) completePrompt();
    } else if (
      parsed.type === "message_end" &&
      (parsed as { message?: { role?: string } }).message?.role === "assistant"
    ) {
      lastAssistantMessageEnd = parsed;
    }
  });
  child.stderr.on("data", (d) => {
    appendStderr(d);
  });

  // Always cap wall-clock — see SPAWN_BACKSTOP_MS. A stalled child without a
  // timeout hangs the parent indefinitely (observed in the wild: overnight
  // stuck session). The backstop only catches runaway loops; the inactivity
  // watchdog below is what detects true hangs, and it does so without a view
  // on how fast the child's model happens to be. `timedOut` / `inactivityKilled`
  // / `aborted` are declared with the cap session above (the session reads
  // them by closure, so they must exist before `createCapSession` runs).
  const timeoutMs = opts.timeoutMs ?? spawnBackstopMs();
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    // Escalate to SIGKILL if the child ignores SIGTERM for 5s.
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);

  // Inactivity watchdog (#296): kill only on total stdout silence. Coarse
  // poll — half the budget, clamped to [250ms, 30s] so production budgets
  // poll cheaply and short test budgets still fire promptly.
  const inactivityMs = inactivityTimeoutMs();
  const inactivityPoll =
    inactivityMs > 0
      ? setInterval(
          () => {
            if (Date.now() - lastActivityAt >= inactivityMs) {
              inactivityKilled = true;
              child.kill("SIGTERM");
              setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
            }
          },
          Math.min(30_000, Math.max(250, Math.floor(inactivityMs / 2))),
        )
      : undefined;
  inactivityPoll?.unref();

  // Propagate Pi's user-cancel (Esc) signal: kill the child so the tool
  // execute promise resolves and Pi un-stuck immediately.
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
    if (inactivityPoll) clearInterval(inactivityPoll);
    caps.cleanup();
    opts.signal?.removeEventListener("abort", onAbort);
    // Best-effort cleanup of the temp prompt file; ignore errors.
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    // Stop the per-spawn permission broker; unlinks the socket file.
    if (broker) {
      try {
        broker.stop();
      } catch (err) {
        trace(`spawn[${spec.role}]: broker stop failed: ${(err as Error).message}`);
      }
    }
  }

  if (timedOut) {
    appendStderr(`\n[pi-ensemble] killed after ${timeoutMs}ms timeout`);
  }
  if (inactivityKilled) {
    appendStderr(`\n[pi-ensemble] killed after ${inactivityMs}ms inactivity`);
  }
  if (aborted) {
    appendStderr("\n[pi-ensemble] cancelled by user (Esc)");
  }

  // Final flat string from the ring buffer (bounded; no SlowFlatten on the
  // 64KB total even if the rest of the spawn ran a regex over it).
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const ms = Date.now() - start;
  const result = collapseEvents(
    lastAgentEnd,
    lastAssistantMessageEnd,
    spec.role,
    ms,
    exitCode,
    stderr,
  );
  // #543 F1/F6 — the cap-kill stderr lines + killCause + structured trigger
  // evidence (loopEvidence / tokenBudget) follow #296's structured-kill
  // contract, resolved by priority in spawn-caps.ts's capKillAttribution.
  capKillAttribution(caps, spec, runningState.totalTokens, appendStderr, result);
  result.transcriptPath = transcriptPath;
  result.modelSource = modelChoice.source;
  // The cap-kill cause + evidence were already resolved above (capKillAttribution,
  // after the stderr lines are appended). The wall-clock budgets for the
  // timeout/inactivity kills are set HERE — only meaningful for those causes.
  if (result.killCause === "timeout") result.killBudgetMs = timeoutMs;
  if (result.killCause === "inactivity") result.killBudgetMs = inactivityMs;
  // A killed child never completed its assignment, whatever its exit code.
  if (result.killCause) {
    result.ok = false;
    // Only meaningful for a kill; attaching it always would imply we killed
    // every child.
    result.lastActivity = {
      kind: lastActivityKind,
      agoMs: Date.now() - lastActivityAt,
      linesSeen: stdoutLines,
    };
  }
  if (modelChoice.model && !result.model) {
    // collapseEvents only sets `model` from assistant message metadata, which
    // is present when the child actually got a reply. If the child failed
    // before any assistant turn (rare), surface the requested model anyway.
    result.model = modelChoice.model;
  }

  reconcileObservedCounts(result, runningState);

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
