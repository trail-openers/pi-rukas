#!/usr/bin/env bun
/**
 * #1762 round 5 — the corrective round was BLIND to a payload-bearing `FAILED:`
 * line, and the consolidated round saw only the tally.
 *
 * The measured defect. `IS_MARKER_LINE = /^FAILED:/` vetoed EVERY `FAILED:` line
 * in `isNonAssertionLine`, `assertionCandidate` and `extractSpecificAssertion`
 * (and the consolidation classifier's named-failure predicate used it too), so
 * the one line a project gate printed that NAMED the assertion —
 * `FAILED: test/a_test.sh: a first run writes the settings: expected '0', got '1'`
 * — was refused by the same predicate that refuses a bare filename. A worktree
 * whose verify failed on that line alone yielded `assertionLines() === []`,
 * `decideCorrectiveRound` answered `round: false`, and the cycle parked with a
 * failure text that had named the defect the whole time. The consolidated route
 * had a second half of the same blindness: a script's tally block
 * (`test.sh: failed checks (2)` with the names on indented lines beneath it)
 * reached the developer as the tally ALONE, because the names were never harvested.
 *
 * This suite pins the fix and, in section 5, everything the fix must NOT touch.
 * Every fixture is synthetic gate output; none of it is this repo's own
 * `verify-loop.sh` dialect.
 */

import {
  CORRECTIVE_LINE_MAX,
  CORRECTIVE_MAX_LINES,
  type CorrectiveGateView,
  decideCorrectiveRound,
} from "../src/work-driver-corrective-decide.ts";
import { extractSpecificAssertion } from "../src/work-driver-verify-assertion.ts";
import { formatExecError } from "../src/work-driver-verify-develop-helpers.ts";
import {
  classifyFailureLine,
  isBareFailedMarker,
  matchShape,
  scriptTallyCount,
} from "../src/work-driver-verify-failures.ts";
import { assertionLines } from "../src/work-driver-verify-record.ts";
import { harvestConsolidatedTallies } from "../src/work-driver-verify-tally.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import {
  CMD,
  EXAMPLE_STREAM,
  PAYLOAD_MARKER,
  TALLY_LINE,
  TALLY_NAMES,
  WT,
  makeAssert,
} from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();
const NO_EVENTS: WorkEvent[] = [];

/** A per-worktree gate whose one record carries `text`, for worktree `cwd`. */
function perWtGate(cwd: string, text: string): CorrectiveGateView {
  return {
    ok: false,
    failures: [text],
    verifyRun: { status: "ran", command: CMD, failures: [text], perWorktree: [{ cwd, text }] },
  };
}

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

// ── 1. the table shape ───────────────────────────────────────────────────────
{
  const line = classifyFailureLine(PAYLOAD_MARKER);
  assert(
    line?.shape === "failed-marker-payload" && line.namesTest === true,
    `shape: a FAILED: marker whose detail carries an assertion token is failed-marker-payload (got ${JSON.stringify(line)})`,
  );
  // The exemption is independent of table position: matchShape answers it BEFORE
  // the success veto, so a marker printed with the counts it compared survives.
  const counted = "FAILED: a_test.sh: expected 0 failures, got 3";
  const viaMatch = matchShape(counted);
  assert(
    viaMatch?.shape === "failed-marker-payload" && viaMatch.namesTest === true,
    `pre-veto: FAILED: <path>: expected 0 failures, got 3 is a payload marker, not a passing tally (got ${JSON.stringify(viaMatch)})`,
  );
  // Every token in the brief, and each one only in the DETAIL, not the path.
  for (const token of ["expected", "got", "assert", "error", "!==", "===", "to equal", "to be"]) {
    const l = `FAILED: a_test.sh: the value ${token} here`;
    assert(
      classifyFailureLine(l)?.shape === "failed-marker-payload",
      `token: ${JSON.stringify(token)} in the detail makes it a payload marker`,
    );
  }
  // The count-summary form is NEVER this shape, whatever its name list reads like.
  for (const summary of [
    "FAILED: 2 test(s) — a_test_case, b",
    "FAILED: 12 test(s) — expected.ts, got.ts",
    "FAILED: 1 test(s) — error.ts",
  ]) {
    assert(
      classifyFailureLine(summary)?.shape !== "failed-marker-payload",
      `count summary: ${JSON.stringify(summary)} is never the payload shape (got ${JSON.stringify(classifyFailureLine(summary))})`,
    );
    assert(
      !isBareFailedMarker(summary),
      `count summary: ${JSON.stringify(summary)} is not bare either — it is the tally form`,
    );
  }
  // A bare marker, and a detail with no token, both stay bare / namesTest: false.
  for (const bare of [
    "FAILED: smoke-tests/test-x.ts",
    "FAILED: test/a_test.sh: a first run writes the settings",
  ]) {
    const c = classifyFailureLine(bare);
    assert(
      c?.shape === "failed-marker" && c.namesTest === false,
      `bare: ${JSON.stringify(bare)} stays failed-marker/namesTest:false (got ${JSON.stringify(c)})`,
    );
    assert(isBareFailedMarker(bare), `bare: ${JSON.stringify(bare)} is the bare marker shape`);
  }
  // One count helper, the only reader of a tally's N.
  assert(
    scriptTallyCount(TALLY_LINE) === 2,
    `tally count: scriptTallyCount reads the N of the tally line (got ${scriptTallyCount(TALLY_LINE)})`,
  );
  assert(
    scriptTallyCount(PAYLOAD_MARKER) === undefined,
    "tally count: a marker line carries no tally count",
  );
}

