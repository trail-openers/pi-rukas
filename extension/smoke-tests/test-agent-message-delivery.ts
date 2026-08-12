#!/usr/bin/env bun
/**
 * Messages to the parent agent must survive a turn being in flight.
 *
 * `pi.sendUserMessage(text)` is not a notification API. It calls
 * `AgentSession.prompt(text, { streamingBehavior: options?.deliverAs })`, and
 * `prompt` throws when the agent is mid-turn and no behaviour was given
 * (`agent-session.js:828-831`). The `ExtensionAPI` binding catches that and
 * routes it to `runner.emitError` — so the caller sees nothing and the message
 * is gone.
 *
 * Twenty of twenty-one call sites in this extension passed no behaviour.
 * `async-jobs.ts` was the sole exception and documented why. The driver's first
 * message landed (sent while idle, it started a turn) and everything it said
 * during that turn was discarded.
 *
 * This matters more now: a tool executes DURING a turn by definition, so a
 * driver launched from `start_work_driver` is streaming for its whole life.
 * Without `deliverAs`, every message it sent would be lost.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { notifyAgent } from "../src/agent-message.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------ the helper's contract

{
  const calls: Array<{ text: string; options?: { deliverAs?: string } }> = [];
  const fakePi = {
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      calls.push({ text, options });
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub; only the one method is used
  } as any;

  notifyAgent(fakePi, "step complete");
  assert(calls.length === 1, "the message is forwarded");
  assert(calls[0]?.text === "step complete", "...unchanged");
  assert(
    calls[0]?.options?.deliverAs === "steer",
    "canary: it carries deliverAs — without this pi throws mid-turn and the message is swallowed",
  );
}

// ------------------------------------- no bare call sites are left in the tree

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  // A bare `sendUserMessage(x)` — no second argument on the same line, and not
  // inside a comment. Two files are legitimately exempt: the helper itself, and
  // async-jobs.ts which passes deliverAs directly and predates the helper.
  const EXEMPT = new Set(["agent-message.ts", "async-jobs.ts", "types.ts"]);
  const offenders: string[] = [];

  for (const name of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    if (EXEMPT.has(name)) continue;
    const text = readFileSync(path.join(SRC, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    for (const line of text.split("\n")) {
      if (!/\.sendUserMessage\(/.test(line)) continue;
      if (/deliverAs/.test(line)) continue;
      offenders.push(`${name}: ${line.trim().slice(0, 70)}`);
    }
  }

  assert(
    offenders.length === 0,
    `no module calls sendUserMessage without deliverAs${
      offenders.length ? ` — found: ${offenders.join(" | ")}` : " (use notifyAgent)"
    }`,
  );
}

// ------------------------------- and the exempt file really is still steering

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const asyncJobs = readFileSync(path.join(SRC, "async-jobs.ts"), "utf8");
  assert(
    /sendUserMessage\([^)]*deliverAs:\s*"steer"/.test(asyncJobs),
    "async-jobs.ts — the one site that always got this right — still passes deliverAs",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
