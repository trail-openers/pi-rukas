#!/usr/bin/env bun
/**
 * #1125 — the guard routes the original scan missed.
 *
 * Two shapes reached the review findings store past review-accept-guard.ts:
 *
 *   1. plain git/gh was exempt as a block, so a git/gh line carrying an
 *      argument that writes a file (`--output`, `-o`) or runs a shell alias
 *      (`-c alias.x='!…'`) was never scanned at all;
 *   2. the runtime pattern required the runtime and the protected name on the
 *      same line, so a here-doc (`bun <<EOF`, the `import` on line two) and a
 *      program piped into `bun -` both walked through — and the trailing
 *      lookahead rejected a `.ts` suffix, so a path-qualified module import
 *      (`import "./src/review-findings-store.ts"`) named nothing.
 *
 * Each refusal below is one route; each allowance is a case the hardening must
 * not break — the plain git/gh reads and prose arguments that exemption
 * exists for. The base refusals (the operator script, eval flags, the edit
 * tools) are covered in test-review-accept.ts and test-review-accept-layers.ts.
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

// ── route 1: git/gh arguments that write a file or run a shell ──────────────

for (const c of [
  // `git show --output` writes the object it prints: the store, named, lands on disk.
  `git show HEAD:blob --output=${DATA}`,
  // The short form of the same flag.
  `git show HEAD:blob -o ${DATA}`,
  // `-c` sets a config value, and an `!`-prefixed alias value is a shell command.
  `git -c alias.dump='!cat /tmp/payload ${DATA}' dump`,
  // gh carries the same --output flag, and gh is not git.
  `gh api /repos/o/r/contents/f --output=${DATA}`,
]) {
  assert(
    runsReviewAccept(c) !== undefined,
    `git/gh: a file-writing or alias argument that names the store is refused — ${c.slice(0, 46)}`,
  );
}

// The exemption is revoked by the ARGUMENT SHAPE, not by the word "git": a
// file-writing argument that names no store route is just a command.
for (const c of [
  "git show HEAD:README.md --output=/tmp/readme.txt",
  "git -c core.pager=cat log --oneline",
  "gh api /repos/o/r --jq .name",
]) {
  assert(
    runsReviewAccept(c) === undefined,
    `git/gh: a file-writing argument that names no store path is allowed — ${c.slice(0, 46)}`,
  );
}

// ── route 2: a runtime whose program is not on the runtime's own line ───────

for (const c of [
  // A here-doc: the runtime on line one, the store import on line two.
  `bun <<EOF\nimport { acceptFinding } from "./src/${STORE}.ts"\nacceptFinding("feat/x", "r1")\nEOF`,
  // A quoted here-doc delimiter, and the async import form.
  `bun <<'SH'\nconst s = await import("./extension/src/${STORE}.ts")\nSH`,
  // A program piped into the runtime: only the producer side names the store.
  `printf 'import "./src/${STORE}.ts"' | bun -`,
  `echo 'import("./src/${STORE}.ts")' | node -`,
  // The eval form naming the store by path — the `.ts` suffix must not hide it.
  `bun -e 'import("./src/${STORE}.ts")'`,
  // A module path handed to the runtime directly.
  `bun x "./src/${STORE}.ts"`,
]) {
  assert(
    runsReviewAccept(c) !== undefined,
    `runtime: a multi-line/stdin program importing the store is refused — ${c.slice(0, 46)}`,
  );
}

// A runtime alone, or a store name alone, is not a route: the refusal needs
// both halves, whichever line each sits on.
for (const c of [
  "bun -",
  "cat payload.js | bun -",
  "node -",
  "bun run build",
  `cat ${DATA}`,
  `sed -i 's/a/b/' ./.git/${DATA}`,
]) {
  const isStoreOnly = !/\b(?:bun|bunx|node|npx|tsx|ts-node|deno)\b/.test(c);
  if (isStoreOnly) {
    // The data file itself is always refused — that is the original rule.
    assert(
      runsReviewAccept(c) !== undefined,
      `data file: naming the findings file is refused on its own — ${c.slice(0, 46)}`,
    );
  } else {
    assert(
      runsReviewAccept(c) === undefined,
      `runtime: a runtime that names no store path is allowed — ${c.slice(0, 46)}`,
    );
  }
}

// ── what the exemption must still allow ─────────────────────────────────────

for (const c of [
  `git commit -m "feat(review): record ${DATA} rows (#1105)"`,
  `git commit -m "docs: explain the ${STORE} lifecycle"`,
  `git log --oneline -- extension/src/${STORE}.ts`,
  "git log --stat -3",
  "git diff HEAD -- extension/src/review-accept-guard.ts",
  "gh pr view 1105",
  "gh pr view --json number,title",
]) {
  assert(
    runsReviewAccept(c) === undefined,
    `allowed: a plain git/gh read or prose argument is left alone — ${c.slice(0, 46)}`,
  );
}

// ── the hook refuses with a named reason, in every mode ─────────────────────

const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
registerReviewAcceptGuard({
  on: (ev: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
    handlers[ev] = fn;
  },
} as never);

for (const command of [
  `git show HEAD:blob --output=${DATA}`,
  `bun <<EOF\nimport "./src/${STORE}.ts"\nEOF`,
]) {
  const verdict = (await handlers.tool_call?.({ toolName: "bash", input: { command } }, {})) as
    | { block?: boolean; reason?: string }
    | undefined;
  assert(
    verdict?.block === true && typeof verdict.reason === "string" && verdict.reason.length > 0,
    `hook: blocks the hardened route with a named reason — ${command.slice(0, 40)}`,
  );
}

for (const command of [
  `git commit -m "feat(review): record ${DATA} rows (#1105)"`,
  "gh pr view 1105",
]) {
  const verdict = (await handlers.tool_call?.({ toolName: "bash", input: { command } }, {})) as
    | { block?: boolean }
    | undefined;
  assert(
    verdict === undefined,
    `hook: leaves the allowed git/gh form alone — ${command.slice(0, 40)}`,
  );
}

process.exit(exit);
