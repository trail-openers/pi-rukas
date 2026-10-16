#!/usr/bin/env bun
/**
 * #1125 — the guard routes the original scan missed.
 *
 * What reached the review findings store before the hardening:
 *
 *   1. plain git/gh was exempt as a block, so a git/gh line carrying an argument
 *      that writes a file (`--output`, `-o`, in spaced or attached form) or runs
 *      a shell (`-c alias.x='!…'`, `gh alias set`) was never scanned at all;
 *   2. the runtime pattern required the runtime and the protected name on the
 *      same line, so a here-doc (`bun <<EOF`, the `import` on line two) and a
 *      program piped into `bun -` both walked through — and the trailing
 *      lookahead rejected a `.ts` suffix, so a path-qualified module import
 *      named nothing;
 *   3. the plain-git exemption survived a `git rm` / `checkout` / `restore` of
 *      the findings data file, which deletes or overwrites the store outright.
 *
 * Each refusal below is one route; each allowance is a case the hardening must
 * not break. The rows marked OVER-REFUSAL are refused on purpose and asserted
 * as refusals so the deliberate cost stays visible — the module header names
 * each one. The base refusals (the operator script, eval flags, the edit tools)
 * are covered in test-review-accept.ts and test-review-accept-layers.ts.
 */

import { registerReviewAcceptGuard, runsReviewAccept } from "../src/review-accept-guard.ts";

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

type Case = { c: string; why: string };

/** Verdict, computed once per case and asserted against a literal expectation. */
function refused(c: string): boolean {
  return runsReviewAccept(c) !== undefined;
}

// ── route 1: git/gh arguments that write a file or run a shell ──────────────

const WRITE_ARG_REFUSALS: Case[] = [
  // `git show --output` writes the object it prints: the store, named, lands on disk.
  { c: `git show HEAD:blob --output=${DATA}`, why: "spaced --output naming the data file" },
  { c: `git show HEAD:blob -o ${DATA}`, why: "spaced -o naming the data file" },
  // The attached short forms: the value sits in the same token as the flag,
  // which is the shape the old `-o\b` never matched.
  { c: `git show HEAD:blob -o${DATA}`, why: "ATTACHED -o naming the data file" },
  { c: `git show HEAD:blob -c${DATA}`, why: "ATTACHED -c naming the data file" },
  // `-c` sets a config value, and an `!`-prefixed alias value is a shell command.
  { c: `git -c alias.dump='!cat /tmp/payload ${DATA}' dump`, why: "-c alias naming the data file" },
  // Aliases installed for the next plain invocation to run.
  { c: `gh alias set dump '!cat ${DATA}'`, why: "gh alias set" },
  { c: `gh config set alias.dump '!cat ${DATA}'`, why: "gh config set alias" },
  { c: `git config alias.dump '!cat ${DATA}'`, why: "git config alias." },
  // gh and glab carry the same flags, and neither is git.
  { c: `gh api /repos/o/r/contents/f --output=${DATA}`, why: "gh --output naming the data file" },
  { c: `glab api /projects/1 --output=${DATA}`, why: "glab --output naming the data file" },
];

// A chained command is not plain, so the ordinary scan judges it — and the
// ordinary scan has to know these arguments too.
const CHAINED_REFUSALS: Case[] = [
  { c: `cd /tmp; git show HEAD:blob -o${DATA}`, why: "chained git with an attached -o" },
  { c: `cd /tmp && git show HEAD:blob -o ${DATA}`, why: "chained git with a spaced -o" },
  { c: `cd /tmp; glab api /projects/1 --output=${DATA}`, why: "chained glab with --output" },
];

// route 1 must not over-reach: a write-capable argument that names no protected
// file is just a command, and prose inside quotes never revokes the exemption.
const WRITE_ARG_ALLOWANCES: Case[] = [
  {
    c: "git show HEAD:README.md --output=/tmp/readme.txt",
    why: "--output naming no protected file",
  },
  { c: "git -c core.pager=cat log --oneline", why: "-c naming no protected file" },
  { c: "gh api /repos/o/r --jq .name", why: "gh api with no write argument" },
  { c: "git log --oneline", why: "a plain log" },
  // The `-o` of a commit message is prose: quoted text is stripped before the
  // write-flag test, so a message cannot revoke its own exemption.
  {
    c: `git commit -m "fix: note ${DATA} with -o and --output words"`,
    why: "-o inside a quoted message",
  },
  {
    c: `git commit -m "feat: review-accept guard" -m 'runs on bun and names ${STORE}'`,
    why: "a second quoted message naming the script and the store",
  },
];

