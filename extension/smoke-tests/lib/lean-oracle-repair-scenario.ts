/**
 * lib/lean-oracle-repair-scenario — ONE lean run whose `build` child claims a frozen acceptance test cannot
 * pass, whose claim the DRIVER proves for itself by re-running that file, driven through the real `runLean`
 * and the real phase-1 handlers.
 *
 * `test-lean-build-blocked-repair.ts` compares each arm of `PI_ENSEMBLE_LEAN_ORACLE_REPAIR` against
 * `fixtures/lean-state/oracle-repair-off.json`. The `off` record was captured from the tree BEFORE the repair
 * round existed, by this same function, so it pins the release the off arm restores; the `on` record pins the
 * repair round that replaced it. The two arms are also asserted DIFFERENT, because a switch whose arms agree
 * has no second arm.
 *
 * Nothing here stubs a judgement. The repo, the frozen test commit and the worktrees are real git; the frozen
 * file is a real script the project's own `sh {file}` runner really exits non-zero on. Only the model is
 * fake: each child writes bytes into its tree and declares its tool calls. Comments are recorded, never posted.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { leanIssueResult } from "../../src/headless/work-lean-result.ts";
import type { ResultFailure } from "../../src/headless/failure.ts";
import { buildOutcome } from "../../src/lean/build.ts";
import type { BuildDeps } from "../../src/lean/build.ts";
import { handlersFor, leanSeed } from "../../src/lean/command.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import { setLeanCommentPoster } from "../../src/lean/io.ts";
import { NO_HOOKS } from "../../src/lean/submodule-reads.ts";
import { BLOCKED_REPORTER_PATH } from "../../src/lean/build-blocked-reporter.ts";
import { ensureSpecifyWorktreeWithProvision } from "../../src/lean/specify-tree.ts";
import type { RepairRoundDeps } from "../../src/oracle-repair-dispatch.ts";
import { REPAIR_HEADING } from "../../src/oracle-repair-brief.ts";
import { specifyOutcome } from "../../src/lean/specify.ts";
import type { SpecifyDeps } from "../../src/lean/specify.ts";
import type { Outcome } from "../../src/lean/state.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import { repairOutcome } from "../../src/lean/repair.ts";
import { withRepairBaseTree } from "../../src/oracle-repair-wiring.ts";
import type { BudgetOpts } from "../../src/lean/step-budget.ts";
import { withEnv } from "./env-scope.ts";
import { BODY, SPEC, fakeGhDir, originRepo, withStubForge } from "./lean-seed-fixtures.ts";
import { FIXED_NOW, goldenGitEnv } from "./lean-specify-off-golden.ts";

/** The path of the arm records, relative to `smoke-tests/`. */
export const REPAIR_FIXTURE = "fixtures/lean-state/oracle-repair-off.json";

/** The issue the golden run carries. */
export const REPAIR_ISSUE = 2700;

/** The frozen acceptance test the run freezes: red while `src/retry.ts` still says `not-implemented`. */
export const FROZEN_REL = "tests/AC1-retry.test.sh";
/** Its bytes name their own path on failure, which is what makes the runner's verdict a real `red`. */
export const FROZEN_BYTES =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1-retry.test.sh" 1>&2; exit 1; fi\nexit 0\n';
/** The implementation the frozen test is red against, present at the run's base. */
export const SRC_REL = "src/retry.ts";
export const SRC_BYTES = "export const retry = () => { throw new Error('not-implemented'); };\n";
/** A replacement with a case that is red at the base and green at the head: what the judge accepts. */
export const RED_AT_BASE =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1-retry.test.sh: AC1 returns the value" 1>&2; exit 1; fi\nexit 0\n';
/** The implementation the repaired oracle passes: what the builder writes in the repairing arm. */
export const IMPLEMENTED = "export const retry = () => 1;\n";
/** A replacement that only deletes the failing assertion: green at base, so the judge refuses it. */
export const WEAKENED = '#!/bin/sh\necho "ok - tests/AC1-retry.test.sh"\nexit 0\n';
/** A second file's replacement, for the out-of-quota refusal. */
export const EXTRA_REL = "tests/AC2-extra.test.sh";

