/**
 * #1265 — the fixture the launch worktree sweep's tests need, and did not have.
 *
 * `resolveSweepTarget` accepts a candidate on one check only: the directory's
 * `.git` file must read, after trimming, EXACTLY
 * `gitdir: <realpath(repoRoot)/.git>/worktrees/<basename>`. Two shapes that
 * look like worktrees fail it and are silently skipped as `not-our-worktree`,
 * which is why a sweep that removes nothing can look like a sweep that had
 * nothing to remove:
 *
 *  - `makeBaseWorktrees` (lib/git-worktree-fixture.ts) runs `git init` inside
 *    `<dir>/.worktrees/<id>`. That produces a real `.git` **directory**, not a
 *    gitdir file — it can never pass the check.
 *  - a hand-written `.git` file with an approximate `gitdir:` line is rejected
 *    by the same exact-string comparison (the reason the pre-#1265 sweep test
 *    only ever exercised `enabled: false`).
 *
 * So the fixture uses ONE producer for both halves of the contract:
 * `makeSweepWorktree` runs a real `git worktree add` and then REWRITES the
 * `.git` file to what `resolveSweepTarget` expects. The rewrite is safe because
 * the driver's worktrees are created detached (worktree.ts), so their
 * administrative record already lives at `<gitdir>/worktrees/<name>` and git
 * writes the very line asserted against — the fixture restates the real layout
 * rather than approximating it, and `sweepGitdirLine` is the single source of
 * that line so the producer and any assertion cannot drift.
 *
 * The other half of #1265: worktrees are named `issue-<N>-<id>`
 * (work-driver-branch-mechanized.ts), while state files are
 * `.pi/work-state/<N>.json` (workflow-state.ts `workStateFile`). Those two
 * names are not the same string, so this module exposes the pair as ONE rule —
 * `parseSweepWorktreeName` — which both the fixture's state writer and the
 * sweep's own resolution use. A test that hand-copied either name would
 * exercise a shape production never produces.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorktreeIssue } from "../../src/work-driver-sweep-rules.ts";
import type { WorkCapLiteral } from "../../src/workflow-state-events-caps.ts";
import {
  type WorkEvent,
  type WorkState,
  type WorkStep,
  initialState,
  workStateDir,
} from "../../src/workflow-state.ts";

/** Run one git command, throwing with its stderr so a fixture failure names the cause. */
function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `worktree-sweep-fixture: git ${args.join(" ")} failed in ${cwd}: ${(r.stderr ?? r.stdout ?? "").trim()}`,
    );
  }
  return (r.stdout ?? "").trim();
}

/**
 * The basename → state-file resolution the sweep performs, in ONE place so a
 * test can pin the rule and the fixture cannot disagree with the code.
 *
 * DELEGATES to `parseWorktreeIssue` in `src/work-driver-sweep-rules.ts` — it is
 * not a second implementation of the same rule. The fixture exists to make a
 * test see exactly what production sees, and a private regex here would let the
 * test and the sweep disagree about which state file a name points at while
 * both still passed: the shape of the #1265 bug itself, reproduced in the
 * harness. `parseWorktreeIssue` answers `undefined` for anything that is not a
 * driver worktree name (no prefix, issue 0, leading zeros, no trailing
 * separator); that becomes `{ ok: false }` with the reason here, because the
 * fixture's callers want a message rather than a bare `undefined`.
 */
export function parseSweepWorktreeName(
  name: string,
): { ok: true; issue: number } | { ok: false; reason: string } {
  const issue = parseWorktreeIssue(name);
  if (issue === undefined) {
    return {
      ok: false,
      reason: "not a driver worktree name: issue-<N>-<id> expected",
    };
  }
  return { ok: true, issue };
}

/** The `.git` file content `resolveSweepTarget` expects for one worktree name. */
export function sweepGitdirLine(repoRoot: string, name: string): string {
  return `gitdir: ${join(realpathSync(repoRoot), ".git", "worktrees", name)}`;
}

/** A repo with one committed base on `main`, plus an empty `.worktrees/`. */
export function makeSweepRepo(name: string): {
  repoRoot: string;
  baseSha: string;
} {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)));
  git(repoRoot, ["init", "-q", "--initial-branch=main"]);
  git(repoRoot, ["config", "user.email", "sweep@test.invalid"]);
  git(repoRoot, ["config", "user.name", "Sweep"]);
  writeFileSync(join(repoRoot, "base.txt"), "base\n");
  // node_modules is ignored so a fixture tree holding a real one reads as
  // "clean" to git while the dependency-suppression rule still fires on it.
  writeFileSync(join(repoRoot, ".gitignore"), "node_modules\n");
  git(repoRoot, ["add", "base.txt", ".gitignore"]);
  git(repoRoot, ["commit", "-qm", "base"]);
  mkdirSync(join(repoRoot, ".worktrees"), { recursive: true });
  mkdirSync(join(repoRoot, ".pi", "work-state"), { recursive: true });
  return { repoRoot, baseSha: git(repoRoot, ["rev-parse", "HEAD"]) };
}

