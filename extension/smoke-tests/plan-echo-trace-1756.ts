#!/usr/bin/env bun
/**
 * plan-echo-trace-1756.ts — what the reader SAYS when an echo is unusable
 * (#1756 round 3). Split from `test-plan-coercion-1756.ts` along the 500-line
 * cap (AGENTS.md §12), in the shape `plan-input-gate-scenarios.ts` and
 * `plan-provenance-shape.ts` use for `test-plan-provenance.ts`: the scenarios
 * live here, the verdict counters stay in the parent file, and the parent runs
 * this one.
 *
 * Two silences used to be one event. A `report_workstream` result can carry no
 * usable echo because (a) the companion echoed nothing — an older companion, or
 * an over-capacity payload the transport dropped, both of which are ABSENCE and
 * the reader's known fallback — or (b) it carried a `details` the reader cannot
 * use, which is a MALFORMED companion report and a fault worth a line. Read the
 * two the same and an operator grepping traces cannot tell "the child said
 * nothing" from "the child said something unreadable".
 *
 * The other half is log injection: the mismatch warning quotes key names and a
 * call id, both model-derived, and a trace line is ONE line. They go through the
 * fence renderer's own neutraliser, so an echoed key cannot write its own WARN.
 *
 * Run: cd extension && bun run smoke-tests/test-plan-coercion-1756.ts
 */

import { RECORDED_ARGS_DETAILS_KEY } from "../src/plan-workstream-schema.ts";
import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import {
  RAW_STRING_FENCE,
  RECORDED_ARRAY_FENCE,
  call,
} from "./lib/plan-echo-fixtures-1756.ts";
import { captureTracesSync } from "./lib/spec-slot-fixtures.ts";

/** Run one scenario set and report failures through the parent's counter. */
export function runPlanEchoTraceScenarios(assert: (cond: boolean, msg: string) => void): void {
  {
    // A `details` that is itself an array cannot hold an echo. With the transport
    // in front of the reader such a payload never arrives at all — the transport
    // drops it and it becomes ABSENCE — so it reaches the reader only through a
    // hand-built fixture, which is exactly the case that must announce itself.
    const malformed = captureTracesSync(() =>
      workstreamCallsOf({
        toolUses: [
          { type: "toolCall", id: "c1", name: "report_workstream", arguments: RAW_STRING_FENCE },
        ],
        toolResults: [
          {
            toolCallId: "c1",
            toolName: "report_workstream",
            isError: false,
            text: "recorded",
            details: [RECORDED_ARRAY_FENCE],
          },
        ],
      }),
    );
    assert(
      malformed.value.accepted === 0 && malformed.value.refused.length === 1,
      "a `details` that is an array is NO echo",
    );
    const warned = malformed.traces.filter((t) => t.includes("malformed recorded echo"));
    assert(
      warned.length === 1 && warned[0]?.includes("c1") === true,
      `a carried-but-unusable echo emits ONE traceWarn naming the workstream call id (got ${JSON.stringify(malformed.traces)})`,
    );
  }
  {
    // The distinguishing half: a result that carries NO `details` (an older
    // companion, or a payload the transport dropped for size) stays SILENT. Were
    // it warned on too, the trace would say the same thing about both events and
    // the line would carry no information.
    const silent = captureTracesSync(() => workstreamCallsOf(call("c1", RAW_STRING_FENCE, {})));
    assert(
      silent.traces.every((t) => !t.includes("malformed recorded echo")),
      `a result with no carrier at all traces NO malformed-echo line (got ${JSON.stringify(silent.traces)})`,
    );
    // A payload under the key that is not a params object IS malformed, and does
    // warn — the pair is what makes the two cases distinguishable.
    const notAnObject = captureTracesSync(() =>
      workstreamCallsOf({
        toolUses: [
          { type: "toolCall", id: "c2", name: "report_workstream", arguments: RAW_STRING_FENCE },
        ],
        toolResults: [
          {
            toolCallId: "c2",
            toolName: "report_workstream",
            isError: false,
            text: "recorded",
            details: { [RECORDED_ARGS_DETAILS_KEY]: "task-a" },
          },
        ],
      }),
    );
    assert(
      notAnObject.traces.filter((t) => t.includes("malformed recorded echo")).length === 1 &&
        notAnObject.traces[0]?.includes("c2") === true,
      `a non-object \`recordedArgs\` warns and names its call id (got ${JSON.stringify(notAnObject.traces)})`,
    );
  }
  {
    // Log injection: the mismatch warning quotes the echoed key names and the
    // call id, both model-derived text. `neutraliseFenceEntry` is the fence
    // renderer's neutraliser (one line, control characters collapsed, backticks
    // gone) and it must run over both before they reach the line — a key that
    // begins with `\nWARN …` would otherwise forge a second trace line.
    const forged = captureTracesSync(() =>
      workstreamCallsOf(
        call("c\n1", RAW_STRING_FENCE, {
          recorded: { ...RECORDED_ARRAY_FENCE, "evil\nkey": "x" },
        }),
      ),
    );
    const lines = forged.traces.filter((t) => t.includes("not a coercion"));
    assert(
      lines.length === 1 &&
        lines[0]?.startsWith("[pi-rukas] WARN work-driver:") === true &&
        !lines[0]?.includes("\n1") &&
        !lines[0]?.includes("evil\nkey") &&
        lines[0]?.includes("evil key") === true,
      `an echoed key and a call id are neutralised before the trace line, and cannot forge a second one (got ${JSON.stringify(forged.traces)})`,
    );
  }
}
