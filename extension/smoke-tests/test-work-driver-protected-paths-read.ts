#!/usr/bin/env bun
/**
 * #1378 (part 1 of 2) — the `-z` parsers and the develop protected-path gate
 * against real git.
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
 * and restored around every block that touches them.
 *
 * Part 2: test-work-driver-protected-paths-read-canary.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  PROTECTED_DIFF_ARGV,
  PROTECTED_STATUS_ARGV,
  readCommittedProtectedPaths,
  readProtectedStatusPaths,
} from "../src/work-driver-protected-paths-read.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { realExec } from "./lib/exec-fake.ts";
import { gitIn } from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CI = ".github/workflows/ci.yml";
const env = process.env as Record<string, string | undefined>;

/** Run a block with both develop-gate env vars pinned, restoring whatever was there. */

async function withEnv(
  overrides: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

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

// ============================ parser unit cases (no git, no gate)
//
// The two `-z` layouts differ in field ORDER, so they are two parsers; each is
// pinned against the exact byte stream git produces, and against the malformed
// streams that must come back unreadable rather than as a shorter list.

{
  const fake = (stdout: string, onCall?: (argv: string[]) => void) =>
    (async (cmd: string, opts?: { argv?: string[] }) => {
      onCall?.(opts?.argv ?? []);
      return { stdout };
    }) as typeof realExec;

  const statusCalls: string[][] = [];
  const st = await readProtectedStatusPaths(
    fake("R  .pi/verify-cmd2\0src/a.ts\0", (a) => statusCalls.push(a)),
    "/wt",
  );
  assert(
    "paths" in st && st.paths.join("|") === ".pi/verify-cmd2|src/a.ts",
    "status -z: a rename contributes BOTH sides, new name first (`XY new\\0orig\\0`)",
  );
  assert(
    statusCalls[0]?.join(" ") === PROTECTED_STATUS_ARGV.join(" "),
    "status read is argv-shaped: `git status --porcelain -z --untracked-files=all`",
  );

  assert(
    "unreadable" in (await readProtectedStatusPaths(fake("R  only-one-side\0"), "/wt")),
    "status -z: a rename with no origin token is unreadable, not a one-sided guess",
  );
  assert(
    "unreadable" in (await readProtectedStatusPaths(fake("ZZ\u0000src/a.ts\u0000"), "/wt")),
    "status -z: a malformed record (no status separator) is unreadable",
  );
  assert(
    "paths" in (await readProtectedStatusPaths(fake(""), "/wt")) &&
      (await readProtectedStatusPaths(fake(""), "/wt")).paths.length === 0,
    "status -z: an empty stream is an empty change set, not an error",
  );

  const diffCalls: string[][] = [];
  const df = await readCommittedProtectedPaths(
    fake("R100\0.github/workflows/ci.yml\0src/ci.yml\0", (a) => diffCalls.push(a)),
    "/wt",
    "b".repeat(40),
  );
  assert(
    "targets" in df && df.targets.join() === "src/ci.yml" && df.renameSources.join() === CI,
    "diff -z: the destination is a changed path, the source is protected-only (`R100\\0from\\0to`)",
  );
  assert(
    diffCalls[0]?.join(" ") === [...PROTECTED_DIFF_ARGV, `${"b".repeat(40)}..HEAD`].join(" "),
    "committed read is argv-shaped with -z, --name-status, -M and --end-of-options",
  );
  assert(
    "targets" in
      (await readCommittedProtectedPaths(fake("D\0.pi/verify-cmd\0"), "/wt", "b".repeat(40))) &&
      (
        await readCommittedProtectedPaths(fake("D\0.pi/verify-cmd\0"), "/wt", "b".repeat(40))
      ).targets.join() === ".pi/verify-cmd",
    "diff -z: a `D` record is a first-class path (a delete-plus-add pair does not collapse to R100)",
  );
  assert(
    "unreadable" in
      (await readCommittedProtectedPaths(fake("R100\0src/a.ts\0"), "/wt", "b".repeat(40))),
    "diff -z: a rename record missing its destination is unreadable",
  );
  assert(
    "unreadable" in (await readCommittedProtectedPaths(fake("M\0"), "/wt", "b".repeat(40))),
    "diff -z: a status record without its path is unreadable",
  );
  // -z names are verbatim: a backslash or a tab is data, not an escape to decode.
  const verbatim = await readCommittedProtectedPaths(
    fake("A\0.github/back\\slash.yml\0A\0.github/tab\there.yml\0"),
    "/wt",
    "b".repeat(40),
  );
  assert(
    "targets" in verbatim &&
      verbatim.targets.join("|") === ".github/back\\slash.yml|.github/tab\there.yml",
    "diff -z: a backslash or a tab in a protected name arrives verbatim, undecoded",
  );
  const verbatimStatus = await readProtectedStatusPaths(
    fake("?? .github/back\\slash.yml\0?? .github/tab\there.yml\0"),
    "/wt",
  );
  assert(
    "paths" in verbatimStatus &&
      verbatimStatus.paths.join("|") === ".github/back\\slash.yml|.github/tab\there.yml",
    "status -z: a backslash or a tab in a protected name arrives verbatim, undecoded",
  );
  const boom = (async () => {
    throw new Error("stdout maxBuffer length exceeded");
  }) as typeof realExec;
  const failedDiff = await readCommittedProtectedPaths(boom, "/wt", "b".repeat(40));
  assert(
    "unreadable" in failedDiff && /maxBuffer/.test(failedDiff.unreadable),
    "diff -z: a rejected read is unreadable with the error text (no silent truncation of the rename list)",
  );
}

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
      const line = commandOf(cmd, opts);
      if (which === "status" && /\bstatus --porcelain -z/.test(line)) {
        throw new Error("stdout maxBuffer length exceeded");
      }
      if (which === "diff" && /\bdiff -z --name-status -M/.test(line)) {
        throw new Error("stdout maxBuffer length exceeded");
      }
      if (/\bstatus --porcelain -z/.test(line)) return { stdout: "" };
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
