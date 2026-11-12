#!/usr/bin/env bun
/**
 * #2200 — the shapes the child deletion rule reads (the judgement core), split out
 * of test-write-fence-deletion-2200.ts by the repo's file-size cap. This file
 * covers WHAT a command claims to delete; that file covers the hook: the roots,
 * the refusal text and log, `git clean`, and the registration canary.
 *
 *   A. the incident's shapes are refused, literal paths included (A1), the shared
 *      temp root under the names it actually has (A2), a sibling child's temp root
 *      and a harness-owned tree (A3), the `xargs` sweep (A4), and every interpreter
 *      form D7 names (A5);
 *   A6. a remover behind a wrapper is still that remover — the splitter strips the
 *       privilege and scheduling forms its sibling scanner (`bash-destructive-write.ts`)
 *       strips, so `sudo rm -rf …` is judged rather than skipped, whichever side of
 *       the roots its target lies on;
 *   B. deleting inside the child's own roots still works — the rule is not a bash
 *      ban — while a target the command does not name is refused even in-tree.
 *
 * Observed RED on the code before this change: the shared-root rows, `find`
 * without start paths, the template-literal interpreter body, and the wrapper rows
 * (a `sudo`-prefixed remover fell out of `owned()` entirely).
 */

import {
  CHILD_TMP_ENV,
  deletionRootsFrom,
  firstDeletionOutside,
} from "../src/write-fence-deletion.ts";
import { buildDeletionFixture } from "./lib/write-fence-deletion-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fx = buildDeletionFixture("shapes");
const { base, wt, scratch, childTmp, sharedTmp, siblingTmp, harnessTree, foreignRun } = fx;

/** The roots a fenced develop child's dispatch gives it; the child works in the worktree. */
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
// A1. The incident's shapes: literal paths outside every allowed root.
// ============================================================
const refusedShapes: Array<[string, string]> = [
  [`rm -rf ${foreignRun}`, "the incident's literal `rm -rf` of another run's dir"],
  [`rm ${foreignRun}/payload`, "a literal `rm` of one file outside the roots"],
  [`rmdir ${foreignRun}`, "a literal `rmdir` outside the roots"],
  [`rm -rf ${sharedTmp}`, "a literal `rm -rf` of the shared temp root itself"],
  [
    `find ${sharedTmp} -maxdepth 1 -name 'x-*' -delete`,
    "the acceptance row: `find <sharedTemp> -maxdepth 1 -name 'x-*' -delete`",
  ],
  [
    `find ${sharedTmp} -maxdepth 1 -name 'a-*' -print0 | xargs -0 -r rm -rf`,
    "the incident's prefix sweep through `find … | xargs -0 -r rm -rf`",
  ],
  [`unlink ${foreignRun}/payload`, "`unlink` outside the roots"],
  [`shred -u ${foreignRun}/payload`, "`shred -u` outside the roots"],
  [`cd ${sharedTmp} && rm -rf other-session-run`, "a delete reached through `cd`"],
  [`(cd ${sharedTmp} && rm -rf other-session-run)`, "the same delete inside a subshell"],
  [`rm -rf ${siblingTmp}`, "another child's per-child temp root (D3)"],
  [`rm -rf ${harnessTree}`, "a harness-owned temp tree — a live reviewer checkout (D3)"],
];
for (const [command, why] of refusedShapes) {
  assert(refused(command) !== undefined, `A1 refuse: ${why} — \`${command}\``);
}

