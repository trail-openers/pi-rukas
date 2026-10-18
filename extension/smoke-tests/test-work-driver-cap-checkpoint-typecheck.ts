#!/usr/bin/env bun
/**
 * #1414 round 2 — the checkpoint's typecheck distinguishes "could not run"
 * from "broken", and is bounded + slotted like every other verify exec.
 *
 * Split from test-work-driver-cap-checkpoint.ts (AGENTS.md §12 file-size
 * limit) because the finding's coverage is a different question than that
 * file's: it asks what the `typechecked` field MEANS, not whether the
 * checkpoint committed.
 *
 * The bug (round 1's fix, incomplete): `typecheckWorktree` returned
 * `boolean | undefined`, and `false` was the catch-all — no `extension/` to
 * check, a binary the shell could not run, and a run killed at its bound all
 * produced the same value a real `error TS2345` produces. The handoff then
 * told the operator, in identical words, that committed code was broken, on
 * the strength of a command that never judged it. Same bug class as #1414
 * proper one layer down: round 1 fixed the command's spelling, the lie
 * survived because "could not run" and "the code is broken" shared a boolean.
 *
 * Two halves, deliberately:
 *   - the classifier, tested PURE over planted shapes. Both directions, so
 *     each case is the mutation-check for the others: swapping the diagnostic
 *     and could-not-run arms, or deleting the timeout guard, breaks a named
 *     case rather than passing silently.
 *   - the integration path, asserting the RECORD and the STATUS FILE — the two
 *     surfaces an operator actually reads. A field can be right while the
 *     sentence rendered from it lies.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { classifyTypecheckRejection } from "../src/work-driver-cap-checkpoint-typecheck.ts";
import { CHECKPOINT_TYPECHECK_CMD } from "../src/work-driver-cap-checkpoint.ts";
import { checkpointCapedDispatch } from "../src/work-driver-cap-checkpoint.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyTimeoutMs } from "../src/work-driver-verify-develop-helpers.ts";
import { initialState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The rejection shapes the executor produces, planted literally. */
type Behaviour = "resolve" | "reject-diagnostic" | "reject-missing" | "reject-timeout" | "reject-non-error";

/**
 * An executor that throws ONE of the real shapes for the typecheck and forwards
 * every git call to `execp`, so `tree: "committed"` stays a real observation.
 *
 * The forward is `{ ...opts, maxBuffer: ... }` with the DRIVER's opts winning:
 * the round-1 spy spread its own default first, so the 256 KiB cap and the
 * `timeout` the binding adds were both invisible to the test that exists to
 * observe them. `optsReceived` is what the bound assertions read.
 */
function typecheckSpy(behaviour: Behaviour): {
  fn: NonNullable<DriverContext["checkpointExecFn"]>;
  calls: { cmd: string; cwd?: string }[];
  optsReceived: Array<Record<string, unknown> | undefined>;
} {
  const calls: { cmd: string; cwd?: string }[] = [];
  const optsReceived: Array<Record<string, unknown> | undefined> = [];
  const fn: NonNullable<DriverContext["checkpointExecFn"]> = async (cmd, opts) => {
    if (!cmd.includes("tsc")) return execp(cmd, { ...opts, maxBuffer: 8 * 1024 * 1024 });
    calls.push({ cmd, cwd: opts?.cwd });
    optsReceived.push(opts as Record<string, unknown> | undefined);
    if (behaviour === "resolve") return { stdout: "", stderr: "" };
    if (behaviour === "reject-diagnostic") {
      // A real `tsc --noEmit` failure: non-zero exit carrying TSxxxx. The ONLY
      // shape that means "the code is broken".
      throw Object.assign(new Error("Command failed: bun x tsc --noEmit"), {
        code: 2,
        stdout: "src/foo.ts(3,5): error TS2345: Argument of type 'x' is not assignable.",
        stderr: "",
      });
    }
    if (behaviour === "reject-timeout") {
      // Killed at its bound (exec.ts's group-kill / Node's exec-timeout shape).
      throw Object.assign(
        new Error(`command timed out after 600000ms: ${CHECKPOINT_TYPECHECK_CMD}`),
        {
          killed: true,
          signal: "SIGKILL",
          code: null,
          stdout: "",
          stderr: "",
        },
      );
    }
    if (behaviour === "reject-missing") {
      // A missing binary: the SHELL could not run the command at all (127).
      throw Object.assign(
        new Error("Command failed: bun x tsc --noEmit\nsh: tsc: command not found"),
        {
          code: 127,
          stdout: "",
          stderr: "sh: tsc: command not found",
        },
      );
    }
    // A non-Error rejection — the checkpoint is contractually non-throwing.
    throw "tsc blew up without an Error";
  };
  return { fn, calls, optsReceived };
}

