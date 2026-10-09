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
  async (cmd) => {
    calls.push(cmd);
    return {
      stdout: cmd.startsWith("git rev-list") ? `${count}\n` : "",
      stderr: "",
    };
  };

{
  // Crash-resume greens and the sha-only / tri-state rules, with no git at all.
  const { trustedPreservedGreens, resetWorktreeToBase, runIndependentFanout, commitsAheadOfBase } =
    await import("../src/work-develop-retry.ts");
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

  // Finding 2: the reset accepts ONLY a 40-hex sha; nothing reaches git otherwise.
  for (const bad of ["-x", "--hard", "main", "abc123", `${SHA}\n`]) {
    const calls: string[] = [];
    const refused = await resetWorktreeToBase(stubExec("0", calls), "/w", bad).then(
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
  const aheadRefused = await resetWorktreeToBase(stubExec("2", ahead), "/w", SHA).then(
    () => false,
    (err: Error) => /2 commit\(s\) ahead/.test(err.message),
  );
  assert(
    aheadRefused && !ahead.some((c) => c.startsWith("git reset")),
    "#1016: a worktree with commits ahead of base is never reset",
  );
  const unreadableRefused = await resetWorktreeToBase(boom, "/w", SHA).then(
    () => false,
    (err: Error) => /unreadable/.test(err.message),
  );
  assert(unreadableRefused, "#1016: an unreadable commit check refuses the reset");

  // Finding 3: a zero-commit reset is reset --hard + clean -fd, with no stash.
  const seen: string[] = [];
  await resetWorktreeToBase(stubExec("0", seen), "/w", SHA);
  assert(
    seen.includes(`git reset --hard ${SHA}`) &&
      seen.includes("git clean -fd") &&
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
    resetFor: (id) => resetWorktreeToBase(stubExec("1", []), `/w/${id}`, SHA),
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
  const { execFileSync, exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { trustedPreservedGreens, runIndependentFanout, resetWorktreeToBase } = await import(
    "../src/work-develop-retry.ts"
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "greens-1016-"));
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const mkRepo = async (name: string) => {
    const d = path.join(dir, name);
    await fs.mkdir(d, { recursive: true });
    git(d, ["init", "-q"]);
    git(d, ["commit", "--allow-empty", "-qm", "base"]);
    return d;
  };
  const dirA = await mkRepo("a");
  const dirB = await mkRepo("b");
  const base = git(dirA, ["rev-parse", "HEAD"]);
  git(dirA, ["commit", "--allow-empty", "-qm", "work"]);
  const headA = git(dirA, ["rev-parse", "HEAD"]);
  // Test shim: the real shell exec, typed to the driver's verifyExecFn seam.
  const shell = promisify(exec);
  const execFn: ExecFn = async (cmd, opts) => {
    const r = await shell(cmd, opts);
    return { stdout: String(r.stdout), stderr: String(r.stderr) };
  };
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
    resetFor: async () => {},
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

  // Retry hygiene: a zero-commit failed workstream's uncommitted edits are gone
  // after the reset, and no stash entry is left behind.
  const baseB = git(dirB, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(dirB, "partial.txt"), "half-written");
  await fs.writeFile(path.join(dirB, "README.md"), "tracked edit");
  await resetWorktreeToBase(execFn, dirB, baseB);
  assert(git(dirB, ["stash", "list"]) === "", "#1016: the retry reset leaves no stash entry");
  const leftover = await fs.stat(path.join(dirB, "partial.txt")).then(
    () => true,
    () => false,
  );
  assert(!leftover, "#1016: untracked partial edits are removed before the retry");
  assert(
    git(dirB, ["rev-parse", "HEAD"]) === baseB,
    "#1016: the failed worktree is reset to its base SHA",
  );
  // A worktree with a commit ahead of base is never reset: HEAD and the commit survive.
  git(dirB, ["commit", "--allow-empty", "-qm", "committed work"]);
  const headB = git(dirB, ["rev-parse", "HEAD"]);
  const aheadRefused = await resetWorktreeToBase(execFn, dirB, baseB).then(
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
    resetFor: async () => {},
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
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
