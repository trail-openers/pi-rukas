#!/usr/bin/env bun
/**
 * #2618 — a child that submits its tests from inside a codemode script is credited.
 *
 * Pi records calls a tool made to other tools on the PARENT call's `toolResult`
 * message as `nestedCalls` (pi-ai `ToolResultMessage`), never as assistant
 * `toolCall` blocks. `collapseEvents` read only assistant blocks into
 * `DispatchResult.toolUses`, so a specify child that submitted everything from
 * one codemode script read as silent and the step re-dispatched a fresh author on
 * a reset tree (the canary: 441 s of a 1006 s specify step).
 *
 * The rules this file pins (the issue's decisions):
 *   (1) a nested `submit_tests` row with status `ok` reaches `toolUses` after its
 *       PARENT codemode call, carrying its arguments;
 *   (2) a direct call and a nested one are each credited once, in transcript
 *       order (all of the child's own blocks first, then each nested run in its
 *       parent result's order), and a nested call to ANY other tool — including a
 *       plan child's `report_plan_item` — never enters `toolUses` (so the
 *       lens/adversarial evidence consumers cannot be moved by this read);
 *   (3) a row whose status is `error` or `unfinished` is neither credited nor
 *       counted as unreadable — it is not a call the child completed;
 *   (4) a row whose `arguments` Pi dropped (over its size bound) is NOT credited
 *       as files but DOES reach the real extractors as one unreadable call, so
 *       the step names an unreadable submission instead of "never submitted";
 *   (5) `complete: false` credits the surviving `ok` rows and traces the
 *       incomplete case (the flag itself is not carried on the entry);
 *   (6) two codemode calls in one turn keep Pi's record order within each result,
 *       and results keep message order across them;
 *   (7) the `lastAssistantMessageEnd` fallback carries no tool result at all, so
 *       it keeps today's silence reading — disclosed, not fixed.
 */

import { extractBlockedReport } from "../src/lean/build-blocked-extract.ts";
import { extractSubmitTests } from "../src/lean/submit-tests-extract.ts";
import type { PiMessage } from "../src/pi-event-shapes.ts";
import { collapseEvents } from "../src/spawn-collapse-events.ts";
import {
  blockedArgs,
  codemodeResult,
  codemodeTurn,
  directCallTurn,
  directResult,
  nestedArgsOmitted,
  nestedOk,
  nestedUnfinished,
  submitArgs,
  type agentEnd,
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
  return collapseEvents({ type: "agent_end", messages } as never, null, "developer", 10, 0, "");
}

/** The tool names on a collapsed result, in order. */
function names(toolUses: unknown[]): string[] {
  return toolUses.map((tu) => (tu as { name?: string }).name ?? "");
}

// ── (1) a nested submit_tests is credited, in place, with its arguments ─────
{
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult("call-codemode-1", [
      nestedOk("call-codemode-1/1", "submit_tests", submitArgs("AC1", ["tests/AC1-a.test.sh"])),
      nestedOk("call-codemode-1/2", "submit_tests", submitArgs("AC2", ["tests/AC2.test.sh"])),
    ]),
  ]);
  assert(
    names(result.toolUses).join() === "codemode,submit_tests,submit_tests",
    `(1) the two nested submissions reach toolUses (got ${JSON.stringify(names(result.toolUses))})`,
  );
  const { rows, skipped } = extractSubmitTests(result.toolUses);
  assert(
    skipped === 0 && rows.length === 2 && rows[0]?.criterionId === "AC1" && rows[1]?.criterionId === "AC2",
    `(1) and the real extractor reads both rows in Pi's record order (got ${JSON.stringify(rows)}, skipped ${skipped})`,
  );
  assert(
    rows[0]?.testFiles.join() === "tests/AC1-a.test.sh",
    `(1) with the arguments Pi recorded (got ${JSON.stringify(rows[0])})`,
  );
  // The nested rows must not be mistaken for a tool result the child produced.
  assert(
    (result.toolResults ?? []).length === 1,
    `(1) the nested rows are not added to toolResults (got ${String(result.toolResults?.length)})`,
  );
}

