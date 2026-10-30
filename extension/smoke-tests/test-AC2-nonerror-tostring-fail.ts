#!/usr/bin/env bun
/**
 * #1909 AC2 — a thrown value that is not an Error must not cost the host its
 * document either.
 *
 * For a non-Error `fail()` fell through to `String(err)`, which reaches for
 * `Symbol.toPrimitive`, then `valueOf`, then `toString` — and this verb called
 * it unguarded, both in the document's message and in the `say(...)` template
 * literal beside it. A thrown object whose `toString` throws therefore took the
 * whole verb down exactly like AC1's hostile Error does: `runSubcommand`
 * rejected and the host read an empty stdout, where the contract promises
 * exactly one document at exit 30.
 *
 * Driven through `runSubcommand` by the shared `driveThrow` fixture, so the
 * output contract (`violations`) is judged by the harness rather than re-derived
 * here. Offline.
 */
import { EXIT } from "../src/headless/exit-code.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { driveThrow } from "./lib/work-lean-verb-fixture.ts";

const { assert, state } = makeAssert();

/** A label for a value whose own toString may throw. */
function safe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
}

/** A non-Error whose every route from value to text throws. */
function hostile(): unknown {
  const boom = (): never => {
    throw new Error("hostile toString");
  };
  const thrown = { marker: "WEIRD", toString: boom, valueOf: boom };
  // `Symbol.toPrimitive` is what `String()` consults first, so leaving it out
  // would test `toString` alone rather than the value's route to text.
  return Object.defineProperty(thrown, Symbol.toPrimitive, { value: boom });
}

/** The same value built in the probe child, where it is real source, not a value. */
const HOSTILE_SOURCE =
  'const boom = () => { throw new Error("hostile toString"); }; ' +
  'const thrown = { marker: "WEIRD", toString: boom, valueOf: boom }; ' +
  "Object.defineProperty(thrown, Symbol.toPrimitive, { value: boom }); " +
  "const run = async () => { throw thrown; };";

const r = await driveThrow(hostile(), HOSTILE_SOURCE);

assert(
  r.code === EXIT.crash,
  `a non-Error whose toString throws exits 30 (got ${r.code})`,
);
assert(r.docs.length === 1, `the host gets exactly one document (got ${r.docs.length})`);
assert(
  r.violations.length === 0,
  `the one document and the NDJSON stderr both hold their shape (got ${JSON.stringify(r.violations)})`,
);
assert(r.errorCode === "crash", `error.code is "crash" (got ${safe(r.errorCode)})`);
assert(
  typeof r.message === "string" && r.message.trim() !== "",
  `error.message is a non-empty string for a value that cannot stringify (got ${safe(r.message)})`,
);
assert(
  r.probeCode === EXIT.crash,
  `the same throw in a real child also exits 30 (got ${r.probeCode})`,
);

if (state.exit !== 0) {
  console.log(
    "FAIL test-AC2-nonerror-tostring-fail.ts: work-lean's fail() cannot stringify a hostile non-Error",
  );
  process.exit(1);
}
process.exit(0);
