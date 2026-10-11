/**
 * #1016 — crash-resume of a develop fan-out: only workstreams with a green
 * branch-completed in the INTERRUPTED attempt are preserved.
 */
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

{
  const { greenWorkstreamsFromInterruptedDevelop } = await import("../src/work-develop-greens.ts");
  const base = (over: Record<string, unknown>): WorkState =>
    ({
      schemaVersion: 1,
      issue: 1,
      updatedAt: 0,
      pipelineState: {
        currentStep: "develop",
        inFlightJobIds: ["j1"],
        ...over,
      },
      eventLog: [],
    }) as unknown as WorkState;
  const bc = (id: string, ok: boolean): WorkEvent => ({
    kind: "branch-completed",
    step: "develop",
    workstreamId: id,
    ok,
    ms: 1,
    at: 1,
  });
  const started: WorkEvent = { kind: "step-started", step: "develop", at: 1 };
  const crashed = base({});
  crashed.eventLog = [
    { kind: "step-started", step: "branch", at: 0 },
    started,
    bc("task-a", true),
    bc("task-b", false),
  ];
  const green = greenWorkstreamsFromInterruptedDevelop(crashed);
  assert(
    [...green].join() === "task-a",
    "#1016: only task-a (green before the crash) is preserved",
  );
  const notInFlight = base({ inFlightJobIds: [] });
  notInFlight.eventLog = crashed.eventLog;
  assert(
    greenWorkstreamsFromInterruptedDevelop(notInFlight).size === 0,
    "#1016: no marker → full re-entry",
  );
  const atBranch = base({ currentStep: "branch" });
  atBranch.eventLog = crashed.eventLog;
  assert(
    greenWorkstreamsFromInterruptedDevelop(atBranch).size === 0,
    "#1016: not at develop → full re-entry",
  );
}

import type { DriverContext } from "../src/work-driver-context.ts";

type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;
const SHA = "a".repeat(40);

/** A recording stub: every git command seen, answering rev-list with `count`. */
const stubExec =
  (count: string, calls: string[]): ExecFn =>
  async (cmd, opts) => {
    // argv form (#1016): the recorded line is the command as git receives it.
    const line = [cmd, ...(opts?.argv ?? [])].join(" ");
    calls.push(line);
    return {
      stdout: line.startsWith("git rev-list") ? `${count}\n` : "",
      stderr: "",
    };
  };

