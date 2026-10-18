/**
 * #1414/#1118 — the driver's typecheck gate must name the compiler, never an
 * alias that resolves it.
 *
 * The bug, in its two forms:
 *
 *  - #1118: the checkpoint ran the hyphenless alias, which was not on PATH on
 *    the reporting host, so the checkpoint's own status line accused correctly
 *    committed code of being broken.
 *  - #1414: the alias form is an npx-style LOOKUP. On this host it resolves a
 *    GLOBAL TypeScript 7 that prints its usage and exits 0 — the gate PASSes
 *    every tree while judging nothing, which is strictly worse than the
 *    not-found failure, because it is invisible.
 *
 * So "does the command mention tsc" is not the property. The property is that
 * the program the command runs is the file the `typescript` devDependency ships
 * — which is what `LOCAL_TSC_CMD` spells and what every assertion below checks.
 *
 * RED/GREEN: every assertion here fails on the pre-fix literal
 * `bun x tsc --noEmit` — as an alias match, and as a command whose program is
 * not the pinned path. RED was additionally confirmed live on this host, where
 * the alias form reports Version 7.0.2 while the pinned compiler reports 5.9.3.
 *
 * Run: bun smoke-tests/test-verify-typecheck-uses-project-tsc.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHECKPOINT_TYPECHECK_CMD, LOCAL_TSC_CMD } from "../src/work-driver-cap-checkpoint.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf-8");

const results: string[] = [];
function ok(name: string): void {
  results.push(`PASS ${name}`);
}

// ── 1. The compiler the driver names is the one the project depends on.
{
  // The path must be the real CLI the devDependency ships — not a plausible
  // string that resolves to nothing, which would fail the gate at run time on
  // every host and look like broken code.
  const cli = path.join(REPO_ROOT, "extension", "node_modules", "typescript", "bin", "tsc");
  assert.ok(
    readFileSync(cli, "utf-8").length > 0,
    "extension/node_modules/typescript/bin/tsc exists and is non-empty",
  );
  assert.match(LOCAL_TSC_CMD, /^node node_modules\/typescript\/bin\/tsc$/);
  ok("LOCAL_TSC_CMD names the pinned compiler's own CLI file");
}

// ── 2. No alias anywhere in a command the driver builds (#1118, #1414).
{
  const aliasForms = [/\bbunx\b/, /\bbun\s+x\s+(?:tsc|typescript)\b/, /\bnpx\s+tsc\b/];
  for (const re of aliasForms) {
    assert.ok(
      !re.test(LOCAL_TSC_CMD),
      `LOCAL_TSC_CMD must not launch through an alias (matched ${re})`,
    );
    assert.ok(
      !re.test(CHECKPOINT_TYPECHECK_CMD),
      `CHECKPOINT_TYPECHECK_CMD must not launch through an alias (matched ${re})`,
    );
  }
  // The RED literal itself must be rejected by the same test, so the check
  // cannot be a tautology that would also have passed the old code.
  const RED_LITERAL = "bun x tsc --noEmit";
  assert.ok(
    aliasForms.some((re) => re.test(RED_LITERAL)),
    "this gate actually rejects the pre-#1414 command it replaces",
  );
  assert.notEqual(CHECKPOINT_TYPECHECK_CMD, RED_LITERAL);
  ok("the pre-fix alias form is rejected by this gate, not merely absent");
}

// ── 3. The real tsc flag, not the hyphenated one #1414 round 1 hit.
{
  assert.match(CHECKPOINT_TYPECHECK_CMD, /--noEmit\b/);
  assert.ok(
    !/--no-emit/.test(CHECKPOINT_TYPECHECK_CMD),
    "`--no-emit` is not a tsc flag; the checkpoint's old literal carried it",
  );
  // A project is named, so the gate checks the tree it means rather than
  // whatever tsconfig happens to be in the cwd.
  assert.match(CHECKPOINT_TYPECHECK_CMD, /-p\s+tsconfig\.json$/);
  ok("the checkpoint uses the real flag and names its tsconfig project");
}

// ── 4. What the driver RUNS is what the handoff TELLS the operator it ran.
// Three prose sites quote the command; if any keeps its own literal, the
// operator raises a bound or runs a command that is not the gate's.
{
  const sites = [
    "extension/src/work-driver-cap-checkpoint.ts",
    "extension/src/work-driver-cap-checkpoint-typecheck.ts",
    "extension/src/work-driver-caped-state.ts",
  ];
  // A quoted string that looks like a tsc invocation. Comments and jsdoc are
  // deliberately NOT scanned: prose that explains the old command ("the
  // hyphenated form is not a tsc flag") is the documentation this fix ships
  // with, and forbidding it would delete the explanation of the bug. A command
  // the code can actually execute is what must not be hardcoded.
  const COMMAND_LITERAL = /["'`]\s*(?:bunx|bun\s+x|npx)\s[^"'`]*\btsc\b[^"'`]*["'`]/;
  for (const rel of sites) {
    const code = read(rel)
      .split("\n")
      .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const hit = code.match(COMMAND_LITERAL);
    assert.ok(
      hit === null,
      `${rel} hardcodes a tsc command instead of quoting the exported one: ${(hit?.[0] ?? "").slice(0, 110)}`,
    );
  }
  ok("no prose site keeps its own tsc literal — they all quote the export");
}

// ── 5. The project's own verify tiers use the same spelling (#1118).
{
  const tiers = [".pi/verify-cmd", ".pi/verify-cmd-fast", ".pi/verify-cmd-full"];
  for (const rel of tiers) {
    const text = read(rel);
    const command = text
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && l.trim() !== "")
      .join(" ");
    assert.ok(command.includes(LOCAL_TSC_CMD), `${rel} does not use the pinned compiler path`);
    for (const re of [/\bbunx\b/, /\bbun\s+x\s+tsc\b/])
      assert.ok(!re.test(command), `${rel} launches tsc through an alias (${re})`);
  }
  ok("every .pi verify tier runs the pinned compiler, not an alias");
}

// ── 6. The docs prescribe the same command, not the no-op form (#1414).
{
  for (const rel of ["AGENTS.md", "CONTRIBUTING.md"]) {
    for (const line of read(rel).split("\n")) {
      if (!/\btsc\b/.test(line)) continue;
      // A comment that NAMES the alias to explain why it is wrong is the point
      // of the documentation; a command a reader is told to RUN is not. So the
      // check fires only on a backticked shell command that invokes tsc
      // through a launcher and does not name the pinned path.
      const prescribes = /`[^`]*(?:bunx|bun\s+x|npx)\s+[^`]*tsc[^`]*`/.test(line);
      assert.ok(
        !prescribes || line.includes(LOCAL_TSC_CMD),
        `${rel} tells a reader to launch tsc through an alias: ${line.trim().slice(0, 110)}`,
      );
    }
  }
  ok("the repo's own documented typecheck command is the pinned one");
}

console.log(results.join("\n"));
console.log(`\nverify-typecheck-uses-project-tsc: ${results.length} groups passed`);
