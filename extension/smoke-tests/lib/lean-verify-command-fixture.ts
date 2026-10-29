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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  /** The `verify.test` template; defaults to `sh {file}`. */
  testTemplate?: string | undefined;
  /** The `verify.fast` tier; defaults to a passing one. */
  fastTier?: string;
  /** Bounds every run, so a hang is observable in seconds. */
  timeoutMs?: number;
}

export interface CommandVerifyRun {
  outcome?: Outcome;
  threw?: Error;
  worktree: string;
  head: string;
}

/** Commit `rel` with `text` in `dir`, as the fixture's identity. */
export function commitFile(dir: string, rel: string, text: string): void {
  const target = path.join(dir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, { mode: 0o755 });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `chore: fixture ${rel}`);
}

/** A shell test that exits 0. */
export const GREEN_FILE = "#!/bin/sh\necho 'ok'\nexit 0\n";
/** A shell test that fails and prints its own basename, exit 1. */
export function redFile(rel: string): string {
  return `#!/bin/sh\necho "FAIL ${path.basename(rel)}: the suite regressed" 1>&2\nexit 1\n`;
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
  const run = { ...createRun({ issue: o.issue, version: "test", models: {}, baseSha, branch }), steps };
  const ctx: HandlerCtx = {
    repoRoot,
    issue: o.issue,
    run,
    steps,
    stepKey: `${o.issue}:verify:0`,
    now: () => 4,
  };

  const exec: VerifyExec = (cmd, opts) =>
    execp(cmd, { ...opts, env: opts?.env ?? gitTestEnv(), cwd: opts?.cwd ?? wt });
  const deps: VerifyDeps = {
    exec,
    loadConfig: async () => ({
      verify: {
        fast: o.fastTier ?? "true",
        test: o.testTemplate === undefined ? "sh {file}" : o.testTemplate,
      },
    }),
    readVerifyCmd: async () => undefined,
    fetchSpecBody: async () => o.specBody,
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  };
  try {
    const { verifyOutcome } = await import("../../src/lean/verify.ts");
    return { outcome: await verifyOutcome(ctx, deps), worktree: wt, head };
  } catch (err) {
    return { threw: err as Error, worktree: wt, head };
  }
}

/** The sha256 of a string's bytes, the way the freeze records them. */
export function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}
