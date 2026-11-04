/**
 * lib/ticket-capture — the driver seams the ticket-aware /work assertions read.
 *
 * Both capture the string a CHILD received rather than the argument the driver
 * was handed, which is the only grain that can fail: a call site can drop the
 * body and leave every renderer perfect (the lean half of this branch found
 * exactly that). Split from `test-ticket-aware-review.ts` along the step each
 * helper drives (AGENTS.md §12); the assertions stay with the file that owns the
 * claim, and these take no `assert` — they only produce strings.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../../src/types.ts";
import type { CycleContext } from "../../src/work-driver-context.ts";
import { runLensFix } from "../../src/work-driver-lens-fix.ts";
import { initialState, type WorkState } from "../../src/workflow-state.ts";
import { mkLensSummary } from "../test-helpers.ts";
import { makeFakePi } from "./lens-fix-bound-land-fixture.ts";
import { ISSUE_BODY } from "./ticket-issue-fixture.ts";

/** Scratch dirs created here, for the caller to clean up. */
const ROOTS: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  ROOTS.push(dir);
  return dir;
}

export { tmp };

export function scratchRoots(): readonly string[] {
  return ROOTS;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function runGit(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/** Write a cached issue-body artifact inside `.pi/work-state/` (the only place
 * a reader will accept) and return its repo-relative path, as explore writes it. */
function cachedArtifact(repoRoot: string, issue: number, text: string): string {
  const dir = path.join(repoRoot, ".pi", "work-state");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `issue-body-${String(issue)}.txt`);
  writeFileSync(file, text, "utf8");
  return path.relative(repoRoot, file);
}

/** A local bare "origin" plus a pushed feature branch: the driver's diff reads
 * are `origin/<base>...origin/<head>`, so a local-only commit reads as an empty
 * diff and the step returns before it builds any prompt. */
function initRepo(label: string): string {
  const root = tmp(`ticket-repo-${label}`);
  const originDir = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  runGit(root, ["init", "-q", "--bare", "--initial-branch=main", originDir]);
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["config", "user.email", "t@t"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(path.join(repo, "meter.ts"), "export const draw = () => 1;\n");
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-q", "-m", "base"]);
  runGit(repo, ["remote", "add", "origin", originDir]);
  runGit(repo, ["push", "-q", "-u", "origin", "main"]);
  runGit(repo, ["remote", "set-head", "origin", "main"]);
  runGit(repo, ["checkout", "-q", "-b", "feature/issue-2009"]);
  writeFileSync(
    path.join(repo, "quota.ts"),
    "export const quota = () => { throw new Error('x'); };\n",
  );
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-q", "-m", "feat: quota"]);
  runGit(repo, ["push", "-q", "-u", "origin", "feature/issue-2009"]);
  return repo;
}

export const HEAD_SHA = "0".repeat(40);

/** The one lens-fix dispatch the step makes, captured from `ctx.dispatchFn`. */
export async function captureLensFixPrompts(
  repoRoot: string,
  opts: { resend: boolean; body?: string; findings: string },
): Promise<string[]> {
  const tree = path.join(repoRoot, ".worktrees", "issue-2009");
  mkdirSync(tree, { recursive: true });
  const s = initialState(2009, 1_000_000);
  s.pipelineState.currentStep = "lens-fix";
  s.pipelineState.worktrees = { default: tree };
  s.pipelineState.branchName = "";
  s.pipelineState.reviewRound = 1;
  s.pipelineState.issueBodyArtifact = cachedArtifact(repoRoot, 2009, opts.body ?? ISSUE_BODY);
  const log: WorkState["eventLog"] = [
    {
      kind: "lens-issues-found",
      at: 1_100_000,
      jobId: "j-1",
      round: 1,
      findings: opts.findings,
      verdict: "ISSUES_FOUND",
    },
  ];
  if (opts.resend) {
    log.push({
      kind: "lens-fix-empty-resend",
      at: 1_150_000,
      jobId: "j-2",
      round: 1,
      worktree: tree,
      evidence: "no committed fix",
    } as WorkState["eventLog"][number]);
  }
  const prompts: string[] = [];
  const prevResume = process.env.PI_ENSEMBLE_RESUME;
  process.env.PI_ENSEMBLE_RESUME = "0";
  try {
    const ctx = {
      host: makeFakePi(),
      repoRoot,
      issue: 2009,
      verifyExecFn: async (_cmd: string, o?: { argv?: string[] }) => {
        const a = (o?.argv ?? []).join(" ");
        if (a.includes("rev-parse HEAD")) return { stdout: `${HEAD_SHA}\n` };
        if (a.includes("rev-list")) return { stdout: "0\n" };
        return { stdout: "" };
      },
      dispatchFn: async (_h: unknown, spec: { role: string; prompt: string }) => {
        prompts.push(spec.prompt);
        return {
          role: "developer",
          ok: true,
          text: "done",
          toolUses: [],
          ms: 5,
          exitCode: 0,
          transcriptPath: "/tmp/stub.json",
        } as DispatchResult;
      },
    } as unknown as CycleContext;
    await runLensFix(ctx, { ...s, eventLog: log } as WorkState, 1_200_000);
  } finally {
    // `delete`, never `= undefined`: the env-clear gate reads an assigned
    // string "undefined" on Bun, which is a set variable, not a cleared one.
    if (prevResume === undefined) delete process.env.PI_ENSEMBLE_RESUME;
    else process.env.PI_ENSEMBLE_RESUME = prevResume;
  }
  return prompts;
}

/** The `context` the six lens children were dispatched with, captured at
 * `ctx.lensReviewFn` while `runLens` runs over a real repo and branch. */
export async function captureLensContext(opts: {
  label: string;
  body?: string;
  issues?: number[];
}): Promise<string> {
  const repoRoot = initRepo(opts.label);
  const s = initialState(2009, 1_000_000);
  s.pipelineState.worktrees = { default: repoRoot };
  s.pipelineState.branchName = "feature/issue-2009";
  s.pipelineState.baseSha = undefined;
  if (opts.issues) s.issues = opts.issues;
  if (opts.body !== undefined) {
    s.pipelineState.issueBodyArtifact = cachedArtifact(repoRoot, 2009, opts.body);
  }
  let seen = "";
  const ctx = {
    host: { sendUserMessage: () => undefined },
    repoRoot,
    issue: 2009,
    lensReviewFn: async (a: { context?: string }) => {
      seen = a.context ?? "";
      return mkLensSummary({ verdict: "APPROVED" });
    },
  } as unknown as CycleContext;
  await runLensFromRepo(ctx, s);
  return seen;
}

async function runLensFromRepo(ctx: CycleContext, s: ReturnType<typeof initialState>) {
  const { runLens } = await import("../../src/work-driver-lens.ts");
  await runLens(ctx, s, Date.now());
}

/** A real repo whose mainline commit is readable as `origin/main` — the state
 * the adversarial step needs before it reaches a reviewer at all. */
export function adversarialFixture(label: string): {
  repoRoot: string;
  baseSha: string;
  artifact: string;
} {
  const repoRoot = initRepo(label);
  const artifact = cachedArtifact(repoRoot, 2009, `Meter quota check\n\n${ISSUE_BODY}`);
  return { repoRoot, baseSha: runGit(repoRoot, ["rev-parse", "origin/main"]), artifact };
}

export { initRepo, runGit };
