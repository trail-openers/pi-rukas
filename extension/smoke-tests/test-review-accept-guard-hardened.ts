#!/usr/bin/env bun
/**
 * #1125 — the deny-by-default accept guard: the exact read-only allowlist, and the
 * over-refusals clause (b) accepts as the cost of failing closed.
 *
 * There are no route-specific reasons any more: every refusal carries the SAME base
 * text (the accept CLI is the sanctioned path), plus one of two remedy sentences —
 * the vcs sentence when a write-capable flag is present, the data sentence when the
 * refusal is a path-operand one. Those two sentences are asserted here, once.
 *
 * The base refusals (the operator script, the edit tools) are covered in
 * test-review-accept.ts and test-review-accept-layers.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.url` rather than `import.meta.dir`: this suite is run under both bun and
// node, and only bun defines `dir`.
const HERE = dirname(fileURLToPath(import.meta.url));
import {
  editsFindingsFile,
  registerReviewAcceptGuard,
  runsReviewAccept,
} from "../src/review-accept-guard.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const STORE = "review-findings-store";
const DATA = "review-findings.json";
const NL = String.fromCharCode(10);
const Q = String.fromCharCode(39);

type Case = { c: string; why: string };

/** Verdict, computed once per case and asserted against a literal expectation. */
function refused(c: string): boolean {
  return runsReviewAccept(c) !== undefined;
}

// ── 1. the exact read-only allowlist (clause (a)) ─────────────────────────────

const ALLOWANCES: Case[] = [
  { c: "git status", why: "git status" },
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
  { c: "bun run build", why: "the exact build form" },
  { c: "bun run check", why: "the exact check form" },
  { c: "bunx tsc --noEmit", why: "the exact type-check form" },
  { c: "bun x tsc --noEmit", why: "the same form spelled with a space" },
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
  { c: "echo review-acceptance-notes", why: "a word containing the script name" },
  { c: "ls -la extension/src", why: "a read tool naming nothing protected" },
  { c: "cat extension/src/index.ts", why: "cat of an ordinary source file" },
];

// The repo's own develop gate must stay allowed, verbatim from .pi/verify-cmd.
function verifyCmdArms(): string[] {
  const file = join(HERE, "..", "..", ".pi", "verify-cmd");
  const body = readFileSync(file, "utf8");
  const lines = body
    .split(NL)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .join(NL);
  return lines
    .split("&&")
    .map((arm) => arm.replace(/^cd \S+$/, "").trim())
    .filter((arm) => arm && !arm.startsWith("cd ") && !arm.startsWith("bun run check"));
}

// ── 2. the #1125-mandated refusals ────────────────────────────────────────────

const MANDATED_REFUSALS: Case[] = [
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
  {
    c: `bun <<~EOF${NL}import "${STORE}"${NL}EOF`,
    why: "a tilde here-doc importing the store",
  },
  // Shell expansion hides the name from a string match, so no arm vouches for a word
  // carrying `$`, a backtick or a backslash: the guard cannot read what the shell will
  // substitute, and `$(…)` / `${V}` can ASSEMBLE a protected name the text never spells.
  {
    c: "cat $({)review-findings.json$({)",
    why: "ACCEPTANCE: cat of the data file assembled by brace expansion",
  },
  {
    c: `cat "a${"${DF}"}b"`,
    why: "ACCEPTANCE: a quoted word carrying a parameter expansion the guard cannot read",
  },
  {
    c: `cat ${Q}review-findings${Q}$(echo .json)${Q}`,
    why: "a command substitution glued to a quoted run of the store's name",
  },
  {
    c: "cat rev\\iew-findings.json",
    why: "an escaped word: the guard cannot tell what the shell hands to cat",
  },
  {
    c: "git log --oneline; cat `echo review-findings`.json",
    why: "a backtick-built store name in a chained segment",
  },
  // `gh api` is no longer an arm: it carries an arbitrary method and body, so no flag
  // ban turns it into a read (#1125: any command containing a forge CLI is refused).
  { c: "gh api -X DELETE /repos/o/r", why: "ACCEPTANCE: gh api DELETE" },
  { c: "gh api -X POST /repos/o/r/issues -f body=x", why: "ACCEPTANCE: gh api POST with a body" },
  { c: "gh api --method=DELETE /repos/o/r", why: "ACCEPTANCE: gh api with --method=DELETE" },
  { c: "gh api /repos/o/r", why: "ACCEPTANCE: bare gh api" },
  // A git read verb whose operand NAMES the store as a search term or a blob path.
  { c: `git log -- ${DATA}`, why: "ACCEPTANCE: git log with the data file as a path operand" },
  { c: `git show HEAD:${DATA}`, why: "ACCEPTANCE: git show of the data file's blob" },
  { c: `git log -S${DATA}`, why: "ACCEPTANCE: git log -S naming the data file" },
  { c: `git log --grep=${DATA}`, why: "git log --grep= naming the data file" },
  // A redirection moves bytes to or from a path no arm ever saw.
  {
    c: `git log --oneline > .git/${DATA}`,
    why: "ACCEPTANCE: a redirection writing the data file",
  },
  { c: `git log --oneline < .git/${DATA}`, why: "a redirection reading the data file" },
  { c: "git status > /tmp/out.txt", why: "a redirection no arm spells" },
];

