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
      pipelineState: { currentStep: "develop", inFlightJobIds: ["j1"], ...over },
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

{
  // Finding 1: a crash-resume green with no commit ahead of base is NOT kept
  // and is re-dispatched; a green with commits is kept and never re-run.
  const { trustedGreens, runIndependentFanout } = await import("../src/work-develop-retry.ts");
  const trusted = await trustedGreens(new Set(["task-a", "task-x"]), async (id) => id === "task-a");
  assert([...trusted].join() === "task-a", "#1016: falsely-ok task-x (no commits) is not trusted");
  const calls: string[] = [];
  await runIndependentFanout({
    independent: ["task-a", "task-x"],
    preserved: trusted,
    skip: [],
    runAt: async (id) => {
      calls.push(id);
      return { id, ok: true };
    },
    resetFor: async () => {},
    verdicts: [],
    multi: true,
  });
  assert(
    calls.join() === "task-x",
    "#1016: only the untrusted workstream is dispatched; trusted green task-a is never re-run",
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
  const execFn = promisify(exec) as never;
  const kept = await trustedPreservedGreens(new Set(["a", "b"]), {
    execFn,
    worktrees: { a: dirA, b: dirB },
    baseFor: () => base,
  });
  assert(
    [...kept].join() === "a",
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
    res.results.every((r) => r.ok),
    "#1016: after the one retry, b is green",
  );
  assert(
    res.verdicts.length === 2 && res.verdicts.every((v) => v.ok),
    "#1016: the returned verdicts carry a (kept) and b (retried green)",
  );

  // Retry hygiene: partial edits from the failed attempt are gone after reset.
  await fs.writeFile(path.join(dirB, "partial.txt"), "half-written");
  await fs.writeFile(path.join(dirB, "README.md"), "tracked edit");
  git(dirB, ["add", "README.md"]);
  git(dirB, ["commit", "-qm", "tracked"]);
  const baseB = git(dirB, ["rev-parse", "HEAD~1"]);
  await fs.writeFile(path.join(dirB, "README.md"), "dirty edit");
  await resetWorktreeToBase(execFn, dirB, baseB);
  const leftover = await fs.stat(path.join(dirB, "partial.txt")).then(
    () => true,
    () => false,
  );
  assert(!leftover, "#1016: untracked partial edits are removed before the retry");
  assert(
    git(dirB, ["rev-parse", "HEAD"]) === baseB,
    "#1016: the failed worktree is reset to its base SHA",
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
    thrown.verdicts.some((v) => v.id === "a" && v.ok) &&
      thrown.verdicts.some((v) => v.id === "b" && !v.ok && /retry exploded/.test(v.reason ?? "")),
    "#1016: a throwing retry becomes {id, ok:false, reason}; the green verdict survives",
  );
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
