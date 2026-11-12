/**
 * lib/lean-specify-off-golden — the OFF-arm golden of #2212, in one place.
 *
 * `test-lean-specify-off-golden.ts` compares a switch-off `specify` run against a
 * record captured ONCE from the v0.14.71 tree (R3). Both sides must build the run
 * the same way, so the recipe lives here and the capture script (run once, against
 * an extracted v0.14.71 tree under this worktree's `tmp/`) calls this same
 * function: a golden whose harness drifted from its capture would pin nothing.
 *
 * The repo shape is R4's, not the preflight-bug recipe. The runner the base
 * commits is honest about ONE file: it runs a committed green test with `sh` and
 * exits 0 on it, and exits 4 on anything else — so the child's own file gets a
 * real non-naming exit 4 (its output is the runner's line for the OTHER file, and
 * names neither this test's path nor its basename). `specify-run.ts` drops an
 * `unclear` proof with a reason, and a run whose only declared file was dropped is
 * a decline.
 *
 * The broken-runner recipe cannot produce v0.14.71's outcome: `assertRan` throws
 * for a proof that observed NOTHING, so a runner failing on every file ends
 * `handed-back` on the red proof's own infra clause with the switch on either way.
 *
 * What the record holds is R2's definition of byte-identity: the run's terminal
 * state, the exit code, the terminal reason, and each recorded step's `state`,
 * `key` and `outcome` (kind, reason, failedRules). Every `startedAt`/`endedAt` is
 * masked and the run is driven under a fixed injected clock. The posted comment
 * body is excluded: the forge is off and `decline` is replaced by a spy that
 * records the rules it was handed, so no network is contacted on either arm and
 * the record carries no path or timestamp that could differ between them.
 *
 * One more field is masked, for the same reason R2 masks the clock: the step
 * quotes the base sha in the drop note, and git abbreviates a sha by the
 * repository's loose-object layout, which a fixture repo built afresh does not
 * reproduce. A golden that pinned it would be a golden of the fixture's objects.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { handlersFor, leanSeed } from "../../src/lean/command.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import type { LeanRun, Outcome } from "../../src/lean/state.ts";
import type { SpecifyDeps } from "../../src/lean/specify.ts";
import { specifyOutcome } from "../../src/lean/specify.ts";
import type { DispatchResult } from "../../src/types.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { BODY, fakeGhDir, originRepo, withStubForge } from "./lean-seed-fixtures.ts";

/** The path the child declares its test at. */
export const TEST_REL = "tests/AC1-child.test.sh";
/**
 * The child's declared test.
 *
 * Its content is never run — the committed runner exits 4 on any path but the
 * green fixture's — so this is the file the red proof sees as a non-naming exit 4:
 * the runner's stderr names the runner and the other file, never this one, so
 * nothing proved this test red and the proof DROPS it with a reason.
 */
export const UNCLEAR_TEST =
  '#!/bin/sh\necho "cannot run tests/other-missing.test.sh: no module named acme" 1>&2\nexit 4\n';
/** The runner template the project's `.pi/work.json` names. */
export const RUNNER_TEMPLATE = "sh runner.sh {file}";
/** A committed test the runner DOES run, and which passes: exit 0 on the base. */
export const GREEN_TEST = '#!/bin/sh\necho "ok - $(basename "$0")"\nexit 0\n';
/** Its path, which is the only path the committed runner executes. */
export const GREEN_TEST_REL = "tests/AC0-green.test.sh";
/** The probe basename `specify-preflight.ts` writes, which the off arm must never leave. */
export const PROBE_BASENAME = ".lean-runner-probe.test";
/**
 * The runner the base commits. `sh runner.sh {file}` is the template the config
 * names; this script is what that template runs.
 *
 * It is honest about one file and silent about every other, which is what makes
 * the off arm a DECLINE rather than an infrastructure hand-back. Silence is load-
 * bearing twice over: the proof reads the rendered command line as part of the
 * output, so a runner that echoed `$1` would "name" any file it was given and the
 * non-naming exit 4 would never be reached; and a runner that said NOTHING about a
 * file is the observation-of-nothing `assertRan` throws on. So this script exits 0
 * on the green fixture's path and exits 4 with a line that names no path at all.
 */
