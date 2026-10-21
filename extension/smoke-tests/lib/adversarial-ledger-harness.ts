/**
 * adversarial-ledger-harness — the fixture + guard harness behind
 * `test-adversarial-ledger-range.ts`, split out for the 500-line gate
 * (AGENTS.md §12).
 *
 * This is the machinery half of that test: build a real clone with a bare
 * origin, read back the ledger rows the REAL writers put there, and drive the
 * REAL #912 merge guard with only `gh` stubbed. The arms themselves stay in the
 * test, where the assertions on the reviewed range live.
 *
 * Two properties the arms depend on and should not have to re-derive:
 *
 * - **Nothing is mocked.** Only `gh` is faked; every git call is the real thing
 *   against a real clone, because the binding decision under test IS a set of
 *   git reads. A `mock.module` would also starve the writers' subprocess
 *   callbacks the row poll waits on (#984).
 * - **The writers are awaited.** Both return their write, so an arm learns
 *   whether a row was recorded or refused rather than inferring it from the
 *   absence of a row — a silent skip is a test failure, not an assertion.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LedgerBinding } from "../../src/adversarial-ledger-binding.ts";
import { writeAdversarialLedgerEntry } from "../../src/adversarial-ledger.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
// The refusal vocabulary is re-exported so an arm asserts "this detail is one
// of the prefixes the guard knows" without importing the module under test
// directly — the harness is the test's only window into the binding side.
export { BINDING_REFUSAL_PREFIXES } from "../../src/adversarial-ledger-binding.ts";
import { writeLensLedgerEntry } from "../../src/lens-ledger.ts";
import { registerMergeGuard } from "../../src/merge-guard.ts";
import type { LedgerEntry } from "../../src/review-ledger.ts";
import { latestEntry, readLedgerFile } from "../../src/review-ledger.ts";
import type { DispatchResult } from "../../src/types.ts";
import { commandOf } from "./argv-shell.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** The branch every fixture builds. One name so a row's branch is never the
 * thing an arm is accidentally asserting about. */
export const BRANCH = "feature/x";

/** Run a real git command in `repo` and return its trimmed stdout.
 *
 * #1145 — `env: gitTestEnv()` on every git child this harness spawns. Only `gh`
 * is faked here, so the binding decision under test IS this set of git reads:
 * without the isolated env a host `~/.config/git/ignore` (or a host
 * `init.defaultBranch`, which is what makes `origin/HEAD` exist and moves
 * `resolveMainline` between two different answers) changes what the guard
 * decides, and the arm's verdict becomes a property of the machine. Same reason
 * for the two bare `execFileSync` calls in `setupRepo` below. */
export const sh = (repo: string, ...argv: string[]) => {
  const stdout = execFileSync("git", ["-C", repo, ...argv], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitTestEnv(),
  });
  return stdout.trim();
};

export interface Repo {
  dir: string;
  branch: string;
  /** The merge-base `origin/main` shares with the branch — the base a correct
   * review names, and the base the row's patch id is taken against. */
  mergeBase: string;
  tip: string;
  /** The branch's first commit: one commit behind the tip, i.e. the narrowing
   * a caller reaches for when it reviews `HEAD~1` instead of the branch. */
  parent: string;
}

/** A repo with `mainline` (default `main`) pushed to a bare origin and a feature
 * branch TWO commits ahead — the two-commit shape the issue's acceptance
 * criterion names, because one commit cannot express "a range narrower than the
 * branch". The mainline name is a parameter because the mainline's NAME is what
 * #1360 lens 2 is about: a repo whose mainline is `trunk` used to classify a
 * tip-named head as `head-not-current` for a review that was of the tip. */
export function setupRepo(mainline = "main"): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), "adv-1360-"));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, "repo");
  execFileSync("git", ["-C", root, "init", "-q", "--bare", origin], {
    stdio: "ignore",
    env: gitTestEnv(),
  });
  execFileSync("git", ["-C", root, "clone", "-q", origin, dir], {
    stdio: "ignore",
    env: gitTestEnv(),
  });
  sh(dir, "config", "user.email", "t@t.t");
  sh(dir, "config", "user.name", "t");
  sh(dir, "checkout", "-qb", mainline);
  writeFileSync(path.join(dir, "base.txt"), "base\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "base");
  sh(dir, "push", "-q", "origin", mainline);
  sh(dir, "remote", "set-head", "origin", mainline);
  const mergeBase = sh(dir, "rev-parse", mainline);
  sh(dir, "checkout", "-qb", BRANCH, mainline);
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "commit A");
  const parent = sh(dir, "rev-parse", "HEAD");
  writeFileSync(path.join(dir, "b.txt"), "b\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "commit B");
  const tip = sh(dir, "rev-parse", "HEAD");
  sh(dir, "push", "-q", "origin", BRANCH);
  return { dir, branch: BRANCH, mergeBase, tip, parent };
}

