#!/usr/bin/env bun
/**
 * Issue #1028 — verify-loop.sh --digest mode.
 *
 * Tests the `--digest` failure-digest mode of smoke-tests/lib/verify-loop.sh
 * (flag implemented by the sibling workstream; this file is the test surface
 * for it — the issue's acceptance criteria say the new --digest cases go in
 * a dedicated file, not in test-verify-loop.ts, which is near the 500-line
 * cap).
 *
 * The digest's contract: print every failing test file name, every `✗` line
 * from each failing test's output, the indented detail lines that follow
 * each `✗`, and the `FAILED: <n> test(s) — …` summary; drop everything else
 * (no `✓` lines, no passing tests' output); exit with the SAME code as
 * normal mode (0 all-pass, 1 any failure, 2 usage error). The digest is a
 * line-anchor filter, NOT head/tail truncation — a planted failure anywhere
 * in the argument list must survive, not only the last one.
 *
 * Cases:
 *   1. Mixed fail/pass set (fixture-1/2/3): exit code parity with normal
 *      mode, every failing file named, every ✗ present, the `FAILED:`
 *      summary present, no ✓ lines, no passing tests' output.
 *   2. All-pass set: exit 0, empty digest, no FAILED: marker (the existing
 *      case-2 invariant, in digest mode).
 *   3. Planted failures at head, middle and tail of a multi-fixture argument
 *      list: all three failures' ✗ lines appear in the digest — not just
 *      the last one (unpatterned head/tail truncation drops the middle).
 *   4. Thrown-error failure (fixture-throw.ts): a failing test with NO ✗
 *      line — the digest still attributes it by the `FAILED: <file>` marker.
 *   5. ✓-noise + indented detail (fixture-multi.ts, fixture-check-noise.ts):
 *      every ✗ line with its indented detail survives; the 3×200 bound from
 *      normal mode does NOT apply; the `✓ ... error ...` trap line is absent
 *      even though it contains the substring "error"; detail from one ✗
 *      block is not carried into the next.
 *   6. Shared digest-filter contract (the mechanical cross-check the prose
 *      contract in verify-loop.sh's header describes): the same fixture
 *      output is fed through BOTH implementations — the --digest state
 *      machine (full indented detail) and the #827 bounded tail (grep for ✗)
 *      — and the two must agree on which ✗ marker lines are kept, line for
 *      line.
 *
 * Shared helpers (runLoop, runPipeline) live in verify-loop-lib.ts; the
 * --digest argv variant is local to this file because the lib's runLoop is
 * out of scope for this ticket.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { runLoop } from "./verify-loop-lib.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(__dirname, "fixtures", "verify-loop");
const SCRIPT = path.join(__dirname, "lib", "verify-loop.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// #1028 — run verify-loop.sh in --digest mode (the lib's runLoop does not
// take extra argv; this thin wrapper is the digest variant of the same
// helper, same cwd and spawn shape, plus the flag as argv[0]).
//
// `error` is checked explicitly: spawnSync reports a failure to spawn bash
// (missing binary, EACCES, …) as `error` with `status: null` rather than as
// a non-zero exit code, so without this check a broken environment would
// read as "the digest failed" instead of "we could not run bash at all".
//
// @returns {status, stdout} are meaningful only when envError is null.
function runDigest(
  files: string[],
): { status: number; stdout: string; envError: string | null } {
  const result = spawnSync("bash", [SCRIPT, "--digest", ...files], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
  });
  if (result.error) {
    return {
      status: -1,
      stdout: "",
      envError: `failed to spawn bash: ${result.error.message}`,
    };
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? "", envError: null };
}

// --- Case 1: mixed fail/pass — parity + invariants ---
{
  const f = (n: number) => path.join(FIXTURES, `fixture-${n}.ts`);
  const files = [f(1), f(2), f(3)];
  const normal = runLoop(files);
  const digest = runDigest(files);
  assert(
    digest.envError === null,
    `case 1 (digest): environment OK — bash spawned (no spawn error${digest.envError ? `: ${digest.envError}` : ""})`,
  );
  assert(
    digest.status === normal.status && digest.status !== 0,
    `case 1 (digest): exit code matches normal mode (${digest.status} vs ${normal.status}), non-zero on failure`,
  );
  const lines = digest.stdout.trim().split("\n");
  assert(
    lines[lines.length - 2]?.startsWith("FAILED: 2 test(s) —"),
    `case 1 (digest): second-to-last line is the summary marker with count 2 (got: ${JSON.stringify(lines[lines.length - 2])})`,
  );
  assert(
    lines[lines.length - 1] === "P: 1  F: 2",
    `case 1 (digest): last line is the pass/fail tally P: 1  F: 2 (got: ${JSON.stringify(lines[lines.length - 1])})`,
  );
  assert(
    digest.stdout.includes("FAILED: " + f(1)) && digest.stdout.includes("FAILED: " + f(3)),
    "case 1 (digest): per-failure markers name both failing files (fixture-1 and fixture-3; fixture-2 passes)",
  );
  assert(
    digest.stdout.includes("FAILED: " + f(3)),
    "case 1 (digest): fixture-3 is attributed by its FAILED: marker (its plain-text failure line is dropped by the ✗-anchored filter)",
  );
  assert(
    !digest.stdout.includes(f(2)) && !digest.stdout.includes("allpass"),
    "case 1 (digest): the passing fixture-2's output is absent",
  );
  assert(
    !digest.stdout.split("\n").some((l) => l.startsWith("✓")),
    "case 1 (digest): no ✓ lines in the digest",
  );
}

// --- Case 2: all-pass — exit 0, empty digest, no FAILED: marker ---
{
  const files = [path.join(FIXTURES, "allpass-a.ts"), path.join(FIXTURES, "allpass-b.ts")];
  const digest = runDigest(files);
  assert(digest.status === 0, "case 2 (digest): exit 0 when all pass");
  assert(
    digest.stdout.trim() === "",
    `case 2 (digest): digest prints nothing on all-pass (got: ${JSON.stringify(digest.stdout)})`,
  );
  assert(!digest.stdout.includes("FAILED:"), "case 2 (digest): no FAILED: marker on all-pass");
}

// --- Case 3: planted failures at head, middle and tail — all survive ---
{
  const f = (n: number) => path.join(FIXTURES, `fixture-${n}.ts`);
  const files = [f(1), f(2), f(3), f(4), f(5)]; // 1,3,5 fail; 2,4 pass
  const digest = runDigest(files);
  assert(digest.status !== 0, "case 3 (digest): exit non-zero with failures at head, middle and tail");
  assert(
    digest.stdout.includes("FAILED: " + f(1)),
    "case 3 (digest): HEAD failure (fixture-1) survives in the digest via its FAILED: marker",
  );
  assert(
    digest.stdout.includes("FAILED: " + f(3)),
    "case 3 (digest): MIDDLE failure (fixture-3) survives via its FAILED: marker — head/tail truncation would drop it",
  );
  assert(
    digest.stdout.includes("FAILED: " + f(5)),
    "case 3 (digest): TAIL failure (fixture-5) survives in the digest via its FAILED: marker",
  );
  const lastLine = digest.stdout.trim().split("\n").at(-2) ?? "";
  assert(
    lastLine.startsWith("FAILED: 3 test(s) —") &&
      lastLine.includes("fixture-1.ts") &&
      lastLine.includes("fixture-3.ts") &&
      lastLine.includes("fixture-5.ts"),
    `case 3 (digest): the summary names all three planted failures (got: ${JSON.stringify(lastLine)})`,
  );
  const lines3 = digest.stdout.trim().split("\n");
  assert(
    lines3[lines3.length - 1] === "P: 2  F: 3",
    `case 3 (digest): pass/fail tally line is P: 2  F: 3 (got: ${JSON.stringify(lines3[lines3.length - 1])})`,
  );
}

// --- Case 4: thrown error — no ✗ line, still attributed by the marker ---
{
  const files = [path.join(FIXTURES, "fixture-throw.ts")];
  const digest = runDigest(files);
  const normal = runLoop(files);
  assert(
    digest.status === normal.status && digest.status !== 0,
    `case 4 (digest): thrown-error failure exits with the same code as normal mode (${digest.status})`,
  );
  assert(
    digest.stdout.includes("FAILED: " + path.join(FIXTURES, "fixture-throw.ts")),
    "case 4 (digest): a failure with NO ✗ line is still attributed by its FAILED: marker",
  );
  assert(
    (digest.stdout.trim().split("\n").at(-2) ?? "").startsWith("FAILED: 1 test(s) —"),
    "case 4 (digest): the summary marker is present (second-to-last) for a thrown-error failure",
  );
  assert(
    (digest.stdout.trim().split("\n").at(-1) ?? "") === "P: 0  F: 1",
    "case 4 (digest): the pass/fail tally line is P: 0  F: 1",
  );
}

// --- Case 5: ✓-noise + indented detail ---
{
  const files = [
    path.join(FIXTURES, "fixture-multi.ts"),
    path.join(FIXTURES, "fixture-check-noise.ts"),
  ];
  const digest = runDigest(files);
  assert(digest.status !== 0, "case 5 (digest): exit non-zero when the noise fixture fails");

  // Every ✗ line survives — no 3×200 bound (that bound is normal-mode only).
  assert(
    digest.stdout.includes("✗ fixture-multi: first assertion: expected 'alpha', got 'beta'"),
    "case 5 (digest): fixture-multi's first ✗ line present",
  );
  assert(
    digest.stdout.includes("✗ fixture-multi: second assertion: expected 0 failures, got 2"),
    "case 5 (digest): fixture-multi's SECOND ✗ line present (no 3×200 bound in digest mode)",
  );

  // Indented detail follows its ✗ line and is NOT carried into the next ✗.
  const lines = digest.stdout.split("\n");
  const i1 = lines.findIndex((l) => l.includes("first assertion: expected 'alpha'"));
  const i2 = lines.findIndex((l) => l.includes("second assertion: expected 0 failures"));
  assert(
    i1 !== -1 && i1 + 1 < lines.length && lines[i1 + 1].startsWith("  at checkAlpha"),
    `case 5 (digest): the indented 'at checkAlpha' detail line immediately follows its ✗ (✗1 at ${i1})`,
  );
  assert(
    i2 !== -1 && i1 !== -1 && i2 > i1,
    "case 5 (digest): the indented detail is not duplicated before the next ✗",
  );

  // The ✓-noise fixture: no ✓ line survives, and the trap line — a ✓ line
  // containing the substring "error" — is absent even though "error" appears
  // in a kept line. Anchoring at line start is what makes this hold.
  assert(
    !lines.some((l) => l.startsWith("✓")),
    "case 5 (digest): no ✓ lines in the digest (the keep-filters are line-anchored)",
  );
  assert(
    !digest.stdout.includes("✓ no error handling: assertion passed"),
    "case 5 (digest): the `✓ ... error ...` trap line is ABSENT despite containing 'error'",
  );
  assert(
    digest.stdout.includes("✗ fixture-check-noise: real failure at the end: expected 1, got 0"),
    "case 5 (digest): the real failure line in the noise fixture survives",
  );
  assert(
    !digest.stdout.includes("✓ happy path") && !digest.stdout.includes("✓ edge case"),
    "case 5 (digest): the other ✓ lines in the noise fixture are absent",
  );
}

// --- Case 6: shared digest-filter contract — the two implementations agree ---
//
// The prose contract in verify-loop.sh's header ("Shared digest-filter
// contract (#1028)") says the --digest state machine and the #827 tail
// implement the same anchor semantics. This case makes that mechanical: the
// same fixture output is fed through both — --digest (unbounded ✗ + indented
// detail) and normal mode's #827 bounded tail (grep -F ✗, first 3, 200
// chars each) — and the kept ✗ marker lines must be identical in both.
// (The #827 tail only greps ✗ lines, so the comparison is on ✗ lines.)
{
  const files = [
    path.join(FIXTURES, "fixture-multi.ts"),
    path.join(FIXTURES, "fixture-check-noise.ts"),
  ];
  const normal = runLoop(files);
  const digest = runDigest(files);
  assert(
    normal.status !== 0 && digest.envError === null && digest.status !== 0,
    "case 6: both runs executed (normal non-zero, digest spawned)",
  );

  // Digest side: every ✗ line of every failing test, in execution order.
  const digestX = digest.stdout
    .split("\n")
    .filter((l) => l.startsWith("✗ "));

  // #827 side: the bounded tail is everything after the last `FAILED:` line
  // in the normal-mode output (where the ✗ echoes live). The #827 loop
  // truncates each ✗ line to 200 chars (prefix 199 + '…'), so the digest
  // side is truncated to the same 200 chars before comparing — a digest ✗
  // line of exactly 200 chars matches its own 199+… truncation.
  const normalStdout = normal.stdout;
  const lastMarker = normalStdout.lastIndexOf("FAILED: ");
  const tail = lastMarker === -1 ? "" : normalStdout.slice(lastMarker);
  const tailX = tail
    .split("\n")
    .filter((l) => l.startsWith("✗ "))
    .map((l) => (l.length > 200 ? l.slice(0, 199) + "…" : l));
  const digestXTrunc = digestX.map((l) =>
    l.length > 200 ? l.slice(0, 199) + "…" : l,
  );

  assert(
    digestX.length === tailX.length,
    `case 6: both filters keep the same NUMBER of ✗ marker lines (digest ${digestX.length}, #827 tail ${tailX.length})`,
  );
  const mismatches = digestXTrunc
    .map((l, i) => ({ digest: l, tail: tailX[i] }))
    .filter((p) => p.digest !== p.tail);
  assert(
    mismatches.length === 0,
    `case 6: both filters keep the same ✗ lines, in order (mismatches: ${mismatches.length}${mismatches.length ? ` — ${JSON.stringify(mismatches[0])}` : ""})`,
  );
}

console.log(exit === 0 ? "\nAll digest checks passed." : "\nFAILED");
process.exit(exit);
