#!/usr/bin/env bun
/**
 * #746 — the #741 poisoning sequence: a stray untracked file at repoRoot is
 * detected EARLY (the branch step), not at the consolidated verify gate ~50
 * minutes later.
 *
 * The incident (#741, live on pi-rukas itself, 2026-09-15). A develop-step
 * dispatch in cycle 1 wrote a source file to the REPOSITORY ROOT instead of
 * its assigned worktree (its cwd had silently fallen back to the process
 * directory, which for a driver-launched child IS repoRoot). The stray,
 * untracked file survived the cycle. Cycle 2 (`--restart`) then:
 *
 *   - correctly cleared the stale worktrees (the #730 residue pass) and
 *     salvaged their commits to durable refs, but
 *   - did NOT clear the repo root — the #730 residue pass scans `git
 *     worktree list` for `.worktrees/issue-<N>-*` only and is structurally
 *     blind to a stray file at the root;
 *   - completed all development work (2/2 workstreams, ~50 min);
 *   - and only THEN failed at the POST-DEVELOP consolidated verify gate with
 *     "repoRoot is dirty (extension/src/work-driver-converge.ts)".
 *
 * The cost was paid at the worst moment: after develop + adversarial had
 * completed. One cycle's dispatch silently poisoned the next.
 *
 * Decision (recorded on the issue): on dirt at repoRoot outside the
 * driver-managed exclusion set, the branch step HARD-BLOCKS the cycle before
 * dispatching any development work, and NEVER deletes / stashes / mutates
 * the residue (the #741 file turned out to be an alternative design worth
 * keeping).
 *
 * Coverage:
 *   1. Real-git, end-to-end: a stray untracked file at repoRoot (under
 *      `extension/src/`, outside the exclusion set) IS detected at the
 *      branch step — the cycle halts BEFORE any develop dispatch — and the
 *      stray file SURVIVES (preserve-and-report: never deleted). A clean
 *      root does NOT block.
 *   2. Exclusion-set canary: the driver-managed dirs (`.worktrees/`, `.pi/`,
 *      `tmp/`) are NOT residue; a stray under a source dir IS.
 *   3. Pre-fix regression simulation: with no branch-step gate, the stray
 *      file sails through branch + develop and is discovered only at the
 *      consolidated verify gate (kind: "dirty-root", "repoRoot is dirty") —
 *      the incident's 50-minute shape.
 *   4. Structural canary: the post-develop consolidated verify STILL refuses
 *      on a dirty root (the late gate must not regress or be relaxed), passes
 *      on a clean root, and shares the same exclusion set as the branch step.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
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

// The branch step's dirty-root gate hard-blocks; these escape hatches let the
// real-git fixtures below keep exercising the (separate) worktree machinery.
process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_PR_PREFLIGHT = "0";

const realExec: ExecFn = async (cmd, o) => {
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
      cwd: o?.cwd,
      maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`${err.message}\n${err.stderr ?? ""}`);
  }
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout;

/** The #741 incident path, relative to the repo root. */
const STRAY_REL = path.join("extension", "src", "work-driver-converge.ts");

/** A minimal driver context for runBranch against the real-git fixture. */
function branchCtx(repo: string, execFn: ExecFn, dispatchFn?: () => Promise<DispatchResult>) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture
    pi: {} as any,
    issue: 746,
    issues: [746],
    restart: false,
    repoRoot: repo,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn,
  } as unknown as DriverContext;
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-746-poison-"));

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

/** Injected exec for runBranch: delegates to REAL git, stubs out `gh`. */
function branchExec(): ExecFn {
  return async (cmd, o) => {
    if (cmd.startsWith("gh ")) return { stdout: "" };
    if (cmd.startsWith("git fetch")) return { stdout: "" };
    return realExec(cmd, o);
  };
}

async function freshState(issue: number) {
  const { initialState } = await import("../src/workflow-state.ts");
  return initialState(issue);
}

