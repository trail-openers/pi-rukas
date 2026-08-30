/**
 * pm-mode — the session flags that keep PM in orchestration mode.
 *
 * These were file-private `let`s in `commands.ts`, which was fine while only a
 * slash command could arm them. A tool that starts a `/work` cycle needs the
 * same arming, so they live here and both paths go through the same door.
 *
 * `doctrineFirstTurnPending` — one-shot for injecting the FULL project-manager
 * doctrine on the first turn after a workflow command fires. Cleared after the
 * first `agent_start` so the 53K-char doctrine is not re-injected every turn.
 *
 * `pmModeActive` — sticky for the rest of the session. While true, every PM
 * `agent_start` gets a short preamble reminding the model that it must not edit
 * or write code itself. This closes the live-test bug where PM had the doctrine
 * only on turn 1 and reached for the edit tool on turns 2+ once it fell out of
 * context.
 */

let doctrineFirstTurnPending = false;
let pmModeActive = false;

/**
 * Enter PM mode, arming the one-shot doctrine only on the way in.
 *
 * The re-arm is conditional deliberately. A slash command is rate-limited by a
 * human typing it; a tool is not, and an LLM that calls `start_work_driver`
 * three times would otherwise queue the full 53K-char doctrine three times.
 * Once PM mode is already active the sticky preamble is doing its job and the
 * full doctrine adds nothing.
 *
 * Tool stripping (setActiveTools) is handled by `stripPmTools` in commands.ts,
 * called immediately after armPmMode in every caller.  This separation keeps
 * pm-mode.ts free of ExtensionAPI dependencies.
 */
export function armPmMode(): void {
  if (!pmModeActive) doctrineFirstTurnPending = true;
  pmModeActive = true;
}

export function isPmModeActive(): boolean {
  return pmModeActive;
}

/** Read and clear the one-shot. */
export function takeDoctrinePending(): boolean {
  const pending = doctrineFirstTurnPending;
  doctrineFirstTurnPending = false;
  return pending;
}

/** For `/ensemble-debug` — reads without clearing. */
export function peekDoctrinePending(): boolean {
  return doctrineFirstTurnPending;
}

/** Test-only: return to a fresh session's state. */
export function resetPmMode(): void {
  doctrineFirstTurnPending = false;
  pmModeActive = false;
}
