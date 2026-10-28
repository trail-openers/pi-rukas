#!/usr/bin/env bun
/**
 * lean/config — `.pi/work.json` is read at the base commit, never the tree.
 *
 * The whole point of threading `baseSha` through the loader is the case in
 * the first group: a run that edits its own config in the working tree must
 * still be judged by the bytes at the commit it started from. A loader that
 * read the filesystem would pass every other test here and fail that one, so
 * that case is built first and the fixture makes the two copies genuinely
 * different rather than differently formatted.
 *
 * Everything runs against a real temp git repo, because "absent at that
 * commit" and "present but modified" are git facts, not file facts — faking
 * them with a stub exec would only test the stub.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { LeanConfigError, defaultConfig, loadWorkConfig } from "../src/lean/config.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repo with one commit containing `.pi/` files, and the sha of that commit. */
function makeRepo(files: Record<string, string>): {
  repoRoot: string;
  baseSha: string;
  cleanup: () => void;
} {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-config-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const g = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env }).trim();
  g("init", "-q", "-b", "main");
  mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(repoRoot, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const baseSha = g("rev-parse", "HEAD");
  return { repoRoot, baseSha, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

const VALID = JSON.stringify(
  {
    version: 1,
    autoMerge: true,
    verify: { fast: "bun run check", full: "bash verify-loop.sh" },
    budgets: { build: { turns: 7, tokens: 100, minutes: 3 } },
  },
  null,
  2,
);

// ── base wins over the working tree ────────────────────────────────────────

{
  const { repoRoot, baseSha, cleanup } = makeRepo({ ".pi/work.json": VALID });
  try {
    // Same path, genuinely different content: not a formatting difference the
    // loader could accidentally agree on.
    writeFileSync(
      path.join(repoRoot, ".pi", "work.json"),
      JSON.stringify({ version: 1, autoMerge: false, budgets: { build: { turns: 999 } } }),
      "utf8",
    );
    const cfg = await loadWorkConfig(execp, repoRoot, baseSha);
    assert(cfg.autoMerge === true, "the committed autoMerge wins over an edited working tree");
    assert(cfg.verify.full === "bash verify-loop.sh", "the committed verify.full wins");
    assert(cfg.budgets.build?.turns === 7, "the committed budget wins over the working tree's");
    assert(cfg.budgets.specify?.turns === 80, "a state the file omits keeps its default budget");
  } finally {
    cleanup();
  }
}

// ── absent file → defaults, with the verify-cmd fallback ───────────────────

{
  const { repoRoot, baseSha, cleanup } = makeRepo({ "README.md": "x\n" });
  try {
    const cfg = await loadWorkConfig(execp, repoRoot, baseSha);
    assert(cfg.version === 1, "defaults carry version 1");
    assert(cfg.autoMerge === false, "no config means no auto-merge");
    assert(cfg.verify.full === undefined, "no verify-cmd means no full command");
    assert(cfg.budgets.build?.minutes === 45, "defaults carry the build budget");
    assert(cfg.budgets.ci?.minutes === 30, "defaults carry the ci budget");
    assert(cfg.budgets.specify?.tokens === 10_000_000, "defaults carry the specify token budget");
  } finally {
    cleanup();
  }
}

{
  // The fallback reads the file AT THE SHA too: comments and blanks are
  // skipped, and a working-tree edit is invisible.
  const { repoRoot, baseSha, cleanup } = makeRepo({
    ".pi/verify-cmd":
      "# the full gate\n\nbash extension/smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts\n# trailing note\n",
  });
  try {
    writeFileSync(path.join(repoRoot, ".pi", "verify-cmd"), "rm -rf /\n", "utf8");
    const cfg = await loadWorkConfig(execp, repoRoot, baseSha);
    assert(
      cfg.verify.full === "bash extension/smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts",
      "verify.full falls back to the committed .pi/verify-cmd, first non-comment line",
    );
    assert(cfg.autoMerge === false, "the fallback still does not enable auto-merge");
  } finally {
    cleanup();
  }
}

// ── invalid → a typed error, never a silent default ────────────────────────

const invalidCases: Array<[string, string, string]> = [
  ["not json", "{", "is not valid JSON"],
  ["wrong version", JSON.stringify({ version: 2 }), "version must be 1"],
  ["no version", JSON.stringify({ autoMerge: true }), "version must be 1"],
  [
    "bad autoMerge",
    JSON.stringify({ version: 1, autoMerge: "yes" }),
    "autoMerge must be a boolean",
  ],
  ["verify not object", JSON.stringify({ version: 1, verify: "x" }), "verify must be an object"],
  [
    "bad verify key",
    JSON.stringify({ version: 1, verify: { fast: 5 } }),
    "verify.fast must be a string",
  ],
  ["budgets not object", JSON.stringify({ version: 1, budgets: [] }), "budgets must be an object"],
  [
    "negative budget",
    JSON.stringify({ version: 1, budgets: { build: { turns: -1 } } }),
    "budgets.build.turns must be a non-negative integer",
  ],
  [
    "fractional budget",
    JSON.stringify({ version: 1, budgets: { build: { minutes: 1.5 } } }),
    "budgets.build.minutes must be a non-negative integer",
  ],
];

for (const [name, content, expected] of invalidCases) {
  const { repoRoot, baseSha, cleanup } = makeRepo({ ".pi/work.json": content });
  try {
    let thrown: unknown;
    try {
      await loadWorkConfig(execp, repoRoot, baseSha);
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof LeanConfigError, `${name}: rejected with LeanConfigError`);
    assert(
      thrown instanceof Error && thrown.message.includes(expected),
      `${name}: names "${expected}"`,
    );
  } finally {
    cleanup();
  }
}

// A valid file that merely omits the optional sections is not invalid.
{
  const { repoRoot, baseSha, cleanup } = makeRepo({
    ".pi/work.json": JSON.stringify({ version: 1 }),
  });
  try {
    const cfg = await loadWorkConfig(execp, repoRoot, baseSha);
    assert(
      cfg.autoMerge === false && Object.keys(cfg.verify).length === 0,
      "a minimal file loads with defaults filled in",
    );
  } finally {
    cleanup();
  }
}

// The defaults function is what an absent file produces — pinned directly so
// the two cannot drift apart silently.
assert(defaultConfig().autoMerge === false, "defaultConfig() autoMerge false");
assert(
  defaultConfig("npm test").verify.full === "npm test",
  "defaultConfig() carries a supplied full command",
);
assert(defaultConfig().verify.full === undefined, "defaultConfig() without one leaves it absent");

process.exit(exit);
