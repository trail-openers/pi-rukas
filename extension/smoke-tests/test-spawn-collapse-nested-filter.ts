#!/usr/bin/env bun
/**
 * #2618 — the nested read credits ONLY the two lean companion tools, in a real
 * child's transcript.
 *
 * The gate this file is the "observed red" for: delete the name filter from
 * `creditNestedReporterCalls` and case (2) fails, because every nested `read`,
 * `bash`, `edit` and `write` the child ran inside its codemode script would land
 * in `DispatchResult.toolUses` — the array the skill-load proof, the
 * unproven-HIGH bash-reproduction join, and every dispatch report read as the
 * child's tool calls. "Only those two names ever enter toolUses" is a claim about
 * a child that used codemode the way children actually use it, so that is what is
 * replayed here: reads, an edit, a test run and a submission, in one script.
 *
 * Case (3) pins the other direction: the credited rows really are the calls, with
 * their arguments, in Pi's record order — the filter is not a blanket refusal.
 */

import type { PiMessage } from "../src/pi-event-shapes.ts";
import { collapseEvents } from "../src/spawn-collapse-events.ts";
import {
  agentEnd,
  codemodeResult,
  codemodeTurn,
  directCallTurn,
  directResult,
  nestedOk,
  nestedUnfinished,
  submitArgs,
} from "./fixtures/nested-call-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function collapse(messages: PiMessage[]) {
  return collapseEvents(agentEnd(messages), null, "developer", 10, 0, "");
}

function names(toolUses: unknown[]): string[] {
  return toolUses.map((tu) => (tu as { name?: string }).name ?? "");
}

// A child that read the spec, edited a test, ran it, and submitted — all inside
// one codemode script, plus one direct bash call of its own.
const transcript: PiMessage[] = [
  directCallTurn("bash", "call-bash", { command: "cat issue.json" }),
  directResult("call-bash", "bash"),
  codemodeTurn("call-cm", "tools.read({path:'docs/spec.md'}); …"),
  codemodeResult("call-cm", [
    nestedOk("call-cm/1", "read", { path: "docs/spec.md" }),
    nestedOk("call-cm/2", "read", { path: "src/retry.ts" }),
    nestedOk("call-cm/3", "edit", { path: "tests/AC1.test.sh", edits: [] }),
    nestedOk("call-cm/4", "bash", { command: "sh tests/AC1.test.sh" }),
    nestedOk("call-cm/5", "submit_tests", submitArgs("AC1", ["tests/AC1.test.sh"])),
    nestedUnfinished("call-cm/6", "bash", "error", { command: "sh tests/AC2.test.sh" }),
  ]),
];

{
  const result = collapse(transcript);
  assert(
    names(result.toolUses).join() === "bash,codemode,submit_tests",
    `(1) only the child's own two calls and the one nested submission are tool uses (got ${JSON.stringify(names(result.toolUses))})`,
  );
  // The whole point of the name filter: the other four nested rows are not
  // evidence of anything, and the lens/adversarial consumers of toolUses must not
  // see a nested bash as the child having reproduced a finding.
  const seen = names(result.toolUses);
  for (const forbidden of ["read", "edit"]) {
    assert(
      !seen.includes(forbidden),
      `(2) a nested \`${forbidden}\` never enters toolUses — the filter, not the transcript, is what keeps it out`,
    );
  }
  assert(
    seen.filter((n) => n === "bash").length === 1,
    `(2) and the child's nested test runs are not counted as its own bash calls (got ${String(seen.filter((n) => n === "bash").length)})`,
  );
  // The tool RESULTS channel is untouched: what Pi accepted is what the child
  // asked for directly, never a nested row.
  assert(
    (result.toolResults ?? []).map((r) => r.toolName).join() === "bash,codemode",
    `(3) toolResults still carries only the parent results (got ${JSON.stringify((result.toolResults ?? []).map((r) => r.toolName))})`,
  );
  assert(
    (result.toolResults ?? []).every((r) => !r.toolName.includes("submit_tests")),
    "(3) and no nested row pretends to be a result Pi accepted",
  );
}

{
  // The filter's other edge: it credits the calls it is meant to, with arguments,
  // in Pi's record order — not a blanket refusal that happens to pass (1).
  const result = collapse([
    codemodeTurn("call-cm"),
    codemodeResult("call-cm", [
      nestedOk("call-cm/1", "bash", { command: "ls" }),
      nestedOk("call-cm/2", "submit_tests", submitArgs("AC2", ["tests/AC2.test.sh"])),
      nestedOk("call-cm/3", "read", { path: "x" }),
      nestedOk("call-cm/4", "submit_tests", submitArgs("AC3", ["tests/AC3.test.sh"])),
    ]),
  ]);
  assert(
    names(result.toolUses).join() === "codemode,submit_tests,submit_tests",
    `(4) the submissions are credited in Pi's record order, between the calls that were not (got ${JSON.stringify(names(result.toolUses))})`,
  );
  const args = result.toolUses.slice(1).map((tu) => (tu as { arguments?: unknown }).arguments);
  assert(
    JSON.stringify(args) ===
      JSON.stringify([submitArgs("AC2", ["tests/AC2.test.sh"]), submitArgs("AC3", ["tests/AC3.test.sh"])]),
    `(4) with the arguments each call carried (got ${JSON.stringify(args)})`,
  );
}

process.exit(exit);
