#!/usr/bin/env bun
/**
 * #1909 AC3 — a crash whose Error says NOTHING still has to say something.
 *
 * `fail()` built the document's `error.message` from `err.message` alone (for
 * an Error) and clipped/fenced that one value. Nothing fell back when it was
 * blank: an Error whose `message` formatted to whitespace kept its whole stack —
 * which the verb already read for the trace — out of the document the host
 * parses, and an Error whose message AND stack both formatted blank published
 * `error.message: ""`, i.e. a crash the host cannot report at all. There was no
 * literal the verb reached for when both were empty.
 *
 * So the two fallbacks the criterion names are driven as a host drives them —
 * through `runSubcommand`, by the shared `driveThrow` fixture — and judged on
 * the document's `error.message`:
 *
 *   - message blank, stack present → the stack reaches the document, AND the
 *     stderr trace carries a stack frame (the same reason in both outputs);
 *   - message AND stack blank      → a literal stands in.
 *
 * A message a hostile getter REPLACES with a throw is AC1's case, not this
 * one; here the Error is readable, it just says nothing. Offline.
 */
import { EXIT } from "../src/headless/exit-code.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { driveThrow, warnLines } from "./lib/work-lean-verb-fixture.ts";

const { assert, state } = makeAssert();

/** The stack a silent Error still carries, and which the host never saw. */
const STACK = "Error: silent at build\n    at runLean (/x/engine.ts:7:3)";

/** A label for a value whose own toString may throw. */
function safe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
}

/** An Error whose own text is whitespace, with `stack` set to `stack`. */
function silent(stack: string): Error {
  const err = new Error("placeholder");
  Object.defineProperty(err, "message", { get: () => " \n\t ", configurable: true });
  err.stack = stack;
  return err;
}

/** The probe child's source for the same silent Error. */
function silentSource(stack: string): string {
  return `const run = async () => { const e = new Error("placeholder"); Object.defineProperty(e, "message", { get: () => " \\n\\t ", configurable: true }); e.stack = ${JSON.stringify(stack)}; throw e; };`;
}

// ── (a) a blank message falls back to the stack the run already has.
{
  const r = await driveThrow(silent(STACK), silentSource(STACK));
  assert(r.code === EXIT.crash, `a silent Error still exits 30 (got ${r.code})`);
  assert(r.docs.length === 1, `exactly one document on stdout (got ${r.docs.length})`);
  assert(
    r.violations.length === 0,
    `the one document and the NDJSON stderr both hold their shape (got ${JSON.stringify(r.violations)})`,
  );
  assert(
    typeof r.message === "string" && r.message.includes("runLean"),
    `a blank message falls back to the stack — the document carries it (got ${safe(r.message)})`,
  );
  // The trace is the other half of the same derivation: if the reason is the
  // stack, the warning the developer reads has to carry a frame, not just a
  // name. Checked on the real child's stderr, which is the only place a
  // traceWarn is visible (the harness captures stdout and leaves stderr alone).
  const traced = warnLines(r.trace);
  assert(
    traced.some((l) => l.includes("work-lean: #7 crashed") && l.includes("at runLean")),
    `a silent Error's trace carries the stack frame the document carries (got ${JSON.stringify(traced)})`,
  );
}

// ── (b) both blank: a literal stands in, so the host always reads a reason.
{
  const r = await driveThrow(silent(" \n\t "), silentSource(" \n\t "));
  assert(
    r.code === EXIT.crash,
    `an Error with nothing to say at all exits 30 (got ${r.code})`,
  );
  assert(r.docs.length === 1, `exactly one document on stdout (got ${r.docs.length})`);
  assert(
    r.violations.length === 0,
    `the output contract holds when there is nothing to say (got ${JSON.stringify(r.violations)})`,
  );
  assert(
    typeof r.message === "string" && r.message.trim() !== "",
    `message and stack both blank: a literal stands in (got ${safe(r.message)})`,
  );
  assert(
    typeof r.message === "string" && r.message.includes("unknown error"),
    `the stand-in says "unknown error" (got ${safe(r.message)})`,
  );
}

if (state.exit !== 0) {
  console.log(
    "FAIL test-AC3-empty-message-fallback.ts: work-lean's fail() publishes an empty error.message",
  );
  process.exit(1);
}
process.exit(0);