export interface SweepWorktree {
  /** Directory name under `.worktrees/`, e.g. `issue-7-default`. */
  name: string;
  /** Absolute path to the worktree directory. */
  path: string;
  /** The exact `.git` file content the sweep's own check expects. */
  expectedGitdir: string;
}

/**
 * `<repoRoot>/.worktrees/<name>` as a real, detached worktree at `baseSha`.
 *
 * The `.git` file is whatever `git worktree add` wrote — the detached layout puts
 * the administrative record at `<gitdir>/worktrees/<name>`, so it is already the
 * exact line `resolveSweepTarget` compares against (`readWorktreeGitdir` pins
 * it; `sweepGitdirLine` is the shared builder). It is git's real line, not a
 * hand-written stand-in.
 *
 * `dirty` writes an untracked file into the tree — the state that makes Rule 5
 * (full removal) refuse and Rule 6 (artifact purge) apply, so the branch the
 * sweep takes is decided by the tree's real state rather than a fake's answer.
 *
 * `installDeps` lays down a REAL (non-symlink) `node_modules` — the expensive
 * shape `git clean -fdX` would destroy, and the one the dependency-suppression
 * rule keys on. git sees it as ignored, so the tree stays "clean" either way.
 *
 * `installNestedDeps` lays the same real tree one level down, at
 * `pkg/node_modules` beside a `pkg/package.json` marker — the shape a
 * nested-package monorepo has, and the one pi-rukas itself has at
 * `extension/node_modules`. A root-only dependency scan reads it as nothing
 * worth keeping, which is the finding #1265's FIX 2 closes.
 */
export function makeSweepWorktree(
  repoRoot: string,
  baseSha: string,
  name: string,
  opts: {
    dirty?: boolean;
    installDeps?: boolean;
    installNestedDeps?: boolean;
  } = {},
): SweepWorktree {
  const path = join(repoRoot, ".worktrees", name);
  git(repoRoot, ["worktree", "add", "--detach", path, baseSha]);
  const expectedGitdir = sweepGitdirLine(repoRoot, name);
  if (opts.installDeps) {
    mkdirSync(join(path, "node_modules"), { recursive: true });
    writeFileSync(join(path, "node_modules", "dep.js"), "installed\n");
  }
  if (opts.installNestedDeps) {
    mkdirSync(join(path, "pkg", "node_modules"), { recursive: true });
    writeFileSync(join(path, "pkg", "package.json"), '{"name":"pkg"}\n');
    writeFileSync(join(path, "pkg", "node_modules", "dep.js"), "installed\n");
  }
  if (opts.dirty) writeFileSync(join(path, "leftover.txt"), "uncommitted\n");
  return { name, path, expectedGitdir };
}

/** What the sweep reads back from a worktree's `.git` file. */
export function readWorktreeGitdir(worktreePath: string): string {
  return readFileSync(join(worktreePath, ".git"), "utf8").trim();
}

/** A cap-hit event with the fields the decision engine reads.
 *
 * `nextStep` is REQUIRED by the schema and is what terminalises a cycle; a
 * sweep only reads `cap` and the last-cap-hit position, so the fixture states
 * the handoff outcome rather than omitting the field or casting through any.
 */
export function sweepCapHit(cap: WorkCapLiteral, at: number): WorkEvent {
  return {
    kind: "cap-hit",
    at,
    cap,
    reviewRound: 0,
    nextStep: "handoff",
  };
}

/**
 * Write the state file the worktree's basename points at, and return its path.
 *
 * `updatedAt` is PINNED, not stamped by the writer: a fixture whose age comes
 * from `Date.now()` cannot tell a sweep that reasons about age from one that
 * ignores it. Callers pass an explicit epoch ms.
 *
 * `ownerPid`: the sweep skips a worktree whose state names a live owner, so a
 * killed-cycle fixture needs a dead pid — see `deadPid()`.
 */
