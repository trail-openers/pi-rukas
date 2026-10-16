#!/usr/bin/env bun
/**
 * #1125 — the guard routes round 3 closed, and the shapes it must keep allowing.
 *
 * Each refusal below is one route; each allowance is a case the hardening must not
 * break. The rows marked OVER-REFUSAL are refused ON PURPOSE and asserted as refusals
 * so the deliberate cost stays visible — the module header counts them and names each.
 * The base refusals (the operator script, eval flags, the edit tools) are covered in
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

type Case = { c: string; why: string };

/** Verdict, computed once per case and asserted against a literal expectation. */
function refused(c: string): boolean {
  return runsReviewAccept(c) !== undefined;
}

// ── 1. unbalanced quotes are judged on the RAW command (fail closed) ─────────
//
// `quotedOff` strips only BALANCED segments. With an odd number of `'` or `"` the
// text cannot be parsed as prose, so every route falls back to the raw command
// rather than guessing the benign reading.

const UNBALANCED_REFUSALS: Case[] = [
  {
    c: `git commit -m "prose${NL}bun -e 'import("./src/${STORE}.ts")'`,
    why: "odd double quote hiding a bun -e that imports the store",
  },
  {
    c: `git status && echo 'x; bun -e rm ${DATA}`,
    why: "odd single quote hiding a runtime and the data file",
  },
  { c: `git commit -m "prose ${DATA}`, why: "odd quote naming the data file" },
  { c: `git commit -m 'it''s about ${DATA}`, why: "doubled single quotes around the data file" },
];

// The same quote rules must NOT turn ordinary prose into a route: a balanced quoted
// message that names the store stays a commit message.
const UNBALANCED_ALLOWANCES: Case[] = [
  { c: `git commit -m "prose about ${STORE}"`, why: "balanced quotes naming the store" },
  {
    c: `git commit -m "feat: guard 'quoted' words in ${STORE} messages"`,
    why: "balanced single quotes nested inside a balanced double-quoted message",
  },
  { c: `echo "it's a normal message about ${STORE}"`, why: "an apostrophe inside a message" },
];

// ── 2. the test-run exemption is conditional, on the RAW command ──────────────
//
// `bun test` / `bash …/verify-loop.sh` is exempt as a read-only suite, but an
// operator character or a newline anywhere — even inside quotes — revokes it, and
// every argument must be a test path/glob or a `--digest`-style flag.

const TEST_RUN_REFUSALS: Case[] = [
  {
    c: `bun test smoke-tests/test-review-*.ts 'bun ./src/${STORE}.ts'`,
    why: "a quoted argument that is not a test path",
  },
  {
    c: `bash smoke-tests/lib/verify-loop.sh bun ${STORE}.ts`,
    why: "a bare word argument — the runner is handed something that is not a test",
  },
  {
    c: `bun test --reporter junit smoke-tests/test-${STORE}*.ts`,
    why: "a flag shape the exemption does not recognise",
  },
  {
    c: `bash smoke-tests/lib/verify-loop.sh --digest-mode on smoke-tests/test-*.ts`,
    why: "a flag whose value is a separate word",
  },
  {
    c: `sudo bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts`,
    why: "the exemption requires bash as the first word",
  },
  { c: `bun test smoke-tests/test-${STORE}*.ts; rm ${DATA}`, why: "a chained removal" },
  {
    c: `bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts${NL}bun -e 'x("${STORE}")'`,
    why: "a newline inside a run that began as a test",
  },
];

