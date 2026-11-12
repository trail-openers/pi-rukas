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
import {
  buildDeletionFixture,
  deletionHost,
  withDeletionHost,
} from "./lib/write-fence-deletion-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Every row runs inside this block: the rule consults process.env for the home it refuses
// (os.homedir) and for the temp root its ancestor walk seeds on (os.tmpdir), so an unpinned
// runner could make a row green or red by where it happened to put TMPDIR. See withDeletionHost.
const fx = buildDeletionFixture("shapes");
const HOST = deletionHost(fx.base);
await withDeletionHost(HOST, async () => {
const {
  base,
  wt,
  scratch,
  childTmp,
  sharedTmp,
  sharedRuns,
  siblingTmp,
  harnessTree,
  foreignRun,
} = fx;

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
// The temp roots named by the ROW and by the file's pinned host, never by the invocation:
// `process.env.TMPDIR` here asked the machine which tree it keeps its scratch in, so the set
// of rows differed per runner and one of them could vanish from the run unnoticed.
for (const root of new Set([sharedTmp, "/tmp", HOST.TMPDIR])) {
  assert(
    refused(`rm -rf ${root}/pi-rukas-review-victim`) !== undefined,
    `A2: a delete under the shared root \`${root}\` is refused`,
  );
}

// ============================================================
// A5. The `xargs` replacement placeholder is not a path. `find <sharedTemp> | xargs -I{} rm -rf {}`
// used to be ALLOWED: the splitter swallows the placeholder as `-I`'s value, the surviving
// `rm -rf {}` has the literal operand `{}`, and nothing reached the `find` start paths.
// A remover operand that IS the replacement placeholder names no path, so the line falls
// through to the `find` start paths — refused over a shared root, allowed inside the worktree.
// The spellings the first fix missed and the second round pinned: no `-I`/`-i` at all, and
// the BSD bare `-i`. Real `xargs` substitutes its own `{}` in both cases, so a bare `{}`
// operand names a match and never a path — and the line must fall through to the `find`
// start paths the same way the attached spellings do. Measured against the code this round
// started from, the no-option form ran; the bare `-i` form refused by accident, because its
// `{}` read as a literal path that landed outside the roots — which also made an in-tree
// `find <own tree> | xargs -i rm {}` a refusal, so both directions are pinned here.
// ============================================================
const placeholderRefused: Array<[string, string]> = [
  [`find ${sharedTmp} | xargs -I{} rm -rf {}`, "`xargs -I{} rm -rf {}` over the shared temp root"],
  [`find ${sharedTmp} | xargs -I {} rm -rf {}`, "`xargs -I {} rm -rf {}` (separate placeholder)"],
  [`find ${sharedTmp} | xargs -i% rm -rf %`, "`xargs -i% rm -rf %` (BSD short form)"],
  [`find ${sharedTmp} | xargs -I{} shred -u {}`, "`xargs -I{} shred -u {}` over the shared root"],
  [
    `find ${sharedTmp} | xargs -i rm -rf {}`,
    "`xargs -i rm -rf {}` — bare `-i`, whose placeholder is xargs' own `{}`",
  ],
  [
    `find ${sharedTmp} | xargs -i rm -rf '{}'`,
    "the same bare `-i` with the placeholder quoted, which the shell strips before xargs sees it",
  ],
  [
    `find ${sharedTmp} | xargs -i rm -rf`,
    "bare `-i` with no operand at all: the targets are the matches on stdin",
  ],
  [
    `find ${sharedTmp} | xargs rm -rf {}`,
    "no `-I`/`-i` at all — xargs still substitutes its default `{}`",
  ],
];
for (const [command, why] of placeholderRefused) {
  assert(refused(command) !== undefined, `A5 refuse: ${why} — \`${command}\``);
}
const placeholderAllowed: Array<[string, string]> = [
  [`find ${wt}/dist | xargs -I{} rm {}`, "`xargs -I{} rm {}` over a worktree build dir"],
  [`find ${childTmp} | xargs -i% rm -rf %`, "`xargs -i% rm -rf %` over the child's own temp root"],
  [`find ${wt}/dist | xargs -i rm {}`, "bare `-i` over a worktree build dir"],
  [`find ${wt}/dist | xargs rm {}`, "no `-I` at all over a worktree build dir"],
];
for (const [command, why] of placeholderAllowed) {
  assert(refused(command) === undefined, `A5 allow: ${why} — \`${command}\``);
}

// ============================================================
// A7. A `find` whose matches reach a remover is judged by its start paths EVEN WHEN the
// remover also names a literal path. `find <shared> -exec ls {} + | xargs rm -rf <in-tree>`
// used to be ALLOWED: the one in-tree literal made the remover "name a path", so the reader
// judged only it and never consulted the `find` — while a pipe carries every match, so the
// outside tree was swept by a line that named it. Measured with real `xargs`, it deletes.
// A non-remover `-exec` (`ls`, `grep`) prints its matches, so they are the remover's victims;
// an `-exec` of a remover is silent and hands the pipe nothing.
// ============================================================
const pipeLaunderingRefused: Array<[string, string]> = [
  [
    `find ${sharedTmp} -exec ls {} + | xargs rm -rf ${wt}/build`,
    "the round-2 finding: a non-remover `-exec` whose remover names only an in-tree literal",
  ],
  [
    `find ${sharedTmp} -exec grep -l x {} + | xargs rm -rf .`,
    "the same with `-exec grep` and a relative literal (which resolves inside the worktree)",
  ],
  [
    `find ${sharedTmp} | xargs rm -rf ${wt}/build`,
    "a plain `find` pipe whose remover names only an in-tree literal",
  ],
  [
    `find ${wt} -exec ls {} + | xargs rm -rf ${siblingTmp}`,
    "an in-tree `find` reaching out through the pipe: the literal is the outside tree here",
  ],
];
for (const [command, why] of pipeLaunderingRefused) {
  assert(refused(command) !== undefined, `A7 refuse: ${why} — \`${command}\``);
}
// The shapes that must NOT be caught by that rule: a silent `-exec rm` hands the pipe no
// victims, so only the remover's own literal is judged — and a fully in-tree pipe stays a
// cleanup.
const pipeLaunderingAllowed: Array<[string, string]> = [
  [
    `find ${wt} -exec rm {} + | xargs rm -rf ${wt}/build`,
    "a silent `-exec rm` prints nothing, so the downstream remover has only its in-tree literal",
  ],
  [
    `find ${wt} -exec ls {} + | xargs rm -rf ${wt}/build`,
    "a pipe whose `find` and remover both stay in the worktree",
  ],
];
for (const [command, why] of pipeLaunderingAllowed) {
  assert(refused(command) === undefined, `A7 allow: ${why} — \`${command}\``);
}
// A placeholder-only remover behind a producer that is not a `find` names no tree at all:
// the placeholder must not turn `ls | xargs -i rm -rf {}` into a pass (the same verdict the
// rule already gives `ls | xargs rm`).
for (const [command, why] of [
  [`ls ${sharedTmp} | xargs -i rm -rf {}`, "`ls … | xargs -i rm -rf {}`"],
  [`echo ${sharedTmp}/victim | xargs rm -rf {}`, "`echo … | xargs rm -rf {}`"],
] as Array<[string, string]>) {
  assert(refused(command) !== undefined, `A7 refuse: ${why} names no tree — \`${command}\``);
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
// A8. An `xargs -I` whose VALUE is a path is not a placeholder. `xargs -I VALUE cmd`
// substitutes VALUE for each name read on standard input, so an operand equal to that
// value is the path the child typed, not a match: `xargs -I <shared> rm -rf <shared>`
// deletes the shared root (real `xargs` deletes it). Reading the value as a placeholder
// dropped the operand, so the remover seemed to name nothing and the delete ran.
// ============================================================
const pathShapedPlaceholderRefused: Array<[string, string]> = [
  [`xargs -I ${sharedTmp} rm -rf ${sharedTmp}`, "`xargs -I <shared> rm -rf <shared>`"],
  [`xargs -i ${sharedTmp}/x rm -rf ${sharedTmp}/x`, "`xargs -i <shared>/x rm -rf <shared>/x`"],
  [
    `xargs -I ${sharedTmp} unlink ${sharedTmp}/payload`,
    "`xargs -I <shared> unlink <shared>/payload`",
  ],
  // A relative target resolves against the remover's own directory, which `xargs` gives it as
  // the child's cwd — so the bare line reaches `<wt>/tmp/other-session-run`, a tree inside the
  // worktree, and deletes nothing the rule forbids. This line, run from the fixture root, is
  // the one that reaches the foreign run (verified against GNU xargs).
  [
    `cd ${base} && xargs -I ./out rm -rf ./${foreignRun.slice(base.length + 1)}`,
    "a `./`-shaped -I value whose relative target the `cd` puts outside the roots",
  ],
  ["xargs -I ~ rm -rf ~", "a bare `~` -I value, which expands to the home directory"],
];
for (const [command, why] of pathShapedPlaceholderRefused) {
  assert(refused(command) !== undefined, `A8 refuse: ${why} — \`${command}\``);
}
// A placeholder that is not path-shaped still names no path, so those lines fall through
// to the `find` start paths (A5) rather than being judged on the brace.
assert(
  refused(`find ${sharedTmp} | xargs -I%% rm -rf %%`) !== undefined,
  "A8 refuse: a non-path `-I%%` placeholder over the shared root still falls through to the find",
);

// ============================================================
// A8b. An `xargs -I` whose VALUE is a plain WORD still names the child's own path. `-I` takes an
// arbitrary string, so `rm`, `q` and `VICTIM` are all legal replacement strings — and the operand
// equal to one is the path xargs hands the remover on every run. Real GNU `xargs` 4.10 deletes with
// both spellings — `printf 'victim\n' | xargs -I victim rm -rf victim` cleared a scratch victim dir,
// and from a cwd inside the worktree, `xargs -I q rm -rf ../outside/q` cleared one outside it. Only
// the brace/`%`/`-#` family is a token, so a plain word's operand is judged wherever the line puts
// it; the A8 rows above missed this because every `-I` value there was path-shaped.
// ============================================================
/**
 * THE DISCRIMINATING ROWS. `xargs -I` takes an ARBITRARY string, so `q`, `rm` and `VICTIM` are all
 * legal replacement strings — and every one of them is also a legal path. Membership of the
 * placeholder set is therefore not enough to drop a word: `isPlaceholderWord` must also require a
 * token SHAPE, or the sole operand to the right of the command is read as the substitution, the
 * remover seems to name nothing, and the tree it named is never judged. Mutate that shape test away
 * (`return placeholders.has(text)`) and the allow rows below go red — the one that matters,
 * `xargs -I q rm -rf q`, is the line real GNU `xargs` 4.10 really deletes through. The refuse rows
 * pin the same operand read wherever the `cd` or the line puts it, on the removers the writers table
 * has no entry for and under the BSD `-i` spelling.
 */
const wordValuedPlaceholderRefused: Array<[string, string]> = [
  [`printf q | xargs -I q rm -rf ${sharedRuns}/other-run`, "an operand that IS the word `-I` value, naming a shared root no basename rule knows"],
  [`printf q | xargs -I rm rm -rf ${sharedRuns}/other-run`, "the replacement string is itself a command name"],
  [`printf q | xargs -I VICTIM rm -rf ${sharedRuns}/other-run`, "the replacement string is a word in caps"],
  [`printf q | xargs -i q unlink ${sharedRuns}/other-run`, "the BSD `-i` spelling"],
  [`printf q | xargs -I q rmdir ${sharedRuns}/other-run`, "`rmdir` with a word `-I` value"],
  [`printf q | xargs -I q shred -u ${sharedRuns}/other-run/payload`, "`shred -u` with a word `-I` value"],
  [`printf q | xargs -I q rm -rf ${foreignRun}`, "a word `-I` whose absolute operand is the foreign run"],
  [`printf q | xargs -I q unlink ${foreignRun}/payload`, "`unlink` with a word `-I` value"],
  [`printf q | xargs -I q shred -u ${foreignRun}/payload`, "`shred -u` with a word `-I` value"],
  [
    `cd ${base} && xargs -I out rm -rf ../${base.slice(base.lastIndexOf("/") + 1)}/shared/other-run`,
    "a plain-word `-I` value whose relative operand the `cd` puts outside the roots",
  ],
];
for (const [command, why] of wordValuedPlaceholderRefused) {
  assert(refused(command) !== undefined, `A8b refuse: ${why} — \`${command}\``);
}
// The same word-valued lines stay a cleanup when the operand resolves inside the roots: the fix
// judges the operand, it does not refuse every line whose `-I` value is a word.
const wordValuedPlaceholderAllowed: Array<[string, string]> = [
  [`printf q | xargs -I q rm -rf ${wt}/q`, "a word `-I` whose operand is an absolute worktree path"],
  [`printf q | xargs -I q rm -rf q`, "a word `-I` whose relative operand is inside the worktree"],
  [`printf q | xargs -I q rm -rf ${childTmp}/q`, "a word `-I` whose operand is the child's own temp dir"],
  [`find ${wt}/dist | xargs -I q rm -rf q`, "a word-valued `-I` over a worktree build dir"],
  [`find ${childTmp} | xargs -i q rm -rf q`, "a word-valued BSD `-i` over the child's own temp dir"],
];
for (const [command, why] of wordValuedPlaceholderAllowed) {
  assert(refused(command) === undefined, `A8b allow: ${why} — \`${command}\``);
}

// ============================================================
// A9. The command an `-exec` runs is the FIRST word after the action. Picking the
// first word that is not an option let `find <shared> -exec -- rm -rf {} +` and
// `find <shared> -exec sudo rm -rf {} +` read as an `-exec` of nothing (or of a
// wrapper that is not a remover), so the reader saw no removal action and allowed the
// line. An `-exec` whose first word is an option cannot be read at all, so it is refused.
// ============================================================
const execFirstWordRefused: Array<[string, string]> = [
  [`find ${sharedTmp} -exec -- rm -rf {} +`, "`-exec -- rm -rf {} +`"],
  [`find ${sharedTmp} -exec sudo rm -rf {} +`, "`-exec sudo rm -rf {} +`"],
  [`find ${sharedTmp} -exec sudo -u nobody rm -rf {} +`, "`-exec sudo -u USER rm -rf {} +`"],
  [`find ${sharedTmp} -execdir rm {} \;`, "`-execdir rm {} \\;`"],
  [`find ${sharedTmp} -exec -x rm -rf {} +`, "an -exec whose first word is an option"],
];
for (const [command, why] of execFirstWordRefused) {
  assert(refused(command) !== undefined, `A9 refuse: ${why} — \`${command}\``);
}
for (const [command, why] of [
  [`find ${wt} -exec rm {} +`, "an in-tree `-exec rm {} +`"],
  [`find ${wt} -exec sudo rm -rf {} +`, "an in-tree `-exec sudo rm -rf {} +`"],
] as Array<[string, string]>) {
  assert(refused(command) === undefined, `A9 allow: ${why} — \`${command}\``);
}

// ============================================================
// A10. An interpreter body that deletes through a SHELL cannot be read: the path lives
// in a string the shell runs, so the rule has no target to resolve. A body that holds a
// recognised delete AND a shell-out is refused as unreadable rather than judged on the
// literals it does name.
// ============================================================
const shellOutRefused: Array<[string, string]> = [
  [
    `node -e 'require("child_process").execSync("rm -rf ${sharedTmp}")'`,
    "`node -e` with `child_process.execSync`",
  ],
  [
    `node -e 'const {exec} = require("child_process"); exec("rm -rf ${sharedTmp}")'`,
    "`node -e` with `child_process.exec`",
  ],
  [
    `node -e 'require("child_process").spawn("rm", ["-rf", "${sharedTmp}"])'`,
    "`node -e` with `child_process.spawn`",
  ],
  [`bun -e 'Bun.spawn(["rm", "-rf", "${sharedTmp}"])'`, "`bun -e` with `Bun.spawn`"],
  // The exec-family spelling the first list missed: `execFileSync("rm", […])` runs the same
  // remover `execSync("rm -rf …")` does, and was ALLOWED because the reader's call list had no
  // entry for it. Read through a destructured import too, which is how it is usually written.
  [
    `node -e 'require("child_process").execFileSync("rm", ["-rf", "${sharedTmp}"])'`,
    "`node -e` with `child_process.execFileSync`",
  ],
  [
    `node -e 'const {execFileSync} = require("child_process"); execFileSync("rm", ["-rf", "${sharedTmp}"])'`,
    "`execFileSync` called through a destructured import",
  ],
  [
    `python3 -c 'import subprocess; subprocess.call(["rm", "-rf", "${sharedTmp}"])'`,
    "`python3 -c` with `subprocess`",
  ],
  [`python3 -c 'import os; os.system("rm -rf ${sharedTmp}")'`, "`python3 -c` with `os.system`"],
  [`ruby -e 'system("rm -rf ${sharedTmp}")'`, "`ruby -e` with `system`"],
  [`ruby -e '\`rm -rf ${sharedTmp}\`'`, "`ruby -e` with backticks"],
  [`perl -e 'system("rm -rf ${sharedTmp}")'`, "`perl -e` with `system`"],
];
for (const [command, why] of shellOutRefused) {
  assert(refused(command) !== undefined, `A10 refuse: ${why} — \`${command}\``);
}
// A body that shells out but deletes nothing itself is not a deletion, and one that
// deletes through its own library stays judged on its literal (A3).
for (const [command, why] of [
  [`node -e 'require("child_process").execSync("ls -l")'`, "a shell-out that deletes nothing"],
  [
    `python3 -c 'import subprocess; print(subprocess)'; echo`,
    "a python body that only imports subprocess",
  ],
] as Array<[string, string]>) {
  assert(refused(command) === undefined, `A10 allow: ${why} — \`${command}\``);
}

// ============================================================
// A11. A remover behind a namespace or tracing wrapper is still that remover.
// ============================================================
for (const [command, why] of [
  [`busybox rm -rf ${foreignRun}`, "`busybox rm -rf` of another run's dir"],
  [`strace -f rm -rf ${foreignRun}`, "`strace -f rm -rf` outside the roots"],
  [`unshare rm -rf ${foreignRun}`, "`unshare rm -rf` outside the roots"],
  [`nsenter -t 1 rm -rf ${foreignRun}`, "`nsenter -t 1 rm -rf` outside the roots"],
  [`chroot / rm -rf ${foreignRun}`, "`chroot / rm -rf` outside the roots"],
  // `chroot` takes the new root as a POSITIONAL before the program it runs — exactly one word.
  // Consume two and the remover itself leaves the reader's view, which is the shape that would let
  // this line run; consume none and `/bin` reads as the command. `firejail` takes no positional, so
  // its first word is already the command whatever its options.
  [
    `chroot /bin rm -rf ${foreignRun}`,
    "`chroot /bin rm -rf` — one positional root, the remover still read",
  ],
  [
    `busybox chroot / rm -rf ${foreignRun}`,
    "`busybox chroot / rm -rf` — a wrapper stacked before the positional root",
  ],
  [
    `firejail --quiet --noprofile rm -rf ${foreignRun}`,
    "`firejail --quiet --noprofile rm -rf` — flags, no positional to consume",
  ],
] as Array<[string, string]>) {
  assert(refused(command) !== undefined, `A11 refuse: ${why} — \`${command}\``);
}
assert(
  refused(`busybox rm -rf ${wt}/build`) === undefined,
  "A11 allow: `busybox rm -rf` of a build dir in the worktree",
);

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

});

console.log(`\nexit ${exit}`);
process.exit(exit);
