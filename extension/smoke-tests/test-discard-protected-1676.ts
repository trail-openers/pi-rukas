#!/usr/bin/env bun
/**
 * #1676 backstop — the discard pass for an edit to a DEFERRED protected path.
 *
 * Real git in scratch repos: the discard is git work, so a fake exec would test
 * nothing. Covers the committed, uncommitted, rename, symlink and directory shapes
 * the pass must refuse or revert, and the empty-net-diff result the develop loop
 * reads. Split from test-scope-fence-protected-1676.ts to keep both under the cap.
 */

import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecFn } from "../src/work-develop-git.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { discardEdits, runProtectedPathGate } from "../src/work-driver-verify-develop-protected.ts";
import type { WorkState } from "../src/workflow-state-schema.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FENCE = ".pi/verify-cmd";
const SOURCE = "extension/src/b.ts";
const NEW = ".github/workflows/new.yml";

// Commit identity and signing are pinned so the host config cannot make the
// revert commit fail.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
const execAsync = promisify(execFile);
const realExec = (async (_cmd: string, opts: { argv?: string[]; cwd: string }) => {
  const { stdout, stderr } = await execAsync("git", opts.argv ?? [], {
    cwd: opts.cwd,
    env: gitEnv,
  });
  return { stdout, stderr };
}) as unknown as ExecFn;

/** The pre-loop discard pass in the object shape these cases were written in: the
 * deferral and base go in the state, the operator grant in the context. */
const discardDeferredProtectedEdits = (a: {
  execFn: ExecFn;
  worktrees: Record<string, string>;
  baseFor: (id: string) => string | undefined;
  deferred: readonly string[];
  protectedGrant: readonly string[] | undefined;
  failures: string[];
  notes: string[];
}) =>
  discardEdits(
    true,
    a.execFn,
    a.worktrees,
    {
      pipelineState: { baseSha: a.baseFor("default"), deferredProtected: [...a.deferred] },
    } as unknown as WorkState,
    { protectedGrant: a.protectedGrant } as unknown as CycleContext,
    a.failures,
    a.notes,
  );

/** A scratch repo with the gate file and a source file, committed as the base. */
function repoAtBase(): { dir: string; base: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "protected-discard-1676-"));
  git(dir, "init", "-q");
  mkdirSync(path.join(dir, ".pi"), { recursive: true });
  mkdirSync(path.join(dir, "extension/src"), { recursive: true });
  writeFileSync(path.join(dir, FENCE), "base-gate\n");
  writeFileSync(path.join(dir, SOURCE), "base-src\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

// 1. A COMMITTED edit to the deferred path is reverted by a revert commit: no
// failure, the file is back at base, and the branch's net diff no longer has it.
{
  const { dir, base } = repoAtBase();
  writeFileSync(path.join(dir, FENCE), "dev-edit\n");
  git(dir, "commit", "-q", "-am", "dev edit to the gate");
  const failures: string[] = [];
  const notes: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [FENCE],
    protectedGrant: [],
    failures,
    notes,
  });
  assert(failures.length === 0, "a committed deferred edit is discarded without a failure");
  assert(
    readFileSync(path.join(dir, FENCE), "utf8") === "base-gate\n",
    "the committed deferred edit is restored to base content",
  );
  assert(
    git(dir, "diff", "--name-only", base, "HEAD") === "",
    "after the revert commit the branch's net diff against base is empty",
  );
  assert(
    notes.some((n) => n.includes(FENCE) && n.includes("operator grant")),
    "a note names the discarded deferred path and the operator grant it needs",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 2. An UNCOMMITTED, untracked deferred file that is absent at base is removed.
{
  const { dir, base } = repoAtBase();
  mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(dir, NEW), "name: x\n");
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [NEW],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(failures.length === 0, "an untracked deferred file is discarded without a failure");
  assert(!existsSync(path.join(dir, NEW)), "an untracked deferred file absent at base is removed");
  assert(git(dir, "status", "--porcelain") === "", "the worktree is clean after the discard");
  rmSync(dir, { recursive: true, force: true });
}

