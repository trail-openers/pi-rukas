#!/usr/bin/env bun
/**
 * lean/specify, bytes — the freeze hashes what git COMMITTED, byte for byte.
 *
 * One case, because one line of production code carries the whole claim:
 * `committedBlob` reads `git show HEAD:<path>` with `stdoutEncoding: "latin1"`.
 * Every other blob read in this step family goes through the same option, and
 * `latin1` is the one text encoding where a byte survives the trip — `utf8`
 * replaces any invalid sequence with U+FFFD, so a test file holding a byte
 * string that is not valid UTF-8 comes back as a DIFFERENT buffer. The step then
 * freezes the hash of those substituted bytes: the file it committed is not the
 * file the record describes, and the first `assertFrozenIntact` after that throws
 * on a tree nobody touched. The failure is silent at freeze time and lands
 * several steps later, blamed on tampering.
 *
 * So this freezes a test whose committed bytes are exactly `ff fe 41 80` — a
 * UTF-16 BOM, an ASCII byte, and a byte that is not valid UTF-8 in either
 * encoding (no NUL: the boundary refuses a NUL-bearing test before the freeze
 * is ever reached — see the note on `BYTES`). It asserts three things, and the
 * middle one is the point:
 *
 *   - the step committed the four bytes the child wrote, not four characters;
 *   - `outcome.frozen[path]` is `sha256` of those four bytes;
 *   - and it is NOT the hash of what a `utf8` read would have produced.
 *
 * The last assertion is what makes reverting `latin1` to the default fail here
 * rather than quietly changing the recorded hash: without it, a reader could not
 * tell this test apart from one that merely agrees with whatever the code does.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ROOTS,
  RUNNER,
  configWith,
  git,
  makeRepo,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * `git show HEAD:<rel>` as RAW BYTES.
 *
 * `spawnSync` with `encoding: "utf8"` would decode the blob in the HARNESS and
 * replace the invalid sequences here — the very bug this file exists to catch,
 * reproduced on the wrong side of the assertion and silently agreeing with a
 * broken step. Without an encoding, stdout is the Buffer git wrote.
 */
function showBlob(wt: string, rel: string): Buffer {
  const r = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: wt, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0)
    throw new Error(`git show HEAD:${rel} failed: ${(r.stderr ?? "").toString().trim()}`);
  return r.stdout;
}

/** The bytes under test: a UTF-16LE BOM and a byte no encoding maps losslessly. */
// No NUL: a test file holding one is refused at the boundary as not a text
// file (`countTestLines` in test-size.ts), and this case is about the FREEZE
// keeping the bytes, not about that rule (test-lean-test-size.ts pins the
// refusal). 0xff and 0x80 are never valid UTF-8 in any position, so the
// latin1-vs-utf8 failure this file exists to catch is unchanged; the BOM is
// kept because it is the shape a real UTF-16 test starts with.
const BYTES = Buffer.from([0xff, 0xfe, 0x41, 0x80]);
const REL = "tests/AC1-bytes.test.sh";
const shaOf = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

{
  const { repoRoot, baseSha } = makeRepo({ "src/blob.ts": "export const b = 1;\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 40,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      // The child wrote four bytes and nothing else. They are a test in the
      // only sense the step cares about: it is a file it must not mangle.
      writeFileSync(path.join(wt, REL), BYTES);
    },
    toolUses: [submit("AC1", [REL])],
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `bytes: no throw (got ${r.threw?.message ?? "clean"})`);
  assert(r.outcome?.kind === "ok", `bytes: ok, got ${r.outcome?.kind}`);

  // git's own answer, not the fixture's: what the commit really holds. Read
  // through `latin1` for exactly the reason the step does — and WITHOUT
  // `--textconv`, which would decode the blob and mangle these bytes in the
  // harness rather than in the code under test.
  const committedBytes = showBlob(wt, REL);
  assert(
    committedBytes.equals(BYTES),
    `bytes: the commit holds the exact four bytes the child wrote (got ${committedBytes
      .toString("hex")
      .slice(0, 32)})`,
  );

  assert(
    r.outcome?.frozen?.[REL] === shaOf(BYTES),
    `bytes: frozen[path] is sha256 of the committed bytes (got ${r.outcome?.frozen?.[REL]}, want ${shaOf(BYTES)})`,
  );

  // The counterfactual that makes this a test of `stdoutEncoding: "latin1"`.
  // A utf8 read of the same blob replaces the invalid sequences, so its hash
  // differs — and `frozen[path]` must equal NEITHER: the assertion above pins it
  // to the raw bytes, and this one refuses the specific value a utf8 decode
  // produces. Revert the option and the first fires; that pair is the proof.
  const utf8Hash = shaOf(Buffer.from(committedBytes.toString("utf8"), "utf8"));
  assert(
    utf8Hash !== shaOf(BYTES),
    "bytes: a utf8 round trip really does change these bytes, so the assertion below has teeth",
  );
  assert(
    r.outcome?.frozen?.[REL] !== utf8Hash,
    `bytes: frozen[path] is not the utf8-decoded hash ${utf8Hash} either — the latin1 read held`,
  );

  assert(
    git(wt, "show", "--name-only", "--format=", "HEAD") === REL,
    `bytes: the commit contains exactly the byte-exact test (got ${git(wt, "show", "--name-only", "--format=", "HEAD")})`,
  );
}

// ------------------------------- the unbuilt stubs throw, they do not return a kind
//
// Same file, same claim about the engine's contract, because it is the claim this
// file is really testing: a `lean` handler may return only the outcome kinds
// `machine.ts` lists for its state, and the not-built stubs used to invent one
// (`done`) to carry their reason. The engine then ended the run on
// `no transition for <state> + "done"` instead of naming the stage that was
// missing — a handler bug by the engine's own definition, reported as a table
// bug. They throw now, so this asserts the reason reaches the operator.
// `verify`, `handback` and `publish` are real steps now (see
// `test-lean-verify-wiring.ts` and `test-lean-publish.ts`), so the stub asserted
// on is `review`, which is still unbuilt.
{
  const { phase1Handlers } = await import("../src/lean/command.ts");
  const unbuilt = ["review", "ci", "land"] as const;
  const stub = phase1Handlers("/nonexistent", 1).review as (ctx: unknown) => Promise<unknown>;
  let threw = "";
  try {
    const out = await stub({} as never);
    threw = `returned ${JSON.stringify(out)}`;
  } catch (err) {
    threw = (err as Error).message;
  }
  assert(
    threw === "work-lean stage review is not built yet",
    `stubs: an unbuilt stage THROWS its reason rather than returning an outcome (${threw})`,
  );
  assert(
    unbuilt.every((name) => typeof phase1Handlers("/nonexistent", 1)[name] === "function"),
    "stubs: every unbuilt stage still has a handler, so the engine reaches it and its throw is what the run reports",
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
