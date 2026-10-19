#!/usr/bin/env bun
/**
 * #1676 — one explanation for a deferred protected edit.
 *
 * A develop change that edits a protected, ungranted path, and that path is
 * also in the workstream's outOfScope fence, used to produce TWO failures: the
 * protected-path gate's halt (with its --allow-protected instruction) and the
 * scope gate's "declared fence violated". The protected halt is the single
 * explanation, so the scope gate must not repeat it for a path the protected
 * gate already refused. Other fence hits still block.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecFn } from "../src/work-develop-git.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import type { FenceViolationRecord } from "../src/work-driver-scope-fence.ts";
import {
  discardDeferred,
  runProtectedPathGate,
} from "../src/work-driver-verify-develop-protected.ts";
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

const workstreams = {
  default: { id: "default", scope: "b", paths: [SOURCE], outOfScope: [FENCE] },
};
const changed = () => new Map([["default", new Set([FENCE, SOURCE])]]);

// The protected-path gate, as the develop step runs it: no grant, the path edited.
const protectedFailures: string[] = [];
const protectedNotes: string[] = [];
const refused = runProtectedPathGate({
  protectedGateOn: true,
  touchedPaths: [FENCE, SOURCE],
  protectedOnlyPaths: [],
  protectedGrant: [],
  issues: [1676],
  failures: protectedFailures,
  notes: protectedNotes,
});
assert(refused.join() === FENCE, "the protected-path gate returns the ungranted path it refused");
assert(protectedFailures.length === 1, "the protected-path gate records one failure for it");

// Control: without the refusal the scope gate still fences the edit.
const controlFailures: string[] = [];
runScopeFanoutGate(workstreams, changed(), controlFailures, [], undefined, undefined);
assert(
  controlFailures.some((f) => f.includes(FENCE) && f.includes("declared fence violated")),
  "control: with no protected refusal the scope gate blocks the fenced path",
);

// The refusal present: the scope gate adds no second failure for the path.
const scopeFailures: string[] = [];
const scopeNotes: string[] = [];
const fenceRecords: FenceViolationRecord[] = [];
runScopeFanoutGate(workstreams, changed(), scopeFailures, scopeNotes, fenceRecords, undefined, {
  protectedRefused: refused,
});
assert(scopeFailures.length === 0, "the scope gate adds no failure for a refused protected path");
assert(
  scopeNotes.some((n) => n.includes(FENCE) && n.includes("protected-path gate")),
  "the scope gate names the protected-path gate in a note instead",
);
assert(
  fenceRecords.every((r) => r.file !== FENCE),
  "no fence-violation record is written for the refused path",
);
const explanations = [...protectedFailures, ...scopeFailures].filter((f) => f.includes(FENCE));
assert(explanations.length === 1, "the develop step carries exactly one explanation for the edit");

// A non-canonical spelling is the same path: "./.pi/verify-cmd" in the changed set
// is refused once, by the same normaliser that built the refused set.
const spelledFailures: string[] = [];
const spelledNotes: string[] = [];
runScopeFanoutGate(
  workstreams,
  new Map([["default", new Set([`./${FENCE}`, SOURCE])]]),
  spelledFailures,
  spelledNotes,
  undefined,
  undefined,
  { protectedRefused: [`./${FENCE}`] },
);
assert(
  spelledFailures.length === 0 && spelledNotes.some((n) => n.includes(FENCE)),
  "a ./-spelled changed path matches its refused entry: no failure, one note",
);

// #1676 round 3 — git paths are verbatim. A real file named with a parenthetical
// is not an annotation, so refusing it must not exempt the plain path beside it.
const verbatimWs = {
  default: { id: "default", scope: "b", paths: [SOURCE], outOfScope: ["docs/notes"] },
};
const verbatimFailures: string[] = [];
runScopeFanoutGate(
  verbatimWs,
  new Map([["default", new Set(["docs/notes (draft)", "docs/notes"])]]),
  verbatimFailures,
  [],
  undefined,
  undefined,
  { protectedRefused: ["docs/notes (draft)"] },
);
assert(
  verbatimFailures.some((f) => f.includes("out-of-scope path docs/notes \u2014")),
  "(a) an ungranted protected 'docs/notes (draft)' does not exempt a fenced 'docs/notes'",
);

// A changed 'docs/notes (draft)' is a different file from the fenced 'docs/notes':
// no fence hit, so no failure and no sibling or issue-fenced record for it.
const parenFailures: string[] = [];
const parenRecords: FenceViolationRecord[] = [];
runScopeFanoutGate(
  verbatimWs,
  new Map([["default", new Set(["docs/notes (draft)", SOURCE])]]),
  parenFailures,
  [],
  parenRecords,
);
assert(
  parenFailures.length === 0 &&
    parenRecords.every((r) => r.kind === "undeclared" || r.file !== "docs/notes (draft)"),
  "(b) a changed 'docs/notes (draft)' with a fence entry 'docs/notes' is not a false fence violation",
);

// A refusal for a different path does not hide this one.
const otherFailures: string[] = [];
runScopeFanoutGate(workstreams, changed(), otherFailures, [], undefined, undefined, {
  protectedRefused: ["docs/other.md"],
});
assert(
  otherFailures.some((f) => f.includes(FENCE) && f.includes("declared fence violated")),
  "a refusal for another path leaves the fence hit blocking",
);

// The gate off: nothing is refused, so nothing is returned.
const offFailures: string[] = [];
const offRefused = runProtectedPathGate({
  protectedGateOn: false,
  touchedPaths: [FENCE],
  protectedOnlyPaths: [],
  protectedGrant: [],
  issues: [1676],
  failures: offFailures,
  notes: [],
});
assert(
  offRefused.length === 0 && offFailures.length === 0,
  "with the protected gate off nothing is refused",
);

// ------------------------------------------ #1676 backstop: discard a deferred edit

// Real git in a scratch repo: the discard pass is git work, so a fake exec would
// test nothing. Commit identity and signing are pinned so the host config cannot
// make the revert commit fail.
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
  discardDeferred(
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

const NEW = ".github/workflows/new.yml";

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

console.log(`\nexit ${exit}`);
process.exit(exit);
