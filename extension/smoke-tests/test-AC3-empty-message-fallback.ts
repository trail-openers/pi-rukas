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
 *   - message AND stack blank      → a literal stands in;
 *   - stack blank, message present → the trace's BODY is the message (a warning
 *     whose body came from a blank stack would be a bare label);
 *   - a `name` carrying a newline / U+2028 / CR → the trace is still exactly one
 *     physical stderr line, because `name` reaches the trace verbatim and
 *     `TRACE_MAX` bounds only the body.
 *
 * A message a hostile getter REPLACES with a throw is AC1's case, not this
 * one; here the Error is readable, it just says nothing. Cases (c) and (d) are
 * driven through the real child as well, because the trace body and its
 * single-line-ness are only observable on the fd the harness leaves alone.
 * Offline.
 */
import { EXIT } from "../src/headless/exit-code.ts";
import { NAME_MAX, TRACE_MAX } from "../src/headless/work-lean.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { driveThrow, warnLines } from "./lib/work-lean-verb-fixture.ts";

const { assert, state } = makeAssert();

/** The stack a silent Error still carries, and which the host never saw. */
const STACK = "Error: silent at build\n    at runLean (/x/engine.ts:7:3)";

/** A backslash — so the assertions below spell escapes without a doubled literal. */
const BS = String.fromCharCode(0x5c);

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

// ── (c) a BLANK stack and a real message: the trace carries the MESSAGE.
//
// `body` is `blank(stack) ? reason : stack`, so with no stack the warning has
// to repeat what the document says rather than print a bare label. A reviewer
// that gets `Error:` and nothing after it has been told nothing about the crash.
// Both directions of the fallback are therefore asserted on the real child's
// stderr: (a) proves the stack reaches the trace when the message is blank, and
// this proves the message reaches it when the stack is blank.
{
  const msg = "lock file was held by another run";
  const err = new Error(msg);
  err.stack = "   \n\t ";
  const src = `const run = async () => { const e = new Error(${JSON.stringify(msg)}); e.stack = "   \\n\\t "; throw e; };`;
  const r = await driveThrow(err, src);
  assert(
    r.code === EXIT.crash,
    `an Error with no stack still exits 30 (got ${r.code})`,
  );
  assert(r.docs.length === 1, `exactly one document on stdout (got ${r.docs.length})`);
  assert(
    r.violations.length === 0,
    `the output contract holds with no stack to trace (got ${JSON.stringify(r.violations)})`,
  );
  assert(
    typeof r.message === "string" && r.message.includes(msg),
    `a blank stack does not cost the document its message (got ${safe(r.message)})`,
  );
  const traced = warnLines(r.trace);
  assert(
    traced.some((l) => l.includes("work-lean: #7 crashed") && l.includes(msg)),
    `with a blank stack the trace carries the message as its body (got ${JSON.stringify(traced)})`,
  );
}

// ── (d) a hostile `name` cannot split the trace into two stderr lines.
//
// `name` is the one field that reaches the trace verbatim — `TRACE_MAX` bounds
// the body alone — so a name carrying a newline used to write the record's
// prefix and dump the rest of the label as a second line (which the harness's
// NDJSON check then rejects outright). CR and the Unicode separators are the
// same bug for a reader that splits on them.
{
  const nasty = "Wrapped\nError\u2028Broken\rLine";
  const err = new Error("git exploded");
  err.name = nasty;
  err.stack = "WrappedError at build\n    at runLean (/x/engine.ts:7:3)";
  const src = `const run = async () => { const e = new Error("git exploded"); e.name = ${JSON.stringify(nasty)}; e.stack = "WrappedError at build\\n    at runLean (/x/engine.ts:7:3)"; throw e; };`;
  const r = await driveThrow(err, src);
  assert(r.code === EXIT.crash, `a hostile name still exits 30 (got ${r.code})`);
  assert(
    r.violations.length === 0,
    `a name with a newline and U+2028 keeps stderr one-record-per-line (got ${JSON.stringify(r.violations)})`,
  );
  const traced = warnLines(r.trace);
  assert(
    // `name` is scrubbed and bounded by NAME_MAX on its own, so the raw label is
    // NOT in the line — these are its ESCAPES, which is the point: the newline
    // became two printable characters instead of splitting the record.
    traced.some(
      (l) =>
        l.includes("work-lean: #7 crashed") &&
        l.includes("Wrapped") &&
        l.includes(`${BS}n`) &&
        l.includes(`${BS}u2028`) &&
        l.includes("at runLean"),
    ),
    `the name's newlines are escaped into the one line it always was (got ${JSON.stringify(traced)})`,
  );
  assert(
    traced.every(
      (l) =>
        !l.includes("\r") &&
        !l.includes("\u2028") &&
        l.slice(l.indexOf("crashed — ") + "crashed — ".length).length <= TRACE_MAX + NAME_MAX + 64,
    ),
    `no raw CR or U+2028 survives in any traced line, and a hostile name cannot flood it (got ${JSON.stringify(traced)})`,
  );
}

if (state.exit !== 0) {
  console.log(
    "FAIL test-AC3-empty-message-fallback.ts: work-lean's fail() publishes an empty error.message",
  );
  process.exit(1);
}
process.exit(0);
