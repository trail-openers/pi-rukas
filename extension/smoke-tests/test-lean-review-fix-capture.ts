#!/usr/bin/env bun
/**
 * lean/review — a fixer's UNCOMMITTED edits are captured, not discarded.
 *
 * The field failure this pins: the fix developer made one real edit, ended its
 * turn without committing, and `fixRound` read back the untouched HEAD, so
 * `assertFixAdvanced` threw "review fix produced no change" and the run handed
 * back with the fix sitting in the fix tree that teardown then destroyed. `build`
 * has never had that failure because `normaliseBuild` captures the child's
 * changed set and the DRIVER makes the commit. The fix wave now calls the same
 * fold before it destroys the tree, so:
 *
 *   (a) a fixer that edits and never commits -> ONE driver commit, branch advances
 *   (b) a fixer that edits a frozen test / a protected path -> refused or reverted, named
 *   (c) a fixer that changes nothing -> CAUSE_NO_CHANGE, unchanged
 *   (d) a fixer that commits its own work -> unchanged
 *   (e) a fixer that edits a path matching a CONFIGURED `lean.protectedPaths` glob ->
 *       reverted like a built-in, named in the step reason, and absent from origin —
 *       and the same edit KEPT with `PI_ENSEMBLE_LEAN_PROTECTED_PATHS=0`
 *
 * Every case drives the whole step, so each refusal is read off origin: what the
 * wave pushed (or failed to push) is the claim, not what a helper returned.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { existsSync } from "node:fs";
import { defaultConfig } from "../src/lean/config.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import { withEnv } from "./lib/env-scope.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  CAUSE_NO_CHANGE,
  FIXER_ROLE,
  cleanupRoots,
  depsWith,
  fixerThatCommits,
  frozenBlob,
  git,
  lensRoundFor,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { ctxFor } from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

/** A run whose `specify` froze this repo's acceptance test at `ref`. */
function frozenCtx(repoRoot: string, baseSha: string) {
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
}

/**
 * A wave the gate buys once and the re-review then clears. `write` acts as the
 * fixer: whatever it leaves in `spec.cwd` is what the fold has to answer for.
 *
 * `protectedPaths` is the project's OWN list as its `.pi/work.json` would name it.
 * It rides the step's config read — `loadConfig` is the seam the step already uses
 * at the run's base sha — so a case states the project's rule rather than a fold's
 * private idea of one.
 */
const deps = (write: (cwd: string) => void, protectedPaths?: string[]) =>
  depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer must answer"),
    lens: async (a) => lensRoundFor(a, "APPROVED", []),
    ...(protectedPaths === undefined
      ? {}
      : {
          loadConfig: async () => ({
            ...defaultConfig(),
            lean: { protectedPaths },
          }),
        }),
    dispatch: async (spec) => {
      write(spec.cwd as string);
      return result({ role: FIXER_ROLE });
    },
  });

/** `git log --format=%s base..ref` — the subjects the branch gained. */
const subjects = (repoRoot: string, base: string, ref: string): string[] =>
  git(repoRoot, "log", "--format=%s", `${base}..${ref}`)
    .split("\n")
    .filter((s) => s !== "");

// ── (a) a fixer that edits and never commits is captured by the driver ───────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const { outcome, threw } = await run(
    frozenCtx(repoRoot, baseSha),
    deps((cwd) => {
      put(cwd, "fix-uncommitted.ts", "export const fixed = true;\n");
    }),
  );
  const after = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  const gained = subjects(repoRoot, head, after);
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(a) the wave that discarded an uncommitted fix now completes (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    after !== head,
    `(a) and the branch advanced off ${head.slice(0, 12)} rather than handing back at it`,
  );
  assert(
    gained.length === 1 && (gained[0] ?? "").startsWith("build: attempt"),
    `(a) the branch holds ONE driver commit naming the fold, not the child's silence (got ${JSON.stringify(gained)})`,
  );
  assert(
    threw === undefined && (outcome?.dispatches ?? []).some((r) => r.role === FIXER_ROLE),
    "(a) and the fixer is still billed for the round it was paid for",
  );
}

