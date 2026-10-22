/**
 * Shared fixtures for the #1765 base-health probe's FAILURE arms and the
 * develop gate's REUSE path.
 *
 * Three helpers, each shared because two files assert against them and a
 * fixture that drifts between them lets one test a shape the other never
 * writes:
 *
 *  - `stateWithRedProbe` — a branch-step state carrying a RED verdict for the
 *    develop gate's reuse. The probe suite checks what the branch step RECORDS
 *    (including which red arm it earned); the attribution suite checks what the
 *    develop gate REBUILDS from it. Dropping `timedOut` on the rebuild is the
 *    #1765 lens-round-1 defect, and only a shared writer keeps both sides
 *    agreed on what the record says.
 *  - `probeFailureExecutor` — an executor that fails the PROJECT's command in a
 *    chosen shape and runs every git call for real. It identifies the gate by
 *    what lives in the child's cwd rather than by the command string, so a case
 *    can never reject the probe's own `git worktree add` and report a verdict no
 *    gate produced.
 *  - `announceGate` / `commitAll` — the one way these fixtures put a marker on a
 *    gate and land it at the base commit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { initialState } from "../../src/workflow-state.ts";
import type { WorkState } from "../../src/workflow-state.ts";
import { realExec } from "./restore-start-ref-fixtures.ts";

/**
 * How an executor fails the PROJECT's command. Each arm names what it proves:
 * a rejection with a stream, a rejection with none (the harness echo), a
 * rejection the run was killed for, or an executor that never reached the
 * child at all — the last is the shape the branch probe must degrade on rather
 * than crash on, and no child rejection can produce it.
 */
export type ProbeFailureShape = "pass" | "red" | "echo-only" | "killed" | "executor-threw";

/** Commit whatever the working tree holds — a rewritten gate, a seeded test. */
export function commitAll(repo: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo });
}

/**
 * The line a fixture gate prints before it execs the real verify loop. A case
 * that must fail the project's command while its output still reaches the
 * matcher looks for it; a git call never prints it, however it is spelled.
 */
export const GATE_ECHO = "GATE-RUN";

/**
 * Prefix a fixture's `gate.sh` with an announce line, after its shebang so the
 * script still runs. The cwd travels with the echo, so a case can also assert
 * WHICH tree executed the gate. Returns the marker, for the executor to match.
 */
export function announceGate(gateFile: string, marker: string = GATE_ECHO): string {
  const lines = readFileSync(gateFile, "utf8").split(String.fromCharCode(10));
  lines.splice(lines[0]?.startsWith("#!") ? 1 : 0, 0, `echo ${marker} "$PWD"`);
  writeFileSync(gateFile, lines.join(String.fromCharCode(10)), { mode: 0o755 });
  return marker;
}

/**
 * A state whose `pipelineState.baseHealthProbe` is a RED for exactly this
 * (base, command, bound), as the branch step leaves it.
 */
export function stateWithRedProbe(
  baseSha: string,
  cmd: string,
  tierBoundMs: number,
  opts: { timedOut?: boolean; issue?: number } = {},
): WorkState {
  const state = initialState(opts.issue ?? 1765);
  state.pipelineState.baseSha = baseSha;
  state.pipelineState.baseHealthProbe = {
    status: "red",
    baseSha,
    command: cmd,
    tierBoundMs,
    ...(opts.timedOut === true ? { timedOut: true as const } : {}),
  };
  return state;
}

/**
 * Wrap the real executor so the PROJECT's command (any call whose cwd holds a
 * `gate.sh`) rejects in `shape`, while every git call runs for real so the
 * probe's worktree plumbing stays exercised rather than stubbed away.
 *
 * `outputMustContain` narrows the rejection to runs whose own output carries the
 * marker — how a case fails a real gate without failing a sibling call.
 * `onGate` sees each project-command call with its cwd, so a case can count
 * gate runs (which keeps a rejection case from passing vacuously) and assert
 * which tree executed.
 */
export function probeFailureExecutor(opts: {
  shape: ProbeFailureShape;
  /**
   * The marker a gate script must carry to be "the project's command". Read
   * from the SCRIPT rather than from the run's output: the fixture loop exits
   * at its first failure, so a red gate never gets to print an announce line
   * after the tests start, and a case that matched on output would silently
   * match nothing and let the real gate answer instead of the arm under test.
   */
  gateMarker?: string;
  onGate?: (line: string, cwd: string) => void;
  /**
   * `"before"` (the default) throws when the executor is asked to run the
   * project's command, which is a REJECTION the probe reads as a failed run.
   * `"git"` throws on every git call instead — which reaches the probe from
   * OUTSIDE its own try, because the probe's `git worktree add` and
   * `provisionWorktree` run before it: that is the shape the branch step must
   * degrade on rather than crash on, and the one a rejection of the project's
   * command cannot produce.
   */
  throwWhere?: "before" | "git";
}) {
  return async (command: string, o?: Parameters<typeof realExec>[1]) => {
    const line = o?.argv ? [command, ...o.argv].join(" ") : command;
    const isGit = line.startsWith("git ");
    if (opts.shape === "executor-threw" && opts.throwWhere === "git" && isGit) {
      throw new Error("executor exploded: fork: retry: Resource temporarily unavailable");
    }
    if (opts.shape === "pass" || isGit || !isGateCall(o?.cwd, opts.gateMarker)) {
      return await realExec(command, o);
    }
    opts.onGate?.(line, o?.cwd ?? "");
    switch (opts.shape) {
      case "red":
        // The real gate, failing for its own reasons: the control that makes
        // the rejection arms below non-vacuous.
        return await realExec(command, o);
      case "killed":
        throw Object.assign(new Error(`Command failed: ${command}`), { killed: true });
      case "echo-only":
        // No stdout, no stderr, no exit code: what the stream reduces to is
        // node's own `Command failed:` message and nothing else.
        throw new Error(`Command failed: ${command}`);
      case "executor-threw":
        throw new Error("executor exploded: fork: retry: Resource temporarily unavailable");
      case "pass":
        return await realExec(command, o);
    }
  };
}

/**
 * Is this call the project's gate? True when the cwd holds a `gate.sh` (the
 * fixture vocabulary's marker for "this tree carries the project's command")
 * that either carries the caller's marker or, when none was given, is a
 * fixture loop script at all. A git argv call never resolves to one.
 */
function isGateCall(cwd: string | undefined, marker: string | undefined): boolean {
  if (!cwd) return false;
  try {
    const file = `${cwd}/gate.sh`;
    if (!existsSync(file)) return false;
    if (marker === undefined) return true;
    return readFileSync(file, "utf8").includes(marker);
  } catch {
    return false;
  }
}
