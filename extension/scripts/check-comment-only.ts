#!/usr/bin/env bun
/**
 * lean/scripts/check-comment-only — prove a comment-only branch changed no code.
 *
 * A trim that touches an executable token is a behaviour change wearing a docs
 * label. The only honest evidence is the transpiled output: two files that
 * differ solely in comments compile to identical bytes once `removeComments`
 * has had its way with them.
 *
 * Scope is the lean tree (`extension/src/lean`, at any depth) against a base ref,
 * default `origin/main`. Files present on only one side are reported too — a
 * comment-only change neither adds nor deletes a file.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import ts from "typescript";

const LEAN_SCOPE = "extension/src/lean";
const DEFAULT_BASE = "origin/main";

const require = createRequire(import.meta.url);
const EXTENSION_ROOT = path.join(import.meta.dirname, "..");
const typescript = require(path.join(EXTENSION_ROOT, "node_modules", "typescript", "lib", "typescript.js")) as typeof ts;

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function changedLeanFiles(base: string, repoRoot: string): string[] {
  const out = git(["-C", repoRoot, "diff", "--name-only", base, "--", LEAN_SCOPE]);
  return out.split("\n").filter((line) => line.endsWith(".ts"));
}

function contentAt(rev: string, file: string, repoRoot: string): string | undefined {
  try {
    return git(["-C", repoRoot, "show", `${rev}:${file}`]);
  } catch {
    return undefined;
  }
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

const base = process.argv[2] ?? DEFAULT_BASE;
const repoRoot = path.join(EXTENSION_ROOT, "..");

const files = changedLeanFiles(base, repoRoot);
const differing: string[] = [];

for (const file of files) {
  const before = contentAt(base, file, repoRoot);
  const after = contentAt("HEAD", file, repoRoot);
  if (before === undefined || after === undefined) {
    differing.push(`${file}: present on only one side of the diff`);
    continue;
  }
  const outBefore = transpile(before);
  const outAfter = transpile(after);
  if (outBefore !== outAfter) {
    differing.push(`${file}: transpiled output differs (${outBefore.length} → ${outAfter.length} bytes)`);
  }
}

console.log(`comment-only check against ${base}: ${files.length} changed file(s) in ${LEAN_SCOPE}`);
for (const line of differing) console.log(`DIFF ${line}`);

if (differing.length > 0) {
  console.log(`FAIL: ${differing.length} file(s) changed beyond comments`);
  process.exit(1);
}
console.log("OK: every changed file compiles identically to its base");
