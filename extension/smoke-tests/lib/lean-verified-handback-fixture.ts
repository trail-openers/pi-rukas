/**
 * lib/lean-verified-handback-fixture — the rigs the files that test the verified
 * handback share: the queue and the stop that reproduce the defect, the post spy
 * that captures the comment, and the real-repo git harness the lease rewind is
 * driven against.
 *
 * The reproduction is the sequence the defect needs and nothing else: a review
 * step that ends `fixed` (its fix wave pushed a new head), and a drive stopped
 * there, so the re-verify the table routes into never runs.
 *
 * Why a bounded hang rather than a throw or a clock: the engine writes a step
 * ahead and then calls its handler, so a handler that throws records
 * `{kind: "error"}` — a DECIDED `verify`, which is a different record from the
 * one the defect needs, and a rule keyed on the log would not fire. Only a
 * process that died between the write-ahead and the outcome leaves the entry the
 * write-ahead made without a verdict. So the rig's handler for the re-verify
 * parks on a promise the harness RELEASES once it has read the record, and the
 * released drive lands its error verdict on an in-memory copy that nothing reads
 * — the file on disk keeps the shape the killed process left, which is the shape
 * the engine's own resume path (`resume.ts`) drives.
 *
 * The clock is the house {@link crossing} rig from
 * `lib/lean-host-contract-fixture.ts`, keyed on the step the run stands in. Its
 * two positions — `Date.now()` while the run works, and `Date.now() + 240 min −
 * 1 min` at the boundary it judges — are derived from the SAME reads the engine's
 * stop test makes, so the run is never born past its own deadline: an epoch
 * pinned in the past puts every boundary inside the handoff allowance and the run
 * stops before its first step, which is a red case, not the bug.
 *
 * The post spy is the whole post path: `handbackOutcome` takes `post` as an
 * argument, so capturing what it was handed needs no seam anywhere else, and the
 * off-arm golden compares those bytes against a capture taken before the rule
 * existed.
 */

import { spawnSync } from "node:child_process";
import { isFullCommitSha } from "../../src/commit-sha.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import { type Outcome, REPORT_STATES } from "../../src/lean/state.ts";
import { MAX_BUILD_ATTEMPTS } from "../../src/lean/machine.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** The full commit shas the cases use, so a head in a record is a chosen value. */
export const VERIFIED_SHA = "1111111111111111111111111111111111111111";
export const FIX_SHA = "2222222222222222222222222222222222222222";

/** The green gate's own words for the head it certified, printed as the comment's `needed:` line. */
export const VERIFY_REASON = `all frozen tests green at ${VERIFIED_SHA}`;

/**
 * The queue for a run whose review fixed its head: the walk up to the review is
 * the ordinary green one, and the review answers `fixed`.
 *
 * `verify` holds exactly ONE verdict — the green the run earned BEFORE the
 * review — and that is the whole point. The re-verify `review:fixed` routes into
 * is never answered, which is what leaves the entry the write-ahead made without
 * an outcome.
 *
 * `handback` and `decline` are absent on purpose: they are the steps the cases
 * observe, and the driver installs the REAL reporting handler (with the post spy)
 * rather than a scripted verdict.
 */
export const FIXED_THEN_CROSSING: Partial<Record<string, Outcome[]>> = {
  ready: [{ kind: "ok" }],
  // `frozen` is what the handback comment lists under `Frozen acceptance tests:`, so
  // the run carries a contract: a comment with no lines there would not reproduce the
  // body the off-arm golden has to match.
  specify: [
    {
      kind: "ok",
      frozen: { "tests/AC1-verified-head.test.sh": "a".repeat(64) },
      tests: { AC1: ["tests/AC1-verified-head.test.sh"] },
    },
  ],
  build: Array.from({ length: MAX_BUILD_ATTEMPTS }, () => ({ kind: "ok" }) as Outcome),
  challenge: [{ kind: "none" }],
  verify: [{ kind: "green", verifiedHead: VERIFIED_SHA, reason: VERIFY_REASON }],
  publish: [
    {
      kind: "ok",
      prUrl: "https://github.com/o/r/pull/1",
      publishedHead: FIX_SHA,
      reason: `published PR at ${FIX_SHA.slice(0, 12)}`,
    },
  ],
  review: [{ kind: "fixed", reason: `review clean at ${FIX_SHA.slice(0, 12)}, one fix wave` }],
};

