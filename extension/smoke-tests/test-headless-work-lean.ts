#!/usr/bin/env bun
/**
 * epic #1883 — `pi-rukas-headless work-lean <issue>`: the verb drives the lean
 * engine through an injected `run` and maps its answer to the exit code and the
 * one JSON document, without a model call, a git call or a forge.
 *
 *   code 10 / handed-back → 10, one document, state and steps
 *   code 0 / 11           → 0 / 11 (the engine's own codes pass through)
 *   bad argv              → 40, error.code "bad-arguments", nothing ran
 *   a publish step        → doc.prUrl is the newest publish step's URL, if it is
 *                           a well-formed https URL within the load-time bound
 *   a malformed outcome   → 30, error.code "crash", exactly one document
 *   a code off the table  → 30 (a state whose code is not the one machine.ts says)
 *   a crash               → 30, and a traceWarn with the error name and stack
 *   a host whose send throws → still exactly one document, at the run's code
 *
 * The lock refusal and the headless trust thread — the two things that reach the
 * real engine and the real dispatch seam — are in
 * `test-headless-work-lean-lock.ts`. Fixtures are in
 * `./lib/work-lean-verb-fixture.ts`.
 */

import { MESSAGE_MAX, TRACE_MAX } from "../src/headless/work-lean.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import {
  fakeRun,
  spawnCrash,
  spawnHugeCrash,
  step,
  traceBody,
  verbRun,
  verbThrowing,
  verbThrowingHost,
} from "./lib/work-lean-verb-fixture.ts";

const { assert, state } = makeAssert();

// ── (a) a handed-back run: exit 10, one document, the state, ≥1 NDJSON line.
{
  const r = await verbRun(["7"], async () => ({
    summary: "work-lean #7: handed-back (exit 10) — handler error at build",
    result: fakeRun({ code: 10, state: "handed-back", steps: [step("ready"), step("build")] }),
  }));
  assert(r.violations.length === 0, `handed-back: output contract (${r.violations.join("; ")})`);
  assert(r.code === 10, `handed-back exits 10 (got ${r.code})`);
  assert(r.doc.subcommand === "work-lean", "document names the subcommand");
  assert(r.doc.issue === 7, "document carries the issue");
  assert(r.doc.state === "handed-back", `document carries the state (got ${r.doc.state})`);
  assert(r.doc.exitCode === 10, "document's exitCode matches");
  assert(r.doc.steps === 2, `document counts the steps (got ${r.doc.steps})`);
  assert(
    typeof r.doc.summary === "string" && (r.doc.summary as string).includes("handed-back"),
    "document carries the summary",
  );
  assert(r.doc.prUrl === undefined, "no publish step means no prUrl");
  assert(r.mode?.headless === true, "the verb asks for the headless mode on every run");
  assert(r.lines.length >= 1, `at least one NDJSON line (${r.lines.length})`);
  assert(
    r.lines.some((l) => l.kind === "log" && String(l.message).includes("work-lean: #7 starting")),
    "a starting progress line was emitted",
  );
  assert(
    r.lines.some((l) => l.kind === "log" && String(l.message).includes("handed-back (exit 10)")),
    "the final progress line carries the summary",
  );
}

// ── (b) the engine's own codes pass through.
for (const [code, state_] of [
  [0, "landed"],
  [11, "not-ready"],
] as const) {
  const r = await verbRun(["7"], async () => ({
    summary: `work-lean #7: ${state_} (exit ${code})`,
    result: fakeRun({ code, state: state_ as never }),
  }));
  assert(r.code === code, `state ${state_} exits ${code} (got ${r.code})`);
  assert(r.doc.exitCode === code, `document's exitCode is ${code}`);
  assert(r.doc.state === state_, `document's state is ${state_}`);
}

// ── (c) bad argv: no issue, a non-numeric issue, an extra flag, two issues.
for (const argv of [[], ["abc"], ["--bogus"], ["7", "8"], ["7", "--force"]]) {
  const r = await verbRun(argv, async () => ({
    summary: "should not run",
    result: fakeRun({ code: 0, state: "landed" }),
  }));
  assert(r.code === 40, `argv ${JSON.stringify(argv)} exits 40 (got ${r.code})`);
  assert(
    (r.doc.error as { code?: string })?.code === "bad-arguments",
    `argv ${JSON.stringify(argv)}: error.code bad-arguments`,
  );
  assert(!r.ran, `argv ${JSON.stringify(argv)}: the engine never ran`);
}
{
  const r = await verbRun(["0"], async () => ({
    summary: "s",
    result: fakeRun({ code: 0, state: "landed" }),
  }));
  assert(r.code === 40, `issue 0 is refused (got ${r.code})`);
}
{
  // --json is accepted and changes nothing.
  const r = await verbRun(["7", "--json"], async () => ({
    summary: "work-lean #7: landed (exit 0)",
    result: fakeRun({ code: 0, state: "landed" }),
  }));
  assert(r.code === 0 && r.doc.state === "landed", "--json is accepted");
}

