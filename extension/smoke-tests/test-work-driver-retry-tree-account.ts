#!/usr/bin/env bun
/**
 * #1391 — a lost step attempt's worktree is accounted for by the retry.
 *
 * Split out of `test-retry-lost-work.ts` for the 500-line gate (AGENTS.md §12).
 * The cases there pin what a retry says; the cases here pin the #1391 half of it
 * — that the account is derived from the FILES a step's work lives in rather
 * than from the step's name, and that the lens-fix retry composes that account
 * from the tree it is about to clear and says where the copy went.
 *
 * Why it was wrong: `lostAttemptLine` answered "where is the work?" from
 * `step === "develop"`. `lens-fix` writes files in the lens-fix worktree exactly
 * like `develop` does, so a severed round-2 fixer was reported as restarting
 * "from the beginning" while its edits sat in the very tree the retry then
 * dispatched into — and the next thing to read those files was the reposition
 * guard, which parked the cycle (nessie #109: "round 3 of 3", one second long).
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { exec, execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type LifecycleDetails, attach, detach } from "../src/lifecycle-events.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { lostAttemptLine } from "../src/work-driver-retry-context.ts";
import { __setRetryTreeCleaner } from "../src/work-driver-retry-tree.ts";
import { routeStepOutcome } from "../src/work-driver-step-router.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import { realExec } from "./lib/exec-fake.ts";

const execp = promisify(exec);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const severed = {
  kind: "dispatch-failed-provider" as const,
  step: "explore" as const,
  role: "explore",
  jobId: "j1",
  label: "explore",
  ms: 909_265,
  at: 1,
  providerMessage: "terminated",
  usage: { input: 400_000, output: 12_000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 45 },
};

// 1. The account is built from the step's FILES, not its name.
{
  const { WORKTREE_EDITING_STEPS } = await import("../src/work-driver-retry-context.ts");
  const lensFix = lostAttemptLine("lens-fix", 1, {
    ...severed,
    step: "lens-fix",
    role: "developer",
  });
  assert(
    WORKTREE_EDITING_STEPS.includes("lens-fix"),
    "lens-fix is declared a step whose work lives in a worktree (it was the one left out)",
  );
  assert(
    WORKTREE_EDITING_STEPS.includes("develop"),
    "develop remains declared — the account that was already right stays right",
  );
  assert(
    !WORKTREE_EDITING_STEPS.includes("ci") && !WORKTREE_EDITING_STEPS.includes("explore"),
    "the driver's fileless steps are not swept into the set",
  );
  assert(
    lensFix.includes("still in the worktree"),
    `a lost lens-fix attempt is accounted for by its files, not as a clean restart (got: ${lensFix})`,
  );
  assert(
    !lensFix.includes("the step restarts from the beginning"),
    "a file-editing step never claims a from-scratch restart",
  );

  // A driver step that touches no files keeps the account that was true for it.
  const ci = lostAttemptLine("ci", 1, { ...severed, step: "ci", role: "ops" });
  assert(
    ci ===
      "ci attempt 1 lost: 15m09s, 45 turns, 412k tokens — the step restarts from the beginning",
    `a fileless step's account is unchanged (got: ${ci})`,
  );

  // The retry's own cleanup belongs to the account: it is what turns "kept" into
  // "the only copy is here".
  const saved: RetryTreeAccounting = {
    outcome: "saved",
    paths: ["host/fun/game-view.js", "test/front_page_test.sh", "new/fix.ts"],
    savedTo: "/tmp/issue-109/retry-lens-fix-1.patch",
  };
  const cleaned = lostAttemptLine(
    "lens-fix",
    1,
    { ...severed, step: "lens-fix", role: "developer" },
    saved,
  );
  assert(
    cleaned.includes("saved to /tmp/issue-109/retry-lens-fix-1.patch") &&
      cleaned.includes("3 file(s)"),
    `an accounted-for retry says WHERE the saved copy is (got: ${cleaned})`,
  );
  assert(
    !cleaned.includes("still in the worktree"),
    "a cleared tree is not reported as still holding the work",
  );

  // `already-clean` is the shape this cycle was NOT: nothing to move, so the
  // account must not invent a saved copy.
  const clean = lostAttemptLine(
    "lens-fix",
    1,
    { ...severed, step: "lens-fix", role: "developer" },
    {
      outcome: "already-clean",
      paths: [],
    },
  );
  assert(
    clean.includes("nothing was left") && !clean.includes("saved to"),
    `an already-clean retry claims no saved copy (got: ${clean})`,
  );

  // And a tree the driver could not read is said plainly — the operator is the
  // one who finds the dirt now, so the line must not imply it was cleared.
  const unreadable = lostAttemptLine(
    "lens-fix",
    1,
    { ...severed, step: "lens-fix", role: "developer" },
    {
      outcome: "unreadable",
      paths: [],
      error: "git status --porcelain failed",
    },
  );
  assert(
    unreadable.includes("could not be accounted for") &&
      unreadable.includes("git status --porcelain failed"),
    `an unreadable tree says so instead of implying it was clean (got: ${unreadable})`,
  );
}

// 2. End to end: the lens-fix retry's account comes from the tree it clears.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-retry-account-"));
  const entries: LifecycleDetails[] = [];
  const pi = {
    sendUserMessage: () => {},
    appendEntry: (_t: string, data?: unknown) => {
      entries.push(data as LifecycleDetails);
    },
    registerEntryRenderer: () => {},
  } as unknown as ExtensionAPI;
  attach(pi);
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const wtDir = path.join(dir, ".worktrees", "issue-961-lensfix");
    await fs.mkdir(wtDir, { recursive: true });

    // The tree the severed fixer left: modified tracked files plus a new one —
    // `M DESIGN.md, M host/fun/game-view.js, ...` in the #109 log.
    const dirty = [" M DESIGN.md", " M host/fun/game-view.js", "?? new/fix.ts"];
    const seen: Array<{ cwd?: string; argv?: string[] }> = [];
    let s = initialState(961, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-fix",
        lastCompletedStep: "lens-review",
        branchName: "feature/issue-961-retry-test",
        reviewRound: 2,
        worktrees: { default: wtDir },
        // The router counts the attempts ALREADY SPENT: an empty counter means
        // the failure being routed is attempt 1, and the retry is attempt 2.
        transientRetryAttempts: {},
      },
    };
    s = {
      ...s,
      eventLog: [
        ...s.eventLog,
        {
          kind: "dispatch-failed-provider",
          step: "lens-fix",
          role: "developer",
          jobId: "j-lf",
          label: "developer:lens-fix-2",
          ms: 1_369_000,
          at: 1,
          providerMessage: "terminated",
          usage: {
            input: 2_800_000,
            output: 20_000,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 40,
          },
        },
      ],
    };

    const { routeStepOutcome } = await import("../src/work-driver-step-router.ts");
    const order: string[] = [];
    const ctx = {
      host: pi,
      repoRoot: dir,
      issue: 961,
      verifyExecFn: async (_cmd: string, o?: { cwd?: string; argv?: string[] }) => {
        seen.push({ cwd: o?.cwd, argv: o?.argv });
        const a = o?.argv ?? [];
        if (a[0] === "status") {
          order.push("status");
          return { stdout: `${dirty.join("\n")}\n` };
        }
        if (a[0] === "add" || a[0] === "diff") {
          order.push(a[0] as string);
          return { stdout: "diff --binary placeholder\n" };
        }
        if (a[0] === "reset") {
          order.push("reset");
          return { stdout: "" };
        }
        if (a[0] === "checkout" || a[0] === "clean") {
          order.push(a[0] as string);
          return { stdout: "" };
        }
        return { stdout: "" };
      },
    } as unknown as DriverContext;

    // The clean itself is task-b's module (`worktree-retry-clean.ts`); the
    // router reaches it through the seam declared next to `__setSleepFn`. The
    // contract that seam must satisfy is "read once, save, then clear" — which
    // is what task-d pins against real git — so the fake below states it here
    // and this test pins the router's half: read FIRST, record it, say it.
    const restoreCleaner = __setRetryTreeCleaner(async ({ ctx: c, tree, patchPath }) => {
      const { stdout } = await (c.verifyExecFn ?? realExec)("git", {
        cwd: tree,
        argv: ["status", "--porcelain"],
      });
      const paths = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (paths.length === 0) return { outcome: "already-clean" as const, paths };
      await (c.verifyExecFn ?? realExec)("git", { cwd: tree, argv: ["checkout", "--", "."] });
      await (c.verifyExecFn ?? realExec)("git", { cwd: tree, argv: ["clean", "-qfd"] });
      return { outcome: "saved" as const, paths, savedTo: patchPath };
    });
    let out: Awaited<ReturnType<typeof routeStepOutcome>> | undefined;
    try {
      out = await routeStepOutcome(
        { ...ctx, emitSink: createEmitSink(() => {}) } as never,
        s,
        "lens-fix",
        { num: 7, total: 9 },
        2,
        Date.now(),
      );
    } finally {
      restoreCleaner();
    }
    if (!out) throw new Error("routeStepOutcome returned nothing");

    assert(out.retry === true, "the severed lens-fix attempt is retried, not halted");
    const accounted = out.state.pipelineState.retryTreeAccounting;
    assert(
      accounted !== undefined,
      "the retry carries an account of the dirt it cleared, on pipelineState",
    );
    assert(
      accounted?.outcome === "saved" && accounted.paths.length === 3,
      `the account names what the lost attempt left behind (got ${accounted?.outcome}: ${accounted?.paths.join(", ")})`,
    );
    assert(
      typeof accounted?.savedTo === "string" && accounted.savedTo.includes("retry-"),
      `the saved copy's path is recorded (got ${String(accounted?.savedTo)})`,
    );
    assert(
      order.indexOf("status") === 0 && order.indexOf("status") < order.indexOf("clean"),
      `the tree is read before it is cleared (call order: ${order.join(" → ")})`,
    );
    assert(
      seen.some((c) => c.cwd === wtDir && c.argv?.[0] === "clean") &&
        !seen.some((c) => c.cwd === dir && c.argv?.[0] === "clean"),
      "the clear acts on the lens-fix worktree, never on repoRoot",
    );

    const retry = entries.find((e) => e.kind === "step-retry" && e.label === "lens-fix");
    assert(
      (retry?.reason ?? "").includes("lens-fix attempt 1 lost: 22m49s, 40 turns, 2.82M tokens"),
      `the retry line keeps the full account of what was lost (got: ${retry?.reason})`,
    );
    assert(
      (retry?.reason ?? "").includes("saved to") && (retry?.reason ?? "").includes("3 file(s)"),
      `and says where that work went (got: ${retry?.reason})`,
    );
    // The account is the retry's OWN: a later retry of the same step must not
    // describe a fresh child's worktree with the previous one's file count.
    assert(
      retry !== undefined &&
        entries.filter((x) => x.kind === "step-retry" && x.label === "lens-fix").length === 1,
      "exactly one retry line for the step (the account is not replayed)",
    );

    // The record must survive the round trip: the retry runs in the next
    // iteration, from state read back off disk.
    await writeState(dir, out.state);
    const reread = await readState(dir, 961);
    assert(
      reread?.pipelineState.retryTreeAccounting?.outcome === accounted?.outcome &&
        reread?.pipelineState.retryTreeAccounting?.savedTo === accounted?.savedTo,
      "the account persists to the state file the retried step reads back",
    );
  } finally {
    detach();
    rmSync(dir, { recursive: true, force: true });
  }
}

// #1391 — the retry's own dirt, pinned against real git. `dirty` is the right
// verdict in isolation (case 4 proves a dirty tree is never MOVED); the defect
// was that `dirty` also ENDED the cycle when the driver had just made the tree
// dirty by losing a child in it. Both halves here were wrong in a way a stub
// could hide: the retry clears the dead attempt's edits and dispatches the
// fixer anyway, and clearing a DETACHED worktree must not move HEAD — attach
// with `git checkout -- .`, never `git checkout HEAD`, whose arg resolves as a
// tree-ish and detaches the tree (and re-attaches one deliberately detached).
{
  const retryDir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-retry-"));
  try {
    const origin = path.join(retryDir, "origin.git");
    const root = path.join(retryDir, "root");
    const wt = path.join(retryDir, "wt");
    await execp("git init -q --bare --initial-branch=main origin.git", { cwd: retryDir });
    await execp("git init -q --initial-branch=main root", { cwd: retryDir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: root,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(root, "a.txt"), "one\n");
    await execp("git add . && git commit -q -m base", { cwd: root, shell: "/bin/bash" });
    await execp(`git remote add origin ${JSON.stringify(origin)} && git push -q -u origin main`, {
      cwd: root,
    });
    await execp("git checkout -qb feature/lens-retry && git push -q -u origin feature/lens-retry", {
      cwd: root,
    });
    const tipSha = (await execp("git rev-parse HEAD", { cwd: root })).stdout.trim();
    // DETACHED at the tip — the shape runLensFix works in.
    await execp(`git worktree add --detach ${JSON.stringify(wt)} ${JSON.stringify(tipSha)}`, {
      cwd: root,
    });
    // The gate's executor honours the argv form (note above), bound to `root`.
    const repositionExec = async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
      const argv = o?.argv;
      if (argv) {
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) =>
          execFile(cmd, argv, { cwd: o?.cwd ?? root, encoding: "utf8" }, (err, so) =>
            err ? reject(err) : resolve({ stdout: so }),
          ),
        );
        return { stdout };
      }
      return (await execp(cmd, { cwd: o?.cwd ?? root, shell: "/bin/bash" })) as { stdout: string };
    };

    // The severed attempt's footprint: one modified tracked file, one new file.
    writeFileSync(path.join(wt, "a.txt"), "one\nhalf a fix\n");
    writeFileSync(path.join(wt, "leftover.ts"), "export const x = 1;\n");

    const dirty4 = await repositionLensFixWorktree(
      repositionExec,
      wt,
      "feature/lens-retry",
      [1391],
      "reposition test",
    );
    assert(
      dirty4.kind === "dirty",
      `1391: the dead attempt's dirt is read as dirty (got ${dirty4.kind}) — the guard's verdict is unchanged`,
    );
    assert(
      (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim() === tipSha,
      "1391: the dirty guard did not move HEAD",
    );

    // The retry accounts for that dirt and clears it. task-b's clean, against
    // real git, in the shape the fix dispatch needs — a detached worktree.
    const { cleanTreeForRetry, retryCleanSource } = await import("./lib/retry-clean-under-test.ts");
    const acct = await cleanTreeForRetry(repositionExec, {
      cwd: wt,
      patchPath: path.join(retryDir, "retry-lens-fix-1.patch"),
    });
    assert(
      acct.outcome === "saved" && acct.paths.length === 2,
      `1391: the retry accounts for the dead attempt's files (got ${acct.outcome}: ${acct.paths.join(", ")})`,
    );
    assert(
      (await execp("git status --porcelain", { cwd: wt })).stdout.trim() === "",
      "1391: the retry leaves the worktree clean for the fixer",
    );
    assert(
      (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim() === tipSha,
      "1391: clearing a detached worktree keeps HEAD (checkout -- ., never a tree-ish)",
    );
    const symbolic = await execp("git symbolic-ref -q HEAD", { cwd: wt }).catch(() => undefined);
    assert(
      symbolic === undefined,
      "1391: clearing a detached worktree does not re-attach it to a branch",
    );

    // The dirt is preserved, not destroyed (#109's fix survived only as a scratch
    // diff nobody looked at) — here it is a named, restorable artifact.
    assert(
      existsSync(path.join(retryDir, "retry-lens-fix-1.patch")),
      "1391: the dirt is saved to a patch before the tree is cleared",
    );
    assert(
      readFileSync(path.join(retryDir, "retry-lens-fix-1.patch"), "utf8").includes("half a fix"),
      "1391: the saved patch really carries the severed attempt's edit",
    );

    const reClean = await cleanTreeForRetry(repositionExec, {
      cwd: wt,
      patchPath: path.join(retryDir, "retry-lens-fix-2.patch"),
    });
    assert(
      reClean.outcome === "already-clean" &&
        reClean.savedTo === undefined &&
        !existsSync(path.join(retryDir, "retry-lens-fix-2.patch")),
      `1391: a second retry on the cleared tree says so and writes no patch (got ${reClean.outcome})`,
    );

    // With the tree clean the gate that parked the cycle lets the fixer through.
    const rAfter = await repositionLensFixWorktree(
      repositionExec,
      wt,
      "feature/lens-retry",
      [1391],
      "reposition test",
    );
    assert(
      rAfter.kind === "already-at-tip",
      `1391: after the retry clears its own dirt the fixer is dispatched (got ${rAfter.kind})`,
    );
    console.log(
      `  … 1391 clean pinned against: ${await retryCleanSource()} (task-b's module is used as soon as it lands)`,
    );
  } finally {
    rmSync(retryDir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
