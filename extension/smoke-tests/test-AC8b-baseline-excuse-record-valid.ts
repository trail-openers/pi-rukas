#!/usr/bin/env bun
/**
 * #2042 — a recorded name the step log's own reader would refuse forfeits the excuse.
 *
 * `baselineExcuse` builds a `PreexistingTierRecord` and the caller writes it onto the
 * step log with `saveRun`. `loadRun` then applies `preexistingFailuresProblem`, which
 * refuses a name longer than `PREEXISTING_NAME_MAX_CHARS` or carrying a control
 * character — and the 8 KiB scan-window clip can produce both by itself, by cutting a
 * long name mid-character. Before this check the two halves disagreed: the write
 * succeeded and the readback refused the WHOLE run file, so the excuse that graded a
 * tier green took the run down with it.
 *
 * Both streams print the SAME 250-character name, so nothing else can be what
 * refuses it — and the pair would be excused were it not for the record check. The
 * valid short pair below is the control: without it the guard would pass by refusing
 * every excuse.
 */
import {
  PREEXISTING_NAME_MAX_CHARS,
  preexistingFailuresProblem,
} from "../src/lean/state-outcome-maps.ts";
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC8b-baseline-excuse-record-valid.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };

function excuseOf(name: string) {
  const stream = `FAILED ${name} - AssertionError`;
  return baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'pytest'",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: stream,
    baseStream: stream,
    headRoot: "/tmp/pi-rukas-2042-clip/worktree",
    probeRoot: "/tmp/pi-rukas-2042-clip/repo.baseline-lean-verify-9",
  });
}

// -------------------------------------------- (too-long) a 250-char shared name
{
  const LONG = `tests/${"d".repeat(240)}_test.py::test_a`;
  assert(
    LONG.length > PREEXISTING_NAME_MAX_CHARS && LONG.includes("::"),
    `(too-long) the fixture name really is over the bound and still a pytest identity (${String(LONG.length)} chars)`,
  );
  const r = excuseOf(LONG);
  assert(
    r.kind === "refused",
    `(too-long) a name the log's reader would refuse forfeits the excuse (${r.kind})`,
  );
  assert(
    r.kind === "refused" || r.record.names.length > 0,
    "(too-long) and nothing is half-written",
  );
  // The refusal is the validator's own answer, not a coincidence of this fixture.
  assert(
    preexistingFailuresProblem({
      fast: {
        cmd: "sh -c 'pytest'",
        names: [LONG],
        total: 1,
        baseSha: "a".repeat(40),
      },
    }) !== undefined,
    "(too-long) the state validator really does refuse that name (the two cannot disagree)",
  );
}

// ------------------------------------------- (surrogate) a clipped astral name
{
  // An astral character cut in half by the scan window leaves a lone surrogate,
  // which `\p{Cc}` refuses — the shape the clip produces that no length bound catches.
  const SURROGATE = `tests/sur_${"\ud835\udc00".repeat(70)}t.py::test_a`.slice(0, 141);
  assert(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(SURROGATE),
    `(surrogate) the fixture token really holds a lone surrogate (${String(SURROGATE.length)} chars)`,
  );
  const r = excuseOf(SURROGATE);
  assert(
    r.kind === "refused",
    `(surrogate) a lone surrogate in a recorded name forfeits the excuse (${r.kind})`,
  );
}

// ------------------------------------------------------ (valid) the control pair
{
  const SHORT = "tests/x_test.py::test_a";
  const r = excuseOf(SHORT);
  assert(
    r.kind === "excused",
    `(valid) a name inside the bound still excuses, so the guard is not a blanket refusal (${r.kind})`,
  );
  assert(
    r.kind === "excused" && preexistingFailuresProblem({ fast: r.record }) === undefined,
    "(valid) and every record the excuse returns is one the log can be read back with",
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