// ============================================================
// A2. The shared temp root under the names it actually has.
// ============================================================
for (const root of new Set([sharedTmp, "/tmp", process.env.TMPDIR ?? "/tmp"])) {
  assert(
    refused(`rm -rf ${root}/pi-rukas-review-victim`) !== undefined,
    `A2: a delete under the shared root \`${root}\` is refused`,
  );
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

// ============================================================
// A5. The `xargs -I` placeholder is not a path. `find <sharedTemp> | xargs -I{} rm -rf {}`
// used to be ALLOWED: the splitter swallows the placeholder as `-I`'s value, the surviving
// `rm -rf {}` has the literal operand `{}`, and nothing reached the `find` start paths.
// A remover operand that IS the replacement placeholder names no path, so the line falls
// through to the `find` start paths — refused over a shared root, allowed inside the worktree.
// ============================================================
const placeholderRefused: Array<[string, string]> = [
  [`find ${sharedTmp} | xargs -I{} rm -rf {}`, "`xargs -I{} rm -rf {}` over the shared temp root"],
  [`find ${sharedTmp} | xargs -I {} rm -rf {}`, "`xargs -I {} rm -rf {}` (separate placeholder)"],
  [`find ${sharedTmp} | xargs -i% rm -rf %`, "`xargs -i% rm -rf %` (BSD short form)"],
  [`find ${sharedTmp} | xargs -I{} shred -u {}`, "`xargs -I{} shred -u {}` over the shared root"],
];
for (const [command, why] of placeholderRefused) {
  assert(refused(command) !== undefined, `A5 refuse: ${why} — \`${command}\``);
}
const placeholderAllowed: Array<[string, string]> = [
  [`find ${wt}/dist | xargs -I{} rm {}`, "`xargs -I{} rm {}` over a worktree build dir"],
  [`find ${childTmp} | xargs -i% rm -rf %`, "`xargs -i% rm -rf %` over the child's own temp root"],
];
for (const [command, why] of placeholderAllowed) {
  assert(refused(command) === undefined, `A5 allow: ${why} — \`${command}\``);
}

// ============================================================
// A6. A remover behind a wrapper is still that remover: the splitter strips the
// privilege and scheduling forms its sibling scanner strips, so `sudo rm -rf …`
// is judged (not skipped) whichever side of the roots its target lies on.
// ============================================================
const wrapperRefused: Array<[string, string]> = [
  [`sudo rm -rf ${foreignRun}`, "`sudo rm -rf` of another run's dir"],
  [`sudo -u nobody rm -rf ${foreignRun}`, "`sudo -u USER rm -rf` outside the roots"],
  [`doas rm -rf ${foreignRun}`, "`doas rm -rf` outside the roots"],
  [`setsid rm -rf ${foreignRun}`, "`setsid rm -rf` outside the roots"],
  [`gtimeout 10 rm -rf ${foreignRun}`, "`gtimeout DUR rm -rf` outside the roots"],
  [`sudo env VAR=1 nice -n 5 rm -rf ${foreignRun}`, "stacked wrappers before the remover"],
];
for (const [command, why] of wrapperRefused) {
  assert(refused(command) !== undefined, `A6 refuse: ${why} — \`${command}\``);
}
// The same stripping must not turn an in-tree cleanup into a refusal.
const wrapperAllowed: Array<[string, string]> = [
  [`sudo rm -rf ${wt}/build`, "`sudo rm -rf` of a build dir in the worktree"],
  [`nice -n 5 rm -rf ${wt}/build`, "`nice -n N rm -rf` inside the worktree"],
];
for (const [command, why] of wrapperAllowed) {
  assert(refused(command) === undefined, `A6 allow: ${why} — \`${command}\``);
}

// ============================================================
// B. The child's own roots stay deletable — the rule is not a bash ban.
// ============================================================
const allowedShapes: Array<[string, string]> = [
  [`rm -rf ${wt}/build`, "a build dir inside the worktree"],
  ["rm -rf ./build", "a relative delete inside the worktree"],
  [`rm ${scratch}/notes.txt`, "the cycle scratch dir"],
  [`rm -rf ${childTmp}`, "the child's OWN per-child temp dir"],
  [`find ${childTmp} -maxdepth 1 -name 'x-*' -delete`, "find -delete over its own temp dir"],
  [`find ${wt} -name '*.log' -delete`, "find -delete inside the worktree"],
  // The in-tree shapes a developer reaches for, judged by the paths the command names:
  // a `find` pipe is judged by its start paths, and so is the remover it feeds.
  [
    `find ${wt}/dist -name '*.map' -print0 | xargs -0 -r rm -f`,
    "a find|xargs cleanup in the worktree",
  ],
  [
    `find ${childTmp} -maxdepth 1 -name 'p*' -print0 | xargs -0 rm`,
    "a find|xargs sweep of its own temp dir",
  ],
  [`find ${wt}/dist | xargs -I{} rm {}`, "a find|xargs -I{} cleanup in the worktree"],
  [`find ${wt} -type f -exec rm {} +`, "a plain -exec rm over a worktree path"],
  [`find ${wt} -name 'x' -exec rm {} +`, "a -exec rm narrowed by a name test inside the worktree"],
  ["git status --porcelain", "an ordinary read-only command"],
  ["bun run check", "the project verify"],
  [`node -e 'console.log("${scratch}/notes.txt")'`, "an interpreter that deletes nothing"],
];
for (const [command, why] of allowedShapes) {
  assert(refused(command) === undefined, `B allow: ${why} — \`${command}\``);
}
// …but the same shapes aimed outside the roots stay refused by the paths they name,
// and a remover fed by anything but a `find` names no tree at all.
const inTreeRefusals: Array<[string, string]> = [
  [
    `find ${sharedTmp} -maxdepth 1 -name 'a-*' -print0 | xargs -0 -r rm -rf`,
    "the incident's sweep through a find|xargs pipe",
  ],
  [`find ${sharedTmp} -name x -exec rm {} +`, "a -exec rm over a shared-root path"],
  ["rm", "a remover with no operands and no producer"],
  ["ls | xargs rm", "a remover fed by ls: nothing on the line names the targets"],
  [`cat ${wt}/list.txt | xargs rm -f`, "a remover fed by a file: nothing names the targets"],
  [`echo ${sharedTmp}/victim | xargs rm`, "a remover fed by echo"],
  [`rm -f ${wt}/*.log`, "a glob inside the worktree"],
  ["find -exec rm {} +", "an -exec rm that names no tree to remove from"],
];
for (const [command, why] of inTreeRefusals) {
  assert(refused(command) !== undefined, `B refuse: ${why} — \`${command}\``);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
