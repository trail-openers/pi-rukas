/**
 * lib/lean-review-fixtures — the temp-repo harness the `lean/review` smoke
 * tests share.
 *
 * `review`'s claims are git claims ("origin holds the head the gates read",
 * "the fixer's commit is on the branch", "the frozen blob still hashes to its
 * record"), so a stub exec would test the stub. Here the repo, the branch and
 * the commits are real and `exec` shells out to the real `execp`; only the
 * models are stubs, behind the three injected seams of `ReviewDeps`. No child
 * process is spawned and no token is spent.
 *
 * One array of temp roots is shared by both suites and each cleans it at its
 * own end (`cleanupRoots` is idempotent), because the two files exercise the
 * same step from two angles and would otherwise duplicate all of this.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { ADVERSARIAL_GATE_ROLE } from "../../src/lean/review-gates.ts";
import type { LensRound, ReviewDeps } from "../../src/lean/review.ts";
import { ReviewInfraError, reviewOutcome } from "../../src/lean/review.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import { FIXER_ROLE } from "../../src/lean/step-budget.ts";
import { FIX_RUN_ID_SHAPE } from "../../src/lean/review-log.ts";
import type { LensName, LensRunResult } from "../../src/lens-review-types.ts";
import { aggregateLensUsage } from "../../src/lens-review-usage.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { put } from "./lean-build-fixture.ts";

const ROOTS: string[] = [];

export function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/**
 * The env the harness's REAL `execp` hands its children.
 *
 * `execp` forwards `opts.env` verbatim — no merge with `process.env` — and
 * `src/lean/review-deps.ts` builds that env as the git view plus nothing else.
 * A minimal env with no PATH is an env in which `git` cannot be found, so the
 * step's own git reads all came back as failures; and with no HOME or identity,
 * a fixer's `git commit` died on "Please tell me who you are" — which read as a
 * broken integration rather than a fixture that had quietly replaced the
 * environment. So: the real parent env, plus the isolation the git view needs,
 * plus the identity. The fixture's git calls and the step's git calls must see
 * the same environment, or a case only ever proves the stub works.
 */
export function stepGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...gitEnv() };
}

/** A repo with a base commit, a `main` branch, and a bare origin it pushes to. */
export function makeRepo(): { repoRoot: string; origin: string; baseSha: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-review-"));
  const origin = mkdtempSync(path.join(tmpdir(), "lean-review-origin-"));
  ROOTS.push(repoRoot, origin);
  git(repoRoot, "init", "-q", "-b", "main");
  git(origin, "init", "-q", "--bare");
  put(repoRoot, "a.ts", "export const a = 1;\n");
  put(repoRoot, "tests/AC1.test.ts", "// frozen\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  git(repoRoot, "remote", "add", "origin", origin);
  git(repoRoot, "push", "-q", "-u", "origin", "main");
  return { repoRoot, origin, baseSha: git(repoRoot, "rev-parse", "HEAD") };
}

export const USAGE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 10 };

/**
 * One lens child's record, as the review layer reports it and as `lensRows`
 * bills it. `n` makes the six rows of a round distinguishable in an assertion:
 * `ms` and every usage counter scale with it, so a fold that collapsed the
 * round into one row or dropped a child is visible in the totals.
 */
export function lensRowResult(n: number, over: Partial<LensRunResult> = {}): LensRunResult {
  return {
    lens: LENS_NAMES[n % LENS_NAMES.length] as LensName,
    ok: true,
    ms: 100 * (n + 1),
    startMs: 0,
    findings: [],
    summary: `lens ${String(n)} clean`,
    attempts: 1,
    blocked: false,
    usage: {
      input: 10 * (n + 1),
      output: n + 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.1 * (n + 1),
      turns: n + 1,
    },
    ...over,
  };
}

/** The six lens names, so a round's rows read like the real roster's. */
const LENS_NAMES: LensName[] = [
  "SECURITY",
  "PERFORMANCE",
  "SIMPLICITY",
  "ARCHITECTURE",
  "ERROR_HANDLING",
  "TYPE_SAFETY",
];

/**
 * A clean six-lens round: six children, each with its own usage, which is what
 * a round that actually ran looks like. A round with `usage: undefined` is a
 * round that ran nobody, and the step refuses it (`test-lean-review-absence.ts`).
 *
 * The round's aggregate comes from `aggregateLensUsage`, the PRODUCTION fold the
 * review layer itself uses. A fixture that hand-rolled the sum was a second
 * definition of "what a round cost" inside the tests: it kept agreeing with the
 * fixture's own arithmetic while the rows the step actually bills came from
 * `lensRows`, and the two could drift with nothing red.
 */
