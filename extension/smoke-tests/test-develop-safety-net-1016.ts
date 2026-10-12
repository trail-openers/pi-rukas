/**
 * #1016 — the green rule and the #622 safety net compose correctly. Real git
 * worktrees: a developer that leaves edits UNCOMMITTED is still work (the
 * safety net commits them after the fan-out), a failed workstream's partial
 * edits are saved to a patch before its retry reset, and a file whose name is
 * shell syntax is committed as a literal name without running anything.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetWorktreeToBase as resetRaw, runGit } from "../src/work-develop-git.ts";
import { greenCountsAsWork, runIndependentFanout } from "../src/work-develop-retry.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { applySafetyNet, safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import { execp as execFn } from "../src/work-driver-verify.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

// The fixture's execp is the ExecFn; the git primitives take the GitExec adapter.
const resetWorktreeToBase = (
  f: typeof execFn,
  cwd: string,
  base: string | undefined,
  save: { repoRoot: string; patchPath: string },
) => resetRaw(runGit(f), cwd, base, save);

const dir = await mkdtemp(path.join(tmpdir(), "safety-1016-"));
try {
  const ids = ["task-a", "task-b", "task-c"];
  const shas = await makeBaseWorktrees(dir, ids);
  const wt = (id: string) => path.join(dir, ".worktrees", id);
  const patchFor = (id: string) => path.join(dir, "tmp", "issue-1", `retry-${id}-1.patch`);
  const save = (id: string) => ({ repoRoot: dir, patchPath: patchFor(id) });

  // task-a: a committed green.
  await writeFile(path.join(wt("task-a"), "a.rs"), "a");
  gitIn(wt("task-a"), ["add", "a.rs"]);
  gitIn(wt("task-a"), ["commit", "-qm", "a"]);

  // task-b: the developer left its edit UNCOMMITTED (zero commits ahead).
  await writeFile(path.join(wt("task-b"), "b.rs"), "b");
  // The develop step's runAt commits the leftover work BEFORE the green check.
  const sn = await safetyNetWorktree("task-b", dir, wt("task-b"), shas["task-b"] ?? "", execFn, []);
  assert(
    sn?.kind === "safety-net-commit",
    "#1016: the per-worktree safety net commits task-b first",
  );
  const green = await greenCountsAsWork(execFn, wt("task-b"), shas["task-b"]);
  assert(green.counts, "#1016: the safety-net commit makes task-b a green");

  // The same safety-net call develop makes after the fan-out.
  const state = {
    schemaVersion: 1,
    issue: 1,
    updatedAt: 0,
    eventLog: [],
    pipelineState: {
      baseSha: shas["task-a"],
      workstreamBaseShas: shas,
      worktrees: { "task-a": wt("task-a"), "task-b": wt("task-b") },
    },
  } as unknown as WorkState;
  const after = await applySafetyNet(
    { repoRoot: dir, verifyExecFn: execFn } as unknown as DriverContext,
    state,
  );
  assert(after.eventLog.length === 0, "#1016: the post-fan-out sweep finds nothing left to commit");
  assert(
    gitIn(wt("task-b"), ["rev-list", "--count", `${shas["task-b"]}..HEAD`]) === "1",
    "#1016: task-b is one commit ahead of its base once the safety net has run",
  );
  assert(existsSync(path.join(wt("task-b"), "b.rs")), "#1016: task-b's edit survives the commit");

  // task-c: a dispatch failed with a partial edit. The retry saves it, then resets.
  await writeFile(path.join(wt("task-c"), "c.rs"), "partial");
  const patch = await resetWorktreeToBase(execFn, wt("task-c"), shas["task-c"], save("task-c"));
  assert(patch === patchFor("task-c"), "#1016: the partial edit is saved to the retry patch");
  assert(
    (await readFile(patchFor("task-c"), "utf8")).includes("+partial"),
    "#1016: the saved patch contains the partial edit",
  );
  assert(!existsSync(path.join(wt("task-c"), "c.rs")), "#1016: task-c is reset after the save");

  // Through the fan-out: task-a is green, task-c fails once and is re-run once.
  await writeFile(path.join(wt("task-c"), "c2.rs"), "partial-2");
  const notes: string[] = [];
  const res = await runIndependentFanout({
    independent: ["task-a", "task-c"],
    preserved: new Set(),
    skip: [],
    verdicts: [],
    multi: true,
    runAt: async (id) => ({ id, ok: id === "task-a" }),
    // A second save needs its own path: the first patch exists, and a save never overwrites.
    resetFor: async (id) => ({
      attempt: 2,
      patch: await resetWorktreeToBase(execFn, wt(id), shas[id], {
        repoRoot: dir,
        patchPath: path.join(dir, "tmp", "issue-1", `retry-${id}-2.patch`),
      }),
    }),
    notes,
  });
  const c = res.find((v) => v.id === "task-c");
  assert(c !== undefined && !c.ok, "#1016: task-c's retry runs and its second failure stands");
  assert(
    notes.some(
      (n) =>
        n.startsWith("task-c: retry attempt 2: partial work saved to") &&
        n.includes("retry-task-c-2.patch"),
    ),
    "#1016: the handoff note names the saved patch path",
  );

  // Injection: shell syntax in file names is a literal name, never executed.
  const dir2 = await mkdtemp(path.join(tmpdir(), "safety-inj-1016-"));
  try {
    const shas2 = await makeBaseWorktrees(dir2, ["task-x"]);
    const wx = path.join(dir2, ".worktrees", "task-x");
    await writeFile(path.join(wx, "$(touch pwned)"), "x");
    await writeFile(path.join(wx, "`touch pwned2`"), "x");
    // #1016 — a non-ASCII name is C-quoted by plain porcelain; -z must keep it whole.
    await writeFile(path.join(wx, "café.txt"), "x");
    const ev = await safetyNetWorktree("task-x", dir2, wx, shas2["task-x"] ?? "", execFn, []);
    assert(ev?.kind === "safety-net-commit", "#1016: the injection-named files are committed");
    // -z: ls-tree would C-quote the non-ASCII name and hide the literal bytes.
    const names = gitIn(wx, ["ls-tree", "-z", "--name-only", "HEAD"]).split("\0").join("\n");
    assert(
      names.includes("$(touch pwned)") &&
        names.includes("`touch pwned2`") &&
        names.includes("café.txt"),
      "#1016: the files are committed under their literal names",
    );
    assert(
      !existsSync(path.join(wx, "pwned")) && !existsSync(path.join(wx, "pwned2")),
      "#1016: no command runs for the injection-named files",
    );
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }

  // #1016 containment: a state path that is the repo root itself (outside
  // `.worktrees/`) is refused — no commit lands there and a note records why.
  gitIn(dir, ["init", "-q"]);
  gitIn(dir, ["commit", "--allow-empty", "-qm", "root"]);
  const headBefore = gitIn(dir, ["rev-parse", "HEAD"]);
  await writeFile(path.join(dir, "root-dirt.txt"), "dirt");
  const refusalNotes: string[] = [];
  const refused = await safetyNetWorktree(
    "task-r",
    dir,
    dir,
    shas["task-a"] ?? "",
    execFn,
    refusalNotes,
  );
  assert(refused === undefined, "#1016: a repo-root path yields no safety-net commit");
  assert(
    gitIn(dir, ["rev-parse", "HEAD"]) === headBefore,
    "#1016: no commit lands on the repo root",
  );
  assert(
    refusalNotes.some((n) => n.startsWith("task-r: safety net refused")),
    "#1016: the refusal is recorded as a note",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

// #1016 — a developer commit plus a second, UNCOMMITTED edit: the leftover edit
// is committed by the safety net, never silently dropped from the PR.
{
  const dir3 = await mkdtemp(path.join(tmpdir(), "safety-second-1016-"));
  try {
    const shas3 = await makeBaseWorktrees(dir3, ["task-s"]);
    const ws = path.join(dir3, ".worktrees", "task-s");
    await writeFile(path.join(ws, "first.ts"), "1");
    gitIn(ws, ["add", "first.ts"]);
    gitIn(ws, ["commit", "-qm", "first"]);
    await writeFile(path.join(ws, "second.ts"), "2");
    const ev = await safetyNetWorktree("task-s", dir3, ws, shas3["task-s"] ?? "", execFn, []);
    assert(ev?.kind === "safety-net-commit", "#1016: a leftover edit after a commit is committed");
    assert(
      gitIn(ws, ["rev-list", "--count", `${shas3["task-s"]}..HEAD`]) === "2",
      "#1016: the worktree holds both the developer's commit and the safety-net commit",
    );
    assert(
      gitIn(ws, ["show", "--name-only", "--format=", "HEAD"]) === "second.ts",
      "#1016: the safety-net commit holds exactly the leftover second.ts",
    );
  } finally {
    await rm(dir3, { recursive: true, force: true });
  }
}

// #1016 — the post-fan-out sweep commits only ok workstreams, and a leftover
// commit beside a developer commit is noted with its paths.
{
  const dir4 = await mkdtemp(path.join(tmpdir(), "safety-scope-1016-"));
  try {
    const shas4 = await makeBaseWorktrees(dir4, ["task-f"]);
    const wf = path.join(dir4, ".worktrees", "task-f");
    await writeFile(path.join(wf, "dev.ts"), "1");
    gitIn(wf, ["add", "dev.ts"]);
    gitIn(wf, ["commit", "-qm", "dev"]);
    await writeFile(path.join(wf, "leftover.ts"), "2");
    const state = {
      schemaVersion: 1,
      issue: 1,
      updatedAt: 0,
      eventLog: [],
      pipelineState: {
        baseSha: shas4["task-f"],
        workstreamBaseShas: shas4,
        worktrees: { "task-f": wf },
        plumbReports: [],
      },
    } as unknown as WorkState;
    const ctx4 = { repoRoot: dir4, verifyExecFn: execFn } as unknown as DriverContext;
    const skipped = await applySafetyNet(ctx4, state, new Set<string>());
    assert(skipped.eventLog.length === 0, "#1016: a workstream outside the ok set is not swept");
    assert(
      gitIn(wf, ["rev-list", "--count", `${shas4["task-f"]}..HEAD`]) === "1",
      "#1016: the failed workstream's leftover edit stays uncommitted",
    );
    const swept = await applySafetyNet(ctx4, state, new Set(["task-f"]));
    assert(swept.eventLog.some((e) => e.kind === "safety-net-commit"), "#1016: an ok workstream is swept");
    assert(
      (swept.pipelineState.plumbReports ?? []).some((r) => /leftover uncommitted path\(s\) after 1 developer commit/.test(r.body)),
      "#1016: a leftover commit beside a developer commit is noted with its count",
    );
  } finally {
    await rm(dir4, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
