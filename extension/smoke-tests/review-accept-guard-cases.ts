/**
 * The case tables of `test-review-accept-guard-hardened.ts`, kept in their own module so
 * the suite that asserts them stays inside the file-size cap (#1125). The tables are the
 * specification — one entry per shape the guard's adjudication rule must decide — and the
 * suite walks each through `runsReviewAccept` and asserts the verdict. Nothing here calls
 * the guard: these are data, and the polarity (`!refused` / `refused`) is the suite's.
 */

/** A command and the reason the suite asserts its verdict — the reason is the test name. */

const STORE = "review-findings-store";
const DATA = "review-findings.json";
const NL = String.fromCharCode(10);
const Q = String.fromCharCode(39);
const OB = String.fromCharCode(123); // {
const CB = String.fromCharCode(125); // }

export type Case = { c: string; why: string };
// ── 1. the exact read-only allowlist (clause (a)) ─────────────────────────────
export const ALLOWANCES: Case[] = [
  { c: "git status", why: "git status" },
  // The exec-flag and prefix-word refusals an ARM cannot see are asserted here; the arm's
  // own word-0 / flag ban is asserted per segment in the arms-direct suite (#1125).
  { c: "git log --oneline", why: "a plain log" },
  { c: "git --no-pager log --oneline", why: "the remedy the refusal names" },
  { c: "git diff HEAD~1 HEAD", why: "a diff between commits" },
  { c: "git show HEAD:README.md", why: "a blob read" },
  { c: "git blame src/a.ts", why: "blame" },
  { c: "gh pr view 1105", why: "gh pr view" },
  { c: "gh pr view --json number,title", why: "gh pr view --json" },
  { c: "gh pr diff 1105", why: "gh pr diff" },
  { c: "gh repo view", why: "gh repo view" },
  { c: "gh issue view 1125 --json body -q .body", why: "gh issue view" },
  { c: "glab mr view 1105", why: "glab mr view" },
  { c: "glab mr diff 1105", why: "glab mr diff" },
  { c: "bun test smoke-tests/test-review-accept.ts", why: "one named test file" },
  { c: `bun test smoke-tests/test-${STORE}*.ts`, why: "a glob naming the store's test file" },
  { c: "bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts", why: "the offline glob" },
  {
    c: `bash smoke-tests/lib/verify-loop.sh smoke-tests/test-${STORE}*.ts --digest`,
    why: "a --digest-style switch",
  },
  {
    c: "bash smoke-tests/lib/verify-loop.sh --digest smoke-tests/test-review-accept.ts",
    why: "--digest before the file list",
  },
  {
    c: "bash smoke-tests/lib/verify-loop.sh --jobs-from-host smoke-tests/test-*.ts",
    why: "the host-sizing switch that .pi/verify-cmd actually carries (no expansion in it)",
  },
  { c: "bun run build", why: "the exact build form" },
  { c: "bun run check", why: "the exact check form" },
  { c: "bunx tsc --noEmit", why: "the exact type-check form" },
  { c: "bun x tsc --noEmit", why: "the same form spelled with a space" },
  // An empty command runs nothing, so it needs no arm: `scanCommand` returns undefined
  // only for input that is genuinely whitespace once quotes are removed.
  { c: "''", why: "an empty command (quoted) is harmless" },
  { c: '""', why: "an empty command (double-quoted) is harmless" },
  { c: "'' ''", why: "two empty quoted words are harmless" },
  { c: `git commit -m "feat: review-accept guard"`, why: "a commit naming the operator script" },
  {
    c: `git commit -m "clean up the ${DATA} handling"`,
    why: "the data file named inside a quoted message",
  },
  { c: `git commit -m "add ${DATA} and rm it"`, why: "destructive verbs inside a quote" },
  {
    c: `git commit -m "feat(review): record ${DATA} rows (#1105)"`,
    why: "a commit message naming the data file",
  },
  { c: `git commit -m "docs: explain the ${STORE} lifecycle"`, why: "a message naming the store" },
  {
    c: `git commit -m "feat: guard 'quoted' words in ${STORE} messages"`,
    why: "balanced single quotes nested inside a balanced double-quoted message",
  },
  { c: `git commit -m "plain message with no store word"`, why: "an ordinary commit message" },
  { c: `echo "it's a normal message about ${STORE}"`, why: "an apostrophe inside a message" },
  { c: "ls -la extension/src", why: "a read tool naming nothing protected" },
  { c: "cat extension/src/index.ts", why: "cat of an ordinary source file" },
];

