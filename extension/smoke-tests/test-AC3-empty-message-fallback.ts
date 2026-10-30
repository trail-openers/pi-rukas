#!/usr/bin/env bun
/**
 * #1909 AC3 — a crash whose Error says NOTHING still has to say something.
 *
 * `fail()` builds the document's `error.message` from `err.message` alone (for
 * an Error) and clips/fences that one value. Nothing falls back when it is
 * blank: an Error whose `message` formats to whitespace keeps its whole stack
 * — which the verb already reads for the trace — out of the document the host
 * parses, and an Error whose message AND stack both format blank publishes
 * `error.message: ""`, i.e. a crash the host cannot report at all. There is no
 * literal the verb reaches for when both are empty.
 *
 * So the two fallbacks the criterion names are driven as a host drives them —
 * through `runSubcommand` — and judged on the document's `error.message`:
 *
 *   - message blank, stack present → the stack reaches the document;
 *   - message AND stack blank      → a literal stands in.
 *
 * A message a hostile getter REPLACES with a throw is AC1's case, not this
 * one; here the Error is readable, it just says nothing. Offline.
 */
import { runSubcommand } from "../src/headless/cli.ts";
import { EXIT } from "../src/headless/exit-code.ts";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";

const FILE = "test-AC3-empty-message-fallback.ts";
const REPO = "/tmp/pi-rukas-work-lean-hostile";
/** The stack a silent Error still carries, and which the host never sees. */
const STACK = "Error: silent at build\n    at runLean (/x/engine.ts:7:3)";

/** A line a failing run leaves in the output that names this file. */
function note(msg: string): void {
  console.error(`FAIL ${FILE}: ${msg}`);
}

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

/** What the host sees: the code `runSubcommand` returns, and what it printed. */
async function drive(err: unknown): Promise<{ code: number; docs: string[] }> {
  const chunks: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code = -99;
  try {
    code = await runSubcommand("work-lean", ["7"], REPO, () => {}, (argv, ctx) =>
      runWorkLeanVerb(argv, ctx, async () => {
        throw err;
      }),
    );
  } catch (escaped) {
    code = -1;
    note(`runSubcommand rejected instead of returning a code (${safe(escaped)})`);
  } finally {
    process.stdout.write = write;
  }
  return { code, docs: chunks.join("").split("\n").filter((l) => l.trim() !== "") };
}

let failed = false;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`✓ ${msg}`);
  else {
    note(msg);
    failed = true;
  }
};

/** The one document's `error`, or an empty view of one. */
async function crashError(err: unknown) {
  const { code, docs } = await drive(err);
  const doc: Record<string, unknown> =
    docs.length === 1 ? (JSON.parse(docs[0] ?? "{}") as Record<string, unknown>) : {};
  const error = doc.error as { code?: string; message?: string } | undefined;
  return { code, docs, error: error ?? {} };
}

// ── (a) a blank message falls back to the stack the run already has.
{
  const { code, docs, error } = await crashError(silent(STACK));
  check(code === EXIT.crash, `a silent Error still exits 30 (got ${code})`);
  check(docs.length === 1, `exactly one document on stdout (got ${docs.length})`);
  check(
    typeof error.message === "string" && error.message.includes("runLean"),
    `a blank message falls back to the stack — the document carries it (got ${safe(
      error.message,
    )})`,
  );
}

// ── (b) both blank: a literal stands in, so the host always reads a reason.
{
  const { code, docs, error } = await crashError(silent(" \n\t "));
  check(code === EXIT.crash, `an Error with nothing to say at all exits 30 (got ${code})`);
  check(docs.length === 1, `exactly one document on stdout (got ${docs.length})`);
  check(
    typeof error.message === "string" && error.message.trim() !== "",
    `message and stack both blank: a literal "unknown error" stands in (got ${safe(
      error.message,
    )})`,
  );
  check(
    typeof error.message === "string" && error.message.includes("unknown error"),
    `the stand-in says "unknown error" (got ${safe(error.message)})`,
  );
}

if (failed) {
  console.log(`FAIL ${FILE}: work-lean's fail() publishes an empty error.message`);
  process.exit(1);
}
process.exit(0);
