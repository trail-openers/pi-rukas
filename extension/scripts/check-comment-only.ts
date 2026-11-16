#!/usr/bin/env bun
/**
 * scripts/check-comment-only — prove a comment-only branch changed no code.
 *
 * What this proves: the emitted JavaScript of every changed `extension/src/lean`
 * file is byte-identical between base and head. Comments do not reach the
 * emitter, so identical output is evidence the trim touched no executable token.
 *
 * What this does NOT prove: the change is type-correct or well formatted. The
 * emitter discards type annotations and formatting alike, so `tsc --noEmit` and
 * `bun run check` are still required gates.
 *
 * Both sides are read from git objects — the roster from
 * `git diff --name-only <base> <head>` and each side's bytes from
 * `git show <rev>:<path>` — so the check judges committed bytes, never whatever
 * happens to sit in the working tree. The roster and the bytes always come from
 * the same source; `--working-tree` switches BOTH to the working tree (untracked
 * files included) for an author who wants a pre-commit preview.
 *
 * An empty roster is a FAIL, not a pass: zero changed files proves nothing about
 * a branch. A ref that git cannot read is a FAIL naming the ref and git's own
 * stderr. Syntax errors on either side are a FAIL too — unparseable source has
 * no meaningful transpiled output to compare, so the parse diagnostics of both
 * sides are collected before any comparison happens.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type ts from "typescript";

const LEAN_SCOPE = "extension/src/lean";
const DEFAULT_BASE = "origin/main";
const DEFAULT_HEAD = "HEAD";
const WORKING_TREE_FLAG = "--working-tree";

const require = createRequire(import.meta.url);
const EXTENSION_ROOT = path.join(import.meta.dirname, "..");
const TYPESCRIPT_ENTRY = path.join(
  EXTENSION_ROOT,
  "node_modules",
  "typescript",
  "lib",
  "typescript.js",
);
const typescript = require(TYPESCRIPT_ENTRY) as typeof ts;

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
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

/** Roster from committed diff; working-tree roster only under the explicit flag. */
function changedLeanFiles(
  base: string,
  head: string,
  workingTree: boolean,
  repoRoot: string,
): string[] {
  if (workingTree) {
    const tracked = git(["-C", repoRoot, "diff", "--name-only", base, "--", LEAN_SCOPE]);
    const untracked = git([
      "-C",
      repoRoot,
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      LEAN_SCOPE,
    ]);
    return tsFiles([...tracked.split("\n"), ...untracked.split("\n")]);
  }
  const out = git(["-C", repoRoot, "diff", "--name-only", base, head, "--", LEAN_SCOPE]);
  return tsFiles(out.split("\n"));
}

function contentFromGit(rev: string, file: string, repoRoot: string): string | undefined {
  try {
    return git(["-C", repoRoot, "show", `${rev}:${file}`]);
  } catch {
    // Absent on this side: a rename or add/delete, reported as a one-sided file.
    return undefined;
  }
}

function contentFromWorkingTree(file: string, repoRoot: string): string | undefined {
  try {
    return readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return undefined;
  }
}

function parseDiagnosticsOf(source: string, file: string, side: string): string[] {
  const sourceFile = typescript.createSourceFile(
    file,
    source,
    typescript.ScriptTarget.ESNext,
    true,
  );
  // `parseDiagnostics` is populated by `createSourceFile` but is not in the public
  // .d.ts; the narrow cast names the one internal field this gate reads.
  const diagnostics = (
    sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  return (diagnostics ?? []).map(
    (diagnostic) =>
      `${file} (${side}): ${typescript.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  );
}

function transpile(source: string): string {
  return typescript.transpileModule(source, {
    compilerOptions: {
      removeComments: true,
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.ESNext,
    },
  }).outputText;
}

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const workingTree = process.argv.slice(2).includes(WORKING_TREE_FLAG);
const base = positional[0] ?? DEFAULT_BASE;
const head = positional[1] ?? DEFAULT_HEAD;
const repoRoot = path.join(EXTENSION_ROOT, "..");

if (!workingTree) {
  readRev(base, repoRoot);
  readRev(head, repoRoot);
}

const files = changedLeanFiles(base, head, workingTree, repoRoot);

if (files.length === 0) {
  console.log(
    `FAIL: no changed .ts file under ${LEAN_SCOPE} — nothing was proven (base ${base}, head ${workingTree ? "working tree" : head})`,
  );
  process.exit(1);
}

const differing: string[] = [];
const syntax: string[] = [];

for (const file of files) {
  // The base side is a git object either way; only the head side follows the flag,
  // which is what keeps roster and bytes sourced consistently (see header).
  const before = contentFromGit(base, file, repoRoot);
  const after = workingTree
    ? contentFromWorkingTree(file, repoRoot)
    : contentFromGit(head, file, repoRoot);

  if (before === undefined || after === undefined) {
    const missing = before === undefined ? base : workingTree ? "working tree" : head;
    differing.push(`${file}: present only on one side (absent at ${missing})`);
    continue;
  }

  syntax.push(...parseDiagnosticsOf(before, file, base));
  syntax.push(...parseDiagnosticsOf(after, file, workingTree ? "working tree" : head));

  const outBefore = transpile(before);
  const outAfter = transpile(after);
  if (outBefore !== outAfter) {
    differing.push(
      `${file}: emitted JavaScript differs (${outBefore.length} → ${outAfter.length} bytes)`,
    );
  }
}

const headLabel = workingTree ? "working tree" : head;
console.log(
  `comment-only check ${base}..${headLabel}: ${files.length} changed file(s) in ${LEAN_SCOPE}`,
);
for (const line of syntax) console.log(`SYNTAX ${line}`);
for (const line of differing) console.log(`DIFF ${line}`);

if (syntax.length > 0) {
  console.log(`FAIL: ${syntax.length} syntax error(s) — unparseable source proves nothing`);
  process.exit(1);
}

if (differing.length > 0) {
  console.log(`FAIL: ${differing.length} file(s) changed beyond comments`);
  process.exit(1);
}

console.log("OK: every changed file emits JavaScript identical to its base");