/** Create a branch at `sha` — a base that is not the mainline. */
export const branchAt = (repo: string, name: string, sha: string): void => {
  sh(repo, "branch", name, sha);
};

/** Commit a tracked-file change on the branch — the "HEAD moved after the
 * review" shape. */
export function commitOnBranch(repo: string, name: string, content: string, msg: string): string {
  writeFileSync(path.join(repo, name), content);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", msg);
  return sh(repo, "rev-parse", "HEAD");
}

/** Edit a TRACKED file with no commit — the "tree changed after the review" shape. */
export function editTracked(repo: string, name: string, content: string): void {
  writeFileSync(path.join(repo, name), content);
}

/** The ledger file for a repo (its git common dir — one ledger per clone, so a
 * worktree of this clone would share it). */
export const ledgerFile = (repo: string) => {
  const common = sh(repo, "rev-parse", "--git-common-dir");
  const abs = path.isAbsolute(common) ? common : path.resolve(repo, common);
  return path.join(abs, "review-ledger.json");
};

/** This branch's latest row of `kind`, or undefined. */
export function latest(repo: string, kind: "adversarial" | "lens"): LedgerEntry | undefined {
  const file = ledgerFile(repo);
  return existsSync(file) ? latestEntry(readLedgerFile(file).entries, BRANCH, kind) : undefined;
}

/** Poll for a row. The arms `await` their writes (both writers return their
 * write), so a row is normally on disk already; this is the belt-and-braces
 * path for a writer that degraded (lock contention, a slow subprocess hop).
 * MUST await between ticks — the writer's subprocess callbacks run on the event
 * loop, so a blocking wait starves them (#984). */
