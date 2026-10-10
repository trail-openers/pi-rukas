#!/usr/bin/env bun
/**
 * The question tool must be usable by a session that has no terminal.
 *
 * In RPC mode nobody can press a key inside the tool call, so the tool records
 * the question in its result and tells the agent to end its turn; the client
 * delivers the answer as the next message. Every other non-terminal mode keeps
 * the error it had.
 */

import { registerQuestionTool } from "../src/question-tool.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
const tools: any[] = [];
const fakePi = {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  registerTool(def: any) {
    tools.push(def);
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
} as any;
registerQuestionTool(fakePi);
const tool = tools[0];

const params = {
  question: "Adopt my resolutions?",
  options: [{ label: "Adopt all", description: "Apply all five" }, { label: "Change some" }],
};

const rpc = await tool.execute("call-1", params, undefined, undefined, { mode: "rpc" });
assert(rpc.details.deferred === true, "rpc: the result says the question was deferred");
assert(rpc.details.answer === null, "rpc: there is no answer yet");
assert(rpc.details.question === "Adopt my resolutions?", "rpc: the question is in the details");
assert(
  JSON.stringify(rpc.details.options) === JSON.stringify(["Adopt all", "Change some"]),
  "rpc: the option labels are in the details",
);
assert(
  JSON.stringify(rpc.details.optionDetails) ===
    JSON.stringify([
      { label: "Adopt all", description: "Apply all five" },
      { label: "Change some", description: "" },
    ]),
  "rpc: every option carries its description, empty when it has none",
);
assert(
  rpc.content[0].text.includes("End your turn"),
  "rpc: the agent is told to end its turn",
);

const none = await tool.execute(
  "call-2",
  { question: "Which branch?", options: [] },
  undefined,
  undefined,
  { mode: "rpc" },
);
assert(none.details.deferred === true, "rpc: a question without options is still asked");

const print = await tool.execute("call-3", params, undefined, undefined, { mode: "print" });
assert(
  print.content[0].text.startsWith("Error: UI not available"),
  "print: the error is unchanged",
);
assert(print.details.deferred === undefined, "print: nothing is deferred");

process.exit(exit);
