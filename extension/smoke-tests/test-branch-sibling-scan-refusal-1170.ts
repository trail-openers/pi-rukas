#!/usr/bin/env bun
/**
 * #1170 — an unreadable `git worktree list` during the branch step's sibling
 * scan REFUSES the cycle (step-failed:branch → handoff). It must never fall
 * through to the LLM ops fallback, which would create the worktree unscanned.
 * Also pins the ref charset `assertSafeRef` accepts (`_`, `+`) and rejects
 * shell metacharacters.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import { assertSafeRef } from "../src/worktree-loss.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1170-sibling-"));
const TITLE = "sibling scan refusal";
const TITLE_ARTIFACT = path.join(root, "issue-title.txt");
writeFileSync(TITLE_ARTIFACT, `title: ${TITLE}\n`);

try {
  // ---- branch step with an unreadable worktree listing
  const originDir = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  let dispatches = 0;
  const execFn: ExecFn = async (cmd, o) => {
    if (cmd.startsWith("gh ")) return { stdout: "[]" };
    if (cmd.startsWith("git fetch")) return { stdout: "" };
    if (cmd.includes("worktree list")) throw new Error("git: unable to read worktree list");
    return realExec(cmd, o);
  };
  const ctx = {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture
    host: {} as any,
    issue: 1170,
    issues: [1170],
    restart: true,
    repoRoot: repo,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn: async () => {
      dispatches++;
      return { role: "ops", ok: true, text: "noop", toolUses: [], ms: 0, exitCode: 0 };
    },
  } as unknown as DriverContext;
  const st = initialState(1170);
  st.pipelineState.issueBodyArtifact = TITLE_ARTIFACT;

  const out = await runBranch(ctx, st, 1000).catch((e) => {
    console.error(`runBranch threw: ${(e as Error).message}`);
    return undefined;
  });
  const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap !== undefined && cap.kind === "cap-hit" && cap.cap === "step-failed:branch",
    "an unreadable sibling listing yields a step-failed:branch cap",
  );
  assert(
    cap !== undefined && cap.kind === "cap-hit" && cap.nextStep === "handoff",
    "the refusal routes to handoff",
  );
  assert(dispatches === 0, "no LLM ops dispatch runs after the refusal (no unscanned creation)");

  // ---- ref charset
  for (const ok of ["fix/issue_12", "feature/a+b", "release/1.2.3", "feature/x-y@{1}"]) {
    let threw = false;
    try {
      assertSafeRef(ok);
    } catch {
      threw = true;
    }
    assert(!threw, `assertSafeRef accepts ${ok}`);
  }
  for (const bad of ["feature/x;rm -rf /", "a$(id)", "a`id`", "a b", "-x"]) {
    let threw = false;
    try {
      assertSafeRef(bad);
    } catch {
      threw = true;
    }
    assert(threw, `assertSafeRef rejects ${JSON.stringify(bad)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
