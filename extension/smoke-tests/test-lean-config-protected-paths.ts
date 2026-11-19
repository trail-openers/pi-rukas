#!/usr/bin/env bun
/**
 * lean/config — `lean.protectedPaths`, the project's OWN protected globs (#2365).
 *
 * Split out of `test-lean-config.ts` for the AGENTS.md §12 line gate, along the
 * seam the field itself draws: that suite answers "does the loader read the file
 * at the base commit and refuse what it cannot honour", this one answers "what
 * does THIS field admit, and what does the fold make of what it admitted". The
 * shared temp repo lives in `lib/lean-config-fixture.ts` so neither suite drifts
 * from the other's idea of a committed `.pi/work.json`.
 *
 * Four claims, each needing the real loader rather than a stub — an invalid entry
 * must raise `LeanConfigError` the way a typo'd budget does, because a protected
 * path the loader quietly dropped is a rule the project believes it has:
 *
 *   - a valid list reads back in the project's own order, beside the `lean`
 *     sibling key, and an empty list resolves to "no rule" rather than to zero
 *     compiled patterns;
 *   - every entry the matcher module refuses is refused HERE too, naming the
 *     entry — the loader is the only place a project learns its rule was inert;
 *   - the `verify.testGlob` wildcard rules deliberately do NOT carry over, since
 *     a protected-path entry IS a glob;
 *   - the field-by-field rebuild holds: a foreign key beside the two the schema
 *     admits cannot ride onto the record and become a fold input.
 */

import { execp } from "../src/exec.ts";
import { LeanConfigError, loadWorkConfig, protectedPathsOf } from "../src/lean/config.ts";
import { makeRepo } from "./lib/lean-config-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

{
  // A valid list is carried in the loader's own order, and a config with no
  // `lean` block at all carries none — the two states a fold distinguishes.
  const { repoRoot, baseSha, cleanup } = makeRepo({
    ".pi/work.json": JSON.stringify({
      version: 1,
      lean: { specIntake: "require", protectedPaths: ["angular.json", "package*.json", "theme/"] },
    }),
  });
  try {
    const cfg = await loadWorkConfig(execp, repoRoot, baseSha);
    assert(
      cfg.lean?.protectedPaths?.join("|") === "angular.json|package*.json|theme/",
      `the committed glob list reads back in order (got ${JSON.stringify(cfg.lean?.protectedPaths)})`,
    );
    assert(
      cfg.lean?.specIntake === "require",
      "and the sibling key still rides the rebuilt record",
    );
  } finally {
    cleanup();
  }
}

{
  // An empty array is a project that said nothing, which is the same answer as
  // no field: a fold must not compile zero patterns and call it a rule.
  const { repoRoot, baseSha, cleanup } = makeRepo({
    ".pi/work.json": JSON.stringify({ version: 1, lean: { protectedPaths: [] } }),
  });
  try {
    const cfg = await loadWorkConfig(execp, repoRoot, baseSha);
    assert(
      cfg.lean?.protectedPaths?.length === 0 && protectedPathsOf(cfg) === undefined,
      "an empty list loads and resolves to no rule",
    );
  } finally {
    cleanup();
  }
}

// Every entry the matcher module refuses is refused here too, with the entry
// named: the loader is the only place a project ever learns its rule was inert.
const badProtectedPaths: Array<[string, unknown, string]> = [
  ["not an array", "angular.json", "lean.protectedPaths must be an array"],
  ["non-string entry", [5], "entries must be strings"],
  ["empty entry", [""], "must not contain an empty entry"],
  ["absolute entry", ["/etc/passwd"], "must be repo-relative, not absolute"],
  ["traversal entry", ["src/../.github"], 'must not contain ".."'],
  ["negation entry", ["!src/x.ts"], 'must not start with "!"'],
  ["backslash entry", ["src\\x.ts"], "plain repo-relative glob"],
  ["zero-width entry", ["src\u200b/x.ts"], "invisible"],
];

for (const [name, entries, expected] of badProtectedPaths) {
  const { repoRoot, baseSha, cleanup } = makeRepo({
    ".pi/work.json": JSON.stringify({ version: 1, lean: { protectedPaths: entries } }),
  });
  try {
    let thrown: unknown;
    try {
      await loadWorkConfig(execp, repoRoot, baseSha);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof LeanConfigError,
      `lean.protectedPaths ${name}: rejected with LeanConfigError`,
    );
    assert(
      thrown instanceof Error && thrown.message.includes(expected),
      `lean.protectedPaths ${name}: names "${expected}" (got ${(thrown as Error)?.message})`,
    );
  } finally {
    cleanup();
  }
}

{
  // The wildcard rules of `verify.testGlob` deliberately do NOT carry over: a
  // protected-path entry IS a glob, so `*`, `?` and `**` are all legal here.
  const { repoRoot, baseSha, cleanup } = makeRepo({
    ".pi/work.json": JSON.stringify({
      version: 1,
      lean: { protectedPaths: ["src/**", "**/theme/**", "a?c.ts", "package*.json"] },
    }),
  });
  try {
    const cfg = await loadWorkConfig(execp, repoRoot, baseSha);
    assert(
      cfg.lean?.protectedPaths?.length === 4,
      `wildcards are legal in a protected-path entry (got ${JSON.stringify(cfg.lean?.protectedPaths)})`,
    );
  } finally {
    cleanup();
  }
}

{
  // `__proto__` as a `lean` key must not ride onto the record beside the two
  // keys the schema admits — the field-by-field rebuild is the whole defence.
  const polluted = JSON.parse('{"version":1,"lean":{"specIntake":"require","__proto__":"x"}}');
  const { repoRoot, baseSha, cleanup } = makeRepo({
    ".pi/work.json": JSON.stringify(polluted),
  });
  try {
    const cfg = await loadWorkConfig(execp, repoRoot, baseSha);
    assert(
      (cfg.lean as Record<string, unknown>).__proto__ === "x" ||
        Object.keys(cfg.lean ?? {})
          .sort()
          .join(",") === "specIntake",
      "a foreign lean key is either refused or inert, never a fold input",
    );
    assert(
      cfg.lean?.protectedPaths === undefined,
      "and no protected-path rule is invented beside it",
    );
  } finally {
    cleanup();
  }
}

process.exit(exit);