const TEST_RUN_ALLOWANCES: Case[] = [
  { c: `bun test smoke-tests/test-${STORE}*.ts`, why: "a glob naming the store's test file" },
  { c: `bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts`, why: "the offline glob" },
  {
    c: `bash smoke-tests/lib/verify-loop.sh smoke-tests/test-${STORE}*.ts --digest`,
    why: "a --digest-style switch",
  },
  {
    c: `bash smoke-tests/lib/verify-loop.sh --digest smoke-tests/test-review-accept.ts`,
    why: "--digest before the file list",
  },
  {
    c: `bun test smoke-tests/test-review-accept-guard-hardened.ts`,
    why: "one named test file",
  },
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

// ── 3. the data file dominates plain git ──────────────────────────────────────
//
// The plain-git exemption exists for PROSE arguments. A path operand is not prose,
// so `git add <data>` is refused and a commit message naming it is not — the
// difference is whether the name survives quote removal.

const DATA_OPERAND_REFUSALS: Case[] = [
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
];

const DATA_PROSE_ALLOWANCES: Case[] = [
  {
    c: `git commit -m "clean up the ${DATA} handling"`,
    why: "the data file named inside a quoted message, with a verb inside the quote",
  },
  { c: `git commit -m "add ${DATA} and rm it"`, why: "destructive verbs inside a quote" },
  { c: `git commit -am "note ${DATA}"`, why: "flags plus a quoted data mention" },
  {
    c: `git commit -m "feat(review): record ${DATA} rows (#1105)"`,
    why: "a commit message naming the data file",
  },
  { c: `git commit -m "docs: explain the ${STORE} lifecycle"`, why: "a message naming the store" },
];

// ── 4. a runtime only counts in invocation position ───────────────────────────
//
// The first or second word of the command or of a segment after `|`, `;`, `&`, `(` or
// a newline. `grep -rn bun <store>` has `bun` as a grep PATTERN; `bun -e` has it as
// the program to run.

const POSITION_ALLOWANCES: Case[] = [
  { c: `grep -rn bun extension/src/${STORE}.ts`, why: "bun as a grep pattern" },
  { c: `git grep -e bun -- extension/src/${STORE}.ts`, why: "bun as a git-grep pattern" },
  { c: `grep -r accept ${STORE}`, why: "a grep for accept naming the store" },
  { c: `cp -r ${STORE} /tmp`, why: "cp -r whose -r is not a runtime" },
  { c: `ls -p ${STORE}`, why: "ls -p naming the store" },
  { c: `printf 'x' | bun -y`, why: "bun -y: a STANDALONE - is the stdin read, -y is not" },
  { c: `cat payload.js | bun -`, why: "a stdin read naming nothing" },
  { c: `bun run build`, why: "bun run build naming nothing" },
  { c: `awk '{print $1}' extension/src/${STORE}.ts`, why: "awk on the store module" },
  { c: `wc -l extension/src/${STORE}.ts`, why: "wc on the store module" },
  { c: `sed -n '1,20p' extension/src/${STORE}.ts`, why: "sed -n on the store module" },
  {
    c: `echo '/** Run with bun; reads extension/src/${STORE}.ts. */'`,
    why: "a jsdoc comment naming bun and the store",
  },
  { c: `echo review-acceptance-notes`, why: "a word containing the script name" },
  { c: `git commit -m "feat: review-accept guard"`, why: "a commit naming the operator script" },
  {
    c: `gh pr create --body "Adds the review-accept acceptance path"`,
    why: "a PR body naming the operator script",
  },
];

const RUNTIME_REFUSALS: Case[] = [
  {
    c: `bun <<EOF${NL}import { acceptFinding } from "./src/${STORE}.ts"${NL}EOF`,
    why: "here-doc importing the store",
  },
  {
    c: `bun <<'SH'${NL}const s = await import("./extension/src/${STORE}.ts")${NL}SH`,
    why: "quoted here-doc with an async import",
  },
  { c: `printf 'import "./src/${STORE}.ts"' | bun -`, why: "printf piped into bun -" },
  { c: `echo 'import("./src/${STORE}.ts")' | node -`, why: "echo piped into node -" },
  { c: `bun -e 'import("./src/${STORE}.ts")'`, why: "bun -e importing the store" },
  { c: `bun -p 'import("./src/${STORE}.ts")'`, why: "bun -p importing the store" },
  { c: `bun --print 'require("./src/${STORE}.ts")'`, why: "bun --print requiring the store" },
  {
    c: `bun -e 'await (await import("./src/${STORE}.ts")).acceptRow({})'`,
    why: "bun -e calling acceptRow",
  },
  { c: `bun x "./src/${STORE}.ts"`, why: "bun x on the store module, .ts suffix included" },
  {
    c: `git status${NL}bun -e 'require("fs").writeFileSync("${STORE}", "")'`,
    why: "git then a bun -e on the next line",
  },
  { c: `command bun -e 'import("./src/${STORE}.ts")'`, why: "a prefix word before the runtime" },
  { c: `env bun -e 'import("./src/${STORE}.ts")'`, why: "env before the runtime" },
];

// ── 5. git/gh arguments that write a file or run a shell ─────────────────────

const WRITE_ARG_REFUSALS: Case[] = [
  { c: `git show HEAD:blob --output=${DATA}`, why: "spaced --output naming the data file" },
  { c: `git show HEAD:blob -o ${DATA}`, why: "spaced -o naming the data file" },
  { c: `git show HEAD:blob -o${DATA}`, why: "ATTACHED -o naming the data file" },
  { c: `git show HEAD:blob -c${DATA}`, why: "ATTACHED -c naming the data file" },
  {
    c: `git -c alias.dump='!cat /tmp/payload ${DATA}' dump`,
    why: "-c alias whose value is a shell command naming the data file",
  },
  { c: `gh alias set dump '!cat ${DATA}'`, why: "gh alias set" },
  { c: `gh config set alias.dump '!cat ${DATA}'`, why: "gh config set alias" },
  { c: `git config alias.dump '!cat ${DATA}'`, why: "git config alias." },
  { c: `gh api /repos/o/r/contents/f --output=${DATA}`, why: "gh --output naming the data file" },
  { c: `glab api /projects/1 --output=${DATA}`, why: "glab --output naming the data file" },
  { c: `cd /tmp; git show HEAD:blob -o${DATA}`, why: "chained git with an attached -o" },
  { c: `cd /tmp && git show HEAD:blob -o ${DATA}`, why: "chained git with a spaced -o" },
  { c: `cd /tmp; glab api /projects/1 --output=${DATA}`, why: "chained glab with --output" },
  { c: `git commit --all -o ${DATA}`, why: "an argument that only LOOKS like a write flag" },
];

const VCS_ALLOWANCES: Case[] = [
  { c: `git show HEAD:README.md --output=/tmp/readme.txt`, why: "--output naming no protected file" },
  { c: `git -c core.pager=cat log --oneline`, why: "-c naming no protected file" },
  { c: `gh api /repos/o/r --jq .name`, why: "gh api with no write argument" },
  { c: `git log --oneline`, why: "a plain log" },
  { c: `git --no-pager log --oneline`, why: "the remedy the refusal names" },
  { c: `git log --oneline -- extension/src/${STORE}.ts`, why: "git log naming the store module" },
  { c: `git diff HEAD -- extension/src/${STORE}.ts`, why: "git diff naming the store module" },
  { c: `git diff HEAD -- extension/src/review-accept-guard.ts`, why: "a diff of the guard itself" },
  { c: `gh pr view 1105`, why: "gh pr view" },
  { c: `gh pr view --json number,title`, why: "gh pr view --json" },
  { c: `glab mr view 1105`, why: "glab mr view" },
  { c: "git status", why: "git status" },
];

// ── 6. documented over-refusals ───────────────────────────────────────────────
//
// A string match cannot tell these from a command, so the guard refuses rather than
// guesses. The module header's count must match this list's length.

const OVER_REFUSALS: Case[] = [
  {
    c: `cat <<'MD'${NL}\`\`\`bash${NL}bun run build${NL}\`\`\`${NL}The build reads extension/src/${STORE}.ts${NL}MD`,
    why: "OVER-REFUSAL 1: a fenced bun line then prose naming the store",
  },
  {
    c: `echo '| tool | file |${NL}|---|---|${NL}| bun | extension/src/${STORE}.ts |'`,
    why: "OVER-REFUSAL 2: a markdown table whose cells hold | and name the store",
  },
  {
    c: `echo '/bun|node|deno/' extension/src/${STORE}.ts`,
    why: "OVER-REFUSAL 3: a /bun|node|deno/ regex beside a store path",
  },
  {
    c: `git commit -m 'it''s about ${DATA}`,
    why: "OVER-REFUSAL 4: odd quoting judged on the raw command",
  },
  {
    c: `git commit --all -o ${DATA}`,
    why: "OVER-REFUSAL 5: an argument that only looks like a write flag",
  },
  {
    c: `bun test --reporter junit smoke-tests/test-${STORE}*.ts`,
    why: "OVER-REFUSAL 6: a test flag the exemption does not recognise",
  },
  {
    c: `bash smoke-tests/lib/verify-loop.sh --digest-mode on smoke-tests/test-*.ts`,
    why: "OVER-REFUSAL 7: a flag whose value is a separate word",
  },
  {
    c: `env BUN_ENV=test bun -e 'import("./src/${STORE}.ts")'`,
    why: "OVER-REFUSAL 8: a runtime behind a prefix word beyond the second",
  },
];

// ── assertions ────────────────────────────────────────────────────────────────

const REFUSALS = [
  ...UNBALANCED_REFUSALS,
  ...TEST_RUN_REFUSALS,
  ...DATA_OPERAND_REFUSALS,
  ...RUNTIME_REFUSALS,
  ...WRITE_ARG_REFUSALS,
];
const ALLOWANCES = [
  ...UNBALANCED_ALLOWANCES,
  ...TEST_RUN_ALLOWANCES,
  ...DATA_PROSE_ALLOWANCES,
  ...POSITION_ALLOWANCES,
  ...VCS_ALLOWANCES,
];

for (const t of REFUSALS) assert(refused(t.c), `refused — ${t.why}`);
for (const t of ALLOWANCES) assert(!refused(t.c), `allowed — ${t.why}`);
for (const t of OVER_REFUSALS) assert(refused(t.c), `known over-refusal — ${t.why}`);

// The over-refusal count the header publishes is this list's length.
const header = readFileSync(join(HERE, "..", "src", "review-accept-guard.ts"), "utf8");
const declared = /KNOWN OVER-REFUSALS — (\d+)/.exec(header)?.[1];
assert(
  declared === String(OVER_REFUSALS.length),
  `header over-refusal count (${declared}) matches the asserted list (${OVER_REFUSALS.length})`,
);

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

// ── the hook refuses with a named reason, per route ───────────────────────────

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

// The write-flag remedy sentence belongs to the vcs-write route only.
const writeBlocked = await call(`git show HEAD:blob --output=${DATA}`);
assert(
  writeBlocked?.block === true && (writeBlocked.reason ?? "").includes("--output/-o/-c"),
  "hook: the vcs-write route names the write-capable argument to drop",
);
assert(
  (writeBlocked?.reason ?? "").includes("git --no-pager log"),
  "hook: the vcs-write remedy carries no -c in its example",
);
const dataBlocked = await call(`git add ${DATA}`);
assert(
  dataBlocked?.block === true &&
    (dataBlocked.reason ?? "").includes("path operand") &&
    !(dataBlocked.reason ?? "").includes("--output/-o/-c"),
  "hook: the data route speaks of path operands, not of write flags",
);
const runtimeBlocked = await call(`bun -e 'import("./src/${STORE}.ts")'`);
assert(
  runtimeBlocked?.block === true && !(runtimeBlocked.reason ?? "").includes("--output/-o/-c"),
  "hook: the runtime route does not tell the agent to drop a write flag",
);

for (const command of [
  `git commit -m "clean up the ${DATA} handling"`,
  `gh pr view 1105`,
  `git log --oneline -- extension/src/${STORE}.ts`,
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
