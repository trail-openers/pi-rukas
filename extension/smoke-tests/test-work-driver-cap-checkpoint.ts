#!/usr/bin/env bun
/**
 * #543 F5 — the driver-owned checkpoint (M5/M6) after a dispatch-cap kill.
 *
 * A cap-killed child may not yet have committed (a developer is allowed to
 * commit in their worktree per #453/#621, but a cap kill can fire mid-
 * implementation, before the commit; lens / adversarial / explore are
 * structurally write-gated per role-tools.ts #238). The driver stages +
 * commits the worktree, authors `status-<role>.md` in
 * the scratch dir, and records `capedPartialState`. This test exercises the
 * two behaviours the round-1 findings pinned:
 *
 *   (M5) a structurally write-gated role (adversarial-developer /
 *        code-review-specialist / explore) is REPORT-ONLY: no stage, no
 *        commit, `reportOnly: true` on the record;
 *   (M6) when the killed developer's workstream paths are declared, the
 *        stage is SCOPED to them: foreign untracked files are NOT swept
 *        into the checkpoint commit and are counted in the status file.
 *
 * Real git repo, no dispatches — the cap kill is recorded directly on the
 * state file the checkpoint reads.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { checkpointCapedDispatch } from "../src/work-driver-cap-checkpoint.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyTimeoutMs } from "../src/work-driver-verify-develop-helpers.ts";
import { initialState, writeState } from "../src/workflow-state.ts";

/** #1414 — the command the checkpoint is supposed to run, imported from src (it
 * is spelled once there too) and asserted verbatim against what the injected
 * executor received and what the status file prints. */
import { CHECKPOINT_TYPECHECK_CMD as TYPECHECK_CMD } from "../src/work-driver-cap-checkpoint.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-checkpoint-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function capKillState(repoRoot: string, issue: number): ReturnType<typeof initialState> {
  let s = initialState(issue, Date.now());
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "develop",
      worktrees: { default: repoRoot },
    },
  };
  s = {
    ...s,
    eventLog: [
      ...s.eventLog,
      {
        kind: "dispatch-failed" as const,
        step: "develop" as const,
        role: "developer" as const,
        jobId: "j1",
        label: "developer",
        ms: 1000,
        at: Date.now(),
        exitCode: 143,
        killCause: "loop" as const,
        errorTail: "killed by pi-rukas (loop)",
      },
    ],
  };
  return s;
}

const fakePi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;

/**
 * #1414 — an injected `checkpointExecFn` that records the typecheck call and
 * forwards EVERYTHING else to the real executor. The checkpoint's five git
 * calls run against a real repo here, so a blanket stub would turn
 * `tree: "committed"` into a tautology; forwarding keeps those assertions
 * meaningful. Typed against the seam itself, since smoke tests are outside
 * extension/tsconfig.json's include list and would not be type-checked.
 *
 * Round 2 — the forward is `{ ...opts, maxBuffer: ... }`, NOT
 * `{ maxBuffer: ..., ...opts }`. The old order put the spy's own 8 MiB default
 * FIRST, so whatever the driver passed was overridden: the checkpoint's
 * 256 KiB cap — and the `timeout` the binding adds — were invisible to the
 * test that exists to observe them. `optsReceived` is what the bound assertions
 * read.
 */
function typecheckSpy(behaviour: "resolve" | "reject" | "reject-non-error" = "resolve"): {
  fn: NonNullable<DriverContext["checkpointExecFn"]>;
  calls: { cmd: string; cwd?: string }[];
  optsReceived: Array<Record<string, unknown> | undefined>;
} {
  const calls: { cmd: string; cwd?: string }[] = [];
  const optsReceived: Array<Record<string, unknown> | undefined> = [];
  const fn: NonNullable<DriverContext["checkpointExecFn"]> = async (cmd, opts) => {
    if (cmd.includes("tsc")) {
      calls.push({ cmd, cwd: opts?.cwd });
      optsReceived.push(opts as Record<string, unknown> | undefined);
      if (behaviour === "resolve") return { stdout: "", stderr: "" };
      if (behaviour === "reject") throw new Error("tsc exited 2: type errors");
      // A non-Error rejection must still land as typechecked: false — the
      // checkpoint is contractually non-throwing.
      throw "tsc blew up without an Error";
    }
    // git and anything else: the real executor. The driver's own opts win —
    // the spy supplies a floor, it does not clobber (round-2 LOW finding).
    return execp(cmd, { maxBuffer: 8 * 1024 * 1024, ...opts });
  };
  return { fn, calls, optsReceived };
}

