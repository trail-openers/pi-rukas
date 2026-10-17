#!/usr/bin/env bun
/**
 * #1378 (part 1b of 3) — the develop protected-path gate against REAL git.
 *
 * The gate used to see the change set through `git status --porcelain
 * --untracked-files=all` and `git diff --name-only <base>..HEAD`. Neither is
 * `-z`, and between them two classes of protected-path write passed: a COMMITTED
 * rename away from a protected path (`--name-only` collapses a rename to its
 * destination, so the deleted workflow was absent from the change set), and a
 * protected path whose name git C-quotes (the quote-strip left octal bytes
 * literal, so the prose, the grant comparison and SAFE_PATH_RE all saw escape
 * sequences). See the module jsdoc in src/work-driver-protected-paths-read.ts.
 *
 * Every case here runs against REAL git (`realExec`, `gitIn`) rather than a
 * hand-written porcelain string — the pre-existing assertions fed the parser a
 * synthetic `R  old -> new` line, a shape real git never emits, and stayed green
 * through the whole bug.
 *
 * Env hygiene: `PI_ENSEMBLE_PROTECTED_PATHS` and `PI_ENSEMBLE_VERIFY` are saved
 * and restored around every block that touches them (lib/env-scope.ts).
 *
 * Companions: test-work-driver-protected-paths-parse.ts (the two `-z` parsers,
 * unit-pinned) and test-work-driver-protected-paths-read-canary.ts (the
 * read-shape canary + the rename-source scope boundary).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { withEnv } from "./lib/env-scope.ts";
import { realExec } from "./lib/exec-fake.ts";
import { gitIn } from "./lib/git-worktree-fixture.ts";
import { isNulDiffRead, isNulStatusRead } from "./lib/nul-porcelain.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CI = ".github/workflows/ci.yml";

/** A repo with `.github/workflows/ci.yml` + `src/ci.yml` committed; returns its base SHA. */

function seedRepo(dir: string): string {
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, CI), "runs-on: ubuntu\n");
  writeFileSync(path.join(dir, "src/ci.yml"), "placeholder\n");
  writeFileSync(path.join(dir, "src/app.ts"), "export const a = 1;\n");
  gitIn(dir, ["init", "-q", "--initial-branch=main"]);
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "base"]);
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

function developState(dir: string, baseSha: string): WorkState {
  const s = initialState(1378, 1000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { "task-a": dir },
      baseSha,
    },
  };
}

function developCtx(grant?: readonly string[]): DriverContext {
  return {
    host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
    repoRoot: "/nonexistent",
    issue: 1378,
    ...(grant ? { protectedGrant: grant } : {}),
    verifyExecFn: realExec,
  };
}

const protectedFailure = (f: string[]) => f.find((x) => /protected path/.test(x)) ?? "";

// ============================ the gate against real git
//
// Each case builds a real repo, does the real `git mv` / commit, and drives
// `verifyStepOutcome("develop")` through `realExec`.

