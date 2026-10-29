/**
 * lib/lean-verify-command-fixture — the harness the `command` criteria tier's
 * smoke test drives.
 *
 * `runVerify` from `lean-verify-fixture.ts` injects only the project CONFIG, and
 * the `command` tier needs three more seams: the issue body the spec comes from,
 * a file committed at HEAD after the freeze, and the exact runner template. This
 * module builds the same repo shape (base commit, frozen acceptance test, a
 * registered worktree on the run's branch) and adds them, so the tier is driven
 * through the real `verifyOutcome` with real git and real processes — nothing
 * about the tier is stubbed.
 *
 * The frozen record is written from the bytes the freeze commit really holds, so
 * a case that adds a command file afterwards is not mistaken for a tampered
 * contract: only the case's own file moves, and it moves by commit, so the tree
 * is clean when the step reads it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";
import type { VerifyDeps } from "../../src/lean/verify.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** Temp dirs this module made; the caller removes them at the end of the run. */
export const ROOTS: string[] = [];

export const SRC = "export const retry = () => { throw new Error('not implemented'); };\n";
/** The frozen test: red while `src/DONE` is absent, and it names its own path. */
export const TEST =
  '#!/bin/sh\nif [ ! -f src/DONE ]; then echo "not ok - tests/AC1-retry.test.sh" 1>&2; exit 1; fi\nexit 0\n';

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

export interface CommandVerifyOpts {
  issue: number;
  /** The issue body carrying the `pi-spec v1` block. */
  specBody: string;
  /** Commit the implementation so the frozen test is green. */
  implement?: boolean;
  /** Files to commit at HEAD before the step judges the tree. */
  files?: Record<string, string>;
  /**
   * Files to commit into the BASE commit, before the worktree branches from it.
   * A `command` criterion names a test the base already held, so this is where a
   * runnable one's file has to be written.
   */
  baseFiles?: Record<string, string>;
  /**
   * Committed SYMLINKS at HEAD: `rel -> target`. Mode 120000, which is exactly
   * the shape the base check must refuse — a plain existence probe follows the
   * link and finds a file, so the gate used to execute it.
   */
  links?: Record<string, string>;
  /**
   * The same, in the BASE commit. A symlink whose base entry is a symlink is
   * caught by the very first check the tier makes, which is the reproduction of
   * the shipped bug: the file "existed" at both ends and got executed.
   */
  baseLinks?: Record<string, string>;
  /** Extra `git commit` messages, in order, to add at HEAD after `files`. */
  commits?: string[];
  /** The `verify.test` template; defaults to `sh {file}`. */
  testTemplate?: string | undefined;
  /**
   * The `verify.fast` tier; defaults to a passing one. The compiler canary is
   * attached to the tiers, so a case that wants the tier to run an unusual command
   * must know whether that command looks like a pinned compiler.
   */
  fastTier?: string;
  /** Bounds every run, so a hang is observable in seconds. */
  timeoutMs?: number;
  /**
   * Runs AFTER the fixture's own commits, against the worktree. Used to build a
   * shape no commit option expresses — a test edited or deleted at HEAD, or the
   * command file written by a runner that must not have run.
   */
  mutate?: (wt: string) => void;
  /**
   * Make one git call settle early, or reject it — the seam for "the machine
   * could not answer" and for a read that must not reach the real git.
   * Return `undefined` to let the call through.
   */
  execOver?: (
    cmd: string,
    opts: Parameters<VerifyExec>[1],
  ) => Promise<{ stdout: string; stderr?: string } | undefined>;
  /**
   * Reject the issue-body read, so the case can ask what an unreadable spec does
   * to a verdict (it is infrastructure, and it throws — see (e2)).
   */
  specFetchThrows?: boolean;
}

export interface CommandVerifyRun {
  outcome?: Outcome;
  threw?: Error;
  worktree: string;
  head: string;
  /** The run's base commit — the tree a command criterion's file must sit in. */
  baseSha: string;
}

/** Commit `rel` with `text` in `dir`, as the fixture's identity. */
export function commitFile(dir: string, rel: string, text: string): void {
  const target = path.join(dir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, { mode: 0o755 });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `chore: fixture ${rel}`);
}

/**
 * Commit `rel` as a symlink to `target` (mode 120000), and make sure git records
 * it as a link rather than the target's bytes.
 *
 * `core.symlinks=false` would check the link out as a plain text file holding the
 * target, which is a different test than the one being pinned; the assert below
 * refuses to let the fixture quietly degrade into that.
 */
export function commitSymlink(dir: string, rel: string, target: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  rmSync(abs, { force: true });
  symlinkSync(target, abs);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `chore: fixture link ${rel}`);
  if (!git(dir, "ls-tree", "HEAD", "--", rel).startsWith("120000 "))
    throw new Error(`fixture could not commit ${rel} as a symlink (mode 120000)`);
}

/** Overwrite `rel` in `dir` and commit the change — the 'edited since base' shape. */
export function commitEdit(dir: string, rel: string, text: string): void {
  writeFileSync(path.join(dir, rel), text, { mode: 0o755 });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `chore: fixture edit ${rel}`);
}

/** Remove `rel` from the worktree and the index, committing the deletion. */
export function commitDelete(dir: string, rel: string): void {
  rmSync(path.join(dir, rel), { force: true });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `chore: fixture delete ${rel}`);
}

/** A shell test that exits 0. */
export const GREEN_FILE = "#!/bin/sh\necho 'ok'\nexit 0\n";

