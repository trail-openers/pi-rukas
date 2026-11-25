#!/usr/bin/env bun
/**
 * #2618 — the rename canary for the two nested-credited tool names.
 *
 * `spawn-collapse-events.ts` credits a nested record by its tool NAME. The name
 * is written by the companion that registers the tool, compared by the extractor
 * that reads the direct call, and compared again by the transport that reads the
 * nested row. Three sites, one string: rename it and the child keeps calling it
 * while every reader quietly reads a silent child — the exact failure this issue
 * exists to delete, re-created by the fix itself.
 *
 * So the fix names the two tools once (`src/lean-reporter-tools.ts`), and this
 * file pins the agreement three ways:
 *   (1) each companion really registers the constant's name (a rename at the
 *       constant stops the companion test, not just a comment);
 *   (2) a collapsed nested row is read by the REAL extractors — the names the
 *       transport credits are the names the extractors accept, end to end;
 *   (3) a name OUTSIDE the credited set earns nothing, so the set is closed and
 *       not "everything except these two".
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { REPORT_BLOCKED_TOOL, SUBMIT_TESTS_TOOL } from "../src/lean-reporter-tools.ts";
import { BLOCKED_REPORTER_PATH } from "../src/lean/build-blocked-reporter.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "../src/lean/submit-tests-reporter.ts";
import { extractBlockedReport } from "../src/lean/build-blocked-extract.ts";
import { extractSubmitTests } from "../src/lean/submit-tests-extract.ts";
import { collapseEvents } from "../src/spawn-collapse-events.ts";
import type { PiMessage } from "../src/pi-event-shapes.ts";
import {
  blockedArgs,
  codemodeResult,
  codemodeTurn,
  nestedOk,
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
  return collapseEvents({ type: "agent_end", messages } as never, null, "developer", 1, 0, "");
}

/** The name a companion registers, read out of its own source. */
function registeredName(reporterPath: string): string {
  const src = readFileSync(reporterPath, "utf8");
  // Either a string literal or the shared constant (`name: SUBMIT_TESTS_TOOL`):
  // the canary has to read what the companion REGISTERS, however it spells it,
  // since a rename can land at either the literal or the constant.
  const m = /registerTool\(\{\s*name:\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/.exec(src);
  assert(m !== null, `the companion at ${reporterPath} registers a named tool`);
  const literal = m?.[1];
  if (literal !== undefined) return literal;
  const symbol = m?.[2] ?? "";
  const declared = new RegExp(`${symbol}\\s*=\\s*"([^"]+)"`).exec(
    readFileSync(path.join(import.meta.dirname, "..", "src", "lean-reporter-tools.ts"), "utf8"),
  );
  assert(
    declared !== null,
    `the companion at ${reporterPath} names ${symbol}, which the constants module does not define`,
  );
  return declared?.[1] ?? "";
}

// (1) the constant is what each companion registers.
{
  const submitName = registeredName(SUBMIT_TESTS_REPORTER_PATH);
  assert(
    submitName === SUBMIT_TESTS_TOOL,
    `(1) the specify companion registers ${SUBMIT_TESTS_TOOL} (got ${submitName})`,
  );
  const blockedName = registeredName(BLOCKED_REPORTER_PATH);
  assert(
    blockedName === REPORT_BLOCKED_TOOL,
    `(1) the build companion registers ${REPORT_BLOCKED_TOOL} (got ${blockedName})`,
  );
}

// (2) the transport's credited names are the extractors' accepted names, end to end.
{
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult("call-codemode-1", [
      nestedOk("call-codemode-1/1", SUBMIT_TESTS_TOOL, submitArgs("AC1", ["tests/AC1.test.sh"])),
      nestedOk("call-codemode-1/2", REPORT_BLOCKED_TOOL, blockedArgs([
        { path: "tests/AC1.test.sh", reason: "the two assertions contradict" },
      ])),
    ]),
  ]);
  const submits = extractSubmitTests(result.toolUses);
  assert(
    submits.rows.length === 1 && submits.skipped === 0,
    `(2) ${SUBMIT_TESTS_TOOL} credited by the transport is read by its extractor (got ${JSON.stringify(submits)})`,
  );
  const blocked = extractBlockedReport(result.toolUses);
  assert(
    blocked.rows.length === 1 && blocked.rows[0]?.path === "tests/AC1.test.sh",
    `(2) and so is ${REPORT_BLOCKED_TOOL} (got ${JSON.stringify(blocked)})`,
  );
}

// (3) the credited set is closed: a name outside it earns nothing.
{
  // The near-miss names a rename produces: right shape, wrong string. Each is
  // nested under a codemode call that would otherwise be the only thing recorded.
  const lookalikes = [
    `${SUBMIT_TESTS_TOOL} `,
    "submit_test",
    "Submit_Tests",
    `${REPORT_BLOCKED_TOOL}s`,
    "report_block",
  ];
  const result = collapse([
    codemodeTurn("call-codemode-1"),
    codemodeResult(
      "call-codemode-1",
      lookalikes.map((name, i) =>
        nestedOk(`call-codemode-1/${String(i + 1)}`, name, submitArgs("AC1", ["tests/x.test.sh"])),
      ),
    ),
  ]);
  const credited = result.toolUses.map((tu) => (tu as { name?: string }).name);
  assert(
    credited.join() === "codemode",
    `(3) no near-miss name is credited (got ${JSON.stringify(credited)})`,
  );
  assert(
    extractSubmitTests(result.toolUses).skipped === 0 &&
      extractBlockedReport(result.toolUses).skipped === 0,
    "(3) and none of them counts as an unreadable call either",
  );
}

process.exit(exit);