/** A repo with one dirty in-scope file and (optionally) an extension/ dir. */
async function dirtyRepo(issue: number, withExtension: boolean): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-typecheck-"));
  const git = (...args: string[]) => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-q", "-m", "seed");
  if (withExtension) mkdirSync(path.join(dir, "extension"), { recursive: true });
  writeFileSync(path.join(dir, "in-scope.ts"), "in\n");
  // The kill event's timestamp must PREDATE the checkpoint's `at` (the #544 8c
  // stale-kill guard skips a checkpoint whose existing record is newer than the
  // kill it is reading). `Date.now()` here and the checkpoint's own
  // Date.now() can land in the same millisecond, which makes
  // `existing.at > capKill.at` false and the checkpoint proceeds — but a
  // fixture whose event is stamped a millisecond LATER than a pre-existing
  // record would be silently skipped, so pin the event in the past by a full
  // second: the guard's `>` then holds in the direction that matters.
  const killAt = Date.now() - 1000;
  let s = initialState(issue, killAt);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "develop",
      worktrees: { default: dir },
      workstreams: {
        default: { id: "default", scope: "scope", paths: ["in-scope.ts"], outOfScope: [] },
      },
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
        at: killAt,
        exitCode: 143,
        killCause: "loop" as const,
        errorTail: "killed by pi-rukas (loop)",
      },
    ],
  };
  await writeState(dir, s);
  return dir;
}

// ---------------- the classifier, pure — planted shapes, both directions
{
  const cases: Array<[string, unknown, true | false | undefined, string]> = [
    [
      "a real tsc diagnostic is a verdict on the code",
      Object.assign(new Error("Command failed: bun x tsc --noEmit"), {
        code: 2,
        stdout: "src/a.ts(1,1): error TS2345: not assignable",
        stderr: "",
      }),
      false,
      "",
    ],
    [
      "ENOENT is no verdict — the binary was not there",
      Object.assign(new Error("spawn bun ENOENT"), { code: "ENOENT" }),
      undefined,
      "could not run",
    ],
    [
      "the shell's `command not found` is no verdict",
      Object.assign(new Error("Command failed: bun x tsc --noEmit\nsh: tsc: command not found"), {
        code: 127,
        stdout: "",
        stderr: "sh: tsc: command not found",
      }),
      undefined,
      "could not run",
    ],
    [
      "`Cannot find module` from bun x is no verdict",
      Object.assign(new Error("Command failed\nCannot find module 'typescript'"), {
        code: 1,
        stdout: "",
        stderr: "Cannot find module 'typescript'",
      }),
      undefined,
      "could not run",
    ],
    [
      "a run killed at its bound is no verdict even with TS output already printed",
      Object.assign(new Error("command timed out after 600000ms: bun x tsc --noEmit"), {
        killed: true,
        code: null,
        stdout: "src/a.ts(1,1): error TS2345: partial run",
        stderr: "",
      }),
      undefined,
      "killed at its",
    ],
    [
      "a non-Error rejection still reads as a failure, never throws",
      "tsc blew up without an Error",
      false,
      "",
    ],
    [
      "a bare non-zero exit with no recognised refusal still indicts the code",
      Object.assign(new Error("tsc exited 1 after compiling 400 files"), { code: 1 }),
      false,
      "",
    ],
  ];
  for (const [label, err, wantVerdict, wantText] of cases) {
    let got: ReturnType<typeof classifyTypecheckRejection> | "THREW" = "THREW";
    try {
      got = classifyTypecheckRejection(err);
    } catch {
      /* asserted below */
    }
    if (got === "THREW") {
      assert(false, `classifier never throws — ${label}`);
      continue;
    }
    assert(got.verdict === wantVerdict, `classifier: ${label} → verdict ${String(wantVerdict)}`);
    if (wantText) {
      const why = got.verdict === undefined ? got.why : "";
      assert(
        why.includes(wantText),
        `classifier: ${label} names the reason ("${wantText}") in why (got ${JSON.stringify(why)})`,
      );
    }
  }
}

/**
 * Run the checkpoint with an injected spy against a dirty, in-scope worktree.
 * `withExtension: false` exercises the fs.access gate (nothing to check).
 * The repo is NOT removed here — the caller still reads the status file and
 * the git log, and removes it in its own `finally`.
 */
