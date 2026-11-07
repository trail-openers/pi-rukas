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
 *   (unreadable) a line that carries a runner's failure token — a `FAILED `/`ERROR `
 *     marker, a `not ok`, a `--- FAIL:`, a `FAIL` word with a name — and that the
 *     classifier does not recognise REFUSES the excuse on either side; it is never
 *     merely omitted. Omitting it let a head of `[readable A, unreadable B]` match a
 *     base that printed only A and grade the tier green on a failure this run authored;
 *   (over-window) a raw line past the classifier's own scan window REFUSES the excuse
 *     too. The classifier judges such a line on its first 8 KiB, so two lines differing
 *     only past the window can fold onto one comparison key — the folding this module
 *     exists to prevent, arriving through length instead of through a token parser.
 *
 * The controls keep each guard from being a blanket refusal.
 */
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine as classify,
} from "../src/work-driver-verify-failures.ts";
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
  const COLLECTION_ERROR = "ERROR tests/test_brand_new.py";
  const BARE_FAILED = "FAILED tests/y.py";
  assert(
    excuseOf([A, COLLECTION_ERROR], [A]).kind === "refused",
    `(unreadable) a head line the classifier cannot read refuses the excuse (${excuseOf([A, COLLECTION_ERROR], [A]).kind})`,
  );
  assert(
    excuseOf([A], [BARE_FAILED]).kind === "refused",
    `(unreadable) a base whose only line is unreadable names nothing, and refuses (${excuseOf([A], [BARE_FAILED]).kind})`,
  );
  assert(
    failureLinesOf(COLLECTION_ERROR).length === 0 && failureLinesOf(BARE_FAILED).length === 0,
    `(unreadable) and neither bare line is offered as a comparable line (${JSON.stringify(failureLinesOf(BARE_FAILED))})`,
  );
  // A TAP COMMENT and a shell trace both carry the runner's `not ok` token, and neither
  // matches the table's anchored `^\s*not\s+ok\b` — so the classifier drops them, and the
  // ONLY thing standing between a head-only one of these and a green tier is this veto.
  const TAP_COMMENT = "# not ok 9 - /t/brand_new.t - boom";
  const SHELL_TRACE = "+ not ok 7 - a trace line the table does not carry";
  assert(
    failureLinesOf(TAP_COMMENT).length === 0 && failureLinesOf(SHELL_TRACE).length === 0,
    `(unreadable) neither a TAP comment nor a shell trace is a line the classifier reads (${JSON.stringify(failureLinesOf(TAP_COMMENT))})`,
  );
  assert(
    excuseOf([A, TAP_COMMENT], [A]).kind === "refused",
    `(unreadable) a head-only TAP comment line refuses the excuse — it must not be omitted (${excuseOf([A, TAP_COMMENT], [A]).kind})`,
  );
  assert(
    excuseOf([A, SHELL_TRACE], [A]).kind === "refused",
    `(unreadable) a head-only shell-trace line refuses it too (${excuseOf([A, SHELL_TRACE], [A]).kind})`,
  );
  assert(
    excuseOf([A, TAP_COMMENT], [A, TAP_COMMENT]).kind === "excused",
    `(unreadable) the same unread line on BOTH sides is not a new failure, and the excuse stands on the recognised pair (${excuseOf([A, TAP_COMMENT], [A, TAP_COMMENT]).kind})`,
  );
  // The shape the same rule exists to allow: the harness echoes the tier's own command,
  // so that echo carries `not ok` on BOTH runs. No prefix is exempt — it is refused for
  // being unreadable until the base prints the identical line.
  const ECHO = `Command failed: sh -c 'echo "${A}" 1>&2; exit 1'`;
  assert(
    classify(ECHO) === undefined,
    `(unreadable) the harness echo is not a line the classifier reads (${JSON.stringify(classify(ECHO))})`,
  );
  assert(
    excuseOf([A, ECHO], [A, ECHO]).kind === "excused",
    `(unreadable) an identical unreadable harness echo on both sides does not refuse (${excuseOf([A, ECHO], [A, ECHO]).kind})`,
  );
  // The echo is the HARNESS'S OWN line — node's rejection message, which the step appends
  // to the stream — and what it echoes is the tier's command, the same command the base
  // run was handed. So it is not a line the gate printed and never a failure this run
  // authored, whether or not the base's stream happens to carry it: refusing on it would
  // hand back every real tier, since only the head run is echoed. An echo of a command
  // the tier never ran is a different matter, and is what the two lines below pin.
  assert(
    excuseOf([A, ECHO], [A]).kind === "excused",
    `(unreadable) the harness's echo of the tier's OWN command does not refuse on its own (${excuseOf([A, ECHO], [A]).kind})`,
  );
  const FOREIGN_ECHO = "Command failed: make -C /elsewhere check-release";
  assert(
    // The echo names a command the tier never ran, and no gate line of either run is a
    // recognised failure any more — so there is nothing left to compare, and the empty
    // recognised set is what refuses. The echo is not excused by being an echo.
    excuseOf([FOREIGN_ECHO], [A]).kind === "refused",
    `(unreadable) an echo of a command the tier never ran still refuses (${excuseOf([FOREIGN_ECHO], [A]).kind})`,
  );
  assert(
    excuseOf([A, FOREIGN_ECHO], [A, FOREIGN_ECHO]).kind === "excused",
    `(unreadable) and the base's copy of that same echo settles it (${excuseOf([A, FOREIGN_ECHO], [A, FOREIGN_ECHO]).kind})`,
  );
  assert(
    excuseOf([A], [A]).kind === "excused",
    `(unreadable) the pair without such a line still excuses (${excuseOf([A], [A]).kind})`,
  );
}

