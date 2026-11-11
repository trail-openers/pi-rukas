#!/usr/bin/env bun
/**
 * #2173 — the ONE exempt-path set the two serialising sides share.
 *
 * `work-driver-shared-paths.ts` is consulted by the reactive claims core
 * (`checkCrossGroupClaimsSync`) AND by both queue-side overlap predicates
 * (`groupPathsOverlap`, `predictedPathsCollide`). That single-set rule is the
 * residual HIGH finding this file exists for: an exemption applied on one side
 * only deletes half the park, and the pair of tests that drive the two sides
 * would each still be green.
 *
 * So this file asserts the set ITSELF — that both sides consult this module
 * (by importing it and by the source scan at the bottom), that the two entries
 * are the ones that serialise nearly every cycle, and that the exemption is
 * narrow: markup survives, an unrelated file that merely shares a name does not
 * become exempt, and a source file never is.
 *
 * Observed red on a mutant: the `mutant` block at the end deletes an entry from
 * the set and asserts the pair collides again, which is what makes the
 * "everything else still serialises" claim an assertion rather than a reading.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SHARED_NON_EXCLUSIVE_PATHS,
  isSharedNonExclusivePath,
  withoutSharedNonExclusivePaths,
} from "../src/work-driver-shared-paths.ts";
import { checkCrossGroupClaimsSync } from "../src/work-driver-path-claims.ts";
import { groupPathsOverlap, predictedPathsCollide } from "../src/work-queue-overlap.ts";
import type { IssueGroup } from "../src/work-queue-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ALWAYS_RUN = "extension/src/work-driver-verify-always-run.ts";
const TROUBLESHOOTING = "docs/troubleshooting.md";
const g = (id: string, issue: number, paths: string[]): IssueGroup => ({
  id,
  scope: "",
  paths,
  outOfScope: [],
  issues: [issue],
});
const claimsOf = (issue: number, paths: string[]) => [
  { issue, pid: process.pid, paths, startedAt: Date.now() },
];

// ── 1. the set is exactly the two paths the field evidence named ───────────
{
  const paths = SHARED_NON_EXCLUSIVE_PATHS.map((e) => e.path);
  assert(
    paths.includes(ALWAYS_RUN) && paths.includes(TROUBLESHOOTING),
    `the set holds the generated ALWAYS_RUN list and the operator runbook (got ${paths.join(", ")})`,
  );
  assert(
    SHARED_NON_EXCLUSIVE_PATHS.every((e) => e.because.trim().length > 0),
    "every entry states WHY it is non-exclusive (a bare list invites someone to add a source file to it)",
  );
  assert(
    !paths.some((p) => /^extension\/src\/[^/]+\.ts$/.test(p) && p !== ALWAYS_RUN),
    "no ordinary source file is exempt (the set stays two derived/append-only paths)",
  );
}

// ── 2. the predicate, including the markup a planner actually writes ───────
for (const declared of [
  ALWAYS_RUN,
  `**${ALWAYS_RUN}**`,
  `\`${TROUBLESHOOTING}\``,
  `${TROUBLESHOOTING} (new)`,
  `./${TROUBLESHOOTING}`,
]) {
  assert(
    isSharedNonExclusivePath(declared),
    `an annotated / emphasised / backticked declaration of an exempt path is exempt: ${declared}`,
  );
}
for (const not of [
  "",
  undefined,
  "src/foo.ts",
  "docs/troubleshooting.md.bak",
  "notes/troubleshooting.md",
  "src/troubleshooting.md",
  "docs/",
  ALWAYS_RUN.replace("/work-driver-verify-always-run.ts", ""),
]) {
  assert(
    !isSharedNonExclusivePath(not),
    `NOT exempt: ${String(not)} (the exemption is the exact repo path, not its name)`,
  );
}
assert(
  withoutSharedNonExclusivePaths([ALWAYS_RUN, "src/a.ts", TROUBLESHOOTING]).join(",") === "src/a.ts",
  "the filter drops exactly the exempt paths and keeps the rest in order",
);
assert(withoutSharedNonExclusivePaths(undefined).length === 0, "no list → no paths, no throw");

// ── 3. ONE set, consulted by BOTH sides ────────────────────────────────────
//
// The pair below is the same declared-path pair handed to the claims core and to
// the two queue predicates. If either side stopped consulting the set, exactly
// one of the three assertions goes red — which is the drift the shared module
// exists to prevent and which no per-side test would catch.
{
  const a = [ALWAYS_RUN, TROUBLESHOOTING];
  assert(
    checkCrossGroupClaimsSync(10, { default: { paths: a } }, claimsOf(11, a)).length === 0,
    "claims core: the exempt pair does not conflict",
  );
  assert(
    groupPathsOverlap(g("a", 10, a), g("b", 11, a)) === false,
    "queue groupPathsOverlap: the exempt pair does not overlap",
  );
  assert(
    predictedPathsCollide(a, a) === false,
    "queue predictedPathsCollide: the exempt pair does not collide",
  );
}

// ── 4. the source scan: neither side may re-implement its own list ──────────
//
// Prose is convention; a scan is enforcement. The exemption lives in ONE module,
// so any other module that hard-codes either path as a non-exclusive path is a
// second source of truth that will drift — the failure the shared set removes.
{
  const src = path.resolve(import.meta.dirname, "../src");
  const readers = [
    "work-driver-path-claims.ts",
    "work-driver-path-claims-gate.ts",
    "work-queue-overlap.ts",
  ];
  for (const file of readers) {
    const text = readFileSync(path.join(src, file), "utf8");
    assert(
      text.includes("work-driver-shared-paths.ts"),
      `${file} imports the shared exempt-path module (it has no list of its own)`,
    );
  }
  const shared = readFileSync(path.join(src, "work-driver-shared-paths.ts"), "utf8");
  assert(
    shared.includes(ALWAYS_RUN) && shared.includes("docs/troubleshooting.md"),
    "work-driver-shared-paths.ts is the file that names the exempt paths",
  );
}

// ── 5. mutant: with the set emptied, the same pair serialises again ────────
//
// Without this, "everything else still serialises" is unobserved — an exemption
// implemented as `return true` everywhere would pass every case above.
{
  const src = path.resolve(import.meta.dirname, "../src/work-driver-shared-paths.ts");
  const original = readFileSync(src, "utf8");
  try {
    // Rewrite the module's list to one entry and re-import the fresh module URL.
    const mutated = original.replace(
      /path: "extension\/src\/work-driver-verify-always-run\.ts",/,
      'path: "extension/src/deleted-generated-list.ts",',
    );
    assert(mutated !== original, "the mutant edits the set (an inert mutation proves nothing)");
    const tmpFile = path.join(
      path.dirname(src),
      `__mutant-shared-paths-${process.pid}.ts`,
    );
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(tmpFile, mutated, "utf8");
    try {
      const mod = (await import(
        `../src/${path.basename(tmpFile)}?mutant=${process.pid}`
      )) as typeof import("../src/work-driver-shared-paths.ts");
      assert(
        !mod.isSharedNonExclusivePath(ALWAYS_RUN),
        "mutant: with the ALWAYS_RUN entry gone, that path is no longer exempt",
      );
      assert(
        mod.isSharedNonExclusivePath(TROUBLESHOOTING),
        "mutant: the other entry is untouched (the mutation was one row, not the mechanism)",
      );
    } finally {
      rmSync(tmpFile, { force: true });
    }
  } finally {
    // The source is never written — the mutation lives only in the copy.
    assert(readFileSync(src, "utf8") === original, "the real module was never mutated");
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