// ── 2. the veto sites now ask "the bare marker shape", not "any FAILED:" ─────
{
  assert(
    extractSpecificAssertion(PAYLOAD_MARKER) === PAYLOAD_MARKER,
    `extractor: a payload-bearing marker line IS the specific assertion (got ${JSON.stringify(extractSpecificAssertion(PAYLOAD_MARKER))})`,
  );
  assert(
    extractSpecificAssertion("FAILED: smoke-tests/test-x.ts") !== PAYLOAD_MARKER,
    "extractor: a bare marker still reports absence (the #798 defect stays closed)",
  );
  assert(
    assertionLines("FAILED: smoke-tests/test-x.ts").length === 0,
    "veto: a bare marker offers no line to the developer",
  );
  assert(
    assertionLines(PAYLOAD_MARKER).join("|") === PAYLOAD_MARKER,
    `veto: the payload marker is offered (got ${JSON.stringify(assertionLines(PAYLOAD_MARKER))})`,
  );
  // The count-summary exemption and the secret guard are unchanged.
  // The summary exemption is UNCHANGED and stays absence: `extractSpecificAssertion`
  // never returns the count summary (its own gate refuses a line the table does not
  // say NAMES a check), and the count-summary exception exists so the reader does
  // not silently drop the line that carries the count.
  const SUMMARY = "FAILED: 2 test(s) — a.ts, b.ts";
  const { NO_SPECIFIC_ASSERTION } = await import("../src/work-driver-verify-assertion.ts");
  assert(
    extractSpecificAssertion(SUMMARY) === NO_SPECIFIC_ASSERTION,
    `summary exemption unchanged: a count summary alone still reports absence (got ${JSON.stringify(extractSpecificAssertion(SUMMARY))})`,
  );
  assert(
    extractSpecificAssertion(`${SUMMARY}\n\u2717 a.ts: expected 1, got 2`) ===
      "\u2717 a.ts: expected 1, got 2",
    "summary exemption unchanged: the summary never displaces the real assertion beside it",
  );
  const secretish = "FAILED: a_test.sh: expected api_key = zX9cVbNm0pQwErTy, got nothing";
  assert(
    !assertionLines(secretish).some((l) => l.includes("zX9cVbNm0pQwErTy")),
    "LOOKS_LIKE_SECRET unchanged: a credential inside a payload detail is not offered",
  );
}

// ── 3. the per-worktree route: the offline reproduction ──────────────────────
{
  const ex = Object.assign(new Error("Command failed: sh check.sh"), {
    stdout: EXAMPLE_STREAM,
    stderr: "",
  });
  const wrapper = formatExecError(ex, "timed out", `verify command \`${CMD}\` failed in ${WT}`);
  assert(
    wrapper.startsWith(`verify command \`${CMD}\` failed in ${WT}: `),
    `wrapper: the harness sentence is what formatExecError produced (${JSON.stringify(wrapper.slice(0, 60))}…)`,
  );
  const lines = assertionLines(wrapper);
  assert(
    lines.length === 1 && lines[0] === PAYLOAD_MARKER,
    `per-worktree: assertionLines of the wrapper returns exactly the payload line (got ${JSON.stringify(lines)})`,
  );
  const d = decideCorrectiveRound(perWtGate(WT, wrapper), {
    eventLog: NO_EVENTS,
    worktrees: { default: WT },
  });
  assert(
    d.round === true && d.source === "per-workstream",
    `per-worktree: the corrective round is earned (got ${JSON.stringify(d)})`,
  );
  if (d.round) {
    assert(
      d.targets.length === 1 &&
        d.targets[0]?.id === "default" &&
        d.targets[0].lines.join("|") === PAYLOAD_MARKER,
      `per-worktree: the N=1 developer is given the payload line for its own worktree (got ${JSON.stringify(d.targets)})`,
    );
  }
  // The per-worktree path NEVER produces a joined tally line: the harness wrapper
  // flattens the stream to one line, so the indentation the harvest reads cannot
  // exist there. Pinned so a future "helpful" harvest on this route is caught.
  assert(
    !lines.some((l) => l.includes(": ") && l.endsWith(TALLY_NAMES[1] ?? "")),
    `per-worktree: no joined tally line is ever produced here (got ${JSON.stringify(lines)})`,
  );
  assert(
    !assertionLines(wrapper).some((l) => l === `${TALLY_NAMES[0]}, ${TALLY_NAMES[1]}`),
    "per-worktree: the names are never emitted alone either",
  );
}

