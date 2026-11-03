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
import type { ReviewWave } from "../../src/lean/review-args.ts";
import { ADVERSARIAL_GATE_ROLE } from "../../src/lean/review-gates.ts";
import { FIX_RUN_ID_SHAPE, PASS_KINDS } from "../../src/lean/review-log.ts";
import type { LensRound, ReviewDeps } from "../../src/lean/review.ts";
import { ReviewInfraError, reviewOutcome } from "../../src/lean/review.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import { FIXER_ROLE } from "../../src/lean/step-budget.ts";
import { DEFAULT_REVIEW_THRESHOLD } from "../../src/lens-review-format.ts";
import type { Finding } from "../../src/lens-review-types.ts";
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
 * A blocking finding, in the shape the review layer's `reported` rows arrive in.
 *
 * The step reads structured rows now (`LensRound.reported`), not only the
 * rendered line a fixer is handed, so a fixture that built only the string could
 * not drive the re-review's decision at all. The only row property the step reads
 * is `carried` — the layer's own "still open" — so a case that wants a row to hand
 * the run back re-reports it carried (the re-review stubs in the `test-lean-review-*`
 * suites do this through `lensRoundFor`/`lensRoundWith`), and one that wants
 * it answered reports nothing.
 */
export function blockingFinding(over: Partial<Finding> = {}): Finding {
  return {
    severity: "HIGH",
    lens: "SECURITY",
    path: "a.ts",
    line: 1,
    title: "leak",
    ...over,
  };
}

/** A blocking row the re-review reported as CARRIED — the layer's NOT ADDRESSED. */
export function carriedFinding(over: Partial<Finding> = {}): Finding {
  return { ...blockingFinding(), carried: true, ...over } as Finding;
}

/**
 * A six-lens round with a caller-chosen verdict and rows.
 *
 * `rows` defaults to none, which is what a round that found nothing reports —
 * `findings` is then the empty string, as the wiring renders it. Six children
 * always ran (each with its own usage), because a round that ran nobody is a
 * round the step refuses, and a fixture must not be able to fake an approval.
 */
export function lensRoundWith(
  verdict: LensRound["verdict"],
  rows: Finding[],
  advisory: Finding[] = [],
): LensRound {
  const lenses = LENS_NAMES.map((_, i) => lensRowResult(i));
  return {
    verdict,
    findings: renderFixtureFindings(rows),
    reported: rows,
    // `splitAdvisory`'s output as the wiring hands it up: rows the layer moved OUT
    // of `reported`. Empty by default — a round that discounted nothing — and a
    // case that means "a carried HIGH sat only here" passes them explicitly.
    advisory,
    lenses,
    usage: aggregateLensUsage(lenses),
  };
}

/**
 * The same round, stamped with the range the layer says it ranged over.
 *
 * `runLensReview` sets `deltaReview` whenever it reviewed a `since..head` delta,
 * and the step now refuses a re-review that did not range over the fix it named —
 * so a re-review stub that leaves the field out is a round that reviewed the whole
 * branch, and the step is right to refuse it. Only a stub that sets it drives the
 * fix path, exactly as the production layer does.
 *
 * The step, not the caller, chooses the range: `lensGate` passes `since` only on
 * the fix wave, so the stamp is derived from the argument the step handed the
 * layer rather than from a value a test invented — a fixture that set `since` on
 * the full round would be writing the step's answer for it.
 */
export function lensRoundFor(
  args: { wave: ReviewWave; since?: string; head: string },
  verdict: LensRound["verdict"],
  rows: Finding[],
  advisory: Finding[] = [],
): LensRound {
  const round = lensRoundWith(verdict, rows, advisory);
  // A full round is the layer's ordinary whole-branch review: no delta, no stamp.
  if (args.wave !== "fix" || args.since === undefined) return round;
  return { ...round, deltaReview: { since: args.since, head: args.head } };
}

/**
 * A re-review that reported the wave's blocking rows as CARRIED — NOT ADDRESSED,
 * arrived at the way production does.
 *
 * The review layer owns every row's fate: `rowFate` refuses to resolve an open row
 * whose cited code is unchanged, and the row that reaches `reported` carrying
 * `carried: true` IS the layer's statement that the fix did not answer it. So a
 * fixture that means "the fix did NOT answer it" re-reports the rows carried, and
 * one that means "the fix answered it" reports nothing — the layer resolved it,
 * and the step keeps no second resolve rule of its own.
 *
 * It is the fix-wave arm of `lensRoundWith` and refuses a whole-branch round: only
 * the step names a re-review's `since` (`lensGate` passes it on the fix wave alone),
 * so a fixture that stamped a full round would be asserting the very claim the step
 * checks. `intoAdvisory` moves the rows out of `reported` into the tier
 * `splitAdvisory` discounts (their cited lines outside the PR's changed lines). A
 * carried row there is still the layer saying NOT ADDRESSED and the step reads both
 * tiers for that, so `true` is the fixture for a wave that must hand back on a row
 * the discount hid from `reported`.
 */
