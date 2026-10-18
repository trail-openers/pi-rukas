#!/usr/bin/env bun
/**
 * #1167 — the identifier half of the plan-time unfence: which names the issue
 * mentions resolve to a file, and which must never unfence anything.
 *
 * Split out of test-plan-unfence-issue-named.ts for the AGENTS.md §12 line cap.
 * The rule under test is that ambiguity is never resolved on a guess: a
 * symbol `git grep` finds in several source files, or in none, unfences
 * NOTHING and records why. Silence would be indistinguishable from "the issue
 * named no fence", which is how an extraction bug reads as a clean plan.
 */

import { definesSymbol, resolveDefiningFile } from "../src/work-driver-plan-unfence-extract.ts";
import { type UnfenceResult, unfenceIssueNamedPaths } from "../src/work-driver-plan-unfence.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const WS = (id: string, paths: string[], outOfScope: string[]): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

const OPTS = {
  execFn: async (_c: string, o?: { argv?: string[] }) => ({ stdout: "" }),
  repoRoot: "/repo",
  ref: "origin/main",
};

// ------------------------------------------- unresolved identifiers never unfence

{
  const body = "## Decisions\n- dispatchCore and mysterySymbol both matter.\n- absentSymbol too.";
  const plan = {
    default: WS("default", ["src/a.ts"], ["src/ambiguous.ts", "src/nonexistent.ts"]),
  };
  const r: UnfenceResult = await unfenceIssueNamedPaths(plan, body, {
    execFn: async (_c: string, o?: { argv?: string[] }) => {
      const argv = o?.argv ?? [];
      if (argv[0] === "grep") {
        if (argv[4] === "mysterySymbol") {
          return { stdout: "src/ambiguous.ts\nsrc/also.ts\n" };
        }
        return { stdout: "" };
      }
      return { stdout: "// no definition here\n" };
    },
    repoRoot: "/repo",
    ref: "origin/main",
    defaultToSingle: true,
  });
  assert(
    r.workstreams.default.outOfScope.includes("src/ambiguous.ts"),
    "an identifier matching SEVERAL source files unfences nothing (ambiguity is never resolved on a guess)",
  );
  assert(
    r.workstreams.default.outOfScope.includes("src/nonexistent.ts"),
    "an identifier matching NOTHING unfences nothing",
  );
  assert(
    r.warnings.some((w) => w.startsWith("unresolved identifier mysterySymbol:")),
    "the ambiguous name is recorded as a plan note rather than silently ignored",
  );
  assert(
    r.warnings.some((w) => w.startsWith("unresolved identifier absentSymbol:")),
    "a name with no defining file is recorded too",
  );
}

// ------------------------------------------------------ globs are not paths

{
  const plan = { default: WS("default", ["src/a.ts"], ["src/keep.ts"]) };
  const r = await unfenceIssueNamedPaths(
    plan,
    "## ACCEPTANCE CRITERIA\n- test-work-driver-plan* and test-work-driver-scope* pass.",
    OPTS,
  );
  assert(
    r.workstreams.default.outOfScope.includes("src/keep.ts"),
    "a glob in the acceptance criteria names no file and unfences nothing",
  );
  assert(r.removed.length === 0, "no fence was removed by a glob-only criteria list");
}

// ------------------------------------------------- identifier resolution rules

{
  assert(
    definesSymbol("export function dispatchCore(\n  pi: unknown,\n) {}\n", "dispatchCore"),
    "a declaration line counts as a definition",
  );
  assert(
    !definesSymbol("  // the driver calls dispatchCore once\n", "dispatchCore"),
    "a comment mentioning the name is not a definition (that is how a test file would win)",
  );
  assert(
    !definesSymbol("const dispatchCorey = 1;\n", "dispatchCore"),
    "a name that merely starts with the symbol is not the symbol",
  );
  const files: string[] = [];
  const sole = await resolveDefiningFile("thing", ["src/a.ts", "src/b.ts"], async (f) => {
    files.push(f);
    return f === "src/a.ts" ? "export function thing() {}\n" : "//\n";
  });
  assert(sole === "src/a.ts", "exactly one candidate carries a definition → that file resolves");
  assert(
    (await resolveDefiningFile("thing", ["src/a.ts", "src/b.ts"], async () => "//\n")) ===
      undefined,
    "zero definitions → ambiguous → nothing resolves",
  );
  assert(
    (await resolveDefiningFile(
      "thing",
      ["src/a.ts", "test/a.ts", "AGENTS.md"],
      async () => "export function thing() {}\n",
    )) === "src/a.ts",
    "test and prose candidates never own a symbol even when they contain the same text",
  );
  assert(files.length === 2, "every source candidate is read before deciding (no early win)");
}

console.log(exit === 0 ? "\nAll plan-unfence identifier assertions passed." : "\nFAILURES above.");
process.exit(exit);