await withEnv({ PI_ENSEMBLE_VERIFY: "1", PI_ENSEMBLE_PROTECTED_PATHS: undefined }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "protect-z-"));
  try {
    // --- committed rename AWAY from a protected path (the reproduced hole)
    const away = path.join(root, "away");
    mkdirSync(away, { recursive: true });
    const awayBase = seedRepo(away);
    gitIn(away, ["mv", CI, "src/moved.yml"]);
    gitIn(away, ["commit", "-q", "-m", "move the workflow aside"]);
    const awayResult = await verifyStepOutcome(
      developCtx(),
      developState(away, awayBase),
      "develop",
    );
    const awayHit = protectedFailure(awayResult.failures);
    assert(
      !awayResult.ok && awayHit.includes(`— ${CI}`),
      "committed `git mv .github/workflows/ci.yml src/…` HALTS the develop gate, naming the source",
    );
    assert(
      !awayHit.includes("git diff"),
      "...as a protected-path finding, not an unreadable-read failure",
    );

    // --- committed rename INTO a protected path
    const into = path.join(root, "into");
    mkdirSync(into, { recursive: true });
    const intoBase = seedRepo(into);
    gitIn(into, ["mv", "src/app.ts", ".github/workflows/deploy.yml"]);
    gitIn(into, ["commit", "-q", "-m", "move a file into the workflow dir"]);
    const intoResult = await verifyStepOutcome(
      developCtx(),
      developState(into, intoBase),
      "develop",
    );
    assert(
      protectedFailure(intoResult.failures).includes("— .github/workflows/deploy.yml"),
      "committed `git mv src/app.ts .github/workflows/deploy.yml` HALTS, naming the destination",
    );

    // --- uncommitted (staged) rename INTO a protected path
    const unstaged = path.join(root, "unstaged");
    mkdirSync(unstaged, { recursive: true });
    const unstagedBase = seedRepo(unstaged);
    gitIn(unstaged, ["mv", "src/app.ts", ".github/workflows/leak.yml"]);
    const unstagedResult = await verifyStepOutcome(
      developCtx(),
      developState(unstaged, unstagedBase),
      "develop",
    );
    assert(
      protectedFailure(unstagedResult.failures).includes("— .github/workflows/leak.yml"),
      "an UNCOMMITTED rename into a protected path halts too (the status read sees both sides)",
    );

    // --- untracked non-ASCII protected file: the real C-quoting fixture
    const unicode = path.join(root, "unicode");
    mkdirSync(unicode, { recursive: true });
    const unicodeBase = seedRepo(unicode);
    // Precomposed literal — a decomposed "o" + combining diaeresis would be a
    // different byte sequence and a different test of the filesystem encoding.
    const UNICODE_PATH = ".github/workflows/wörkflows.yml";
    writeFileSync(path.join(unicode, UNICODE_PATH), "runs-on: ubuntu\n");
    // Assert the environment is actually exercising the defect: without `-z`,
    // git C-quotes this name. If core.quotePath were off globally the case would
    // pass for the wrong reason.
    const plain = gitIn(unicode, ["status", "--porcelain", "--untracked-files=all"]);
    assert(
      plain.includes("\\303\\266"),
      "fixture precondition: git C-quotes the non-ASCII name in the non-`-z` read",
    );
    const unicodeResult = await verifyStepOutcome(
      developCtx(),
      developState(unicode, unicodeBase),
      "develop",
    );
    const unicodeHit = protectedFailure(unicodeResult.failures);
    assert(
      unicodeHit.includes(UNICODE_PATH),
      "a non-ASCII protected path halts and the failure names the DECODED path",
    );
    assert(
      !unicodeHit.includes("\\303") && !unicodeHit.includes(`"${UNICODE_PATH}`),
      "...with no octal escapes and no surrounding quotes in the operator-facing text",
    );
    assert(
      unicodeHit.includes("cannot be granted") &&
        unicodeHit.includes("PI_ENSEMBLE_PROTECTED_PATHS=0") &&
        !unicodeHit.includes("--restart --allow-protected"),
      "...and the message says it cannot be granted, names the escape hatch, and prints no grant command",
    );

    // --- an ordinary rename between unprotected paths is not an alarm
    const ordinary = path.join(root, "ordinary");
    mkdirSync(ordinary, { recursive: true });
    const ordinaryBase = seedRepo(ordinary);
    writeFileSync(path.join(ordinary, "src/old.ts"), "export const a = 1;\n");
    gitIn(ordinary, ["add", "-A"]);
    gitIn(ordinary, ["commit", "-q", "-m", "add old"]);
    const renameBase = gitIn(ordinary, ["rev-parse", "HEAD"]);
    gitIn(ordinary, ["mv", "src/old.ts", "src/renamed.ts"]);
    gitIn(ordinary, ["commit", "-q", "-m", "rename within src"]);
    const ordinaryResult = await verifyStepOutcome(
      developCtx(),
      developState(ordinary, renameBase),
      "develop",
    );
    assert(
      !ordinaryResult.failures.some((f) => /protected path/.test(f)),
      "an ordinary `git mv src/old.ts src/renamed.ts` adds no protected-path failure",
    );

    // --- committed deletion of a protected file still halts
    const deleted = path.join(root, "deleted");
    mkdirSync(deleted, { recursive: true });
    const deletedBase = seedRepo(deleted);
    gitIn(deleted, ["rm", "-q", CI]);
    gitIn(deleted, ["commit", "-q", "-m", "delete the workflow"]);
    const deletedResult = await verifyStepOutcome(
      developCtx(),
      developState(deleted, deletedBase),
      "develop",
    );
    assert(
      protectedFailure(deletedResult.failures).includes(`— ${CI}`),
      "a committed deletion of a protected file halts (the `D` record, not an R100 collapse)",
    );
    // --- the same deletion with a replacement whose content differs: git does not
    //     pair the two, so the `D` record must halt on its own, not via a rename
    const replaced = path.join(root, "replaced");
    mkdirSync(replaced, { recursive: true });
    const replacedBase = seedRepo(replaced);
    gitIn(replaced, ["rm", "-q", CI]);
    writeFileSync(path.join(replaced, "src/passed.ts"), "export const unrelated = 2;\n");
    gitIn(replaced, ["add", "-A"]);
    gitIn(replaced, ["commit", "-q", "-m", "delete the workflow, add a different file"]);
    const replacedResult = await verifyStepOutcome(
      developCtx(),
      developState(replaced, replacedBase),
      "develop",
    );
    assert(
      protectedFailure(replacedResult.failures).includes(`— ${CI}`),
      "a committed deletion with a differing replacement halts on the `D` record",
    );

    // --- a grant naming the rename SOURCE admits it; one naming only the
    //     destination does not.
    const grantAway = path.join(root, "grant-away");
    mkdirSync(grantAway, { recursive: true });
    const grantAwayBase = seedRepo(grantAway);
    gitIn(grantAway, ["mv", CI, "src/moved.yml"]);
    gitIn(grantAway, ["commit", "-q", "-m", "move aside under a grant"]);
    const grantedSource = await verifyStepOutcome(
      developCtx([CI]),
      developState(grantAway, grantAwayBase),
      "develop",
    );
    assert(
      !grantedSource.failures.some((f) => /protected path/.test(f)),
      "a grant naming the rename SOURCE admits it (#1090 extended to sources)",
    );
    assert(
      grantedSource.notes.some((n) => n.includes("--allow-protected") && n.includes(CI)),
      "...and the admission is recorded as a note naming the moved-aside path",
    );
    const grantedDest = await verifyStepOutcome(
      developCtx(["src/moved.yml"]),
      developState(grantAway, grantAwayBase),
      "develop",
    );
    assert(
      protectedFailure(grantedDest.failures).includes(CI),
      "a grant naming only the DESTINATION does not admit the rename source",
    );

    // --- a second COPY of a deleted protected file is caught by `-C`
    //
    // Measured against real git 2.50.1, and the measurement is the point: git
    // will NOT report a `C` whose source is an **unmodified** file, so
    // `cp .github/workflows/ci.yml docs/leak.yml` with the workflow left in place
    // is a bare `A docs/leak.yml` under `-M` **and** under `-M -C` alike — `-C`
    // buys nothing there, and a test claiming it did would assert a git behaviour
    // that does not exist.
    //
    // What `-C` does buy is the case where the developer deletes the protected
    // file and writes its content out to MORE THAN ONE new path. `-M` pairs one
    // destination (`R100`) and reports the rest as plain additions; `-M -C` pairs
    // the next as `C100`. Both name the protected source, and the second is the
    // one only `-C` adds — which is what makes the parser's copy arm reachable in
    // production rather than dead code.
    const copied = path.join(root, "copied");
    mkdirSync(copied, { recursive: true });
    seedRepo(copied);
    // The body has to be long enough for git's similarity heuristic to pair it at
    // all: a 3-line file deleted-and-recopied sits below the `R50` threshold and
    // comes back `D` + `A` + `A` under BOTH spellings, which would fail the
    // precondition below for a reason that has nothing to do with `-C`.
    const PROTECTED_BODY =
      "runs-on: ubuntu\nsteps:\n  - run: a\n  - run: b\n  - run: c\n  - run: d\n  - run: e\n";
    writeFileSync(path.join(copied, CI), PROTECTED_BODY);
    gitIn(copied, ["add", "-A"]);
    gitIn(copied, ["commit", "-q", "-m", "give the workflow enough content to pair on"]);
    const bodyBase = gitIn(copied, ["rev-parse", "HEAD"]);
    gitIn(copied, ["rm", "-q", CI, "src/app.ts"]);
    mkdirSync(path.join(copied, "docs"), { recursive: true });
    writeFileSync(path.join(copied, "docs/leak1.txt"), PROTECTED_BODY);
    writeFileSync(path.join(copied, "docs/leak2.txt"), PROTECTED_BODY);
    gitIn(copied, ["add", "-A"]);
    gitIn(copied, ["commit", "-q", "-m", "delete the workflow, write its content out twice"]);
    // The load-bearing precondition: assert BOTH spellings, so `-C` is shown to
    // change git's output rather than assumed to.
    const withoutC = gitIn(copied, [
      "-c",
      "core.quotePath=off",
      "diff",
      "-z",
      "--name-status",
      "-M",
      "--end-of-options",
      `${bodyBase}..HEAD`,
    ]);
    const withC = gitIn(copied, [
      "-c",
      "core.quotePath=off",
      "diff",
      "-z",
      "--name-status",
      "-M",
      "-C",
      "--end-of-options",
      `${bodyBase}..HEAD`,
    ]);
    assert(
      !withoutC.split("\0").some((t) => t.startsWith("C")) &&
        withC.split("\0").some((t) => t.startsWith("C100")),
      "fixture precondition: `-M` emits no C record where `-M -C` emits `C100` — exactly what `-C` buys, and why the parser's copy arm is reachable",
    );
    assert(
      withC.includes(CI),
      "...and the `C100` record names the PROTECTED source, the path the leak copied out of",
    );
    const copiedResult = await verifyStepOutcome(
      developCtx(),
      developState(copied, bodyBase),
      "develop",
    );
    assert(
      protectedFailure(copiedResult.failures).includes(`— ${CI}`),
      "deleting the workflow and writing its content to two new paths HALTS the gate naming the protected source",
    );
    assert(
      !protectedFailure(copiedResult.failures).includes("git diff"),
      "...as a protected-path finding, not an unreadable-read failure",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================ fail-closed symmetry
//
// The status read already failed develop; the committed read used to swallow the
// error into a flag only. Both now halt naming the worktree, and both degrade to a
// note under the escape hatch.

{
  const stateWith = () => {
    const s = initialState(1378, 1000);
    return {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        worktrees: { "task-a": "/nonexistent/wt" },
        baseSha: "a".repeat(40),
      },
    };
  };
  const throwing = (which: "status" | "diff"): DriverContext => ({
    host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
    repoRoot: "/nonexistent",
    issue: 1378,
    verifyExecFn: (async (cmd: string, opts?: { argv?: string[]; maxBuffer?: number }) => {
      // Matched by the same derived matchers every other develop-gate fake uses,
      // so this fixture cannot keep throwing at a command the gate no longer sends
      // (which would leave the "unreadable read" assertions testing nothing).
      const line = commandOf(cmd, opts);
      if (which === "status" && isNulStatusRead(line)) {
        throw new Error("stdout maxBuffer length exceeded");
      }
      if (which === "diff" && isNulDiffRead(line)) {
        throw new Error("stdout maxBuffer length exceeded");
      }
      return { stdout: "" };
    }) as NonNullable<DriverContext["verifyExecFn"]>,
  });

  await withEnv({ PI_ENSEMBLE_VERIFY: "1", PI_ENSEMBLE_PROTECTED_PATHS: undefined }, async () => {
    const diffFail = await verifyStepOutcome(throwing("diff"), stateWith(), "develop");
    assert(
      diffFail.failures.some(
        (f) => f.includes('worktree "task-a"') && f.includes("git diff failed"),
      ),
      "with the gate on, an unreadable committed-diff read fails develop naming the worktree",
    );
    const statusFail = await verifyStepOutcome(throwing("status"), stateWith(), "develop");
    assert(
      statusFail.failures.some(
        (f) => f.includes('worktree "task-a"') && f.includes("git status failed"),
      ),
      "...and so does an unreadable status read (unchanged #1090 behaviour)",
    );
  });

  await withEnv({ PI_ENSEMBLE_VERIFY: "1", PI_ENSEMBLE_PROTECTED_PATHS: "0" }, async () => {
    const diffNote = await verifyStepOutcome(throwing("diff"), stateWith(), "develop");
    assert(
      !diffNote.failures.some((f) => f.includes("git diff failed")) &&
        diffNote.notes.some((n) => n.includes("git diff failed in task-a")),
      "PI_ENSEMBLE_PROTECTED_PATHS=0 turns the unreadable committed read into a note, not a failure",
    );
  });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