/**
 * THE SCOPE OF THE RULE — the 20 commands the brief measured as REFUSED before the
 * fix, all of which spell NO protected name. Clause (a) scopes the allowlist to
 * commands that NAME THE STORE; these name nothing, so no arm is consulted and none of
 * them is refused. If one of these starts failing, the early return in `scanCommand`
 * has gone: the guard is back to bricking the ordinary agent surface, which is the bug
 * this block exists to catch.
 */
export const ORDINARY_AGENT_COMMANDS: Case[] = [
  { c: "mkdir -p tmp/x", why: "a scratch directory" },
  { c: "git add -A", why: "staging the diff" },
  { c: "git push", why: "pushing the branch" },
  { c: "git checkout -b feature/issue-1125-guard", why: "cutting the branch" },
  {
    c: "gh pr create --title feat: the accept guard --body Adds the review accept guard",
    why: "opening the PR",
  },
  { c: "npm install", why: "installing dependencies" },
  { c: "cargo test", why: "a Rust test suite" },
  { c: "bun run smoke-tests/test-x.ts", why: "bun RUNS a suite (not `bun test <path>`)" },
  { c: "timeout -k 10 300 bunx tsc --noEmit", why: "the bounded type-check the brief mandates" },
  { c: "python3 -c 'print(1)'", why: "a one-liner in another runtime" },
  { c: "find . -name '*.ts'", why: "a file listing" },
  { c: "sed -i s/a/b/ src/a.ts", why: "an in-place edit of an ordinary file" },
  { c: "awk '{print 1}' src/a.ts", why: "awk on a non-protected path (rule's must-stay list)" },
  { c: "sed -n '1,5p' src/a.ts", why: "sed -n on a non-protected path (rule's must-stay list)" },
  { c: "gh api /repos/o/r", why: "gh api on a non-protected path (rule's must-stay list)" },
  { c: "echo {a,b}", why: "a brace list that assembles no protected name" },
  { c: "ls -R src", why: "a recursive listing" },
  { c: "grep -rn foo src", why: "a recursive search" },
  { c: "cd extension && bun run check", why: "the chained lint run from .pi/verify-cmd" },
  { c: "cd extension && bunx tsc --noEmit", why: "the chained type-check from .pi/verify-cmd" },
];

/**
 * Out-of-scope refusals the previous shape enforced and the RULE does not. Each is a
 * command that names NO protected file: clause (a) refuses "every other bash command
 * THAT NAMES THE FINDINGS STORE", so a command that names nothing is outside the
 * allowlist's reach and the guard leaves it alone. Each kept its store-naming twin as a
 * refusal (see the store-named additions in MANDATED_REFUSALS), which is what makes
 * these cases a scope test rather than a weakening.
 */
