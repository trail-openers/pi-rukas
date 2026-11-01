#!/usr/bin/env bun
/**
 * lean/ci — the step that refuses to call a green a green on a child's word.
 *
 * `ci` sits between `publish` and `land`, and `land` trusts it for the merge. So
 * every case below asks one of two questions: did the step OBSERVE both halves
 * (the forge's required-check verdict and the project's full verify tier), or did
 * it talk itself into a green? A case passes `green` only when the recorder says
 * both commands really ran against the right head; anything it did not run can
 * only produce red or a throw.
 *
 *   (a) both halves observed at the verified head -> green
 *   (b) no full tier configured -> red naming that gap (and the tier never ran)
 *   (c) the tier exits non-zero -> red carrying its tail
 *   (d) a required check not passing -> red, and the tier was never run
 *   (e) no checks reported at all -> red (absence of evidence is not green)
 *   (f) the PR head moved off the verified head -> red, tier not run
 *   (g) the PR is not OPEN -> red
 *   (h) `gh` could not run -> THROWS (infra), never a red the machine routes to a fix
 *   (i) the tier was killed at its bound -> THROWS, not a red
 *   (j) the tier could not be started -> THROWS
 *   (k) no verified head on the log -> THROWS (nothing to observe)
 *   (l) no PR on the log -> THROWS
 *   (m) the full tier falls back to `.pi/verify-cmd` when work.json has none
 *
 * Everything is offline: the forge is a recorder answering the pinned argv, the
 * tier is an `sh` command the recorder runs, and no PR or merge exists.
 */

import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { defaultConfig } from "../src/lean/config.ts";
import { ciOutcome } from "../src/lean/ci.ts";
import type { CiDeps } from "../src/lean/ci-deps.ts";
import { ROOTS, ciLandLog } from "./lib/lean-ci-land-fixture.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import type { Outcome } from "../src/lean/state.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HEAD = "b".repeat(40);

interface CiCase {
  /** What `loadConfig` answers; `full` absent means the project configured none. */
  full?: string;
  /** The `.pi/verify-cmd` line the seam answers (the fallback path). */
  verifyCmd?: string;
  /** The `gh pr view` reply. */
  view?: unknown;
  /** The `gh pr checks` reply. */
  checks?: unknown;
  /** Reject the `gh` reads instead of answering them. */
  ghFails?: boolean;
  /** Make the tier run reject (a kill or an un-startable command). */
  tierFails?: unknown;
  /** A tier that runs and exits non-zero (a real red), as a rejected exec. */
  tierExit?: number;
  /** The oid the verify step records, in place of the repo's own head. */
  verifiedHead?: string;
  /** The log carries no verified head at all. */
  noHead?: boolean;
  /** The `gh pr view` head; defaults to the log's real verified head. */
  prHead?: string;
  /** The log carries no publish step at all. */
  noPr?: boolean;
  /** Check the worktree out at this oid (the disk gate must catch it). */
  worktreeHead?: string;
  /** Leave the worktree's HEAD detached from the run's branch. */
  detached?: boolean;
  /** Write this untracked file into the worktree, so the tree is not clean. */
  dirtyFile?: string;
  /** The worktree exists but holds no checkout at all. */
  noWorktree?: boolean;
}

/**
 * The fixture's OWN git, run for real.
 *
 * `ci` re-reads HEAD, the branch and the porcelain of the worktree before it will
 * run its tier (`assertDiskAtVerifiedHead`), and the recorder receives those as
 * `exec("git", { argv })`. Answering them from a scripted constant would make the
 * step's whole disk guarantee unobservable: a recorder that returns whatever the
 * test expects has proven only that the test agrees with itself. So the `git`
 * branch below shells out to the fixture's real repo and returns what git really
 * says about the tree on disk.
 */