/** The project's per-file runner. */
const RUNNER = "sh {file}";
/** Where the project keeps its tests, so the boundary accepts what the specify child writes. */
const TEST_DIR = "tests";
const TEST_GLOB = "*.test.sh";
/** The builder's own words about the file it claims cannot pass. */
export const CLAIM_REASON = "the frozen assertion contradicts the problem statement";
/** A line no source but the builder's own report could put into a brief — the blindness canary. */
export const LEAK_SENTENCE = "BUILDER-PRIVATE-DIFF-TEXT from the build session";

/** What one child of the run does: the bytes it writes and the calls it makes. */
export interface ChildPlan {
  /** Bytes to leave at each path of the child's tree. */
  files?: Record<string, string>;
  /** The `submit_tests` calls to declare, in order. */
  submit?: Array<{ criterionId: string; testFiles: string[] }>;
  /** The frozen paths to report as unsatisfiable, with the child's reason. */
  blocked?: string[];
  /** Text to append to the child's own reply, so a claim's prose can be made to leak. */
  text?: string;
}

/** What the repair seat was shown and what it declared, read off the dispatches it received. */
export interface RepairObservation {
  prompts: string[];
  cwd: string[];
  roles: string[];
  /** Each repair child's deadline / turn arms, as the seam received them. */
  arms: BudgetOpts[];
  /** The paths each repair child wrote into its (reset) tree. */
  treeFiles: string[][];
  /** What each seat's own plan claimed, kept so a blindness assertion can name what was NOT sent. */
  specSeen: string[][];
  /** Whether the round took a throwaway checkout of the run's base — the tree the judge ran in. */
  judgedInBaseCheckout: boolean;
  /** Whether each seat's tree sat on the build head its brief described the red at. */
  atBuildHead: boolean[];
}

/** What one arm leaves behind: the verdict, each step, every comment, and what the repair seat saw. */
export interface RepairRecord {
  state: string;
  code: number;
  reason: string;
  steps: { state: string; key: string; outcome?: unknown }[];
  comments: string[];
  failure?: ResultFailure;
  repair?: RepairObservation;
}

/** Every full sha masked, so a fixture repo built afresh still matches its golden. */
function mask(s: string): string {
  return s.replace(/\b[0-9a-f]{40}\b/g, "<sha>");
}

const blockedCall = (paths: string[]): unknown[] => [
  {
    name: "report_blocked",
    arguments: { conflicts: paths.map((p) => ({ path: p, reason: CLAIM_REASON })) },
  },
];

const submitCall = (criterionId: string, testFiles: string[]): unknown[] => [
  { name: "submit_tests", arguments: { criterionId, testFiles } },
];

/**
 * Write one file into a tree, executable, with its parent directories.
 *
 * The mode is set in a second call rather than by `writeFileSync`'s `mode` option: that option applies only
 * when the file is CREATED, and the harness writes the same path twice across a run's retries, so a mode
 * carried in the option would silently describe the first write while the runner executed the second. The
 * project's own runner is `sh {file}` and reads the bytes, but a fixture whose stated mode disagreed with
 * its real one would be a fixture nobody could trust.
 */