export const OUT_OF_SCOPE_ALLOWED: Case[] = [
  { c: "echo {a,b}", why: "a brace list with no store word: expansion is moot if nothing names" },
  { c: "awk 'BEGIN{system(\"id\")}'", why: "awk running a shell, naming no store file" },
  { c: "rg --pre=/bin/sh x", why: "an exec flag on a search that names no store file" },
  { c: "gh api -X DELETE /repos/o/r", why: "a forge write naming no store file" },
  { c: "sudo cat x", why: "a prefix word before a read of an ordinary file" },
  { c: "ls -R src", why: "a listing of an ordinary directory" },
  { c: "sed -n '1,5p' src/index.ts", why: "sed on an ordinary source file" },
  { c: "bun -e x", why: "a runtime evaluating code that names no store file" },
  { c: "bun test src/index.ts", why: "a test run over a non-test path naming no store file" },
  {
    c: "bun smoke-tests/test-vipune-capability.ts",
    why: "a runtime running one suite that names no store file",
  },
  { c: "git status > /tmp/out.txt", why: "a redirection whose target is no store file" },
  // #1764 criterion 12 moved this row out of DENY_BY_DEFAULT_REFUSALS: the store name sat
  // in the VALUE of `gh --body`, a prose option, and clause (1) no longer fires on a
  // literal prose value. The write-capable flags (`--output=` above) still refuse.
  {
    c: `gh pr create --body "Adds the review-accept acceptance path"`,
    why: "a gh write subcommand naming the script only in its --body prose: clause (1)'s prose-option exception",
  },
  { c: "cat payload.js | wc -", why: "a stdin pipe whose reader counts bytes and names nothing" },
  {
    // The write-capable flags are OUT OF SCOPE only for a program that writes nothing.
    // On git / gh / glab they remain clause (b)'s accepted over-refusal — a `--output`
    // is a route to WRITING the store, asserted in OVER_REFUSALS below.
    c: "bun test --reporter=junit smoke-tests/test-a.ts",
    why: "a test runner's flag on a run that names no store file",
  },
];

/** Siblings of the protected names that clause (b) refuses on sight, and the `-G` pickaxe
 * value: a NAME the tool matches, so a store stem on it refuses the arm — including after
 * the path-limiting `--`, where every other word reads as a path. */
export const SIBLING_REFUSALS: Case[] = [
  // SIBLING_REFUSALS: a dotted suffix of a protected name reaches the store's bytes.
  { c: `cat /repo/.git/${DATA}.bak`, why: "cat of a .bak sibling of the data file" },
  { c: `cat /repo/.git/${DATA}.corrupt`, why: "cat of a .corrupt sibling with no numeric suffix" },
  { c: "cat /repo/.git/review-findings-store.tmp", why: "cat of a .tmp sibling of the store" },
  { c: `git log -G${STORE}`, why: "ACCEPTANCE: git log -G naming the store" },
  { c: `git log --pickaxe-regex -G${STORE}`, why: "-G with its regex companion flag" },
  { c: `git log --oneline -- -G${STORE}`, why: "-G after the path-limiting --" },
  { c: `git diff -G${STORE} HEAD`, why: "-G on a diff" },
];
/**
 * The store name spelled the way the SHELL builds it: `'rev''iew-findings.json'` is ONE
 * word that the shell concatenates into the exact store name, so no quoting may hide it.
 * The matcher-level and edit-path assertions — for this and for CASE, which a `write` path
 * never folds the way the guard folds a command — are asked DIRECTLY in the arms-direct
 * suite (#1125). */
