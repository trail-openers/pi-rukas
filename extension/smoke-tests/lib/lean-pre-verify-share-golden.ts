/**
 * lib/lean-pre-verify-share-golden — the OFF-arm golden of #2634, in one place.
 *
 * `test-lean-pre-verify-share-off-arm.ts` compares the switch-at-`0` run against
 * `fixtures/lean-state/pre-verify-share-off-2634.json`, a record captured ONCE from `c488c87cb2`
 * — origin/main before the pre-verify share existed — by
 * `fixtures/lean-state/capture-pre-verify-share-off.ts`, which calls THIS same `driveOffArm`. Both
 * sides must build the run the same way, so the recipe lives here. The capture is run against a
 * worktree of that commit with this file and the capture script COPIED in, so every `src/` import
 * it makes resolves inside the pre-change tree: a golden whose harness drifted from its capture, or
 * whose `src/` resolved at main, would pin nothing.
 *
 * What AC4's byte-identity covers, and why each surface is here:
 *
 *   - **the step log** — the share's only other writer is `challenge`'s skip, so the records a
 *     bounded run could grow a key on are `specify`, `build`, `challenge` and `verify`;
 *   - **the `## Run` section** — `publish-body` gained the `challenge skipped:` line, and an off-arm
 *     body that printed it would be a leak the step log alone cannot catch;
 *   - **the `gates` object** — `challengeGates` gained a fourth kind and a `reason` key on the
 *     projection's challenge arm;
 *   - **the machine tables** — `OUTCOME_KINDS.challenge` and the registry's forward-routed pair
 *     count, which a leaked kind or a quiet extra edge would move.
 *
 * Every clock-derived field and every sha (full or 12-char) and the version stamp is masked: the base
 * sha rides in a reason line, the short sha in `publish`'s, and a fixture repo built afresh has new ones each run. The machine's two registry
 * fields — `OUTCOME_KINDS.challenge` and the forward-routed pair count — are masked on BOTH sides,
 * because the change under review adds the `skipped` kind and its edge to them by design: a golden
 * that compared them could only pass by having been captured from this branch. `test-lean-machine.ts`
 * pins those two against the live registry. What is NOT masked is a KEY: a step record that gained a
 * key, a `reason` beside a verdict that never had one, a Run line that started printing, or a gates
 * field that appeared on the off arm, fails the comparison rather than passing a looser check.
 *
 * The run is offline on both sides: real git in a temp repo, a stub `gh` printing the issue body, a
 * recording forge whose push goes to a real bare origin. The steps no in-process trial could run
 * (`review`, `ci`, `land`, and the four whose verdict the case scripts) are stubs — the golden is
 * about the RECORD the four bounded surfaces hold, not about what a review judges. The project
 * roster is off on both arms, as the release had none: its run-start check refuses a fixture runner
 * that writes no JUnit report.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { leanGates } from "../../src/headless/work-lean-gates.ts";
import { execp } from "../../src/exec.ts";
import type { NormalizedPullRequest } from "../../src/forge-types.ts";
import { handlersFor, leanSeed } from "../../src/lean/command.ts";
import type { LeanHandlers, RunLeanResult } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import { OUTCOME_KINDS } from "../../src/lean/machine.ts";
import { publishOutcome } from "../../src/lean/publish.ts";
import type { PublishDeps } from "../../src/lean/publish-deps.ts";
import { renderPiSpec } from "../../src/lean/spec.ts";
import { specifyWorktreePath } from "../../src/lean/specify-tree.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { SPEC, fakeGhDir, originRepo, withStubForge } from "./lean-seed-fixtures.ts";

/** The issue the golden run carries — its step keys carry it, so it is part of the record. */
export const GOLDEN_ISSUE = 2634;
/** The fixed clock both sides run under, so no wall clock reaches the record. */
export const FIXED_NOW = 1700000000000;
/** The committed path of the golden, relative to `smoke-tests/`. */
export const SHARE_FIXTURE = "fixtures/lean-state/pre-verify-share-off-2634.json";
/** The frozen test the run records, and the file the fixture commits at HEAD. */
export const FROZEN_REL = "tests/AC1-retry.test.sh";
const FROZEN_SHA = "0".repeat(64);
const PR_URL = "https://forge.invalid/o/r/pull/7";

