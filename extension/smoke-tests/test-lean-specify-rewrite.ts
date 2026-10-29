#!/usr/bin/env bun
/**
 * lean/specify, part 4 of 3 — the REWRITE of the captured bytes never follows
 * a link.
 *
 * `fileProblem` already refuses a submitted path whose `realpath` leaves the
 * tree, so the escape case (a parent link to a directory OUTSIDE the worktree)
 * is closed at validation — that is case (r) in test-lean-specify-tamper.ts.
 * This case covers what validation cannot see: a parent that is a symlink to a
 * directory INSIDE the tree passes `realpath`, and a write through it would
 * follow the link rather than land in the tree's own directory. `writeCaptured`
 * is exercised directly because the step cannot be reached in that state —
 * validation drops the row first — and the case also asserts the ordinary
 * nested path still lands, so the check is not a refusal of everything.
 *
 * The fixture is lib/lean-specify-fixture.ts.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCaptured } from "../src/lean/specify-reset.ts";
import { ROOTS } from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---- (r1) a symlinked ancestor is refused at the rewrite, even for an inside link
//
// `fileProblem` already refuses a path whose `realpath` leaves the tree, so the
// escape case (a parent link to a directory OUTSIDE the worktree) is closed at
// validation — case (r) below. The rewrite must still not write THROUGH a link:
// a parent that is a symlink to a directory INSIDE the tree passes `realpath`,
// and a write through it would follow the link rather than the tree's own
// directory. `writeCaptured` is exercised directly because the step cannot be
// reached in that state — validation drops the row first.
const r1wt = mkdtempSync(path.join(tmpdir(), "lean-wt-"));
ROOTS.push(r1wt);
{
  const inside = path.join(r1wt, "real-tests");
  mkdirSync(inside, { recursive: true });
  symlinkSync(inside, path.join(r1wt, "linked"));
  let threw: unknown;
  try {
    writeCaptured(r1wt, new Map([["linked/AC1-inside.test.sh", Buffer.from("CAPTURED\n")]]));
  } catch (err) {
    threw = err;
  }
  assert(
    (threw as Error)?.name === "SpecifyInfraError" &&
      /could not write .+: ancestor .+ is a symlink/.test((threw as Error).message),
    `(r1) writing through a symlinked parent throws SpecifyInfraError naming the ancestor (got ${
      threw === undefined ? "no throw" : `${(threw as Error).name}: ${(threw as Error).message}`
    })`,
  );
  assert(
    !existsSync(path.join(inside, "AC1-inside.test.sh")),
    "(r1) no bytes landed behind the link",
  );
  // And a plain nested path still lands, which is what keeps the check from
  // being a refusal of everything.
  writeCaptured(r1wt, new Map([["deep/nested/AC1-ok.test.sh", Buffer.from("OK\n")]]));
  assert(
    existsSync(path.join(r1wt, "deep", "nested", "AC1-ok.test.sh")) &&
      readFileSync(path.join(r1wt, "deep", "nested", "AC1-ok.test.sh"), "utf8") === "OK\n",
    "(r1) an ordinary nested path is created and written",
  );
  assert(
    readdirSync(path.join(r1wt, "deep", "nested")).length === 1,
    "(r1) no temp file left behind next to the written one",
  );
}
for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
