#!/usr/bin/env bun
/**
 * lean: a project's own `lean.protectedPaths` globs are enforced by the build
 * fold, on both of its arms.
 *
 * The built-in reverts (`.pi/`, `.github/`, `agents.json`, `CODEOWNERS`,
 * `.gitmodules`) have their own cases in `test-lean-build.ts` (d) and (m); this
 * file is the configured half of the same rule, and it keeps the built-ins as
 * controls, because the two lists are folded into one revert set.
 *
 *   (a) a child edits a path matching ONLY a configured glob -> reverted, gone
 *       from the tree and the commit, and named in the step reason beside a
 *       built-in path it also edited (one `reverted:` list, both sources);
 *   (b) the budget-stopped fold (`foldStoppedBuild`) reverts the same path and
 *       its OWN reason names it — a disclosure folded into the `ok` arm's
 *       reason only would leave the ceiling handback silent;
 *   (c) the reason discloses a configured glob that matched NO path on this
 *       tree, and stays silent when every glob bit;
 *   (e) one predicate for both reads: a configured path the fold reverts is
 *       never ALSO reported as `the build commit contains untouchable path(s)`.
 *
 * Real temp repos, a stubbed model, no child spawned and no token spent.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WorkConfig } from "../src/lean/config.ts";
import { defaultConfig } from "../src/lean/config.ts";
import { emptyRunningState } from "../src/progress.ts";
import type { BudgetOpts } from "../src/lean/step-budget.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { commitPaths, status } from "./lib/lean-build-asserts.ts";
import {
  ROOTS,
  childCommit,
  git,
  put,
  runBuild,
} from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The config the fixture hands the step: the runner plus a project's own globs. */
function configWithProtected(protectedPaths?: string[]): WorkConfig {
  return {
    ...configWithRunner(),
    ...(protectedPaths === undefined ? {} : { lean: { protectedPaths } }),
  };
}

/** The `reverted:` clause of a step reason, as the two build arms compose it. */
function revertedOf(reason: string | undefined): string[] {
  return (((reason ?? "").match(/reverted: ([^;]*)/) ?? [])[1] ?? "")
    .split(", ")
    .filter((p) => p !== "");
}

// The project's OWN protected paths, named in this file's config only: the
// fixture's base tree ships `angular.json` as a dependency, so a case that named
// it would have its glob bite on the child's untouched copy and never exercise
// the inert-arm it is meant to exercise.
const PROJECT_GLOBS = ["src/**/*.vue", "scripts/**", "package*.json"];

// ── (a) the ok fold reverts a configured path and names it beside a built-in ──
{
  const r = await runBuild({
    issue: 2365,
    config: configWithProtected(PROJECT_GLOBS),
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 1;\n");
      // Project files matched only by the configured globs: a `**` arm that must
      // name a nested path, a basename `*` that spans none (`package.json`) and
      // one that spans some (`package-lock.json`), and a built-in in the round too.
      put(wt, "src/app/legacy.vue", "<template></template>\n");
      put(wt, "scripts/deploy.sh", "#!/bin/sh\n");
      put(wt, "package.json", '{ "name": "rewritten" }\n');
      put(wt, "package-lock.json", '{ "lockfileVersion": 99 }\n');
      put(wt, ".pi/work.json", '{ "verify": { "test": "true {file}" } }\n');
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(a) ok, got ${r.outcome?.kind}`);
  for (const rel of [
    "src/app/legacy.vue",
    "scripts/deploy.sh",
    "package.json",
    "package-lock.json",
    ".pi/work.json",
  ]) {
    assert(!existsSync(path.join(wt, rel)), `(a) the child's edit to ${rel} is gone from the tree`);
  }
  assert(
    commitPaths(wt).join() === "src/retry.ts",
    `(a) the commit holds the implementation only (got ${commitPaths(wt).join(", ")})`,
  );
  const reverted = revertedOf(r.outcome?.reason).sort();
  assert(
    reverted.join(",") ===
      ".pi/work.json,package-lock.json,package.json,scripts/deploy.sh,src/app/legacy.vue",
    `(a) the ONE reverted list names configured and built-in paths alike (got ${r.outcome?.reason})`,
  );
  assert(status(wt) === "", `(a) clean after the commit (got ${status(wt)})`);
}

// ── (b) the budget-stopped fold: same revert, and its own reason names it ────
{
  const BUILD_TURNS = 3;
  const cfg: WorkConfig = {
    ...configWithProtected(["src/**/*.vue"]),
    budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
  };
  const breach = (onProgress: BudgetOpts["onProgress"]) =>
    onProgress?.({ ...emptyRunningState("developer"), turns: BUILD_TURNS + 1 });
  const r = await runBuild({
    issue: 2366,
    config: cfg,
    onProgressTick: breach,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 1;\n");
      put(wt, "src/app/legacy.vue", "<template></template>\n");
    },
  });
  assert(r.threw === undefined, `(b) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "budget", `(b) the stopped round is a budget verdict, got ${r.outcome?.kind}`);
  assert(
    !existsSync(path.join(r.worktree, "src/app/legacy.vue")),
    "(b) the ceiling-stopped fold reverted the configured path too",
  );
  assert(
    commitPaths(r.worktree).join() === "src/retry.ts",
    `(b) and its commit holds no protected path (got ${commitPaths(r.worktree).join(", ")})`,
  );
  // The claim `test-lean-build-submodule-off.ts` (d) pins for submodules, for the
  // same reason: the budget arm composes its reason itself, so a disclosure folded
  // only into the `ok` arm's list leaves the ceiling handback silent about a commit
  // built on a tree where the file the project protects was edited and undone.
  assert(
    revertedOf(r.outcome?.reason).includes("src/app/legacy.vue"),
    `(b) the budget verdict's OWN reason names the reverted path (got ${r.outcome?.reason})`,
  );
}

