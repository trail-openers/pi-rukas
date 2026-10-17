#!/usr/bin/env bun
/**
 * #1391 — the reposition gate stops reading driver-caused dirt as operator dirt.
 *
 * The incident (tehas cycle 109): the round-2 lens-fix developer died at
 * 01:56:00 on a local failure, the router retried the step, and the retry's own
 * precondition check met the tree the dead child had written —
 * `lens-fix-reposition: worktree has uncommitted changes: M DESIGN.md, M
 * host/fun/game-view.css, …` — and parked the cycle at 01:56:04. The "third
 * round" lasted one second, the fixer was never dispatched, and the round's
 * MEDIUM findings stayed open on the PR.
 *
 * Nothing in the driver could tell "the dirt my own lost child left" from "the
 * operator's in-progress work" — both are `M <path>` to `git status
 * --porcelain`. These tests drive the real gate against REAL git and pin the
 * three behaviours that close it:
 *
 *  1. driver-caused dirt, a CLEAN preserve → the tree is cleaned, the patch is
 *     on disk with the lost work in it, and the gate proceeds to the tip
 *     instead of parking;
 *  2. driver-caused dirt the gate must NOT clean (a committed fix, or a failed
 *     save) → nothing is destroyed, the park says whose dirt it is and where
 *     the saved copy is;
 *  3. the same dirt WITHOUT the flag (someone else's work) → the gate behaves
 *     exactly as it always did: dirty, no clean, no git write.
 *
 * Offline: real git in a temp dir, no Pi spawn. Deliberately NOT `*-live.ts`.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { cleanLensFixTreeAfterLostAttempt } from "../src/work-driver-lens-fix-reposition-clean.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { parkLensFixReposition } from "../src/work-driver-lens-fix-reposition-park.ts";
import { interruptedLensFixNote, lostAttemptOnStep } from "../src/work-driver-retry-context.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
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

/** Real shell exec matching the driver's ExecFn contract, argv form honoured. */
const realExec: ExecFn = async (cmd, o) => {
  if (o?.argv) {
    const { stdout } = await execFileP(cmd, o.argv, {
      cwd: o.cwd,
      maxBuffer: o.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  }
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) =>
  execFileP("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...args], { cwd });

/**
 * A repo with a pushed feature branch and a DETACHED lens-fix worktree under
 * `<root>/.worktrees/lens` — the layout `lensWorktree()` produces, and the only
 * place the cleaner is allowed to write.
 */
async function fixture(dir: string): Promise<{ repo: string; wt: string; branch: string }> {
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "game-view.js"), "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "DESIGN.md"), "# design\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const branch = "feature/issue-1391-dirty-retry";
  await git(repo, ["checkout", "-q", "-b", branch]);
  await git(repo, ["push", "-q", "-u", "origin", branch]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const wt = path.join(repo, ".worktrees", "lens");
  await execFileP("git", ["worktree", "add", "--detach", wt, baseSha], { cwd: repo });
  return { repo, wt, branch };
}

// ---------------------------------------------------------------------------
// 1. The gate cleans its own residue and reaches the fixer.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-1391-clean-"));
  try {
    const { repo, wt, branch } = await fixture(dir);
    const scratch = path.join(repo, "tmp", "issue-1391");

    // The branch ADVANCED after the child died (round 1's fix landed) — so the
    // gate cannot short-circuit on `already-at-tip`: it has to get past the
    // dirty check to do anything at all, which is the 109 shape.
    writeFileSync(path.join(repo, "game-view.js"), "one\ntwo\nthree\nlanded round 1\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "fix(lens): round 1"]);
    await git(repo, ["push", "-q", "origin", branch]);

    // What the lost child left behind: one tracked edit and one new file — the
    // 109 shape, where a new file under an ignored `tmp/` is exactly the dirt
    // the clean must spare (it holds the patch the preserve just wrote).
    writeFileSync(path.join(wt, "DESIGN.md"), "# design\n\nhalf-written fix note\n");
    writeFileSync(path.join(wt, "new-helper.js"), "export const half = 1;\n");

    const rep = await repositionLensFixWorktree(
      realExec,
      wt,
      branch,
      [1391],
      "1391 dirty retry",
      true,
      repo,
      scratch,
    );
    assert(
      rep.kind === "repositioned" || rep.kind === "already-at-tip",
      `#1391: dirt the driver caused does not park the retry (got ${rep.kind})`,
    );
    const { stdout: porcelain } = await git(wt, ["status", "--porcelain"]);
    assert(porcelain.trim() === "", "#1391: the retry's tree is clean for the fixer");
    const { stdout: head } = await git(wt, ["rev-parse", "HEAD"]);
    const { stdout: tip } = await git(repo, ["rev-parse", branch]);
    assert(head.trim() === tip.trim(), "#1391: the cleaned tree sits at the branch tip");
    assert(
      existsSync(path.join(wt, "new-helper.js")) === false,
      "#1391: the lost child's untracked file is gone from the retry's tree",
    );
    assert(
      existsSync(path.join(wt, "DESIGN.md")),
      "#1391: cleaning removes the residue, not the tree's tracked files",
    );

    const patches = (await git(scratch, ["rev-parse", "--git-dir"])) ? null : null;
    void patches;
    const { stdout: listed } = await execFileP("/bin/sh", ["-c", "ls -1"], { cwd: scratch });
    const patch = listed
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("retry-lens-fix-") && l.endsWith(".patch"))[0];
    assert(patch !== undefined, `#1391: the preserve wrote a retry patch (got: ${listed.trim()})`);
    if (patch !== undefined) {
      const body = readFileSync(path.join(scratch, patch), "utf8");
      assert(
        body.includes("half-written fix note"),
        "#1391: the preserved patch carries the dead child's tracked edit",
      );
      assert(
        body.includes("export const half = 1"),
        "#1391: the preserved patch carries the dead child's untracked file",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Fail-closed: a tree with commits is refused, and nothing is destroyed.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-1391-commits-"));
  try {
    const { repo, wt, branch } = await fixture(dir);
    const scratch = path.join(repo, "tmp", "issue-1391");
    // The child committed its work AND left more uncommitted — the #749 shape
    // where the committed-fix integration is the thing that lands it.
    writeFileSync(path.join(wt, "game-view.js"), "one\ntwo\nthree\nfixer commit\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "fix(lens): committed by the dead child"]);
    writeFileSync(path.join(wt, "DESIGN.md"), "# design\n\nuncommitted residue\n");
    const headBefore = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();

    const r = await cleanLensFixTreeAfterLostAttempt({
      execFn: realExec,
      repoRoot: repo,
      tree: wt,
      scratchDir: scratch,
      id: "lens-fix",
    });
    assert(r.error !== undefined, `#1391: a tree with commits is refused (${r.error})`);
    assert(
      r.error?.includes("left untouched") === true,
      "#1391: the refusal says the tree was left untouched",
    );
    assert(
      (await git(wt, ["rev-parse", "HEAD"])).stdout.trim() === headBefore,
      "#1391: the refusal does not move HEAD",
    );
    const { stdout: after } = await git(wt, ["status", "--porcelain"]);
    assert(
      after.includes("DESIGN.md"),
      "#1391: the refusal does not discard the uncommitted residue either",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2b. Fail-closed: a tree outside `.worktrees/` is refused before any write.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-1391-escape-"));
  try {
    const { repo } = await fixture(dir);
    const outside = path.join(dir, "elsewhere");
    await execFileP("git", ["worktree", "add", "--detach", outside, "HEAD"], { cwd: repo });
    writeFileSync(path.join(outside, "DESIGN.md"), "# design\n\nsomeone else's work\n");
    const r = await cleanLensFixTreeAfterLostAttempt({
      execFn: realExec,
      repoRoot: repo,
      tree: outside,
      scratchDir: path.join(repo, "tmp", "issue-1391"),
      id: "lens-fix",
    });
    assert(r.error !== undefined, `#1391: a tree outside .worktrees/ is refused (${r.error})`);
    const { stdout: after } = await git(outside, ["status", "--porcelain"]);
    assert(after.includes("DESIGN.md"), "#1391: the refused tree is byte-identical");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. Someone else's dirt: unchanged behaviour, and no git write of any kind.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-1391-operator-"));
  try {
    const { repo, wt, branch } = await fixture(dir);
    const scratch = path.join(repo, "tmp", "issue-1391");
    writeFileSync(path.join(wt, "DESIGN.md"), "# design\n\nthe operator's own edit\n");

    // Record every argv the gate runs, so "nothing is stashed or cleaned" is
    // an assertion on the commands rather than on a side effect we hope for.
    const calls: string[] = [];
    const spy: ExecFn = async (cmd, o) => {
      if (o?.argv) calls.push(o.argv.join(" "));
      return realExec(cmd, o);
    };

    const rep = await repositionLensFixWorktree(spy, wt, branch, [1391], "1391 operator dirt");
    assert(rep.kind === "dirty", `#1391: operator dirt still parks (got ${rep.kind})`);
    assert(
      rep.kind === "dirty" && rep.attemptLost === undefined,
      "#1391: dirt nobody attributes to a lost child is not flagged as the driver's",
    );
    assert(
      calls.some((c) => c.startsWith("status ")),
      "#1391: the gate did read the status (the spy works)",
    );
    assert(
      !calls.some(
        (c) => c.startsWith("clean") || c.startsWith("reset") || c.startsWith("checkout"),
      ),
      `#1391: no clean / reset / checkout runs against operator dirt (calls: ${calls.join(" | ")})`,
    );
    const { stdout: after } = await git(wt, ["status", "--porcelain"]);
    assert(after.includes("DESIGN.md"), "#1391: the operator's edit is exactly where they left it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. The park says whose dirt it is (the 109 handoff read the wrong way).
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-1391-park-"));
  try {
    const ctx = { host: {}, repoRoot: dir, issue: 1391 } as unknown as DriverContext;
    const state = initialState(1391, Date.now());
    const parked = await parkLensFixReposition(ctx, state, Date.now(), "/tmp/wt-1391", {
      kind: "dirty",
      detail:
        "worktree has uncommitted changes: `M DESIGN.md` (left by the lens-fix attempt this cycle already lost) — preserved to /tmp/x/retry-lens-fix-1.patch",
      attemptLost: true,
      preservedTo: "/tmp/x/retry-lens-fix-1.patch",
    });
    const cap = [...parked.eventLog]
      .reverse()
      .find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-reposition");
    assert(cap !== undefined, "#1391 park: a dirty result produces the cap-hit");
    assert(
      (cap as { evidence?: string })?.evidence?.includes("#1391 attribution") === true,
      "#1391 park: the evidence says the dirt is the driver's own",
    );
    assert(
      (cap as { evidence?: string })?.evidence?.includes("fixer was NOT dispatched") === true,
      "#1391 park: the evidence says the fixer never ran, so the findings are still open",
    );
    assert(
      (cap as { evidence?: string })?.evidence?.includes("retry-lens-fix-1.patch") === true,
      "#1391 park: the evidence names the preserved patch",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. The attribution signal itself: scoped to the step that lost the attempt.
// ---------------------------------------------------------------------------
{
  let s = initialState(1391, 1_000_000);
  assert(
    lostAttemptOnStep(s, "lens-fix") === false,
    "#1391: a first attempt is not a retry — no licence to clean",
  );
  s = {
    ...s,
    pipelineState: { ...s.pipelineState, transientRetryAttempts: { develop: 1 } },
  };
  assert(
    lostAttemptOnStep(s, "lens-fix") === false,
    "#1391: a develop retry does not license cleaning the lens-fix tree",
  );
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      transientRetryAttempts: { ...s.pipelineState.transientRetryAttempts, "lens-fix": 1 },
    },
  };
  assert(
    lostAttemptOnStep(s, "lens-fix") === true,
    "#1391: the transient budget on lens-fix is the retry signal",
  );
  // The RETRY_ONCE semantic budget is the same kind of lost child; a guard that
  // read only the transient counter would still park this shape.
  const semantic = {
    ...initialState(1391, 1_000_000),
    pipelineState: {
      ...initialState(1391, 1_000_000).pipelineState,
      retryAttempts: { "lens-fix": 1 },
    },
  };
  assert(
    lostAttemptOnStep(semantic, "lens-fix") === true,
    "#1391: the semantic retry budget counts too",
  );
}

// ---------------------------------------------------------------------------
// 6. The retried fixer is told; a fresh round is not.
// ---------------------------------------------------------------------------
{
  const base = initialState(1391, 1_000_000);
  assert(
    interruptedLensFixNote(base) === undefined,
    "#1391: a normal round carries no interruption note",
  );
  const failed = {
    kind: "dispatch-failed-provider" as const,
    step: "lens-fix" as const,
    role: "developer",
    jobId: "j1",
    label: "developer:lens-fix-2",
    ms: 1_369_000,
    at: 1,
    providerMessage: "terminated",
    usage: { input: 2_800_000, output: 20_000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 40 },
  };
  const retried = appendEvent(
    {
      ...base,
      pipelineState: { ...base.pipelineState, transientRetryAttempts: { "lens-fix": 1 } },
    },
    failed,
  );
  const note = interruptedLensFixNote(retried) ?? "";
  assert(
    note.includes("A previous attempt at this fix round was interrupted"),
    "#1391: the retried fixer is told its predecessor was cut short",
  );
  assert(note.includes("cause: provider-severed"), "#1391: the note names the classified cause");
  assert(note.includes("22m49s, 40 turns"), `#1391: the note says how far it got (got: ${note})`);
  assert(!note.includes("terminated"), "#1391: the provider's own text stays out of the prompt");
  // A develop failure must not produce a lens-fix note.
  const devOnly = appendEvent(
    {
      ...base,
      pipelineState: { ...base.pipelineState, transientRetryAttempts: { "lens-fix": 1 } },
    },
    { ...failed, step: "develop" as const },
  );
  assert(
    (interruptedLensFixNote(devOnly) ?? "").includes("cause:") === false,
    "#1391: a develop failure is not reported to the fixer as its own",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