async function runCheckpoint(issue: number, behaviour: Behaviour, withExtension = true) {
  const repo = await dirtyRepo(issue, withExtension);
  const spy = typecheckSpy(behaviour);
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot: repo,
    issue,
    checkpointExecFn: spy.fn,
  } as unknown as Parameters<typeof checkpointCapedDispatch>[0];
  const state = await readBackState(repo, issue);
  const out = await checkpointCapedDispatch(ctx, state, "develop");
  const status = await readFile(
    path.join(repo, "tmp", `issue-${issue}`, "status-developer.md"),
    "utf8",
  ).catch(() => "");
  return { repo, cps: out.pipelineState.capedPartialState, spy, status };
}

async function readBackState(repo: string, issue: number) {
  const { readState } = await import("../src/workflow-state.ts");
  const s = await readState(repo, issue);
  if (!s) throw new Error(`fixture state file for issue ${issue} is missing`);
  return s;
}

// ---------------- the bound and the slot reach the executor (finding 1)
{
  const { cps, spy, repo } = await runCheckpoint(9920, "resolve");
  try {
    assert(spy.calls.length === 1, "#1414-r2: the typecheck branch ran exactly once");
    assert(
      spy.calls[0]?.cmd === CHECKPOINT_TYPECHECK_CMD,
      `#1414-r2: the executor received \`${CHECKPOINT_TYPECHECK_CMD}\` (got ${JSON.stringify(spy.calls[0]?.cmd)})`,
    );
    assert(
      spy.optsReceived[0]?.timeout === verifyTimeoutMs(),
      `#1414-r2: the run is BOUNDED — opts.timeout === verifyTimeoutMs() (got ${String(spy.optsReceived[0]?.timeout)})`,
    );
    assert(
      spy.optsReceived[0]?.maxBuffer === 256 * 1024,
      `#1414-r2: the driver's maxBuffer reaches the executor, not the spy's default (got ${String(spy.optsReceived[0]?.maxBuffer)})`,
    );
    assert(cps?.typechecked === true, "#1414-r2: a resolving typecheck still records true");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------- "could not run" is no verdict, and is never called broken
for (const [behaviour, wantWhy] of [
  ["reject-missing", "could not run"],
  ["reject-timeout", "killed at its"],
] as const) {
  const issue = behaviour === "reject-missing" ? 9921 : 9922;
  const { cps, status, repo } = await runCheckpoint(issue, behaviour);
  try {
    assert(cps?.typechecked === undefined, `${behaviour}: records NO verdict (field not false)`);
    assert(
      "typechecked" in (cps ?? {}) === false,
      `${behaviour}: the field is ABSENT from the record, not false and not null`,
    );
    assert(
      typeof cps?.typecheckReason === "string" && cps.typecheckReason.includes(wantWhy),
      `${behaviour}: the reason is recorded as \`${wantWhy}\` (got ${JSON.stringify(cps?.typecheckReason)})`,
    );
    assert(cps?.tree === "committed", `${behaviour}: a no-verdict typecheck still commits`);
    assert(
      status.includes("reached NO VERDICT"),
      `${behaviour}: the status file says NO VERDICT, in words the operator can act on`,
    );
    assert(
      !/Typecheck \([^)]*\) FAILED/.test(status),
      `${behaviour}: the status file makes NO broken-code claim about a run that did not happen`,
    );
    assert(
      !/\bbunx\b/.test(status) && !status.includes("--no-emit"),
      `${behaviour}: no stale command spelling in the status file`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------- a real diagnostic DOES say the code is broken (mutation guard)
{
  const { cps, status, repo } = await runCheckpoint(9923, "reject-diagnostic");
  try {
    assert(cps?.typechecked === false, "diagnostic: records typechecked:false");
    assert(
      cps?.typecheckReason === undefined,
      "diagnostic: a real verdict carries no no-verdict reason",
    );
    assert(
      /Typecheck \([^)]*\) FAILED/.test(status),
      "diagnostic: the status file DOES make the broken-code claim — this is the case the two above must not be conflated with",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------- no extension/ dir: no verdict, and the reason says so
{
  const { cps, status, repo } = await runCheckpoint(9924, "resolve", false);
  try {
    assert(
      cps?.typechecked === undefined,
      "no extension/: nothing to check is a NO verdict, not a pass and not a failure",
    );
    assert(
      (cps?.typecheckReason ?? "").includes("no extension/ directory"),
      `no extension/: the reason names the missing directory (got ${JSON.stringify(cps?.typecheckReason)})`,
    );
    assert(
      !/Typecheck \([^)]*\) FAILED/.test(status),
      "no extension/: no broken-code claim for a tree that was never compiled",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
