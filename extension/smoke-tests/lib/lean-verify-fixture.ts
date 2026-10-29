/**
 * lib/lean-verify-fixture — the harness the `lean/verify` smoke tests share.
 *
 * `verify`'s claims are git claims plus process-exit claims, so both are real
 * here: a temp git repo whose HEAD holds the frozen acceptance test, real `git`
 * probes, and real `sh` processes for the tiers and the frozen test runs. Only
 * the project's CONFIG is injected — a case that wants a tier to exit 1 must not
 * have to rewrite a commit the frozen records were hashed at to ask for one.
 *
 * This module builds its own repo rather than reusing `lean-build-fixture`'s
 * `buildFixture`, for one reason: that helper checks the run's branch out in
 * `repoRoot` too (`-B`), and a worktree whose HEAD the case moves must hold the
 * branch alone. The shape is otherwise the same — base commit, acceptance-test
 * commit, registered worktree — and the frozen sha256 in the step log is the one
 * the committed blob really hashes to, so the tamper cases have to break a real
 * byte to be red.
 *
 * A case mutates the tree BEFORE the step looks at it — editing a frozen file on
 * disk, committing a rewrite of the frozen blob at HEAD, dropping a stray file —
 * and the step then judges the result. That order is the whole point: `verify`
 * is asked "is this the tree that was frozen?", and the only way to show it
 * reads bytes rather than vibes is to change the bytes.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { type Outcome, type Step, createRun } from "../../src/lean/state.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";
import type { VerifyDeps } from "../../src/lean/verify.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** Temp dirs this module made; the caller removes them at the end of the run. */
export const ROOTS: string[] = [];

/** The implementation the frozen test is red against. */
export const SRC = "export const retry = () => { throw new Error('not implemented'); };\n";
/**
 * The fixture's frozen test. It is RED while `src/DONE` is absent and goes green
 * when the case creates it (`implement: true`) — which is what makes the green
 * case and the red case the same repo with one file between them.
 *
 * The predicate is a file EXISTENCE check, not a `grep` for a marker string:
 * `grep -q "a-b"` proved host-dependent here (measured: GNU grep 3.12 in this
 * container reports no match for a hyphenated literal the file plainly holds,
 * while `grep -c --` on the same bytes matches). A frozen test whose red depends
 * on how one machine's grep parses a dash is not a contract. It names its own
 * path when it fails, which is how `runTestFile` tells a real red from a runner
 * that broke somewhere else.
 */
export const TEST =
  '#!/bin/sh\nif [ ! -f src/DONE ]; then echo "not ok - tests/AC1-retry.test.sh" 1>&2; exit 1; fi\nexit 0\n';
/** A frozen test that passes whatever the source does: a contract nobody wrote. */
export const GREEN_TEST = "#!/bin/sh\nexit 0\n";

/** A tier command that succeeds. */
export const PASS_TIER = "true";
/** A tier command that fails loudly, so a red reason has a tail worth naming. */
export function failTier(marker: string): string {
  return `sh -c 'echo tier-said-${marker} 1>&2; exit 1'`;
}
/** A tier that outlives any bound a test can wait for. */
export const HANG_TIER = "sleep 60";

/**
 * A `verify.test` template whose runner exits non-zero WITHOUT naming the file:
 * the shape `runTestFile` classifies as `unclear`. `sh {file}` cannot produce it
 * (the fixture's test echoes its own path when it fails), so a case that wants
 * to see what an unattributable failure becomes needs this runner instead.
 */
export const SILENT_TEST_RUNNER = "sh silent-runner.sh {file}";

/**
 * A tier that writes `rel` in the worktree, COMMITTING it when `commit` is set.
 *
 * The re-check cases need a tier that disturbs the tree *after* the step has
 * already read it clean: the pre-tier checks pass, the tier runs, and only the
 * post-tier re-check can see what it did.
 */
export function writeTier(rel: string, text: string, commit = false): string {
  const quoted = `'${text.replace(/'/g, "'\\''")}'`;
  const add = commit
    ? " git add -A >/dev/null; git -c user.name=t -c user.email=t@t commit -q -m tier;"
    : "";
  return `sh -c "printf %s ${quoted} > '${rel}';${add} exit 0"`;
}

