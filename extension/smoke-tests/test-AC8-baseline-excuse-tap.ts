#!/usr/bin/env bun
/**
 * #2064 — the excuse compares WHOLE failure lines, so it excuses any runner the shared
 * classifier recognises, and a line whose text changed is a line the base never printed.
 *
 * The parser this replaces read pytest's `path::name` out of each line and compared
 * tokens, which is why TAP and go used to be refused outright: every token parser tried
 * for them found a new way to fold two checks onto one token. Whole lines cannot fold,
 * so both now excuse — and the cases that pinned the folding refusal come back as the
 * cases that pin it NOT happening.
 *
 *   (tap) two runs of one TAP suite print the same `not ok 1 - checkout - expected 3
 *     got 4` -> excused, and the sibling `not ok 2 - checkout - other assertion` — the
 *     line a ` - ` cut used to fold onto the first — is refused when only the head
 *     printed it
 *   (go) an identical `--- FAIL:` pair excuses; a base that printed only one of two
 *     head failures does not
 *   (reason) a head line whose reason text differs from the base's is a NEW failure
 *     line, so a changed reason refuses where an identity parser saw one name
 *   (paths) each tree's own root is stripped as a literal prefix, so one check printed
 *     in two trees is one line, and a different project-relative path is not
 *   (marker) a line that opens with a runner's own `FAILED `/`ERROR ` marker and that
 *     the classifier does not recognise refuses the whole excuse, on either side
 *   (ci probe) a red full tier whose head set the base probe printed excuses, and the
 *     tier's command runs at HEAD and again in the throwaway base tree — ci pays its own
 *     probe even when `verify`'s record on the log carries a byte-identical command and
 *     a recorded `baseNames` set
 *   (tier) a tier that really printed TAP lines excuses end to end
 */
import { baselineExcuse, failureLinesOf } from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";
import { cleanUp, run } from "./lib/lean-ci-recorder.ts";
import { failLinesTier } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC8-baseline-excuse-tap.ts";
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
const HEAD_ROOT = "/tmp/pi-rukas-2064-tap/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-tap/repo.baseline-lean-verify-9";

