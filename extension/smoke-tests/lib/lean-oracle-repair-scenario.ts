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
 * Nothing here stubs a judgement. The repo, the frozen test commit and the worktree are real git; the frozen
 * file is a real script the project's own `sh {file}` runner really exits non-zero on, so the red the
 * anti-forgery gate honours is a real exit code rather than a fixture's answer. The repair seat's replacement
 * is judged by the real judge running the real runner in a real throwaway checkout of the run's base commit.
 * Only the model is fake: each child writes bytes into its tree and declares its tool call. Comments are
 * recorded, never posted.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { runRepairRound, type RepairOutcome } from "../../src/oracle-repair-dispatch.ts";
import { specifyOutcome } from "../../src/lean/specify.ts";
import type { SpecifyDeps } from "../../src/lean/specify.ts";
import type { Outcome } from "../../src/lean/state.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";
import { BODY, fakeGhDir, originRepo, withStubForge } from "./lean-seed-fixtures.ts";
import { FIXED_NOW, goldenGitEnv } from "./lean-specify-off-golden.ts";

/** The committed path of the two arm records, relative to `smoke-tests/`. */
export const REPAIR_FIXTURE = "fixtures/lean-state/oracle-repair-off.json";

/** The issue the golden run carries. */
export const REPAIR_ISSUE = 2700;

/** The frozen acceptance test the run freezes: red while `src/retry.ts` still says `not-implemented`. */
export const FROZEN_REL = "tests/AC1-retry.test.sh";
/** Its bytes: they name their own path on failure, so the runner's verdict is a real `red`. */
export const FROZEN_BYTES =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1-retry.test.sh" 1>&2; exit 1; fi\nexit 0\n';
/** The implementation the frozen test is red against, present at the run's base. */
export const SRC_REL = "src/retry.ts";
export const SRC_BYTES = "export const retry = () => { throw new Error('not-implemented'); };\n";
/** An implementation the repaired oracle passes: the builder never writes it in the golden's build arm. */
export const IMPLEMENTED = "export const retry = () => 1;\n";
/** A replacement that merely deletes the failing assertion: green at base, so the judge refuses it. */
export const WEAKENED = '#!/bin/sh\necho "ok - tests/AC1-retry.test.sh"\nexit 0\n';
/** A replacement with one case that fails at the base: the judge accepts it. */
export const RED_AT_BASE =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - AC1 returns the value" 1>&2; exit 1; fi\nexit 0\n';
/** The name a judge stub refuses on, and the reason it refuses — for the cases that never run a base. */
export const JUDGE_REFUSAL_SENTENCE = "every case of the replacement passes at the base";
/** The name a second, out-of-quota file would carry — the unnamed-file refusal's subject. */
export const EXTRA_REL = "tests/AC2-extra.test.sh";
export const EXTRA_RED =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - AC2 keeps the budget" 1>&2; exit 1; fi\nexit 0\n';

/** The project's per-file runner template. */
const RUNNER = "sh {file}";
/** The builder's own words about the file it claims cannot pass. */
export const CLAIM_REASON = "the frozen assertion contradicts the problem statement";
/** A line no source but the builder's own report could put into a brief — the blindness canary. */
export const LEAK_SENTENCE = "the builder wrote BUILDER-PRIVATE-DIFF-TEXT and its session said so";

/** What one child of the run does: the bytes it writes and the tool calls it makes. */
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

/** What the base judge decided, when a case replaces it rather than running a real base. */
export type RepairJudgeStub = (round: number) => RepairOutcome;

