#!/usr/bin/env bun
/**
 * The develop gate's baseline comparison and timeout reporting.
 *
 * A verify command that already fails at the cycle's base commit parked
 * every cycle as `verify-failed:develop` with evidence blaming the diff; a
 * consolidated run KILLED at its timeout was reported as "specific
 * assertion: (no specific assertion could be extracted)". Driven through the
 * real `runVerifyCommandGate` with real git and a stub verify command whose
 * outcome is chosen per working directory (the builder is shared with the
 * stale-base suite in `lib/verify-baseline-red-harness.ts`).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOST_EXHAUSTION_LABEL,
  extractAttributedTail,
} from "../src/work-driver-exec-error.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
  sharesAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import {
  BASELINE_RED_MARKER,
  baselineExplainsChange,
} from "../src/work-driver-verify-baseline.ts";
import { appendEvent } from "../src/workflow-state.ts";
import {
  runGateFixture,
  type Outcome,
} from "./lib/verify-baseline-red-harness.ts";
import {
  RUST_CARGO_STREAM,
  CARGO_SIGABRT_SUMMARY,
  TSC_DIAG_NO_LOCATION,
  TSC_DIAG_STREAM,
  rustPanicHeader,
} from "./lib/verify-failure-shapes-fixtures.ts";
import {
  assertDefaultVerifyBound,
  defaultBoundText,
  pinDefaultVerifyTimeout,
} from "./lib/verify-timeout-pin.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};
// The timeout cases assert the DEFAULT bound's text. The bound is read from
// the production helper with PI_ENSEMBLE_VERIFY_TIMEOUT_MS absent (see
// ./lib/verify-timeout-pin.ts), so an operator who raised the knob (a 45-min
// laptop setting) does not fail them for the wrong reason, and a future
// change to the default moves the asserted text with it.
const BOUND = await defaultBoundText();
// One self-check lives in the lib and BOTH consumers call it, so the shared
// helper cannot silently read a bound the gate does not use — and the pin is
// proven to put the operator's own knob value back afterwards.
await assertDefaultVerifyBound(assert);
const root = mkdtempSync(path.join(tmpdir(), "pi-baseline-red-"));

const run = (
  name: string,
  outcomeFor: (where: "base" | "change", baseRun?: 1 | 2) => Outcome,
  baselineCallbacks: {
    onBaselineAttributed?: () => void;
    onBaselineRedEstablished?: (established: boolean) => void;
  } = {},
) => runGateFixture(root, name, outcomeFor, baselineCallbacks);


// #2341 — the real nessie 1415 cargo stream: the panic pair (test, file,
// line, measured value, bound) AND the generic target summary. The defective
// behaviour quoted only the summary; the fixture carries both so a regression
// that re-quotas the summary fails the quote assertion rather than passing on
// a fixture that never contained the decisive line.
const CARGO = `${RUST_CARGO_STREAM}\n`;

// 1 — the happy path never pays for a baseline run.
{
  const r = await run("green", () => ({ ok: true }));
  assert(r.failures.length === 0, "green gate: no failures");
  assert(!r.verifyRuns.includes("base"), "green gate: the baseline is NOT run on the happy path");
}

// 2 — red at base: the same test fails with and without the change.
{
  const r = await run("red-at-base", () => ({ ok: false, stdout: CARGO }));
  assert(
    r.verifyRuns.filter((w) => w === "base").length === 2,
    `red at base: the baseline is run TWICE after the failure (#1826 — one red run is not a red base; got ${r.verifyRuns.filter((w) => w === "base").length})`,
  );
  assert(
    r.baselineHadChange === false,
    "red at base: the baseline tree does not contain the change",
  );
  const first = r.failures[0] ?? "";
  assert(
    first.startsWith(BASELINE_RED_MARKER),
    "red at base: the baseline finding LEADS the failures",
  );
  assert(first.includes(r.baseSha.slice(0, 12)), "red at base: the finding names the base sha");
  assert(
    first.includes("base run 1") && first.includes("base run 2"),
    `red at base: the finding names BOTH base runs (got ${first.slice(0, 200)})`,
  );
  assert(
    first.includes("panicked at src/session/fastpath_tests.rs:91:5") &&
      first.includes("fast path took 101.409582ms") &&
      first.includes("which is over the 100 ms bound"),
    `red at base: the finding quotes the RUST PANIC — file:line, measured value and the bound it broke (got ${first.slice(0, 300)})`,
  );
  assert(
    first.includes("SAME assertion"),
    "red at base: the finding says the change's run shares that panic (same test on both sides)",
  );
  assert(
    !first.includes("error: test failed, to rerun pass"),
    "red at base: the generic cargo target summary is NEVER the quoted assertion (#2341)",
  );
  assert(
    first.includes("could not be established"),
    "red at base: with no origin the stale-base probe reports unknown rather than silently claiming the base is current (#2341)",
  );
  assert(
    first.includes("Fix the gate at the base commit"),
    "red at base: an unknown probe still gets the classic fix-the-base advice (#2341)",
  );
  assert(
    first.length <= 800,
    `red at base: the finding survives the 800-char evidence bound (${first.length})`,
  );
  assert(r.failures.length > 1, "red at base: the change's own failures are kept, not replaced");
  assert(
    !r.listed.includes("baseline-verify-9"),
    "red at base: the temporary worktrees are removed",
  );
  assert(
    !existsSync(r.baselineDir) && !existsSync(r.secondBaselineDir),
    "red at base: BOTH temporary directories are gone",
  );
  let st = r.state;
  st = {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      verifyEvidence: { step: "develop", failures: r.failures, at: 0 },
    },
  };
  st = appendEvent(st, {
    kind: "cap-hit",
    at: 0,
    cap: "verify-failed:develop",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: first,
  });
  const explained = explainCap("verify-failed:develop", st);
  assert(
    explained.includes("already fails at the cycle's base commit") &&
      !explained.includes("Inspect the worktree(s), fix or re-dispatch"),
    "red at base: the handoff no longer tells the operator to fix the worktree",
  );
}

// 3 — green at base: the change broke it; nothing is excused.
{
  const r = await run("green-at-base", (w) =>
    w === "base" ? { ok: true } : { ok: false, stdout: CARGO },
  );
  assert(r.failures.length > 0, "green at base: the failure still blocks");
  assert(
    !r.failures.some((f) => f.includes(BASELINE_RED_MARKER)),
    "green at base: no baseline-red finding",
  );
  assert(
    r.notes.some((n) => n.startsWith("baseline verify passed")),
    "green at base: a note records that the gate was green before the change",
  );
}

// 4 — a base run that fails for want of dependencies proves nothing.
{
  const r = await run("deps", (w) =>
    w === "base"
      ? { ok: false, stdout: "error: Cannot find module 'typescript'\n" }
      : { ok: false, stdout: CARGO },
  );
  assert(
    !r.failures.some((f) => f.includes(BASELINE_RED_MARKER)),
    "missing deps at base: NOT reported as a red baseline",
  );
  assert(
    r.notes.some((n) => n.startsWith("baseline verify not established")),
    "missing deps at base: reported as not established",
  );
}

// 5 — a run killed at its timeout is reported as a timeout, everywhere.
await pinDefaultVerifyTimeout(async () => {
  const attributed: boolean[] = [];
  const established: boolean[] = [];
  const r = await run(
    "timeout",
    () => ({
      ok: false,
      stdout: "ok    no product or host names in platform files\n",
      killed: true,
    }),
    {
      onBaselineAttributed: () => attributed.push(true),
      onBaselineRedEstablished: (e) => established.push(e),
    },
  );
  const all = r.failures.join("\n");
  assert(
    !all.includes("no specific assertion could be extracted") &&
      !all.includes("specific assertion:"),
    "timeout: no failure claims an assertion about the code",
  );
  assert(
    r.failures.some((f) => f.includes(`${BOUND} timeout on the CONSOLIDATED tree`)),
    "timeout: the consolidated run is reported as exceeding its bound",
  );
  // #1826 — a killed FIRST base run is no longer evidence about the base: it
  // judged nothing, so it triggers no second run, raises no baseline-red claim on
  // either channel, and leaves the change's own timeout entry as the park's
  // evidence. The `[verify-timeout]` line above is what an operator now reads for
  // this shape, and no assertion in the handoff quotes a base it never saw.
  assert(
    !r.failures.some((f) => f.startsWith(BASELINE_RED_MARKER)),
    "timeout: a base run killed at its bound raises no [baseline-red] finding (a killed run confirms nothing, #1826)",
  );
  assert(
    r.verifyRuns.filter((w) => w === "base").length === 1,
    `timeout: the killed base run is not re-run to confirm it (got ${r.verifyRuns.filter((w) => w === "base").length} base runs)`,
  );
  // The killed arm's own route, kept: no second run, no two-run claim on either
  // channel, and the base reported as NOT ESTABLISHED rather than red.
  assert(
    r.notes.some((n) => n.startsWith("baseline verify not established")),
    "timeout: the base is reported as not established rather than red",
  );
  // Its evidence is the timeout's own sentence, and cap precedence routes that
  // sentence ahead of anything else (#1404), so the killed arm cannot reach the cap
  // #1826 withholds: the claim is the `[baseline-red]` entry standing alone as the
  // gate's whole verdict, and a killed run's entry leads with `[verify-timeout]`.
  const baselineEntries = r.failures.filter((f) => f.startsWith(BASELINE_RED_MARKER));
  assert(
    baselineEntries.length <= 1 && baselineEntries.every((f) => f.includes("[verify-timeout]")),
    `timeout: the killed base raises no plain [baseline-red] claim — at most the timeout's own entry (${JSON.stringify(baselineEntries.map((f) => f.slice(0, 60)))})`,
  );
  // The two claims the gate's tail rule reads, asked of the real caller rather than
  // inferred from prose: a killed base run raises NEITHER. #1349's excuse rides on
  // `onBaselineAttributed` (voided: a killed run holds no stream), and the cap's
  // claim rides on `onBaselineRedEstablished` — whose `false` is what stops the
  // cycle parking as `verify-baseline-red:develop`, since no path reaching that cap
  // exists without the claim having fired. Asking `verifyCapFor` with the claim
  // hard-coded to false would test the router's argument, not the gate's answer.
  assert(
    attributed.length === 0,
    `timeout: a killed base run earns #1349's excuse for nothing (got ${JSON.stringify(attributed)})`,
  );
  assert(
    established.length === 1 && established[0] === false,
    `timeout: the killed base reports itself NOT established to the cap (got ${JSON.stringify(established)})`,
  );
  assert(
    !r.notes.some((n) => n.includes("FLAKY")),
    "timeout: a killed base run is not recorded as a flaky base — it never asked for a second run",
  );
});

// 5b — a base that is RED once and GREEN once is not a baseline-red park: the
// failure is attributed to the change exactly as a green base attributes it, and
// the flaky base is recorded (#1826's central case — the four cycles in one
// 40-minute window that parked while a fifth on the same mainline merged).
{
  // Both arms red through the FIRST base run and the second green is what the
  // fixture's per-cwd switch expresses; the change's own run must stay red or
  // the comparison is never reached at all.
  const r = await run("red-then-green", (w, baseRun) =>
    w === "base"
      ? baseRun === 2
        ? { ok: true }
        : { ok: false, stdout: CARGO }
      : { ok: false, stdout: CARGO },
  );
  assert(
    r.verifyRuns.filter((w) => w === "base").length === 2,
    `red then green: the confirming run was paid for (got ${r.verifyRuns.filter((w) => w === "base").length})`,
  );
  assert(
    !r.failures.some((f) => f.startsWith(BASELINE_RED_MARKER)),
    "red then green: no baseline-red finding — one red base run is not a red base",
  );
  assert(
    r.failures.length > 0,
    "red then green: the change's own failure still blocks, attributed as on a green base",
  );
  assert(
    r.notes.some((n) => n.startsWith("baseline verify not established") && n.includes("#1826")),
    "red then green: a note says the base was not confirmed, in the terms of the rule",
  );
  assert(
    r.notes.some(
      (n) => n.includes("FLAKY") && n.includes("base run 1") && n.includes("base run 2"),
    ),
    `red then green: the flaky base is recorded, naming both runs (got ${JSON.stringify(r.notes.filter((n) => n.includes("FLAKY")))})`,
  );
}

// 5c — the park's handoff names BOTH base runs and their outcomes.
{
  const r = await run("red-at-base-explain", () => ({ ok: false, stdout: CARGO }));
  const first = r.failures[0] ?? "";
  let st = appendEvent(r.state, {
    kind: "cap-hit",
    at: 0,
    cap: "verify-baseline-red:develop",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: first,
  });
  st = {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      verifyEvidence: { step: "develop", failures: r.failures, at: 0 },
    },
  };
  const explained = explainCap("verify-baseline-red:develop", st);
  assert(
    explained.includes("base run 1") && explained.includes("base run 2"),
    "handoff: explainCap(verify-baseline-red:develop) names both base runs (got the first 200: " +
      explained.slice(0, 200) +
      ")",
  );
  assert(
    /base run 1: FAILED[\s\S]*base run 2: FAILED/.test(explained),
    "handoff: both runs are named WITH their outcomes, not just counted",
  );
  // #2341 — no stale marker on the finding (the probe answered unknown here),
  // so the handoff keeps the classic fix-the-base instruction.
  assert(
    explained.includes("Fix the gate at the base commit"),
    "handoff: a base with no establishable staleness still gets the fix-the-base advice",
  );
}

// 6 — #2341 F1, the build-failure fold: the base is red on a missing `protoc`,
// the change is red on missing protobuf headers — two different defects, and
// cargo prints the SAME target-level summary for both. While a location-less,
// code-less `error:` line was a quotable `diagnostic`, both streams extracted
// that identical line, `sharesAssertion` folded them on containment, and
// `baselineExplainsChange` excused the failure the change itself added. The
// dialect rule takes the shared line's naming right, so each stream reports
// honest absence and the excuse fails.
{
  const SHARED = "error: failed to run custom build command for `nessie-build v0.1.0`";
  const buildFailure = (stderr: string) =>
    [
      "   Compiling nessie-build v0.1.0 (/repo)",
      SHARED,
      "  process exited with exit status: 1",
      "  --- stderr",
      stderr,
      "error: build failed",
    ].join("\n");
  const baseStream = buildFailure("protoc: program not found");
  const changeStream = buildFailure("google/protobuf/any.proto: File not found.");
  assert(
    baseStream.includes(SHARED) && changeStream.includes(SHARED),
    "build fold: both streams really carry the byte-identical summary — the fold material is in the stream, not the fixture",
  );
  assert(
    extractSpecificAssertion(baseStream, baseStream) === NO_SPECIFIC_ASSERTION,
    `build fold: the base stream (protoc) reports honest absence (got ${JSON.stringify(extractSpecificAssertion(baseStream, baseStream))})`,
  );
  assert(
    extractSpecificAssertion(changeStream, changeStream) === NO_SPECIFIC_ASSERTION,
    `build fold: the change stream (protobuf headers) reports honest absence (got ${JSON.stringify(extractSpecificAssertion(changeStream, changeStream))})`,
  );
  assert(
    !sharesAssertion(changeStream, SHARED) &&
      !sharesAssertion(changeStream, "error: build failed"),
    "build fold: the shared target-level line never buys a SAME-assertion claim",
  );
  assert(
    !baselineExplainsChange(
      {
        status: "red",
        rawStream: baseStream,
        probed: false,
        exitCode: 101,
        assertion: extractSpecificAssertion(baseStream, baseStream),
      },
      [{ text: changeStream, timedOut: false }],
    ),
    "build fold: a base red on missing protoc does NOT explain a change red on missing protobuf headers",
  );
}

// 7 — #2341 fix wave 4 (H4): the tsc dialect under the SAME location rule.
// Two location-less `error TS2345:` failures from DIFFERENT files print the
// byte-identical line (the file sits on another line, or a flattening gate
// amputates it); while the location rule was keyed on the rustc bracket form
// alone, the tsc one slipped through the rule built to refuse exactly this and
// the fold excused a regression the change added. Neither may be quoted nor
// share; the located tsc line still excuses its own base (the rule is not
// simply off).
{
  assert(
    TSC_DIAG_STREAM.split("\n").filter((l) => l === TSC_DIAG_NO_LOCATION).length === 2,
    "tsc fold: the byte-identical line really is in the stream twice — the fold material is in the stream, not the fixture",
  );
  assert(
    !sharesAssertion(TSC_DIAG_STREAM, TSC_DIAG_NO_LOCATION),
    `tsc fold: two location-less error TS2345 failures in different files never share an assertion (${sharesAssertion(TSC_DIAG_STREAM, TSC_DIAG_NO_LOCATION)})`,
  );
  assert(
    extractSpecificAssertion(TSC_DIAG_STREAM, TSC_DIAG_STREAM) === NO_SPECIFIC_ASSERTION,
    `tsc fold: a location-less error TS2345 line is never the quoted assertion (got ${JSON.stringify(extractSpecificAssertion(TSC_DIAG_STREAM, TSC_DIAG_STREAM))})`,
  );
  assert(
    !baselineExplainsChange(
      {
        status: "red",
        rawStream: TSC_DIAG_STREAM,
        probed: false,
        exitCode: 2,
        assertion: TSC_DIAG_NO_LOCATION,
      },
      [{ text: `tsc reported ${TSC_DIAG_NO_LOCATION} in a different file`, timedOut: false }],
    ),
    "tsc fold: a base red on one location-less TS2345 does not explain an unrelated change failure",
  );
}

// The foreign-target workspace stream (#2341 fix wave 7): two crates of one
// `cargo test --workspace` print BYTE-IDENTICAL libtest names, and the failing
// target aborted before printing its own verdict. Separating the sibling's `ok`
// from this header's own needs cargo's per-target banner, which the veto
// deliberately does not parse — so this panic is DELIBERATELY OVER-REFUSED: a
// loud absence costs one round; the silent under-refusal spends the corrective
// round on a test that passes.
{
  const targetA = [
    "running 1 test",
    "test pkg::tests::t_0 ... ok",
    "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
    ...Array.from({ length: 40 }, (_, n) => `   Compiling mid_crate_${n} v0.1.0 (registry)`),
  ].join("\n");
  const targetB = [
    "running 1 test",
    rustPanicHeader("pkg::tests::t_0", "src/real_0.rs:1:5"),
    "assertion failed: `(left == right)` the value the change broke",
    "Aborted (core dumped)",
    CARGO_SIGABRT_SUMMARY,
  ].join("\n");
  const raw = `${targetA}\n${targetB}`;
  const { tail } = extractAttributedTail(raw, 1500);
  assert(
    extractSpecificAssertion(tail, raw) === NO_SPECIFIC_ASSERTION,
    `foreign target (wave 7): a sibling crate's same-named ok OVER-REFUSES, by design (got ${JSON.stringify(extractSpecificAssertion(tail, raw).slice(0, 60))})`,
  );
  const renamed = raw.replace("test pkg::tests::t_0 ... ok", "test pkg::other ... ok");
  const renamedTail = extractAttributedTail(renamed, 1500).tail;
  assert(
    extractSpecificAssertion(renamedTail, renamed) !== NO_SPECIFIC_ASSERTION,
    `foreign target (wave 7): the veto is exact-name, not a ban (got ${JSON.stringify(extractSpecificAssertion(renamedTail, renamed).slice(0, 60))})`,
  );
  assert(
    baselineExplainsChange(
      {
        status: "red",
        rawStream: raw,
        probed: true,
        exitCode: 101,
        assertion: extractSpecificAssertion(extractAttributedTail(raw, 1500).tail, raw),
      },
      [
        {
          text: "thread 'pkg::tests::t_0' panicked at src/other.rs:9:9:\nthe failure the change added",
          timedOut: false,
        },
      ],
    ) === false,
    "foreign target (wave 7): the base's assertion never excuses a DIFFERENT failure the change added",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
