/**
 * #1016 — the develop-path git transport and the reset/commit safety rules.
 * Real git worktrees for the status/reset/commit behaviour (tracked `.pi/`
 * edits, non-ASCII and spaced names, patch no-overwrite, id validation), and a
 * GitExec fake for the argv-only and no-partial-stage rules.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GitExec,
  resetWorktreeToBase,
  retryPatchPath,
  runGit,
  stagePaths,
  worktreeStatus,
} from "../src/work-develop-git.ts";
import { GREEN_DOWNGRADE } from "../src/work-develop-greens.ts";
import { recordDowngrade, runIndependentFanout } from "../src/work-develop-retry.ts";
import { safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import { execp } from "../src/work-driver-verify.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const execFn = execp;
const dir = await mkdtemp(path.join(tmpdir(), "git-argv-1016-"));
try {
  const ids = ["fail-ws", "green-ws", "names-ws", "keep-ws"];
  const shas = await makeBaseWorktrees(dir, ids);
  const wt = (id: string) => path.join(dir, ".worktrees", id);
  const save = (id: string) => ({
    repoRoot: dir,
    patchPath: path.join(dir, "tmp", "issue-1", `retry-${id}-1.patch`),
  });

  // 1. A tracked .pi/ edit with zero commits on a FAILED workstream is saved.
  await mkdir(path.join(wt("fail-ws"), ".pi"), { recursive: true });
  await writeFile(path.join(wt("fail-ws"), ".pi", "verify-cmd"), "bun test-tracked-edit\n");
  gitIn(wt("fail-ws"), ["add", "-f", ".pi/verify-cmd"]);
  gitIn(wt("fail-ws"), ["commit", "-qm", "track .pi/verify-cmd"]);
  const trackedBase = gitIn(wt("fail-ws"), ["rev-parse", "HEAD"]);
  await writeFile(path.join(wt("fail-ws"), ".pi", "verify-cmd"), "edited by developer\n");
  const patch = await resetWorktreeToBase(
    runGit(execFn),
    wt("fail-ws"),
    trackedBase,
    save("fail-ws"),
  );
  assert(patch !== undefined, "#1016: a tracked .pi/ edit counts as work to save");
  assert(
    (await readFile(patch ?? "", "utf8")).includes("+edited by developer"),
    "#1016: the tracked .pi/ edit is in the saved patch",
  );
  assert(
    gitIn(wt("fail-ws"), ["show", "HEAD:.pi/verify-cmd"]).includes("bun test-tracked-edit"),
    "#1016: the reset reverts the tracked .pi/ edit after saving it",
  );

  // 2. The same tracked .pi/ edit on a GREEN workstream is NEVER committed by the
  //    safety net: .pi/ defines verification, so it goes through the protected-path check.
  await mkdir(path.join(wt("green-ws"), ".pi"), { recursive: true });
  await writeFile(path.join(wt("green-ws"), ".pi", "verify-cmd"), "x\n");
  gitIn(wt("green-ws"), ["add", "-f", ".pi/verify-cmd"]);
  gitIn(wt("green-ws"), ["commit", "-qm", "track"]);
  const greenBase = gitIn(wt("green-ws"), ["rev-parse", "HEAD"]);
  await writeFile(path.join(wt("green-ws"), ".pi", "verify-cmd"), "green edit\n");
  await mkdir(path.join(wt("green-ws"), "tmp"), { recursive: true });
  await writeFile(path.join(wt("green-ws"), "tmp", "scratch.txt"), "scratch");
  const ev = await safetyNetWorktree("green-ws", wt("green-ws"), greenBase, execFn, []);
  assert(ev === undefined, "#1016: the safety net does not commit a tracked .pi/ edit");
  assert(
    gitIn(wt("green-ws"), ["rev-parse", "HEAD"]) === greenBase,
    "#1016: HEAD is unchanged — the .pi/ edit was not committed",
  );
  assert(
    gitIn(wt("green-ws"), ["diff", "--cached", "--name-only"]) === "",
    "#1016: the safety net stages nothing (no .pi/ or tmp/ path)",
  );
  assert(
    gitIn(wt("green-ws"), ["diff", "--name-only"]) === ".pi/verify-cmd",
    "#1016: the tracked .pi/ edit stays on disk, uncommitted, for the protected-path check",
  );

  // 3. Non-ASCII and spaced names round-trip through status -z and the commit.
  await writeFile(path.join(wt("names-ws"), "ä.ts"), "a");
  await writeFile(path.join(wt("names-ws"), "my file.ts"), "b");
  const st = await worktreeStatus(runGit(execFn), wt("names-ws"));
  const paths = Array.isArray(st) ? st.map((e) => e.path).sort() : [];
  assert(
    paths.includes("ä.ts") && paths.includes("my file.ts"),
    "#1016: status -z returns ä.ts and a spaced name verbatim",
  );
  const named = await safetyNetWorktree(
    "names-ws",
    wt("names-ws"),
    shas["names-ws"] ?? "",
    execFn,
    [],
  );
  assert(named?.kind === "safety-net-commit", "#1016: the non-ASCII/spaced names are committed");

  // 4. Patch files are never overwritten; ids and paths are validated.
  await writeFile(path.join(wt("fail-ws"), "again.txt"), "again");
  let refused = false;
  try {
    await resetWorktreeToBase(runGit(execFn), wt("fail-ws"), trackedBase, save("fail-ws"));
  } catch (err) {
    refused = String((err as Error).message).includes("could not save partial work");
  }
  assert(refused, "#1016: a second save to an existing patch path is refused, not overwritten");
  let badId = false;
  try {
    retryPatchPath(path.join(dir, "tmp"), "../evil", 1);
  } catch {
    badId = true;
  }
  assert(badId, "#1016: a workstream id outside [A-Za-z0-9._-] is refused");
  assert(
    retryPatchPath(path.join(dir, "tmp"), "task.a-1", 2).startsWith(
      path.join(dir, "tmp") + path.sep,
    ),
    "#1016: a valid id resolves inside the scratch dir",
  );

  // 5. A first-pass failure carries its reason into the verdicts.
  const fanout = await runIndependentFanout({
    independent: ["x"],
    preserved: new Set(),
    skip: [],
    verdicts: [],
    multi: false,
    runAt: async (id) => ({ id, ok: false, reason: "developer exploded" }),
    resetFor: async () => ({ attempt: 1 }),
  });
  assert(fanout[0]?.reason === "developer exploded", "#1016: the first-pass reason is kept");

  // 6. A downgrade is typed, not inferred from an error prefix.
  const emitted: WorkEvent[] = [];
  recordDowngrade({ emit: (e) => emitted.push(e) }, "x");
  assert(
    emitted[0]?.kind === "branch-completed" &&
      emitted[0].downgrade === true &&
      emitted[0].error === GREEN_DOWNGRADE,
    "#1016: recordDowngrade writes a typed downgrade flag and the reason derived from it",
  );

  // 6b. Untracked driver files under .pi/ and tmp/ survive the reset (clean -e),
  // while a tracked edit is saved, and the saved patch re-applies onto base in a
  // fresh worktree with the edit's content intact.
  const kw = wt("keep-ws");
  await writeFile(path.join(kw, "src.txt"), "base\n");
  gitIn(kw, ["add", "src.txt"]);
  gitIn(kw, ["commit", "-qm", "track src"]);
  const keepBase = gitIn(kw, ["rev-parse", "HEAD"]);
  await writeFile(path.join(kw, "src.txt"), "developer edit\n");
  await mkdir(path.join(kw, ".pi"), { recursive: true });
  await writeFile(path.join(kw, ".pi", "local.txt"), "driver file");
  await mkdir(path.join(kw, "tmp"), { recursive: true });
  await writeFile(path.join(kw, "tmp", "scratch.txt"), "scratch");
  const keepPatch = path.join(dir, "tmp", "issue-1", "keep.patch");
  const savedKeep = await resetWorktreeToBase(runGit(execFn), kw, keepBase, {
    repoRoot: dir,
    patchPath: keepPatch,
  });
  assert(
    savedKeep === keepPatch,
    "#1016: the tracked edit is saved while untracked driver files are excluded",
  );
  assert(
    existsSync(path.join(kw, ".pi", "local.txt")) &&
      existsSync(path.join(kw, "tmp", "scratch.txt")),
    "#1016: untracked .pi/ and tmp/ driver files survive the reset",
  );
  assert(
    !(await readFile(keepPatch, "utf8")).includes("local.txt"),
    "#1016: untracked driver files are not in the saved patch",
  );
  assert(
    gitIn(kw, ["show", "HEAD:src.txt"]) === "base",
    "#1016: the tracked file is reset to base",
  );
  const reapply = path.join(dir, ".worktrees", "keep-reapply");
  gitIn(kw, ["worktree", "add", "--detach", reapply, keepBase]);
  gitIn(reapply, ["apply", "--binary", keepPatch]);
  assert(
    (await readFile(path.join(reapply, "src.txt"), "utf8")) === "developer edit\n",
    "#1016: the saved patch re-applies onto base in a fresh worktree with the edit intact",
  );

  // 7. GitExec fake: argv only, one add per ≤500 chunk, and no commit after a failed add.
  const calls: string[][] = [];
  // The subcommand follows the global `--literal-pathspecs` option.
  const subOf = (a: string[]) => a.find((x) => !x.startsWith("--literal-pathspecs"));
  const fake: GitExec = async (args) => {
    calls.push(args);
    if (subOf(args) === "add" && args.includes("bad.ts")) throw new Error("add refused");
    return { stdout: "" };
  };
  const many = Array.from({ length: 1200 }, (_, i) => `f${i}.ts`);
  await stagePaths(fake, "/w", many);
  assert(
    calls.length === 3 && calls.every((c) => subOf(c) === "add"),
    "#1016: 1200 paths stage in 3 argv chunks, no per-file spawns",
  );
  // The safety net over the same fake: one dirty path, whose add fails.
  const seen: string[][] = [];
  const stub = (async (_cmd: string, o: { argv: string[]; cwd: string }) => {
    seen.push(o.argv);
    const sub = subOf(o.argv);
    if (sub === "status") return { stdout: "?? bad.ts\0" };
    if (sub === "rev-list") return { stdout: "0\n" };
    if (sub === "add") throw new Error("add refused");
    return { stdout: "" };
  }) as unknown as typeof execFn;
  const notes: string[] = [];
  const failedAdd = await safetyNetWorktree("w", dir, trackedBase, stub, notes);
  assert(failedAdd === undefined, "#1016: no commit event when a git add fails");
  assert(
    notes.some((n) => n.includes("git add failed") && n.includes("add refused")),
    "#1016: a failed add is recorded as a note with the git error",
  );
  assert(
    !seen.some((a) => subOf(a) === "commit"),
    "#1016: no git commit is attempted after a failed add",
  );
  assert(
    seen.every((a) => Array.isArray(a) && a.length > 0),
    "#1016: every call is argv",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
