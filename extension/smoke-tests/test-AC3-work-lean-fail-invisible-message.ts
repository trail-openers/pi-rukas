#!/usr/bin/env bun
/**
 * #1909 AC3 — an empty or whitespace-only crash message falls back to the
 * stack, and to the literal "unknown error" when both format to empty.
 *
 * The frozen AC3 file exercises ASCII whitespace only (`""`, `"   "`,
 * `"\n\t "`). Those three pass, because `crashMessage()` trims with
 * `String#trim()` and `trim()` strips exactly the set JS calls whitespace.
 *
 * That set is narrower than "whitespace a host cannot print". Four code points
 * are invisible on screen, are NOT `\s` and are NOT `\p{Cc}` (so the
 * `oneLine` control-character sweep in `lean/text-fence.ts` leaves them
 * standing), and yet render as nothing at all:
 *
 *   U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER,
 *   U+180E MONGOLIAN VOWEL SEPARATOR, U+204F REVERSED SEMICOLON.
 *
 * A crash whose message is one of those reads back as a NON-empty string, so
 * `readable(err, "message")?.trim() ||` never falls through: the document
 * prints `error.message: "​"` — a value the host cannot tell from a blank
 * line — while the Error carries a perfectly good stack naming the crash site.
 * When message AND stack are both made of those characters the document does
 * not reach `"unknown error"` either.
 *
 * The point is the contract AC3 states, not the choice of character: a message
 * that carries no printable content is an empty message, and the fallbacks are
 * what the criterion exists to guarantee.
 */

import { runSubcommand } from "../src/headless/cli.ts";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";

const REPO = "/tmp/pi-rukas-work-lean-ac3-invisible";

/** Invisible, non-`\s`, non-`\p{Cc}`: invisible to a reader, kept by `trim()`. */
const INVISIBLE = ["\u200b", "\u2060", "\u180e", "\u204f"];

/** A stack that names the crash site, so a fallback is recognisable. */
const STACK = "Error: STACKMARKER runWorkLeanVerb (/x/work-lean.ts:1:1)";

/** Drive the REAL entry point with a run that throws `err`. */
async function drive(
  err: unknown,
): Promise<{ code: number | null; docs: number; threw: string; message?: string }> {
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code: number | null = null;
  let threw = "";
  try {
    code = await runSubcommand("work-lean", ["7"], REPO, () => {}, (argv, ctx) =>
      runWorkLeanVerb(argv, ctx, async () => {
        throw err;
      }),
    );
  } catch (err) {
    threw = String(err);
  } finally {
    process.stdout.write = write;
  }
  const docs = out
    .join("")
    .split("\n")
    .filter((l) => l.trim() !== "");
  let message: string | undefined;
  try {
    message = (JSON.parse(docs[0] ?? "{}") as { error?: { message?: string } }).error?.message;
  } catch {
    message = undefined;
  }
  return { code, docs: docs.length, threw, message };
}

/** An Error whose message is `msg` and whose stack names the crash site. */
function withStack(msg: string, stack = STACK): Error {
  const e = new Error(msg);
  e.stack = stack;
  return e;
}

const failures: string[] = [];

/** `cond` with the observed document in the report, so a red names the gap. */
function check(label: string, r: { code: number | null; docs: number; threw: string; message?: string }, cond: boolean, want: string) {
  if (!cond) {
    failures.push(`${label}: wanted ${want}, got ${JSON.stringify({ code: r.code, docs: r.docs, threw: r.threw, message: r.message })}`);
  }
}

for (const ch of INVISIBLE) {
  const r = await drive(withStack(ch));
  // The guard contract every other path keeps: one document, exit 30, no escape.
  check(`message ${JSON.stringify(ch)}`, r, r.threw === "", "no escaped rejection");
  check(`message ${JSON.stringify(ch)}`, r, r.code === 30, "exit 30");
  check(`message ${JSON.stringify(ch)}`, r, r.docs === 1, "exactly one document");
  // AC3: an unprintable message is an empty message, so the stack answers.
  check(
    `message ${JSON.stringify(ch)}`,
    r,
    typeof r.message === "string" && r.message.includes("STACKMARKER"),
    "the stack (message carries no printable content)",
  );
}

// Both fields unprintable: the document still has to carry the literal fallback.
{
  const r = await drive(withStack("\u200b", "\u2060\u200b"));
  check("message and stack both unprintable", r, r.threw === "", "no escaped rejection");
  check("message and stack both unprintable", r, r.code === 30, "exit 30");
  check("message and stack both unprintable", r, r.docs === 1, "exactly one document");
  check("message and stack both unprintable", r, r.message === "unknown error", `"unknown error"`);
}

if (failures.length > 0) {
  console.error(
    `FAIL test-AC3-work-lean-fail-invisible-message.ts: ${failures.length} unprintable-message case(s) not handled`,
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
process.exit(0);
