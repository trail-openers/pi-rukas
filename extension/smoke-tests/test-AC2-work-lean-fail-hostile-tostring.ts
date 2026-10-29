#!/usr/bin/env bun
/**
 * #1909 AC2 — a thrown NON-Error whose `toString()` throws still gives the host
 * exit 30 and exactly one document.
 *
 * `fail()` formats a non-Error with `String(err)`, which invokes `toString()`.
 * That read sits in the same spot as the Error path — outside the verb's own
 * try, because the try is what called `fail` — so a hostile `toString` rejects
 * `runSubcommand` and stdout stays EMPTY. The host gets no document and no code.
 */

import { runSubcommand } from "../src/headless/cli.ts";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";
import { makeAssert } from "./headless-verb-harness.ts";

const { assert, state } = makeAssert();

const REPO = "/tmp/pi-rukas-work-lean-ac2";

/** Drive the REAL entry point with a run that throws `err`. */
async function drive(
  err: unknown,
): Promise<{ code: number | null; docs: string[]; threw: string }> {
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code: number | null = null;
  let threw = "";
  try {
    code = await runSubcommand(
      "work-lean",
      ["7"],
      REPO,
      () => {},
      (argv, ctx) =>
        runWorkLeanVerb(argv, ctx, async () => {
          throw err;
        }),
    );
  } catch (err) {
    threw = String(err);
  } finally {
    process.stdout.write = write;
  }
  return {
    code,
    docs: out
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== ""),
    threw,
  };
}

/** A non-Error whose only stringification path throws. */
function hostileToString(): unknown {
  return {
    toString(): never {
      throw new Error("hostile toString");
    },
  };
}

{
  const r = await drive(hostileToString());
  assert(
    r.threw === "",
    `AC2 non-Error with a throwing toString: the verb does not escape its guard (rejected with ${r.threw || "nothing"})`,
  );
  assert(r.code === 30, `AC2 non-Error with a throwing toString: exit 30 (got ${String(r.code)})`);
  assert(
    r.docs.length === 1,
    `AC2 non-Error with a throwing toString: exactly one document on stdout (got ${r.docs.length})`,
  );
}

if (state.exit !== 0) {
  console.error("FAIL test-AC2-work-lean-fail-hostile-tostring.ts");
}
process.exit(state.exit);