// ------------------------------------------------------ (over-window) one long line
{
  // A line past the classifier's own scan window is judged on its first 8 KiB, so the
  // tail — where two distinct checks differ — is invisible to the judge. Two such lines
  // can fold onto one comparison key, which is the defect whole-line comparison exists to
  // close. The rule is not "compare what was seen": a line no judge fully saw is not
  // evidence, so it refuses on either side.
  const PAD = "x".repeat(FAILURE_LINE_SCAN_MAX);
  const LONG_A = `not ok 1 - checkout ${PAD} variant alpha`;
  const LONG_B = `not ok 1 - checkout ${PAD} variant omega`;
  assert(
    LONG_A.length > FAILURE_LINE_SCAN_MAX && LONG_B.length > FAILURE_LINE_SCAN_MAX,
    `(over-window) both fixture lines really are past the window (${String(LONG_A.length)} vs ${String(FAILURE_LINE_SCAN_MAX)})`,
  );
  assert(
    excuseOf([LONG_A], [LONG_B]).kind === "refused",
    `(over-window) two long lines differing only past the window refuse — they must not fold (${excuseOf([LONG_A], [LONG_B]).kind})`,
  );
  assert(
    excuseOf([LONG_A], [LONG_A]).kind === "refused",
    `(over-window) an identical over-long pair refuses too — the line itself is not evidence (${excuseOf([LONG_A], [LONG_A]).kind})`,
  );
  assert(
    excuseOf([LONG_A], [LONG_A]).kind === "refused" &&
      excuseOf(["not ok 1 - checkout"], ["not ok 1 - checkout"]).kind === "excused",
    "(over-window) and a line inside the window still excuses (the veto is not a blanket refusal)",
  );
  // The wrapper shape is the one that actually folded: the harness prefix pushes the
  // gate's own text past the window, so the table read only the head of one check and
  // answered for both.
  const WRAPPED_A = `verify command \`prove -r t\` failed in ${PROBE_ROOT}: ${LONG_A}`;
  const WRAPPED_B = `verify command \`prove -r t\` failed in ${PROBE_ROOT}: ${LONG_B}`;
  assert(
    excuseOf([WRAPPED_A], [WRAPPED_B]).kind === "refused",
    `(over-window) two distinct harness-wrapped long lines refuse (${excuseOf([WRAPPED_A], [WRAPPED_B]).kind})`,
  );
}

// -------------------------------------------------- (paths) only a LEADING root comes out
{
  // The tree prefix is where a run's own tree sits. A root that appears anywhere else in
  // the line is CONTENT the tier printed — a path quoted in an assertion — and the other
  // tree's line carries it too, so removing it from one side and not the other erases a
  // difference the excuse then excused.
  const MID = `not ok 1 - checkout - ${HEAD_ROOT}/t/other.t is quoted mid-line`;
  assert(
    failureLinesOf(MID)[0]?.includes(HEAD_ROOT) === true,
    `(paths) a mid-line occurrence of the run's own root is KEPT (${JSON.stringify(failureLinesOf(MID)[0]?.slice(0, 60))})`,
  );
  assert(
    excuseOf([MID], [`not ok 1 - checkout - /somewhere/else/t/other.t is quoted mid-line`]).kind ===
      "refused",
    `(paths) and so a head line quoting its own tree refuses over a base that quoted another (${excuseOf([MID], [`not ok 1 - checkout - /somewhere/else/t/other.t is quoted mid-line`]).kind})`,
  );
}

// ----------------------------------------------------------- (record) an over-long line
{
  // A line past the step log's bound cannot be persisted. `names` is a DISPLAY preview
  // and is clipped; `baseNames` is the set `ci` REPLAYS, and a clipped replay line is a
  // line the classifier would not accept, so `ci` would compare strings `verify` never
  // compared. Over-long base lines mean the base set is OMITTED, and ci re-probes.
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
    `(record) a line both runs printed that fits the comparison still excuses (${r.kind})`,
  );
  assert(
    r.kind === "excused" &&
      r.record.names.every((n) => n.length <= PREEXISTING_NAME_MAX_CHARS) &&
      preexistingFailuresProblem({ fast: r.record }) === undefined,
    `(record) every DISPLAYED line is inside the bound and validates (${String(r.kind === "excused" ? r.record.names[0]?.length : -1)})`,
  );
  assert(
    r.kind === "excused" && r.record.baseNames === undefined,
    `(record) an over-long BASE line omits baseNames rather than truncating it, so ci re-probes (${String(r.kind === "excused" ? (r.record.baseNames === undefined ? "omitted" : "REPLAYED") : r.kind)})`,
  );
  assert(
    r.kind === "excused" && r.record.total === 1,
    `(record) the total counts the line, not the clip (${String(r.kind === "excused" ? r.record.total : -1)})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