// ── (2) placement, one-per-call, and no other tool ever enters toolUses ─────
{
  // Direct first, then a codemode call that submits the OTHER criterion, and a
  // bash call after it. Each call is the unit of record: the direct row and the
  // nested row are two entries, ordered as the transcript records them — the
  // child's own blocks in turn order, then the nested runs in result order.
  const result = collapse([
    directCallTurn("submit_tests", "call-direct", submitArgs("AC1", ["tests/AC1.test.sh"])),
    codemodeTurn("call-codemode-1"),
    directCallTurn("bash", "call-bash", { command: "ls" }),
    directResult("call-direct", "submit_tests"),
    codemodeResult("call-codemode-1", [
      nestedOk("call-codemode-1/1", "submit_tests", submitArgs("AC2", ["tests/AC2.test.sh"])),
    ]),
    directResult("call-bash", "bash"),
  ]);
  assert(
    names(result.toolUses).join() === "submit_tests,codemode,bash,submit_tests",
    `(2) direct and nested each land once, the nested run after its parent's block (got ${JSON.stringify(names(result.toolUses))})`,
  );
  const { rows, skipped } = extractSubmitTests(result.toolUses);
  assert(
    skipped === 0 && rows.length === 2 && rows[0]?.criterionId === "AC1" && rows[1]?.criterionId === "AC2",
    `(2) so the step sees both criteria, each credited once (got ${JSON.stringify(rows)}, skipped ${skipped})`,
  );
}
{
  // A nested call to another tool is not credited — and a plan child's own
  // reporting tool proves the plan channel is untouched by this read.
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult("call-codemode-1", [
      nestedOk("call-codemode-1/1", "report_plan_item", { kind: "fact", text: "a decision" }),
      nestedOk("call-codemode-1/2", "read", { path: "src/a.ts" }),
      nestedOk("call-codemode-1/3", "bash", { command: "ls" }),
    ]),
  ]);
  assert(
    names(result.toolUses).join() === "codemode",
    `(2) nested report_plan_item / read / bash never enter toolUses (got ${JSON.stringify(names(result.toolUses))})`,
  );
  assert(
    extractSubmitTests(result.toolUses).rows.length === 0 &&
      extractBlockedReport(result.toolUses).rows.length === 0,
    "(2) and neither extractor reads anything from them",
  );
}

// ── (3) error / unfinished rows are neither credited nor unreadable ─────────
{
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult("call-codemode-1", [
      nestedUnfinished("call-codemode-1/1", "submit_tests", "error"),
      nestedUnfinished("call-codemode-1/2", "submit_tests", "unfinished"),
      nestedUnfinished("call-codemode-1/3", "report_blocked", "error", blockedArgs([])),
      nestedUnfinished("call-codemode-1/4", "report_blocked", "unfinished", blockedArgs([])),
    ]),
  ]);
  assert(
    names(result.toolUses).join() === "codemode",
    `(3) an errored or unfinished nested call is not credited (got ${JSON.stringify(names(result.toolUses))})`,
  );
  const submit = extractSubmitTests(result.toolUses);
  const blocked = extractBlockedReport(result.toolUses);
  assert(
    submit.rows.length === 0 && submit.skipped === 0,
    `(3) and it is not counted as an unreadable submit_tests either (rows ${submit.rows.length}, skipped ${submit.skipped})`,
  );
  assert(
    blocked.rows.length === 0 && blocked.skipped === 0,
    `(3) nor as an unreadable report_blocked (rows ${blocked.rows.length}, skipped ${blocked.skipped})`,
  );
}

// ── (4) arguments Pi dropped: not files, but ONE unreadable call ────────────
{
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult("call-codemode-1", [
      nestedArgsOmitted("call-codemode-1/1", "submit_tests"),
    ]),
  ]);
  assert(
    names(result.toolUses).join() === "codemode,submit_tests",
    `(4a) an argument-less nested submit_tests still reaches toolUses (got ${JSON.stringify(names(result.toolUses))})`,
  );
  const { rows, skipped } = extractSubmitTests(result.toolUses);
  assert(
    rows.length === 0 && skipped === 1,
    `(4a) and the real extractor counts it as one unreadable call, not a silent child (rows ${rows.length}, skipped ${skipped})`,
  );
}
{
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult("call-codemode-1", [
      nestedArgsOmitted("call-codemode-1/1", "report_blocked"),
    ]),
  ]);
  assert(
    names(result.toolUses).join() === "codemode,report_blocked",
    `(4b) an argument-less nested report_blocked still reaches toolUses (got ${JSON.stringify(names(result.toolUses))})`,
  );
  const { rows, skipped } = extractBlockedReport(result.toolUses);
  assert(
    rows.length === 0 && skipped === 1,
    `(4b) and the blocked extractor counts it as one unreadable report, not an empty one (rows ${rows.length}, skipped ${skipped})`,
  );
}