export const SPELLING_REFUSALS: Case[] = [
  { c: `cat 'rev${Q}${Q}iew-findings.json'`, why: "ACCEPTANCE: a quoted-split store name" },
  { c: `cat "rev""iew-findings.json"`, why: "the same concatenation in double quotes" },
  { c: "cat Review-Findings.json", why: "ACCEPTANCE: the data file in mixed case" },
];
/** The repo's own develop gate must stay allowed, verbatim from .pi/verify-cmd. */
// ── 2. the #1125-mandated refusals ────────────────────────────────────────────
export const MANDATED_REFUSALS: Case[] = [
  {
    c: `git show HEAD:x --output=.git/${DATA}`,
    why: "ACCEPTANCE: git show --output naming the data file",
  },
  {
    c: `git -c alias.x=${Q}!cat ${DATA}${Q} x`,
    why: "ACCEPTANCE: git -c alias whose value is a shell command naming the data file",
  },
  {
    c: `bun <<EOF${NL}import { acceptFinding } from "./src/${STORE}.ts"${NL}EOF`,
    why: "ACCEPTANCE: a heredoc bun that imports the store",
  },
  {
    c: `bun <<'SH'${NL}const s = await import("./extension/src/${STORE}.ts")${NL}SH`,
    why: "a quoted here-doc with an async import",
  },
  { c: `bun <<~EOF${NL}import "${STORE}"${NL}EOF`, why: "a tilde here-doc importing the store" },
  // SCOPE: shell expansion still hides a NAME, so a word carrying `$`, a backtick or
  // braces stays in the guard's way WHEN IT NAMES THE STORE. A brace list that assembles
  // no protected name (`echo {a,b}`, `awk 'BEGIN{system("id")}'`) names nothing and is
  // out of clause (a)'s scope — it is asserted in OUT_OF_SCOPE_ALLOWED. Each case below
  // is the SAME shape carrying a protected name.
  { c: `cat /repo/.git/rev${OB}iew-findings${CB}.json`, why: "brace expansion of the data name" },
  {
    c: `cat "a${"${DF}"}b"`,
    why: "ACCEPTANCE: a quoted word whose expansion assembles the data name",
  },
  {
    c: `cat ${Q}review-findings${Q}$(echo .json)${Q}`,
    why: "a command substitution glued to a quoted run of the store's name",
  },
  {
    c: `cat ${OB}rev\\iew-findings${CB}.json`,
    why: "ACCEPTANCE: an escaped spelling of the data name the guard cannot read as prose",
  },
  {
    c: "git log --oneline; cat `echo review-findings`.json",
    why: "a backtick-built store name in a chained segment",
  },
  // `gh api` carries an arbitrary method and body, so it is an arm ONLY when its operand
  // names the store — the forge can be told to write that path, and a body is unreadable
  // text. A `gh api` that names nothing protected is out of clause (a)'s scope.
  {
    c: `gh api /repos/o/r -f path=.git/${DATA}`,
    why: "ACCEPTANCE: a forge write whose body names the data file",
  },
  // The store-naming twins of the out-of-scope forms above: the SAME shape, with a
  // protected name in it, is refused. That pair is the scope test — the rule's scope is
  // the store, not the tool.
  {
    c: `awk 'BEGIN{system("cat ${DATA}")}'`,
    why: "ACCEPTANCE: awk running a shell that reads the data file",
  },
  { c: `rg --pre=/bin/sh ${DATA}`, why: "ACCEPTANCE: an exec-capable flag on the data file" },
  {
    c: `gh api -X POST /repos/o/r -f body=${DATA}`,
    why: "ACCEPTANCE: a forge write whose body names the data file",
  },
  {
    c: `cat "a\${${OB}REVIEW-FINDINGS${CB}}.json"`,
    why: "ACCEPTANCE: a quoted expansion whose NAME the text spells between the braces",
  },
  // A git read verb whose operand NAMES the store as a search term or a blob path.
  { c: `git log -- ${DATA}`, why: "ACCEPTANCE: git log with the data file as a path operand" },
  { c: `git show HEAD:${DATA}`, why: "ACCEPTANCE: git show of the data file's blob" },
  { c: `git log --grep=${DATA}`, why: "git log --grep= naming the data file" },
  // SCOPE: a redirection whose TARGET names no protected file is not a command that
  // names the store (`git status > /tmp/out.txt`, asserted allowed). The store-naming
  // redirection below is the refusal — a redirection moves bytes to a path no arm saw.
  { c: `git show HEAD:${DATA} > /tmp/leak.txt`, why: "a redirection of the data file's bytes" },
  // A git repo-location selector moves the repository the "plain read" runs against, so
  // the arm's promise is about some tree the arms never saw. Each spelling is refused
  // whole, `=`-attached, and case-folded (`-C` reaches the arms as `-c`).
  {
    c: "git -C /repo/.git review-findings.json log",
    why: "ACCEPTANCE: git -C pointing at the store's directory",
  },
  {
    c: "git -c /repo/.git review-findings.json log",
    why: "the same lowercased the way the arms see it",
  },
  {
    c: "git --GIT-DIR=/repo/.git review-findings.json log",
    why: "git --git-dir= in its original case",
  },
  {
    c: "git --git-dir=/repo/.git review-findings.json log",
    why: "ACCEPTANCE: git --git-dir= naming the object store",
  },
  {
    c: "git --git-dir /repo/.git review-findings.json log",
    why: "git --git-dir with a spaced value",
  },
  {
    c: "git --exec-path=/bin review-findings.json status",
    why: "ACCEPTANCE: --exec-path= shadowing git-shell beside the store's name",
  },
  // The repo-location selectors MOVE the repository a "plain read" runs against, and
  // each of these spellings also names the object store, so they are in scope; the
  // store-free ones (`git -c core.pager=cat log --oneline`) are out of scope.
  {
    c: "git -C /repo/.git log --oneline",
    why: "ACCEPTANCE: the repo selector pointing at the object store beside the verb",
  },
  // An empty quoted word glues to its neighbour in the shell (`''f` is a token no operand
  // test recognises), so it must not be able to SEPARATE or HIDE a store name.
  { c: `git status ${Q}${Q} ${DATA}`, why: "ACCEPTANCE: an empty word before the data file" },
  { c: `git status "" .git/${DATA}`, why: 'ACCEPTANCE: an empty "" before the data file' },
  { c: `git log ${Q}${Q}${Q}${Q}${DATA}`, why: "four quotes glued to the data file name" },
];