function realGit(cwd: string, argv: string[]): { stdout: string } {
  const r = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    env: {
      ...gitTestEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr ?? "").trim()}`);
  return { stdout: r.stdout ?? "" };
}

/** The log a run carries when it arrives at `ci`, minus what the case removes. */
function logOpts(c: CiCase): Parameters<typeof ciLandLog>[1] {
  return {
    ...(c.noHead === true ? { noVerifiedHead: true } : {}),
    ...(c.noPr === true ? { noPr: true } : {}),
    ...(c.verifiedHead === undefined ? {} : { verifiedHead: c.verifiedHead }),
    ...(c.worktreeHead === undefined ? {} : { worktreeHead: c.worktreeHead }),
    ...(c.detached === true ? { detached: true } : {}),
    ...(c.dirtyFile === undefined ? {} : { dirtyFile: c.dirtyFile }),
    ...(c.noWorktree === true ? { noWorktree: true } : {}),
  };
}

/** Run `ci` on a real verified+published log, with everything else a recorder. */
async function run(
  c: CiCase,
): Promise<{ outcome?: Outcome; threw?: Error; ran: string[]; wt: string }> {
  const f = ciLandLog(77, logOpts(c));
  const ran: string[] = [];
  const marker = c.full ?? c.verifyCmd ?? "";
  const deps: CiDeps = {
    exec: async (cmd, o) => {
      ran.push(cmd);
      if (cmd === marker) {
        if (c.tierFails !== undefined) throw c.tierFails;
        if (c.tierExit !== undefined)
          throw Object.assign(new Error(`Command failed: ${cmd}`), {
            code: c.tierExit,
            stdout: "",
            stderr: "boom from the full tier\n",
          });
        return { stdout: "" };
      }
      if (cmd.startsWith("gh pr ") && c.ghFails === true)
        throw new Error("gh: could not reach the API");
      if (cmd.startsWith("gh pr view "))
        return {
          stdout: JSON.stringify(
            c.view ?? {
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              headRefOid: c.prHead ?? f.head,
            },
          ),
        };
      if (cmd.startsWith("gh pr checks "))
        return { stdout: JSON.stringify(c.checks ?? [{ name: "ci", bucket: "pass" }]) };
      // The disk re-reads go to the fixture's real repo. The alternative — a
      // scripted answer — is what let a whole class of "green" mean nothing: the
      // step would have been graded against a HEAD nobody read off a disk.
      if (cmd === "git") return realGit(String(o?.cwd ?? f.repoRoot), (o?.argv ?? []) as string[]);
      return { stdout: "" };
    },
    loadConfig: async () => ({
      ...defaultConfig(),
      verify: { ...(c.full === undefined ? {} : { full: c.full }) },
    }),
    ...(c.verifyCmd === undefined ? {} : { readVerifyCmd: async () => c.verifyCmd }),
    tierTimeoutMs: 5_000,
  };
  try {
    return { outcome: await ciOutcome(f.ctx, deps), ran, wt: f.repoRoot };
  } catch (err) {
    return { threw: err as Error, ran, wt: f.repoRoot };
  }
}

// ── (a) both halves observed -> green, and BOTH commands really ran ────────
{
  const r = await run({ full: "true" });
  assert(r.outcome?.kind === "green", `(a) both halves observed -> green (${JSON.stringify(r.outcome ?? r.threw?.message)})`);
  assert(r.ran.some((c) => c.startsWith("gh pr view ")), "(a) the forge's merge verdict was read");
  assert(r.ran.some((c) => c.startsWith("gh pr checks ")), "(a) the check rows were read");
  assert(r.ran.includes("true"), "(a) the full tier actually ran");
}

// ── (b) no full tier -> red naming the gap, and the tier never ran ─────────
{
  const r = await run({});
  assert(r.outcome?.kind === "red", `(b) no full tier -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`);
  assert(
    (r.outcome?.reason ?? "").includes("no full verify tier"),
    `(b) the red names the missing full tier (${r.outcome?.reason})`,
  );
  assert(
    !r.ran.some((c) => c.startsWith("gh ")),
    "(b) a run with no full tier never reads the forge — there is no green on offer",
  );
}

// ── (c) the tier fails -> red carrying its tail ───────────────────────────
{
  const r = await run({ full: "tier", tierExit: 3 });
  assert(r.outcome?.kind === "red", `(c) a failing full tier -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`);
  assert(
    (r.outcome?.reason ?? "").includes("boom from the full tier"),
    `(c) the red carries the tier's own output (${r.outcome?.reason})`,
  );
  assert((r.outcome?.reason ?? "").includes("exited 3"), "(c) and the exit code it failed with");
}

