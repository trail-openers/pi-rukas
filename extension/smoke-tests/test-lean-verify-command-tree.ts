#!/usr/bin/env bun
/**
 * lean/verify — the `command` tier's tree and working-file checks (#1908).
 *
 * The gate's claims about a `command` criterion's file are claims about THREE
 * places at once: the base commit, HEAD, and the working file the runner is about
 * to load. `test-lean-verify-command-criteria.ts` pins the first two (a symlink,
 * a file added at HEAD, a file edited or deleted since base); this file pins the
 * third, which is the one an index trick can hide.
 *
 *   (c3) `git update-index --assume-unchanged` keeps `git status` silent about a
 *        file somebody rewrote on disk. A gate that trusted the porcelain ran those
 *        bytes and recorded them as a preservation criterion the base commit had
 *        proved, so the hash of the working file against the base blob is the read
 *        that must refuse it — and the marker file the edited script would have
 *        touched is the assertion that it never ran;
 *   (c4) the tier runs TEST CODE, and test code writes. A criterion whose runner
 *        leaves a rewritten file behind must not be certified green, so every
 *        licence is read again after the runs.
 *
 * Both cases run the real `verifyOutcome` against real git and real processes.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  GREEN_FILE,
  ROOTS,
  SELF_REWRITER,
  bodyWith,
  cleanupRoots,
  git,
  runCommandVerify,
} from "./lib/lean-verify-command-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const TEST_CRITERION = { id: "AC1", text: "a transient failure is retried", verify: "test" };
const COMMAND_CRITERION = {
  id: "AC2",
  text: "the existing reposition smoke tests still pass",
  verify: "command",
};
const CMD_FILE = "tests/AC2-preserve.test.sh";

// ------------- (c3) a file rewritten on disk under an index trick is NOT runnable
//
// The tree checks read the COMMIT; the runner reads the WORKING file. git offers a
// documented way to make the two disagree while keeping `git status` quiet —
// `git update-index --assume-unchanged` — and a gate that trusted the porcelain
// would run bytes no commit holds and record them as a preservation criterion the
// base commit had proved. The hash of the working file against the base blob is
// the only read that sees this, so the marker the edited script would have touched
// is the assertion: absent means the hash refused it before the runner started.
{
  const root = ROOTS[ROOTS.length - 1] ?? "/tmp";
  const marker = path.join(root, "assume-unchanged-was-executed");
  const r = await runCommandVerify({
    issue: 415,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    baseFiles: { [CMD_FILE]: GREEN_FILE },
    mutate: (wt) => {
      writeFileSync(path.join(wt, CMD_FILE), `#!/bin/sh\ntouch ${marker}\nexit 0\n`, {
        mode: 0o755,
      });
      git(wt, "update-index", "--assume-unchanged", "--", CMD_FILE);
      if (git(wt, "status", "--porcelain") !== "")
        throw new Error("fixture: the tree is not porcelain-clean — the case proves nothing");
    },
  });
  assert(
    r.outcome?.kind === "green" && r.threw === undefined,
    `(c3) a file rewritten under --assume-unchanged neither turns the run red nor throws (${JSON.stringify({ kind: r.outcome?.kind, threw: r.threw?.message })})`,
  );
  assert(
    existsSync(marker) === false,
    "(c3) the rewritten file never ran — the marker it would have created is absent",
  );
  assert(
    r.outcome?.commandCriteria?.AC2 === undefined &&
      r.outcome?.commandNotRunnable?.AC2 === `${CMD_FILE} differs on disk from the base commit`,
    `(c3) the hash check refuses the on-disk edit and records its own reason (${JSON.stringify(r.outcome?.commandNotRunnable)})`,
  );
}

// ------------------- (c4) a criterion whose own script rewrites the tree is RED
//
// The tier runs test CODE, and test code writes. A script that overwrites the very
// file it was named for leaves the gate recording a preservation criterion about
// bytes nobody observed — so the licences that let the run proceed are read again
// after it, against what the gate itself saw BEFORE the runner started.
{
  const r = await runCommandVerify({
    issue: 419,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    baseFiles: { [CMD_FILE]: GREEN_FILE, "self-rewrite.sh": SELF_REWRITER },
    // argv form, no shell: the runner is `sh <helper> <test> <arg2>`, so the file
    // it overwrites is NOT the one it executed. The executed file's hash still
    // matches the base's — so the only thing left standing between this run and a
    // green is the re-check that reads the tree again AFTER the command tier ran.
    testTemplate: "sh self-rewrite.sh {file} tests/AC1-retry.test.sh",
  });
  assert(
    r.outcome?.kind === "red" &&
      (r.outcome?.reason ?? "").includes("altered frozen tests"),
    `(c4) bytes the command tier left behind are never certified green — the post-run re-check says so (${JSON.stringify({ kind: r.outcome?.kind, reason: (r.outcome?.reason ?? r.threw?.message ?? "").slice(0, 140) })})`,
  );
  assert(
    r.outcome?.commandCriteria?.AC2 === undefined,
    `(c4) a run the post-tier re-check refused records no command criterion as passed (${JSON.stringify(r.outcome?.commandCriteria)})`,
  );
}

cleanupRoots();
assert(ROOTS.length === 0, "the fixture removed its temp roots");

process.exit(exit);
