#!/usr/bin/env bun
/**
 * #2200 — the interpreter one-liners the deletion rule must read through (D7), split
 * out of `test-write-fence-deletion-shapes-2200.ts` by the repo's file-size cap.
 *
 * A one-liner's paths live in the interpreter BODY, not in argv, so the shell splitter
 * never sees them: the rule reads the body for a remove call and, failing that, for a
 * call that hands a remover to a SHELL — which is where the row for every exec-family
 * spelling lives, since a missing entry there is a remover the reader never sees.
 *
 * Run: cd extension && bun smoke-tests/test-write-fence-deletion-interpreter-2200.ts
 */

import {
  CHILD_TMP_ENV,
  deletionRootsFrom,
  firstDeletionOutside,
} from "../src/write-fence-deletion.ts";
import { buildDeletionFixture } from "./lib/write-fence-deletion-fixture.ts";
import { assert, exit } from "./lib/write-fence-deletion-harness.ts";

const { base, wt, scratch, childTmp, sharedTmp, foreignRun } = buildDeletionFixture("interp");

const FENCED_ENV = {
  PI_ENSEMBLE_WRITE_ROOT: wt,
  PI_ENSEMBLE_WRITE_REPO: base,
  PI_ENSEMBLE_WRITE_SCRATCH: scratch,
  [CHILD_TMP_ENV]: childTmp,
};
const fenced = deletionRootsFrom(FENCED_ENV, wt);

/** The refusal reason the rule gives this command, or undefined when it runs. */
function refused(command: string, roots = fenced): string | undefined {
  return firstDeletionOutside(command, roots)?.reason;
}

// ============================================================
// A3. Interpreter one-liners (D7): every call form the spec names.
// ============================================================
const interpreterRefused: Array<[string, string]> = [
  [
    `node -e 'require("fs").rmSync("${foreignRun}", {recursive: true})'`,
    "`node -e` with `rmSync` on a literal path",
  ],
  [`node --eval 'require("fs").rmSync("${foreignRun}")'`, "`node --eval` with `rmSync`"],
  [
    `bun -e 'import fs from "fs"; fs.rmSync("${foreignRun}", {recursive: true})'`,
    "`bun -e` with `rmSync`",
  ],
  [`python -c 'import shutil; shutil.rmtree("${sharedTmp}")'`, "`python -c` with `shutil.rmtree`"],
  [`python3 -c 'import os; os.remove("${foreignRun}/payload")'`, "`python3 -c` with `os.remove`"],
  [`perl -e 'unlink "${foreignRun}/payload"'`, "`perl -e` with `unlink`"],
  [`ruby -e 'FileUtils.rm_rf("${foreignRun}")'`, "`ruby -e` with `rm_rf`"],
];
for (const [command, why] of interpreterRefused) {
  assert(refused(command) !== undefined, `A3 refuse: ${why}`);
}
// The incident's own script shape: the target is built from the environment's
// home directory inside a template literal, so it lives nowhere but the body.
assert(
  refused(
    "node -e 'const p = `${process.env.HOME}/tmp/sweep`; require(\"fs\").rmSync(p, {recursive: true})'",
  ) !== undefined,
  "A3 refuse: an interpreter whose target is a template literal built from HOME",
);
// A dynamic body or a dynamic target cannot be judged, so it does not run.
assert(
  refused("node -e 'require(\"fs\").rmSync(process.env.TARGET, {recursive:true})'") !== undefined,
  "A3 refuse: an interpreter delete whose target is dynamic",
);
assert(
  refused("bun -e $BODY") !== undefined,
  "A3 refuse: an interpreter body word that is dynamic",
);
// A body that deletes but whose only quoted literals are MODULE SPECIFIERS names no
// path either: `"fs"`, `"fs/promises"`, `"node:fs"` are imports, not targets, so the
// call is unreadable and refused — the same verdict the python and ruby branches give
// for `import shutil; shutil.rmtree()` with no argument.
const moduleSpecifierRefused: Array<[string, string]> = [
  [`node -e 'require("fs").rmSync()'`, "`node -e` with `rmSync()` and no target"],
  [`node -e 'require("fs").unlinkSync()'`, "`node -e` with `unlinkSync()` and no target"],
  [`node -e 'require("fs").rm()'`, "`node -e` with `rm()` and no target"],
  [
    `node -e 'import { rm } from "fs/promises"; rm()'`,
    "`node -e` importing `rm` from `fs/promises` with no target",
  ],
  [
    `node -e 'import { rmSync } from "node:fs"; rmSync()'`,
    "`node -e` importing from `node:fs` with no target",
  ],
  [`bun -e 'require("fs").rmSync()'`, "`bun -e` with `rmSync()` and no target"],
  [`bun -e 'require("node:fs").unlinkSync()'`, "`bun -e` with `unlinkSync()` and no target"],
];
for (const [command, why] of moduleSpecifierRefused) {
  assert(refused(command) !== undefined, `A3 refuse: ${why} — \`${command}\``);
}

// A body that only *mentions* a removal verb deletes nothing, and the rule reads the
// call, not the word: a bare `rm`/`unlink` in a message, a comment or a variable name
// must not make the one-liner unreadable. The incident's own Perl spelling (`unlink
// "path"`, a Perl bareword call) is still caught.
const interpreterAllows: Array<[string, string]> = [
  [`bun -e 'console.log("rm")'`, "a body whose only rm is inside a string"],
  [`python3 -c 'print("rm")'`, "a python body that prints the word rm"],
  [`node -e 'const rm = 1; console.log(rm)'`, "a variable named rm"],
  [`ruby -e 'puts "unlink"'`, "a ruby body that prints the word unlink"],
  [`node -e 'console.log("# rm -rf everything")'`, "a message that reads like a delete"],
];
for (const [command, why] of interpreterAllows) {
  assert(refused(command) === undefined, `A3 allow: ${why} — \`${command}\``);
}
assert(
  refused(`perl -e 'unlink "${sharedTmp}/x"'`) !== undefined,
  "A3 refuse: `perl -e` with the bareword `unlink` call",
);


console.log(`\nexit ${exit}`);
process.exit(exit);
