#!/usr/bin/env bun
/**
 * #1909 AC1 — the headless `work-lean` verb's `fail()` must survive an Error
 * whose OWN ACCESSORS throw.
 *
 * `fail()` read `err.message` in its first statement and `err.name` / `err.stack`
 * in its trace, with no guard of its own, and the verb's `catch` has no second
 * net beneath it. One hostile getter — a wrapped Error from a dependency, a
 * proxy, anything whose `message` is a computed property that blows up — escaped
 * the verb and the host got NO document at all: `runSubcommand` rejects, nothing
 * prints, and the code the runner dies with is bun's, not the contract's 30.
 *
 * So the criterion is driven the way a host drives it — through
 * `runSubcommand`, via the shared `driveThrow` fixture — and judged on what the
 * host actually receives, including the output contract the harness enforces
 * (`violations` empty: one document on stdout, NDJSON v1 on stderr).
 *
 * Two cases, because one guard that reads the fields together is the bug this
 * AC would otherwise miss:
 *
 *   (a) every accessor throws  → 30, one document, a non-empty reason;
 *   (b) ONLY `message` throws  → the readable `name` still labels the trace, so
 *       a partially hostile Error does not lose the half of itself that works.
 *
 * Offline: the engine is injected.
 */
import { EXIT } from "../src/headless/exit-code.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { driveThrow, warnLines } from "./lib/work-lean-verb-fixture.ts";

const { assert, state } = makeAssert();

/** A label for a value whose own toString may throw. */
function safe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
}

/** The probe source for an Error whose given keys throw when read. */
function hostileSource(keys: string[]): string {
  const booms = keys
    .map((k) => `Object.defineProperty(e, ${JSON.stringify(k)}, { get: () => { throw new Error("hostile accessor"); }, configurable: true });`)
    .join(" ");
  return `const run = async () => { const e = new Error("kaboom"); e.name = "WrappedGitError"; ${booms} throw e; };`;
}

/** An Error whose given keys throw when read (built here, for the in-process drive). */
function hostile(keys: string[]): Error {
  const err = new Error("kaboom");
  err.name = "WrappedGitError";
  const boom = (): never => {
    throw new Error("hostile accessor");
  };
  for (const key of keys) {
    Object.defineProperty(err, key, { get: boom, configurable: true });
  }
  return err;
}

// ── (a) every Error accessor throws.
{
  const keys = ["message", "name", "stack"];
  const r = await driveThrow(hostile(keys), hostileSource(keys));
  assert(
    r.code === EXIT.crash,
    `a crash whose Error's own getters throw exits 30 (got ${r.code})`,
  );
  assert(
    r.docs.length === 1,
    `the host gets exactly one document (got ${r.docs.length})`,
  );
  assert(
    r.violations.length === 0,
    `the one document and the NDJSON stderr both hold their shape (got ${JSON.stringify(r.violations)})`,
  );
  assert(r.errorCode === "crash", `error.code is "crash" (got ${safe(r.errorCode)})`);
  assert(
    typeof r.message === "string" && r.message.trim() !== "",
    `error.message is a non-empty string whatever the Error refuses to say (got ${safe(r.message)})`,
  );
  // The probe child must die with the contract's code too: an escaped throw
  // would surface as bun's code there even if the in-process drive looked right.
  assert(
    r.probeCode === EXIT.crash,
    `the same throw in a real child also exits 30 (got ${r.probeCode})`,
  );
}

// ── (b) only `message` throws: the readable name still labels the trace.
{
  const keys = ["message"];
  const r = await driveThrow(hostile(keys), hostileSource(keys));
  assert(
    r.code === EXIT.crash,
    `an Error whose only hostile field is message still exits 30 (got ${r.code})`,
  );
  assert(r.docs.length === 1, `exactly one document on stdout (got ${r.docs.length})`);
  assert(
    r.violations.length === 0,
    `the output contract holds for a partially hostile Error (got ${JSON.stringify(r.violations)})`,
  );
  const traced = warnLines(r.trace);
  assert(
    traced.some((l) => l.includes("WrappedGitError")),
    `the readable name still labels the crash trace (got ${JSON.stringify(traced)})`,
  );
}

if (state.exit !== 0) {
  console.log("FAIL test-AC1-hostile-error-fail.ts: work-lean's fail() cannot read a hostile Error");
  process.exit(1);
}
process.exit(0);