// ── (d) the newest publish step's URL is reported.
{
  const r = await verbRun(["7"], async () => ({
    summary: "work-lean #7: handed-back (exit 10)",
    result: fakeRun({
      code: 10,
      state: "handed-back",
      steps: [
        step("publish", { kind: "ok", prUrl: "https://example.test/pull/1" }),
        step("ci", { kind: "red" }),
        step("publish", { kind: "ok", prUrl: "https://example.test/pull/2" }),
      ],
    }),
  }));
  assert(
    r.doc.prUrl === "https://example.test/pull/2",
    `doc.prUrl is the newest publish URL (got ${r.doc.prUrl})`,
  );
}
{
  // The newest DECIDED publish is the answer, and the walk never reaches past
  // it: a publish that decided without a URL says this run has no PR, and
  // reading one off an older publish would hand the host a replaced PR's
  // address. Same rule as `newestDecided`, which is what the verb calls.
  const r = await verbRun(["7"], async () => ({
    summary: "work-lean #7: handed-back (exit 10)",
    result: fakeRun({
      code: 10,
      state: "handed-back",
      steps: [
        step("publish", { kind: "ok", prUrl: "https://example.test/pull/1" }),
        step("publish", { kind: "ok" }),
      ],
    }),
  }));
  assert(r.doc.prUrl === undefined, `a newer URL-less publish wins (got ${r.doc.prUrl})`);
}
{
  // The URL is re-checked with the load-time rule `handback` applies, not
  // trusted: the loader is not the only thing that hands a `Step[]` over, and a
  // value that breaks the shape is a line of markdown, not a link.
  for (const [label, prUrl] of [
    ["not https", "http://example.test/pull/1"],
    ["whitespace", "https://example.test/pull 1"],
    ["not a string", 42],
    ["empty", ""],
    ["too long", `https://example.test/${"x".repeat(600)}`],
  ] as const) {
    const r = await verbRun(["7"], async () => ({
      summary: "s",
      result: fakeRun({
        code: 0,
        state: "landed",
        steps: [step("publish", { kind: "ok", prUrl: prUrl as never })],
      }),
    }));
    assert(r.code === 0, `a malformed prUrl (${label}) is still a green run (got ${r.code})`);
    assert(
      r.doc.prUrl === undefined,
      `a malformed prUrl (${label}) is not printed as a link (got ${String(r.doc.prUrl).slice(0, 40)})`,
    );
  }
}

// ── (e) a malformed outcome is a crash, never a rejection. Everything from the
// call to the document — the shape checks, the clip, the URL read, the step
// count — sits in ONE guarded region, so each shape below still prints exactly
// one document at exit 30 with error.code "crash". The first four are fields
// `wellFormed` judges BEFORE anything reads them; the last two are what the shape
// check lets through and the print path then has to survive.
for (const [label, make] of [
  [
    "summary undefined",
    () => ({ summary: undefined, result: fakeRun({ code: 0, state: "landed" }) }),
  ],
  ["summary null", () => ({ summary: null, result: fakeRun({ code: 0, state: "landed" }) })],
  ["outcome undefined", () => undefined],
  ["result missing", () => ({ summary: "s" })],
  ["run missing", () => ({ summary: "s", result: { code: 0, state: "landed" } })],
  ["steps missing", () => ({ summary: "s", result: { code: 0, state: "landed", run: {} } })],
  ["code missing", () => ({ summary: "s", result: { state: "landed", run: { steps: [] } } })],
  ["state missing", () => ({ summary: "s", result: { code: 0, run: { steps: [] } } })],
  // The three-code table in `lean/machine.ts` is the state→code contract; a run
  // reporting any other number for a terminal state is a malformed outcome, not
  // a document that tells the host to exit 99 for work that landed.
  ["code 99 / landed", () => ({ summary: "s", result: fakeRun({ code: 99, state: "landed" }) })],
  ["code 11 / landed", () => ({ summary: "s", result: fakeRun({ code: 11, state: "landed" }) })],
  [
    "code 0 / not-ready",
    () => ({ summary: "s", result: fakeRun({ code: 0, state: "not-ready" }) }),
  ],
  [
    "state not on the table",
    () => ({ summary: "s", result: { code: 0, state: "drifting", run: { steps: [] } } }),
  ],
  ["result a string", () => ({ summary: "s", result: "landed" })],
  ["result an array", () => ({ summary: "s", result: [{ code: 0, state: "landed" }] })],
] as const) {
  const r = await verbRun(["7"], async () => make() as never);
  assert(
    r.violations.length === 0,
    `malformed (${label}): one document (${r.violations.join("; ")})`,
  );
  assert(r.code === 30, `malformed (${label}) exits 30 (got ${r.code})`);
  assert(
    (r.doc.error as { code?: string })?.code === "crash",
    `malformed (${label}): error.code crash`,
  );
}

