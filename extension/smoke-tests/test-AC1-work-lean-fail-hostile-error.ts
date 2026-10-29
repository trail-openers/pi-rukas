#!/usr/bin/env bun
/**
 * #1909 AC1 — a thrown Error whose `message`, `name` or `stack` ACCESSOR throws
 * still gives the host exit 30, exactly one document, and a non-empty
 * `error.message`.
 *
 * `fail()` in `headless/work-lean.ts` is the single shape both the refusal and
 * the crash answer take, and it touches three accessors on the Error it was
 * handed: `err.message` for the document, then `err.stack` and `err.name` for
 * the trace. Each read runs OUTSIDE the verb's own try — the try is what called
 * `fail` — so an accessor that throws escapes the guarded region entirely:
 * `runSubcommand` rejects instead of printing, stdout is EMPTY, and the host
 * reads no document at all. That is the exact contract `run()` and
 * `withResultGuarantee` promise for every other path the runner terminates on.
 *
 * The error is handed over as a resolved value from the injected run and thrown
 * inside it, so nothing in this file throws at the point of construction.
 */

import { runSubcommand } from "../src/headless/cli.ts";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";
import { makeAssert } from "./headless-verb-harness.ts";

const { assert, state } = makeAssert();

const REPO = "/tmp/pi-rukas-work-lean-ac1";

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

/** An Error whose one named accessor throws when read. */
function hostile(accessor: "message" | "name" | "stack"): Error {
  const e = new Error("boom");
  Object.defineProperty(e, accessor, {
    configurable: true,
    get(): never {
      throw new Error(`hostile ${accessor}`);
    },
  });
  return e;
}

for (const accessor of ["message", "name", "stack"] as const) {
  const r = await drive(hostile(accessor));
  assert(
    r.threw === "",
    `AC1 ${accessor} accessor throws: the verb does not escape its guard (rejected with ${r.threw || "nothing"})`,
  );
  assert(r.code === 30, `AC1 ${accessor} accessor throws: exit 30 (got ${String(r.code)})`);
  assert(
    r.docs.length === 1,
    `AC1 ${accessor} accessor throws: exactly one document on stdout (got ${r.docs.length})`,
  );
  const doc = JSON.parse(r.docs[0] ?? "{}") as Record<string, unknown>;
  const message = (doc.error as { message?: unknown } | undefined)?.message;
  assert(
    typeof message === "string" && message.trim() !== "",
    `AC1 ${accessor} accessor throws: error.message is non-empty (got ${JSON.stringify(message)})`,
  );
}

if (state.exit !== 0) {
  console.error("FAIL test-AC1-work-lean-fail-hostile-error.ts");
}
process.exit(state.exit);
