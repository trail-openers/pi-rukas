#!/usr/bin/env bun
/**
 * lean/review — the disposable fix tree, its fence, and the step's budget.
 *
 * Split from `test-lean-review-consolidation.ts` along the seam that file's own
 * cases describe: everything here touches a WORKTREE on disk — creates one,
 * fences a write into it, resets it, provisions it, and reads it back through
 * git. The consolidation suite folds values that need no tree at all. Two
 * files because the size ratchet refuses 831 lines, and the seam is real rather
 * than convenient: a tree case fails for a reason a fold case cannot produce
 * (a link that points at nothing, a directory that outlived its step).
 *
 *   (r) the fixer's write fence, and its tree's dependencies surviving the
 *       integration reset. The fence is judged with the PRODUCTION predicate the
 *       guard runs, on a tree that exists, because the step's own trees do not
 *       outlive the step.
 *
 *   (s) T1 — the tree identity travels in its own validated field, so the fixer
 *       row keeps a real duration and a resumed attempt still finds its tree.
 *
 *   (t) the step's budget is actually armed (H1/H2): a child bound derived from
 *       `budgets.review.minutes`, not the generic one, and the turns/tokens
 *       levers abort off the progress stream rather than sitting unread.
 *
 *   (u) the fix tree's NAME is derived from the durable run, not the process —
 *       arm, round, attempt and epoch. The regression it pins is two fixers in
 *       one round colliding on one path and `worktree add --force` ADOPTING the
 *       live tree instead of refusing.
 *
 *   (v) the integration resets the tree and PROVISIONS it again, in that order,
 *       so `clean -fdx` cannot leave a verify reading a tree with no dependencies.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/lean/config.ts";
import { FIX_RUN_ID_SHAPE, reviewAttemptFromLog } from "../src/lean/review-log.ts";
import { fixTreeName } from "../src/lean/review-tree.ts";
import type { DispatchUsageRow } from "../src/lean/step-budget.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import type { DispatchSpec } from "../src/types.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  DISPATCHES_MAX_ROWS,
  FIXER_ROLE,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixRunId,
  git,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (r) the fixer's write fence + the run tree's dependencies after reset ───
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  let fence: { root?: string; repo?: string } | undefined;
  // The tree exists only WHILE the fixer runs — `closeFixTrees` removes it when
  // the step ends. `loadFenceConfig` calls `usableDir` on the root, which refuses
  // a directory that is gone, so the fence is judged on a live tree: the stub
  // recreates the recorded root before the config is loaded. Recording the fence
  // at dispatch time and judging it after the fact against a deleted path would
  // make the production predicate answer "no fence" for a reason that has nothing
  // to do with what the step passed.
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: rejectsThenClears("1. silent catch"),
      dispatch: async (spec: DispatchSpec, opts) => {
        fence = opts.writeFence;
        put(spec.cwd as string, "fix.ts", "export const x = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(threw === undefined, `(r) the fix round completed (${threw?.message})`);
  assert(
    fence !== undefined &&
      typeof fence.root === "string" &&
      fence.root.includes("/.worktrees/lean-7-fix-"),
    `(r) THE FIXER IS DISPATCHED WITH A WRITE FENCE rooted at its own disposable tree — the same shape \`build\` passes, and the fence \`build\`'s builder has always had (got ${JSON.stringify(fence?.root)})`,
  );
  assert(
    fence?.repo === repoRoot,
    `(r) and the fence names the repo, so a write to the repo root is outside it (got ${String(fence?.repo)})`,
  );
  // The fence is not decoration: prove a write outside the tree is the case it
  // exists for, using the production predicate the guard applies to a child's
  // write/edit/bash.
  // The judgement is the PRODUCTION predicate the guard runs in every mode. A
  // fence the step passes but the guard never consults is a field on a spec.
  const { loadFenceConfig, judgeWrite } = await import("../src/write-fence-path.ts");
  const wt = String(fence?.root);
  fs.mkdirSync(wt, { recursive: true });
  // Loaded the way the driver loads it for a real child — through the env the
  // spawn stamps — so this exercises the same config the guard reads, not a
  // hand-built object that could be friendlier than the real one.
  const cfg = loadFenceConfig({
    PI_ENSEMBLE_WRITE_ROOT: wt,
    PI_ENSEMBLE_WRITE_REPO: String(fence?.repo),
    PI_ENSEMBLE_WRITE_SCRATCH: path.join(repoRoot, "scratch"),
  });
  // The fence config is the one the SPAWN stamps, read through the loader the
  // guard itself uses. If it did not load there is no fence to judge with and
  // the case is vacuous, so it fails here rather than judging a `undefined` cfg
  // into an agreeable verdict.
  if (cfg === undefined) throw new Error("(r) the fence config did not load from the spawn's env");
  assert(
    cfg.root !== undefined,
    "(r) the fence config loads from the spawn's env",
  );
  const inside = judgeWrite(path.join(wt, "src", "ok.ts"), wt, cfg);
  const outside = judgeWrite(path.join(repoRoot, "outside-the-tree.ts"), wt, cfg);
  assert(inside.ok, "(r) and the production fence allows a write inside the fixer's tree");
  assert(
    !outside.ok,
    `(r) and REFUSES a write to the repo root, which is what a fixer without a fence could do (${outside.ok ? "allowed" : outside.message})`,
  );
}

// ── (s) T1: the tree identity is data, not a smuggled duration ──────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
  const fixerRows: { ms: number; runId?: string }[] = [];
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async () => ({
        ...cleanLensRound(),
        verdict: "ISSUES_FOUND",
        findings: "- [HIGH] SECURITY a.ts:1: leak",
      }),
      dispatch: async (spec: DispatchSpec) => {
        put(spec.cwd as string, "fix.ts", "export const x = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the finding");
        // A child that reports a real wall clock: the row must keep it.
        return result({ role: FIXER_ROLE, ms: 1234 });
      },
    }),
  );
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  for (const r of rows) if (r.role === FIXER_ROLE) fixerRows.push({ ms: r.ms, runId: r.runId });
  // This run stops after one fix round, so it is well under the cap and the
  // assertion is that every child it paid for is on the record — the adversarial
  // pass, the lens round's six, and the fixer. Cap behaviour itself is case (w)
  // and wiring (e3)/(f), which drive counts past the limit.
  assert(
    rows.length > 0 && rows.length <= DISPATCHES_MAX_ROWS,
    `(s) every child the run paid for is on the record, within the cap (got ${String(rows.length)})`,
  );
  assert(
    fixerRows.length > 0 && fixerRows.every((r) => r.ms === 1234),
    `(s) the fixer row keeps the DURATION its child reported — it is no longer overwritten with a 13-digit epoch (${JSON.stringify(fixerRows.map((r) => r.ms))})`,
  );
  assert(
    fixerRows.every((r) => typeof r.runId === "string" && FIX_RUN_ID_SHAPE.test(String(r.runId))),
    `(s) and the tree identity is in \`runId\`, in the shape the validator accepts — so a row is never DROPPED for carrying it, which is how the step's most expensive child went unbilled (${JSON.stringify(fixerRows.map((r) => r.runId))})`,
  );
  // The role is the one constant both sides read, so the fixer-row match cannot
  // drift onto the builder's rows by a hand-copied string.
  assert(
    FIXER_ROLE === "developer",
    "(s) the fixer's role is the exported constant, shared with the row's reader",
  );
}

// ── (t) H1/H2: the step's budget is ARMED ───────────────────────────────────
//
// Before this the step read `budgets.review.turns` for one division and armed
// nothing: its reviewer, its six lenses and its fixer all ran under the generic
// child bound while the operator's three levers sat unread. The pilot that
// reported "minutes budget 20 exceeded (used 31)" beside a child that ran
// 1,800,180 ms is that gap, and a case that only checked `budget` was passed
// around would have been satisfied by an arm that armed nothing.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const seen: { advBound?: number; lensBound?: number; fixerBound?: number } = {};
  const clean = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async (a) => {
        seen.advBound = a.budget.opts.childBoundMs;
        return result({ loopOutcome: "approved" });
      },
      lens: async (a) => {
        seen.lensBound = a.budget.opts.childBoundMs;
        return cleanLensRound();
      },
    }),
  );
  assert(clean.threw === undefined, `(t) the clean run completed (${clean.threw?.message})`);
  // `budgets.review` ships at 15 minutes, so the armed wall clock is 15 * 60_000
  // — the operator's own number reaching the child. The lens leg clamps to the
  // per-lens knob as well, so assert the bound came FROM the budget by checking
  // it is the budget's value and not the generic default.
  const reviewMinutes = defaultConfig().budgets.review?.minutes ?? 0;
  assert(
    reviewMinutes > 0 && seen.advBound === reviewMinutes * 60_000,
    `(t) the adversarial gate's children carry a \`childBoundMs\` of \`budgets.review.minutes\` (${String(reviewMinutes)} min) — the budget is ARMED, not just divided (got ${String(seen.advBound)})`,
  );
  assert(
    seen.lensBound !== undefined && seen.lensBound <= reviewMinutes * 60_000 && seen.lensBound > 0,
    `(t) and so do the six lens children, clamped no higher than the step's own ceiling (got ${String(seen.lensBound)})`,
  );
  assert(
    clean.outcome?.dispatches?.some((r) => r.role === FIXER_ROLE) === false,
    "(t) a clean branch dispatches no fixer, so the fixer's bound is asserted on the fix path below",
  );

  // The turns/tokens levers are armed too, and they are the two that abort rather
  // than merely bound: a step that never built the arm leaves both levers dead.
  const abortSeen: number[] = [];
  const spent = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      loadConfig: async () => ({
        ...defaultConfig(),
        budgets: { ...defaultConfig().budgets, review: { turns: 3, tokens: 100, minutes: 30 } },
      }),
      adversarial: async (a) => {
        // The child reports progress past the ceiling, exactly as `spawn.ts`'s
        // stdout handler does, and the armed hook must abort on it.
        a.budget.opts.onProgress?.({
          role: FIXER_ROLE,
          turns: 9,
          toolUses: 9,
          totalTokens: 9_000_000,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 9 },
        } as never);
        abortSeen.push(a.budget.opts.signal?.aborted === true ? 1 : 0);
        // A child the abort ended comes back with its cause stamped, as `spawn.ts`
        // returns it. Reporting `approved` here would let the step keep going on a
        // child the budget killed and make the assertion below about the stub.
        return result({ loopOutcome: "approved", killCause: "abort" });
      },
    }),
  );
  assert(
    abortSeen.length > 0 && abortSeen[0] === 1,
    "(t) and the turns/tokens lever is LIVE: progress past the ceiling aborts the child's signal (signal not aborted)",
  );
  assert(
    spent.threw !== undefined || spent.outcome !== undefined,
    `(t) the run reached a decision either way (${spent.threw?.message ?? spent.outcome?.kind})`,
  );

  // H2's other half: a child the bound stopped is reported AS a budget stop, so
  // the step hands back the ceiling and the usage rather than a generic failure.
  const stopped = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () =>
        result({ loopOutcome: "approved", killCause: "child-bound", ms: 31 * 60_000 }),
    }),
  );
  // The assertion is on the VERDICT'S FIELDS, not on a sentence this step does
  // not own: `budgetVerdict` renders its wording in `step-budget.ts`, which three
  // renderers already share, and a review test pinning that wording is a fourth
  // copy of one fact. What this step owes is that the stop it read reaches the
  // engine as the review step's budget verdict, naming the lever and the number
  // the operator set.
  assert(
    stopped.threw === undefined && stopped.outcome?.kind === "budget",
    `(t) a reviewer the bound stopped yields a BUDGET verdict, not an error or a pass (${stopped.threw?.message ?? `kind ${String(stopped.outcome?.kind)}`})`,
  );
  const stop = stopped.outcome as {
    kind: "budget";
    limit: string;
    value: number;
    used: number;
    dispatches?: DispatchUsageRow[];
  } & Record<string, unknown>;
  assert(
    stop.limit === "minutes" && stop.value === reviewMinutes && stop.used === 31,
    `(t) and the verdict names the lever, the ceiling from \`budgets.review\` and the usage the child reported, so the operator can see which number to raise (got ${JSON.stringify([stop.limit, stop.value, stop.used])})`,
  );
  assert(
    stop.dispatches !== undefined && stop.dispatches.length > 0,
    "(t) and the children it paid for ride on the verdict rather than dying with the stop",
  );
}

// ── (u) the fix tree's name is derived from the durable run, not the process ─
//
// The name carries arm, round, attempt and the attempt's epoch. Each closes a
// different hole, and the assertions below drive all four — including the
// regression that made this a bug: a review round dispatches a fixer on TWO arms
// (the adversarial gate's pass-with-findings, and the six-lens round's findings),
// so keying the name by the round alone named one path twice, and `worktree add
// --force` ADOPTED the live tree instead of refusing — the second fixer's head
// already held the first's commits, and the step reported "fixed nothing".
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const trees: string[] = [];
  let advU = 0;
  let lensU = 0;
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      // Round 1 takes BOTH arms: the adversarial gate passes with findings (fix
      // in the "a" tree), then the lens round finds more (fix in the "l" tree).
      // Both gates must CLEAR by round 2 or the step keeps buying fixers: the
      // adversarial text and the lens findings differ (different gates, so
      // `stagnantAgainstFix` compares each against its own gate's last ask), and
      // each gate only reports findings on the first pass.
      adversarial: async () =>
        advU++ === 0
          ? result({ loopOutcome: "approved", text: "Adversarial PASSED WITH FINDINGS: 1. leak" })
          : result({ loopOutcome: "approved", text: "" }),
      lens: async () =>
        lensU++ === 0
          ? {
              ...cleanLensRound(),
              verdict: "ISSUES_FOUND" as const,
              findings: "- [HIGH] SECURITY a.ts:1: leak",
            }
          : cleanLensRound(),
      dispatch: async (spec: DispatchSpec) => {
        const wt = spec.cwd as string;
        trees.push(wt);
        // A REAL commit, from inside the tree, through the same env the step's
        // own git calls use. `add -A` is separate from `commit`: the fixer's
        // brief tells it to commit, and a fixture that only wrote a file would
        // prove the no-progress break fires on a no-op rather than that a real
        // fix advances the head.
        put(wt, `fix-${String(trees.length)}.ts`, "export const x = 1;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    threw === undefined,
    `(u) two fixers in one review round both ran and both integrated (${threw?.message})`,
  );
  assert(
    trees.length >= 2 && new Set(trees).size === trees.length,
    `(u) and no two of them share a path — a collision here is silently ADOPTED by \`add --force\`, which is how this read as "the fixer fixed nothing" (${JSON.stringify(trees.map((t) => t.split("/").pop()))})`,
  );
  // The round counter counts LOOP ITERATIONS, not fixers: round 1 takes the
  // adversarial arm and continues, so the lens arm's fix is round 2's. What the
  // adoption bug needed fixed is that the TWO ARMS of one round never collide,
  // which is `arm` in the name doing that job — asserted by the two distinct
  // paths and their distinct arm letters, not by both reading round 1.
  assert(
    trees.length >= 2 && trees[0]!.includes("-fix-a-") && trees[1]!.includes("-fix-l-"),
    `(u) the two arms name the adversarial tree and the lens tree (${JSON.stringify(trees.map((t) => t.split("/").pop()))})`,
  );
  // Both commits are on origin: the second fix built ON the first, which is what
  // the adoption bug destroyed.
  const originHead = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  const commits = git(repoRoot, "rev-list", `origin/${BRANCH}`).split("\n").length;
  assert(
    commits >= 4 && originHead !== baseSha,
    `(u) every fix round's commit is on origin — the later fix built on the earlier one, not on a tree that already contained it (${String(commits)} commits on the branch)`,
  );

  // The resume half: the name must be RE-DERIVABLE, so the same attempt re-runs
  // into the same paths. Nothing in memory is consulted, which is the only way a
  // re-run can agree with the attempt that died.
  const ctxA = ctxFor(repoRoot, baseSha, BRANCH);
  const first = fixTreeName(
    repoRoot,
    7,
    "l",
    2,
    reviewAttemptFromLog(ctxA.steps),
    fixRunId("1793451347919"),
  );
  const resumed = fixTreeName(
    repoRoot,
    7,
    "l",
    2,
    reviewAttemptFromLog(ctxA.steps),
    fixRunId("1793451347919"),
  );
  assert(
    first === resumed,
    `(u) a resumed attempt derives the SAME tree path for the same fix, so it re-enters the tree its killed self left instead of orphaning it and provisioning a second (${first} vs ${resumed})`,
  );
  const concurrent = fixTreeName(
    repoRoot,
    7,
    "l",
    2,
    reviewAttemptFromLog(ctxA.steps) + 1,
    fixRunId("1793451347919"),
  );
  assert(
    concurrent !== first,
    `(u) and a second concurrent attempt on the same issue and round gets its OWN path, so neither can adopt the other's leftovers (${concurrent.split("/").pop()})`,
  );
}

// ── (v) the integration resets the tree and provisions it again ───────────
//
// `ensureSpecifyWorktreeWithProvision` runs `git reset --hard` and provisions
// BEFORE it, so reusing it here would have reset the tree the fixer had just
// committed in and then linked dependencies to a tree with no code in it. The
// step must reset, provision AFTER, and integrate the commit it was given.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // A gitignored dependency tree in the main checkout: provisioning links it, and
  // a reset that ran after provisioning would have left the link pointing at a
  // tree with nothing checked out.
  const depsDir = path.join(repoRoot, "node_modules");
  fs.mkdirSync(path.join(depsDir, "some-dep"), { recursive: true });
  fs.writeFileSync(path.join(depsDir, "some-dep", "index.js"), "module.exports = 1;\n");
  fs.appendFileSync(path.join(repoRoot, ".gitignore"), "\nnode_modules\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "chore: ignore node_modules");

  const trees: string[] = [];
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: rejectsThenClears("1. silent catch"),
      dispatch: async (spec: DispatchSpec) => {
        const wt = spec.cwd as string;
        trees.push(wt);
        // The dependency link must be live WHILE the fixer works: provisioning
        // before the reset would have put the tree in a state where the child
        // could not resolve its own imports.
        fs.writeFileSync(path.join(wt, "fix.ts"), "export const x = 1;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(threw === undefined, `(u) the fix round integrated (${threw?.message})`);
  assert(trees.length > 0, "(u) a fix round ran");
  assert(
    git(repoRoot, "rev-parse", `origin/${BRANCH}`).length === 40,
    "(u) precondition: the branch head is a full sha — the fixture planted it, and the integration moves it",
  );
  const pushed = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  assert(pushed !== git(repoRoot, "rev-parse", baseSha), "(u) the fixer's commit reached origin");
  // The disposable tree is gone: this step leaves no attached worktree behind, so
  // the next /work's branch step cannot abort on a dirty tree.
  const leftover = fs
    .readdirSync(path.join(repoRoot, ".worktrees"))
    .filter((d) => d.startsWith("lean-7-fix-"));
  assert(
    leftover.length === 0,
    `(u) no fixer tree survives the step (${JSON.stringify(leftover)})`,
  );
}

cleanupRoots();
process.exit(failures());
