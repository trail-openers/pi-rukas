#!/usr/bin/env bun
/**
 * #1909 AC1 — the headless `work-lean` verb's `fail()` must survive an Error
 * whose OWN ACCESSORS throw.
 *
 * `fail()` reads `err.message` in its first statement and `err.name` /
 * `err.stack` in its trace, with no guard of its own, and the verb's `catch`
 * has no second net beneath it. One hostile getter — a wrapped Error from a
 * dependency, a proxy, anything whose `message` is a computed property that
 * blows up — escapes the verb and the host gets NO document at all:
 * `runSubcommand` rejects, nothing prints, and the code the runner dies with
 * is bun's, not the contract's 30.
 *
 * So the criterion is driven the way a host drives it — through
 * `runSubcommand`, the CLI function that prints the one document — and judged
 * on what the host actually receives. Offline: the engine is injected.
 */
import { runSubcommand } from "../src/headless/cli.ts";
import { EXIT } from "../src/headless/exit-code.ts";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";

const FILE = "test-AC1-hostile-error-fail.ts";
const REPO = "/tmp/pi-rukas-work-lean-hostile";

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

/** An Error whose message / name / stack getters all throw when read. */
function hostile(): Error {
  const err = new Error("kaboom");
  const boom = (): never => {
    throw new Error("hostile accessor");
  };
  for (const key of ["message", "name", "stack"]) {
    Object.defineProperty(err, key, { get: boom, configurable: true });
  }
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
    // The verb let its own throw out. Recorded, not swallowed: the assertions
    // below are what turn that into a failure naming this file.
    code = -1;
    note(`runSubcommand rejected instead of returning a code (${safe(escaped)})`);
  } finally {
    process.stdout.write = write;
  }
  return { code, docs: chunks.join("").split("\n").filter((l) => l.trim() !== "") };
}

const { code, docs } = await drive(hostile());
const doc: Record<string, unknown> =
  docs.length === 1 ? (JSON.parse(docs[0] ?? "{}") as Record<string, unknown>) : {};
const error = doc.error as { code?: string; message?: string } | undefined;

let failed = false;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`✓ ${msg}`);
  else {
    note(msg);
    failed = true;
  }
};

check(
  code === EXIT.crash,
  `a crash whose Error's own getters throw exits 30 (got ${code}${
    code === -1 ? " — the verb's throw escaped, so no code was ever returned" : ""
  })`,
);
check(
  docs.length === 1,
  `the host gets exactly one document (got ${docs.length}${
    code === -1 ? "; the throw escaped, so stdout held nothing" : ""
  })`,
);
check(error?.code === "crash", `error.code is "crash" (got ${safe(error?.code)})`);
check(
  typeof error?.message === "string" && error.message.trim() !== "",
  `error.message is a non-empty string whatever the Error refuses to say (got ${safe(
    error?.message,
  )})`,
);

if (failed) {
  console.log(`FAIL ${FILE}: work-lean's fail() cannot read a hostile Error`);
  process.exit(1);
}
process.exit(0);
