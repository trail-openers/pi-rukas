/**
 * spawn-call-budget — the call budget and call-kill of the child-supervision
 * policy (#1567 items 2 and 3, piece P2 / #1465).
 *
 * The tool-inactivity watchdog killed the whole child after 60 min of stdout
 * silence while a tool call was in flight. Silence cannot tell a hung call from
 * a suite that prints nothing until it ends, and the kill took the child's
 * context with it. This module bounds the CALL instead:
 *
 *   - budget: the command's own `timeout N` (the bash tool's `timeout`
 *     argument, or a `timeout N` in the command) + 2 min; otherwise
 *     max(20 min, 3 × the longest completed run of the same command);
 *   - stuck: past its budget, and no progress (child-progress.ts: no update
 *     bytes from the call, no other result) for 10 min;
 *   - call-kill: SIGTERM, then SIGKILL, to the call's own process group — not
 *     the child — and a steer telling the child what happened. Pi's bash tool
 *     then returns the killed command as a failed result and the child goes on.
 *   - a second stuck call on the same command (or a call still in flight
 *     `staleMs` after its kill, or one whose process cannot be found) ends the
 *     child with kill cause `stuck-tool`.
 *
 * Finding the call's process. Pi's bash tool spawns every call's shell with
 * `detached: true` (pi-coding-agent `createLocalShellOperations`), so each call
 * runs as the leader of its own process group, a descendant of the child Pi
 * process. Pi exposes no pid for a call, so the parent reads `ps` once, at kill
 * time: among the child's descendants that lead their own group, the call's is
 * the one that started within START_SLACK_MS of the call's start, narrowed by
 * the command text when two calls started together. Anything ambiguous kills
 * nothing. Killing the group reaches everything the command started (a test
 * runner's workers) and nothing else the child runs. Without process groups
 * (Windows) no call is found, and a stuck call ends the child.
 *
 * "Longest same-command run in this cycle" is kept per process, not per cycle:
 * a longer run seen elsewhere only raises a budget, never lowers one. The
 * 30-min model-silence watchdog (spawn-inflight.ts) is untouched; it applies
 * while no call is in flight. One `armCallBudget` per spawn.
 */

import { type ChildProcess, execFile } from "node:child_process";
import type { Writable } from "node:stream";
import type { ChildProgress, InFlightCall } from "./child-progress.ts";
import type { SteerSource } from "./dispatch-steer.ts";
import { killGroup, killProcessTree } from "./spawn-kill.ts";
import { trace, traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

const MINUTE_MS = 60_000;
/** Policy: a command with its own `timeout N` gets N plus this. */
const OWN_TIMEOUT_GRACE_MS = 2 * MINUTE_MS;
/** Policy: otherwise, this multiple of the longest same-command run. */
const LONGEST_MULTIPLE = 3;
/** How far a group leader's start may lie from the call's start. */
const START_SLACK_MS = 10_000;
/** Bound on the shared longest-run table. */
const LONGEST_MAX_ENTRIES = 1000;

function envMs(key: string, fallbackMs: number): number {
  const raw = process.env[key];
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : fallbackMs;
}

/** The budget floor (policy: 20 min). `0` disables the call watch. */
export function callBudgetFloorMs(): number {
  return envMs("PI_ENSEMBLE_CALL_BUDGET_MS", 20 * MINUTE_MS);
}

/** How long a call past its budget must go without progress to be stuck (policy: 10 min). */
export function callStaleMs(): number {
  return envMs("PI_ENSEMBLE_CALL_STALE_MS", 10 * MINUTE_MS);
}

/** The longest completed run per command fingerprint, shared by every spawn in this process. */
const longestRun = new Map<string, number>();

/** Fold one spawn's completed runs into the shared table. */
export function recordLongestRuns(runs: ReadonlyMap<string, number>): void {
  for (const [fp, ms] of runs) {
    if (ms <= (longestRun.get(fp) ?? -1)) continue;
    longestRun.delete(fp);
    longestRun.set(fp, ms);
    if (longestRun.size > LONGEST_MAX_ENTRIES) {
      const oldest = longestRun.keys().next().value;
      if (oldest !== undefined) longestRun.delete(oldest);
    }
  }
}

/** The longest completed run of this command seen in this process, ms. */
export function longestRunMs(fingerprint: string): number | undefined {
  return longestRun.get(fingerprint);
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: MINUTE_MS,
  h: 60 * MINUTE_MS,
  d: 1440 * MINUTE_MS,
};

/**
 * The call's own timeout in ms: the bash tool's `timeout` (seconds), or a
 * `timeout N` that leads the command (after an optional `cd DIR &&` and env
 * assignments). A `timeout` further in bounds only part of the command.
 */
export function ownTimeoutMs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const { timeout, command } = args as { timeout?: unknown; command?: unknown };
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) return timeout * 1000;
  if (typeof command !== "string") return undefined;
  // Options before the duration; `-k` / `-s` take a value of their own.
  const m =
    /^\s*(?:cd\s+\S+\s*&&\s*)?(?:\w+=\S*\s+)*g?timeout\s+(?:-[ks]\s+\S+\s+|-\S+\s+)*(\d+(?:\.\d+)?)([smhd]?)(?=\s)/.exec(
      command,
    );
  if (!m) return undefined;
  const ms = Number(m[1]) * (UNIT_MS[m[2] || "s"] ?? 1000);
  return ms > 0 ? ms : undefined;
}

