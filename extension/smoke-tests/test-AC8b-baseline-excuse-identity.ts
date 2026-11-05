#!/usr/bin/env bun
/**
 * #2042 — the identity a pytest line yields, and what refuses the whole excuse.
 *
 * Three rules the TAP/go removal left as the whole of the reader's contract:
 *
 *   - an unreadable failure line REFUSES, it is never merely omitted. A head of
 *     `[readable A, unreadable B]` against a base that named only A used to excuse,
 *     because `identitiesOfLine` dropped B and the subset test never saw the failure
 *     this run authored;
 *   - a line that OPENS with pytest's own `FAILED `/`ERROR ` marker must yield an identity
 *     even where the shared classifier recognises nothing: a collection error
 *     (`ERROR tests/test_new.py`, no `::`) and a bare `FAILED tests/y.py` went unseen by a
 *     classifier-only walk, so the excuse covered a failure the base never printed;
 *   - the trailing ` - <reason>` is cut at the FIRST separator at bracket DEPTH 0 — a
 *     last-separator cut leaks reason text into the identity and a first-separator cut
 *     anywhere folds `test_total[EUR - 3.99]` onto its siblings.
 *
 * The positive controls keep the reader from being a blanket refusal: the SAME `t[1]` line
 * on both sides excuses with identity `t[1]`, and so does an ordinary line.
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

// ---------------------------- (positive control) an ordinary line, and a parametrisation
{
  const ORD = "built 14 packages in 3s";
  const SAME = "FAILED a.py::t[1] - AssertionError";
  const BOTH = [ORD, SAME];
  assert(
    excuseOf(BOTH, BOTH).kind === "excused",
    `(control) an ordinary line beside the failure is excused (${excuseOf(BOTH, BOTH).kind})`,
  );
  assert(
    excuseOf([SAME], [SAME]).kind === "excused",
    `(param) the SAME parametrised line on both sides excuses (${excuseOf([SAME], [SAME]).kind})`,
  );
  assert(
    namesOf(SAME).join() === "a.py::t[1]",
    `(param) and its identity is the parametrisation, brackets and all (${JSON.stringify(namesOf(SAME))})`,
  );
}

// -------------------------------- (depth-0 cut) a reason that itself carries " - "
{
  const REASON = "FAILED a.py::t - assert 1 - 2";
  assert(
    namesOf(REASON).join() === "a.py::t",
    `(cut) a reason with ' - ' does not leak into the identity (${JSON.stringify(namesOf(REASON))})`,
  );
  assert(
    namesOf("FAILED a.py::t - x - y").join() === "a.py::t" &&
      namesOf("FAILED a.py::t[1]").join() === "a.py::t[1]",
    `(cut) a second separator does not either, and a token with none stays whole (${JSON.stringify(namesOf("FAILED a.py::t[1]"))})`,
  );
}

// ------------------------- (parametrisation) sibling values stay distinct tokens
{
  const HEAD = ["FAILED a.py::t[EUR - 3.99] - x", "FAILED a.py::t[EUR - 4.99] - x"];
  assert(
    namesOf(HEAD[0] ?? "").join() === "a.py::t[EUR - 3.99]" &&
      namesOf(HEAD[1] ?? "").join() === "a.py::t[EUR - 4.99]",
    `(sibling) each value reads as its own identity, not folded onto the other (${namesOf(HEAD[0] ?? "")}/${namesOf(HEAD[1] ?? "")})`,
  );
  assert(
    excuseOf(HEAD, [HEAD[0] ?? ""]).kind === "refused",
    `(sibling) a head that fails BOTH is refused by a base that fails only 3.99 (${excuseOf(HEAD, [HEAD[0] ?? ""]).kind})`,
  );
}

// ------------------------------------- (unreadable) a failure line nothing can name
{
  // B's brackets never close, so no identity comes out of it. Omitting it instead of
  // refusing let a base that named only A excuse a tier that also failed B.
  const A = "FAILED tests/x_test.py::test_a - AssertionError";
  const B = "FAILED tests/x_test.py::test_b[ - oops";
  assert(
    excuseOf([A, B], [A]).kind === "refused" && excuseOf([A], [A, B]).kind === "refused",
    `(unreadable) a head line this module cannot read refuses it, and an unreadable BASE line too (${excuseOf([A, B], [A]).kind}/${excuseOf([A], [A, B]).kind})`,
  );
  assert(
    namesOf(B).length === 0,
    `(unreadable) and no truncated token is offered as an identity (${JSON.stringify(namesOf(B))})`,
  );
}

// --------------------- (unrecognised marker) a pytest line the classifier never saw
{
  const A = "FAILED tests/x.py::test_a - AssertionError";
  // Neither line below matches a shape in the table (no `::`), so the classifier answers
  // "not a failure line"; the marker alone has to be enough to refuse.
  const COLLECTION_ERROR = "ERROR tests/test_brand_new.py";
  const BARE_FAILED = "FAILED tests/y.py";
  const HEADS: string[][] = [
    [A, COLLECTION_ERROR],
    [A, BARE_FAILED],
  ];
  for (const head of HEADS) {
    assert(
      excuseOf(head, [A]).kind === "refused",
      `(marker) ${head[1]} in head refuses the excuse (${excuseOf(head, [A]).kind})`,
    );
  }
  assert(
    excuseOf([A], [A, COLLECTION_ERROR]).kind === "refused",
    `(marker) the same on the BASE side refuses it (${excuseOf([A], [A, COLLECTION_ERROR]).kind})`,
  );
  assert(
    namesOf(BARE_FAILED).length === 0 && namesOf(COLLECTION_ERROR).length === 0,
    `(marker) and neither bare line yields an identity (${JSON.stringify(namesOf(BARE_FAILED))}/${JSON.stringify(namesOf(COLLECTION_ERROR))})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
