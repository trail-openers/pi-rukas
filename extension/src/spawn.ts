/**
 * Child Pi spawn — the single seam between the orchestrator extension
 * and every specialist subagent.
 *
 * Responsibilities:
 *   1. `--mode rpc` protocol — stdin held open for RPC commands (#152).
 *   2. Extension auto-forward — re-injects installed extensions into child.
 *   3. JSONL event stream parsing — children emit `agent_end`, `message_end`, etc.
 *   4. Done detection — closes stdin on `agent_end`; saves session JSONL.
 *
 * Subagents do NOT inherit pi-rukas's permission interceptor.
 * Split (#171): types in `pi-event-shapes.ts`, helpers in `spawn-support.ts`,
 * extension forwarding in `spawn-extension-forward.ts`, event collapsing
 * in `spawn-collapse-events.ts`, the kill-flag / cap-session / wall-clock and
 * abort arms in `spawn-watchdog.ts` (#1470), this file keeps `spawnSpecialist`.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { preflightChildGuards } from "./child-guards.ts";
import { ChildProgress } from "./child-progress.ts";
import { clampToCycleDeadline } from "./cycle-deadline-clock.ts";
import { scrubGitLocation } from "./git-env.ts";
import { withHostSpawnSlot } from "./host-spawn-slots.ts";
import { type ResolvedModelChoice, resolveModel } from "./models.ts";
import { type BrokerHandle, startBroker } from "./permission-broker.ts";
import { isParentInTrustMode, makeBrokerDeps } from "./permission-guard.ts";
import { getPiInvocation } from "./pi-binary-resolve.ts";
import type { PiJsonEvent, SpawnOptions } from "./pi-event-shapes.ts";
import { kickPiResolutionProbe } from "./pi-version-probe.ts";
import { emptyRunningState, ingestEvent } from "./progress.ts";
import { excludeToolsFor } from "./role-tools.ts";
import { ROLES, type RoleName, isRoleName } from "./roles.ts";
import { capKillAttribution } from "./spawn-caps.ts";
import { applyChildBound, armChildBound } from "./spawn-child-bound.ts";
import { collapseEvents } from "./spawn-collapse-events.ts";
import {
  applyUserExtension,
  discoverInstalledExtensions,
  piEnsembleExtensionPath,
} from "./spawn-extension-forward.ts";
import {
  InFlightTools,
  attachAbortKill,
  createInactivityPoll,
  createStdoutLineHandler,
  createWallClockBackstop,
  isStdinEcho,
} from "./spawn-inflight.ts";
import { groupSpawnOpts, registerChild } from "./spawn-kill.ts";
import { withSpawnSlot } from "./spawn-semaphore.ts";
import {
  STDERR_TAIL_BYTES,
  assertLiveSpawnAllowed,
  buildChildArgs,
  buildCwdHint,
  makeRunId,
  reconcileObservedCounts,
  spawnBackstopMs,
  transcriptPathFor,
  willRetryAfter,
} from "./spawn-support.ts";
import { armCapSession, declareKillFlags } from "./spawn-watchdog.ts";
import { attachStdinErrorGuard } from "./stdin-guard.ts";
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
  // #1528 — the per-process cap first, then the host-wide one (host-spawn-slots.ts).
  return withSpawnSlot(() =>
    withHostSpawnSlot(() => spawnSpecialistInner(spec, opts), opts.signal),
  );
}

async function spawnSpecialistInner(
  spec: DispatchSpec,
  opts: SpawnOptions = {},
): Promise<DispatchResult> {
  if (!isRoleName(spec.role)) throw new Error(`Unknown role: ${spec.role}`);

  assertLiveSpawnAllowed(spec.role);

  const role = ROLES[spec.role];
  // First spawn in this process: kick the version probe (fire-and-forget).
  kickPiResolutionProbe();
  const systemPrompt = await fs.readFile(role.promptFile, "utf8");
  const cwd = spec.cwd ?? process.cwd();

  // Write role prompt to a temp file; Pi's --append-system-prompt accepts a
  // file path and appends file contents to its default safety prompt.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rukas-"));
  const tmpPromptFile = path.join(tmpDir, `${spec.role}.md`);
  await fs.writeFile(tmpPromptFile, systemPrompt);

  // Per-child transcript path. Pi will write its native session JSON here.
  // #573 — accept a caller-supplied runId (derived by the driver BEFORE spawn
  // so crash-resume can locate the surviving session file).
  const runId = opts.runId ?? makeRunId();
  const transcriptPath = transcriptPathFor(spec.role, runId, opts.seq, opts.tag);
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

  // Resolve which model this child should run on (spec > lens env > role > global env > Pi default).
  const modelChoice = resolveModel(spec.role, spec.model, spec.lens);

  // Subagent-permission plumbing: per-spawn Unix socket + broker. The
  // subagent's pi-rukas (forwarded below via --extension and gated by
  // PI_ENSEMBLE_SUBAGENT_MODE=1) escalates `ask` verdicts over this socket.
  // The parent broker prompts the user via ctx.ui.select, caches via the
  // existing decisions.json plumbing, and replies on the socket. Both the
  // forward and the broker are opt-out via PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD=1.
  // Subagent guard wiring depends on parent's trust state:
  //   - Sandbox or interactive host (trust mode): subagent gets PI_ENSEMBLE_TRUST_MODE=1,
  //     no broker socket, no pi-rukas extension forward — subagent's permission-guard
  //     short-circuits the same way the parent does.
  //   - Headless / strict-opt-in: full broker socket + pi-rukas extension forward so
  //     subagent escalates `ask` verdicts to the parent (or hard-denies if no UI).
  //   - PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD=1: forces guard off (debugging escape hatch).
  const parentTrustMode = isParentInTrustMode();
  const subagentGuardEnabled =
    process.env.PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD !== "1" && !parentTrustMode;
  let permSocketPath: string | undefined;
  let broker: BrokerHandle | undefined;
  if (subagentGuardEnabled) {
    permSocketPath = path.join(os.tmpdir(), `pi-rukas-perm-${runId}-${spec.role}.sock`);
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

  // #926 — the argv names CHILD_GUARDS_PATH, so verify it BEFORE building the
  // args: a missing companion must be a named dispatch failure, never a child
  // without the mode-independent guards.
  preflightChildGuards();
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
  // #1571 — the child works in `cwd`; an inherited GIT_DIR & co. would point
  // its git at another tree (git-env.ts).
  scrubGitLocation(childEnv);
  // Interactive-git hang prevention (#605). These win over the inherited
  // host env: a child that reaches an editor, sequence editor, terminal
  // prompt, or full-screen pager (git rebase -i, bare git commit, any
  // credential prompt, a paged diff) must never wait on a TTY it does not
  // have — the inactivity watchdog would otherwise kill it 25 minutes later
  // and misclassify the stall. `true` (the real no-op binary) over `:`
  // (a shell builtin git cannot exec), per Aider's pattern.
  childEnv.GIT_EDITOR = "true";
  childEnv.GIT_SEQUENCE_EDITOR = "true";
  childEnv.GIT_TERMINAL_PROMPT = "0";
  childEnv.GIT_PAGER = "cat";
  if (subagentGuardEnabled) {
    childEnv.PI_ENSEMBLE_SUBAGENT_MODE = "1";
    if (permSocketPath) {
      childEnv.PI_ENSEMBLE_PERM_SOCKET = permSocketPath;
    }
  } else if (parentTrustMode) {
    // Propagate trust mode so any future subagent-side pi-rukas load (e.g.
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
    // #1024 — headless only: own process group, so a kill reaches grandchildren
    // (spawn-kill.ts). Normal exit still ends the child through the stdin-close
    // path above.
    ...groupSpawnOpts(opts.processGroup === true),
  });
  registerChild(child, opts.processGroup === true);

  // #932 — universal EPIPE backstop (stdin-guard.ts): EPIPE fires async as `error`,
  // so without this listener the kickoff write, end(), or any later steer becomes
  // an uncaughtException. Must precede onStdin.
  attachStdinErrorGuard(child.stdin, spec.role);
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

  // Send the kickoff prompt via the RPC channel (Pi's first user turn). With
  // `spec.cwd`, a runtime note names the concrete working directory from line
  // 1: weak local models skim past generic "do not cd" doctrine, and a runtime
  // absolute path is a much harder cue to ignore (PR #192).
  const cwdHint = buildCwdHint(spec.cwd);
  try {
    child.stdin.write(
      `${JSON.stringify({ type: "prompt", message: cwdHint + spec.prompt, images: spec.images })}\n`,
    );
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
    childBound.onReported(); // #1521: reap it if it does not exit
    try {
      child.stdin?.end();
    } catch {
      /* child already gone */
    }
  };

  // #543 F1/F6 — dispatch caps (loop detector + token budget), and the kill
  // flags the session reads by closure, now live in spawn-watchdog.ts (#1470).
  // Ordering is load-bearing: `declareKillFlags` runs first (the session
  // closes over the flags), `armCapSession` BEFORE `createInterface` below
  // because the line handler references `caps` on the first stdout line — a
  // `const caps` initialized after the attach would be in the TDZ for any
  // early line (ReferenceError).
  const flags = declareKillFlags();
  const caps = armCapSession(child, flags, {
    role: spec.role,
    onSteer: opts.onSteer,
    runningState,
  });
  // Inactivity watchdog state (#296): ANY stdout line counts as life —
  // parseable or not. Checked on a coarse interval below.
  let lastActivityAt = Date.now();
  // The SHAPE of the silence, so a kill can be attributed rather than merely
  // tuned: `linesSeen: 0` is a provider stall or auth failure, not a hang.
  // Full reasoning in test-kill-attribution.ts.
  let lastActivityKind = "nothing yet";
  let stdoutLines = 0;
  // #951 — the in-flight tool-call state (spawn-inflight.ts): the watchdog's
  // silence is a SILENCE, and an in-flight tool is work, not silence. A
  // toolCall block inside an assistant message_end opens a span; the matching
  // toolResult closes it (error or not). While the set is non-empty the
  // tool-inactivity bound applies to the silence; when it is empty the
  // model-silence bound applies — exactly one budget is armed at any poll.
  const inFlightTools = new InFlightTools();
  // #1567 — what counts as progress, per spawn (child-progress.ts).
  const childProgress = new ChildProgress();
  const stdoutRl = createInterface({ input: child.stdout });
  const lineHandler = createStdoutLineHandler({
    start,
    inFlightTools,
    childProgress,
    appendStderr,
    runningState,
    caps,
    onProgress: opts.onProgress,
    onRawEvent: opts.onRawEvent,
    onAgentEnd: (parsed) => {
      lastAgentEnd = parsed;
      if (!willRetryAfter(parsed)) completePrompt();
    },
  });
  stdoutRl.on("line", (line) => {
    stdoutLines += 1;
    const res = lineHandler(line);
    if (isStdinEcho(res.kind)) return; // our own steer acked — not life
    lastActivityAt = Date.now();
    if (res.kind) lastActivityKind = res.kind;
    if (res.agentEnd) lastAgentEnd = res.agentEnd;
    if (res.assistantMessageEnd) lastAssistantMessageEnd = res.assistantMessageEnd;
  });
  child.stderr.on("data", (d) => {
    appendStderr(d);
  });
  // Always cap wall-clock — see SPAWN_BACKSTOP_MS and createWallClockBackstop
  // (spawn-inflight.ts). The backstop catches runaway loops; the inactivity
  // watchdog below detects true hangs. The kill-cause flags are declared with
  // the cap session above (read by closure, so they predate `createCapSession`).
  // #1593 — never past what the cycle's deadline leaves (cycle-deadline-clock.ts).
  const bound = clampToCycleDeadline(opts.timeoutMs ?? spawnBackstopMs(), Date.now());
  const timeoutMs = bound.timeoutMs;
  const stopWallClockBackstop = createWallClockBackstop({
    child,
    timeoutMs,
    // `timedOut` first, so `killCause()` reports "timeout" even if the signal
    // cannot land; the guarded kill lives in the factory (#1510). #1521: a
    // child that committed or reported is ended as done instead.
    onTimeout: () => childBound.atBackstop(() => flags.setTimedOut(true)),
  });

  // #1560 — the per-child run bound: wrap-up steer, then end it (spawn-child-bound.ts).
  const childBound = armChildBound({
    child,
    boundMs: opts.childBoundMs,
    cwd,
    onSteer: opts.onSteer,
    stdin: child.stdin,
    reported: () => promptCompleted,
    childExited: flags.childExited,
    preempted: () =>
      flags.aborted() ||
      flags.timedOut() ||
      flags.inactivityKilled() ||
      flags.toolInactivityKilled(),
    commits: spec.role === "developer" && spec.cwd !== undefined,
  });

  // Inactivity watchdog (#296): kill only on total stdout silence. Coarse
  // poll — half the budget, clamped to [250ms, 30s] so production budgets
  // poll cheaply and short test budgets still fire promptly.
  //
  // #951 — ONE poll, two budgets (spawn-inflight.ts createInactivityPoll):
  // while the in-flight set is non-empty the tool-inactivity bound applies;
  // when it is empty the model-silence bound applies. Exactly one budget
  // is armed at any poll, so there is no both-expired race.
  const stopInactivityPoll = createInactivityPoll({
    child,
    inFlightTools,
    lastActivityAt: () => lastActivityAt,
    onKill: (cause, budgetMs, toolNames) => {
      if (cause === "tool-inactivity") flags.setToolInactivityKilled(true);
      else flags.setInactivityKilled(true);
      // #951 — name the tool(s) that went silent, so the report shows
      // WHAT is in flight instead of a bare cause. Inactivity kills
      // keep today's parsed.type behaviour (lastActivityKind above).
      lastActivityKind = `toolCall in flight: ${toolNames.join(", ")}`;
      flags.setKilledBudgetMs(budgetMs);
    },
  });

  // Propagate Pi's user-cancel (Esc) signal: kill the child so the tool
  // execute promise resolves and Pi un-stuck immediately (guarded in the
  // helper, #1510).
  const detachAbortKill = attachAbortKill(child, opts.signal, () => {
    flags.setAborted(true);
  });

  let exitCode: number | null = null;
  try {
    [exitCode] = (await once(child, "exit")) as [number | null];
  } finally {
    stopWallClockBackstop();
    childBound.stop();
    stopInactivityPoll();
    caps.cleanup();
    detachAbortKill();
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

  if (flags.timedOut()) {
    appendStderr(`\n[pi-rukas] killed after ${timeoutMs}ms timeout`);
  }
  if (flags.inactivityKilled()) {
    appendStderr(`\n[pi-rukas] killed after ${flags.killedBudgetMs()}ms inactivity`);
  }
  if (flags.toolInactivityKilled()) {
    appendStderr(
      `\n[pi-rukas] killed after ${flags.killedBudgetMs()}ms with a tool call in flight (tool-inactivity)`,
    );
  }
  if (flags.aborted()) {
    appendStderr("\n[pi-rukas] cancelled by user (Esc)");
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
  applyChildBound(childBound, result);
  result.transcriptPath = transcriptPath;
  result.modelSource = modelChoice.source;
  // The cap-kill cause + evidence were already resolved above (capKillAttribution,
  // after the stderr lines are appended). The wall-clock budgets for the
  // timeout/inactivity kills are set HERE — only meaningful for those causes.
  // #951 — each silence kill records the ACTIVE bound (the one the poll
  // armed), since exactly one budget is checked per poll.
  if (result.killCause === "timeout") result.killBudgetMs = timeoutMs;
  if (result.killCause === "timeout" && bound.clamped) result.killedAtCycleDeadline = true;
  if (result.killCause === "inactivity") result.killBudgetMs = flags.killedBudgetMs();
  if (result.killCause === "tool-inactivity") result.killBudgetMs = flags.killedBudgetMs();
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