const DENY_BY_DEFAULT_REFUSALS: Case[] = [
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
  { c: `sed -i 's/a/b/' ./.git/${DATA}`, why: "an in-place edit of the data file" },
  { c: `cp ${DATA} /tmp/x`, why: "a copy of the data file" },
  { c: `cp -r ${STORE} /tmp`, why: "a copy of the store module directory" },
  // A forge subcommand no arm spells.
  { c: `gh alias set dump ${Q}!cat ${DATA}${Q}`, why: "gh alias set" },
  { c: `gh config set alias.dump ${Q}!cat ${DATA}${Q}`, why: "gh config set alias" },
  { c: `git config alias.dump ${Q}!cat ${DATA}${Q}`, why: "git config alias." },
  { c: `gh api /repos/o/r/contents/f --output=${DATA}`, why: "gh --output naming the data file" },
  { c: `glab api /projects/1 --output=${DATA}`, why: "glab --output naming the data file" },
  {
    c: `gh pr create --body "Adds the review-accept acceptance path"`,
    why: "a gh write subcommand naming the script in prose",
  },
  // A test arm whose argv says something other than a suite.
  {
    c: `bun test smoke-tests/test-review-*.ts ${Q}bun ./src/${STORE}.ts${Q}`,
    why: "a quoted argument that is not a test path",
  },
  {
    c: `bash smoke-tests/lib/verify-loop.sh bun ${STORE}.ts`,
    why: "a bare word argument — the runner is handed something that is not a test",
  },
  { c: `bun test --reporter junit smoke-tests/test-${STORE}*.ts`, why: "a flag with a value" },
  {
    c: "bash smoke-tests/lib/verify-loop.sh --digest-mode on smoke-tests/test-*.ts",
    why: "a flag whose value is a separate word",
  },
  {
    c: "sudo bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts",
    why: "the arm requires bash as the first word",
  },
  { c: `bun test smoke-tests/test-${STORE}*.ts; rm ${DATA}`, why: "a chained removal" },
  {
    c: `bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts${NL}bun -e ${Q}x("${STORE}")${Q}`,
    why: "a newline inside a run that began as a test",
  },
  // A runtime reading its program from somewhere the guard cannot see.
  { c: `printf ${Q}import "./src/${STORE}.ts"${Q} | bun -`, why: "printf piped into bun -" },
  { c: `echo ${Q}import("./src/${STORE}.ts")${Q} | node -`, why: "echo piped into node -" },
  { c: "cat payload.js | bun -", why: "a stdin read: the program is the unreadable half" },
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
];

// ── 4. documented over-refusals — clause (b)'s accepted costs, each asserted ───
//
// A string match cannot tell these from a genuine route, so the guard refuses rather
// than guesses. Each is the same shape as a real bypass, which is why no arm admits it.

const OVER_REFUSALS: Case[] = [
  {
    c: "git show HEAD:README.md --output=/tmp/readme.txt",
    why: "--output naming no protected file",
  },
  { c: "git -c core.pager=cat log --oneline", why: "-c naming no protected file" },
  { c: "bun test src/index.ts", why: "bun test on a non-test path" },
  {
    c: `bun test ${STORE}.ts`,
    why: "bun test on the store module itself, which is not a test path",
  },
  { c: "bun smoke-tests/test-vipune-capability.ts", why: "a runtime running one script" },
  {
    c: "PI_ENSEMBLE_VIPUNE_REQUIRED=1 bun smoke-tests/test-vipune-capability.ts",
    why: "the same with an env prefix — a runtime running one script",
  },
  { c: `ls -p ${STORE}`, why: "ls naming the store" },
  { c: `grep -rn bun extension/src/${STORE}.ts`, why: "grep naming the store" },
  { c: `awk ${Q}{print $1}${Q} extension/src/${STORE}.ts`, why: "awk naming the store" },
  { c: `wc -l extension/src/${STORE}.ts`, why: "wc naming the store" },
  { c: `sed -n ${Q}1,20p${Q} extension/src/${STORE}.ts`, why: "sed -n naming the store" },
  {
    c: `git log --oneline -- extension/src/${STORE}.ts`,
    why: "a git read whose path operand is the store module (#1125 fix round: a path SEGMENT whose last segment is a protected stem is refused; name the module by a path the guard can read, or run the read through a tool)",
  },
  {
    c: `git diff HEAD -- extension/src/${STORE}.ts`,
    why: "a git diff whose path operand is the store module — the same over-refusal as the log above",
  },
  {
    c: "gh api /repos/o/r --jq .name",
    why: "gh api is no longer an arm at all: it carries an arbitrary method and body, so every gh api is refused",
  },
];

