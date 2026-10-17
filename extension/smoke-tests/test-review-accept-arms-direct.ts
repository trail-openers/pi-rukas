#!/usr/bin/env bun
/**
 * #1125 — the accept guard's ARMS asked DIRECTLY, one shell segment at a time.
 *
 * Split out of test-review-accept-guard-hardened.ts so each file stays under the §12
 * size limit. The invariant is the one that motivated the split: the guard's pre-checks
 * refuse `-c` and any quoted word for every command, so a whole command proves only the
 * pre-check. These ask one arm one segment — what the ARM refuses, with nothing above it
 * to catch the fall. The A1/A2 arms are the last line for a git/gh read the pre-checks
 * let through.
 */

import { armCommit, armForgeRead, armGitRead, armRead } from "../src/review-accept-arms.ts";
import { isProtectedToken } from "../src/review-accept-command.ts";
import { editsFindingsFile, registerReviewAcceptGuard, runsReviewAccept } from "../src/review-accept-guard.ts";

/** Run the REAL tool_call hook over one bash input, as the hardened suite does. */
async function registerBashCall(input: unknown): Promise<{ block?: boolean } | undefined> {
  let captured: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  registerReviewAcceptGuard({
    on: (_event: string, handler: typeof captured) => {
      captured = handler;
    },
  } as never);
  if (!captured) throw new Error("hook: the guard registered no tool_call handler");
  return (await captured({ toolName: "bash", input }, {})) as
    | { block?: boolean }
    | undefined;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Words exactly as an arm receives them: lowercased segment split on spaces. */
const words = (s: string): string[] => s.toLowerCase().split(" ");

const STORE = "review-findings-store";
const DATA = "review-findings.json";
const Q = String.fromCharCode(39);

/**
 * A1 refuses every repo-location selector, every operand that NAMES the store, and every
 * empty quoted word. Each spelling below is the only term in the arm that can make its
 * case red — remove that term and the case fails.
 */
for (const c of [
  "git -c /repo/.git log",
  "git --git-dir=/x log",
  "git --git-dir /x log",
  "git --work-tree=/x status",
  "git --exec-path=/x status",
  "git --exec-path /x blame src/a.ts",
  "git log --oneline --git-dir=/x",
  // The empty word AFTER the verb, spelled so nothing else in the segment refuses: an
  // operand test cannot see through `''`, so this is the case the empty-word refusal is
  // the only term that makes red.
  "git log '' review-findings.json",
  "git log '' extension/src/review-findings-store.ts",
  // `''` glued to a DOT-relative path: the colon branch reads `.git/` (not the store) and
  // the plain basename test sees `.json`, so ONLY the empty-word term can make this red.
  "git log '' .git/review-findings.json",
  // The `-G` term is the only one that sees these: the dashdash term reads the word as a
  // path (`-G…` is not a basename), so only the `-g` branch can make them red.
  "git log -Greview-findings-store --oneline",
  "git log --pickaxe-regex -Greview-findings-store",
  "git diff -Greview-findings.json HEAD",
])
  assert(!armGitRead(words(c)), `arm A1 refuses the selector / store operand — ${c}`);
for (const c of ["git log --oneline", "git --no-pager status", "git show HEAD:readme.md"])
  assert(armGitRead(words(c)), `arm A1 still admits the plain read — ${c}`);

/** A2 refuses the same selectors on a forge read, and still admits the exact reads. */
for (const c of [
  "gh pr view 1 --git-dir=/x",
  "gh pr view 1 -c x",
  "gh pr diff 2 --work-tree=/x",
  "gh repo view --git-dir /x",
])
  assert(!armForgeRead(words(c)), `arm A2 refuses the repo-location selector — ${c}`);
for (const c of ["gh pr view 1105", "glab mr diff 3"])
  assert(armForgeRead(words(c)), `arm A2 still admits the exact read — ${c}`);

/**
 * A7 (`git commit -m "<prose>"`) carries the same write-flag / repo-location ban the git
 * read arms carry: a `-c` config can name a hook or an alias the commit then runs.
 */
for (const c of [
  'git commit -m "x" -c y.z=1',
  'git commit -m "x" --git-dir=/x',
  // A template or cleanup operand names a FILE the commit reads, with or without `=value`.
  // Each needs the QUOTED message too: without one the arm refuses at the missing-`-m`
  // test, so it proves nothing about the flag ban.
  'git commit -m "x" --template=<review-findings-store>',
  `git commit -m "x" --template=${Q}/tmp/${STORE}${Q}`,
  `git commit -m "x" -t /tmp/${STORE}`,
  'git commit -m "x" -t /tmp/t',
  'git commit -m "x" --cleanup=verbatim',
])
  assert(!armCommit(words(c)), `arm A7 refuses the write-capable flag — ${c}`);
for (const c of ['git commit -m "plain message"', 'git commit -m "fix: guard"'])
  assert(armCommit(words(c)), `arm A7 still admits the plain commit — ${c}`);

/**
 * A7 refuses a PREFIX word before `git` (the arm requires `git` at word 0) and excuses
 * prose only after an UNQUOTED `-m`: `commit "-m" "m <store>"` quotes the FLAG, so the
 * prose position never opens and the store name is asked as a path operand.
 */
for (const c of [
  'sudo git commit -m "x review-findings.json"',
  'time git commit -m "x review-findings.json"',
  'git commit "-m" "m review-findings.json"',
  'git commit "--message" "m review-findings.json"',
])
  assert(!armCommit(words(c)), `arm A7 refuses the prefix word / quoted -m — ${c}`);

/**
 * A8 refuses an exec-capable flag on a read tool: `rg --pre=CMD` pipes every matched
 * file through CMD, so the "read" runs a program no arm named. `sed` and `awk` are not
 * read tools at all — their execute verb is not a flag any list names — so the arm
 * refuses them at word 0 whatever their arguments are.
 */
for (const c of [
  "rg --pre=/bin/sh x",
  "rg --pre cat foo",
  "rg --pre-glob *.ts foo",
  "grep --command=x pat f",
  "find . -exec id ; ",
  "find . --exec id",
  'awk BEGIN{system("id")}',
  "sed -n 1e id x",
  "sed -n w /tmp/x f",
  "sed -n 1,20p extension/src/index.ts",
])
  assert(!armRead(words(c)), `arm A8 refuses the exec-capable flag / tool — ${c}`);
for (const c of ["rg foo src/a.ts", "cat extension/src/index.ts", "grep pat src/a.ts"])
  assert(armRead(words(c)), `arm A8 still admits the plain read — ${c}`);

/**
 * Brace expansion is substitution the guard cannot read: `rev{iew-findings}.json` becomes a
 * protected name the text never spells. The arms see bare words and do not test `EXPANSION`
 * — that is the segment pre-check — so this asserts the word shape the pre-check is
 * chartered to catch: a brace word is never a vouchable protected token. Whole-command
 * refusal is asserted in test-review-accept-guard-hardened.ts.
 */
const OB = String.fromCharCode(123);
const CB = String.fromCharCode(125);
for (const t of [`rev${OB}iew-findings${CB}.json`, "{a,b}", "a{b}c"])
  assert(!isProtectedToken(t), `brace spelling is not a vouchable protected token — ${t}`);

/**
 * The protected-name matcher asked directly: an exact-basename match loses to a
 * one-byte suffix, so each spelling below is a store name the shell expands onto the
 * store's bytes. The last two are clause (b)'s accepted over-refusals — a word that
 * merely STARTS with a stem is refused, which is the price of the prefix rule.
 */
for (const t of [
  "review-findings.json?",
  "review-findings.json:",
  "review-findings.json*",
  "review-findings.json[",
  "review-findings.json,",
  "review-accept",
  "review-acceptance-notes",
  "review-findings.jsonx",
  "/repo/.git/review-findings.json?",
])
  assert(isProtectedToken(t), `matcher: the stem prefix refuses — ${t}`);
for (const t of ["index.ts", "review-accept-guard.ts", "notes.md", "/repo/src/a.ts"]) {
  assert(
    !isProtectedToken(t.split("/").pop() ?? t),
    `matcher: an ordinary basename is not protected — ${t}`,
  );
}

/**
 * The matcher is asked of the word AS THE SHELL PASSES IT: `'rev''iew-findings.json'` is
 * one word the shell concatenates into the exact store name, and the matcher lowercases
 * the candidate itself. The COMMAND-level and edit-path counterparts (which the guard's
 * own lowercase of the whole command would mask) live in the hardened suite.
 */
for (const t of [
  `${Q}rev${Q}${Q}iew-findings.json${Q}`,
  `"rev""iew-findings.json"`,
  `"REVIEW-FINDINGS.JSON"`,
  "Review-Findings.json",
  "REVIEW-FINDINGS.JSON",
  `${Q}rev${Q}${Q}iew-findings-store${Q}`,
])
  assert(isProtectedToken(t), `matcher: quotes-as-concatenation and case refuse — ${t}`);
for (const t of ["review-accept-guard.ts", "REVIEW-ACCEPT-GUARD.TS", "index.ts"]) {
  assert(
    !isProtectedToken(t.split("/").pop() ?? t),
    `matcher: a module beside the store stays unprotected in any case — ${t}`,
  );
}

/**
 * The edit-path checks (#1125 item 4): the target is normalised and asked SEGMENT-wise, so
 * a trailing `/`, a `/.` or a `../..` walk out of the store's directory cannot present the
 * store as some other file; and a `path` property that THROWS is refused, not left to
 * escape the guard's own scan.
 */
for (const p of [
  "/repo/.git/review-findings.json/",
  "/repo/.git/review-findings.json/.",
  "/repo/.git/review-findings.json/../../src/index.ts",
])
  assert(
    editsFindingsFile("write", { path: p }) !== undefined,
    `edit: a trailing or walking path still names the store — ${p}`,
  );
for (const p of ["/repo/src/index.ts", "/repo/extension/src/a.ts"])
  assert(
    editsFindingsFile("write", { path: p }) === undefined,
    `edit: an ordinary path stays allowed — ${p}`,
  );
assert(
  editsFindingsFile("edit", {
    get path() {
      throw new Error("x");
    },
  }) !== undefined,
  "edit: a throwing path getter is refused and does not throw (#1125)",
);

/**
 * Case is erased INSIDE the matcher. The `write` tool's `path` is NOT lowercased by the
 * guard the way a bash command is, so a mixed-case target is the case that fails without
 * this: it is refused. The guard module itself remains editable however it is cased.
 */
for (const p of [
  "/repo/.git/Review-Findings.json",
  "/repo/.git/REVIEW-FINDINGS.JSON",
  "/repo/.git/Review-Findings-Store.tmp",
])
  assert(
    editsFindingsFile("write", { path: p }) !== undefined,
    `edit: a protected name in any case is refused — ${p}`,
  );
for (const p of [
  "/repo/extension/src/review-accept-guard.ts",
  "/repo/extension/src/Review-Accept-Guard.ts",
]) {
  assert(
    editsFindingsFile("write", { path: p }) === undefined,
    `edit: the guard module stays editable in any case — ${p}`,
  );
}

/**
 * Whole-command refusals displaced from test-review-accept-guard-hardened.ts by the §12
 * 500-line cap (cb90cc5). Each is the ONLY case for its term: `-S` (unlike `-G`) has no
 * arm test; a redirection is a guard-level pre-check no arm sees; and `wc` naming the
 * store module is refused where the whole command is asked, not per segment — the `sed -n`
 * and `.bak` siblings the cap also dropped are already covered in both suites.
 */
for (const c of [
  `git log -S${DATA}`,
  `git log --oneline > .git/${DATA}`,
  `git log --oneline < .git/${DATA}`,
  `wc -l extension/src/${STORE}.ts`,
])
  assert(runsReviewAccept(c) !== undefined, `guard refuses the displaced case — ${c}`);

/**
 * An option value ATTACHED to a short flag is one word no tokeniser ever hands out bare,
 * so `-t` (git's `--template` — a FILE the commit reads) and `-e` (a runtime's inline
 * program) belong to the attached-value class with `-g/-s/-o/-f`: the two cases below name
 * the store or the accept script ONLY in that glued position.
 */
for (const c of [`git commit -m "x" -t${DATA}`, "bun -ereview-accept.ts"]) {
  assert(
    runsReviewAccept(c) !== undefined,
    `guard refuses a store name glued to a short flag — ${c}`,
  );
}
assert(
  runsReviewAccept('git commit -m "clean up the review finding handling" -t notes.txt') ===
    undefined,
  "guard: an ordinary template file glued to -t is still an allowed commit",
);

/**
 * A `path` / `command` that is PRESENT but not a string cannot be scanned, and a scan
 * that did not run is not a pass — each is refused fail-closed. `toString` is the shape
 * that used to slip through: the writer below would coerce it onto the store.
 */
for (const input of [
  { path: 123 },
  { path: ["a"] },
  { path: { toString: () => `/repo/.git/${DATA}` } },
])
  assert(
    editsFindingsFile("write", input) !== undefined,
    `edit: a present non-string path is refused — ${JSON.stringify(input)}`,
  );
for (const input of [{}, { path: undefined }, { path: null }, { other: 1 }])
  assert(
    editsFindingsFile("write", input) === undefined,
    `edit: an absent path blocks nothing — ${JSON.stringify(input)}`,
  );

const nonStringCommand = await registerBashCall({ command: { toString: () => `cat ${DATA}` } });
assert(
  nonStringCommand?.block === true,
  "hook: a bash command that is present but not a string is refused",
);
for (const input of [{}, { command: undefined }, { command: null }])
  assert(
    (await registerBashCall(input)) === undefined,
    `hook: an absent bash command blocks nothing — ${JSON.stringify(input)}`,
  );

process.exit(exit);