// ── route 2: destructive plain git on the data file ─────────────────────────

const DESTRUCTIVE_REFUSALS: Case[] = [
  { c: `git checkout ${DATA}`, why: "git checkout of the data file" },
  { c: `git restore ./${DATA}`, why: "git restore of the data file" },
  { c: `git rm .git/${DATA}`, why: "git rm of the data file" },
  { c: `git stash push -- ${DATA}`, why: "git stash of the data file" },
  { c: `git clean -f ${DATA}`, why: "git clean of the data file" },
];

// The reads the exemption exists for, including reads that name the store.
const VCS_ALLOWANCES: Case[] = [
  {
    c: `git commit -m "feat(review): record ${DATA} rows (#1105)"`,
    why: "a commit message naming the data file",
  },
  {
    c: `git commit -m "docs: explain the ${STORE} lifecycle"`,
    why: "a commit message naming the store",
  },
  { c: `git log --oneline -- extension/src/${STORE}.ts`, why: "git log naming the store module" },
  { c: `git diff HEAD -- extension/src/${STORE}.ts`, why: "git diff naming the store module" },
  { c: "git log --stat -3", why: "a plain stat log" },
  { c: "git diff HEAD -- extension/src/review-accept-guard.ts", why: "a diff of the guard itself" },
  { c: "gh pr view 1105", why: "gh pr view" },
  { c: "gh pr view --json number,title", why: "gh pr view --json" },
  { c: "glab mr view 1105", why: "glab mr view" },
];

// ── route 3: a runtime whose program is not on the runtime's own line ───────

const RUNTIME_REFUSALS: Case[] = [
  // A here-doc: the runtime on line one, the store import on line two.
  {
    c: `bun <<EOF\nimport { acceptFinding } from "./src/${STORE}.ts"\nacceptFinding("feat/x", "r1")\nEOF`,
    why: "here-doc importing the store",
  },
  {
    c: `bun <<'SH'\nconst s = await import("./extension/src/${STORE}.ts")\nSH`,
    why: "quoted here-doc with an async import",
  },
  // A program piped into the runtime: only the producer side names the store.
  { c: `printf 'import "./src/${STORE}.ts"' | bun -`, why: "printf piped into bun -" },
  { c: `echo 'import("./src/${STORE}.ts")' | node -`, why: "echo piped into node -" },
  // The eval forms — the program body never appears in the command string.
  { c: `bun -e 'import("./src/${STORE}.ts")'`, why: "bun -e importing the store" },
  { c: `bun -p 'import("./src/${STORE}.ts")'`, why: "bun -p importing the store" },
  { c: `bun --print 'require("./src/${STORE}.ts")'`, why: "bun --print requiring the store" },
  {
    c: `bun -e 'await (await import("./src/${STORE}.ts")).acceptRow({})'`,
    why: "bun -e calling acceptRow",
  },
  // A module path handed to the runtime directly; the `.ts` must not hide it.
  { c: `bun x "./src/${STORE}.ts"`, why: "bun x on the store module" },
  // A multi-line command whose second line is the route.
  {
    c: `git status\nbun -e 'require("fs").writeFileSync("${STORE}", "")'`,
    why: "git then a bun -e writing the store name",
  },
];

// A runtime alone, or a store name alone, is not a route.
const RUNTIME_ALLOWANCES: Case[] = [
  { c: "bun run build", why: "bun run build naming nothing" },
  { c: `grep -n accept extension/src/${STORE}.ts`, why: "grep on the store module" },
  { c: `awk '{print $1}' extension/src/${STORE}.ts`, why: "awk on the store module" },
  { c: "wc -l extension/src/review-findings-store.ts", why: "wc on the store module" },
  { c: `sed -n '1,20p' extension/src/${STORE}.ts`, why: "sed -n on the store module" },
  // A doc comment naming the runtime and the store is prose, not a route.
  {
    c: `echo '/** Run with bun; reads extension/src/${STORE}.ts. */'`,
    why: "a jsdoc comment naming bun and the store",
  },
];