/**
 * A tier that leaves HEAD on the same commit but on NO branch.
 *
 * `git rev-parse HEAD` still answers the sha the step recorded, so the moved-HEAD
 * re-check cannot see it; only a branch read can. The tier itself runs `git
 * checkout`, which a test fixture's tier script may do — the step's own shell
 * never does.
 */
export const DETACH_TIER = 'sh -c "git checkout -q --detach; exit 0"';

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

export interface VerifyRun {
  outcome?: Outcome;
  threw?: Error;
  worktree: string;
  head: string;
}

export interface VerifyOpts {
  issue: number;
  /** What the project configured; `fast` defaults to a passing tier. */
  config?: Partial<WorkConfig["verify"]>;
  /** Nothing configured at all: the frozen tests alone decide. */
  noCommand?: boolean;
  /** Bounds every tier and frozen-test run, so a hang is observable in seconds. */
  timeoutMs?: number;
  /** Make the worktree dirty before the step looks at it. */
  dirty?: boolean;
  /** Rewrite the frozen file ON DISK, uncommitted, before the step looks. */
  editDisk?: string;
  /** Commit a rewrite of the frozen file at HEAD before the step looks. */
  editAtHead?: string;
  /** Commit the implementation, so the frozen test's own red goes away. */
  implement?: boolean;
  /**
   * A second tier, run after `fast`: the re-check cases use it to rewrite a
   * frozen file, drop an untracked file, or commit, once the tree has already
   * been read clean. The command runs through a shell in the worktree.
   */
  full?: string;
  /**
   * A `verify.test` template whose runner says nothing about the file it was
   * asked to run. The fixture's own `sh {file}` names its path on failure;
   * this is the stand-in for a runner that does not, so a case can observe what
   * an `unclear` proof (silent non-zero exit) becomes.
   */
  silentTestRunner?: boolean;
  /**
   * Make the HEAD read that happens AFTER the tiers reject, while every earlier
   * git call still goes to the real git. That read is the post-tier re-check: a
   * step that cannot re-read HEAD once the tiers have run has not observed a
   * tier moving it — it has failed to read the tree, which is infrastructure.
   */
  recheckHeadFails?: boolean;
  /**
   * Reject the post-tier BRANCH read (`symbolic-ref --short -q HEAD`) while
   * every earlier git call still goes to the real git — the shape a detached
   * HEAD gives, since `-q` exits 1 without printing anything. A read that
   * REJECTS rather than exiting 1 is covered by `recheckHeadFails` for the HEAD
   * read; this one proves the branch read treats git's "detached" exit as an
   * answer and not as a machine that could not reply.
   */
  recheckBranchDetached?: boolean;
  /** Log lines to add after the fixture's own. */
  extraSteps?: Step[];
}

/**
 * Commit the acceptance test in `dir` and return the resulting head. This is the
 * freeze: the sha the step log records is the sha of the bytes this commit holds,
 * so every tamper case has to change a real byte to be red.
 */
function commitFreeze(dir: string, issue: number, text: string): string {
  const target = path.join(dir, "tests", "AC1-retry.test.sh");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, { mode: 0o755 });
  chmodSync(target, 0o755);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `test: acceptance tests for #${issue}`);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * A repo whose HEAD holds the frozen acceptance test, and a registered worktree
 * on the run's branch at that HEAD.
 *
 * The worktree is built first and the branch is handed to it outright, so a case
 * can commit inside the tree — moving the very head the step is about to judge —
 * without git refusing to move a branch `repoRoot` holds.
 */
