#!/usr/bin/env bun
/**
 * #2618 — the rename canary for the two nested-credited tool names.
 *
 * One string is written and read at FOUR sites: the companion that registers the
 * tool, the extractor that reads a direct call, the transport that credits a
 * nested (`codemode`) row, and this project's own test for the literal. The
 * companions and the extractors live under `src/lean/`, which AC5 of this issue
 * forbids this fix to edit — so the shared constants sit outside the engine
 * (`src/lean-reporter-tools.ts`) and only the transport imports them. The literals
 * in the engine stay put, and THIS file is what stops them drifting.
 *
 * It bites by reading, not by quoting:
 *   (1) each companion's registered name is read OUT OF ITS OWN SOURCE, as the
 *       regex `registerTool({ name: "…"` resolves it in the file right now, and
 *       compared with the constant. Edit the literal in the companion and this
 *       reddens while the constant keeps its old value;
 *   (1b) same for the two extractors' `t.name !== "…"` guards — the second pair of
 *       literals, which a companion-only rename would otherwise walk past;
 *   (2) a collapsed nested row is fed to the REAL extractors: the names the
 *       transport credits are the names the readers accept, end to end, so a
 *       rename at the constant alone (which would credit a name nobody registers)
 *       reddens here too;
 *   (3) the credited set is CLOSED — a near-miss name earns nothing — so (2)
 *       cannot be satisfied by a filter that lets everything through.
 *
 * Together: a rename at EITHER side of any pair turns one of these red. There is
 * no assertion here that reads the constant and compares it with itself.
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

const src = (p: string): string => readFileSync(p, "utf8");

/** The name a companion really registers — the regex Pi's own loader would see.
 * `registerTool({` and `name:` are pinned to one another by the whitespace-only
 * gap, so the description text ("…the submit_tests tool…") cannot answer this. */
function registeredName(reporterPath: string): string | undefined {
  const m = /registerTool\(\{\s*name:\s*"([^"]+)"/.exec(src(reporterPath));
  return m?.[1];
}

/** The name an extractor really matches, from the guard in its own source
 * (`if (t.name !== "submit_tests" …`). Anchored on the guard, not a bare string
 * search: the header of both extractors mentions the tool name in prose. */
function matchedName(extractPath: string): string | undefined {
  const m = /t\.name\s*!==\s*"([^"]+)"/.exec(src(extractPath));
  return m?.[1];
}

const SUBMIT_EXTRACT_PATH = path.join(import.meta.dirname, "..", "src", "lean", "submit-tests-extract.ts");
const BLOCKED_EXTRACT_PATH = path.join(import.meta.dirname, "..", "src", "lean", "build-blocked-extract.ts");

// (1) the companion's registered literal is the constant.
for (const [label, reporterPath, constant] of [
  ["specify", SUBMIT_TESTS_REPORTER_PATH, SUBMIT_TESTS_TOOL],
  ["build", BLOCKED_REPORTER_PATH, REPORT_BLOCKED_TOOL],
] as const) {
  const registered = registeredName(reporterPath);
  assert(
    registered === constant,
    `(1) the ${label} companion registers "${constant}" (source says ${JSON.stringify(registered)})`,
  );
}

// (1b) the extractor's matched literal is the same constant.
for (const [label, extractPath, constant] of [
  ["submit-tests", SUBMIT_EXTRACT_PATH, SUBMIT_TESTS_TOOL],
  ["build-blocked", BLOCKED_EXTRACT_PATH, REPORT_BLOCKED_TOOL],
] as const) {
  const matched = matchedName(extractPath);
  assert(
    matched === constant,
    `(1b) the ${label} extractor matches "${constant}" (source says ${JSON.stringify(matched)})`,
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
    `(2) ${SUBMIT_TESTS_TOOL} credited by the transport is read by its real extractor (got ${JSON.stringify(submits)})`,
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
