#!/usr/bin/env bun
/**
 * `PI_ENSEMBLE_LEAN_PROTECTED_PATHS=0` means "the fold never saw the globs", on all
 * three `normaliseBuild` callers — and the ON arm strictly differs.
 *
 * `test-lean-protected-paths.ts` and `test-lean-review-fix-capture.ts` each pin one
 * fold's behaviour. This file pins the CLAIM that ties the three together, which no
 * per-fold case can: for one child edit and one project config, the off arm's report
 * and step reason carry no trace of the feature at all, while the on arm strictly
 * differs on the same bytes.
 *
 *   (a) `build`'s ok arm — off: the reason names only the built-in revert, no
 *       configured path and no inert clause appears anywhere, and the commit holds
 *       what the child wrote; on: the configured paths are reverted and named.
 *   (b) `build`'s budget-stopped arm — the same pair on the reason the ceiling
 *       handback composes itself, which is a separate list in `build.ts` and so a
 *       separate place the disclosure could go missing.
 *   (c) the review fixer's fold — the same pair on what reaches origin, the only
 *       surface that fold's caller owns.
 *
 * The arms differ ONLY in the env, on the same child edit and the same config, so a
 * difference in the result can only have come from the switch — and the off arm's
 * silence is the byte-identity claim: the fold's pre-field reason had no clause for a
 * configured path, so an off arm that printed one is this switch failing, whatever
 * the report's shape happens to be.
 *
 * Real temp repos, a stubbed model, no child spawned and no token spent.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/lean/config.ts";
import type { WorkConfig } from "../src/lean/config.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import type { BudgetOpts } from "../src/lean/step-budget.ts";
import { emptyRunningState } from "../src/progress.ts";
import { withEnv } from "./lib/env-scope.ts";
import { commitPaths, configWithRunner, status } from "./lib/lean-build-asserts.ts";
import { ROOTS, put, runBuild } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  FIXER_ROLE,
  cleanupRoots,
  ctxFor,
  depsWith,
  frozenBlob,
  git,
  lensRoundFor,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

/** What a project would write — and the only thing this switch is allowed to reach. */
const GLOBS = ["angular.json", "package*.json", "theme/"];

/** Every trace the feature adds. None of these may appear with the switch at `0`. */
const FIELD_MARKS = ["angular.json", "package-lock.json", "theme/", "matched nothing"];

/** A config carrying the project's own globs, beside the runner the fixture needs. */
const configWith = (paths: string[]): WorkConfig => ({
  ...configWithRunner(),
  lean: { protectedPaths: paths },
});

/** The edits every arm makes: one built-in, three configured, one ordinary file. */
function childEdits(wt: string): void {
  put(wt, "src/retry.ts", "export const retry = () => 1;\n");
  put(wt, ".pi/work.json", '{ "verify": { "test": "true {file}" } }\n');
  put(wt, "angular.json", '{ "scripts": {} }\n');
  put(wt, "package-lock.json", '{ "lockfileVersion": 99 }\n');
  put(wt, "theme/deep/x.css", "body { color: red }\n");
}

// The commit every arm holds with the switch off: the child's own work, configured
// paths included, and nothing for `.pi/` — the built-in is not this switch's to keep.
const OFF_COMMIT = "angular.json,package-lock.json,src/retry.ts,theme/deep/x.css";

// ── (a) the ok arm
{
  let off!: Awaited<ReturnType<typeof runBuild>>;
  await withEnv({ PI_ENSEMBLE_LEAN_PROTECTED_PATHS: "0" }, async () => {
    off = await runBuild({ issue: 2365, config: configWith(GLOBS), child: childEdits });
  });
  assert(off.threw === undefined, `(a) off arm: no throw (${off.threw?.message ?? "clean"})`);
  assert(off.outcome?.kind === "ok", `(a) off arm: ok, got ${off.outcome?.kind}`);
  assert(
    commitPaths(off.worktree).join() === OFF_COMMIT,
    `(a) off arm commits what the child wrote, configured paths included (got ${commitPaths(off.worktree).join(", ")})`,
  );
  const offReason = off.outcome?.reason ?? "";
  assert(
    offReason.includes("4 file(s) changed") && offReason.includes("reverted: .pi/work.json"),
    `(a) off arm still composes every clause the fold had before the field (got ${offReason})`,
  );
  assert(
    !FIELD_MARKS.some((m) => offReason.includes(m)),
    `(a) and names nothing the field adds — the pre-field reason bytes (got ${offReason})`,
  );

  const on = await runBuild({ issue: 2366, config: configWith(GLOBS), child: childEdits });
  assert(on.threw === undefined, `(a) on arm: no throw (${on.threw?.message ?? "clean"})`);
  assert(on.outcome?.kind === "ok", `(a) on arm: ok, got ${on.outcome?.kind}`);
  assert(
    commitPaths(on.worktree).join() === "src/retry.ts",
    `(a) on arm keeps only the implementation (got ${commitPaths(on.worktree).join(", ")})`,
  );
  const onReason = on.outcome?.reason ?? "";
  assert(
    onReason.includes("angular.json") &&
      onReason.includes("package-lock.json") &&
      onReason.includes("theme/deep/x.css"),
    `(a) the on arm strictly differs: it names the configured reverts the off arm kept (got ${onReason})`,
  );
  for (const rel of ["angular.json", "package-lock.json", "theme/deep/x.css"])
    assert(
      !existsSync(path.join(on.worktree, rel)),
      `(a) ${rel} is gone from the tree, not merely left out of the commit`,
    );
  assert(status(on.worktree) === "", `(a) clean after the commit (got ${status(on.worktree)})`);
}