/**
 * Handlers for one pass of the drive, and the handle on the step it parks at.
 *
 * `park` names what the harness expects the pass to be stopped on. `verify` is the
 * defect's own position: the queue runs dry at the re-verification and the handler
 * hangs there, which is the only thing that leaves the entry the write-ahead made
 * without an outcome. `handback` is the second pass: every verdict the replay needs
 * is queued, and the reporting step — the one the case observes through its real
 * handler — must not be answered from the script, so the pass stands at it until
 * the harness releases it, with its record already saved.
 */
export interface StoppedDrive {
  handlers: LeanHandlers;
  /** Every state whose handler ran, in order — the walk's own witness. */
  calls: string[];
  /** The state the drive is parked on; `undefined` until the harness sees it. */
  standingAt: () => string | undefined;
  /** Release the parked handler so the drive's promise settles (nothing reads its answer). */
  release: () => void;
}

/**
 * Handlers for the walk up to and including the review, which then STOP the drive
 * the way a killed process does at the re-verify its `fixed` review routes into.
 *
 * A handler cannot decline to answer: `settle` records whatever it returns, and a
 * throw it catches becomes `{kind: "error"}` — a DECIDED step. The only thing that
 * leaves the entry the write-ahead made WITHOUT an outcome is a handler that hangs.
 * So the queue running dry at `verify` parks on a promise, and the harness releases
 * it (`release`) after it has read the record the hanging drive left on disk. The
 * released drive then writes its error verdict into that file, which is why the
 * harness re-arms the pending entry before the second pass — the file has to hold
 * the residue a killed process left, not the answer a released promise wrote.
 *
 * The park is bounded by the driver, which fails loudly if the hang is anywhere but
 * the re-verify — a walk that never reached a `fixed` review is a red case, not a
 * test that waits forever.
 */
export function stopAtReverify(
  plan: Partial<Record<string, Outcome[]>>,
  park: "verify" | "handback" = "verify",
  /** How many `verify` verdicts this pass may answer before the re-verification parks it. */
  verifyVisits = 2,
): StoppedDrive {
  const handlers: LeanHandlers = {};
  const calls: string[] = [];
  // A FRESH plan object per pass: the queues are built from the caller's plan at call
  // time, so a queue drained by the first pass cannot starve the second.
  const queues = Object.fromEntries(
    Object.entries(structuredClone(plan)).map(([state, queue]) => [state, [...(queue ?? [])]]),
  ) as Record<string, Outcome[]>;
  // The pass stops where its queue runs out — the re-verification the `fixed` review
  // routes into and nothing answers. `standingAt` is what the harness checks, so a
  // stop anywhere else is a red case rather than a walk that quietly ran past it.
  let standing: string | undefined;
  let resolvePark: ((outcome: Outcome) => void) | undefined;
  for (const state of [...new Set([...Object.keys(queues), park])]) {
    handlers[state as never] = (async () => {
      // The parked state never answers from a queue: reaching it at all on the pass
      // that is supposed to stand there is the pass's stop, and reaching it on the
      // other pass is the bug. `standingAt` and `calls` say which happened.
      if (state === park) {
        calls.push(state);
        standing = state;
        return new Promise<Outcome>((resolve) => {
          resolvePark = resolve;
        });
      }
      // `verify` is deliberately in BOTH roles: pass one walks INTO the
      // re-verification and parks there, so its green queue is deliberately one entry
      // short of the visits the log will hold. Pass two's plan holds one verdict per
      // visit its REPLAY consumes, so a replay never mistakes a decided entry for the
      // pending one — `verifiedPosition` consumes an entry per visit and the queue is
      // consumed in step.
      const next = queues[state]?.shift();
      // A reporting state is never answered from the queue: the driver installs the
      // REAL handler for it, so a queue that carried one would shadow the step under
      // test. Listing them keeps the plan honest rather than silently ignored.
      if (next !== undefined && REPORT_STATES.includes(state as never))
        throw new Error(
          `the plan scripts ${state}, which is the step the case observes — remove the entry`,
        );
      calls.push(state);
      if (next === undefined)
        throw new Error(`no scripted outcome for ${state} — the walk ran past its plan`);
      return next;
    }) as never;
  }
  return {
    handlers,
    calls,
    standingAt: () => standing,
    // Idempotent: the harness releases from its assertions AND from a `finally`, and
    // a second call must not throw or change an answer already given.
    release: () => resolvePark?.({ kind: "done", reason: "released by the harness" }),
  };
}

