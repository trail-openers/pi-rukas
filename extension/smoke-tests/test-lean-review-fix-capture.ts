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
 *
 * Every case drives the whole step, so each refusal is read off origin: what the
 * wave pushed (or failed to push) is the claim, not what a helper returned.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { existsSync } from "node:fs";
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
import { put } from "./lib/lean-build-fixture.ts";
import { ctxFor } from "./lib/lean-review-fixtures.ts";
import { sha256 } from "../src/lean/specify-proof.ts";

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
 */
const deps = (write: (cwd: string) => void) =>
  depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer must answer"),
    lens: async (a) => lensRoundFor(a, "APPROVED", []),
    dispatch: async (spec) => {
      write(spec.cwd as string);
      return result({ role: FIXER_ROLE });
    },
  });

/** `git log --format=%s base..ref` — the subjects the branch gained. */
const subjects = (repoRoot: string, base: string, ref: string): string[] =>
  git(repoRoot, "log", "--format=%s", `${base}..${ref}`).split("\n").filter((s) => s !== "");

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
    const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 5;\n" });
    const { threw } = await run(frozenCtx(repoRoot, baseSha), deps(write));
    return { repoRoot, head, threw, origin: git(repoRoot, "rev-parse", `origin/${BRANCH}`) };
  };
  const cheated = await frozenArm((wt) => put(wt, "tests/AC1.test.ts", "// rewrote the contract\n"));
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
  const { threw } = await run(frozenCtx(repoRoot, baseSha), deps(() => {}));
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

cleanupRoots();
process.exit(failures());
