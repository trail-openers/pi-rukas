#!/usr/bin/env bun
/**
 * Declared paths are prose written by a planner, not `git` output.
 *
 * `verifyConsolidation` asks whether any of a workstream's declared `paths`
 * appears in `git diff --name-only`, by exact string equality. Those paths come
 * from an LLM writing a plan, and — measured across the 16 real state files on
 * this host — they routinely carry annotations meant for a human reader:
 *
 *     "extension/src/work-driver-verify-cmd.ts (new)"      (338.json)
 *     "extension/src/role-tools.ts (no changes)"           (339.json)
 *
 * Neither ever equals a `git` path, so the workstream reads as MISSING even
 * when its files were changed — and `missing` is what the consolidation gate
 * reports at commit-pr, a HALT step.
 *
 * The failure is one-directional and quiet: this can produce a false ALARM,
 * never a false pass, which is why it survived. Markdown emphasis is handled
 * for the same reason — same class, same cost.
 */

import { normaliseDeclaredPath } from "../src/work-driver-verify.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------- annotations measured in the wild

{
  const cases: Array<[string, string]> = [
    ["extension/src/work-driver-verify-cmd.ts (new)", "extension/src/work-driver-verify-cmd.ts"],
    ["extension/src/role-tools.ts (no changes)", "extension/src/role-tools.ts"],
    ["extension/src/spawn.ts", "extension/src/spawn.ts"],
  ];
  for (const [raw, want] of cases) {
    const got = normaliseDeclaredPath(raw);
    assert(got === want, `canary: ${JSON.stringify(raw)} -> ${JSON.stringify(got)}`);
  }
}

// ---------------------------------------------------- markdown and whitespace

{
  const cases: Array<[string, string]> = [
    ["`extension/src/lens-review.ts`", "extension/src/lens-review.ts"],
    ["  extension/src/spawn.ts  ", "extension/src/spawn.ts"],
    ["**AGENTS.md**", "AGENTS.md"],
    ["./extension/src/spawn.ts", "extension/src/spawn.ts"],
  ];
  for (const [raw, want] of cases) {
    assert(normaliseDeclaredPath(raw) === want, `${JSON.stringify(raw)} -> ${want}`);
  }
}

// -------------------------------------------------------- nothing over-eager

{
  // A directory is a legitimate declaration — verifyConsolidation matches
  // `f.startsWith(p + "/")` — so a trailing slash must normalise to something
  // that still matches rather than to something that never can.
  assert(
    normaliseDeclaredPath("extension/src/") === "extension/src",
    "a trailing slash is trimmed",
  );
  assert(
    normaliseDeclaredPath("docs/notes (draft).md") === "docs/notes (draft).md",
    "canary: a parenthetical INSIDE a filename survives — only a trailing annotation is stripped",
  );
  assert(normaliseDeclaredPath("") === "", "empty stays empty");
  assert(normaliseDeclaredPath("   ") === "", "whitespace-only becomes empty, and is then skipped");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