// ------------------------------- (M6) scoped stage, foreign file NOT swept
{
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    writeFileSync(path.join(repo, "foreign-untracked.txt"), "foreign\n");
    let s = capKillState(repo, 9901);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        workstreams: {
          default: {
            id: "default",
            scope: "scope",
            paths: ["in-scope.ts"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(repo, s);
    const ctx = { host: fakePi, repoRoot: repo, issue: 9901 } as unknown as Parameters<
      typeof checkpointCapedDispatch
    >[0];
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    const cps = out.pipelineState.capedPartialState;
    assert(cps !== undefined, "M6: capedPartialState recorded");
    assert(cps?.tree === "committed", "M6: in-scope file committed (tree=committed)");
    assert(
      typeof cps?.commitSha === "string" && cps.commitSha.length >= 7,
      "M6: commitSha recorded",
    );
    const committed = git(repo, "show", "--name-only", "--format=", cps?.commitSha ?? "");
    assert(committed.includes("in-scope.ts"), "M6: in-scope file IS in the checkpoint commit");
    assert(
      !committed.includes("foreign-untracked.txt"),
      "M6: foreign untracked file NOT swept into the checkpoint commit",
    );
    const statusFile = path.join(repo, "tmp", "issue-9901", "status-developer.md");
    const content = await readFile(statusFile, "utf8").catch(() => "");
    assert(
      /1 untracked path\(s\) outside the declared workstream scope/.test(content),
      `M6: status file counts the foreign file as swept-foreign (got: ${JSON.stringify(content.slice(0, 400))})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// --------------------- (M6-neg) no declared paths → unscoped sweep (legacy)
{
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    writeFileSync(path.join(repo, "foreign-untracked.txt"), "foreign\n");
    const s = capKillState(repo, 9902);
    await writeState(repo, s);
    const ctx = { host: fakePi, repoRoot: repo, issue: 9902 } as unknown as Parameters<
      typeof checkpointCapedDispatch
    >[0];
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    const cps = out.pipelineState.capedPartialState;
    assert(cps?.tree === "committed", "M6-neg: unscoped checkpoint still commits (legacy sweep)");
    const committed = git(repo, "show", "--name-only", "--format=", cps?.commitSha ?? "");
    assert(
      committed.includes("in-scope.ts") && committed.includes("foreign-untracked.txt"),
      "M6-neg: without declared paths the sweep is unscoped (both files committed)",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------- (M5) write-gated role is report-only
{
  const repo = makeRepo();
  try {
    // A write-gated child cannot have written files — but a dirty tree can
    // exist (driver artefacts / other workstreams); the checkpoint must not
    // stage or commit anything for this role.
    writeFileSync(path.join(repo, "stray.txt"), "stray\n");
    let s = initialState(9903, Date.now());
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        worktrees: { default: repo },
      },
    };
    s = {
      ...s,
      eventLog: [
        ...s.eventLog,
        {
          kind: "dispatch-failed" as const,
          step: "lens-review" as const,
          role: "code-review-specialist" as const,
          jobId: "j3",
          label: "lens:security",
          ms: 1000,
          at: Date.now(),
          exitCode: 143,
          killCause: "token-budget" as const,
          errorTail: "killed by pi-rukas (token budget)",
        },
      ],
    };
    await writeState(repo, s);
    const before = git(repo, "rev-parse", "HEAD");
    const ctx = { host: fakePi, repoRoot: repo, issue: 9903 } as unknown as Parameters<
      typeof checkpointCapedDispatch
    >[0];
    const out = await checkpointCapedDispatch(ctx, s, "lens-review");
    const after = git(repo, "rev-parse", "HEAD");
    assert(before === after, "M5: write-gated role → NO checkpoint commit");
    const cps = out.pipelineState.capedPartialState;
    assert(cps?.reportOnly === true, "M5: capedPartialState.reportOnly is true");
    assert(!cps?.commitSha, "M5: no commitSha for a report-only checkpoint");
    const statusFile = path.join(repo, "tmp", "issue-9903", "status-code-review-specialist.md");
    const content = await readFile(statusFile, "utf8").catch(() => "");
    assert(
      content.length > 0,
      "M5: the status file is still authored (the report IS the checkpoint)",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- #1190: an unstaged tracked edit as the FIRST porcelain record
// (` M seed.txt`) keeps its first character — a trimmed read staged `eed.txt`,
// the add failed, and the checkpoint committed without the file.
{
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "seed.txt"), "edited\n");
    writeFileSync(path.join(repo, "zz-new.ts"), "new\n");
    const s = capKillState(repo, 9904);
    await writeState(repo, s);
    const ctx = { host: fakePi, repoRoot: repo, issue: 9904 } as unknown as Parameters<
      typeof checkpointCapedDispatch
    >[0];
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    assert(
      out.pipelineState.capedPartialState?.tree === "committed",
      "#1190: checkpoint committed",
    );
    const committed = git(repo, "show", "--name-only", "--format=", "HEAD").split("\n");
    assert(committed.includes("seed.txt"), "#1190: the first ` M` record is committed whole");
    assert(committed.includes("zz-new.ts"), "#1190: the later record is committed too");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- #1414: the typecheck branch actually runs, and runs the right command
//
// Every earlier fixture here writes only top-level files, so the worktree has
// no `extension/` directory and `typecheckWorktree` returns `undefined` from
// its `fs.access` gate — the `typechecked` field was NEVER written by any
// test, and the command it ran (`bunx tsc --no-emit`) was never observed.
// Two independent defects hid behind that: the alias is not always on PATH
// and `--no-emit` is not a tsc flag, so the checkpoint recorded
// `typechecked: false` on every host and the handoff told the operator the
// committed code was broken.
//
// The branch sits on the DIRTY path only (after the porcelain check, before
// the commit) and after the report-only short-circuit, so this fixture needs
// a developer role, an in-scope dirty file, AND an extension/ directory.
{
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, "extension"), { recursive: true });
    writeFileSync(path.join(repo, "extension", "tsconfig.json"), '{"compilerOptions":{}}\n');
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    let s = capKillState(repo, 9905);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        workstreams: {
          default: {
            id: "default",
            scope: "scope",
            paths: ["in-scope.ts"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(repo, s);
    const spy = typecheckSpy("resolve");
    const ctx = {
      host: fakePi,
      repoRoot: repo,
      issue: 9905,
      checkpointExecFn: spy.fn,
    } as unknown as Parameters<typeof checkpointCapedDispatch>[0];
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    const cps = out.pipelineState.capedPartialState;

    assert(spy.calls.length === 1, "#1414: the typecheck branch ran exactly once");
    assert(
      spy.calls[0]?.cmd === TYPECHECK_CMD,
      `#1414: the injected executor received exactly \`${TYPECHECK_CMD}\` (got ${JSON.stringify(spy.calls[0]?.cmd)})`,
    );
    assert(
      !/\bbunx\b/.test(spy.calls[0]?.cmd ?? "") && !spy.calls[0]?.cmd.includes("--no-emit"),
      "#1414: no bare bunx and no --no-emit reach the executor",
    );
    assert(
      spy.calls[0]?.cwd === path.join(repo, "extension"),
      `#1414: cwd is the worktree's extension/ dir (got ${JSON.stringify(spy.calls[0]?.cwd)})`,
    );
    assert(cps?.typechecked === true, "#1414: a resolving typecheck records typechecked:true");
    assert(cps?.tree === "committed", "#1414: the injected executor does not stop the commit");
    const passFile = path.join(repo, "tmp", "issue-9905", "status-developer.md");
    const passContent = await readFile(passFile, "utf8").catch(() => "");
    assert(
      passContent.includes(`Typecheck (${TYPECHECK_CMD}) passed at the checkpoint.`),
      `#1414: the status file names the command it ran on the pass case (got: ${JSON.stringify(
        passContent
          .split("\n")
          .filter((l) => l.startsWith("Typecheck"))
          .join("|"),
      )})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- #1414 (fail + non-Error): typechecked:false, and the handoff names the
// command the driver actually ran.
{
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, "extension"), { recursive: true });
    writeFileSync(path.join(repo, "extension", "tsconfig.json"), '{"compilerOptions":{}}\n');
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    const s = capKillState(repo, 9906);
    await writeState(repo, s);
    const spy = typecheckSpy("reject");
    const ctx = {
      host: fakePi,
      repoRoot: repo,
      issue: 9906,
      checkpointExecFn: spy.fn,
    } as unknown as Parameters<typeof checkpointCapedDispatch>[0];
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    const cps = out.pipelineState.capedPartialState;
    assert(spy.calls.length === 1, "#1414-fail: the typecheck branch ran once");
    // Round 2: the driver's own exec opts must reach the executor. The spy
    // used to spread ITS maxBuffer first, so the checkpoint's 256 KiB cap and
    // the `timeout` the binding adds were both invisible here — the assertions
    // below are the ones that would have failed pre-fix.
    assert(
      spy.optsReceived[0]?.timeout === verifyTimeoutMs(),
      `#1414-r2: the typecheck is BOUNDED — the executor received timeout === verifyTimeoutMs() (${String(spy.optsReceived[0]?.timeout)})`,
    );
    assert(
      spy.optsReceived[0]?.maxBuffer === 256 * 1024,
      `#1414-r2: the driver's maxBuffer is not clobbered by the spy's default (got ${String(spy.optsReceived[0]?.maxBuffer)})`,
    );
    assert(cps?.typechecked === false, "#1414-fail: a rejecting typecheck records false");
    assert(cps?.tree === "committed", "#1414-fail: a failed typecheck still commits (recovery)");
    const failContent = await readFile(
      path.join(repo, "tmp", "issue-9906", "status-developer.md"),
      "utf8",
    ).catch(() => "");
    assert(
      failContent.includes(`Typecheck (${TYPECHECK_CMD}) FAILED at the checkpoint`),
      "#1414-fail: the status file names the command it ran on the fail case",
    );
    assert(!failContent.includes("--no-emit"), "#1414-fail: no stale flag in the status file");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- #1414 (non-Error rejection): the never-throw contract holds.
{
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, "extension"), { recursive: true });
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    const s = capKillState(repo, 9907);
    await writeState(repo, s);
    const spy = typecheckSpy("reject-non-error");
    const ctx = {
      host: fakePi,
      repoRoot: repo,
      issue: 9907,
      checkpointExecFn: spy.fn,
    } as unknown as Parameters<typeof checkpointCapedDispatch>[0];
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    assert(
      out.pipelineState.capedPartialState?.typechecked === false,
      "#1414: a non-Error rejection still records typechecked:false (never throws)",
    );
    assert(spy.calls.length === 1, "#1414: the non-Error case still ran the typecheck");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
