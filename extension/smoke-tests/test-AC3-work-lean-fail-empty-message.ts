#!/usr/bin/env bun
/**
 * #1909 AC3 — an empty or whitespace-only crash message falls back to the
 * stack, and to the literal "unknown error" when BOTH message and stack format
 * to nothing.
 *
 * `fail()` builds `error.message` from `err.message` alone (or `String(err)` for
 * a non-Error). A crash whose message is `""`, `"   "` or `"\n\t "` therefore
 * prints `error.message: ""` — the document says the run crashed and names
 * nothing — even though the Error carries a perfectly good stack. And when
 * neither field has content, the document still carries the empty string rather
 * than the literal fallback a host can print.
 */

import { runSubcommand } from "../src/headless/cli.ts";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";
import { makeAssert } from "./headless-verb-harness.ts";

const { assert, state } = makeAssert();

const REPO = "/tmp/pi-rukas-work-lean-ac3";

/** The stack a real throw carries, put on an Error whose message is `msg`. */
function withStack(msg: string): Error {
  const e = new Error(msg);
  e.stack = "Error: <message is empty>\n    at runWorkLeanVerb (/x/work-lean.ts:1:1)";
  return e;
}

/** Drive the REAL entry point with a run that throws `err`. */
async function crashMessage(err: unknown): Promise<string | undefined> {
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runSubcommand(
      "work-lean",
      ["7"],
      REPO,
      () => {},
      (argv, ctx) =>
        runWorkLeanVerb(argv, ctx, async () => {
          throw err;
        }),
    );
  } catch {
    // AC1/AC2 own the escape; here we only read whatever document landed.
  } finally {
    process.stdout.write = write;
  }
  const docs = out
    .join("")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const doc = JSON.parse(docs[0] ?? "{}") as Record<string, unknown>;
  return (doc.error as { message?: unknown } | undefined)?.message as string | undefined;
}

for (const [label, msg] of [
  ["empty", ""],
  ["spaces", "   "],
  ["newlines and tabs", "\n\t "],
] as const) {
  const printed = await crashMessage(withStack(msg));
  assert(
    typeof printed === "string" && printed.includes("runWorkLeanVerb"),
    `AC3 ${label} message falls back to the stack (got ${JSON.stringify(printed)})`,
  );
}

// Both fields empty: the document still has to carry something a host can print.
{
  const both = new Error("");
  both.stack = "";
  const printed = await crashMessage(both);
  assert(
    printed === "unknown error",
    `AC3 empty message and empty stack fall back to "unknown error" (got ${JSON.stringify(printed)})`,
  );

  const whitespace = new Error(" \n ");
  whitespace.stack = "\t  \n";
  const printedWs = await crashMessage(whitespace);
  assert(
    printedWs === "unknown error",
    `AC3 whitespace-only message and stack fall back to "unknown error" (got ${JSON.stringify(printedWs)})`,
  );
}

if (state.exit !== 0) {
  console.error("FAIL test-AC3-work-lean-fail-empty-message.ts");
}
process.exit(state.exit);