export const DENY_BY_DEFAULT_REFUSALS: Case[] = [
  // A heredoc body the guard cannot read, whatever the runtime.
  { c: `bun <<EOF${NL}anything at all${NL}EOF`, why: "a bun here-doc with an unreadable body" },
  {
    c: `python <<EOF${NL}open(".git/${DATA}","w")${NL}EOF`,
    why: "a here-doc writing the data file through another interpreter",
  },
  // Unbalanced quotes: the text cannot be parsed as prose, so nothing is guessed at.
  { c: `git commit -m "prose ${DATA}`, why: "odd quote naming the data file" },
  { c: `git commit -m 'it''s about ${DATA}`, why: "doubled single quotes around the data file" },
  {
    c: `git status && echo 'x; bun -e rm ${DATA}`,
    why: "odd single quote hiding a runtime and the data file",
  },
  {
    c: `git commit -m "prose${NL}bun -e ${Q}import("./src/${STORE}.ts")${Q}`,
    why: "odd double quote hiding a bun -e that imports the store",
  },
  // A path operand naming the store has no arm, whatever the verb.
  { c: `git mv ${DATA} ${DATA}.bak`, why: "git mv of the data file" },
  { c: `git commit ${DATA}`, why: "git commit naming the data file as an operand" },
  { c: `git add ${DATA}`, why: "git add of the data file" },
  { c: `git checkout ${DATA}`, why: "git checkout of the data file" },
  { c: `git restore ./${DATA}`, why: "git restore of the data file" },
  { c: `git rm .git/${DATA}`, why: "git rm of the data file" },
  { c: `git stash push -- ${DATA}`, why: "git stash of the data file" },
  { c: `git clean -f ${DATA}`, why: "git clean of the data file" },
  { c: `cat ${DATA}`, why: "cat of the data file" },
  {
    c: `cat ${Q}${DATA}${Q}`,
    why: "ACCEPTANCE: the data file quoted — the shell hands the name to cat either way",
  },
  // The exec-capable read tools (awk, sed, rg --pre) and the prefix-word refusals are
  // asserted per ARM in the arms-direct suite (#1125).
  // A prefix word before a read tool or a commit puts a program the arms never named in
  // A basename that merely STARTS with a protected stem still expands onto the store.
  { c: `cat ${DATA}?`, why: "ACCEPTANCE: a one-byte suffix on the data file's name" },
  { c: `cat ${DATA}:`, why: "a colon after the data file's name" },
  { c: `cat ${DATA}*`, why: "a glob suffix on the data file's name" },
  { c: `cat /repo/.git/${DATA}?`, why: "the same, as an absolute path" },
  { c: `cat ${DATA}.jsonx`, why: "a .json sibling carrying one more byte" },
  { c: `sed -i 's/a/b/' ./.git/${DATA}`, why: "an in-place edit of the data file" },
  { c: `cp ${DATA} /tmp/x`, why: "a copy of the data file" },
  { c: `cp -r ${STORE} /tmp`, why: "a copy of the store module directory" },
  // A forge subcommand no arm spells.
  { c: `gh alias set dump ${Q}!cat ${DATA}${Q}`, why: "gh alias set" },
  { c: `gh config set alias.dump ${Q}!cat ${DATA}${Q}`, why: "gh config set alias" },
  { c: `git config alias.dump ${Q}!cat ${DATA}${Q}`, why: "git config alias." },
  { c: `gh api /repos/o/r/contents/f --output=${DATA}`, why: "gh --output naming the data file" },
  { c: `glab api /projects/1 --output=${DATA}`, why: "glab --output naming the data file" },
  // A test arm whose argv says something other than a suite.
  {
    c: `bun test smoke-tests/test-review-*.ts ${Q}bun ./src/${STORE}.ts${Q}`,
    why: "a quoted argument that is not a test path",
  },
  {
    c: `bash smoke-tests/lib/verify-loop.sh bun ${STORE}.ts`,
    why: "a bare word argument — the runner is handed something that is not a test",
  },
  {
    c: `bun test --reporter junit smoke-tests/test-a.ts ${DATA}`,
    why: "ACCEPTANCE: a test run naming the data file among its suites, whatever its flags",
  },
  {
    c: "bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts review-findings.json",
    why: "ACCEPTANCE: the verify-loop wrapper handed the data file as a suite",
  },
  {
    c: "sudo bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts review-findings.json",
    why: "ACCEPTANCE: the same behind a prefix word the arms never named",
  },
  { c: `bun test smoke-tests/test-${STORE}*.ts; rm ${DATA}`, why: "a chained removal" },
  {
    c: `bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts${NL}bun -e ${Q}x("${STORE}")${Q}`,
    why: "a newline inside a run that began as a test",
  },
  // A runtime reading its program from somewhere the guard cannot see.
  { c: `printf ${Q}import "./src/${STORE}.ts"${Q} | bun -`, why: "printf piped into bun -" },
  { c: `echo ${Q}import("./src/${STORE}.ts")${Q} | node -`, why: "echo piped into node -" },
  {
    c: `cat ${OB}payload.js${CB} | bun -`,
    why: "ACCEPTANCE: a stdin pipe whose brace word is an unreadable program on a runtime",
  },
  { c: `bun -e ${Q}import("./src/${STORE}.ts")${Q}`, why: "bun -e importing the store" },
  { c: `bun -p ${Q}import("./src/${STORE}.ts")${Q}`, why: "bun -p importing the store" },
  { c: `bun --print ${Q}require("./src/${STORE}.ts")${Q}`, why: "bun --print requiring the store" },
  {
    c: `bun -e ${Q}await (await import("./src/${STORE}.ts")).acceptRow({})${Q}`,
    why: "bun -e calling acceptRow",
  },
  { c: `bun x "./src/${STORE}.ts"`, why: "bun x on the store module, .ts suffix included" },
  {
    c: `git status${NL}bun -e ${Q}require("fs").writeFileSync("${STORE}", "")${Q}`,
    why: "git then a bun -e on the next line",
  },
  {
    c: `command bun -e ${Q}import("./src/${STORE}.ts")${Q}`,
    why: "a prefix word before the runtime",
  },
  { c: `env bun -e ${Q}import("./src/${STORE}.ts")${Q}`, why: "env before the runtime" },
  {
    c: `env BUN_ENV=test bun -e ${Q}import("./src/${STORE}.ts")${Q}`,
    why: "a runtime behind a prefix word beyond the second",
  },
  // Write-capable arguments, wherever they sit.
  { c: `git show HEAD:blob --output=${DATA}`, why: "spaced --output naming the data file" },
  { c: `git show HEAD:blob -o ${DATA}`, why: "spaced -o naming the data file" },
  { c: `git show HEAD:blob -o${DATA}`, why: "ATTACHED -o naming the data file" },
  { c: `cd /tmp; git show HEAD:blob -o${DATA}`, why: "chained git with an attached -o" },
  { c: `cd /tmp && git show HEAD:blob -o ${DATA}`, why: "chained git with a spaced -o" },
  { c: `git commit --all -o ${DATA}`, why: "a commit carrying an output flag" },
  {
    c: "git commit -m review-findings.json -c y.z=1",
    why: "a commit carrying a config override beside the store's name",
  },
];

