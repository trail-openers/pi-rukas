#!/usr/bin/env bun
/**
 * #1313 part b (#1567 P9) — a headless PM question inside a running /work
 * cycle gets a deadline (question-deadline.ts), and `check_review_cap` only
 * reads: starting a timer is `start_review_cap`'s job (review-cap.ts).
 *
 * The incident: a PM asked an operator who could not answer and waited until
 * the container was stopped; and a `check_review_cap` call meant as a read
 * started a timer for a key nothing used.
 */

process.env.PI_ENSEMBLE_QUESTION_DEADLINE_MS = "40";

import {
  armQuestionDeadline,
  questionDeadlinePending,
  registerQuestionDeadline,
} from "../src/question-deadline.ts";
import { registerQuestionTool } from "../src/question-tool.ts";
import { checkReviewCap, registerCheckReviewCapTool, reset, snapshot } from "../src/review-cap.ts";
import { claimCycle, resetRegistry } from "../src/work-driver-registry.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Handler = (e: { source: string }) => unknown;
type Exec = (...args: unknown[]) => Promise<unknown>;
const sent: string[] = [];
const handlers = new Map<string, Handler>();
const tools = new Map<string, { parameters: unknown; execute: Exec }>();
const fakePi = {
  sendUserMessage: (t: string) => {
    sent.push(t);
  },
  on: (ev: string, h: Handler) => {
    handlers.set(ev, h);
  },
  registerTool: (t: { name: string; parameters: unknown; execute: Exec }) => {
    tools.set(t.name, t);
  },
} as never;
registerQuestionDeadline(fakePi);
registerQuestionTool(fakePi);
registerCheckReviewCapTool(fakePi);

const ask = async () => {
  const r = await tools
    .get("question")
    ?.execute(
      "t",
      { question: "Kill the looping child?", options: [{ label: "Kill it" }, { label: "Wait" }] },
      undefined,
      undefined,
      { mode: "rpc" },
    );
  return (r as { content: { text: string }[] }).content[0]?.text ?? "";
};

// ------------------------------------------------ 1. no cycle → no deadline
{
  resetRegistry();
  const text = await ask();
  assert(!/deadline|within/.test(text), "with no cycle running a question has no deadline");
  assert(!questionDeadlinePending(), "and nothing is armed");
}

// ------------------------------------------------ 2. a cycle → the PM is told to act
{
  const claim = claimCycle(63);
  if (!claim.ok) throw new Error("claim failed");
  const text = await ask();
  assert(/act on your default \(the first option\)/.test(text), "the reply names the deadline");
  await wait(80);
  const notice = sent.find((s) => s.startsWith("[ensemble:question-deadline]")) ?? "";
  assert(/"Kill it"/.test(notice), "at the deadline the PM is told to act on its default");
  assert(/Do not ask again/.test(notice), "and not to ask again");

  // An operator answer clears it; our own notices do not.
  sent.length = 0;
  await ask();
  handlers.get("input")?.({ source: "extension" });
  assert(questionDeadlinePending(), "a driver notice is not an answer");
  handlers.get("input")?.({ source: "rpc" });
  assert(!questionDeadlinePending(), "an operator message clears the deadline");
  await wait(80);
  assert(sent.length === 0, "no deadline notice after an answer");

  process.env.PI_ENSEMBLE_QUESTION_DEADLINE_MS = "0";
  assert(armQuestionDeadline(fakePi, "q", undefined) === "", "0 turns the deadline off");
  claim.claim.release();
}

// ------------------------------------------------ 3. check_review_cap only reads
{
  reset();
  const read = checkReviewCap("issue-63", { readOnly: true });
  assert(read.ok && read.missing === true, "a read of an unknown key reports it missing");
  assert(snapshot().length === 0, "and starts no timer");
  const viaTool = await tools
    .get("check_review_cap")
    ?.execute("t", { key: "issue-63", reset: true });
  assert(
    snapshot().length === 0 &&
      (viaTool as { details: { missing?: true } }).details.missing === true,
    "the check tool never starts a timer, even when sent reset",
  );
  await tools.get("start_review_cap")?.execute("t", { key: "issue-63" });
  assert(snapshot().length === 1, "start_review_cap starts it");
  const after = checkReviewCap("issue-63", { readOnly: true });
  assert(after.ok && !after.missing && !after.reset, "the read then reports the running timer");
  const schema = JSON.stringify(tools.get("check_review_cap")?.parameters);
  assert(!schema.includes("reset"), "check_review_cap has no reset parameter");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