export function carriedLensRound(
  args: { wave: ReviewWave; since?: string; head: string },
  carriedRows: readonly Finding[],
  opts: { intoAdvisory?: boolean } = {},
): LensRound {
  if (args.wave !== "fix" || args.since === undefined)
    throw new Error(
      "carriedLensRound is the re-review fixture: it stamps the range the step named, and a whole-branch round has no range to stamp",
    );
  const carried = carriedRows.map((f) => ({ ...f, carried: true }) as Finding);
  return opts.intoAdvisory === true
    ? lensRoundFor(args, "ISSUES_FOUND", [], carried)
    : lensRoundFor(args, "ISSUES_FOUND", carried);
}

/** The wiring's `renderFindings`, kept here so a fixture's string and the
 * production one cannot disagree about what one row looks like. */
function renderFixtureFindings(rows: Finding[]): string {
  return rows
    .map(
      (f) =>
        `- [${f.severity}] ${f.lens} ${f.path}${f.line === undefined ? "" : `:${String(f.line)}`}: ${f.title}`,
    )
    .join("\n");
}

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
  return lensRoundWith("APPROVED", []);
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
    // The harness's stand-in for the doctrine judge: a step that resolves the
    // project's bar gets the shipped default rather than a child process. A case
    // that cares about the bar overrides this and asserts what the lens call
    // received — the default here must never be the thing a case proves.
    reviewThreshold: async () => DEFAULT_REVIEW_THRESHOLD,
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

/**
 * Did the review step PASS, on either of its two kinds?
 *
 * `done` is a clean pass and `fixed` is a pass whose loop integrated a fix round,
 * so every case that asks "did the step clear its gates" must accept both — a
 * fixture that compares against `"done"` alone silently stops covering the arm
 * that fixed anything, which is the arm the table re-verifies. The set is read
 * from the module that writes it, so a third kind cannot make these assertions
 * quietly pass on nothing.
 */
export function passed(kind: string | undefined): boolean {
  // The needle widens, not the list — see `PASS_KINDS` in `review-log.ts`: the
  // element type stays the registry's, so this helper cannot drift from the kinds
  // the table actually routes on.
  return kind !== undefined && PASS_KINDS.includes(kind as (typeof PASS_KINDS)[number]);
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
 * The default `dispatch` commits nothing, which is the right stub for the
 * no-change case and the wrong one for every case that needs the step to reach
 * its re-review: a fixer that commits nothing is refused by `assertFixAdvanced`
 * (correct product behaviour) and the case then measures that refusal instead of
 * what it names. `tag` makes the commit unique per case, so two cases driving one
 * repo cannot produce byte-identical trees.
 *
 * Counted per tree, not per factory instance, and that is load-bearing rather
 * than tidy: the fix tree's name is derived from arm-wave-attempt-epoch and the
 * suite's clock is frozen at 1, so two cases in one repo ask for the SAME path,
 * and `git worktree add --force` ADOPTS the registration the earlier case left,
 * its commit still in it. A per-instance counter would then write a file that was
 * already there, `put` would skip the identical write, the child would commit
 * nothing, and the step would integrate a head no child produced.
 */
export function fixerThatCommits(tag: string) {
  const written = new Map<string, number>();
  let n = 0;
  return async (spec: DispatchSpec): Promise<DispatchResult> => {
    const wt = spec.cwd as string;
    const seen = written.get(wt) ?? 0;
    written.set(wt, seen + 1);
    const name = `fix-${tag}-${String(seen)}.ts`;
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

export {
  alwaysBlockingOnGate,
  blockingReject,
  issuesFoundThenClears,
  parsedRound,
  rejectsThenClears,
} from "./lean-gate-stubs.ts";
export { ReviewInfraError } from "../../src/lean/review.ts";
export {
  CAUSE_NEW_CRITICAL,
  CAUSE_NO_CHANGE,
  CAUSE_NOT_ADDRESSED,
  PASS_ROWS,
  REVIEW_CHILD_BUDGET,
  REVIEW_PASSES,
} from "../../src/lean/review.ts";
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
