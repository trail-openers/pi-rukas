/**
 * lib/lean-specify-gap-golden — one lean run whose `specify` child submits a test that passes on the
 * base, driven through the real `runLean` and the real phase-1 handlers.
 *
 * `test-lean-specify-gap-handback.ts` compares the record of each arm of
 * `PI_ENSEMBLE_LEAN_SPECIFY_GAP_HANDBACK` against `fixtures/lean-state/specify-gap.json`. The `off` record
 * there was captured from the tree before the switch existed, by this same function, so it pins the release
 * the off arm restores; the `on` record pins the handback that replaced it.
 *
 * The record carries the headless projection's `failure` too, so the kind a host branches on is pinned.
 * Only the model and the comment's destination are fakes: the child writes one test that exits 0 and
 * declares it, and `setLeanCommentPoster` records each comment body instead of posting it. The config names a
 * runner (`sh {file}`) that runs an empty probe cleanly, so the run reaches the red proof, which drops the file
 * as `exited 0 on base`. The clock is fixed and every full sha is masked: the base sha is quoted in the
 * reason, and a fixture repo built afresh has a new one every run.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { ResultFailure } from "../../src/headless/failure.ts";
import { leanIssueResult } from "../../src/headless/work-lean-result.ts";
import { handlersFor, leanSeed } from "../../src/lean/command.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import { runLean } from "../../src/lean/engine.ts";
import { setLeanCommentPoster } from "../../src/lean/io.ts";
import type { SpecifyDeps } from "../../src/lean/specify.ts";
import { specifyOutcome } from "../../src/lean/specify.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { withEnv } from "./env-scope.ts";
import { BODY, fakeGhDir, originRepo, withStubForge } from "./lean-seed-fixtures.ts";
import { FIXED_NOW, goldenGitEnv } from "./lean-specify-off-golden.ts";

/** The committed path of the two records, relative to `smoke-tests/`. */
export const GAP_FIXTURE = "fixtures/lean-state/specify-gap.json";

/** The child's test: green on the base, so nothing proves it red. */
const CHILD_REL = "tests/AC1-child.test.sh";
const RUNNER = "sh {file}";

/** What one arm leaves behind: the run's verdict, each step's outcome, and every comment body. */
export interface GapRecord {
  state: string;
  code: number;
  reason: string;
  steps: { state: string; key: string; outcome?: unknown }[];
  comments: string[];
  /** The headless projection's `failure`; absent for a decline, which is no failure. */
  failure?: ResultFailure;
}

const mask = (s: string): string => s.replace(/\b[0-9a-f]{40}\b/g, "<sha>");

/** Drive one run with the switch at `gapSwitch` (`undefined` = unset). */
export async function driveGapRun(
  issue: number,
  gapSwitch: string | undefined,
): Promise<GapRecord> {
  const repo = originRepo({ workJson: { version: 1, verify: { fast: "true", test: RUNNER } } });
  const comments: string[] = [];
  const restore = setLeanCommentPoster(async (_issue, body) => {
    comments.push(body);
  });
  let record: GapRecord | undefined;
  try {
    const seed = await leanSeed(repo.repoRoot);
    if (seed.baseSha === "") throw new Error(`seed failed: ${seed.why ?? "no reason"}`);
    const deps: SpecifyDeps = {
      exec: (cmd, o) => execp(cmd, { ...(o ?? {}), env: { ...goldenGitEnv(), ...(o?.env ?? {}) } }),
      dispatch: async (spec) => {
        const tree = spec.cwd as string;
        mkdirSync(path.join(tree, "tests"), { recursive: true });
        writeFileSync(path.join(tree, CHILD_REL), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        return {
          role: "developer",
          ok: true,
          text: "done",
          toolUses: [
            { name: "submit_tests", arguments: { criterionId: "AC1", testFiles: [CHILD_REL] } },
          ],
          ms: 1,
          exitCode: 0,
          usage: { input: 5, output: 6, cacheRead: 1, cacheWrite: 2, cost: 0.125, turns: 3 },
        };
      },
      fetchIssueBody: async () => BODY,
      loadConfig: async () => ({ ...defaultConfig(), verify: { fast: "true", test: RUNNER } }),
      statReporter: async () => ({}),
    };
    // The project roster's run-start check refuses a runner that writes no JUnit report.
    await withEnv(
      { PI_ENSEMBLE_LEAN_SPECIFY_GAP_HANDBACK: gapSwitch, PI_ENSEMBLE_LEAN_PROJECT_ROSTER: "0" },
      async () => {
        const result = await withStubForge(fakeGhDir(BODY), () =>
          runLean({
            repoRoot: repo.repoRoot,
            issue,
            handlers: {
              ...handlersFor(repo.repoRoot, issue, {}, seed),
              // The run must end at `specify`; a build would spawn a real child.
              build: async (): Promise<Outcome> => ({ kind: "blocked", reason: "no build here" }),
              specify: (ctx) => specifyOutcome(ctx, deps),
            },
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
        };
      },
    );
  } finally {
    restore();
    rmSync(path.join(repo.repoRoot, ".worktrees"), { recursive: true, force: true });
    repo.dispose();
  }
  if (record === undefined) throw new Error("the run left no record");
  return record;
}