// ── (c) a glob that matched nothing is disclosed, and only when one did ───────
{
  const inert = await runBuild({
    issue: 2367,
    config: configWithProtected(["angular.json", "theme/", "src/**/*.vue"]),
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
  });
  assert(inert.threw === undefined, `(c) no throw: ${inert.threw?.message ?? "clean"}`);
  assert(
    (inert.outcome?.reason ?? "").includes("protected paths matched nothing: angular.json, theme/, src/**/*.vue"),
    `(c) the reason names the globs that matched no path on this tree (got ${inert.outcome?.reason})`,
  );

  // The negative control: every glob of the run bit, so nothing is disclosed. A
  // disclosure that fired on every build would be noise, and a case that only ever
  // checked the positive arm could not tell the two apart. The second glob bites on a
  // path of the CHILD'S OWN work rather than on a protected path — a glob that only
  // matched a path the built-in list already reverts has said nothing of its own, and
  // counts as inert. It names the frozen acceptance test deliberately: `src/retry.ts` is
  // the implementation the fold must KEEP, and a glob over it would revert the run's only
  // work and leave nothing to commit — which is the shape the inert-disclosure rule exists
  // to make visible, not something a control case should quietly rely on.
  const biting = await runBuild({
    issue: 2368,
    config: configWithProtected(["src/**/*.vue", "tests/**/*.sh"]),
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 1;\n");
      put(wt, "src/app/legacy.vue", "<template></template>\n");
      put(wt, "tests/AC1-retry.test.sh", "#!/bin/sh\nexit 0\n");
    },
  });
  assert(
    !(biting.outcome?.reason ?? "").includes("matched nothing"),
    `(c) and a config whose every glob bit says nothing about inert ones (got ${biting.outcome?.reason})`,
  );
  assert(
    revertedOf(biting.outcome?.reason).includes("src/app/legacy.vue"),
    `(c) while the one that did bite is still named (got ${biting.outcome?.reason})`,
  );

  // What the inert list is FOR: the project's own rules that named nothing. A BUILT-IN path is
  // the shipped rule, not one this project wrote, so it belongs nowhere in a list of configured
  // GLOBS — telling someone to delete `.pi/work.json` from a reason headed "protected paths
  // matched nothing" is a disclosure that sends them at the wrong file. The built-in is still
  // reverted and still named, just in the `reverted:` clause where it belongs.
  const builtIn = await runBuild({
    issue: 2371,
    config: configWithProtected(["src/**/*.vue"]),
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 1;\n");
      // The one shape the old note folded into the same list: a built-in path the child touched
      // and the configured glob did not name.
      put(wt, ".pi/work.json", '{ "verify": { "test": "true {file}" } }\n');
    },
  });
  assert(builtIn.threw === undefined, `(c) no throw: ${builtIn.threw?.message ?? "clean"}`);
  assert(
    (builtIn.outcome?.reason ?? "").includes("protected paths matched nothing: src/**/*.vue"),
    `(c) the inert configured glob is named (got ${builtIn.outcome?.reason})`,
  );
  assert(
    !(builtIn.outcome?.reason ?? "")
      .split("protected paths matched nothing: ")[1]
      .split(";")[0]
      .includes(".pi/work.json"),
    `(c) and the built-in is NOT on the configured list — the built-in list is not the project's to have rotted (got ${builtIn.outcome?.reason})`,
  );
  assert(
    revertedOf(builtIn.outcome?.reason).includes(".pi/work.json"),
    `(c) while the built-in revert is still disclosed where it belongs (got ${builtIn.outcome?.reason})`,
  );
}

// ── (e) one predicate: a reverted configured path is never also a leaked one ─
//
// `classify` and `verifyCommit` read the SAME predicate. If the leak filter kept
// the built-in-only rule while the revert arm learned the globs, every build that
// edited a configured path would revert it and then throw the fold's own infra
// error — an exit-10 handback for a routine revert. The mutant: make
// `verifyCommit` call `isProtectedPath` directly.
{
  const r = await runBuild({
    issue: 2370,
    config: configWithProtected(["**/theme/**", "src/**/*.vue"]),
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 1;\n");
      // A path the CHILD COMMITS: the only way the commit's own leak check is
      // reached with a configured path in its diff.
      put(wt, "src/theme/legacy.css", "body { color: red }\n");
      put(wt, "src/app/legacy.vue", "<template></template>\n");
      childCommit(wt, "the child's own commit");
    },
  });
  assert(
    r.threw === undefined,
    `(e) a configured revert is not a fold failure (got ${r.threw?.constructor.name}: ${r.threw?.message ?? "clean"})`,
  );
  assert(
    !(r.threw?.message ?? "").includes("untouchable"),
    "(e) and never the leaked-path throw",
  );
  assert(r.outcome?.kind === "ok", `(e) ok, got ${r.outcome?.kind}`);
  assert(
    commitPaths(r.worktree).join() === "src/retry.ts",
    `(e) neither configured path reached the commit (got ${commitPaths(r.worktree).join(", ")})`,
  );
  assert(
    git(r.worktree, "show", "HEAD:src/retry.ts").includes("retry"),
    "(e) and the child's real work is still there",
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