/**
 * The runner the self-rewriting case configures, as `sh self-rewrite.sh <test> <test>`.
 *
 * It runs the test (so the criterion really executed) and then overwrites the file
 * with different bytes while exiting 0 — the shape only a post-run re-read can
 * catch. A `verify.test` template may carry no shell metacharacter, so the
 * redirection lives in a committed helper rather than in the template itself.
 */
export const SELF_REWRITER =
  "#!/bin/sh\nif [ -n \"$2\" ]; then printf 'rewritten by the run\\n' > \"$2\"; fi\nexit 0\n";
/** A shell test that fails and prints its own basename, exit 1. */
export function redFile(rel: string): string {
  return `#!/bin/sh\necho "FAIL ${path.basename(rel)}: the suite regressed" 1>&2\nexit 1\n`;
}

/**
 * A shell test that kills itself. The runner exits on a SIGNAL with no status, and
 * `runTestFile` classifies that as `kind: "infra"` — nobody observed the test, so
 * the gate must throw rather than record a verdict about it.
 *
 * `path` is in the output because a non-zero exit whose output never named the file
 * is a red; the killed path throws regardless, and the name keeps the two cases
 * distinguishable in the failure message.
 */
export function killedFile(rel: string): string {
  return `#!/bin/sh\necho "runner died on ${path.basename(rel)}" 1>&2\nkill $$\n`;
}

/** Remove every temp repo this module made. Called by the suite that uses it. */
export function cleanupRoots(): void {
  for (const dir of ROOTS) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort: the OS reaps the temp root; a leak here is noise, not a failure.
    }
  }
  ROOTS.length = 0;
}

/** The `pi-spec v1` block for the given criteria. */
export function bodyWith(
  criteria: { id: string; text: string; verify: string; command?: string }[],
): string {
  return "```pi-spec v1\n".concat(
    JSON.stringify({
      problem: "the retry helper gives up on the first transient failure",
      criteria,
      size: "S",
    }),
    "\n```",
  );
}

/**
 * Build the repo, run the real `verifyOutcome`, and hand back the verdict or the
 * throw — never both, never neither.
 */
export async function runCommandVerify(o: CommandVerifyOpts): Promise<CommandVerifyRun> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-verify-cmd-"));
  ROOTS.push(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  const dir = (rel: string) => path.join(repoRoot, rel);
  mkdirSync(dir("src"), { recursive: true });
  writeFileSync(dir("src/retry.ts"), SRC);
  // Base-commit files first: `baseSha` is read after this commit, so a command
  // criterion's test can be made to exist at base without any later commit moving
  // the base out from under the run's record.
  for (const [rel, text] of Object.entries(o.baseFiles ?? {})) {
    const target = dir(rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, { mode: 0o755 });
  }
  for (const [rel, target] of Object.entries(o.baseLinks ?? {})) {
    const abs = dir(rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    rmSync(abs, { force: true });
    symlinkSync(target, abs);
  }
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  const baseSha = git(repoRoot, "rev-parse", "HEAD");
  const branch = `lean/issue-${o.issue}`;
  const wt = path.join(repoRoot, ".worktrees", `lean-${o.issue}`);
  git(repoRoot, "worktree", "add", "-q", "-B", branch, wt, baseSha);

  // The freeze: the log's sha is the sha of the bytes this commit holds.
  commitFile(wt, "tests/AC1-retry.test.sh", TEST);
  if (o.implement === true) {
    commitFile(wt, "src/DONE", "done\n");
  }
  for (const [rel, text] of Object.entries(o.files ?? {})) commitFile(wt, rel, text);
  for (const [rel, target] of Object.entries(o.links ?? {})) commitSymlink(wt, rel, target);
  for (const message of o.commits ?? []) git(wt, "commit", "-q", "--allow-empty", "-m", message);
  o.mutate?.(wt);
  const head = git(wt, "rev-parse", "HEAD");

  const steps: Step[] = [
    { key: `${o.issue}:ready:0`, state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    {
      key: `${o.issue}:specify:0`,
      state: "specify",
      startedAt: 2,
      outcome: {
        kind: "ok",
        frozen: { "tests/AC1-retry.test.sh": sha(TEST) },
        tests: { AC1: ["tests/AC1-retry.test.sh"] },
      },
    },
  ];
  const run = {
    ...createRun({ issue: o.issue, version: "test", models: {}, baseSha, branch }),
    steps,
  };
  const ctx: HandlerCtx = {
    repoRoot,
    issue: o.issue,
    run,
    steps,
    stepKey: `${o.issue}:verify:0`,
    now: () => 4,
  };

  const exec: VerifyExec = (cmd, opts) => {
    const over = o.execOver?.(cmd, opts);
    if (over !== undefined)
      return over.then(
        (r) => r ?? execp(cmd, { ...opts, env: opts?.env ?? gitTestEnv(), cwd: opts?.cwd ?? wt }),
      );
    return execp(cmd, { ...opts, env: opts?.env ?? gitTestEnv(), cwd: opts?.cwd ?? wt });
  };
  const deps: VerifyDeps = {
    exec,
    loadConfig: async () => ({
      verify: {
        fast: o.fastTier ?? "true",
        test: o.testTemplate === undefined ? "sh {file}" : o.testTemplate,
      },
    }),
    readVerifyCmd: async () => undefined,
    fetchIssueBody: async () => {
      if (o.specFetchThrows === true) throw new Error("gh: could not reach the host");
      return o.specBody;
    },
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  };
  try {
    const { verifyOutcome } = await import("../../src/lean/verify.ts");
    return { outcome: await verifyOutcome(ctx, deps), worktree: wt, head, baseSha };
  } catch (err) {
    return { threw: err as Error, worktree: wt, head, baseSha };
  }
}

/** The sha256 of a string's bytes, the way the freeze records them. */
export function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}