// ── 4. the consolidated route: the tally harvest, ONE line ───────────────────
{
  const harvested = harvestConsolidatedTallies(EXAMPLE_STREAM);
  assert(
    harvested.length === 1 &&
      harvested[0] === `${TALLY_LINE}: ${TALLY_NAMES[0]}, ${TALLY_NAMES[1]}`,
    `harvest: the tally joins its names into ONE line (got ${JSON.stringify(harvested)})`,
  );
  const lines = assertionLines(EXAMPLE_STREAM);
  assert(
    lines.includes(PAYLOAD_MARKER),
    `consolidated: the payload marker is among the target lines (got ${JSON.stringify(lines)})`,
  );
  assert(
    lines.includes(`${TALLY_LINE}: ${TALLY_NAMES.join(", ")}`),
    `consolidated: the joined tally is among the target lines (got ${JSON.stringify(lines)})`,
  );
  assert(
    !lines.includes(TALLY_NAMES[0] ?? "") && !lines.includes(TALLY_NAMES[1] ?? ""),
    "consolidated: names are never emitted alone",
  );
  // One CORRECTIVE_MAX_LINES slot, and cut at CORRECTIVE_LINE_MAX like any line.
  const d = decideCorrectiveRound(consolidatedGate(EXAMPLE_STREAM), {
    eventLog: NO_EVENTS,
    worktrees: { default: WT },
  });
  assert(d.round === true && d.source === "consolidated", "consolidated: the round is earned");
  if (d.round) {
    const given = d.targets[0]?.lines ?? [];
    const joinedTally = `${TALLY_LINE}: ${TALLY_NAMES.join(", ")}`;
    assert(
      given.filter((l) => l === joinedTally).length === 1,
      `consolidated: the joined tally costs exactly ONE slot (got ${JSON.stringify(given)})`,
    );
    assert(
      !given.some((l) => l !== joinedTally && l.includes("lint")),
      "consolidated: the names appear only inside the joined line, never as their own slot",
    );
    assert(
      given.every((l) => l.length <= CORRECTIVE_LINE_MAX),
      `consolidated: every line is cut at CORRECTIVE_LINE_MAX (${CORRECTIVE_LINE_MAX})`,
    );
    assert(
      given.length <= CORRECTIVE_MAX_LINES,
      `consolidated: at most CORRECTIVE_MAX_LINES (${CORRECTIVE_MAX_LINES}) lines are given`,
    );
  }
  // Indentation is measured BEFORE trimming: a name at the tally's own depth is
  // not part of its block.
  assert(
    harvestConsolidatedTallies(`${TALLY_LINE}\n${TALLY_NAMES[0]}\n${TALLY_NAMES[1]}`).length === 0,
    "harvest: a name no deeper than the tally stops it (indentation read on the raw line)",
  );
}