/** The policy's budget for one call. */
export function callBudgetMs(call: InFlightCall, floorMs: number, longestMs?: number): number {
  const own = ownTimeoutMs(call.args);
  if (own !== undefined) return own + OWN_TIMEOUT_GRACE_MS;
  return Math.max(floorMs, LONGEST_MULTIPLE * (longestMs ?? 0));
}

/** One `ps` row. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  ageMs: number;
  args: string;
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in ms. */
export function parseEtime(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  const [d = 0, h = 0, min = 0, sec = 0] = m.slice(1).map((v) => Number(v ?? 0));
  return (((d * 24 + h) * 60 + min) * 60 + sec) * 1000;
}

/** Parse `ps -o pid=,ppid=,pgid=,etime=,args=` output. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    const ageMs = m ? parseEtime(m[4] ?? "") : undefined;
    if (!m || ageMs === undefined) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      ageMs,
      args: m[5] ?? "",
    });
  }
  return rows;
}

function listProcesses(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    const argv = ["-A", "-ww", "-o", "pid=,ppid=,pgid=,etime=,args="];
    execFile("ps", argv, { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : parsePs(String(stdout)));
    });
  });
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The process group running bash `call` under the child `childPid`, or
 * undefined when no single group can be named (see the module doc). A
 * candidate whose argv shows the command's first line is preferred; a lone
 * candidate without it (bash `exec`s a simple command, and drops its quotes)
 * is accepted only when no other bash call is in flight to own it.
 */
export function findCallGroup(
  rows: ProcRow[],
  childPid: number,
  call: InFlightCall,
  now: number,
  otherBashCalls = 0,
): number | undefined {
  const command = (call.args as { command?: unknown } | null)?.command;
  const head =
    typeof command === "string" ? collapse(command.split("\n")[0] ?? "").slice(0, 80) : "";
  if (call.toolName !== "bash" || !head) return undefined;
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r]);
  const descendants: ProcRow[] = [];
  const queue = [childPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const r of byParent.get(queue.shift() as number) ?? []) {
      if (seen.has(r.pid)) continue;
      seen.add(r.pid);
      descendants.push(r);
      queue.push(r.pid);
    }
  }
  const near = descendants.filter(
    (r) => r.pgid === r.pid && Math.abs(now - r.ageMs - call.startedAt) <= START_SLACK_MS,
  );
  const named = near.filter((r) => collapse(r.args).includes(head));
  if (named.length === 1) return named[0]?.pid;
  if (named.length === 0 && near.length === 1 && otherBashCalls === 0) return near[0]?.pid;
  return undefined;
}

export interface CallBudget {
  /** The child was ended for a stuck call (kill cause `stuck-tool`). */
  stuckKilled(): boolean;
  /** The budget of the call that ended the child, ms. */
  readonly killedBudgetMs: number | undefined;
  stop(): void;
}

function shortCommand(call: InFlightCall): string {
  const command = (call.args as { command?: unknown } | null)?.command;
  const text = typeof command === "string" ? collapse(command) : call.fingerprint;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / MINUTE_MS))} min`;

function callKillText(call: InFlightCall, budgetMs: number, staleMs: number): string {
  return `pi-rukas killed your tool call \`${shortCommand(call)}\`: it ran past its ${minutes(budgetMs)} budget with no new output for ${minutes(staleMs)}. Do not re-run it unchanged — a second stuck run of the same command ends this session. Bound it with \`timeout N\`, narrow it to what you need, or run it in the background with its output in a file you read.`;
}