try {
  // =============== 1. real-git, end-to-end — the #741 poisoning sequence
  {
    const repoPath = path.join(root, "poison");
    const baseSha = await makeRepo(repoPath);

    // The #741 residue: an untracked file at the repo ROOT, under a source
    // directory (outside the driver-managed exclusion set).
    const stray = path.join(repoPath, STRAY_REL);
    mkdirSync(path.dirname(stray), { recursive: true });
    writeFileSync(stray, "// issue #741, d1 — the alternative design\n");

    let dispatched = 0;
    const noopDispatch = async (): Promise<DispatchResult> => {
      dispatched++;
      return { role: "developer", ok: true, text: "noop", toolUses: [], ms: 0, exitCode: 0 };
    };

    const out = await runBranch(
      branchCtx(repoPath, branchExec(), noopDispatch),
      await freshState(746),
      1000,
    ).catch((e) => {
      console.error(`runBranch threw: ${(e as Error).message}`);
      return undefined;
    });

    assert(out !== undefined, "the branch step does NOT throw on the poisoned root");
    const capHit = out?.eventLog.find((e) => e.kind === "cap-hit");
    assert(
      capHit !== undefined,
      "EARLY detection: the branch step HALTS the cycle on the stray root file (a cap-hit is appended) — not the consolidated verify gate 50 min later",
    );
    assert(
      capHit?.nextStep === "handoff",
      "the halt routes to handoff (nextStep: handoff) — the cycle does not proceed to develop",
    );
    // The cap must NAME the stray file. It rides on the event (evidence) or a
    // plumb-report (the branch step's documented channel).
    const capEvidence = capHit && "evidence" in capHit ? capHit.evidence : "";
    const plumbBody = out?.eventLog
      .filter((e) => e.kind === "plumb-report")
      .map((e) => (e as { body?: string }).body ?? "")
      .join("\n");
    const allText = `${capEvidence}\n${plumbBody}`;
    assert(
      allText.includes("work-driver-converge.ts") || allText.includes(STRAY_REL),
      `the halt NAMES the exact stray path (got evidence/plumb: ${allText.slice(0, 200)})`,
    );
    assert(
      dispatched === 0,
      "the developer dispatch is NEVER invoked — the cycle halts before any develop work (the ~50-min cost is never paid)",
    );
    // Preserve-and-report: the stray file SURVIVES the branch step.
    assert(
      existsSync(stray),
      "the stray file SURVIVES the branch step (preserve-and-report — never deleted, stashed or mutated)",
    );
    // The branch step did not itself dirty the root beyond the stray it just
    // named. Read porcelain with the excludes file disabled so the gate's own
    // side-effects (adding `.worktrees/`/`tmp/` to .git/info/exclude) cannot
    // hide what it added: the ONLY dirt present must be the stray's subtree.
    const raw = await gitOut(repoPath, [
      "-c",
      "core.excludesFile=/dev/null",
      "status",
      "--porcelain",
    ]);
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.includes(".worktrees/") && !l.includes(".pi/") && !l.includes("tmp/"));
    const onlyStray =
      lines.length > 0 &&
      lines.every(
        (l) =>
          l.includes(STRAY_REL) || l.startsWith("?? extension/") || l.startsWith("?? extension"),
      );
    assert(
      onlyStray,
      `the branch step added nothing but the (still-present) stray to the root — residual non-stray dirt: ${JSON.stringify(lines)}`,
    );
  }

  // =============== 2. real-git — a clean root does NOT block
  {
    const repoPath = path.join(root, "clean");
    const baseSha = await makeRepo(repoPath);
    void baseSha;

    const noopDispatch = async (): Promise<DispatchResult> => ({
      role: "ops",
      ok: true,
      text: "noop",
      toolUses: [],
      ms: 0,
      exitCode: 0,
    });

    const out = await runBranch(
      branchCtx(repoPath, branchExec(), noopDispatch),
      await freshState(746),
      1000,
    ).catch((e) => {
      console.error(`runBranch (clean) threw: ${(e as Error).message}`);
      return undefined;
    });
    const capHit = out?.eventLog.find((e) => e.kind === "cap-hit");
    assert(
      capHit === undefined,
      "a clean root is NOT blocked — the branch step proceeds (no spurious dirty-root cap)",
    );
    const wts = out?.pipelineState.worktrees ?? {};
    const target = path.join(repoPath, ".worktrees", "issue-746-default");
    assert(wts.default === target, `the clean branch step created its target worktree (${target})`);
  }

  // =============== 3. exclusion-set canary (pure, no git)
  {
    // The driver-managed dirs (.worktrees/, .pi/) are NOT residue; a stray
    // under a source dir IS. This mirrors the consolidated verify preflight's
    // filter (the reference implementation), which excludes `.worktrees/` and
    // `.pi/`.
    const straySrcLine = `?? ${STRAY_REL}`;
    const strayWorktreesLine = `?? ${path.join(".worktrees", "issue-746-default")}`;
    const strayPiLine = `?? ${path.join(".pi", "work-state", "746.json")}`;
    const isDirt = (l: string) =>
      l.trim() !== "" && !/^..\s+"?\.worktrees\//.test(l) && !/^..\s+"?\.pi\//.test(l);
    assert(isDirt(straySrcLine), "a stray under a SOURCE dir is dirt (flagged)");
    assert(!isDirt(strayWorktreesLine), "a stray under .worktrees/ is NOT dirt (excluded)");
    assert(!isDirt(strayPiLine), "a stray under .pi/ is NOT dirt (excluded)");
  }

  // =============== 4a. pre-fix regression simulation — discovery at the verify gate
  //
  // With no branch-step gate, the stray file sails through branch (its
  // worktree sits at .worktrees/issue-746-default, unrelated to the root
  // file) and through develop, and is discovered ONLY at the consolidated
  // verify gate: kind "dirty-root", message "repoRoot is dirty". The
  // incident's 50-minute shape.
  {
    const repoPath = path.join(root, "prefix");
    const baseSha = await makeRepo(repoPath);
    const stray = path.join(repoPath, STRAY_REL);
    mkdirSync(path.dirname(stray), { recursive: true });
    writeFileSync(stray, "// stray residue at the root\n");

    const wt = path.join(repoPath, ".worktrees", "issue-746-default");
    await git(repoPath, ["worktree", "add", "-q", "--detach", wt, baseSha]);

    const res = await runConsolidatedVerify(realExec, {
      repoRoot: repoPath,
      baseSha,
      worktrees: { default: wt },
      scratchDir: path.join(repoPath, "tmp", "issue-746"),
      verifyCmd: "true",
      timeoutMs: 5000,
    });
    assert(
      res.status === "conflict" && res.kind === "dirty-root",
      "PRE-FIX shape: with no branch-step gate, the stray file is first discovered at the CONSOLIDATED VERIFY gate (kind: dirty-root) — the ~50-min cost",
    );
    const detail = res.status === "conflict" ? res.detail : "";
    assert(
      /repoRoot is dirty/.test(detail),
      "the late gate's message reads 'repoRoot is dirty' — the exact #741 wording",
    );
    // git porcelain collapses a fully-untracked nested dir to its parent, so
    // the gate names the stray's parent dir (`extension/`), not the full path.
    assert(
      detail.includes("extension"),
      `the late gate NAMES the stray's location (got: ${detail.slice(0, 160)})`,
    );
    assert(
      existsSync(stray),
      "the stray file survived the late refusal too (the gate refuses, it does not clean)",
    );
  }

  // =============== 4b. the late gate still passes on a clean root (no over-refusal)
  {
    const repoPath = path.join(root, "late-clean");
    const baseSha = await makeRepo(repoPath);
    const wt = path.join(repoPath, ".worktrees", "issue-746-default");
    await git(repoPath, ["worktree", "add", "-q", "--detach", wt, baseSha]);

    const res = await runConsolidatedVerify(realExec, {
      repoRoot: repoPath,
      baseSha,
      worktrees: { default: wt },
      scratchDir: path.join(repoPath, "tmp", "issue-746"),
      verifyCmd: "true",
      timeoutMs: 5000,
    });
    assert(
      res.status === "passed",
      "NO-REGRESSION: the consolidated verify still PASSES on a clean root (the gate is not over-refusing)",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// =============== 4c. structural canary — both gates share the exclusion set
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");
  const verifySrc = read("work-driver-consolidated-verify.ts");
  assert(
    /\.worktrees\//.test(verifySrc) && /\.pi\//.test(verifySrc),
    "the consolidated verify preflight still excludes .worktrees/ and .pi/ (the shared exclusion set)",
  );
  const residueSrc = read("work-driver-branch-residue.ts");
  const branchDevelopSrc = read("work-driver-branch-develop.ts");
  const earlyGateRefsExclusions =
    (/\.worktrees\//.test(residueSrc) && /\.pi\//.test(residueSrc)) ||
    (/\.worktrees\//.test(branchDevelopSrc) && /\.pi\//.test(branchDevelopSrc));
  assert(
    earlyGateRefsExclusions,
    "the branch step carries a dirty-root early gate that references the same .worktrees//.pi/ exclusion set as the consolidated verify (the two gates share one source of truth)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