export function cleanLensRound(): LensRound {
  const lenses = LENS_NAMES.map((_, i) => lensRowResult(i));
  return {
    verdict: "APPROVED",
    findings: "",
    lenses,
    usage: aggregateLensUsage(lenses),
  };
}

/**
 * One dispatch result. The default role is `ADVERSARIAL_GATE_ROLE` — the role
 * the adversarial LOOP synthesises, not the inner reviewer's — because the
 * adversarial stubs here stand for the loop's return value. Spelling the wrong
 * role in the fixture and the same wrong role in the assertion is how this row
 * was mis-attributed for a whole release: both sides agreed and nothing pinned
 * it, so the fixture carries the production constant instead.
 */
export function result(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: ADVERSARIAL_GATE_ROLE,
    ok: true,
    text: "",
    toolUses: [],
    ms: 5,
    exitCode: 0,
    usage: USAGE,
    ...over,
  };
}

/** The step under test, with the outside world replaced by these. */
export function depsWith(over: Partial<ReviewDeps>): ReviewDeps {
  return {
    headless: false,
    exec: (cmd, o) => execp(cmd, { ...(o ?? {}), env: { ...stepGitEnv(), ...(o?.env ?? {}) } }),
    adversarial: async () => result({ loopOutcome: "approved" }),
    // The production shape of a clean round: six lenses ran, each with its own
    // usage. A round with no lens records is a round that ran nobody, and the
    // step refuses it (`test-lean-review-absence.ts`).
    lens: async () => cleanLensRound(),
    dispatch: async () => result({ role: FIXER_ROLE }),
    fetchIssueBody: async () => "body",
    loadConfig: async () => defaultConfig(),
    ...over,
  };
}

export function ctxFor(repoRoot: string, baseSha: string, branch: string): HandlerCtx {
  const run = createRun({ issue: 7, version: "test", models: {}, baseSha, branch });
  return { repoRoot, issue: 7, run, steps: run.steps, stepKey: "7:review:0", now: () => 1 };
}

/** Publish `branch` on origin and in the run's worktree, at a commit on `base`. */
export async function setup(opts: {
  repoRoot: string;
  baseSha: string;
  branch: string;
  /** A file the head commit adds, so the head is not the base. */
  feature?: string;
  /** A frozen test the head commit tampers with. */
  tamper?: boolean;
}): Promise<string> {
  const wt = path.join(opts.repoRoot, ".worktrees", "lean-7");
  git(opts.repoRoot, "worktree", "add", "-B", opts.branch, wt, opts.baseSha);
  if (opts.feature !== undefined) {
    put(wt, "feature.ts", opts.feature);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "feat: the work");
  }
  if (opts.tamper === true) {
    put(wt, "tests/AC1.test.ts", "// edited by the fixer\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "fix: broke the contract");
  }
  git(wt, "push", "-q", "origin", `refs/heads/${opts.branch}`);
  return git(wt, "rev-parse", "HEAD");
}

export const BRANCH = "lean/issue-7";

/**
 * The frozen acceptance test's committed bytes at `ref`, byte for byte.
 *
 * The hash the step must be handed is the one `specify` froze, and that is a hash
 * of the COMMITTED bytes — so this reads them out of git rather than off a
 * working copy, which is whatever the last case in this file left behind. `latin1`
 * is the one encoding that round-trips every byte, so a frozen test holding
 * invalid UTF-8 still hashes to the record the freeze made (same reasoning as
 * `blobAt` in `src/lean/build-git.ts`). `trim()` is deliberately NOT applied —
 * that would change the bytes.
 */
export function frozenBlob(repoRoot: string, ref: string): string {
  const r = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "show", `${ref}:tests/AC1.test.ts`],
    {
      cwd: repoRoot,
      encoding: "latin1",
      env: gitEnv(),
    },
  );
  if (r.status !== 0)
    throw new Error(`git show ${ref}:tests/AC1.test.ts failed: ${(r.stderr ?? "").trim()}`);
  return r.stdout ?? "";
}

/**
 * A fixer stub that DOES its job: writes a file and commits it in the tree the
 * step dispatched it to.
 *
 * The default `dispatch` above commits nothing, which is the right stub for the
 * no-progress case and the wrong one for every case that needs the loop to reach
 * a later round: a fixer that commits nothing is refused by `assertFixAdvanced`
 * (correct product behaviour) and the case then measures that break instead of
 * what it names. `tag` makes each round's commit unique, so two rounds cannot
 * produce byte-identical trees and the head genuinely advances each time.
 */
