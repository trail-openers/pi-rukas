/**
 * lib/lean-ci-land-fixture — the log shape `ci` and `land` arrive on, for real.
 *
 * Both steps read the same two facts off the step log: the newest decided
 * `verify`'s `verifiedHead`, and (for `ci`) the `publish` step's `prUrl`. Those
 * fields are step-owned and shape-checked by `state-outcome.ts`, so a case that
 * hand-builds them is testing a record the loader would refuse — which is how a
 * gate ends up matching a head that can never exist. This module builds the log
 * the way a run writes it: in a real temp git repo, on a real branch, whose HEAD
 * holds a real commit whose oid the `verify` step records.
 *
 * The repo is deliberately minimal. Neither step judges the tree (that is
 * `verify`'s job, and `test-lean-verify.ts` owns it); both judge a COMMIT OID
 * and a forge answer. So the fixture spends its effort on the two claims that
 * are load-bearing here — a real 40-hex head on the log, and a real PR URL —
 * and injects everything else.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** Temp dirs this module made; the caller removes them at the end of the run. */
export const ROOTS: string[] = [];

/** The forge's answer for the PR this fixture's publish step recorded. */
export const PR_NUMBER = 77;
export const PR_URL = `https://github.com/o/r/pull/${String(PR_NUMBER)}`;

function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** git in `dir`, with an identity in the child's environment. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

export interface CiLandLog {
  repoRoot: string;
  /** The commit the `verify` step's green is a claim about — a real oid. */
  head: string;
  /** What the branch is called, so a case can assert the step looked there. */
  branch: string;
  ctx: HandlerCtx;
}

/**
 * A repo at a real commit, plus the log a run carries when it arrives at `ci`
 * or `land`: verified green at that commit, published at `PR_URL`.
 *
 * `head` overrides the recorded verified head — the case where the PR has moved
 * off what the gate certified. It is a string, not a real commit, on purpose:
 * the step's job is the EQUALITY of two oids, and an oid the repo has never
 * held is the most unequal thing available.
 */
export function ciLandLog(
  issue: number,
  opts: {
    /** Drop the verified head entirely (the log says nothing was certified). */
    noVerifiedHead?: boolean;
    /** The oid the verify step records, in place of the repo's own head. */
    verifiedHead?: string;
    /** Drop the publish step (nothing was ever opened on the forge). */
    noPr?: boolean;
  } = {},
): CiLandLog {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-ci-land-"));
  ROOTS.push(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "src/retry.ts"), "export const retry = () => 1;\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "feat: implemented the retry helper");
  const head = git(repoRoot, "rev-parse", "HEAD");
  const branch = `lean/issue-${String(issue)}`;
  git(repoRoot, "branch", branch, head);

  const verify: Outcome = {
    kind: "green",
    reason: `frozen tests and project tiers passed at ${head}`,
    ...(opts.noVerifiedHead === true ? {} : { verifiedHead: opts.verifiedHead ?? head }),
  };
  const steps: Step[] = [
    { key: `${String(issue)}:ready:0`, state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    { key: `${String(issue)}:verify:0`, state: "verify", startedAt: 2, outcome: verify },
  ];
  if (opts.noPr !== true)
    steps.push({
      key: `${String(issue)}:publish:0`,
      state: "publish",
      startedAt: 3,
      outcome: { kind: "ok", prUrl: PR_URL, publishedHead: head },
    });

  const run0 = createRun({
    issue,
    version: "test",
    models: {},
    baseSha: "a".repeat(40),
    branch,
  });
  return {
    repoRoot,
    head,
    branch,
    ctx: {
      repoRoot,
      issue,
      run: { ...run0, steps },
      steps,
      stepKey: `${String(issue)}:land:0`,
      now: () => 4,
    },
  };
}