/** The committed bytes at `ref` for `rel`, byte for byte — what a fold must not move. */
const blob = (repoRoot: string, ref: string, rel: string): string =>
  git(repoRoot, "show", `${ref}:${rel}`);

// ── (b) a frozen edit is refused; a protected edit is reverted and named ─────
//
// Both arms drive the whole step, because the claim is what reaches origin. The
// frozen arm is the fold's OWN refusal (`integrate` only ever sees a frozen edit
// the child COMMITTED, which test-lean-review-frozen.ts (x0) pins): the fold's
// reset puts the frozen bytes back either way, so the refusal is not about the
// branch's safety — it is that a wave which edited the acceptance contract has
// not answered the findings it was paid for. The protected arm is the opposite
// verdict: an edit to `.pi/` is reverted, named in the report, and the wave
// proceeds, so nothing may reach origin and nothing may throw.
{
  const frozenArm = async (write: (wt: string) => void) => {
    const { repoRoot, baseSha } = makeRepo();
    const head = await setup({
      repoRoot,
      baseSha,
      branch: BRANCH,
      feature: "export const f = 5;\n",
    });
    const { threw } = await run(frozenCtx(repoRoot, baseSha), deps(write));
    return { repoRoot, head, threw, origin: git(repoRoot, "rev-parse", `origin/${BRANCH}`) };
  };
  const cheated = await frozenArm((wt) =>
    put(wt, "tests/AC1.test.ts", "// rewrote the contract\n"),
  );
  assert(
    cheated.threw !== undefined &&
      /frozen acceptance contract/.test(cheated.threw.message) &&
      cheated.threw.message.includes("tests/AC1.test.ts"),
    `(b) a fixer's uncommitted edit to a frozen test is refused and NAMED (${cheated.threw?.message})`,
  );
  assert(
    cheated.origin === cheated.head,
    "(b) and the refused fix never reached origin — the branch still holds the reviewed head",
  );
  const protectedArm = await frozenArm((wt) => {
    put(wt, ".pi/work.json", '{"verify":{"test":"sh {file}"}}\n');
    put(wt, "fix-uncommitted.ts", "export const fixed = true;\n");
  });
  assert(
    protectedArm.threw === undefined && protectedArm.origin !== protectedArm.head,
    `(b) a protected edit does NOT refuse the wave the way a frozen one does (${protectedArm.threw?.message ?? "no throw"})`,
  );
  assert(
    git(protectedArm.repoRoot, "rev-parse", `origin/${BRANCH}`) === protectedArm.origin &&
      !existsSync(`${protectedArm.repoRoot}/.pi/work.json`) &&
      git(protectedArm.repoRoot, "show", `origin/${BRANCH}:fix-uncommitted.ts`).includes("fixed"),
    "(b) the reverted .pi file is neither on origin nor left in the tree, and the real fix landed",
  );
}

// ── (c) a fixer that changes nothing still gets the named no-change cause ────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const { threw } = await run(
    frozenCtx(repoRoot, baseSha),
    deps(() => {}),
  );
  assert(
    threw !== undefined && threw.message.includes(CAUSE_NO_CHANGE),
    `(c) a fixer that left neither a commit nor any edit still names the no-change cause (${threw?.message})`,
  );
}

// ── (d) a fixer that commits its own work behaves exactly as today ───────────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
  const committer = fixerThatCommits("own");
  const { outcome, threw } = await run(
    frozenCtx(repoRoot, baseSha),
    depsWith({
      adversarial: rejectsThenClears("1. the finding the fixer must answer"),
      lens: async (a) => lensRoundFor(a, "APPROVED", []),
      dispatch: (spec) => committer(spec),
    }),
  );
  const gained = subjects(repoRoot, head, git(repoRoot, "rev-parse", `origin/${BRANCH}`));
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(d) a fixer that committed its own work still passes (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    gained.length === 1 && gained[0] === "fix: own",
    `(d) and it is the CHILD's commit on the branch, unfolded (got ${JSON.stringify(gained)})`,
  );
}