// ── (d) a required check not passing -> red, tier never run ───────────────
{
  const r = await run({ full: "true", checks: [{ name: "test", bucket: "fail" }] });
  assert(r.outcome?.kind === "red", `(d) a failing check -> red (${JSON.stringify(r.outcome)})`);
  assert((r.outcome?.reason ?? "").includes("test"), "(d) the red names the failing check");
  assert(!r.ran.includes("true"), "(d) the tier was not run over a red CI");
}

// ── (e) `skipped` is not green, and neither is an empty list ──────────────
{
  const skipped = await run({ full: "true", checks: [{ name: "build", bucket: "skipped" }] });
  assert(skipped.outcome?.kind === "red", "(e) a skipped required check is not green");
  assert((skipped.outcome?.reason ?? "").includes("build"), "(e) and the red names it");
  const none = await run({ full: "true", checks: [] });
  assert(none.outcome?.kind === "red", "(e) no checks reported is not green either");
}

// ── (f) the PR moved off the verified head -> red, tier not run ───────────
{
  const r = await run({ full: "true", view: { state: "OPEN", mergeStateStatus: "CLEAN", headRefOid: "c".repeat(40) } });
  assert(r.outcome?.kind === "red", `(f) a moved head -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`);
  assert(
    (r.outcome?.reason ?? "").includes("is not the verified head"),
    `(f) the red names both heads (${r.outcome?.reason})`,
  );
  assert(!r.ran.includes("true"), "(f) a green about another head runs no tier over it");
}

// ── (g) the PR is not OPEN -> red ─────────────────────────────────────────
{
  const r = await run({ full: "true", view: { state: "MERGED", mergeStateStatus: "CLEAN", headRefOid: HEAD } });
  assert(r.outcome?.kind === "red", `(g) a closed PR -> red (${JSON.stringify(r.outcome)})`);
}

// ── (h) `gh` did not run -> infrastructure, never a routed red ────────────
{
  const r = await run({ full: "true", ghFails: true });
  assert(r.threw instanceof VerifyInfraError, `(h) an unreadable forge THROWS (${String(r.threw?.message)})`);
  assert(r.outcome === undefined, "(h) and produces no verdict the machine could route to a fix round");
}

// ── (i) the tier killed at its bound -> infrastructure, not a red ─────────
{
  const killed = Object.assign(new Error("was killed"), { killed: true });
  const r = await run({ full: "true", tierFails: killed });
  assert(r.threw instanceof VerifyInfraError, `(i) a killed tier THROWS (${String(r.threw?.message)})`);
}

// ── (j) the tier could not be started -> infrastructure ──────────────────
{
  const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  const r = await run({ full: "true", tierFails: enoent });
  assert(r.threw instanceof VerifyInfraError, `(j) an un-startable tier THROWS (${String(r.threw?.message)})`);
}

// ── (k) no verified head -> nothing to observe, so it throws ─────────────
{
  const r = await run({ full: "true", noHead: true });
  assert(
    r.threw instanceof VerifyInfraError && (r.threw.message ?? "").includes("no verified head"),
    `(k) no verified head on the log THROWS (${String(r.threw?.message)})`,
  );
}

// ── (l) no PR recorded -> throws ─────────────────────────────────────────
{
  const r = await run({ full: "true", noPr: true });
  assert(
    r.threw instanceof VerifyInfraError && (r.threw.message ?? "").includes("no PR"),
    `(l) no PR on the log THROWS (${String(r.threw?.message)})`,
  );
}

// ── (m) work.json names no full tier, .pi/verify-cmd does ───────────────
{
  const r = await run({ verifyCmd: "true" });
  assert(
    r.outcome?.kind === "green",
    `(m) the full tier falls back to .pi/verify-cmd (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(r.ran.includes("true"), "(m) and that command is the one that ran");
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);