export function armCallBudget(o: {
  child: ChildProcess;
  progress: ChildProgress;
  /** The driver's steer seam; without one the steer is written to `stdin`. */
  onSteer?: (message: string, source: SteerSource) => void;
  stdin: Writable;
  childExited: () => boolean;
  appendStderr: (s: string) => void;
  /** Injectable for tests. */
  list?: () => Promise<ProcRow[]>;
  now?: () => number;
}): CallBudget {
  const floorMs = callBudgetFloorMs();
  const staleMs = callStaleMs();
  const now = o.now ?? Date.now;
  const list = o.list ?? listProcesses;
  let stuck = false;
  let killedBudgetMs: number | undefined;
  let busy = false;
  /** Call ids already call-killed, with when. */
  const killedCalls = new Map<string, number>();
  /** Fingerprints call-killed once in this spawn. */
  const killedCommands = new Set<string>();
  const gone = () => o.childExited() || o.child.exitCode != null || o.child.signalCode != null;

  const endChild = (call: InFlightCall, budgetMs: number, why: string, group?: number) => {
    stuck = true;
    killedBudgetMs = budgetMs;
    o.appendStderr(
      `\n[pi-rukas] killed: stuck tool call \`${shortCommand(call)}\` — ${why} (budget ${minutes(budgetMs)}; override: PI_ENSEMBLE_CALL_BUDGET_MS / PI_ENSEMBLE_CALL_STALE_MS)`,
    );
    trace(`call-budget: ending child — ${why}`);
    try {
      if (group !== undefined) killGroup(group);
      killProcessTree(o.child);
    } catch (err) {
      traceWarn(`call-budget kill failed: ${String(err)}`);
    }
  };

  const callKill = async (call: InFlightCall, budgetMs: number) => {
    const childPid = o.child.pid;
    const others = o.progress
      .inFlightCalls()
      .filter((c) => c.toolName === "bash" && c.toolCallId !== call.toolCallId).length;
    const rows = childPid === undefined || call.toolName !== "bash" ? [] : await list();
    if (gone() || stuck) return;
    // The call may have ended, or the child moved on, while `ps` ran.
    const stillStuck =
      o.progress.inFlightCalls().some((c) => c.toolCallId === call.toolCallId) &&
      now() - o.progress.lastProgressAt >= staleMs;
    if (!stillStuck) return;
    const group =
      childPid === undefined ? undefined : findCallGroup(rows, childPid, call, now(), others);
    if (killedCommands.has(call.fingerprint)) {
      endChild(call, budgetMs, "a second stuck run of the same command", group);
      return;
    }
    if (group === undefined) {
      endChild(call, budgetMs, "its process could not be found to kill it alone");
      return;
    }
    killedCalls.set(call.toolCallId, now());
    killedCommands.add(call.fingerprint);
    o.progress.markKilled(call.toolCallId);
    o.appendStderr(`\n[pi-rukas] call-kill: \`${shortCommand(call)}\` (process group ${group})`);
    trace(`call-budget: call-kill pgid ${group} for ${call.toolName} ${call.toolCallId}`);
    killGroup(group);
    const message = callKillText(call, budgetMs, staleMs);
    try {
      if (o.onSteer) o.onSteer(message, "driver-call-kill");
      else o.stdin.write(`${JSON.stringify({ type: "steer", message })}\n`);
    } catch {
      /* child already gone */
    }
  };

  const poll = async () => {
    if (busy || stuck || gone()) return;
    recordLongestRuns(o.progress.longestCompleted());
    const t = now();
    // No progress anywhere in the child for `staleMs`: covers the call's own
    // update bytes and a codemode call whose nested calls are still working.
    if (t - o.progress.lastProgressAt < staleMs) return;
    const calls = o.progress.inFlightCalls();
    for (const call of calls) {
      // Judge the innermost call: a codemode call waits on its nested ones.
      if (calls.some((c) => c.toolCallId.startsWith(`${call.toolCallId}/`))) continue;
      const budgetMs = callBudgetMs(call, floorMs, longestRunMs(call.fingerprint));
      const killedAt = killedCalls.get(call.toolCallId);
      if (killedAt !== undefined) {
        if (t - killedAt >= staleMs) endChild(call, budgetMs, "the call outlived its call-kill");
        return;
      }
      if (t - call.startedAt < budgetMs || t - call.lastUpdateAt < staleMs) continue;
      busy = true;
      try {
        await callKill(call, budgetMs);
      } finally {
        busy = false;
      }
      return;
    }
  };

  const result: CallBudget = {
    stuckKilled: () => stuck,
    get killedBudgetMs() {
      return killedBudgetMs;
    },
    stop: () => {
      clearInterval(interval);
      recordLongestRuns(o.progress.longestCompleted());
    },
  };
  const interval = setInterval(
    () => void poll().catch((err) => traceWarn(`call-budget poll failed: ${String(err)}`)),
    Math.min(30_000, Math.max(250, Math.floor(Math.min(floorMs || staleMs, staleMs) / 2))),
  );
  interval.unref();
  if (floorMs <= 0) clearInterval(interval);
  return result;
}

/**
 * Fold a stuck-tool end into the result, after the cap attribution and the
 * child bound. `stuck-tool` ranks below the structural caps (loop, the
 * model-silence kill, token budget) and above everything else (spawn-caps.ts).
 */
export function applyCallBudget(cb: CallBudget, result: DispatchResult): void {
  const cause = result.killCause;
  const replaceable = !cause || ["timeout", "abort", "child-bound", "no-progress"].includes(cause);
  if (!cb.stuckKilled() || !replaceable) return;
  result.killCause = "stuck-tool";
  result.killBudgetMs = cb.killedBudgetMs;
  result.ok = false;
}