// ── documented over-refusals ────────────────────────────────────────────────

// Each of these is refused on purpose. See WHAT IT DOES NOT COVER / KNOWN
// OVER-REFUSALS in the module header: the scan cannot tell a code fence, a
// table, or a regex literal from a command, so it refuses rather than guesses.
const OVER_REFUSALS: Case[] = [
  {
    c: "cat <<'MD'\n```bash\nbun run build\n```\nThe build reads extension/src/review-findings-store.ts\nMD",
    why: "OVER-REFUSAL: a fenced bun line then prose naming the store",
  },
  {
    c: `echo '| tool | file |\\n|---|---|\\n| bun | extension/src/${STORE}.ts |'`,
    why: "OVER-REFUSAL: a markdown table naming the store with bun in a cell",
  },
  {
    c: `echo '/bun|node|deno/' extension/src/${STORE}.ts`,
    why: "OVER-REFUSAL: a /bun|node|deno/ regex beside a store path",
  },
];

// ── assertions: no regex computes an expectation ────────────────────────────

for (const t of [...WRITE_ARG_REFUSALS, ...CHAINED_REFUSALS, ...DESTRUCTIVE_REFUSALS])
  assert(refused(t.c), `git/gh write-capable argument refused — ${t.why}`);
for (const t of WRITE_ARG_ALLOWANCES)
  assert(!refused(t.c), `git/gh read or quoted prose allowed — ${t.why}`);
for (const t of VCS_ALLOWANCES) assert(!refused(t.c), `plain git/gh read allowed — ${t.why}`);
for (const t of RUNTIME_REFUSALS) assert(refused(t.c), `runtime route refused — ${t.why}`);
for (const t of RUNTIME_ALLOWANCES)
  assert(!refused(t.c), `runtime naming nothing allowed — ${t.why}`);
for (const t of OVER_REFUSALS) assert(refused(t.c), `known over-refusal — ${t.why}`);

// The data file is refused wherever it appears, on its own.
for (const c of [`cat ${DATA}`, `sed -i 's/a/b/' ./.git/${DATA}`, `cp ${DATA} /tmp/x`])
  assert(refused(c), `naming the findings file is refused on its own — ${c.slice(0, 40)}`);

// ── the hook refuses with a named reason, in every mode ─────────────────────

const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
registerReviewAcceptGuard({
  on: (ev: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
    handlers[ev] = fn;
  },
} as never);

assert(typeof handlers.tool_call === "function", "hook: the guard registers a tool_call handler");

const call = async (command: string) =>
  (await handlers.tool_call({ toolName: "bash", input: { command } }, {})) as
    | { block?: boolean; reason?: string }
    | undefined;

for (const command of [
  `git show HEAD:blob --output=${DATA}`,
  `git show HEAD:blob -o${DATA}`,
  `bun <<EOF\nimport "./src/${STORE}.ts"\nEOF`,
]) {
  const verdict = await call(command);
  assert(
    verdict?.block === true && typeof verdict.reason === "string" && verdict.reason.length > 0,
    `hook: blocks the hardened route with a named reason — ${command.slice(0, 40)}`,
  );
}

for (const command of [
  `git commit -m "feat(review): record ${DATA} rows (#1105)"`,
  "gh pr view 1105",
  `git log --oneline -- extension/src/${STORE}.ts`,
]) {
  const verdict = await call(command);
  assert(
    verdict === undefined,
    `hook: leaves the allowed git/gh form alone — ${command.slice(0, 40)}`,
  );
}

// The remedy the refusal names: an ordinary read with the write argument gone.
const blocked = await call(`git show HEAD:blob --output=${DATA}`);
const allowed = await call("git show HEAD:README.md");
assert(
  blocked?.block === true && allowed === undefined,
  "hook: the same read is allowed once the write-capable argument is gone",
);

process.exit(exit);
