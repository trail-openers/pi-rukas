#!/usr/bin/env bun
/**
 * #1362 — the configured `.pi/dirty-root-exempt` list, exercised against REAL
 * git through the production branch step. Companion to
 * `test-repo-root-residue-poisoning.ts`, which owns the #746/#741 poisoning
 * sequence; this file exists because the file-size gate keeps that file's
 * story about one bug, not two.
 *
 * Both cases run the real branch step on a real repo, so the answer comes from
 * `git status --porcelain -uall` and not from a fixture's idea of what
 * porcelain looks like:
 *
 *   5. A tool's own local file (`.claude/settings.local.json`, UNTRACKED)
 *      blocks the branch step with no config — the bug — and blocks nothing
 *      once the project lists `.claude/`. The built-in set is untouched: the
 *      same fixture with no config still blocks, so the exemption is additive.
 *   6. The exemption is UNTRACKED-only. The very same path, as a MODIFIED
 *      tracked file or as the destination of a `git mv`, still blocks with the
 *      list in place: hiding real uncommitted source is exactly what the
 *      Settlement forbids.
 *
 * The pure parser and the prefix matcher are covered by
 * `test-dirty-root-exempt-config.ts`; the preflight / integrate / staging
 * consumers by `test-work-driver-integrate-realgit.ts` (its E4 block).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import type { ExecFn } from "../src/worktree.ts";
import { realExec } from "./lib/exec-fake.ts";
import { gitTestEnv, isolateGitEnv } from "./lib/git-test-env.ts";

const execFileP = promisify(execFile);

// #1145 — a fixture repo must not read the host operator's global git config
// (a `~/.config/git/ignore` line makes an untracked file vanish from
// `git status --porcelain -uall`, which is what these assertions read). See
// lib/git-test-env.ts: the env is threaded into every git call below AND set
// ambiently, because bun 1.3 does not propagate a process.env assignment to a
// child_process call that omits `env`.
isolateGitEnv();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_PR_PREFLIGHT = "0";

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd, env: gitTestEnv() });
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout;

/**
 * A minimal driver context for runBranch against the real-git fixture.
 *
 * `dirtyRootExempt` mirrors what `runWorkDriver` stamps on the real cycle
 * context before any step runs: the branch step receives the list on its
 * context and never reads the file itself, so a fixture that wants the
 * exemption to apply has to carry it. Omitted = no config file.
 */
function branchCtx(
  repo: string,
  execFn: ExecFn,
  dispatchFn?: () => Promise<DispatchResult>,
  dirtyRootExempt?: readonly string[],
) {
  return {
    host: {} as unknown as never,
    issue: 1362,
    issues: [1362],
    restart: false,
    repoRoot: repo,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn,
    dirtyRootExempt,
    // The sink a real cycle owns (created by `enterCycle`). Sibling driver
    // tests supply one the same way — `createEmitSink(() => undefined)` — so
    // every `persistCycle` in the step has a watermark instead of writing
    // silently, and the context types as the `CycleContext` the step takes.
    emitSink: createEmitSink(() => undefined),
  } as unknown as CycleContext;
}

/** Injected exec for runBranch: delegates to REAL git, stubs out `gh`/fetch. */
function branchExec(): ExecFn {
  return async (cmd, o) => {
    if (cmd.startsWith("gh ")) return { stdout: "" };
    if (cmd.startsWith("git fetch")) return { stdout: "" };
    return realExec(cmd, o);
  };
}

