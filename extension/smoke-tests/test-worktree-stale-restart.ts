#!/usr/bin/env bun
/**
 * #545 — restart cycles die at branch: stale same-issue worktrees and a
 * 3-second silent abort with no plumb.
 *
 * Two incidents: (1) `/work #540 --restart` failed in ~3s with cap
 * `step-failed:branch`, no plumb-report, no error text — the mechanized
 * worktree add refused against the cycle's OWN leftover worktrees; (2) 30+
 * detached worktrees from parked/aborted cycles made `git worktree add`
 * environment variance the branch step's real failure source.
 *
 * Now:
 *  - a NON-dirty mechanized branch-step failure plumbs the actual git error
 *    (worktree add stderr) into a plumb-report — the handoff names WHY;
 *  - a dirty leftover of the SAME issue (`.worktrees/issue-<N>-*`) is
 *    salvaged deterministically into the cycle's scratch dir —
 *    `salvage.patch` + `untracked.txt` + the untracked file CONTENTS — before
 *    the refusal, and the refusal itself (and its handoff routing) is
 *    UNCHANGED: a dirty worktree is never destroyed by the driver;
 *  - a dirty worktree of a FOREIGN issue (different prefix) is refused with
 *    the path plumbed — no salvage, no fallback.
 *
 * The #475 dirty-leftover canaries in test-worktree-dirty-preremove.ts still
 * guard the refusal; this file pins the two #545 behaviours on top of it.
 *
 * NOTE: the injected-exec `runBranch` fixtures below use issue 540. The
 * `worktrees` map is EMPTY in `initialState` (schema: populated only by the
 * branch step), so the same-issue salvage at the `runBranch` level operates
 * on the state's OWN worktrees — nothing to salvage in a fixture. The salvage
 * path is therefore covered end-to-end in the real-git section above (via
 * `salvageSameIssueDirtyWorktrees`), and the injected fixtures pin the two
 * routing outcomes: dirty → handoff + path-plumbed refusal (with or without
 * a salvage note when the state's worktrees are non-empty); non-dirty →
 * plumb-report with the git error.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import { salvageKnownDirtyWorktrees } from "../src/work-driver-branch-salvage.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import { DirtyWorktreeError, type ExecFn, worktreeCreate } from "../src/worktree.ts";

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

/** A minimal repo with a committed base, detached at that base. */
async function fixture(name: string): Promise<{ repo: string; baseSha: string }> {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
  return { repo, baseSha: stdout.trim() };
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-stale-restart-"));
const injectedRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-stale-restart-inj-"));

// ------------------------------------------ real git: same-issue salvage

try {
  // ------------- the incident: a --restart hits its OWN dirty leftover
  {
    const { repo, baseSha } = await fixture("same-issue");
    const wt = path.join(repo, ".worktrees", "issue-540-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    writeFileSync(path.join(wt, "a.txt"), "base\nmid-develop work\n");
    writeFileSync(path.join(wt, "new-file.txt"), "untracked work\n");

    const scratch = path.join(repo, "tmp", "issue-540");
    const note = await salvageKnownDirtyWorktrees(realExec, { "task-a": wt }, scratch, "");
    const salvageDir = path.join(scratch, "salvage", "issue-540-task-a");
    assert(note.includes(salvageDir), "salvage: a note names the salvage location");
    const patch = readFileSync(path.join(salvageDir, "salvage.patch"), "utf8");
    assert(
      patch.includes("mid-develop work"),
      "salvage.patch carries the tracked-file diff — the work is preserved",
    );
    const untrackedManifest = readFileSync(path.join(salvageDir, "untracked.txt"), "utf8");
    assert(
      untrackedManifest.includes("new-file.txt"),
      "untracked.txt manifests the new files — the diff alone would have lost them",
    );
    const copied = readFileSync(path.join(salvageDir, "files", "new-file.txt"), "utf8");
    assert(
      copied === "untracked work\n",
      "the untracked file CONTENT is copied, not just listed",
    );
    const { stdout } = await git(wt, ["status", "--porcelain"]);
    assert(stdout.length > 0, "the worktree is still on disk — salvage never destroys");
  }

  // ------------- a foreign dirty worktree is NOT salvaged
  {
    const { repo, baseSha } = await fixture("foreign");
    const wtForeign = path.join(repo, ".worktrees", "issue-999-task-a");
    await git(repo, ["worktree", "add", "-q", "--detach", wtForeign, baseSha]);
    writeFileSync(path.join(wtForeign, "a.txt"), "foreign dirty work\n");

    const scratch = path.join(repo, "tmp", "issue-999");
    // The state's worktrees map for issue 540 names only issue-540 worktrees;
    // the foreign issue-999 worktree is not in the map, so it is not
    // salvaged — the #475 refusal still protects it.
    const note = await salvageKnownDirtyWorktrees(realExec, {}, scratch, "");
    assert(
      note === "",
      "a worktree NOT in the state's worktrees map is not salvaged — salvage only touches what the state knows about",
    );
    const { stdout } = await git(wtForeign, ["status", "--porcelain"]);
    assert(stdout.length > 0, "the foreign worktree is untouched — salvage only touches what the state knows about");
  }

  // ------------- the #540 shape: a dirty SAME-issue sibling refuses worktreeCreate
  {
    const { repo, baseSha } = await fixture("same-sibling");
    // The cycle's OWN dead sibling from a parked run (same issue prefix).
    const wtSibling = path.join(repo, ".worktrees", "issue-540-task-b");
    await git(repo, ["worktree", "add", "-q", "--detach", wtSibling, baseSha]);
    writeFileSync(path.join(wtSibling, "a.txt"), "base\nleftover work\n");

    // The cycle's target path is free, but a dirty same-issue sibling is
    // attached — `worktree add` would refuse with a bare `already exists`
    // style error. #545: the refusal now names the dirty path.
    const foreignErr = await worktreeCreate(realExec, {
      repoRoot: repo,
      name: "issue-540-default",
      fromRef: baseSha,
    }).then(
      () => undefined,
      (e: unknown) => e as Error & { finding?: { path?: string } },
    );
    assert(
      foreignErr instanceof DirtyWorktreeError && foreignErr.finding.path.endsWith("issue-540-task-b"),
      "a dirty same-issue sibling worktree refuses the cycle's own worktreeCreate (#540 shape)",
    );
    assert(
      Boolean(foreignErr?.message.includes("issue-540-task-b")),
      "the refusal names the dirty sibling's path — the plumb report will carry it",
    );
  }

  // ------------- a clean same-issue worktree is skipped (nothing to salvage)
  {
    const { repo, baseSha } = await fixture("clean-same");
    const wt = path.join(repo, ".worktrees", "issue-540-default");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);

    const scratch = path.join(repo, "tmp", "issue-540");
    const note = await salvageKnownDirtyWorktrees(realExec, { default: wt }, scratch, "");
    assert(note === "", "a clean same-issue worktree is skipped — no spurious salvage");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --------------------------------------------- injected-exec: plumb + routing

/** Recorder matching the shape test-worktree-dirty-premove.ts uses.
 *
 *  * `REPO` (the branch step) — every command recorded; `git worktree list`
 *  returns the configured list; `git worktree add` throws when configured;
 *  everything else (including `gh pr list`) succeeds empty so the fixture
 *  reaches the worktree-add failure deterministically.
 *  * `WT` (the leftover's own repo) — `git status --porcelain` / `git diff`
 *  / `git ls-files` answer from `overrides`; `git rev-parse --verify HEAD`
 *  always succeeds (the worktree exists).
 */
function recorder(overrides: Record<string, string>, targetWt?: string) {
  const wtCalls: Array<{ cmd: string }> = [];
  const execFn: ExecFn = async (cmd, o) => {
    // The worktree's own git. The cycle's target path is clean (doesn't
    // exist yet); all other worktrees are dirty.
    if (o?.cwd && o.cwd.includes(".worktrees/")) {
      const isTarget = targetWt !== undefined && o.cwd === targetWt;
      if (!isTarget) wtCalls.push({ cmd });
      if (cmd.startsWith("git status --porcelain")) return { stdout: isTarget ? "\n" : " M src/wip.ts\n" };
      if (cmd.startsWith("git diff HEAD")) return { stdout: "diff --git a/src/wip.ts b/src/wip.ts\n+salvage\n" };
      if (cmd.startsWith("git ls-files --others")) return { stdout: "" };
      if (cmd.startsWith("git rev-parse")) return { stdout: "deadbeef\n" };
      if (cmd.startsWith("git rev-list")) return { stdout: "0\n" };
      if (cmd.startsWith("git worktree")) return { stdout: "" };
      for (const [prefix, stdout] of Object.entries(overrides)) {
        if (cmd.startsWith(prefix)) {
          if (stdout.startsWith("!THROW!")) throw new Error(stdout.slice(7));
          return { stdout };
        }
      }
      return { stdout: "" };
    }
    if (cmd.startsWith("git worktree list")) return { stdout: overrides["git worktree list"] ?? "" };
    for (const [prefix, stdout] of Object.entries(overrides)) {
      if (cmd.startsWith(prefix)) {
        if (stdout.startsWith("!THROW!")) throw new Error(stdout.slice(7));
        return { stdout };
      }
    }
    return { stdout: "" };
  };
  return { wtCalls, execFn };
}

const REPO = "/repo";
process.env.PI_ENSEMBLE_RESUME = "0";

function branchCtx(execFn: ExecFn): DriverContext {
  const noopDispatch = async (): Promise<DispatchResult> => ({
    role: "ops",
    ok: true,
    text: "noop",
    toolUses: [],
    ms: 0,
    exitCode: 0,
  });
  return {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture — only verifyExecFn + repoRoot are touched on this path
    pi: {} as any,
    issue: 540,
    issues: [540],
    restart: true,
    repoRoot: REPO,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn: noopDispatch,
  } as unknown as DriverContext;
}

try {
{
  // #545 incident #1: a NON-dirty mechanized failure (worktree add refused
  // against a foreign leftover) used to fall back to ops with a bare
  // step-failed cap and NO plumb report. Now the plumb-report carries the
  // actual git error — the handoff names WHY.
  const wtForeign = `${REPO}/.worktrees/issue-999-leftover`;
  const targetWt = `${REPO}/.worktrees/issue-540-default`;
  const { execFn } = recorder({
    "git rev-parse --verify --quiet ": "deadbeef\n",
    "git worktree add": `!THROW!fatal: cannot lock ref 'refs/heads/x': already exists\n`,
    "git worktree list": `worktree ${wtForeign}\nHEAD deadbeef\ndetached\n`,
  }, targetWt);
  const out = await runBranch(branchCtx(execFn), initialState(540), 1000).catch(() => undefined);
  const plumbEvent = out?.eventLog.find((e) => e.kind === "plumb-report");
  const plumbField = out?.pipelineState.plumbReports?.find((r) => r.step === "branch");
  assert(
    Boolean(plumbEvent || plumbField),
    "a non-dirty mechanized failure produces a plumb report (event log OR pipelineState)",
  );
  const body = plumbEvent?.body ?? plumbField?.body ?? "";
  assert(
    body.includes("cannot lock ref"),
    "the plumb report carries the ACTUAL git error — the handoff names WHY, not a bare step-failed",
  );
  // #536 — the ops-fallback path does not call provisionWorktree; a
  // worktree-provisioned event with ops-fallback-unprovisioned must appear
  // for each worktree so the develop gate gives the right depsHint.
  const provEvent1 = out?.eventLog.find((e) => e.kind === "worktree-provisioned");
  assert(
    provEvent1?.kind === "worktree-provisioned" &&
      provEvent1.outcome === "ops-fallback-unprovisioned",
    "#536: ops-fallback path emits worktree-provisioned with ops-fallback-unprovisioned",
  );
}

{
  // A dirty SAME-issue sibling: the refusal routes to handoff via
  // step-failed:branch (unchanged #475 semantics), and the plumb report
  // names the dirty sibling's path.
  const targetWt = `${REPO}/.worktrees/issue-540-default`;
  const wtSibling = `${REPO}/.worktrees/issue-540-task-b`;
  const { execFn, wtCalls } = recorder({
    "git rev-parse --verify --quiet ": "deadbeef\n",
    "git worktree list": `worktree ${wtSibling}\nHEAD deadbeef\ndetached\n`,
  }, targetWt);
  const out = await runBranch(branchCtx(execFn), initialState(540), 1000).catch(() => undefined);
  const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "step-failed:branch" && cap.nextStep === "handoff",
    "a dirty same-issue sibling still routes to handoff via step-failed:branch (#475 unchanged)",
  );
  const report = out?.pipelineState.plumbReports?.find((r) => r.step === "branch");
  assert(
    Boolean(report?.body.includes(wtSibling)),
    "the plumb report names the ABSOLUTE path of the dirty sibling",
  );
  assert(
    wtCalls.some((c) => c.cmd.startsWith("git status --porcelain")),
    "salvage inspected the dirty sibling via its own git (attempted salvage.patch)",
  );
}

{
  // A dirty FOREIGN leftover: the cycle proceeds (the foreign worktree is
  // not the cycle's target and not a same-issue sibling), and the plumb
  // report is absent — no refusal, no salvage.
  const wtForeign = `${REPO}/.worktrees/issue-999-default`;
  const targetWt2 = `${REPO}/.worktrees/issue-540-default`;
  const { execFn, wtCalls } = recorder({
    "git rev-parse --verify --quiet ": "deadbeef\n",
    "git worktree add": `!THROW!fatal: cannot lock ref 'refs/heads/x': already exists\n`,
    "git worktree list": `worktree ${wtForeign}\nHEAD deadbeef\ndetached\n`,
  }, targetWt2);
  const out = await runBranch(branchCtx(execFn), initialState(540), 1000).catch(() => undefined);
  // The foreign dirty worktree does NOT trigger a refusal — the cycle
  // falls back to the ops dispatch (recovery path), not handoff.
  const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap === undefined,
    "a foreign dirty worktree does NOT refuse the cycle — the ops fallback handles it",
  );
  assert(
    wtCalls.every((c) => !c.cmd.startsWith("git diff HEAD")),
    "salvage does not copy work from a foreign worktree",
  );
  // #536 — the ops-fallback path (foreign dirty worktree falls back to ops)
  // emits worktree-provisioned with ops-fallback-unprovisioned.
  const provEvent3 = out?.eventLog.find((e) => e.kind === "worktree-provisioned");
  assert(
    provEvent3?.kind === "worktree-provisioned" &&
      provEvent3.outcome === "ops-fallback-unprovisioned",
    "#536: ops-fallback (foreign-dirty case) emits worktree-provisioned with ops-fallback-unprovisioned",
  );
}
} finally {
  rmSync(injectedRoot, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