// ── (f) any other throw is a crash, and the verb never lets one escape.
{
  const r = await verbThrowing(["7"], new Error("git exploded"));
  assert(r.violations.length === 0, `crash: output contract (${r.violations.join("; ")})`);
  assert(r.code === 30, `a throwing run exits 30 (got ${r.code})`);
  assert((r.doc.error as { code?: string })?.code === "crash", "crash: error.code");
  assert(
    String((r.doc.error as { message?: string })?.message).includes("git exploded"),
    "crash: the message is kept",
  );
  assert(r.doc.state === undefined, "a crash reports no state");
  // A non-Error throw must not escape as a rejection either.
  const thrown = await verbThrowing(["7"], "string thrown");
  assert(thrown.code === 30, `a non-Error throw still exits 30 (got ${thrown.code})`);
  assert(
    String((thrown.doc.error as { message?: string })?.message).includes("string thrown"),
    "a non-Error throw still reports its text",
  );
}

// ── (g) the crash is DIAGNOSABLE: the verb traces the error's name and stack.
// The harness captures stdout and leaves stderr alone, so these run in a real
// child — what the runner really writes to stderr is what a host reads when a
// run dies (headless stderr is NDJSON-only; see test-headless-stderr-ndjson.ts).
{
  const probe = await spawnCrash();
  const traced = probe.split("\n").filter((l) => l.startsWith("[pi-rukas] WARN"));
  assert(
    traced.some((l) => l.includes("work-lean: #7 crashed") && l.includes("git exploded")),
    `a crash traces the error name (got ${JSON.stringify(traced)})`,
  );
  assert(
    traced.some((l) => l.includes("at ")),
    "a crash traces the stack, so the host can diagnose what threw",
  );
  assert(
    traced.every((l) => l.length <= TRACE_MAX + 200),
    `the traced line is bounded by TRACE_MAX, so one crash cannot flood the runner's stderr (longest ${Math.max(0, ...traced.map((l) => l.length))})`,
  );
}

// ── (g2) the bound is REAL: a 200 KB stack still gives one line whose TRACE
// part is no longer than TRACE_MAX. The (g) case above has a two-frame stack, so
// it passes whether or not the verb cut anything — this is the case that would
// fail if the `slice(0, TRACE_MAX)` after the escape were removed, or if the
// escape ran after the cut and doubled a stack of `\n`s past the cap.
{
  const probe = await spawnHugeCrash();
  const traced = probe.split("\n").filter((l) => l.startsWith("[pi-rukas] WARN"));
  assert(traced.length === 1, `a huge stack is traced as ONE line (got ${traced.length})`);
  assert(
    traced.some((l) => l.includes("frameMark")),
    "the truncated trace still carries real frames, so a bound that printed nothing would not pass",
  );
  // The probe throws `new Error("huge")`, whose name is the default "Error".
  const bodies = traced.map((l) => traceBody(l, "Error"));
  assert(
    bodies.every((b) => b.length <= TRACE_MAX),
    `the trace part is no longer than TRACE_MAX=${TRACE_MAX} whatever the stack's length (longest ${Math.max(0, ...bodies.map((b) => b.length))})`,
  );
}

// ── (h) a host whose chat channel throws still gets exactly one document.
// The opening send sat BEFORE the guarded region, so a host with a closed stream
// used to get a rejected promise instead of an answer; both sends now go through
// the verb's own guarded `say`. The run itself is normal in one case and throws
// in the other — the document's code is the RUN's answer either way, never the
// channel's.
for (const [label, crash, expected] of [
  ["a successful run", false, 0],
  ["a crashing run", true, 30],
] as const) {
  // EVERY send throws: the opening one, the summary one and the failure line. A
  // guard on only some of them shows up as zero documents or two.
  const r = await verbThrowingHost(crash);
  assert(r.code === expected, `throwing host, ${label}: exit ${expected} (got ${r.code})`);
  assert(
    r.docs.length === 1,
    `throwing host, ${label}: exactly one document on stdout (got ${r.docs.length})`,
  );
  const doc = JSON.parse(r.docs[0] ?? "{}") as Record<string, unknown>;
  assert(doc.subcommand === "work-lean", `throwing host, ${label}: the document is the verb's own`);
  assert(
    doc.exitCode === expected,
    `throwing host, ${label}: the document's exitCode is the run's (${String(doc.exitCode)})`,
  );
  if (crash) {
    assert(
      (doc.error as { code?: string })?.code === "crash",
      "throwing host, crash: error.code survives a broken channel",
    );
  } else {
    assert(doc.state === "landed", "throwing host, success: the state survives a broken channel");
  }
}
{
  // And the opening send is the one that used to escape: with a host that throws
  // only on the FIRST message, the run still completes and the document lands.
  const r = await verbThrowingHost(false, (_text, n) => {
    if (n === 0) throw new Error("closed at start");
  });
  assert(r.code === 0, `a host that throws on the opening send still exits 0 (got ${r.code})`);
  assert(
    r.docs.length === 1,
    `opening-send failure still prints one document (got ${r.docs.length})`,
  );
}

process.exit(state.exit);
