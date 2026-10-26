#!/usr/bin/env bun
/**
 * #1841 — the CONSOLIDATED route reads a `FAIL  <description>` header's indented
 * detail lines, and the harvest's own bounds.
 *
 * Split out of `test-verify-failure-shapes-g-1762.ts` for the 500-line gate
 * (AGENTS.md §12); the shared fixtures live in
 * `lib/verify-failure-shapes-fixtures.ts` so neither half re-types them.
 *
 * The park this closes: a project gate reports a failing check as a header plus
 * prose, and the header alone tells the developer WHICH check went red but not what
 * to change — so the round, once earned, would have dispatched a developer who had
 * to re-run the verify to find out. The per-worktree route is pinned beside the
 * decision itself in `test-work-driver-corrective-decide.ts`; this suite is the same
 * stream arriving as the consolidated run's raw output, the route whose tally
 * harvest was already consolidated-only.
 *
 * Every fixture is synthetic gate output; none of it is this repo's own dialect.
 */

import {
  CORRECTIVE_LINE_MAX,
  CORRECTIVE_MAX_LINES,
  decideCorrectiveRound,
} from "../src/work-driver-corrective-decide.ts";
import type { CorrectiveGateView } from "../src/work-driver-corrective-decide.ts";
import { classifyFailureLine } from "../src/work-driver-verify-failures.ts";
import { harvestHeaderDetails } from "../src/work-driver-verify-header-detail.ts";
import { consolidatedAssertionLines } from "../src/work-driver-verify-record.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import {
  CMD,
  FAIL_HEADER,
  FAIL_HEADER_DETAILS,
  FAIL_HEADER_PASSING,
  FAIL_HEADER_STREAM,
  WT,
  makeAssert,
} from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();
const NO_EVENTS: WorkEvent[] = [];

/** A consolidated-only gate (no worktree failed on its own). */
function consolidatedGate(raw: string): CorrectiveGateView {
  const failure = "consolidated verify failed";
  return {
    ok: false,
    failures: [failure],
    verifyRun: {
      status: "ran",
      command: CMD,
      failures: [failure],
      perWorktree: [],
      consolidatedRaw: raw,
    },
  };
}

// ── 1. the header classifies, and its details are evidence ───────────────────
{
  const got = classifyFailureLine(FAIL_HEADER);
  assert(
    got?.shape === "fail-header" && got.namesTest === true,
    `fail-header: the header classifies with namesTest true (got ${JSON.stringify(got)})`,
  );
  const details = harvestHeaderDetails(FAIL_HEADER_STREAM);
  assert(
    details.length === FAIL_HEADER_DETAILS.length &&
      FAIL_HEADER_DETAILS.every((l) => details.includes(l.trim())),
    `harvest: every indented detail line of the header is harvested (got ${JSON.stringify(details)})`,
  );
  assert(
    !FAIL_HEADER_PASSING.some((l) => details.includes(l.trim())),
    `harvest: the ok/skip lines beside the block are not details (got ${JSON.stringify(details)})`,
  );
}

// ── 2. the consolidated route earns the round and gives both ─────────────────
{
  const lines = consolidatedAssertionLines(FAIL_HEADER_STREAM);
  assert(
    lines.includes(FAIL_HEADER),
    `fail-header consolidated: the header is an evidence line (got ${JSON.stringify(lines)})`,
  );
  const d = decideCorrectiveRound(consolidatedGate(FAIL_HEADER_STREAM), {
    eventLog: NO_EVENTS,
    worktrees: { default: WT },
  });
  assert(
    d.round === true && d.source === "consolidated",
    `fail-header consolidated: the round is earned (got ${JSON.stringify(d)})`,
  );
  if (d.round) {
    const given = d.targets[0]?.lines ?? [];
    assert(
      given.includes(FAIL_HEADER) && FAIL_HEADER_DETAILS.every((l) => given.includes(l.trim())),
      `fail-header consolidated: header and details are both given (got ${JSON.stringify(given)})`,
    );
    assert(
      !FAIL_HEADER_PASSING.some((l) => given.includes(l.trim())),
      `fail-header consolidated: the ok/skip lines are never given (got ${JSON.stringify(given)})`,
    );
    assert(
      given.every((l) => l.length <= CORRECTIVE_LINE_MAX) && given.length <= CORRECTIVE_MAX_LINES,
      "fail-header consolidated: the corrective line bounds hold on this route too",
    );
  }
}

// ── 3. the harvest's own bounds and stopping rules ───────────────────────────
{
  // The count cap is the corrective round's own, so the harvest never builds
  // evidence the reader is certain to slice away.
  const many = harvestHeaderDetails(
    `${FAIL_HEADER}\n${Array.from({ length: 12 }, (_, n) => `    reason ${n}`).join("\n")}`,
  );
  assert(
    many.length === CORRECTIVE_MAX_LINES,
    `bounds: at most ${CORRECTIVE_MAX_LINES} detail lines are harvested (got ${many.length})`,
  );
  // The length cap is the harvest's own: a gate can print a whole file as a diff
  // under one header, and a 400-char "reason" is a dump, not a diagnosis.
  const long = harvestHeaderDetails(`${FAIL_HEADER}\n    ${"z".repeat(400)}`);
  assert(
    long.length === 1 && long[0]?.length === 300,
    `bounds: one detail line is cut at 300 characters (got ${long[0]?.length})`,
  );
  // Indentation is measured on the RAW line: a line at the header's own depth is
  // the next block, not this header's prose, and it stops the walk.
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\nnot indented\n      deeper but after it`).length === 0,
    "bounds: a line no deeper than the header stops the harvest (indentation read untrimmed)",
  );
  // A line the table claims stops the walk too — it is evidence in its own right
  // (a failure) or the next block (a passing tally), not this header's prose.
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\n    reason one\n    ok 1 - a passing check\n    x`).join(
      "|",
    ) === "reason one",
    "bounds: a passing line stops the harvest — it is not a detail of the header",
  );
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\n    ✗ the real assertion`).join("|") === "",
    "bounds: a line the table classifies as a failure stops it — it is evidence on its own, not this header's prose",
  );
  // A stream with no header harvests nothing at all — every existing reader of
  // `assertionLines` is unchanged by this harvest.
  assert(
    harvestHeaderDetails("test.sh: failed checks (2)\n    lint\n    test/b_test.sh").length === 0,
    "no header: the harvest contributes nothing to a stream that has none",
  );
}

process.exit(failed() ? 1 : 0);