/** Every full sha, and the version stamp, in every printed surface: a fixture repo built afresh
 * has new shas each run, and the `- pi-rukas x.y.z` line reports the package, not the commit, so it
 * restates the release each PR bumps it. A key is never masked — only these two value shapes. */
const mask = (s: string): string =>
  s
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/\b[0-9a-f]{12}\b/g, "<sha12>")
    .replace(/- pi-rukas [^\n]*/, "- pi-rukas <version>");

/** The identity every git child of the harness runs with, the production commit included. */
function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** The contract the golden's issue carries: one `verify: "test"` criterion. */
const SPEC_BODY = renderPiSpec({
  problem: SPEC.problem,
  size: "S",
  criteria: [{ id: "AC1", text: "retries a transient failure twice", verify: "test" }],
});

/** A forge stub that records the body it was handed; the push itself goes to a real origin. */
function recordingForge(): {
  forge: PublishDeps["forge"];
  created: { title: string; head: string; body: string }[];
} {
  const created: { title: string; head: string; body: string }[] = [];
  const row = (draft: boolean): NormalizedPullRequest => ({
    number: 7,
    title: "t",
    body: "",
    state: "OPEN",
    url: PR_URL,
    headRefName: `lean/issue-${String(GOLDEN_ISSUE)}`,
    baseRefName: "main",
    author: undefined,
    mergeable: null,
    mergeStateStatus: null,
    isDraft: draft,
    labels: [],
    createdAt: undefined,
    updatedAt: undefined,
  });
  return {
    created,
    forge: async () => ({
      issueView: async () => ({
        number: GOLDEN_ISSUE,
        title: "the retry helper gives up too early",
        body: SPEC_BODY,
        state: "OPEN" as const,
        url: "https://forge.invalid/o/r/issues/7",
        labels: [],
      }),
      prList: async () => [],
      prView: async () => row(false),
      prDraft: async () => {},
      prCreate: async (title: string, head: string, body: string) => {
        created.push({ title, head, body });
        return row(false);
      },
    }),
  };
}

/** The record AC4 compares: the four surfaces the bound could have moved, plus the run's stamp. */
export interface ShareGolden {
  /** Each step's masked record — where a `skipped` kind or a new key would show. */
  steps: { state: string; key: string; outcome?: unknown }[];
  /** The `## Run` section of the PR body the publish step wrote. */
  runSection: string;
  /** The headless `issues[].gates` object, sha-masked. */
  gates: unknown;
  /** The machine's registry tables, read from the live tables and masked on both sides (see the
   * header): the suite asserts them against the registry, it does not compare them to the capture. */
  machine: { pairs: number; challengeKinds: string[] };
  state: string;
  code: number;
}

/** One scripted step of the log the run reaches `publish` with. */
function step(state: Step["state"], outcome: Outcome): Step {
  return {
    key: `${String(GOLDEN_ISSUE)}:${state}:0`,
    state,
    startedAt: FIXED_NOW,
    endedAt: FIXED_NOW + 1000,
    outcome,
  };
}

/**
 * Drive the golden's run once, with `PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE` left UNSET — the arm the
 * capture recorded, and the arm the suite compares both of its own arms against.
 *
 * The four steps whose verdict the golden states are scripted so no model is paid and the record is
 * the case's; `publish` is the REAL step, because the `## Run` section is its output. Origin already
 * holds the head, so the step takes its no-write path and still writes the body to the recording
 * forge.
 */
