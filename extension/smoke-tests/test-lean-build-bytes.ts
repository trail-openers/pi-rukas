#!/usr/bin/env bun
/**
 * lean/build — the byte-level edges: a frozen test that is not valid UTF-8, a
 * frozen map with nothing in it, and the aggregate capture ceiling.
 *
 * Same harness as test-lean-build.ts (a real temp repo, a real worktree, only
 * the model stubbed). Split out to keep each smoke file under the size gate.
 *
 *   (r) a frozen test holding the bytes 0xff 0xfe 0x00 0x80 -> ok, and the frozen
 *       hash still matches: the blob is read byte-exactly, so the record the
 *       freeze made is the one build verifies
 *   (s) a run that froze no tests -> THROW with its own message, not the
 *       hash-mismatch one, and the developer is never dispatched
 *   (t) captured files past the aggregate ceiling -> the first that does not fit
 *       is kept out of the commit and every later one is removed unread, each
 *       with the ceiling as its reason
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { BuildInfraError } from "../src/lean/build-errors.ts";
import {
  ROOTS,
  buildFixture,
  commitPaths,
  put,
  runBuild,
  sha,
  status,
} from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------- (r) a frozen test that is not valid UTF-8
//
// 0xff and 0x80 are never valid UTF-8. Read as utf8 and written back, the blob
// changes, so the frozen hash no longer matches the record and the step throws
// before or after the child. No NUL: `submit_tests` refuses a NUL-bearing test
// as not a text file (test-size.ts), and this case is about the build step's
// own blob round trip, not that rule; 0xff/0x80 alone still make git treat the
// file as binary for the purposes here (an invalid-UTF-8 blob).
{
  const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x80]);
  const r = await runBuild({
    issue: 122,
    frozenText: bytes,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 11;\n"),
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(r) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(r) ok, got ${r.outcome?.kind}`);
  const committed = spawnSync("git", ["show", "HEAD:tests/AC1-retry.test.sh"], {
    cwd: wt,
    maxBuffer: 1024 * 1024,
  }).stdout;
  assert(
    Buffer.compare(committed, bytes) === 0,
    `(r) the committed frozen test is the exact bytes (got ${committed.toString("hex")})`,
  );
  assert(
    sha(committed) === sha(bytes),
    "(r) the committed blob hashes to the record the freeze made",
  );
  assert(
    commitPaths(wt).join() === "src/retry.ts",
    `(r) the commit holds the implementation only (got ${commitPaths(wt).join(", ")})`,
  );
  assert(status(wt) === "", `(r) clean after the commit (got ${status(wt)})`);
}

// --------------------------------- (s) the run froze no tests at all
{
  const built = buildFixture(123);
  built.ctx.steps = built.ctx.steps.map((s) =>
    s.state === "specify" ? { ...s, outcome: { kind: "ok" as const, frozen: {}, tests: {} } } : s,
  );
  const r = await runBuild({ issue: 123, built });
  assert(
    r.threw instanceof BuildInfraError,
    `(s) the throw is a BuildInfraError (got ${r.threw?.message})`,
  );
  assert(
    r.threw?.message === "the run froze no tests — build has nothing to build against",
    `(s) the empty map has its own message (got ${r.threw?.message})`,
  );
  assert(
    !(r.threw?.message ?? "").includes("do not match"),
    "(s) and it is not the hash-mismatch message",
  );
  assert(r.dispatched === 0, `(s) the developer was never dispatched (got ${r.dispatched})`);
}

// ----------------------------- (t) the aggregate ceiling stops the capture
//
// Three 20-byte files against a 30-byte ceiling: `src/a.ts` fits, `src/b.ts`
// would take the total to 40 and is refused, and `src/c.ts` is removed unread
// because the capture has already stopped. None of b or c reaches the commit.
{
  const r = await runBuild({
    issue: 124,
    captureCeiling: 30,
    child: (wt) => {
      put(wt, "src/a.ts", "export const a = 1;\n");
      put(wt, "src/b.ts", "export const b = 1;\n");
      put(wt, "src/c.ts", "export const c = 1;\n");
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(t) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(t) ok, got ${r.outcome?.kind}`);
  assert(
    commitPaths(wt).join() === "src/a.ts",
    `(t) the commit holds the file that fit under the ceiling (got ${commitPaths(wt).join(", ")})`,
  );
  const reason = r.outcome?.reason ?? "";
  assert(
    reason.includes("src/b.ts (not captured: the capture reached its 30-byte aggregate ceiling)"),
    `(t) the file that broke the ceiling is listed with its reason (got ${reason})`,
  );
  assert(
    reason.includes("src/c.ts (not captured: the capture reached its 30-byte aggregate ceiling)"),
    `(t) the file after it is listed too, not read (got ${reason})`,
  );
  assert(!existsSync(path.join(wt, "src/b.ts")), "(t) the refused file is gone from the tree");
  assert(status(wt) === "", `(t) clean after the commit (got ${status(wt)})`);
  assert(
    readFileSync(path.join(wt, "src/a.ts"), "utf8") === "export const a = 1;\n",
    "(t) the file that fit is the bytes the child wrote",
  );
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