export function fixerThatCommits(tag: string) {
  // Counted per (tree, tag), not per factory instance. A factory shared across
  // cases in one repo — which is what the suite does, and correctly, since `setup`
  // moves `origin/<branch>` for each — restarted at 0 for the next case and wrote
  // `fix-<tag>-0.ts` again. The round's fix tree is named for
  // arm-round-attempt-epoch, and the fixture's clock is frozen at 1, so a second
  // case's round-1 tree reuses the first case's path; `git worktree add --force`
  // then ADOPTS that registration with the earlier commit still in it, and the
  // child's byte-identical commit is a no-op. The step sees the branch move twice
  // for one fix round and integrates a head no child produced. Each distinct tree
  // therefore gets its own counter, so every fix round's commit is genuinely new
  // wherever in the suite it is dispatched.
  const written = new Map<string, number>();
  let n = 0;
  return async (spec: DispatchSpec): Promise<DispatchResult> => {
    const wt = spec.cwd as string;
    const seen = written.get(wt) ?? 0;
    written.set(wt, seen + 1);
    const name = `fix-${tag}-${String(seen)}.ts`;
    // `put` skips a write whose content already matches, so a name that collided
    // with a file in an adopted tree would leave the tree dirty in a way the fixer
    // never caused. A second fix in the same tree gets a fresh name; the assertion
    // that this exists for is in `test-lean-review-wiring.ts` (e3), where a branch
    // that moved twice for one round shifts the cost-row clip by one.
    put(wt, name, `export const x = ${String(n++)};\n`);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", `fix: ${tag}`);
    return result({ role: FIXER_ROLE });
  };
}

/** Run the step; a throw comes back as the error so each case asserts on it. */
export async function runStep(
  ctx: HandlerCtx,
  deps: ReviewDeps,
): Promise<{ outcome?: Outcome; threw?: Error }> {
  try {
    return { outcome: await reviewOutcome(ctx, deps) };
  } catch (err) {
    return { threw: err as Error };
  }
}

/** Every temp dir this harness made, removed. Safe to call from each suite. */
export function cleanupRoots(): void {
  for (const dir of ROOTS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * An adversarial stub that asks once, then clears.
 *
 * The review step refuses to pay for a second look at findings it already asked
 * a fixer to fix (`stagnantAgainstFix` in `review.ts`): same gate, same text, a
 * head that moved. So a stub that answers `rejected` with ONE fixed string
 * converges exactly once — the fixer commits, the step asks again, and the break
 * fires. That is the step working, and a fixture that reads it as a bug is
 * testing its own stub. A case that needs more than one fix round must say so
 * explicitly: this helper clears after `asks` refusals rather than leaving the
 * caller to discover the break by timeout.
 */
export function rejectsThenClears(text: string, asks = 1): () => Promise<DispatchResult> {
  let n = 0;
  return async () =>
    n++ < asks
      ? result({ loopOutcome: "rejected", text })
      : result({ loopOutcome: "approved", text: "" });
}

export { MAX_REVIEW_ROUNDS, ReviewInfraError } from "../../src/lean/review.ts";
export type { DispatchUsageRow, FixRunId } from "../../src/lean/step-budget.ts";
import type { FixRunId as _FixRunId } from "../../src/lean/step-budget.ts";
/**
 * A tree-run identity the step will accept.
 *
 * `FixRunId` is a branded string — the brand is what stops an arbitrary string
 * reaching `fixTreeName` and naming a tree nobody claims. A fixture has to build
 * one legitimately rather than `as never` past the check, or the suite drives a
 * value production would refuse and the assertion proves nothing about the real
 * path. The shape asserted here is `FIX_RUN_ID_SHAPE`'s own, so a fixture that
 * drifted from the validator's grammar fails at construction, not in a
 * downstream assertion that would have blamed the step.
 */
export function fixRunId(millis: string): _FixRunId {
  if (!FIX_RUN_ID_SHAPE.test(millis))
    throw new Error(`not a tree-run identity: ${JSON.stringify(millis)}`);
  return millis as _FixRunId;
}
export { ADVERSARIAL_GATE_ROLE } from "../../src/lean/review-gates.ts";
export { DISPATCHES_MAX_ROWS } from "../../src/lean/state-outcome.ts";
export { FIXER_ROLE, LENS_ROLE } from "../../src/lean/step-budget.ts";
export type { DispatchSpec, Outcome, ReviewDeps };