// 3. A committed edit to a path that is NOT deferred is left alone, and the
// protected-path gate still halts on it.
{
  const { dir, base } = repoAtBase();
  writeFileSync(path.join(dir, FENCE), "dev-edit\n");
  git(dir, "commit", "-q", "-am", "edit an ungranted, non-deferred path");
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [NEW],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    readFileSync(path.join(dir, FENCE), "utf8") === "dev-edit\n",
    "an edit to a non-deferred path is not reverted by the discard pass",
  );
  const touched = git(dir, "diff", "--name-only", base, "HEAD").split("\n");
  const halts: string[] = [];
  const refused = runProtectedPathGate({
    protectedGateOn: true,
    touchedPaths: touched,
    protectedOnlyPaths: [],
    protectedGrant: [],
    issues: [1676],
    failures: halts,
    notes: [],
  });
  assert(
    refused.join() === FENCE && halts.length === 1,
    "a non-deferred ungranted protected edit still halts the protected-path gate",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 4. A restore that cannot run (the worktree is not a repository) is a failure.
{
  const notRepo = mkdtempSync(path.join(tmpdir(), "protected-discard-1676-norepo-"));
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: notRepo },
    baseFor: () => "0123456789abcdef0123456789abcdef01234567",
    deferred: [FENCE],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && failures[0]?.includes("could not discard"),
    "a restore that cannot run halts with a named failure, never a silent pass",
  );
  rmSync(notRepo, { recursive: true, force: true });
}

// 5. A committed rename OUT of a deferred path is refused: discarding only the
// deferred side would leave its content under the unprotected name.
{
  const { dir, base } = repoAtBase();
  git(dir, "mv", FENCE, "extension/src/moved.sh");
  git(dir, "commit", "-q", "-m", "move the gate aside");
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [FENCE],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && failures[0]?.includes("rename pairs"),
    "a committed rename out of a deferred path halts instead of discarding one side",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 6. A committed rename INTO a deferred path is refused: discarding the destination
// alone would leave the source deleted on the branch.
{
  const { dir, base } = repoAtBase();
  mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  git(dir, "mv", SOURCE, NEW);
  git(dir, "commit", "-q", "-m", "move a source into a workflow");
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [NEW],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && failures[0]?.includes("rename pairs"),
    "a committed rename into a deferred path halts instead of deleting the source",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 7. A staged rename out of a deferred path is refused too (index-side rename).
{
  const { dir, base } = repoAtBase();
  git(dir, "mv", FENCE, "extension/src/staged.sh");
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [FENCE],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && failures[0]?.includes("rename pairs"),
    "a staged rename out of a deferred path halts",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 8. A deferred path under a symlinked directory is refused before any removal.
{
  const { dir, base } = repoAtBase();
  const outside = mkdtempSync(path.join(tmpdir(), "protected-discard-1676-outside-"));
  writeFileSync(path.join(outside, "victim.yml"), "keep\n");
  symlinkSync(outside, path.join(dir, "linkdir"));
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: ["linkdir/victim.yml"],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && failures[0]?.includes("is a symlink"),
    "a deferred path under a symlinked directory is refused, not removed through the link",
  );
  assert(
    readFileSync(path.join(outside, "victim.yml"), "utf8") === "keep\n",
    "the file behind the symlink is untouched",
  );
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// 10. A COMMITTED deferred file that is absent at base is removed by a revert
// commit, and the worktree reports an empty net diff with the path counted.
{
  const { dir, base } = repoAtBase();
  mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(dir, NEW), "name: x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "add a workflow");
  const failures: string[] = [];
  const result = await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [NEW],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(failures.length === 0, "a committed deferred new file is discarded without a failure");
  assert(!existsSync(path.join(dir, NEW)), "a committed deferred new file is removed from the worktree");
  assert(
    git(dir, "diff", "--name-only", base, "HEAD") === "",
    "a committed deferred new file leaves no net diff after the revert commit",
  );
  assert(
    result.discarded === 1 && result.discardedPaths.join() === NEW && result.emptied.has("default"),
    "the discard result counts the path and marks the worktree as emptied",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 11. A deferred path that is a directory is refused before anything is removed.
{
  const { dir, base } = repoAtBase();
  mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github/workflows/a.yml"), "a\n");
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [".github/workflows"],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && failures[0]?.includes("only file paths"),
    "a directory-shaped deferred path is refused with a named failure",
  );
  assert(
    existsSync(path.join(dir, ".github/workflows/a.yml")),
    "the files under a refused directory are left untouched",
  );
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