/** One comparison, on the lines each run printed. */
function excuseOf(headLines: string[], baseLines: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'prove -r t'",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

// -------------------------------------------------------------- (tap) TAP excuses
{
  const A = "not ok 1 - checkout - expected 3 got 4";
  const B = "not ok 2 - checkout - other assertion";
  assert(
    excuseOf([A], [A]).kind === "excused",
    `(tap) a TAP line the base printed identically excuses (${excuseOf([A], [A]).kind})`,
  );
  // The pair a depth-0 ` - ` cut used to fold onto one token: under whole-line
  // comparison they are two lines, so a base that printed only one cannot excuse both.
  assert(
    excuseOf([A, B], [A]).kind === "refused",
    `(tap) its sibling line, printed only at head, refuses (${excuseOf([A, B], [A]).kind})`,
  );
  assert(
    excuseOf([A, B], [A, B]).kind === "excused",
    `(tap) and both lines printed at base excuse (${excuseOf([A, B], [A, B]).kind})`,
  );
}

// ----------------------------------------------------------------- (go) go excuses
{
  const GO = ["--- FAIL: TestRetryBackoff (0.31s)", "--- FAIL: TestVerifyGate (0.02s)"];
  assert(
    excuseOf(GO, GO).kind === "excused",
    `(go) a go-only pair excuses, as a TAP or pytest pair does (${excuseOf(GO, GO).kind})`,
  );
  assert(
    excuseOf(GO, [GO[0] as string]).kind === "refused",
    `(go) a base that failed only one of the two keeps the red (${excuseOf(GO, [GO[0] as string]).kind})`,
  );
}

// ---------------------------------------------------- (reason) a changed reason refuses
{
  const HEAD = "FAILED tests/x_test.py::test_a - assert 1 == 2";
  const BASE = "FAILED tests/x_test.py::test_a - assert 1 == 3";
  assert(
    excuseOf([HEAD], [BASE]).kind === "refused",
    `(reason) a failure line whose reason text changed is a new line, and refuses (${excuseOf([HEAD], [BASE]).kind})`,
  );
  assert(
    excuseOf([HEAD], [HEAD]).kind === "excused",
    `(reason) the same line unchanged still excuses (${excuseOf([HEAD], [HEAD]).kind})`,
  );
}

// ------------------------------------ (paths) the two trees' own prefixes are not content
{
  const HEAD = `not ok 1 - ${HEAD_ROOT}/t/checkout.t - expected 3 got 4`;
  const BASE = `not ok 1 - ${PROBE_ROOT}/t/checkout.t - expected 3 got 4`;
  assert(
    excuseOf([HEAD], [BASE]).kind === "excused",
    `(paths) the same check printed in two trees excuses (${excuseOf([HEAD], [BASE]).kind})`,
  );
  const shifted = `not ok 1 - ${PROBE_ROOT}/t/other.t - expected 3 got 4`;
  assert(
    excuseOf([HEAD], [shifted]).kind === "refused",
    `(paths) a different project-relative path is a different line (${excuseOf([HEAD], [shifted]).kind})`,
  );
}

// ------------------ (head-only) a failure the base never printed refuses the excuse
{
  const A = "FAILED tests/x_test.py::test_a - AssertionError";
  // Both lines below match a shape the table carries, so a head-only one of them is a
  // line the base never printed and the verbatim rule refuses it; and `failureLinesOf`
  // hands it over as a comparable line, so nothing here can drop it out of the set.
  const NEW_PYTEST = "FAILED tests/y.py::t - AssertionError";
  const NEW_GO = "--- FAIL: TestBrandNew (0.01s)";
  assert(
    failureLinesOf(NEW_PYTEST).length === 1 && failureLinesOf(NEW_GO).length === 1,
    `(marker) both new-check lines are lines the classifier reads (${JSON.stringify(failureLinesOf(NEW_GO))})`,
  );
  assert(
    excuseOf([A, NEW_PYTEST], [A]).kind === "refused",
    `(marker) a head-only new pytest failure refuses the excuse (${excuseOf([A, NEW_PYTEST], [A]).kind})`,
  );
  assert(
    excuseOf([A, NEW_GO], [A]).kind === "refused",
    `(marker) a head-only new go failure refuses it too (${excuseOf([A, NEW_GO], [A]).kind})`,
  );
  const BARE_FAILED = "FAILED tests/y.py";
  assert(
    excuseOf([A], [BARE_FAILED]).kind === "refused",
    `(marker) a base that named nothing but an unreadable line is no evidence (${excuseOf([A], [BARE_FAILED]).kind})`,
  );
}

// ------------------------------------ (ci probe) ci re-probes, never replays a record
{
  const LINES = ["not ok 1 - a bats check", "--- FAIL: TestSolo (0.01s)"];
  const FULL = "sh -c 'prove -r t'";
  // The shape the reuse arm used to accept: a green verify whose record carries this
  // exact command AND the base's whole name set. Nothing reads that set any more, so ci
  // must pay its own probe — and the probe is what excuses it here, not the record.
  const record = {
    cmd: FULL,
    names: LINES,
    total: LINES.length,
    baseSha: "b".repeat(40),
    // A step log from before the verbatim rule still carries the base's name set; the
    // recorder writes this object onto the verify outcome verbatim, so ci sees it too.
    baseNames: LINES,
  };
  const r = await run({
    full: FULL,
    tierExit: 1,
    tierStdout: LINES.join("\n"),
    frozenBytes: {
      path: "tests/AC1-retry.test.sh",
      bytes: "#!/bin/sh\nexit 0\n",
      baseBytes: "#!/bin/sh\nexit 1\n",
    },
    reuseRecord: record,
    // The base's own output comes ONLY from the probe, which the recorder answers at the
    // throwaway tree. A reuse replay would grade this green off the record and never run
    // the base tier, so the absence of that stream is what makes the probe observable.
    baseTierOutput: LINES.join("\n"),
  });
  assert(
    r.outcome?.kind === "green",
    `(ci probe) a red full tier excuses on its OWN probe's output (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(
    r.cmds.filter((c) => c === FULL).length === 2,
    `(ci probe) the tier ran at HEAD and once more at the base, though verify's record was reusable (${String(r.cmds.filter((c) => c === FULL).length)})`,
  );
  assert(
    r.tierRuns === 2,
    `(ci probe) and the tier ran inside the throwaway base checkout too — the recorder answers the probe's tier by its cwd, so two runs IS the two-tree proof (${String(r.tierRuns)})`,
  );
}

// ------------------------------------- (tier fixture) a real TAP tier excuses end to end
{
  const LINES = ["not ok 1 - a bats check", "not ok 2 - another one - expected 3 got 4"];
  const r = await run({
    full: failLinesTier("tap-e2e", LINES),
    tierExit: 1,
    tierStdout: LINES.join("\n"),
    baseTierOutput: LINES.join("\n"),
    frozenBytes: {
      path: "tests/AC1-retry.test.sh",
      bytes: "#!/bin/sh\nexit 0\n",
      baseBytes: "#!/bin/sh\nexit 1\n",
    },
  });
  assert(
    r.outcome?.kind === "green",
    `(tier) a red tier that really printed TAP lines excuses over a base that printed them (${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
}

cleanUp();
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
