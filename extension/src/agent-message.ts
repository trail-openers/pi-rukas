/**
 * agent-message — deliver text to the parent agent without it being dropped.
 *
 * `pi.sendUserMessage(text)` is not a notification API. It calls
 * `AgentSession.prompt(text, { streamingBehavior: options?.deliverAs })`, and
 * `prompt` throws when the agent is mid-turn and no behaviour was given:
 *
 *     if (this.isStreaming) {
 *       if (!options?.streamingBehavior) {
 *         throw new Error("Agent is already processing. Specify streamingBehavior …")
 *       }
 *
 * The `ExtensionAPI` binding catches that rejection and routes it to
 * `runner.emitError({ event: "send_user_message" })`. The caller sees nothing.
 * The message is simply gone.
 *
 * Twenty of the twenty-one call sites in this extension passed no behaviour.
 * `async-jobs.ts` was the sole exception, and documented why. So the driver's
 * first message landed — it was sent while the agent was idle, and it triggered
 * a turn — and every subsequent progress message during that turn was discarded.
 * That is a large part of why `/work` cycles have felt silent.
 *
 * It matters more now than it did: a tool executes *during* a turn by
 * definition, so a driver launched from a tool is streaming for its entire
 * life, and without this every message it sends would be lost.
 *
 * `steer` rather than `followUp`: these are progress reports about work the
 * agent asked for, and they should reach it within the turn that is waiting on
 * them, not after it. When the agent is idle the flag is inert — the guard is
 * inside `if (this.isStreaming)` — so this is safe everywhere.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send text to the parent agent, queuing it if a turn is in flight. */
export function notifyAgent(pi: Pick<ExtensionAPI, "sendUserMessage">, text: string): void {
  pi.sendUserMessage(text, { deliverAs: "steer" });
}