{
  // Crash-resume greens and the sha-only / tri-state rules, with no git at all.
  const { trustedPreservedGreens, runIndependentFanout } = await import(
    "../src/work-develop-retry.ts"
  );
  const {
    commitsAheadOfBase: commitsRaw,
    resetWorktreeToBase: resetRaw,
    runGit,
  } = await import("../src/work-develop-git.ts");
  // Shims: the tests stub the ExecFn; the git primitives take the GitExec adapter.
  const commitsAheadOfBase = (f: ExecFn, cwd: string, base: string | undefined) =>
    commitsRaw(runGit(f), cwd, base);
  const resetWorktreeToBase = (
    f: ExecFn,
    cwd: string,
    base: string | undefined,
    save: { repoRoot: string; patchPath: string },
  ) => resetRaw(runGit(f), cwd, base, save);
  const boom: ExecFn = async () => {
    throw new Error("fatal: bad object");
  };
  const unreadable = await commitsAheadOfBase(boom, "/w", SHA);
  assert("unreadable" in unreadable, "#1016: a git error is an unreadable check, not zero commits");
  const zero = await commitsAheadOfBase(stubExec("0", []), "/w", SHA);
  assert(
    "commits" in zero && zero.commits === 0,
    "#1016: zero is reported as zero only when git returned 0",
  );

  // Finding 1: an unreadable check never untrusts a green — it is kept, and a
  // handoff note names the workstream and the git error.
  const kept = await trustedPreservedGreens(new Set(["task-x"]), {
    execFn: boom,
    worktrees: { "task-x": "/w" },
    baseFor: () => SHA,
  });
  assert(kept.kept.has("task-x"), "#1016: an unreadable check keeps the preserved green");
  assert(
    kept.notes.length === 1 &&
      /task-x/.test(kept.notes[0] ?? "") &&
      /fatal: bad object/.test(kept.notes[0] ?? ""),
    "#1016: the kept-unreadable note names the workstream and the git error",
  );
  const zeroCommits = await trustedPreservedGreens(new Set(["task-x"]), {
    execFn: stubExec("0", []),
    worktrees: { "task-x": "/w" },
    baseFor: () => SHA,
  });
  assert(zeroCommits.kept.size === 0, "#1016: a green with zero commits (git said 0) is not kept");
  const noBase = await trustedPreservedGreens(new Set(["task-x"]), {
    execFn: stubExec("3", []),
    worktrees: { "task-x": "/w" },
    baseFor: () => undefined,
  });
  assert(noBase.kept.size === 0, "#1016: an invalid/absent base fails closed, never kept as green");

  // Finding 2: the reset accepts ONLY a 40-hex sha; nothing reaches git otherwise.
  const SAVE_W = { repoRoot: "/r", patchPath: "/r/tmp/w.patch" };
  for (const bad of ["-x", "--hard", "main", "abc123", `${SHA}\n`]) {
    const calls: string[] = [];
    const refused = await resetWorktreeToBase(
      stubExec("0", calls),
      "/r/.worktrees/w",
      bad,
      SAVE_W,
    ).then(
      () => false,
      (err: Error) => /40-hex/.test(err.message),
    );
    assert(
      refused && calls.length === 0,
      `#1016: reset refuses base ${JSON.stringify(bad)} before git`,
    );
  }
  // Finding 2: a worktree with commits ahead is never reset, and an unreadable
  // check is never a licence to reset.
  const ahead: string[] = [];
  const aheadRefused = await resetWorktreeToBase(
    stubExec("2", ahead),
    "/r/.worktrees/w",
    SHA,
    SAVE_W,
  ).then(
    () => false,
    (err: Error) => /2 commit\(s\) ahead/.test(err.message),
  );
  assert(
    aheadRefused && !ahead.some((c) => c.startsWith("git reset")),
    "#1016: a worktree with commits ahead of base is never reset",
  );
  const unreadableRefused = await resetWorktreeToBase(boom, "/r/.worktrees/w", SHA, SAVE_W).then(
    () => false,
    (err: Error) => /unreadable/.test(err.message),
  );
  assert(unreadableRefused, "#1016: an unreadable commit check refuses the reset");

  // Finding 3: a zero-commit reset is reset --hard + clean -fd, with no stash.
  const seen: string[] = [];
  await resetWorktreeToBase(stubExec("0", seen), "/r/.worktrees/w", SHA, SAVE_W);
  assert(
    seen.includes(`git reset --hard ${SHA}`) &&
      seen.some((c) => c.startsWith("git clean -fd")) &&
      !seen.some((c) => c.includes("stash")),
    "#1016: the reset is git reset --hard <sha> + git clean -fd, never a stash",
  );

  // The retry: a failed workstream with commits ahead fails with its reason and
  // is not re-run; the green is kept.
  const calls: string[] = [];
  const res = await runIndependentFanout({
    independent: ["task-a", "task-x"],
    preserved: new Set(["task-a"]),
    skip: [],
    runAt: async (id) => {
      calls.push(id);
      return { id, ok: false };
    },
    resetFor: (id) => resetWorktreeToBase(stubExec("1", []), `/r/.worktrees/${id}`, SHA, SAVE_W),
    verdicts: [],
    multi: true,
  });
  assert(
    calls.join() === "task-x" && res.some((v) => v.id === "task-a" && v.ok),
    "#1016: a kept green is never re-run, and a reset refusal fails its workstream",
  );
  const refusedVerdict = res.find((v) => v.id === "task-x");
  assert(
    refusedVerdict !== undefined &&
      !refusedVerdict.ok &&
      /ahead of base/.test(refusedVerdict.reason ?? ""),
    "#1016: the refused workstream's verdict carries the named reason",
  );
}

