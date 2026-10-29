#!/usr/bin/env bun
/**
 * lean/specify — the step proven against a REAL temp git repository.
 *
 * The step's claims are git claims ("this file is the only thing that
 * changed", "this commit contains exactly these tests"), so a stub exec would
 * test the stub. Here the repo, the base commit and the worktree are real,
 * `exec` shells out to the real `execp`, and only the model is a stub: the
 * fake dispatch writes files into the worktree and returns the `submit_tests`
 * tool calls the child would have made.
 *
 * Seven cases, one per decision the step makes:
 *   (a) a red test plus a stray non-test edit -> ok, edit reverted, hashes and
 *       commit contents correct;
 *   (b) a test green on base -> no-red-test naming its criterion;
 *   (c) a runner that says `Cannot find module` -> THROW (infra, never a verdict);
 *   (d) a submit for an unknown criterion -> dropped, and that criterion ends uncovered;
 *   (e) no `verify.test` configured -> no-red-test with the runner rule;
 *   (f) a dirty leftover worktree -> reset to base before the child is asked;
 *   (g) a dispatch that did not succeed -> THROW.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import type { WorkConfig } from "../src/lean/config.ts";
import { defaultConfig } from "../src/lean/config.ts";
import type { HandlerCtx } from "../src/lean/engine.ts";
import { parsePorcelainZ } from "../src/lean/specify-tree.ts";
import { type SpecifyDeps, SpecifyInfraError } from "../src/lean/specify.ts";
import type { Outcome } from "../src/lean/state.ts";
import { createRun } from "../src/lean/state.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "../src/lean/submit-tests-reporter.ts";
import type { DispatchResult, DispatchSpec } from "../src/types.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOTS: string[] = [];

/**
 * The identity every git child of this test runs with.
 *
 * Set in the ENVIRONMENT rather than with `-c` on the fixture's own calls,
 * because the commit under test is made by the PRODUCTION step (`git commit`
 * through the injected exec), which takes no flags from here — and a CI
 * container with no global identity would fail exactly that commit while the
 * fixture's own commits went through. `gitTestEnv()` supplies the isolated
 * HOME, so the host's gitconfig is not what fills these in.
 */
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
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** A repo whose single commit contains `files`; returns its root and base sha. */
function makeRepo(files: Record<string, string>): { repoRoot: string; baseSha: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-specify-"));
  ROOTS.push(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(repoRoot, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  return { repoRoot, baseSha: git(repoRoot, "rev-parse", "HEAD") };
}

const SPEC = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S" as const,
  criteria: [
    {
      id: "AC1",
      text: "retries a transient failure twice before failing",
      verify: "test" as const,
    },
    { id: "AC2", text: "documents the retry budget", verify: "manual" as const },
  ],
};

const BODY = `\`\`\`pi-spec v1\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``;

function configWith(verify: WorkConfig["verify"]): WorkConfig {
  return { ...defaultConfig(), verify };
}

function ctxFor(repoRoot: string, baseSha: string, issue: number): HandlerCtx {
  const run = createRun({ issue, version: "test", models: {}, baseSha, branch: "" });
  return { repoRoot, issue, run, steps: run.steps, stepKey: `${issue}:specify:0`, now: () => 1 };
}

function okResult(toolUses: unknown[]): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses, ms: 1, exitCode: 0 };
}

function submit(criterionId: string, testFiles: string[]): unknown {
  return { name: "submit_tests", arguments: { criterionId, testFiles } };
}

/** Every path the worktree reports against its base. */
async function worktreePaths(wt: string): Promise<string[]> {
  const { stdout } = await execp("git", {
    argv: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: wt,
  });
  return parsePorcelainZ(stdout).map((e) => e.path);
}

/** Run the step; a throw comes back as the error, so each case asserts on it. */
async function runSpecify(opts: {
  repoRoot: string;
  baseSha: string;
  issue: number;
  config: WorkConfig;
  writes: (wt: string) => void;
  toolUses: unknown[];
  dispatchOk?: boolean;
}): Promise<{ outcome?: Outcome; threw?: Error; sawBaseHealthy: boolean; worktree?: string }> {
  const issue = opts.issue;
  let sawBaseHealthy = false;
  const exec: SpecifyDeps["exec"] = async (cmd, o) => {
    if (cmd === opts.config.verify.fast) sawBaseHealthy = true;
    // The identity is in the env for EVERY exec, including the production
    // commit the freeze makes — that commit is the thing under test.
    return execp(cmd, { ...o, env: { ...gitEnv(), ...(o?.env ?? {}) } });
  };
  const dispatch: SpecifyDeps["dispatch"] = async (spec: DispatchSpec) => {
    const wt = spec.cwd as string;
    opts.writes(wt);
    return opts.dispatchOk === false
      ? { ...okResult(opts.toolUses), ok: false, exitCode: 1 }
      : okResult(opts.toolUses);
  };
  const deps: SpecifyDeps = {
    exec,
    dispatch,
    fetchIssueBody: async () => BODY,
    loadConfig: async () => opts.config,
    now: () => 1,
    statReporter: async () => ({}),
  };
  try {
    const outcome = await (await import("../src/lean/specify.ts")).specifyOutcome(
      ctxFor(opts.repoRoot, opts.baseSha, issue),
      deps,
    );
    return {
      outcome,
      sawBaseHealthy,
      worktree: path.join(opts.repoRoot, ".worktrees", `lean-${issue}`),
    };
  } catch (err) {
    return { threw: err as Error, sawBaseHealthy };
  }
}

const RUNNER = "sh {file}";

/** A test script that exits 1 and echoes its own name (a genuine red). */
/**
 * A test file that fails for the behaviour the criterion states, and whose
 * output names the FILE — which is what the step's `red` classification asks
 * for ("non-zero AND the output named this file"). A real runner prints the
 * file it is reporting on; a bare `echo` of a message that happens to contain
 * the basename would satisfy the check for the wrong reason, so this asserts
 * on the mechanism instead: the runner's own line for the file.
 */
function redScript(): string {
  return [
    "#!/bin/sh",
    'echo "not ok - $(basename "$0")" 1>&2',
    'echo "assertion failed: retry gave up on the first transient failure" 1>&2',
    "exit 1",
    "",
  ].join("\n");
}

{
  // The runner's own contract, checked before it is load-bearing below: the
  // template `sh {file}` must read as executable `sh` plus the file argument.
  const { renderTestCommand } = await import("../src/lean/specify-proof.ts");
  const rendered = renderTestCommand(RUNNER, "tests/AC1-retry.test.sh");
  assert(
    rendered === "sh tests/AC1-retry.test.sh",
    `(a) the runner template renders to one command (got ${rendered})`,
  );
}

// --------------------------------------------------------------- (a) the ok path
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const toolUses = [submit("AC1", ["tests/AC1-retry.test.sh"])];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 1,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
      // The stray edit the step must revert, and the stray file it must delete.
      writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => { fix(); };\n");
      writeFileSync(path.join(wt, "NOTES.md"), "I also wrote this\n");
    },
    toolUses,
  });
  const wt = r.worktree ?? "";
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(a) ok, got ${r.outcome?.kind}`);
  assert(r.sawBaseHealthy, "(a) the fast verify tier ran before any red was trusted");
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === "tests/AC1-retry.test.sh",
    `(a) frozen holds exactly the kept test (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  const expected = createHash("sha256").update(redScript()).digest("hex");
  assert(
    r.outcome?.frozen?.["tests/AC1-retry.test.sh"] === expected,
    `(a) frozen carries the file's sha256 (got ${r.outcome?.frozen?.["tests/AC1-retry.test.sh"]})`,
  );
  assert(
    JSON.stringify(r.outcome?.tests) === JSON.stringify({ AC1: ["tests/AC1-retry.test.sh"] }),
    `(a) tests maps the criterion to its file (got ${JSON.stringify(r.outcome?.tests)})`,
  );
  assert(
    git(wt, "status", "--porcelain", "-uall") === "",
    "(a) the stray edit and stray file are reverted: the worktree is clean",
  );
  assert(
    git(wt, "show", "HEAD:src/retry.ts") === "export const retry = () => {};",
    "(a) the non-test edit did not survive into the commit",
  );
  assert(
    git(wt, "show", "--name-only", "--format=", "HEAD") === "tests/AC1-retry.test.sh",
    `(a) the commit contains exactly the test file (got ${git(wt, "show", "--name-only", "--format=", "HEAD").replace(/\n/g, ", ")})`,
  );
  assert(
    git(wt, "log", "--format=%s", "-1").startsWith("test: acceptance tests for #1"),
    `(a) commit subject names the issue (got ${git(wt, "log", "--format=%s", "-1")})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("reverted 2 undeclared path"),
    `(a) the reason records what was reverted (got ${r.outcome?.reason})`,
  );
}

// ----------------------------------------------------- (b) green on base is refused
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 2,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-green.test.sh"), "#!/bin/sh\necho ok\nexit 0\n", {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", ["tests/AC1-green.test.sh"])],
  });
  assert(r.threw === undefined, "(b) no throw for an unred test — it is a verdict, not infra");
  assert(r.outcome?.kind === "no-red-test", `(b) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.failedRules ?? []).some((x) => x.includes("AC1")),
    `(b) the rule names the uncovered criterion (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(
    !existsSync(path.join(repoRoot, ".worktrees", "lean-2", "tests", "AC1-green.test.sh")) ||
      (r.outcome?.reason ?? "").includes("exited 0"),
    "(b) the reason records the green file it dropped",
  );
}

// ---------------------------------------------------------- (c) infra looks like infra
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 3,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(
        path.join(wt, "tests/AC1-missing.test.sh"),
        "#!/bin/sh\necho \"error: Cannot find module 'bun'\" 1>&2\nexit 1\n",
        { mode: 0o755 },
      );
    },
    toolUses: [submit("AC1", ["tests/AC1-missing.test.sh"])],
  });
  assert(
    r.threw instanceof SpecifyInfraError,
    `(c) missing dependencies THROW (infra), not a verdict — got ${
      r.threw === undefined ? `outcome ${r.outcome?.kind}` : r.threw.constructor.name
    }`,
  );
}

// ---------------------------------------------- (d) an unknown criterion is dropped
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 4,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      // A red file — for a criterion the spec does not have.
      writeFileSync(path.join(wt, "tests/AC99-other.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC99", ["tests/AC99-other.test.sh"])],
  });
  assert(r.threw === undefined, "(d) no throw");
  assert(r.outcome?.kind === "no-red-test", `(d) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.failedRules ?? []).some((x) => x.includes("AC1")),
    `(d) AC1 is reported uncovered (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("not a test criterion") ||
      (r.outcome?.reason ?? "").includes("unknown criterion"),
    `(d) the reason says why AC99 was dropped (got ${r.outcome?.reason})`,
  );
  assert(
    Object.keys(r.outcome?.frozen ?? {}).length === 0,
    "(d) nothing is frozen for an unknown criterion",
  );
}

// ------------------------------------------------- (e) no runner configured at all
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 5,
    config: configWith({}),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(r.threw === undefined, "(e) no throw");
  assert(r.outcome?.kind === "no-red-test", `(e) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.failedRules ?? []).some((x) => x.includes("no test runner configured")),
    `(e) the runner rule is named (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
}

// -------------------------------------------- (f) a dirty leftover worktree is reset
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "tracked\n" });
  const wt = path.join(repoRoot, ".worktrees", "lean-6");
  git(repoRoot, "worktree", "add", "-q", "--detach", wt, baseSha);
  writeFileSync(path.join(wt, "src/a.ts"), "TRAMPLED BY A DEAD CHILD\n");
  mkdirSync(path.join(wt, "junk"), { recursive: true });
  writeFileSync(path.join(wt, "junk/leftover.ts"), "from the crashed run\n");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 6,
    config: configWith({ test: RUNNER }),
    writes: (wt2) => {
      // The step must have reset the tree BEFORE this child was asked.
      assert(
        git(wt2, "show", "HEAD:src/a.ts") === "tracked",
        "(f) on entry the worktree is back at the base",
      );
      assert(
        !existsSync(path.join(wt2, "junk/leftover.ts")),
        "(f) on entry the dead child's untracked file is gone",
      );
      assert(
        git(wt2, "status", "--porcelain", "-uall") === "",
        "(f) on entry the worktree is clean",
      );
      mkdirSync(path.join(wt2, "tests"), { recursive: true });
      writeFileSync(path.join(wt2, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(r.threw === undefined, `(f) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(f) ok after the reset, got ${r.outcome?.kind}`);
}

// ------------------------------------------------------- (g) a dead dispatch throws
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 7,
    config: configWith({ test: RUNNER }),
    writes: () => {},
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
    dispatchOk: false,
  });
  assert(
    r.threw instanceof SpecifyInfraError,
    `(g) a dispatch that did not succeed THROWS — got ${
      r.threw === undefined ? `outcome ${r.outcome?.kind}` : r.threw.constructor.name
    }`,
  );
}

// -------------------------------------------------- the reporter path is a real file
assert(existsSync(SUBMIT_TESTS_REPORTER_PATH), "the submit_tests reporter exists on disk");

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