export function writeSweepState(
  repoRoot: string,
  params: {
    /** The issue the worktree's name encodes — the state file is `<issue>.json`. */
    issue: number;
    ownerPid: number;
    status: WorkState["pipelineState"]["status"];
    currentStep?: WorkStep;
    branchName?: string;
    /** Worktree paths keyed by workstream id (drives in-cycle teardown). */
    worktrees?: Record<string, string>;
    /** Cap appended as the last `cap-hit` event (Rule 4 switches on this). */
    cap?: WorkCapLiteral;
    /** `mergeHold` alongside the cap — Rule 4 requires both. */
    mergeHold?: boolean;
    /** Pinned write time (epoch ms). Required; see the note above. */
    updatedAt: number;
    /** Extra events appended after the cap-hit. */
    extraEvents?: WorkEvent[];
  },
): string {
  const base = initialState(params.issue, params.updatedAt);
  const state: WorkState = {
    ...base,
    owner: { pid: params.ownerPid, at: params.updatedAt },
    updatedAt: params.updatedAt,
    pipelineState: {
      ...base.pipelineState,
      status: params.status,
      currentStep: params.currentStep ?? "develop",
      ...(params.branchName ? { branchName: params.branchName } : {}),
      ...(params.worktrees ? { worktrees: params.worktrees } : {}),
      ...(params.mergeHold
        ? {
            mergeHold: {
              authorityGranted: false,
              authoritySource: "none" as const,
              evidenceReason: "fixture: the merge gate refused",
            },
          }
        : {}),
    },
    eventLog: [
      ...(params.cap ? [sweepCapHit(params.cap, params.updatedAt)] : []),
      ...(params.extraEvents ?? []),
    ],
  };
  mkdirSync(workStateDir(repoRoot), { recursive: true });
  const file = join(workStateDir(repoRoot), `${params.issue}.json`);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return file;
}

/**
 * The same write addressed by WORKTREE NAME rather than by issue number — the
 * point of this fixture. A test says `issue-7-default` and the helper decides
 * where the state file belongs, so the test cannot accidentally write the file
 * at the name the broken sweep was looking for (`issue-7-default.json`) and
 * then observe the sweep finding it.
 */
export function writeSweepStateForWorktree(
  repoRoot: string,
  worktreeName: string,
  params: Omit<Parameters<typeof writeSweepState>[1], "issue">,
): string {
  const parsed = parseSweepWorktreeName(worktreeName);
  if (!parsed.ok) {
    throw new Error(
      `worktree-sweep-fixture: ${JSON.stringify(worktreeName)} is not a driver worktree name ` +
        `(expected issue-<N>-<id> or issues-<N>-<M>-<id>): ${parsed.reason}`,
    );
  }
  return writeSweepState(repoRoot, { ...params, issue: parsed.issue });
}

/**
 * The executor a sweep test injects: real git for everything, plus a record of
 * every call, so a test can prove the sweep DID something rather than infer it
 * from a return value that reads identically when nothing ran.
 *
 * The argv form runs `cmd` with `argv` as its arguments (never through a
 * shell): `isWorkProvablyOnRemote` issues `execFn("git", { argv: [...] })`, and
 * an executor that drops `argv` turns that into a bare `git` (#1279).
 */
export interface RecordingExec {
  exec: (
    cmd: string,
    opts?: {
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
      shell?: string;
      argv?: string[];
      env?: NodeJS.ProcessEnv;
      killGroup?: boolean;
    },
  ) => Promise<{ stdout: string; stderr?: string }>;
  calls: { cmd: string; cwd?: string; argv?: string[] }[];
  /** The recorded calls, in order, as command lines. */
  commands(): string[];
  /** One string of every recorded command line, for substring assertions. */
  transcript(): string;
  /** How many recorded calls contain `needle` as a command-line substring. */
  countMatching(needle: string): number;
}

export function recordingExec(): RecordingExec {
  const calls: RecordingExec["calls"] = [];
  const exec: RecordingExec["exec"] = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts?.cwd, argv: opts?.argv });
    const r = opts?.argv
      ? spawnSync(cmd, opts.argv, { cwd: opts?.cwd, encoding: "utf8" })
      : spawnSync("/bin/sh", ["-c", cmd], { cwd: opts?.cwd, encoding: "utf8" });
    if (r.status !== 0) {
      const detail = (r.stderr ?? r.stdout ?? "").trim();
      throw Object.assign(new Error(`Command failed: ${cmd}\n${detail}`), {
        code: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      });
    }
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const line = (c: RecordingExec["calls"][number]): string =>
    c.argv ? [c.cmd, ...c.argv].join(" ") : c.cmd;
  return {
    exec,
    calls,
    commands: () => calls.map(line),
    transcript: () => calls.map(line).join("\n"),
    countMatching: (needle) => calls.filter((c) => line(c).includes(needle)).length,
  };
}

/**
 * A pid no process can hold, for "this cycle's owner died" fixtures.
 *
 * Above the pid_max any current Linux/macOS box runs with, and not a signal-0
 * special case — `processAlive()` answers false without racing a real pid.
 */
export function deadPid(): number {
  return 0x7ffffffe;
}