/** Create a fresh single-commit `main` repo and return its base SHA. */
async function makeRepo(repo: string): Promise<string> {
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

async function freshState(issue: number) {
  const { initialState } = await import("../src/workflow-state.ts");
  return initialState(issue);
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1362-exempt-"));

try {
  // =============== 5 + 6. #1362 — the configured list, against real git.
  //
  // Both cases run the production branch step on a real repo, so the answer
  // comes from `git status --porcelain -uall` and not from a fixture's idea of
  // what porcelain looks like.
  {
    // The tool-local file: what the operator never wrote and the driver never
    // produced, which is nonetheless dirt to every dirty-root gate.
    const TOOL_LOCAL = path.join(".claude", "settings.local.json");

    /** Write the stray under `rel`; `tracked` stages and commits it first. */
    async function plantStray(repo: string, rel: string, tracked: boolean): Promise<string> {
      const abs = path.join(repo, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "// tool-local\n");
      if (tracked) {
        await git(repo, ["add", "--", rel]);
        await git(repo, ["commit", "-q", "-m", "track a tool's file"]);
        writeFileSync(abs, "// tool-local, edited after the commit\n");
      }
      return abs;
    }

    /** Write `.pi/dirty-root-exempt` (a driver artefact, never committed). */
    function writeExempt(repo: string, content: string): void {
      mkdirSync(path.join(repo, ".pi"), { recursive: true });
      writeFileSync(path.join(repo, ".pi", "dirty-root-exempt"), content);
    }

    const noop = async (): Promise<DispatchResult> => ({
      role: "ops",
      ok: true,
      text: "noop",
      toolUses: [],
      ms: 0,
      exitCode: 0,
    });

    /**
     * Run the real branch step and report what it decided. `blocked` is the
     * dirty-root cap; `worktrees` is what the step went on to create — the
     * positive evidence that it got past the gate (the develop dispatch itself
     * lives in runDevelop, which this fixture does not invoke, so a dispatch
     * count here could only ever read zero).
     */
    async function branchBlocked(
      repo: string,
      exempt?: readonly string[],
    ): Promise<{
      blocked: boolean;
      dispatched: number;
      worktrees: Record<string, string>;
      baseline: string[] | undefined;
    }> {
      let dispatched = 0;
      const out = await runBranch(
        branchCtx(
          repo,
          branchExec(),
          async () => {
            dispatched++;
            return noop();
          },
          exempt,
        ),
        await freshState(746),
        1000,
      ).catch((e) => {
        console.error(`runBranch (#1362) threw: ${(e as Error).message}`);
        return undefined;
      });
      return {
        blocked: out?.eventLog.some((e) => e.kind === "cap-hit") === true,
        dispatched,
        worktrees: out?.pipelineState.worktrees ?? {},
        // #1362 round 3 — what the branch step recorded as the cycle-start
        // provenance snapshot, read back off the state it returned.
        baseline: out?.pipelineState.dirtyRootExemptBaseline,
      };
    }

    // 5a. No config → the tool's file BLOCKS the branch step (the bug, and the
    // byte-identical guarantee: the built-in set has not grown to cover it).
    {
      const repoPath = path.join(root, "exempt-blocks");
      await makeRepo(repoPath);
      const abs = await plantStray(repoPath, TOOL_LOCAL, false);
      const { blocked, dispatched } = await branchBlocked(repoPath);
      assert(
        blocked && dispatched === 0,
        "#1362 no config: an untracked .claude/settings.local.json BLOCKS the branch step (the built-in set does not exempt it)",
      );
      assert(existsSync(abs), "#1362: the blocked file is preserved, never deleted");
    }

    // 5b. `.claude/` listed → the same fixture proceeds, and nothing is staged.
    {
      const repoPath = path.join(root, "exempt-allows");
      await makeRepo(repoPath);
      const abs = await plantStray(repoPath, TOOL_LOCAL, false);
      writeExempt(repoPath, "# tool-local files\n.claude/\n");
      const { blocked, worktrees } = await branchBlocked(repoPath, [".claude"]);
      assert(
        !blocked,
        "#1362 with .claude/ listed: the same untracked file does NOT block the branch step",
      );
      assert(
        Object.values(worktrees).length > 0,
        "#1362: the cycle proceeds past the gate and creates its worktree (the block was the only thing stopping it)",
      );
      assert(existsSync(abs), "#1362: exempting the file does not delete it either");
      // The exemption must not have made the driver stage it into the branch.
      const staged = (await gitOut(repoPath, ["ls-files", "--cached"])).split("\n");
      assert(
        !staged.some((f) => f.trim() === TOOL_LOCAL),
        `#1362: the exempt file is never staged (index: ${JSON.stringify(staged)})`,
      );
    }

    // 5b-bis. #1362 round 3 — the branch step RECORDS the provenance baseline
    // at the point where it first reads repoRoot's dirt, so the restore claim
    // can later tell the cycle's own `??` output from a tool file that was
    // already here. Read back off the state the real step returned.
    {
      const repoPath = path.join(root, "exempt-baseline");
      await makeRepo(repoPath);
      await plantStray(repoPath, TOOL_LOCAL, false);
      // A second stray outside the exempt prefix must NOT land in the baseline:
      // the field records what is exempt, and the claim's fail-closed direction
      // depends on it not silently widening.
      // A stray outside the exempt prefix, so the reader's own prefix filter is
      // what keeps it out — the baseline records only exempt paths. (This also
      // blocks the cycle, which is the point of the gate; the baseline is
      // written at that same read, so the field is still on the returned state.)
      await plantStray(repoPath, path.join("notes", "mine.md"), false);
      writeExempt(repoPath, ".claude/\n");
      const { blocked, baseline } = await branchBlocked(repoPath, [".claude"]);
      assert(
        blocked,
        "#1362 baseline: a stray outside the exempt prefix still blocks (the baseline is not an exemption)",
      );
      assert(
        Array.isArray(baseline) &&
          baseline.length === 1 &&
          baseline[0] === ".claude/settings.local.json",
        `#1362 baseline: the branch step records the exempt paths that ALREADY existed, and nothing else (got ${JSON.stringify(baseline)})`,
      );
    }

    // 5b-ter. No exemption list → no baseline field at all. Absent is what
    // `isClaimCountedEntry` reads as "name everything", so a cycle with no
    // config must not write an empty array that a later reader could be tempted
    // to reinterpret as "everything is exempt".
    {
      const repoPath = path.join(root, "exempt-baseline-none");
      await makeRepo(repoPath);
      await plantStray(repoPath, TOOL_LOCAL, false);
      const { baseline } = await branchBlocked(repoPath);
      assert(
        baseline === undefined,
        `#1362 baseline: with no exemption list nothing is recorded — absent stays the fail-closed answer (got ${JSON.stringify(baseline)})`,
      );
    }

    // 5c. The boundary is a `/`, not a bare prefix: `.claude` must not swallow
    // a sibling that merely starts with the same characters.
    {
      const repoPath = path.join(root, "exempt-boundary");
      await makeRepo(repoPath);
      await plantStray(repoPath, path.join(".claudefoo", "x.json"), false);
      writeExempt(repoPath, ".claude/\n");
      const { blocked } = await branchBlocked(repoPath, [".claude"]);
      assert(
        blocked,
        "#1362: listing `.claude` does NOT exempt `.claudefoo/x.json` — the boundary is a `/`",
      );
    }

    // 6. Tracked-modified under an exempt prefix still blocks. The exemption is
    // untracked-only; a modified tracked file is uncommitted source.
    {
      const repoPath = path.join(root, "exempt-tracked");
      await makeRepo(repoPath);
      await plantStray(repoPath, TOOL_LOCAL, true);
      writeExempt(repoPath, ".claude/\n");
      // `git status --porcelain` TRIMS the two-character code when its first
      // column is blank, so an unstaged modification prints as `M <path>`, not
      // `M  <path>`. Match the field, not the padding — the production filter
      // reads the code the same way.
      const porcelain = (await gitOut(repoPath, ["status", "--porcelain"])).trim();
      const first = (porcelain.split("\n")[0] ?? "").trim();
      assert(
        /^M\s+\.claude\/settings\.local\.json$/.test(first),
        `#1362 fixture: the exempt path is a MODIFIED tracked file (porcelain: ${JSON.stringify(porcelain)})`,
      );
      const { blocked } = await branchBlocked(repoPath);
      assert(
        blocked,
        "#1362: a MODIFIED tracked file under an exempt prefix still blocks (the list exempts untracked paths only)",
      );
    }

    // 6b. A rename INTO an exempt prefix still counts as dirt.
    {
      const repoPath = path.join(root, "exempt-rename");
      await makeRepo(repoPath);
      mkdirSync(path.join(repoPath, "src"), { recursive: true });
      writeFileSync(path.join(repoPath, "src", "a.txt"), "a\n");
      await git(repoPath, ["add", "src/a.txt"]);
      await git(repoPath, ["commit", "-q", "-m", "add src/a.txt"]);
      mkdirSync(path.join(repoPath, ".claude"), { recursive: true });
      await git(repoPath, ["mv", "src/a.txt", path.join(".claude", "a.txt")]);
      writeExempt(repoPath, ".claude/\n");
      const { blocked } = await branchBlocked(repoPath, [".claude"]);
      assert(
        blocked,
        "#1362: a rename from a non-exempt path into .claude/ still counts as dirt (a rename is never untracked)",
      );
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