export const RUNNER_SH = [
  "#!/bin/sh",
  `if [ "$1" = "${GREEN_TEST_REL}" ]; then sh "${GREEN_TEST_REL}"; exit $?; fi`,
  'echo "runner: the test could not be executed" 1>&2',
  "exit 4",
  "",
].join("\n");
/** The issue body: one `verify: "test"` criterion, so the coverage rule has one id. */
export const GOLDEN_BODY = BODY;
/** The fixed clock both sides run under, so no wall clock reaches the record. */
export const FIXED_NOW = 1700000000000;
/** The issue the golden run carries. */
export const GOLDEN_ISSUE = 2212;
/** The committed path of the golden fixture, relative to `smoke-tests/`. */
export const GOLDEN_FIXTURE = "fixtures/lean-state/specify-off-v0.14.71.json";

/** The identity every git child of the harness runs with, the production commit included. */
export function goldenGitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** git in `dir` with that identity. */
export function goldenGit(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: goldenGitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** The record R2 compares: terminal state, code, reason, and each step's state/key/outcome. */
export interface GoldenRun {
  state: string;
  code: number;
  reason: string;
  steps: { state: string; key: string; outcome?: unknown }[];
  /** How many times the `decline` step ran, and the rules it was handed to report. */
  declineRan: number;
  declineRules: string[];
}

/** The `decline` spy: it records what the run wanted reported and posts nothing. */
export interface DeclineSpy {
  ran: number;
  rules: string[];
}

/** One full commit sha, as the step's drop note quotes it. */
const SHA_TEXT = /\b[0-9a-f]{40}\b/g;

/** Mask every clock-derived field, and the base sha, of one run record. */
export function goldenOf(run: LeanRun, code: number, decline: DeclineSpy): GoldenRun {
  const mask = (s: string): string => s.replace(SHA_TEXT, "<base>");
  const outcome = (o: Outcome | undefined): unknown =>
    o === undefined ? undefined : (JSON.parse(mask(JSON.stringify(o))) as unknown);
  return {
    state: run.state,
    code,
    reason: mask(run.result?.reason ?? ""),
    steps: run.steps.map((s) => ({ state: s.state, key: s.key, outcome: outcome(s.outcome) })),
    declineRan: decline.ran,
    declineRules: decline.rules,
  };
}

/**
 * Drive the real `runLean` over `handlersFor`'s phase-1 handlers.
 *
 * Everything the step touches is the production path — the real `execp`, the real
 * config load off the base commit, the real issue read through the `gh` stub — and
 * only the model is a fake: the child writes its unclear test and declares it. The
 * run's `repoRoot` is the fixture repo itself, because that is what a real
 * `/work-lean` passes: the state file, the lock and every worktree the step makes
 * hang off it, and a scratch dir instead would make the step's own `git worktree
 * add` fail outside the code under test.
 */
export async function driveOffArm(
  issue: number,
  opts: {
    switchOff: boolean;
    /**
     * Ask `specify` for its probe file before it dispatches and fail the run if the
     * byte is there. This is the golden's own witness that the preflight did not
     * run: the switch-off arm must leave no probe, and the comparison of two
     * identical records would otherwise pass on a run that paid for one.
     */
    assertNoProbe?: boolean;
    /** The probe basename the off arm must NOT leave behind. */
    probeBasename?: string;
    /**
     * Sabotage the run's `verify.test` runner at the instant the reset would have
     * populated the tree's submodules — the `beforeSubmoduleInit` seam of
     * `resetWorktreeToBase`. A switch-off run never reaches the seam, because it
     * never populates anything, so a case that makes the sabotage fatal proves the
     * submodule call was not issued rather than trusting a record that agrees.
     */
    beforeSubmoduleInit?: (wt: string) => void;
    /** Replace `specify` — the golden drives the real step; a probe may stub it. */
    specify?: (ctx: Parameters<typeof specifyOutcome>[0], deps: SpecifyDeps) => Promise<Outcome>;
    decline: DeclineSpy;
  },
): Promise<GoldenRun> {
    // `build` is never part of this golden: the run is expected to end at
    // `specify`'s decline. A refusal kind keeps the record finite and offline if a
    // change ever lets the run past the decline, rather than spawning the host's
    // `pi` from a smoke test — `handback` is a real terminal route and, unlike a
    // dead child's `DispatchResult`, one the machine accepts.
    const noBuild = async (): Promise<Outcome> =>
      ({ kind: "blocked", reason: "build is not part of this golden" });
  const repo = originRepo({
    workJson: { version: 1, verify: { fast: "true", test: RUNNER_TEMPLATE } },
  });
  try {
    seedWithRunner(repo.repoRoot, issue);
    const seed = await leanSeed(repo.repoRoot);
    if (seed.baseSha === "") throw new Error(`seed failed: ${seed.why ?? "no reason"}`);
    const handlers: LeanHandlers = {
      ...handlersFor(repo.repoRoot, issue, {}, seed),
      build: noBuild,
      decline: async (ctx) => {
        opts.decline.ran++;
        opts.decline.rules = ctx.steps.flatMap(
          (s) => s.outcome?.failedRules ?? [],
        ) as string[];
        return { kind: "done" };
      },
    };
    const deps: SpecifyDeps = {
      exec: (cmd, o) => execp(cmd, { ...(o ?? {}), env: { ...goldenGitEnv(), ...(o?.env ?? {}) } }),
      dispatch: async (spec): Promise<DispatchResult> => {
        if (opts.assertNoProbe === true) {
          const probe = path.join(spec.cwd as string, opts.probeBasename ?? PROBE_BASENAME);
          if (existsSync(probe))
            throw new Error(`the switch-off run wrote a runner probe at ${probe}`);
        }
        const tree = spec.cwd as string;
        mkdirSync(path.join(tree, "tests"), { recursive: true });
        writeFileSync(path.join(tree, TEST_REL), UNCLEAR_TEST, { mode: 0o755 });
        return {
          role: "developer",
          ok: true,
          text: "done",
          toolUses: [
            { name: "submit_tests", arguments: { criterionId: "AC1", testFiles: [TEST_REL] } },
          ],
          ms: 1,
          exitCode: 0,
          usage: { input: 5, output: 6, cacheRead: 1, cacheWrite: 2, cost: 0.125, turns: 3 },
        };
      },
      fetchIssueBody: async () => GOLDEN_BODY,
      loadConfig: async () => ({
        ...defaultConfig(),
        verify: { fast: "true", test: RUNNER_TEMPLATE },
      }),
      statReporter: async () => ({}),
      ...(opts.beforeSubmoduleInit === undefined
        ? {}
        : { beforeSubmoduleInit: opts.beforeSubmoduleInit }),
    };
    const saved = process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT;
    if (opts.switchOff) process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT = "0";
    else delete process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT;
    try {
      const result = await withStubForge(fakeGhDir(GOLDEN_BODY), () =>
        runLean({
          repoRoot: repo.repoRoot,
          issue,
          handlers: {
            ...handlers,
            specify: (ctx) =>
              opts.specify === undefined ? specifyOutcome(ctx, deps) : opts.specify(ctx, deps),
          },
          seed: { version: seed.version, baseSha: seed.baseSha },
          now: () => FIXED_NOW,
        }),
      );
      return goldenOf(result.run, result.code, opts.decline);
    } finally {
      if (saved === undefined) delete process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT;
      else process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT = saved;
      // The engine's state file and lock live under the repo the run was driven
      // at, and so does the step's worktree. They are the run's output, not its
      // input: a second arm over the same repo would resume the first one's record.
      rmSync(path.join(repo.repoRoot, ".pi", "lean-state"), { recursive: true, force: true });
      rmSync(`${path.join(repo.repoRoot, ".pi", "lean-state", `${String(issue)}.json`)}.lock`, {
        force: true,
      });
      rmSync(path.join(repo.repoRoot, ".worktrees", `lean-${String(issue)}`), {
        recursive: true,
        force: true,
      });
    }
  } finally {
    repo.dispose();
  }
}

/**
 * The base commit the run seeds: the seed fixture's repo plus the runner the
 * config names, pushed to origin so the seed resolves the same sha on both sides.
 */
function seedWithRunner(repoRoot: string, issue: number): void {
  const wt = path.join(repoRoot, ".worktrees", `golden-base-${String(issue)}`);
  mkdirSync(path.join(repoRoot, ".worktrees"), { recursive: true });
  goldenGit(repoRoot, "worktree", "add", "-q", "--detach", wt, "main");
  writeFileSync(path.join(wt, "runner.sh"), RUNNER_SH, { mode: 0o755 });
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, GREEN_TEST_REL), GREEN_TEST, { mode: 0o755 });
  goldenGit(wt, "add", "-A");
  goldenGit(wt, "commit", "-q", "-m", "the project's runner");
  goldenGit(repoRoot, "update-ref", "refs/heads/main", goldenGit(wt, "rev-parse", "HEAD"));
  goldenGit(repoRoot, "push", "-q", "origin", "main");
}

/** The step's outcome as the record holds it, for an assertion that names the field it read. */
export function outcomeOf(
  golden: GoldenRun,
  state: string,
): Record<string, unknown> | undefined {
  return golden.steps.find((s) => s.state === state)?.outcome as Record<string, unknown> | undefined;
}