function fixture(issue: number): {
  repoRoot: string;
  wt: string;
  head: string;
  ctx: HandlerCtx;
} {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-verify-"));
  ROOTS.push(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  const dir = (rel: string) => path.join(repoRoot, rel);
  mkdirSync(dir("src"), { recursive: true });
  mkdirSync(dir("tests"), { recursive: true });
  writeFileSync(dir("src/retry.ts"), SRC);
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  const baseSha = git(repoRoot, "rev-parse", "HEAD");
  const branch = `lean/issue-${issue}`;
  git(repoRoot, "checkout", "-q", "main");
  // The worktree is created BEFORE the freeze commit and the branch is handed to
  // it outright, so a case that commits inside the tree moves a head nothing
  // else holds. `--no-checkout` + a hand-written checkout is how git is told to
  // put the branch on a tree without also checking it out in `repoRoot`.
  const wt = path.join(repoRoot, ".worktrees", `lean-${issue}`);
  git(repoRoot, "worktree", "add", "-q", "-B", branch, wt, baseSha);
  const head = commitFreeze(wt, issue, TEST);

  const run = createRun({ issue, version: "test", models: {}, baseSha, branch });
  const steps: Step[] = [
    { key: `${issue}:ready:0`, state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    {
      key: `${issue}:specify:0`,
      state: "specify",
      startedAt: 2,
      outcome: {
        kind: "ok",
        frozen: { "tests/AC1-retry.test.sh": sha(TEST) },
        tests: { AC1: ["tests/AC1-retry.test.sh"] },
      },
    },
  ];
  const withSteps = { ...run, steps };
  return {
    repoRoot,
    wt,
    head,
    ctx: {
      repoRoot,
      issue,
      run: withSteps,
      steps,
      stepKey: `${issue}:verify:0`,
      now: () => 4,
    },
  };
}

/** The sha256 of a string's bytes, the way the freeze records them. */
export function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Run `verify` against a fixture repo; a throw comes back as `threw`. */
export async function runVerify(opts: VerifyOpts): Promise<VerifyRun> {
  const f = fixture(opts.issue);
  const wt = f.wt;

  if (opts.implement === true && opts.editDisk === undefined) {
    // The green cases COMMIT their work, so the tree the step judges is clean.
    writeFileSync(path.join(wt, "src/DONE"), "done\n");
    git(wt, "add", "src/DONE");
    commitHere(wt, "feat: implemented the retry helper");
  }
  if (opts.editAtHead !== undefined) {
    // The freeze is the fixture's own commit, hashed into the log's record; this
    // rewrite lands AFTER it, so HEAD's blob no longer matches the record while
    // the working tree stays clean. Only a read of the commit can see it.
    writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), opts.editAtHead, { mode: 0o755 });
    chmodSync(path.join(wt, "tests/AC1-retry.test.sh"), 0o755);
    commitHere(wt, "chore: rewrote the frozen test after the freeze");
  }
  if (opts.editDisk !== undefined) {
    // The on-disk tamper case: the frozen file is edited and NOTHING else is
    // dirty, so the only thing standing between this run and a tier pass is the
    // on-disk comparison. The marker the contract asks for is committed here —
    // uncommitted, it would trip the clean-tree refusal before the tamper was
    // ever reached, and the case would prove nothing.
    if (opts.implement === true) {
      writeFileSync(path.join(wt, "src/DONE"), "done\n");
      commitHere(wt, "feat: implemented the retry helper");
    }
    writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), opts.editDisk, { mode: 0o755 });
  }
  if (opts.dirty === true) writeFileSync(path.join(wt, "notes.txt"), "a stray file\n");

  const head = git(wt, "rev-parse", "HEAD");
  const RECHECK_ARGV = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "rev-parse",
    "HEAD",
  ];
  let tierRan = false;
  const BRANCH_ARGV = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ];
  if (opts.silentTestRunner === true) {
    // Committed before `head` is read: the step refuses a dirty tree before it
    // ever runs a test, so a helper left untracked would trip that first, and
    // the frozen file itself is untouched, so no tamper is mistaken for this.
    writeFileSync(path.join(wt, "silent-runner.sh"), "exit 1\n");
    commitHere(wt, "chore: fixture runner that never names the file it ran");
  }
  // The log's frozen record is the bytes the FREEZE committed. A case that
  // rewrote the file on disk or at HEAD afterwards faces a record that no
  // longer matches, which is exactly the tamper the step must catch.
  const all = opts.extraSteps === undefined ? f.ctx.steps : [...f.ctx.steps, ...opts.extraSteps];
  const ctx: HandlerCtx = { ...f.ctx, steps: all };
  ctx.run = { ...ctx.run, steps: all };

  const exec: VerifyExec = (cmd, o) => {
    // The tier command is the marker between the step's pre-tier reads and its
    // post-tier re-checks; only the HEAD read on the far side of it goes quiet.
    if (cmd !== "git" && cmd !== "sh") tierRan = true;
    if (
      opts.recheckHeadFails === true &&
      cmd === "git" &&
      String(o?.argv ?? []) === String(RECHECK_ARGV) &&
      tierRan
    )
      return Promise.reject(new Error("git: fatal: unable to read HEAD"));
    if (
      opts.recheckBranchDetached === true &&
      cmd === "git" &&
      String(o?.argv ?? []) === String(BRANCH_ARGV) &&
      tierRan
    )
      return Promise.resolve({ stdout: "", stderr: "" });
    return execp(cmd, { ...o, env: o?.env ?? gitTestEnv(), cwd: o?.cwd ?? wt });
  };

  const configured = opts.noCommand === true ? {} : (opts.config ?? { fast: PASS_TIER });
  if (opts.full !== undefined) configured.full = opts.full;
  const deps: VerifyDeps = {
    exec,
    loadConfig: async () => ({
      verify: {
        test: opts.silentTestRunner === true ? SILENT_TEST_RUNNER : "sh {file}",
        ...configured,
      },
    }),
    readVerifyCmd: async () => undefined,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };
  try {
    const { verifyOutcome } = await import("../../src/lean/verify.ts");
    return { outcome: await verifyOutcome(ctx, deps), worktree: wt, head };
  } catch (err) {
    return { threw: err as Error, worktree: wt, head };
  }
}