// ── 4. documented over-refusals — clause (b)'s accepted costs, each asserted ───
//
// A string match cannot tell these from a genuine route, so the guard refuses rather
// than guesses. Each is the same shape as a real bypass, which is why no arm admits it.

export const OVER_REFUSALS: Case[] = [
  {
    c: "cat $({)review-findings.json$({)",
    why: "brace characters around the data name: EXPANSION refuses it before any arm reads it",
  },
  {
    c: "git show HEAD:review-findings.json --output=/tmp/readme.txt",
    why: "--output naming no protected file, beside the store's name",
  },
  { c: "git -c core.pager=cat review-findings.json log", why: "-c naming no file" },
  {
    c: "bun test extension/src/index.ts review-findings.json",
    why: "bun test on a non-test path, with the data file in the argument list",
  },
  {
    c: "bun smoke-tests/test-vipune-capability.ts review-findings.json",
    why: "a runtime running one script that names the data file",
  },
  {
    c: "PI_ENSEMBLE_VIPUNE_REQUIRED=1 bun smoke-tests/test-vipune-capability.ts review-findings.json",
    why: "the same with an env prefix — a runtime running one script that names the data file",
  },
  { c: `ls -p ${STORE}`, why: "ls naming the store" },
  { c: `grep -rn bun extension/src/${STORE}.ts`, why: "grep naming the store" },
  {
    c: `awk ${Q}{print ${DATA}}${Q}`,
    why: "awk is no longer a read tool at all — clause (c) removed the allowance",
  },
  {
    c: `sed -n ${Q}1,20p${Q} ${DATA}`,
    why: "sed is no longer a read tool at all — clause (c) removed the allowance",
  },
  {
    c: `sed -n ${Q}1,20p${Q} extension/src/${STORE}.ts`,
    why: "sed -n naming the store",
  },
  {
    c: "echo review-acceptance-notes",
    why: "a word STARTING with the script's stem — clause (c) prefers the over-refusal",
  },
  {
    c: `git log --oneline -- extension/src/${STORE}.ts`,
    why: "a git read whose path operand is the store module: a path SEGMENT whose last segment is a protected stem is refused",
  },
  {
    c: `git diff HEAD -- extension/src/${STORE}.ts`,
    why: "a git diff whose path operand is the store module — the same over-refusal as the log above",
  },
  {
    c: "gh api /repos/o/r --jq .name --output=review-findings.json",
    why: "gh api carries an arbitrary method and body: refused when the output names the store",
  },
];
