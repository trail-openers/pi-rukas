/**
 * question-deadline — a headless PM question raised while a /work cycle runs
 * gets a deadline (#1313 part b, #1567 piece P9).
 *
 * With no terminal, the `question` tool can only record the question and tell
 * the PM to end its turn (question-tool.ts). Inside a running cycle nobody
 * answers that: a PM asked the operator what to do about a looping child, said
 * at the next notice "the operator hasn't answered my question yet … I won't do
 * it without their answer", and the container was stopped 23 minutes later
 * with the cycle still running.
 *
 * So while a cycle is live in this process the deferred question carries a
 * deadline (`PI_ENSEMBLE_QUESTION_DEADLINE_MS`, 5 min; `0` turns it off). The
 * tool's reply tells the PM to put its default first; if no operator message
 * (input from the terminal or the RPC client, not one of our own notices)
 * arrives by then, the PM is told to act on that default and report what it
 * did. A question asked with no cycle running keeps today's behaviour: an RPC
 * client that relays questions has no reason to be hurried.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import { liveCycleIssues } from "./work-driver-registry.ts";

/** The deadline, ms; 0 when off. */
export function questionDeadlineMs(): number {
  const raw = process.env.PI_ENSEMBLE_QUESTION_DEADLINE_MS;
  if (raw === undefined || raw === "") return 5 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60_000;
}

let pending: ReturnType<typeof setTimeout> | undefined;

function clear(): void {
  if (pending) clearTimeout(pending);
  pending = undefined;
}

function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} minute(s)`;
}

/** The text sent to the PM when the deadline passes. */
export function deadlineText(
  question: string,
  defaultLabel: string | undefined,
  ms: number,
): string {
  const act = defaultLabel
    ? `Act now on your stated default — "${defaultLabel}" —`
    : "Act now on the safest default you named";
  return `[ensemble:question-deadline] No operator answer to your question ("${question.slice(0, 200)}") arrived within ${minutes(ms)}, and none will while this /work cycle runs. ${act} and report what you did and why. Do not ask again.`;
}

/**
 * Arm the deadline for a deferred question. Returns the sentence the tool's
 * reply appends, or "" when no deadline applies (no live cycle, or turned off).
 * A newer question replaces an older one's deadline.
 */
export function armQuestionDeadline(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  question: string,
  defaultLabel: string | undefined,
): string {
  const ms = questionDeadlineMs();
  if (ms === 0 || liveCycleIssues().length === 0) return "";
  clear();
  pending = setTimeout(() => {
    pending = undefined;
    // The cycle ended first: the operator can be asked again, so nothing is forced.
    if (liveCycleIssues().length === 0) return;
    trace("question-deadline: no operator answer — telling the PM to act on its default");
    try {
      notifyAgent(pi, deadlineText(question, defaultLabel, ms));
    } catch (err) {
      trace(`question-deadline: notice failed: ${(err as Error).message}`);
    }
  }, ms);
  pending.unref?.();
  return ` A /work cycle is running, so an answer may never come: if none arrives within ${minutes(ms)} you will be told to act on your default (the first option) — make sure it is the one you would choose.`;
}

/** An operator message (terminal or RPC client) answers the question; our own notices do not. */
export function registerQuestionDeadline(pi: ExtensionAPI): void {
  pi.on("input", (event) => {
    if (event.source !== "extension") clear();
    return { action: "continue" };
  });
  pi.on("session_shutdown", () => clear());
}

/** Test-only: is a deadline pending? */
export function questionDeadlinePending(): boolean {
  return pending !== undefined;
}
