#!/usr/bin/env bun
/**
 * scripts/check-comment-only — an AUTHOR AND REVIEWER TOOL for comment-only
 * changes, run by hand and quoted in the PR.
 *
 * Nothing in CI runs it. It is not a gate: no workflow, no verify step and no
 * smoke test invokes this file, so its absence from a CI log means nothing and
 * its OK on a laptop is not evidence a branch is mergeable. The reviewer reads
 * the output the PR quotes, the same way the reviewer reads a test transcript.
 *
 * What it proves: the emitted JavaScript of every changed `extension/src/lean`
 * file is byte-identical between base and head.
 *
 * What that proof does NOT cover — everything the emitter throws away:
 *   - comments, whitespace and formatting (that is the point of the tool);
 *   - ALL type-position syntax — annotations, generics, interfaces, `satisfies`,
 *     type-only imports. A change there is invisible to the comparison, so
 *     `tsc --noEmit` is the gate that covers types, never this tool;
 *   - correctness, style or intent. Identical output only means identical
 *     emitted bytes.
 *
 * Usage (run from anywhere; paths are resolved from this file's location):
 *
 *   bun extension/scripts/check-comment-only.ts               # origin/main HEAD
 *   bun extension/scripts/check-comment-only.ts <base> <head>
 *   bun extension/scripts/check-comment-only.ts --help
 *
 * Exactly 0 or 2 positional refs are accepted; anything else is a FAIL with a
 * usage line, and `--help` prints usage and exits 2.
 *
 * Both sides are read from git objects — the roster from
 * `git diff --name-only <base> <head>` and each side's bytes from
 * `git show <rev>:<path>` — so the check judges committed bytes and nothing in
 * the working tree can be mistaken for a verified side. An empty roster is a
 * FAIL, not a pass: zero changed files proves nothing about a branch. A ref git
 * cannot read is a FAIL naming the ref and git's own stderr, and a `git show`
 * that fails for any reason other than the path being absent on that side is a
 * FAIL naming git's stderr too — only git's own "does not exist" /
 * "exists on disk, but not in" wording is read as a one-sided file. Syntax
 * errors on either side are a FAIL: unparseable source has no meaningful
 * transpiled output to compare, so both sides' parse diagnostics are collected
 * before any comparison happens.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import ts from "typescript";

const LEAN_SCOPE = "extension/src/lean";
const DEFAULT_BASE = "origin/main";
const DEFAULT_HEAD = "HEAD";

/** A git read is bounded: no wedged credential prompt and no unbounded buffer. */
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

/**
 * The git env with the ambient overrides dropped. `GIT_DIR` & friends are
 * inherited inside worktrees and hook environments, where they would point
 * `git show` at some repository other than this one.
 */
const GIT_ENV = (() => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", HOME: process.env.HOME ?? "/" };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_CONFIG_GLOBAL",
  ]) {
    delete env[key];
  }
  return env;
})();

const USAGE = [
  "usage: bun extension/scripts/check-comment-only.ts [<base> <head>]",
  `  no refs    → ${DEFAULT_BASE} ${DEFAULT_HEAD}`,
  "  two refs   → base and head, both git revisions",
  "  --help     → this usage (exit 2)",
  "Exactly 0 or 2 positional refs are accepted.",
].join("\n");

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(2);
}

const require = createRequire(import.meta.url);
const EXTENSION_ROOT = path.join(import.meta.dirname, "..");

/**
 * The typescript this tool transpiles with, resolved out of `extension/node_modules`
 * rather than through the import map, so the tool uses the same typescript the project's
 * `tsc` gate does. The require is still checked: a module without the two functions this
 * tool calls is a FAIL naming the path, not a TypeError at the first call site.
 */
function loadTypescript(): typeof ts {
  const entry = path.join(EXTENSION_ROOT, "node_modules", "typescript", "lib", "typescript.js");
  let mod: unknown;
  try {
    mod = require(entry);
  } catch (error) {
    console.log(`FAIL: could not load typescript from ${entry}: ${String(error)}`);
    process.exit(1);
  }
  const candidate = mod as { transpileModule?: unknown; createSourceFile?: unknown };
  if (typeof candidate.transpileModule !== "function") {
    console.log(`FAIL: ${entry} does not export transpileModule`);
    process.exit(1);
  }
  if (typeof candidate.createSourceFile !== "function") {
    console.log(`FAIL: ${entry} does not export createSourceFile`);
    process.exit(1);
  }
  return mod as typeof ts;
}

const typescript = loadTypescript();

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: GIT_ENV,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
  });
}

/** Git's own message on stderr ("unknown revision", "not a git repository", …). */
function gitStderr(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr;
  const text = typeof stderr === "string" ? stderr : (stderr?.toString("utf8") ?? "");
  return text.trim() || String(error);
}

