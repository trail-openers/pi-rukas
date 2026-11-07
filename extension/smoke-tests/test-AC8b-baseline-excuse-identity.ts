#!/usr/bin/env bun
/**
 * #2064 — the lines the excuse reads, and what refuses the whole excuse.
 *
 * With the pytest identity parser gone the reader has one rule: a failure line is a
 * failure LINE. Three consequences this file pins, none of which an identity parser
 * could have satisfied:
 *
 *   (lines) every recognised line of a stream reads back as its own comparable text,
 *     in stream order and deduplicated — a summary the runner repeats is one line, not
 *     two failures;
 *   (unreadable) a line that opens with a runner's own `FAILED `/`ERROR ` marker and
 *     that the classifier does not recognise REFUSES the excuse on either side; it is
 *     never merely omitted. Omitting it let a head of `[readable A, unreadable B]`
 *     match a base that printed only A and grade the tier green on a failure this run
 *     authored;
 *   (record) a line longer than the step log's own bound is CLIPPED, not refused —
 *     whole failure lines are far longer than the old `path::name` tokens, and the
 *     log's validator refuses an over-long entry rather than clipping it, so the clip
 *     has to happen here, on a character boundary, or the record takes the whole run
 *     file down with it on readback.
 *
 * The controls keep each guard from being a blanket refusal.
 */
import {
  PREEXISTING_NAME_MAX_CHARS,
  preexistingFailuresProblem,
} from "../src/lean/state-outcome-maps.ts";
import { baselineExcuse, failureLinesOf } from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC8b-baseline-excuse-identity.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
/** Two trees that are definitely different directories. */
const HEAD_ROOT = "/tmp/pi-rukas-2064-id/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-id/repo.baseline-lean-verify-9";

/** One comparison, on the lines each run printed. */
function excuseOf(headLines: string[], baseLines: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'pytest'",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

// --------------------------------------------------------------------- (lines)
{
  const STREAM = [
    "built 14 packages in 3s",
    "FAILED a.py::t[1] - AssertionError",
    "not ok 1 - a bats check",
    "FAILED a.py::t[1] - AssertionError",
  ].join("\n");
  const read = failureLinesOf(STREAM);
  assert(
    read.join("\n") === "FAILED a.py::t[1] - AssertionError\nnot ok 1 - a bats check",
    `(lines) each recognised line reads back once, in stream order, prose excluded (${JSON.stringify(read)})`,
  );
  assert(
    excuseOf([STREAM.split("\n")[1] as string], [STREAM.split("\n")[1] as string]).kind ===
      "excused",
    `(lines) and a pair of identical lines excuses — the reader is not a blanket refusal (${excuseOf([STREAM.split("\n")[1] as string], [STREAM.split("\n")[1] as string]).kind})`,
  );
}

// --------------------------------------------------------- (unreadable) one bad line
{
  const A = "FAILED tests/x_test.py::test_a - AssertionError";
  // A collection error and a bare file verdict: a runner declaring a failing test in a
  // dialect the shared table does not carry. `failureLines` drops both, so only the
  // marker walk can see them — and it must refuse, not omit.
  const COLLECTION_ERROR = "ERROR tests/test_brand_new.py";
  const BARE_FAILED = "FAILED tests/y.py";
  assert(
    excuseOf([A, COLLECTION_ERROR], [A]).kind === "refused",
    `(unreadable) a head line the classifier cannot read refuses the excuse (${excuseOf([A, COLLECTION_ERROR], [A]).kind})`,
  );
  assert(
    excuseOf([A], [A, BARE_FAILED]).kind === "refused",
    `(unreadable) an unreadable BASE line refuses it too (${excuseOf([A], [A, BARE_FAILED]).kind})`,
  );
  assert(
    failureLinesOf(COLLECTION_ERROR).length === 0 && failureLinesOf(BARE_FAILED).length === 0,
    `(unreadable) and neither bare line is offered as a comparable line (${JSON.stringify(failureLinesOf(BARE_FAILED))})`,
  );
  assert(
    excuseOf([A], [A]).kind === "excused",
    `(unreadable) the pair without such a line still excuses (${excuseOf([A], [A]).kind})`,
  );
}

// ----------------------------------------------------------- (record) an over-long line
{
  // Whole failure lines are routinely longer than the old `path::name` tokens, and the
  // step log's reader REFUSES an over-long entry rather than clipping it. So the excuse
  // clips, and the record it hands back must be one the log can be read back with.
  const LONG = `FAILED tests/${"d".repeat(240)}_test.py::test_a - AssertionError`;
  assert(
    LONG.length > PREEXISTING_NAME_MAX_CHARS,
    `(record) the fixture line really is over the log's bound (${String(LONG.length)} chars)`,
  );
  assert(
    preexistingFailuresProblem({
      fast: { cmd: "c", names: [LONG], total: 1, baseSha: "a".repeat(40) },
    }) !== undefined,
    "(record) the log's own reader really does refuse that line (the two cannot disagree)",
  );
  const r = excuseOf([LONG], [LONG]);
  assert(
    r.kind === "excused",
    `(record) an over-long line that both runs printed still excuses, clipped (${r.kind})`,
  );
  assert(
    r.kind === "excused" &&
      r.record.names.every((n) => n.length <= PREEXISTING_NAME_MAX_CHARS) &&
      preexistingFailuresProblem({ fast: r.record }) === undefined,
    `(record) every recorded line is inside the bound and validates (${String(r.kind === "excused" ? r.record.names[0]?.length : -1)})`,
  );
  assert(
    r.kind === "excused" && r.record.total === 1,
    `(record) the total counts the line, not the clip (${String(r.kind === "excused" ? r.record.total : -1)})`,
  );
}

// ------------------------------------------- (record) a clipped astral character cannot
{
  // A clip that lands inside an astral character leaves a lone surrogate, which the
  // log's reader refuses for the same reason it refuses a control character.
  const ASTRAL = `FAILED tests/sur_${"\u{1D400}".repeat(70)}t.py::test_a - x`;
  const r = excuseOf([ASTRAL], [ASTRAL]);
  assert(
    r.kind === "excused" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.record.names.join()),
    `(record) no clipped line carries a lone surrogate (${r.kind}; ${JSON.stringify(r.kind === "excused" ? r.record.names[0]?.slice(-4) : null)})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