// ── 5. negatives and unchanged behaviour ─────────────────────────────────────
{
  // count 0 harvests nothing.
  assert(
    harvestConsolidatedTallies(`test.sh: failed checks (0), not run (2)\n    ${TALLY_NAMES[0]}`)
      .length === 0,
    "harvest: count 0 harvests nothing",
  );
  // an `ok` line stops the harvest.
  assert(
    harvestConsolidatedTallies(`${TALLY_LINE}\n    ok 1 - a passing check\n    ${TALLY_NAMES[0]}`)
      .length === 0,
    "harvest: an `ok` line stops it — a passing line is not a name",
  );
  // a timing-block line (`pack_release_test.sh   21.4s`) stops the harvest.
  assert(
    harvestConsolidatedTallies(
      `${TALLY_LINE}\n  pack_release_test.sh   21.4s\n    ${TALLY_NAMES[0]}`,
    ).length === 0,
    "harvest: the timing block stops it — a line with a status shape is not a name",
  );
  // N>1 consolidated-only still declines: no workstream is named by it.
  const d = decideCorrectiveRound(consolidatedGate(EXAMPLE_STREAM), {
    eventLog: NO_EVENTS,
    worktrees: { a: `${WT}-a`, b: `${WT}-b` },
  });
  assert(d.round === false, `N>1 consolidated-only still declines (got ${JSON.stringify(d)})`);
  // A payload marker beside a count-matched summary naming a DIFFERENT path: the
  // count summary is a tally, not an assertion, and the pair names nothing shared.
  const other = "FAILED: test/z_test.sh: expected '1', got '0'";
  const mismatch = [
    "FAILED: 1 test(s) — test/z_test.sh",
    "test.sh: failed checks (1), not run (0)",
    "    lint",
    PAYLOAD_MARKER,
  ].join("\n");
  assert(
    extractSpecificAssertion("FAILED: 1 test(s) — test/z_test.sh") !== other,
    "summary naming a different path never yields the other file's payload line",
  );
  assert(
    !assertionLines("FAILED: 1 test(s) — test/z_test.sh").includes(other),
    "assertionLines: a count summary alone never offers an unrelated payload line",
  );
  // One file as BOTH a bare and a payload marker yields nothing extra: the bare
  // form stays refused, so the pair offers only the payload line, once.
  const sameFile = "test/a_test.sh";
  const both = assertionLines(`FAILED: ${sameFile}\nFAILED: ${sameFile}: expected 0, got 1`);
  assert(
    both.length === 1 && both[0]?.startsWith(`FAILED: ${sameFile}: expected`),
    `same file bare + payload: only the payload line is offered, once (got ${JSON.stringify(both)})`,
  );
  // Today's results are unchanged: the ✗ preference still outranks everything, and
  // the cut's truncation still applies.
  const withMark = `${PAYLOAD_MARKER}\n\u2717 a_test.sh: the real assertion`;
  assert(
    assertionLines(withMark).join("|") === "\u2717 a_test.sh: the real assertion",
    `unchanged: a ✗ line still outranks a payload marker (got ${JSON.stringify(assertionLines(withMark))})`,
  );
  const long = `FAILED: a_test.sh: expected ${"x".repeat(CORRECTIVE_LINE_MAX + 50)}, got 1`;
  const dLong = decideCorrectiveRound(perWtGate(WT, long), {
    eventLog: NO_EVENTS,
    worktrees: { default: WT },
  });
  assert(
    dLong.round === true && (dLong.targets[0]?.lines[0]?.length ?? 0) <= CORRECTIVE_LINE_MAX + 1,
    `unchanged: an over-long evidence line is still cut (${dLong.round ? (dLong.targets[0]?.lines[0]?.length ?? 0) : "no round"} chars)`,
  );
  // lastFailureIndex treats BOTH marker shapes as markers, so the anchor does not
  // move: a stream with a bare marker and a payload marker still anchors at the
  // last marker line, and extractAttributedTail keeps it.
  const { extractAttributedTail } = await import("../src/work-driver-exec-error.ts");
  const stream = [
    "some earlier passing chatter".repeat(40),
    `FAILED: ${sameFile}`,
    PAYLOAD_MARKER,
  ].join("\n");
  const tail = extractAttributedTail(stream, 1500);
  assert(
    tail.attributed && tail.tail.startsWith(PAYLOAD_MARKER),
    "anchor unchanged: the last marker line of either shape is still the anchor",
  );
  const tailBareOnly = extractAttributedTail(
    ["some earlier passing chatter".repeat(40), `FAILED: ${sameFile}`].join("\n"),
    1500,
  );
  assert(
    tailBareOnly.attributed && tailBareOnly.tail.startsWith(`FAILED: ${sameFile}`),
    "anchor unchanged: a bare marker alone still anchors exactly as before",
  );
}

// ── 6. namedFailureShape / PER_FILE_RE keep their rules ─────────────────────
{
  // `namedFailureLines` still accepts a bare marker at the cap site (it names the
  // FILE to the operator) while the classifier's stricter predicate drops it.
  const { namedFailureLines } = await import("../src/work-driver-commit-verify-evidence.ts");
  const bare = "FAILED: smoke-tests/test-x.ts";
  assert(
    namedFailureLines(bare).length === 1,
    "namedFailureShape unchanged: the cap site still keeps a per-file marker",
  );
  const { classifyConsolidatedVerifyFailure } = await import(
    "../src/work-driver-consolidation-classify.ts"
  );
  const verdict = classifyConsolidatedVerifyFailure(
    1,
    ["default"],
    "chatter".repeat(200),
    {},
    bare,
  );
  assert(
    (verdict.namedFailures ?? []).length === 0,
    "classifier predicate unchanged: a bare marker is still not 'the specific assertion' (#798)",
  );
  const vPayload = classifyConsolidatedVerifyFailure(
    1,
    ["default"],
    "chatter".repeat(200),
    {},
    PAYLOAD_MARKER,
  );
  assert(
    (vPayload.namedFailures ?? []).includes(PAYLOAD_MARKER),
    `classifier recovery now names the payload marker (got ${JSON.stringify(vPayload.namedFailures)})`,
  );
}

process.exit(failed() ? 1 : 0);