/** Commit everything in `dir`, as the fixture's identity. */
function commitHere(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

export interface HandbackPost {
  repoRoot: string;
  issue: number;
  body: string;
}

/** A HandlerCtx for a handback case, carrying the log the case asked for. */
export function handbackCtx(
  issue: number,
  steps: Step[],
  repoRoot = "/tmp/lean-handback-repo",
): HandlerCtx {
  const run = createRun({
    issue,
    version: "test",
    models: {},
    baseSha: "a".repeat(40),
    branch: `lean/issue-${issue}`,
  });
  const withSteps = { ...run, steps };
  return {
    repoRoot,
    issue,
    run: withSteps,
    steps: withSteps.steps,
    stepKey: `${issue}:handback:0`,
    now: () => 5,
  };
}

/**
 * A fixture in the state `verify` expects, for the wiring tests: the real repo,
 * the real registered worktree, and a HandlerCtx whose step log froze the test.
 * Nothing runs, so the case can call a handler directly and watch it refuse.
 */
export function buildFixtureForWiring(issue: number): {
  repoRoot: string;
  wt: string;
  ctx: HandlerCtx;
} {
  const f = fixture(issue);
  return { repoRoot: f.repoRoot, wt: f.wt, ctx: f.ctx };
}

/** A decided step for the handback cases. */
export function decided(state: Step["state"], outcome: Outcome, n = 0): Step {
  return { key: `7:${state}:${n}`, state, startedAt: 1, endedAt: 2, outcome };
}

/**
 * A publish step that recorded its PR the only sanctioned way: `prUrl`.
 * `url`/`htmlUrl` are the fields the old guess list read, and a step that
 * reaches for one of them is refused by `state.ts` on load.
 *
 * `issue` names the branch the step belongs to, so a hand-built log can carry a
 * publish step whose `prUrl` the handback under test would print for that run.
 */
export function publishStep(
  url: string,
  field: "prUrl" | "url" | "htmlUrl" = "prUrl",
  issue?: number,
): Step {
  const outcome = { kind: "ok", ...(field === "prUrl" ? { prUrl: url } : { [field]: url }) };
  return decided("publish", outcome as Outcome, issue ?? 7);
}

/** The log a run carries when it reaches handback after its gate said red. */
export function redLog(prUrl?: string): Step[] {
  const steps: Step[] = [
    decided("ready", { kind: "ok" }),
    decided("specify", {
      kind: "ok",
      frozen: { "tests/AC1-retry.test.sh": "a".repeat(64) },
      tests: { AC1: ["tests/AC1-retry.test.sh"] },
    }),
    decided("build", { kind: "ok", reason: "1 file(s) changed" }),
    decided("verify", {
      kind: "red",
      reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
    }),
  ];
  if (prUrl !== undefined) steps.push(decided("publish", { kind: "ok", prUrl } as Outcome));
  return steps;
}