// ── assertions ────────────────────────────────────────────────────────────────

for (const t of ALLOWANCES) assert(!refused(t.c), `allowed — ${t.why}`);
for (const t of MANDATED_REFUSALS) assert(refused(t.c), `mandated refusal — ${t.why}`);
for (const t of DENY_BY_DEFAULT_REFUSALS) assert(refused(t.c), `refused — ${t.why}`);
for (const t of OVER_REFUSALS) assert(refused(t.c), `known over-refusal — ${t.why}`);

// The repo's own develop gate is allowed verbatim.
for (const arm of verifyCmdArms())
  assert(!refused(arm), `.pi/verify-cmd arm allowed — ${arm.slice(0, 60)}`);

// ── the edit tools ────────────────────────────────────────────────────────────

const storeFile = `/repo/.git/${DATA}`;
assert(editsFindingsFile("edit", { path: storeFile }) === storeFile, "edit of the findings file");
assert(
  editsFindingsFile("write", { path: `${storeFile}.corrupt-123` }) !== undefined,
  "write of a corrupt-copy sibling",
);
assert(
  editsFindingsFile("multiedit", { path: `${storeFile}.tmp` }) !== undefined,
  "multiedit of a .tmp sibling",
);
assert(
  editsFindingsFile("edit", { path: "/repo/extension/src/review-findings-store.ts" }) !== undefined,
  "edit of the store module's own source is refused (#1125)",
);
assert(
  editsFindingsFile("multiedit", { path: "/repo/src/a.ts" }) === undefined,
  "edit of an unrelated file is allowed",
);
assert(editsFindingsFile("read", { path: storeFile }) === undefined, "reading is not an edit");
assert(
  editsFindingsFile("write", { path: "/repo/src/review-accept-guard.ts" }) === undefined,
  "editing the guard itself is allowed",
);
assert(
  editsFindingsFile("write", { path: `${storeFile}.bak` }) === undefined,
  "a different file with a similar name is not the store",
);

// ── the hook: one base reason, plus at most the two remedy sentences ────────────

const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
registerReviewAcceptGuard({
  on: (ev: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
    handlers[ev] = fn;
  },
} as never);

assert(typeof handlers.tool_call === "function", "hook: a tool_call handler is registered");

const call = async (command: string) =>
  (await handlers.tool_call({ toolName: "bash", input: { command } }, {})) as
    | { block?: boolean; reason?: string }
    | undefined;

const VCS_SENTENCE = "-o/--output/-c";
const DATA_SENTENCE = "path operand naming the store";

const writeBlocked = await call(`git show HEAD:blob --output=${DATA}`);
assert(
  writeBlocked?.block === true && (writeBlocked.reason ?? "").includes(VCS_SENTENCE),
  "hook: the vcs route names the write-capable argument to drop",
);
assert(
  (writeBlocked?.reason ?? "").includes("git --no-pager log"),
  "hook: the vcs remedy carries no -c in its example",
);
const dataBlocked = await call(`git add ${DATA}`);
assert(
  dataBlocked?.block === true &&
    (dataBlocked.reason ?? "").includes(DATA_SENTENCE) &&
    !(dataBlocked.reason ?? "").includes(VCS_SENTENCE),
  "hook: the data route speaks of path operands, not of write flags",
);
const runtimeBlocked = await call(`bun -e ${Q}import("./src/${STORE}.ts")${Q}`);
assert(
  runtimeBlocked?.block === true &&
    !(runtimeBlocked.reason ?? "").includes(VCS_SENTENCE) &&
    !(runtimeBlocked.reason ?? "").includes(DATA_SENTENCE),
  "hook: the runtime route adds neither remedy sentence",
);
for (const command of [
  "bun extension/scripts/review-accept.ts feat/x deadbeef --reason x",
  `bun <<EOF${NL}import { acceptFinding } from "./src/${STORE}.ts"${NL}EOF`,
]) {
  const v = await call(command);
  assert(
    v?.block === true && (v.reason ?? "").includes("extension/scripts/review-accept.ts"),
    `hook: every refusal names the sanctioned accept CLI — ${command.slice(0, 32)}`,
  );
}

for (const command of [
  `git commit -m "clean up the ${DATA} handling"`,
  "gh pr view 1105",
  `bun test smoke-tests/test-${STORE}*.ts`,
]) {
  const verdict = await call(command);
  assert(verdict === undefined, `hook: leaves the allowed form alone — ${command.slice(0, 44)}`);
}

const blockedRead = await call(`git show HEAD:blob --output=${DATA}`);
const cleanRead = await call("git show HEAD:README.md");
assert(
  blockedRead?.block === true && cleanRead === undefined,
  "hook: the same read is allowed once the write-capable argument is gone",
);

process.exit(exit);
