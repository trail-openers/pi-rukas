#!/usr/bin/env bun
/**
 * #1909 AC2 — a thrown value that is not an Error must not cost the host its
 * document either.
 *
 * For a non-Error `fail()` falls through to `String(err)`, which reaches for
 * `Symbol.toPrimitive`, then `valueOf`, then `toString` — and this verb calls
 * it unguarded, both in the document's message and in the `say(...)` template
 * literal beside it. A thrown object whose `toString` throws therefore takes
 * the whole verb down exactly like AC1's hostile Error does: `runSubcommand`
 * rejects and the host reads an empty stdout, where the contract promises
 * exactly one document at exit 30.
 *
 * Driven through `runSubcommand`, the way a host drives it. Offline.
 */
import { runSubcommand } from "../src/headless/cli.ts";
import { EXIT } from "../src/headless/exit-code.ts";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";

const FILE = "test-AC2-nonerror-tostring-fail.ts";
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
  `a non-Error whose toString throws exits 30 (got ${code}${
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
  `error.message is a non-empty string for a value that cannot stringify (got ${safe(
    error?.message,
  )})`,
);

if (failed) {
  console.log(`FAIL ${FILE}: work-lean's fail() cannot stringify a hostile non-Error`);
  process.exit(1);
}
process.exit(0);