/** What the repair seat was shown and what it declared, read off the dispatches it received. */
export interface RepairObservation {
  prompts: string[];
  cwd: string[];
  roles: string[];
  extraArgs: string[][];
  /** Whether each repair child ran in the specify worktree reset to the run's base sha. */
  atBaseSha: boolean[];
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

/** A `report_blocked` call, in the shape Pi records a tool call. */
const blockedCall = (paths: string[]): unknown[] => [
  {
    name: "report_blocked",
    arguments: { conflicts: paths.map((p) => ({ path: p, reason: CLAIM_REASON })) },
  },
];

/** A `submit_tests` call for one criterion. */
const submitCall = (criterionId: string, testFiles: string[]): unknown[] => [
  { name: "submit_tests", arguments: { criterionId, testFiles } },
];

/** Write one file into a tree, executable, with its parent directories. */
function put(wt: string, rel: string, text: string): void {
  const target = path.join(wt, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, { mode: 0o755 });
}

/** git in `dir` for the harness's own reads. */
function harnessGit(dir: string, ...argv: string[]): string {
  const r = spawnSync("git", argv, { cwd: dir, encoding: "utf8", env: goldenGitEnv() });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** The ref the harness fetches the run's base commit to, in each throwaway checkout. */
const BASE_REF = "refs/heads/repair-base";

/** What the build seat's child does by default: implement nothing, report the frozen file. */
const DEFAULT_BUILD_CHILD: ChildPlan = { blocked: [FROZEN_REL] };

/** Drive one run with the switch at `switchValue` (`undefined` = unset, so the shipped default). */
export async function driveRepairRun(
  issue: number,
  opts: {
    switchValue?: string | undefined;
    buildChild?: ChildPlan;
    repairChild?: ChildPlan;
    /** Whether the run's own gate says green (the default) or red on the repaired oracle. */
    verifyGreen?: boolean;
    /** Replace the mechanical base judgement (a case that scores a refusal's wording, or a hung judge). */
    judge?: RepairJudgeStub;
    /** Hand the round a dispatch that throws, to watch the refusal it makes. */
    dispatchThrows?: boolean;
  } = {},
): Promise<RepairRecord> {
  const repo = originRepo({ workJson: { version: 1, verify: { fast: "true", test: RUNNER } } });
  const comments: string[] = [];
  const restore = setLeanCommentPoster(async (_issue, body) => {
    comments.push(body);
  });
  const repair: RepairObservation = { prompts: [], cwd: [], roles: [], extraArgs: [], atBaseSha: [] };
  const trees: string[] = [];
  let record: RepairRecord | undefined;
  try {
    // The run's base commit must itself carry the frozen test and the failing source: that is what lets the
    // repair seat prove a replacement red at `baseSha` with the project's runner, in a real checkout.
    put(repo.repoRoot, SRC_REL, SRC_BYTES);
    put(repo.repoRoot, FROZEN_REL, FROZEN_BYTES);
    harnessGit(repo.repoRoot, "add", "-A");
    harnessGit(repo.repoRoot, "commit", "-q", "-m", "acceptance contract");

    const seed = await leanSeed(repo.repoRoot);
    if (seed.baseSha === "") throw new Error(`seed failed: ${seed.why ?? "no reason"}`);

    const run = (cmd: string, o?: Parameters<typeof execp>[1]) =>
      execp(cmd, { ...(o ?? {}), env: { ...goldenGitEnv(), ...(o?.env ?? {}) } });

    const dispatch = async (spec: DispatchSpec): Promise<DispatchResult> => {
      const isRepair = (spec.prompt ?? "").includes(REPAIR_MARKER);
      const plan = isRepair ? (opts.repairChild ?? {}) : (opts.buildChild ?? DEFAULT_BUILD_CHILD);
      const tree = spec.cwd as string;
      for (const [rel, text] of Object.entries(plan.files ?? {})) put(tree, rel, text);
      const toolUses: unknown[] = [];
      for (const s of plan.submit ?? []) toolUses.push(...submitCall(s.criterionId, s.testFiles));
      if (plan.blocked !== undefined) toolUses.push(...blockedCall(plan.blocked));
      if (isRepair) {
        repair.prompts.push(spec.prompt ?? "");
        repair.cwd.push(tree);
        repair.roles.push(spec.role);
        repair.atBaseSha.push(harnessGit(tree, "rev-parse", "HEAD") === seed.baseSha);
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

    const config = { ...defaultConfig(), verify: { fast: "true", test: RUNNER } };
    const specifyDeps: SpecifyDeps = {
      exec: run,
      dispatch,
      fetchIssueBody: async () => BODY,
      loadConfig: async () => config,
      statReporter: async () => ({}),
    };
    // Two throwaway real checkouts of the run's base, armed the way the driver arms its own: the judge
    // reads the original from one, the round writes and hashes the accepted bytes in the other. Removed with
    // the run, since a registration a killed run left behind makes the next add at that path refuse.
    const baseTree = mkdtempSync(path.join(tmpdir(), "lean-repair-judge-"));
    const stageTree = mkdtempSync(path.join(tmpdir(), "lean-repair-stage-"));
    for (const tree of [baseTree, stageTree]) {
      harnessGit(tree, "init", "-q", "-b", "main");
      harnessGit(tree, "-c", `user.email=seed@localhost`, "-c", `user.name=seed`, "fetch", "-q", repo.repoRoot, `refs/heads/main:${BASE_REF}`);
      harnessGit(tree, "checkout", "-q", "--detach", BASE_REF);
    }
    trees.push(baseTree, stageTree);

    const repairRound =
      opts.judge === undefined
        ? // The REAL judge, with a real throwaway checkout of the base and the real runner: the fixture
          // supplies only the tree's bytes and the child's declared calls, which is what a model is.
          runRepairRound
        : async (o: Parameters<typeof runRepairRound>[0]): Promise<RepairOutcome> => opts.judge!(o.round);

    const buildDeps = {
      exec: run,
      dispatch,
      fetchIssueBody: async () => BODY,
      loadConfig: async () => config,
      statReporter: async () => ({}),
      repairRound,
      repairTrees: { baseTree, stageTree },
      ...(opts.dispatchThrows === true
        ? {
            repairDispatch: async () => {
              throw new Error("REPAIR-DISPATCH-THREW");
            },
          }
        : {}),
    } as unknown as BuildDeps;

    const handlers: LeanHandlers = {
      ...handlersFor(repo.repoRoot, issue, {}, seed),
      specify: (ctx) => specifyOutcome(ctx, specifyDeps),
      build: (ctx) => buildOutcome(ctx, buildDeps, false),
      verify: async () =>
        opts.verifyGreen === false
          ? { kind: "red", reason: "the repaired oracle failed its own assertion" }
          : {
              kind: "green",
              reason: "frozen tests and project tiers passed",
              verifiedHead: seed.baseSha,
            },
      publish: async () => ({ kind: "ok", prUrl: "https://example.invalid/pr/1" }),
      review: async () => ({ kind: "done" }),
      ci: async () => ({ kind: "green" }),
      land: async () => ({ kind: "merged" }),
    };

    await withEnv(
      {
        PI_ENSEMBLE_LEAN_ORACLE_REPAIR: opts.switchValue,
        PI_ENSEMBLE_LEAN_PROJECT_ROSTER: "0",
      },
      async () => {
        const result = await withStubForge(fakeGhDir(BODY), () =>
          runLean({
            repoRoot: repo.repoRoot,
            issue,
            handlers,
            seed: { version: seed.version, baseSha: seed.baseSha },
            now: () => FIXED_NOW,
          }),
        );
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
          ...(repair.prompts.length === 0 ? {} : { repair }),
        };
      },
    );
  } finally {
    restore();
    for (const tree of trees) {
      spawnSync("git", [...NO_HOOKS, "worktree", "prune"], {
        cwd: repo.repoRoot,
        encoding: "utf8",
        env: goldenGitEnv(),
      });
      rmSync(tree, { recursive: true, force: true });
    }
    rmSync(path.join(repo.repoRoot, ".worktrees"), { recursive: true, force: true });
    repo.dispose();
  }
  if (record === undefined) throw new Error("the run left no record");
  return record;
}

/** The heading a repair brief must carry and no other brief contains; the harness's own routing test. */
export const REPAIR_MARKER = "Repair the named frozen tests";