export async function driveOffArm(issue: number): Promise<ShareGolden> {
  const repo = originRepo({ workJson: { version: 1, verify: { fast: "true" } } });
  try {
    const seed = await leanSeed(repo.repoRoot);
    if (seed.baseSha === "") throw new Error(`seed failed: ${seed.why ?? "no reason"}`);
    const branch = `lean/issue-${String(issue)}`;
    const wt = specifyWorktreePath(repo.repoRoot, issue);
    mkdirSync(path.join(repo.repoRoot, ".worktrees"), { recursive: true });
    git(repo.repoRoot, "worktree", "add", "-q", "-b", branch, wt, "main");
    mkdirSync(path.join(wt, "tests"), { recursive: true });
    writeFileSync(path.join(wt, FROZEN_REL), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(wt, "src.ts"), "export const retry = () => retryTwice();\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "test: the frozen contract, and the build");
    const head = git(wt, "rev-parse", "HEAD");
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`fixture head is not a sha: ${head}`);
    // Origin already holds the head the step would push: a branch it cannot read back is
    // infrastructure, and a no-write push is the path that still opens the PR with a body.
    git(wt, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    // The shape the run reaches publish with: a decided green gate about THIS head, and the frozen
    // map whose path `publish`'s body prints as the criterion's test file.
    const log: Step[] = [
      step("ready", { kind: "ok" }),
      step("specify", {
        kind: "ok",
        frozen: { [FROZEN_REL]: FROZEN_SHA },
        tests: { AC1: [FROZEN_REL] },
      }),
      step("build", { kind: "ok" }),
      step("challenge", { kind: "none" }),
      step("verify", { kind: "green", verifiedHead: head }),
    ];
    const of = (state: Step["state"]): Outcome => {
      const entry = log.find((s) => s.state === state);
      if (entry?.outcome === undefined) throw new Error(`no scripted outcome for ${state}`);
      return entry.outcome;
    };
    const forge = recordingForge();
    const handlers: LeanHandlers = {
      ...handlersFor(repo.repoRoot, issue, {}, seed),
      ready: async () => of("ready"),
      specify: async () => of("specify"),
      build: async () => of("build"),
      challenge: async () => of("challenge"),
      verify: async () => of("verify"),
      publish: (ctx) =>
        publishOutcome(ctx, {
          exec: async (cmd, o) =>
            execp(cmd, { ...(o ?? {}), env: { ...gitEnv(), ...(o?.env ?? {}) } }),
          fetchBody: async () => SPEC_BODY,
          forge: forge.forge,
          issueSpec: async () => undefined,
          specBlock: async () => {
            throw new Error("the golden has no spec block");
          },
        }),
      // Not part of this golden: review buys thirteen children and `ci` polls a pipeline. The
      // machine still routes them, so the run ends the way a real one does.
      review: async () => ({ kind: "done", reason: "review is not part of this golden" }),
      ci: async () => ({ kind: "green" }),
      land: async () => ({ kind: "merged" }),
    };
    const result: RunLeanResult = await withStubForge(fakeGhDir(SPEC_BODY), () =>
      runLean({
        repoRoot: repo.repoRoot,
        issue,
        handlers,
        seed: { version: seed.version, baseSha: seed.baseSha },
        now: () => FIXED_NOW,
      }),
    );
    const body = forge.created[0]?.body;
    if (body === undefined)
      throw new Error(`the run opened no PR (${result.run.state} / ${String(result.code)})`);
    const runSection = body.slice(body.indexOf("## Run"));
    return {
      steps: result.run.steps.map((s) => ({
        state: s.state,
        key: s.key,
        outcome: s.outcome === undefined ? undefined : JSON.parse(mask(JSON.stringify(s.outcome))),
      })),
      runSection: mask(runSection),
      gates: JSON.parse(mask(JSON.stringify(leanGates(result.run.steps, (s) => s)))),
      machine: {
        pairs: forwardPairs(),
        challengeKinds: [...OUTCOME_KINDS.challenge],
      },
      state: result.run.state,
      code: result.code,
    };
  } finally {
    rmSync(path.join(repo.repoRoot, ".pi", "lean-state"), { recursive: true, force: true });
    rmSync(path.join(repo.repoRoot, ".worktrees"), { recursive: true, force: true });
    repo.dispose();
  }
}

/** The registry's forward-routed pair count — the same sum `test-lean-machine.ts` asserts. */
function forwardPairs(): number {
  return Object.values(OUTCOME_KINDS).reduce((n, kinds) => n + kinds.length, 0);
}