// ── (e) the CONFIGURED globs reach the fix fold too, and the switch takes them out ──
//
// `build`'s two arms have their own suite (`test-lean-protected-paths.ts`); this is
// the third `normaliseBuild` caller. A project that names `angular.json` in
// `.pi/work.json` means it in every fold: a fixer that edited it and had the edit
// KEPT would put the very file the project protects onto the merged branch, with the
// build step's rule never having been asked. The two arms below are the whole scope
// claim of `PI_ENSEMBLE_LEAN_PROTECTED_PATHS` — configured globs in, built-ins and
// everything else untouched — driven through the real step so the claim is about what
// reaches origin, not about what a helper returned.
{
  // The built-in edit is the control inside each arm: it must be reverted whatever
  // the switch says, so an arm that reverted nothing could not pass both assertions.
  const write = (wt: string) => {
    put(wt, "fix-uncommitted.ts", "export const fixed = true;\n");
    put(wt, "angular.json", '{ "scripts": { "lied": true } }\n');
    put(wt, "src/theme/deep/x.css", "body { color: red }\n");
    put(wt, ".pi/work.json", '{"verify":{"test":"sh {file}"}}\n');
  };
  const GLOBS = ["angular.json", "theme/"];

  const arm = async (switchOff: boolean) => {
    const { repoRoot, baseSha } = makeRepo();
    const head = await setup({
      repoRoot,
      baseSha,
      branch: BRANCH,
      feature: "export const f = 6;\n",
    });
    const driven = await run(frozenCtx(repoRoot, baseSha), deps(write, GLOBS));
    return {
      repoRoot,
      head,
      ...driven,
      origin: git(repoRoot, "rev-parse", `origin/${BRANCH}`),
      files: git(repoRoot, "show", "--name-only", "--format=", `origin/${BRANCH}`)
        .split("\n")
        .filter((p) => p !== ""),
    };
  };

  const on = await arm(false);
  assert(
    on.threw === undefined && on.outcome?.kind === "fixed",
    `(e) the wave completes with a configured path among the fixer's edits (${on.threw?.message ?? `kind ${String(on.outcome?.kind)}`})`,
  );
  assert(
    !on.files.includes("angular.json") && !on.files.some((p) => p.startsWith("src/theme/")),
    `(e) the configured-glob edits never reached origin — the fold reverted them as it reverts a built-in (got ${JSON.stringify(on.files)})`,
  );
  assert(
    on.files.includes("fix-uncommitted.ts"),
    `(e) while the fixer's real work is still integrated (got ${JSON.stringify(on.files)})`,
  );
  assert(
    (on.outcome?.reason ?? "").includes("reverted: ") &&
      (on.outcome?.reason ?? "").includes("angular.json") &&
      (on.outcome?.reason ?? "").includes("src/theme/deep/x.css") &&
      (on.outcome?.reason ?? "").includes(".pi/work.json"),
    `(e) and the step's own reason names every revert, configured and built-in alike (got ${on.outcome?.reason})`,
  );

  // The off arm: the SAME config, the SAME fixer, the env the only difference. The
  // configured paths survive and the built-in does not — which is the byte-identity
  // claim of R5 read as behaviour rather than as a string comparison.
  await withEnv({ PI_ENSEMBLE_LEAN_PROTECTED_PATHS: "0" }, async () => {
    const off = await arm(true);
    assert(
      off.threw === undefined && off.outcome?.kind === "fixed",
      `(e) with the switch off the wave still completes (${off.threw?.message ?? `kind ${String(off.outcome?.kind)}`})`,
    );
    assert(
      off.files.includes("angular.json") && off.files.some((p) => p.startsWith("src/theme/")),
      `(e) the configured paths are KEPT with the switch off — the pre-field fold (got ${JSON.stringify(off.files)})`,
    );
    assert(
      !off.files.includes(".pi/work.json"),
      `(e) and the BUILT-IN is still reverted — the switch reaches the configured list and nothing else (got ${JSON.stringify(off.files)})`,
    );
    assert(
      (off.outcome?.reason ?? "").includes("reverted: .pi/work.json") &&
        !(off.outcome?.reason ?? "").includes("angular.json"),
      `(e) and the reason names only the built-in (got ${off.outcome?.reason})`,
    );
  });
}

cleanupRoots();
process.exit(failures());
