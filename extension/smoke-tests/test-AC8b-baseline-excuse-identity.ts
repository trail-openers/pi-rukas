#!/usr/bin/env bun
/**
 * #2042 — the identity a pytest line yields, and what refuses the whole excuse.
 *
 * Two rules the TAP/go removal left as the whole of the reader's contract:
 *
 *   - an unreadable failure line REFUSES, it is never merely omitted. A head of
 *     `[readable A, unreadable B]` against a base that named only A used to excuse,
 *     because `identitiesOfLine` dropped B and the subset test never saw the failure
 *     this run authored;
 *   - the trailing ` - <reason>` is cut at the FIRST separator at bracket DEPTH 0.
 *     The last-separator cut leaked reason text into the identity
 *     (`a.py::t - assert 1 - 2` read as `a.py::t - assert 1`), and a first-separator
 *     cut anywhere folds `test_total[EUR - 3.99]` and `test_total[EUR - 4.99]` onto
 *     one token, which excuses a failure only this run authored.
 *
 * The parametrised positive control is what keeps the reader from being a blanket
 * refusal: the SAME `t[1]` line on both sides excuses, and its identity is `t[1]`.
 */
import { baselineExcuse, testIdentitiesOf } from "../src/lean/verify-baseline-excuse.ts";
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
const HEAD_ROOT = "/tmp/pi-rukas-2042-id/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2042-id/repo.baseline-lean-verify-9";

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

const namesOf = (stream: string): string[] => testIdentitiesOf(stream).map((i) => i.name);

// ------------------------------------- (positive control) a parametrisation reads
{
  const PARAM = "FAILED a.py::t[1] - AssertionError";
  assert(
    excuseOf([PARAM], [PARAM]).kind === "excused",
    `(param) the SAME parametrised line on both sides excuses (${excuseOf([PARAM], [PARAM]).kind})`,
  );
  assert(
    namesOf(PARAM).join() === "a.py::t[1]",
    `(param) and its identity is the parametrisation, brackets and all (${JSON.stringify(namesOf(PARAM))})`,
  );
}

// -------------------------------- (depth-0 cut) a reason that itself carries " - "
{
  const REASON = "FAILED a.py::t - assert 1 - 2";
  assert(
    namesOf(REASON).join() === "a.py::t",
    `(cut) a reason containing ' - ' does not leak into the identity (${JSON.stringify(namesOf(REASON))})`,
  );
  assert(
    namesOf("FAILED a.py::t - x - y").join() === "a.py::t",
    `(cut) and neither does a second separator (${JSON.stringify(namesOf("FAILED a.py::t - x - y"))})`,
  );
  assert(
    namesOf("FAILED a.py::t[1]").join() === "a.py::t[1]",
    `(cut) a token with no depth-0 separator stays whole (${JSON.stringify(namesOf("FAILED a.py::t[1]"))})`,
  );
}

// ------------------------- (parametrisation) sibling values stay distinct tokens
{
  const HEAD = ["FAILED a.py::t[EUR - 3.99] - x", "FAILED a.py::t[EUR - 4.99] - x"];
  assert(
    namesOf(HEAD[0] ?? "").join() === "a.py::t[EUR - 3.99]",
    `(sibling) 3.99 reads as its own identity (${JSON.stringify(namesOf(HEAD[0] ?? ""))})`,
  );
  assert(
    namesOf(HEAD[1] ?? "").join() === "a.py::t[EUR - 4.99]",
    `(sibling) 4.99 reads as its own identity, not folded onto 3.99 (${JSON.stringify(namesOf(HEAD[1] ?? ""))})`,
  );
  assert(
    excuseOf(HEAD, [HEAD[0] ?? ""]).kind === "refused",
    `(sibling) a head that fails BOTH is refused by a base that fails only 3.99 (${excuseOf(HEAD, [HEAD[0] ?? ""]).kind})`,
  );
}

// ------------------------------------- (unreadable) a failure line nothing can name
{
  // The HIGH case: B's brackets never close, so no identity comes out of it. Omitting
  // it instead of refusing let a base that named only A excuse a tier that also failed B.
  const A = "FAILED tests/x_test.py::test_a - AssertionError";
  const B = "FAILED tests/x_test.py::test_b[ - oops";
  assert(
    excuseOf([A, B], [A]).kind === "refused",
    `(unreadable) a head line this module cannot read refuses the excuse (${excuseOf([A, B], [A]).kind})`,
  );
  assert(
    namesOf(B).length === 0,
    `(unreadable) and no truncated token is offered as an identity (${JSON.stringify(namesOf(B))})`,
  );
  assert(
    excuseOf([A], [A, B]).kind === "refused",
    `(unreadable) an unreadable BASE line refuses it too (${excuseOf([A], [A, B]).kind})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