// #1016 — a crash-resume green is trusted only with commits ahead of base, and
// a re-run never touches a preserved green's HEAD.
{
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { trustedPreservedGreens, runIndependentFanout, greenCountsAsWork } = await import(
    "../src/work-develop-retry.ts"
  );
  const { resetWorktreeToBase: resetRaw, runGit } = await import("../src/work-develop-git.ts");
  const resetWorktreeToBase = (
    f: ExecFn,
    cwd: string,
    base: string | undefined,
    save: { repoRoot: string; patchPath: string },
  ) => resetRaw(runGit(f), cwd, base, save);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "greens-1016-"));
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const mkRepo = async (name: string) => {
    const d = path.join(dir, ".worktrees", name);
    await fs.mkdir(d, { recursive: true });
    git(d, ["init", "-q"]);
    git(d, ["commit", "--allow-empty", "-qm", "base"]);
    return d;
  };
  const save = (name: string) => ({
    repoRoot: dir,
    patchPath: path.join(dir, "tmp", `${name}.patch`),
  });
  const exists = (p: string) =>
    fs.stat(p).then(
      () => true,
      () => false,
    );
  const dirA = await mkRepo("a");
  const dirB = await mkRepo("b");
  const base = git(dirA, ["rev-parse", "HEAD"]);
  git(dirA, ["commit", "--allow-empty", "-qm", "work"]);
  const headA = git(dirA, ["rev-parse", "HEAD"]);
  // The production executor: argv commands run via execFile (no shell).
  const { execp: execFn } = await import("../src/work-driver-verify.ts");
  const kept = await trustedPreservedGreens(new Set(["a", "b"]), {
    execFn,
    worktrees: { a: dirA, b: dirB },
    baseFor: () => base,
  });
  assert(
    [...kept.kept].join() === "a",
    "#1016: falsely-ok b (no commit ahead of base) is not preserved; a is",
  );

  const calls: string[] = [];
  const attempts: Record<string, number> = {};
  const res = await runIndependentFanout({
    independent: ["a", "b"],
    preserved: new Set(["a"]),
    skip: [],
    verdicts: [],
    multi: true,
    resetFor: async () => undefined,
    runAt: async (id) => {
      calls.push(id);
      attempts[id] = (attempts[id] ?? 0) + 1;
      return { id, ok: id !== "b" || attempts[id] > 1 };
    },
  });
  const headAfter = git(dirA, ["rev-parse", "HEAD"]);
  assert(headAfter === headA, "#1016: green workstream a's HEAD SHA is unchanged across the retry");
  assert(!calls.includes("a"), "#1016: green workstream a is never re-dispatched");
  assert(calls.filter((c) => c === "b").length === 2, "#1016: failed b is re-run exactly once");
  assert(
    res.length === 2 && res.every((v) => v.ok),
    "#1016: the returned verdicts carry a (kept) and b (retried green)",
  );

  // Retry hygiene: uncommitted developer edits are NEVER reset — the reset
  // refuses and the edits stay on disk for the #622 safety net. A clean
  // worktree resets to its base with no stash entry left behind.
  const baseB = git(dirB, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(dirB, "partial.txt"), "half-written");
  const patchB = path.join(dir, "tmp", "b.patch");
  const savedB = await resetWorktreeToBase(execFn, dirB, baseB, save("b"));
  const savedText = await fs.readFile(patchB, "utf8").catch(() => "");
  assert(
    savedB === patchB && savedText.includes("partial.txt"),
    "#1016: a reset saves uncommitted edits to the patch before resetting",
  );
  assert(
    !(await exists(path.join(dirB, "partial.txt"))),
    "#1016: the reset removes the saved edit from the tree",
  );
  assert(git(dirB, ["stash", "list"]) === "", "#1016: the retry reset leaves no stash entry");
  assert(
    git(dirB, ["rev-parse", "HEAD"]) === baseB,
    "#1016: the failed worktree is reset to its base SHA",
  );
  // A worktree with a commit ahead of base is never reset: HEAD and the commit survive.
  git(dirB, ["commit", "--allow-empty", "-qm", "committed work"]);
  const headB = git(dirB, ["rev-parse", "HEAD"]);
  const aheadRefused = await resetWorktreeToBase(execFn, dirB, baseB, save("b2")).then(
    () => false,
    () => true,
  );
  assert(
    aheadRefused && git(dirB, ["rev-parse", "HEAD"]) === headB,
    "#1016: a real worktree with a commit ahead of base is not reset",
  );

  // A throwing retry becomes a failed verdict; the green's verdict survives.
  const thrown = await runIndependentFanout({
    independent: ["a", "b"],
    preserved: new Set(["a"]),
    skip: [],
    verdicts: [],
    multi: true,
    resetFor: async () => undefined,
    runAt: async (id) => {
      if (id === "b" && attempts.b !== undefined) throw new Error("retry exploded");
      attempts[id] = (attempts[id] ?? 0) + 1;
      return { id, ok: false };
    },
  });
  assert(
    thrown.some((v) => v.id === "a" && v.ok) &&
      thrown.some((v) => v.id === "b" && !v.ok && /retry exploded/.test(v.reason ?? "")),
    "#1016: a throwing retry becomes {id, ok:false, reason}; the green verdict survives",
  );
  // #1016 — a zero-commit worktree is green only through commits: the develop
  // step's safety net commits leftover edits BEFORE this check. An empty tree is
  // not green, and a reset never discards uncommitted edits.
  const dirC = await mkRepo("c");
  const baseC = git(dirC, ["rev-parse", "HEAD"]);
  const emptyC = await greenCountsAsWork(execFn, dirC, baseC, "c", "fresh");
  await fs.writeFile(path.join(dirC, "edit.txt"), "uncommitted");
  const dirtyC = await greenCountsAsWork(execFn, dirC, baseC, "c", "fresh");
  assert(
    !emptyC.counts && !dirtyC.counts,
    "#1016: a zero-commit worktree is not green until the safety net commits it",
  );
  // A failed patch write (a file where the patch dir should be) refuses the reset.
  await fs.writeFile(path.join(dir, "blocker"), "x");
  const cRefused = await resetWorktreeToBase(execFn, dirC, baseC, {
    repoRoot: dir,
    patchPath: path.join(dir, "blocker", "c.patch"),
  }).then(
    () => false,
    (err: Error) => /could not save partial work/.test(err.message),
  );
  assert(
    cRefused && (await exists(path.join(dirC, "edit.txt"))),
    "#1016: a failed patch write refuses the reset and the edit stays on disk",
  );
  const cSaved = await resetWorktreeToBase(execFn, dirC, baseC, save("c"));
  const cPatch = await fs.readFile(cSaved ?? "", "utf8").catch(() => "");
  assert(
    cPatch.includes("edit.txt") && !(await exists(path.join(dirC, "edit.txt"))),
    "#1016: an unsaved edit is written to the patch, then reset",
  );
  git(dirC, ["apply", "--binary", cSaved ?? ""]);
  assert(
    (await fs.readFile(path.join(dirC, "edit.txt"), "utf8")) === "uncommitted",
    "#1016: the saved patch re-applies the untracked file with its content",
  );
  // A TRACKED edit under .pi/ is work too: it is saved, then the reset restores the base.
  const dirD = await mkRepo("d");
  await fs.mkdir(path.join(dirD, ".pi"), { recursive: true });
  await fs.writeFile(path.join(dirD, ".pi", "verify-cmd"), "old\n");
  git(dirD, ["add", "-f", ".pi/verify-cmd"]);
  git(dirD, ["commit", "-qm", "track pi"]);
  const baseD = git(dirD, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(dirD, ".pi", "verify-cmd"), "edited\n");
  const dSaved = await resetWorktreeToBase(execFn, dirD, baseD, save("d"));
  const dPatch = await fs.readFile(dSaved ?? "", "utf8").catch(() => "");
  assert(
    dPatch.includes("+edited"),
    "#1016: a tracked .pi/ edit is saved to the patch before reset",
  );
  assert(
    (await fs.readFile(path.join(dirD, ".pi", "verify-cmd"), "utf8")) === "old\n",
    "#1016: the reset restores the tracked .pi/ file to its base content",
  );
  git(dirD, ["apply", "--binary", dSaved ?? ""]);
  assert(
    (await fs.readFile(path.join(dirD, ".pi", "verify-cmd"), "utf8")) === "edited\n",
    "#1016: the saved tracked .pi/ patch re-applies the edit",
  );
  const outside = await resetWorktreeToBase(execFn, dir, baseC, save("o")).then(
    () => false,
    (err: Error) => /not inside/.test(err.message),
  );
  assert(outside, "#1016: a path outside .worktrees/ is refused before git runs");
  // Finding 1: an invalid base or an unreadable check never makes a FRESH green
  // count, even with uncommitted edits present; a resume green is still kept.
  const boomFn: ExecFn = async () => {
    throw new Error("fatal: bad object");
  };
  const invalid = await greenCountsAsWork(execFn, dirC, "main", "c", "fresh");
  const invalidResume = await greenCountsAsWork(execFn, dirC, undefined, "c", "resume");
  assert(!invalidResume.counts, "#1016: an absent base never keeps a preserved green");
  const unreadableFresh = await greenCountsAsWork(boomFn, dirC, baseC, "c", "fresh");
  const unreadableResume = await greenCountsAsWork(boomFn, dirC, baseC, "c", "resume");
  assert(
    !invalid.counts && !unreadableFresh.counts && unreadableResume.counts,
    "#1016: an invalid base or unreadable check fails a fresh green; a resume green is kept",
  );
  await fs.rm(dir, { recursive: true, force: true });
}

// Finding 2: a downgraded commitless green is ONE attempt, not a retry.
{
  const { fanoutVerdictLines } = await import("../src/work-driver-handoff-fanout.ts");
  const { GREEN_DOWNGRADE } = await import("../src/work-develop-greens.ts");
  const st = {
    schemaVersion: 1,
    issue: 1,
    updatedAt: 0,
    pipelineState: { currentStep: "develop", inFlightJobIds: [] },
    eventLog: [
      { kind: "step-started", step: "develop", at: 1 },
      {
        kind: "branch-completed",
        step: "develop",
        workstreamId: "task-x",
        ok: true,
        ms: 1,
        at: 2,
      },
      {
        kind: "branch-completed",
        step: "develop",
        workstreamId: "task-x",
        ok: false,
        ms: 0,
        at: 3,
        error: GREEN_DOWNGRADE,
        downgrade: true,
      },
    ],
  } as unknown as WorkState;
  const texts = fanoutVerdictLines(st).map((l) => l.text);
  assert(
    texts.join() === `task-x: FAIL \u2014 ${GREEN_DOWNGRADE}`,
    `#1016: a first-try commitless green is FAIL with its reason, not 'after retry' (got ${texts.join()})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