// ── (b) the ceiling-stopped arm composes its OWN reason, so it needs its own pair
{
  const BUILD_TURNS = 3;
  const breach = (onProgress: BudgetOpts["onProgress"]) =>
    onProgress?.({ ...emptyRunningState("developer"), turns: BUILD_TURNS + 1 });
  const cfg = (): WorkConfig => ({
    ...configWith(GLOBS),
    budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
  });

  let off!: Awaited<ReturnType<typeof runBuild>>;
  await withEnv({ PI_ENSEMBLE_LEAN_PROTECTED_PATHS: "0" }, async () => {
    off = await runBuild({
      issue: 2367,
      config: cfg(),
      onProgressTick: breach,
      child: childEdits,
    });
  });
  assert(
    off.outcome?.kind === "budget",
    `(b) off arm is a budget verdict, got ${off.outcome?.kind}`,
  );
  const offReason = off.outcome?.reason ?? "";
  assert(
    (offReason.match(/reverted: ([^;]*)/) ?? [])[1] === ".pi/work.json",
    `(b) the ceiling handback's own reason names only the built-in (got ${offReason})`,
  );
  assert(
    !FIELD_MARKS.some((m) => offReason.includes(m)),
    `(b) with no trace of the field in it (got ${offReason})`,
  );

  const on = await runBuild({
    issue: 2368,
    config: cfg(),
    onProgressTick: breach,
    child: childEdits,
  });
  assert(on.outcome?.kind === "budget", `(b) on arm is a budget verdict, got ${on.outcome?.kind}`);
  const onReason = on.outcome?.reason ?? "";
  assert(
    onReason.includes("angular.json") &&
      onReason.includes("package-lock.json") &&
      onReason.includes("theme/deep/x.css"),
    `(b) the on arm's ceiling handback names the configured reverts too (got ${onReason})`,
  );
}

// ── (c) the review fixer's fold: what reaches origin is the claim, not a report
{
  const fixEdits = (wt: string) => {
    put(wt, "fix-uncommitted.ts", "export const fixed = true;\n");
    put(wt, "angular.json", '{ "scripts": { "lied": true } }\n');
    put(wt, "theme/deep/x.css", "body { color: red }\n");
    put(wt, ".pi/work.json", '{ "verify": { "test": "sh {file}" } }\n');
  };
  const frozenCtx = (repoRoot: string, baseSha: string) => {
    const ctx = ctxFor(repoRoot, baseSha, BRANCH);
    ctx.run.steps.push({
      key: "7:specify:0",
      state: "specify",
      startedAt: 1,
      endedAt: 2,
      outcome: {
        kind: "ok",
        frozen: { "tests/AC1.test.ts": sha256(frozenBlob(repoRoot, "HEAD")) },
        tests: { AC1: ["tests/AC1.test.ts"] },
      },
    });
    return ctx;
  };
  const deps = () =>
    depsWith({
      adversarial: rejectsThenClears("1. the finding the fixer must answer"),
      lens: async (a) => lensRoundFor(a, "APPROVED", []),
      loadConfig: async () => ({ ...defaultConfig(), lean: { protectedPaths: GLOBS } }),
      dispatch: async (spec) => {
        fixEdits(spec.cwd as string);
        return result({ role: FIXER_ROLE });
      },
    });
  const arm = async () => {
    const { repoRoot, baseSha } = makeRepo();
    await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
    const { outcome, threw } = await run(frozenCtx(repoRoot, baseSha), deps());
    return {
      outcome,
      threw,
      files: git(repoRoot, "show", "--name-only", "--format=", `origin/${BRANCH}`)
        .split("\n")
        .filter((p) => p !== ""),
    };
  };

  let off!: Awaited<ReturnType<typeof arm>>;
  await withEnv({ PI_ENSEMBLE_LEAN_PROTECTED_PATHS: "0" }, async () => {
    off = await arm();
  });
  assert(
    off.threw === undefined && off.outcome?.kind === "fixed",
    `(c) off arm completes (${off.threw?.message ?? `kind ${String(off.outcome?.kind)}`})`,
  );
  assert(
    off.files.includes("angular.json") && off.files.some((p) => p.startsWith("theme/")),
    `(c) with the switch off the fixer's configured edits are integrated, as before the field (got ${JSON.stringify(off.files)})`,
  );
  const offReason = off.outcome?.reason ?? "";
  assert(
    offReason.includes("reverted: .pi/work.json") &&
      !FIELD_MARKS.some((m) => offReason.includes(m)),
    `(c) and its reason names only the built-in revert (got ${offReason})`,
  );

  const on = await arm();
  assert(
    on.threw === undefined && on.outcome?.kind === "fixed",
    `(c) on arm completes (${on.threw?.message ?? `kind ${String(on.outcome?.kind)}`})`,
  );
  assert(
    on.files.includes("fix-uncommitted.ts") &&
      !on.files.includes("angular.json") &&
      !on.files.some((p) => p.startsWith("theme/")),
    `(c) the on arm reverts them before the push (got ${JSON.stringify(on.files)})`,
  );
  assert(
    (on.outcome?.reason ?? "").includes("angular.json") &&
      (on.outcome?.reason ?? "").includes("theme/deep/x.css"),
    `(c) and the on arm's reason names them, so the two arms read differently (got ${on.outcome?.reason})`,
  );
}

cleanupRoots();
for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
console.log(
  `\n${failures() === 0 ? "switch arms green" : "switch arms RED"} (${String(failures())} failing)`,
);
process.exit(failures());