// ── (5) complete: false credits the surviving ok rows ───────────────────────
{
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult(
      "call-codemode-1",
      [
        nestedOk("call-codemode-1/1", "submit_tests", submitArgs("AC1", ["tests/AC1.test.sh"])),
        nestedUnfinished("call-codemode-1/2", "submit_tests", "error"),
      ],
      false,
    ),
  ]);
  assert(
    names(result.toolUses).join() === "codemode,submit_tests",
    `(5) an incomplete record still credits the rows that survived (got ${JSON.stringify(names(result.toolUses))})`,
  );
  const { rows, skipped } = extractSubmitTests(result.toolUses);
  assert(
    rows.length === 1 && rows[0]?.criterionId === "AC1" && skipped === 0,
    `(5) as the rows the child completed (got ${JSON.stringify(rows)})`,
  );
  // The flag is not carried on the entry: the entry shape stays what the
  // extractors already accept, so no reader has to learn a new field.
  const credited = result.toolUses[1] as Record<string, unknown>;
  assert(
    !("complete" in credited) && !("nested" in credited),
    `(5) and the incomplete flag is not carried on the toolUses entry (got ${JSON.stringify(Object.keys(credited))})`,
  );
}

// ── (6) two codemode calls in one turn: record order within each result ─────
{
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeTurn("call-codemode-2"),
    codemodeResult("call-codemode-1", [
      nestedOk("call-codemode-1/1", "submit_tests", submitArgs("AC1", ["tests/AC1.test.sh"])),
      nestedOk("call-codemode-1/2", "report_blocked", blockedArgs([])),
    ]),
    codemodeResult("call-codemode-2", [
      nestedOk("call-codemode-2/1", "submit_tests", submitArgs("AC2", ["tests/AC2.test.sh"])),
    ]),
  ]);
  assert(
    names(result.toolUses).join() ===
      "codemode,codemode,submit_tests,report_blocked,submit_tests",
    `(6) the assistant blocks come first and each nested run follows its own parent's result (got ${JSON.stringify(names(result.toolUses))})`,
  );
  assert(
    (result.toolResults ?? []).length === 2,
    `(6) the two parent results are unchanged (got ${String(result.toolResults?.length)})`,
  );
}

// ── (7) the message_end fallback keeps today's silence reading ──────────────
{
  // No agent_end at all: the fallback carries the last assistant message and NO
  // tool result, so there is no nestedCalls to read. Disclosed in the module
  // header; a child killed before its result arrived stays silent.
  const fallback = collapseEvents(
    null,
    { type: "message_end", message: codemodeTurn("call-codemode-1") } as never,
    "developer",
    10,
    0,
    "",
  );
  assert(
    names(fallback.toolUses).join() === "codemode",
    `(7) the fallback arm still reports only the assistant block (got ${JSON.stringify(names(fallback.toolUses))})`,
  );
  assert(
    extractSubmitTests(fallback.toolUses).rows.length === 0,
    "(7) and a nested-only submitter in that arm is still silent (disclosed, not fixed)",
  );
}

// ── (8) a child whose only calls are nested is not idle ────────────────────
{
  // build-dispatch's didNoWork reads toolUses.length, so the credit also un-does
  // the second half of the bug: a nested-only child was idle evidence.
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult("call-codemode-1", [
      nestedOk("call-codemode-1/1", "submit_tests", submitArgs("AC1", ["tests/AC1.test.sh"])),
    ]),
  ]);
  const { didNoWork } = await import("../src/lean/build-dispatch.ts");
  assert(
    didNoWork(result) === false,
    "(8) a child whose only calls were nested is not read as having done no work",
  );
  assert(
    result.usage !== undefined && result.usage.turns === 1,
    `(8) while the turn count still counts only the assistant turn (got ${String(result.usage?.turns)})`,
  );
}

process.exit(exit);