/** The comment a post spy captured. */
export interface CapturedPost {
  repoRoot: string;
  issue: number;
  body: string;
}

/** A `post` seam that records every body it was handed. */
export function postSpy(): {
  posts: CapturedPost[];
  post: (r: string, i: number, b: string) => Promise<void>;
} {
  const posts: CapturedPost[] = [];
  return {
    posts,
    post: async (repoRoot: string, issue: number, body: string) => {
      posts.push({ repoRoot, issue, body });
    },
  };
}

/**
 * How long the harness waits for the drive to reach the re-verify before it calls
 * the walk broken. The drive is scripted and instantaneous, so a case that does not
 * reach the boundary in this long never will, and must be reported rather than waited on.
 */
export const ARRIVE_GRACE_MS = 1_000;

/** A promise that settles after `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run git and require success, so a fixture failure is loud, not a wrong verdict. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...gitTestEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** Run git and report failure as `undefined` rather than throwing. */
export function gitQuiet(dir: string, ...args: string[]): string | undefined {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...gitTestEnv(), GIT_TERMINAL_PROMPT: "0" },
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : undefined;
}

/** Write a file inside a fixture repo, making the parent directories. */
export function put(dir: string, rel: string, body: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

/** A clone with a real bare origin, a base commit, and a branch tip of the fix wave's head. */
export function originRepo(opts: {
  branch: string;
  head?: { file: string; body: string };
}): { repoRoot: string; origin: string; baseSha: string; headSha: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-handback-repo-"));
  const origin = mkdtempSync(path.join(tmpdir(), "lean-handback-origin-"));
  git(repoRoot, "init", "-q", "-b", "main");
  git(origin, "init", "-q", "--bare");
  put(repoRoot, "a.ts", "export const a = 1;\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  const baseSha = git(repoRoot, "rev-parse", "HEAD");
  git(repoRoot, "remote", "add", "origin", origin);
  git(repoRoot, "push", "-q", "-u", "origin", "main");
  git(repoRoot, "checkout", "-q", "-B", opts.branch);
  let headSha = baseSha;
  if (opts.head !== undefined) {
    put(repoRoot, opts.head.file, opts.head.body);
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-q", "-m", "fix: the finding");
    headSha = git(repoRoot, "rev-parse", "HEAD");
  }
  git(repoRoot, "push", "-q", "origin", opts.branch);
  return { repoRoot, origin, baseSha, headSha };
}

/** Origin's own value for one branch, read through a fresh `ls-remote`. */
export function originSha(origin: string, branch: string): string | undefined {
  const out = gitQuiet(origin, "ls-remote", "--heads", ".", `refs/heads/${branch}`);
  if (out === undefined || out === "") return undefined;
  const [sha = ""] = out.split(/\s+/);
  return sha === "" ? undefined : sha;
}

/** Origin's own value for one ref of any name, read through a fresh `ls-remote`. */
export function originRefSha(origin: string, ref: string): string | undefined {
  const out = gitQuiet(origin, "ls-remote", ".", ref);
  if (out === undefined || out === "") return undefined;
  const [sha = ""] = out.split(/\s+/);
  return sha === "" ? undefined : sha;
}