export async function waitForRow(repo: string, kind: "adversarial" | "lens"): Promise<LedgerEntry> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const now = latest(repo, kind);
    if (now) return now;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${kind} ledger row appeared for the tool-path review`);
}

/** The forge stub: only `gh` is faked; every git call is real.
 *
 * `baseRefName` is the PR's base, and the guard FETCHES it — so on a repo whose
 * mainline is not `main` a hardcoded "main" makes the fetch fail and the guard
 * refuses for a reason that has nothing to do with the review under test. It is
 * read from the repo (`origin/HEAD`'s target, the same answer `identityBase`
 * resolves) rather than assumed. */
export function forgeExec(repo: string, pr: { comments: string[] }, baseBranch = "main") {
  // `o` is typed against `MergeExecFn`'s options (merge-target.ts), not a local
  // `{ argv? }` shape: the guard calls this through that type, and a parameter
  // narrower than the one the caller passes is an assignability error (TS2322)
  // rather than a behaviour difference — the extra fields (`cwd`, `timeout`,
  // `maxBuffer`, `shell`) are simply not consulted by a stub that runs real git
  // at `repo`. Widening the parameter is the fix; casting the function away is
  // not, because the point of the check is that the stub fits the seam.
  return async (
    cmd0: string,
    o?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string; argv?: string[] },
  ): Promise<{ stdout: string }> => {
    if (cmd0 !== "gh" && !cmd0.startsWith("gh ")) {
      const stdout = o?.argv
        ? execFileSync(cmd0, o.argv, {
            cwd: repo,
            encoding: "utf8",
            stdio: "pipe",
            env: gitTestEnv(),
          })
        : execFileSync("/bin/sh", ["-c", cmd0], {
            cwd: repo,
            encoding: "utf8",
            stdio: "pipe",
            env: gitTestEnv(),
          });
      return { stdout };
    }
    const cmd = commandOf(cmd0, o);
    if (cmd.includes("--json comments")) {
      return { stdout: JSON.stringify({ comments: pr.comments.map((body) => ({ body })) }) };
    }
    if (cmd.includes("pr view 12")) {
      return {
        stdout: JSON.stringify({
          headRefName: BRANCH,
          headRefOid: sh(repo, "rev-parse", `origin/${BRANCH}`),
          baseRefName: baseBranch,
          author: { login: "dev" },
          labels: [],
        }),
      };
    }
    throw new Error(`unexpected gh call: ${cmd}`);
  };
}

/** Drive the real merge guard from inside `repo`. */
export async function guard(repo: string, pr: { comments: string[] }, baseBranch = "main") {
  let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
  registerMergeGuard(
    { on: (n: string, fn: typeof handler) => n === "tool_call" && (handler = fn) } as never,
    { execFn: forgeExec(repo, pr, baseBranch) },
  );
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const r = (await handler?.({ toolName: "bash", input: { command: "gh pr merge 12" } }, {})) as
      | { block?: boolean; reason?: string }
      | undefined;
    return { block: r?.block === true, reason: r?.reason ?? "" };
  } finally {
    process.chdir(prev);
  }
}

/** An approving loop result — the verdict every binding arm except one carries.
 *
 * A checked `DispatchResult` literal, not an `as never` cast: the cast is
 * assignable to any parameter, so a renamed outcome literal, a misspelled
 * field, or a newly-required field compiles silently and only the runtime
 * assertion on the written row would notice (AGENTS §12 forbids the `any`
 * equivalent). Every field the interface requires is written out. */
export const APPROVED: DispatchResult = {
  role: "adversarial-loop",
  ok: true,
  text: "VERDICT: APPROVED",
  toolUses: [],
  ms: 0,
  exitCode: 0,
  loopOutcome: "approved",
};

/** A passing lens row so the guard's lens half never colours the verdict. */
export async function recordPassingLens(repo: string) {
  const outcome = await writeLensLedgerEntry("APPROVED", "MEDIUM", repo, BRANCH, false);
  if (!outcome.recorded) {
    throw new Error(`the lens fixture row was not recorded: ${outcome.reason}`);
  }
}

/**
 * One arm: write a tool-path adversarial row through the REAL writer and return
 * the row alongside the REAL guard's decision on it.
 *
 * The writer is AWAITED (it returns its write), so a row it refused to write is
 * a thrown test failure rather than an assertion about a missing row. `binding`
 * is what the round's capture would have produced — pass a stale or partial one
 * to test what the writer does with it.
 */
export async function toolArm(
  repo: string,
  params: {
    base?: string;
    head?: string;
    binding?: Partial<LedgerBinding>;
    /** true → the /work driver's shape: no provenance marker, so the binding
     * gates do not apply and the row keeps its pre-#1360 form. */
    driverPath?: boolean;
    /** The loop's verdict. Defaults to APPROVED; the rejected arm passes a
     * rejection to show a refusal detail never overwrites the verdict's own.
     * ALL THREE verdict-carrying fields are required together — `ok`,
     * `loopOutcome` AND `text` — so an arm cannot merge a rejection's pass bit
     * over APPROVED's approving report text (a row whose `passed` says false
     * while its own `text` says APPROVED is a fixture asserting two opposite
     * verdicts, and the reply-marker readers read the verdict out of `text`).
     * The merge below stays a checked `DispatchResult`, not an `as never`
     * cast. */
    result?: Pick<DispatchResult, "ok" | "loopOutcome" | "text">;
    /** The git executor the writer uses. Defaults to the real one — every arm
     * runs real git; this exists for the arm that counts calls (#1360 lens 6). */
    execFn?: VerifyExecFn;
    /** The PR's base branch the guard's forge stub reports, so its `git fetch`
     * names a ref the repo actually has. Defaults to `main`; a `trunk` fixture
     * passes `"trunk"` (#1360 lens 2). */
    baseBranch?: string;
  },
): Promise<{ row: LedgerEntry; block: boolean; reason: string; ledgerPath: string }> {
  const pr = { comments: [] as string[] };
  await recordPassingLens(repo);
  // Spreading an absent override is a no-op, so one expression covers both
  // the default (APPROVED) and the varied arm.
  await writeAdversarialLedgerEntry({ ...APPROVED, ...params.result }, {
    workCwd: repo,
    branch: BRANCH,
    base: params.base,
    head: params.head,
    toolPath: params.driverPath !== true,
    binding: params.binding ?? {},
    execFn: params.execFn,
  });
  const row = await waitForRow(repo, "adversarial");
  const g = await guard(repo, pr, params.baseBranch ?? "main");
  return { row, ...g, ledgerPath: ledgerFile(repo) };
}

/** The capture a round produces when it reviews the range it should have: the
 * tree identity and HEAD the writer will recompute, taken at review time. */
export async function honestBinding(repo: string, base: string, headRef: string) {
  const { captureBinding } = await import("../../src/adversarial-ledger-binding.ts");
  return captureBinding(repo, base, headRef);
}

/** Read a ledger file verbatim by path — for an arm that captured the path
 * before clearing the ledger override, or that must prove a row EXISTS when its
 * own `passed` boolean is what is under suspicion. */
export function readRawLedgerFile(file: string): { entries: unknown[] } {
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] })
    : { entries: [] };
}

/** Read this repo's ledger file verbatim. */
export function readRawLedger(repo: string): { entries: unknown[] } {
  return readRawLedgerFile(ledgerFile(repo));
}