function put(wt: string, rel: string, text: string): void {
  const target = path.join(wt, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
  chmodSync(target, 0o755);
}

/**
 * git for the harness's own fixture work. `goldenGitEnv()` isolates config and hooks and, doing so, leaves no
 * author identity, so the fixture supplies one the same way `lib/lean-seed-fixtures.ts` does for its own
 * commits: as data, never read from the developer's account.
 */
function harnessGit(dir: string, ...argv: string[]): string {
  const r = spawnSync("git", argv, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...goldenGitEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/**
 * What the build seat's child does by default: report the frozen file, and leave the tree holding nothing
 * the file can pass against.
 *
 * The second half is not decoration. `blockedProved` — the anti-forgery gate — runs the named file on the
 * builder's tree and honours the claim only on a red, so a child that quietly shipped the implementation
 * would have its own report refused, and the run would never reach the repair round at all. A blocked round
 * is a child that gave up, and a fixture has to make it give up properly.
 */
const UNIMPLEMENTED: Record<string, string> = { [SRC_REL]: SRC_BYTES };
const DEFAULT_BUILD_CHILD: ChildPlan = { blocked: [FROZEN_REL], files: UNIMPLEMENTED };
/** What the specify seat does by default: write the frozen test and declare it. */
const SPECIFY_CHILD: ChildPlan = {
  files: { [FROZEN_REL]: FROZEN_BYTES },
  submit: [{ criterionId: "AC1", testFiles: [FROZEN_REL] }],
};

/** Drive one run with the switch at `switchValue` (`undefined` = unset, so the shipped default). */
export async function driveRepairRun(
  issue: number,
  opts: {
    switchValue?: string | undefined;
    specifyChild?: ChildPlan;
    buildChild?: ChildPlan | ChildPlan[];
    repairChild?: ChildPlan;
    /** Whether the run's own gate says green (the default) or red on the repaired oracle. */
    verifyGreen?: boolean;
    /** Hand the round a dispatch that throws, to watch the refusal it makes. */
    dispatchThrows?: boolean;
  } = {},
): Promise<RepairRecord> {
  const repo = originRepo({
    // The failing source is part of the repo's FIRST commit, because `originRepo` commits before this
    // function can add anything and the run's base is that commit: `specify` proves each candidate red
    // against the base, so the source the frozen test fails against has to be there when the base is pinned.
    workJson: {
      version: 1,
      verify: { fast: "true", test: RUNNER, testDir: TEST_DIR, testGlob: TEST_GLOB },
    },
    files: { [SRC_REL]: SRC_BYTES },
  });
  const comments: string[] = [];
  const restore = setLeanCommentPoster(async (_issue, body) => {
    comments.push(body);
  });
  const repair: RepairObservation = {
    prompts: [],
    cwd: [],
    roles: [],
    arms: [],
    atBuildHead: [],
    treeFiles: [],
    specSeen: [],
    judgedInBaseCheckout: false,
  };
  let record: RepairRecord | undefined;
  // Which build round this dispatch is, counted as they are dispatched — the index `buildChild` reads when
  // a case gives the rounds a list, because a repaired oracle only shows its effect on the NEXT round.
  let buildRounds = 0;
  /** The head the last blocked report was judged at, filled in from the run's step log. */
  let buildHead = "";
  // The round ran only when a `repair` step decided — which is a fact about the run's log, not about a
  // dispatch the harness happened to see: a round whose child died before its brief was built leaves no
  // dispatch behind, and a test that keyed on the dispatch would then assert nothing.
  let roundRan = false;
  try {
    // The run's base holds the failing source and NO test under `tests/`: `specify` proves every candidate
    // red against the base and refuses one the base already tracks, so the frozen file can only exist as
    // bytes the specify child wrote (see the child plans).

    const seed = await leanSeed(repo.repoRoot);
    if (seed.baseSha === "") throw new Error(`seed failed: ${seed.why ?? "no reason"}`);
    // No frozen test is tracked at the base and none is committed by the harness: `specify` proves every
    // candidate red against the base and refuses one the child did not write, so the child's own writes are
    // the only way the file can exist when the step runs it (see the child plans).

    const run = (cmd: string, o?: Parameters<typeof execp>[1]) =>
      execp(cmd, { ...(o ?? {}), env: { ...goldenGitEnv(), ...(o?.env ?? {}) } });

    const dispatch = async (
      spec: DispatchSpec,
      opts2: { extraArgs?: readonly string[] } = {},
    ): Promise<DispatchResult> => {
      // The re-ask opens the same session with `prompt: undefined`, and a session that already
      // submitted has nothing to re-declare — so a seat whose first call submitted keeps submitting.
      const isRepair = spec.prompt !== undefined && spec.prompt.includes(REPAIR_MARKER);
      // Seats are told apart by the reporter extension each is dispatched with — the one fact that cannot
      // collide, unlike a phrase from the spec that every brief quotes. The blocked-reporter extension is the
      // BUILDER's and only the builder's: the specify child carries the submit reporter, and the repair seat
      // carries the submit reporter too (it submits replacement tests), so a brief phrase would be the only
      // thing separating builder from repair seat. The repair seat is the one whose brief names the round.
      const args = (opts2.extraArgs ?? []).join(" ");
      // The builder is dispatched once per round, so a case that wants round two to differ from round one
      // hands the rounds as a list; the last entry is what every later round does.
      const plan = isRepair
        ? (opts.repairChild ?? {})
        : args.includes(path.basename(BLOCKED_REPORTER_PATH))
          ? (Array.isArray(opts.buildChild)
              ? (opts.buildChild[Math.min(buildRounds, opts.buildChild.length - 1)] ??
                DEFAULT_BUILD_CHILD)
              : (opts.buildChild ?? DEFAULT_BUILD_CHILD))
          : (opts.specifyChild ?? SPECIFY_CHILD);
      if (args.includes(path.basename(BLOCKED_REPORTER_PATH))) buildRounds += 1;
      const tree = spec.cwd as string;
      for (const [rel, text] of Object.entries(plan.files ?? {})) put(tree, rel, text);
      const toolUses: unknown[] = [];
      for (const s of plan.submit ?? []) toolUses.push(...submitCall(s.criterionId, s.testFiles));
      if (plan.blocked !== undefined) toolUses.push(...blockedCall(plan.blocked));
      if (isRepair) {
        if (opts.dispatchThrows === true) throw new Error("REPAIR-DISPATCH-THREW");
        repair.prompts.push(spec.prompt ?? "");
        repair.cwd.push(tree);
        repair.roles.push(spec.role);
        repair.treeFiles.push(Object.keys(plan.files ?? {}));
        // The bytes each seat was shown: the blindness assertions read these, not a paraphrase of them.
        repair.specSeen.push(plan.files === undefined ? [] : Object.keys(plan.files));
        repair.arms.push({
          ...(spec.childBoundMs === undefined ? {} : { childBoundMs: spec.childBoundMs }),
          ...(spec.childBoundGraceMs === undefined
            ? {}
            : { childBoundGraceMs: spec.childBoundGraceMs }),
          ...(spec.budgetTurns === undefined ? {} : { budgetTurns: spec.budgetTurns }),
          ...(spec.stall === undefined ? {} : { stall: spec.stall }),
        });
        // The seat's tree sits on the commit the blocked report was judged at: the frozen file is there as
        // the record hashes it, and none of the builder's implementation, because a builder whose report the
        // driver honoured changed no frozen file and shipped nothing that made it pass.
        // The seat's tree sits on the commit the blocked report was judged at — read off the run's own log,
        // not computed here, so the assertion compares the seat's tree against the head the driver recorded.
        repair.atBuildHead.push(harnessGit(tree, "rev-parse", "HEAD") === buildHead);
      }
      return {
        role: spec.role,
        ok: true,
        text: plan.text ?? "done",
        toolUses,
        ms: 1,
        exitCode: 0,
        usage: { input: 5, output: 6, cacheRead: 1, cacheWrite: 2, cost: 0.125, turns: 3 },
      };
    };

    // Whether the round asked for a throwaway checkout of the base. Set inside the dep below, so a round
    // that never reached the judge could not report having judged anything.
    let baseTreeUsed = false;
    const config = {
      ...defaultConfig(),
      verify: { fast: "true", test: RUNNER, testDir: TEST_DIR, testGlob: TEST_GLOB },
    };
    const specifyDeps: SpecifyDeps = {
      exec: run,
      dispatch,
      fetchIssueBody: async () => BODY,
      loadConfig: async () => config,
      statReporter: async () => ({}),
    };
    const buildDeps = {
      exec: run,
      // The build seat's options ride a SECOND argument (the write fence and its reporter extension), so a
      // harness that forwarded only the spec would show every seat the same plan and quietly test a run in
      // which the builder never ran at all.
      dispatch: (spec: DispatchSpec, o: { extraArgs?: readonly string[] }) => dispatch(spec, o),
      fetchIssueBody: async () => BODY,
      loadConfig: async () => config,
      statReporter: async () => ({}),
    } as unknown as BuildDeps;

    const repairDeps = {
      exec: run,
      // The seat's tree, its arms, and what it was shown — all of it read off the real round rather than
      // asserted near it: the assertions below ask whether the dispatch the seam received was blind, and a
      // stubbed round would answer that question about a round that never ran.
      dispatch: (spec, o) => dispatch(spec as DispatchSpec, o),
      ensureTree: (o) => ensureSpecifyWorktreeWithProvision(run, o),
      withBaseTree: <T,>(fn: (tree: string) => Promise<T>): Promise<T> => {
        baseTreeUsed = true;
        return withRepairBaseTree(run, repo.repoRoot, issue, seed.baseSha, fn);
      },
      loadConfig: async () => config,
      fetchIssueBody: async () => BODY,
    };

    const handlers: LeanHandlers = {
      ...handlersFor(repo.repoRoot, issue, {}, seed),
      specify: (ctx) => specifyOutcome(ctx, specifyDeps),
      build: async (ctx) => {
        const oc = await buildOutcome(ctx, buildDeps, false);
        // The head the driver ran the named frozen tests at, taken from the step's own record: the repair
        // brief describes a red at this commit and the seat's tree must sit on it, so the assertion has to
        // compare against what the driver wrote down rather than a head this file guessed.
        if (oc.kind === "blocked" && typeof oc.headBefore === "string") buildHead = oc.headBefore;
        return oc;
      },
      repair: (ctx) => repairOutcome(ctx, repairDeps, false),
      // The round after `build` that asks the adversary for MORE tests. This scenario is about the repair
      // round, so it stands still here: `none` is what a challenge that added nothing returns, and the run
      // moves on to `verify` — which this harness answers directly, as it does every later step.
      challenge: () => ({ kind: "none", reason: "no new tests offered", dispatches: [] }),
      verify: async () =>
        opts.verifyGreen === false
          ? { kind: "red", reason: "the repaired oracle failed its own assertion" }
          : { kind: "green", reason: "frozen tests and project tiers passed", verifiedHead: seed.baseSha },
      publish: async () => ({ kind: "ok", prUrl: "https://example.invalid/pr/1" }),
      review: async () => ({ kind: "done" }),
      ci: async () => ({ kind: "green" }),
      land: async () => ({ kind: "merged" }),
    };

    await withEnv(
      { PI_ENSEMBLE_LEAN_ORACLE_REPAIR: opts.switchValue, PI_ENSEMBLE_LEAN_PROJECT_ROSTER: "0" },
      async () => {
        const result = await withStubForge(fakeGhDir(BODY), () =>
          runLean({
            repoRoot: repo.repoRoot,
            issue,
            handlers,
            seed: {
              version: seed.version,
              baseSha: seed.baseSha,
              ...(opts.switchValue === "0" ? {} : { oracleRepair: opts.switchValue === undefined || opts.switchValue === "1" }),
            },
            now: () => FIXED_NOW,
          }),
        );
        roundRan = result.run.steps.some((s) => s.state === "repair" && s.outcome !== undefined);
        const outcome = (o: Outcome | undefined): unknown =>
          o === undefined ? undefined : (JSON.parse(mask(JSON.stringify(o))) as unknown);
        record = {
          state: result.run.state,
          code: result.code,
          reason: mask(result.run.result?.reason ?? ""),
          steps: result.run.steps.map((s) => ({
            state: s.state,
            key: s.key,
            outcome: outcome(s.outcome),
          })),
          comments: comments.map(mask),
          failure: leanIssueResult(result.run, result.code).failure,
          ...(roundRan
            ? {
                repair: {
                  ...repair,
                  judgedInBaseCheckout: baseTreeUsed,
                },
              }
            : {}),
        };
      },
    );
  } finally {
    restore();
    spawnSync("git", [...NO_HOOKS, "worktree", "prune"], {
      cwd: repo.repoRoot,
      encoding: "utf8",
      env: goldenGitEnv(),
    });
    rmSync(path.join(repo.repoRoot, ".worktrees"), { recursive: true, force: true });
    repo.dispose();
  }
  if (record === undefined) throw new Error("the run left no record");
  return record;
}

/** The heading a repair brief carries and no other brief contains; also the harness's routing test. Derived
 *  from the brief's own heading so the harness cannot route on a string the product no longer renders. */
export const REPAIR_MARKER = REPAIR_HEADING.replace(/^#+ +/, "");