/** Fail the run naming the ref and what git said, never a raw stack. */
function failRef(ref: string, error: unknown): never {
  console.log(`FAIL: ref ${ref} could not be read: ${gitStderr(error)}`);
  process.exit(1);
}

function readRev(ref: string, repoRoot: string): void {
  try {
    git(["-C", repoRoot, "rev-parse", "--verify", `${ref}^{commit}`]);
  } catch (error) {
    failRef(ref, error);
  }
}

function tsFiles(lines: string[]): string[] {
  return [...new Set(lines.filter((line) => line.endsWith(".ts")))].sort();
}

function changedLeanFiles(base: string, head: string, repoRoot: string): string[] {
  const out = git(["-C", repoRoot, "diff", "--name-only", base, head, "--", LEAN_SCOPE]);
  return tsFiles(out.split("\n"));
}

/**
 * Git's wording for "this path is not on that side" — a rename or an add/delete,
 * reported as a one-sided file. Anything else git printed on a failed read is a
 * failure of the read, not an absent blob.
 */
function isMissingBlob(stderr: string): boolean {
  return stderr.includes("does not exist") || stderr.includes("exists on disk, but not in");
}

function contentFromGit(
  rev: string,
  file: string,
  repoRoot: string,
): { text?: string; gitFailed: boolean; stderr: string } {
  try {
    return { text: git(["-C", repoRoot, "show", `${rev}:${file}`]), gitFailed: false, stderr: "" };
  } catch (error) {
    const stderr = gitStderr(error);
    return isMissingBlob(stderr)
      ? { gitFailed: false, stderr }
      : { gitFailed: true, stderr: stderr || `git show ${rev}:${file} failed` };
  }
}

function parseDiagnosticsOf(source: string, file: string, side: string): string[] {
  const sourceFile = typescript.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  // `parseDiagnostics` is populated by `createSourceFile` but is not in the public
  // .d.ts; the narrow cast names the one internal field this tool reads.
  const diagnostics = (
    sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  return (diagnostics ?? []).map(
    (diagnostic) =>
      `${file} (${side}): ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  );
}

const TRANSPILE_OPTIONS: ts.TranspileOptions = {
  compilerOptions: {
    removeComments: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  },
};

function transpile(source: string): string {
  return typescript.transpileModule(source, TRANSPILE_OPTIONS).outputText;
}

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (positional.length !== 0 && positional.length !== 2) {
  console.log(`FAIL: expected 0 or 2 positional refs, got ${String(positional.length)}.`);
  console.log(USAGE);
  process.exit(1);
}
const base = positional[0] ?? DEFAULT_BASE;
const head = positional[1] ?? DEFAULT_HEAD;
const repoRoot = path.join(EXTENSION_ROOT, "..");

readRev(base, repoRoot);
readRev(head, repoRoot);

const files = changedLeanFiles(base, head, repoRoot);

if (files.length === 0) {
  console.log(
    `FAIL: no changed .ts file under ${LEAN_SCOPE} — nothing was proven (base ${base}, head ${head})`,
  );
  process.exit(1);
}

const differing: string[] = [];
const syntax: string[] = [];

for (const file of files) {
  const before = contentFromGit(base, file, repoRoot);
  const after = contentFromGit(head, file, repoRoot);
  if (before.gitFailed) {
    differing.push(`${file}: reading ${base}:${file} failed — ${before.stderr}`);
    continue;
  }
  if (after.gitFailed) {
    differing.push(`${file}: reading ${head}:${file} failed — ${after.stderr}`);
    continue;
  }
  if (before.text === undefined || after.text === undefined) {
    const missing = before.text === undefined ? base : head;
    differing.push(`${file}: present only on one side (absent at ${missing})`);
    continue;
  }

  syntax.push(...parseDiagnosticsOf(before.text, file, base));
  syntax.push(...parseDiagnosticsOf(after.text, file, head));

  const outBefore = transpile(before.text);
  const outAfter = transpile(after.text);
  if (outBefore !== outAfter) {
    differing.push(
      `${file}: emitted JavaScript differs (${outBefore.length} → ${outAfter.length} bytes)`,
    );
  }
}

console.log(
  `comment-only check ${base}..${head}: ${String(files.length)} changed file(s) in ${LEAN_SCOPE}`,
);
for (const line of syntax) console.log(`SYNTAX ${line}`);
for (const line of differing) console.log(`DIFF ${line}`);

if (syntax.length > 0) {
  console.log(`FAIL: ${String(syntax.length)} syntax error(s) — unparseable source proves nothing`);
  process.exit(1);
}

if (differing.length > 0) {
  console.log(`FAIL: ${String(differing.length)} file(s) changed beyond comments`);
  process.exit(1);
}

console.log("OK: every changed file emits JavaScript identical to its base");
