/**
 * lib/lean-ci-recorder — the `gh`/tier recorder the `ci` step is driven with.
 *
 * `ci` reaches exactly four things outside itself: the two pinned `gh` reads,
 * the project's full tier, and the worktree's own git. This module answers all
 * four so the two suites (`test-lean-ci.ts` for the step's decisions,
 * `test-lean-ci-poll.ts` for its wait) drive one recorder and differ only in
 * what they assert.
 *
 * **The disk re-reads are NOT scripted.** `ci` re-reads HEAD, the branch and the
 * porcelain of the worktree before it will run its tier
 * (`assertDiskAtVerifiedHead`), and a recorder that returned a scripted constant
 * for those would make the whole disk guarantee unobservable — the step would be
 * graded against a HEAD the test asserted rather than a disk it read, and a
 * no-op gate would stay green. So the `git` branch shells out to the fixture's
 * REAL repo and returns what git really says about the tree on disk.
 *
 * **The poll is expressible because the reads are sequenced.** A single constant
 * cannot say "pending now, passing later", so `viewAt` answers the Nth view read
 * (and `checksSeq` the Nth checks read), the last entry repeating — a poll never
 * runs out of replies. `sleep` MOVES the fixture clock the wait is bounded by (the
 * shape `test-forge-ci-watch.ts` drives `ciWatch` with): a sleep that only slept
 * would let the bound never expire and the case would hang, and a case that waits
 * without asking the fixture for a moving clock hangs instead of burning a real
 * 60 s per poll. That is the loud failure — no case here can reach production's
 * real timer.
 *
 * Everything stays offline: no PR is created, nothing is merged, and the tier is
 * an `sh` command the recorder answers.
 */

import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { defaultConfig } from "../../src/lean/config.ts";
import type { Budget } from "../../src/lean/config.ts";
import { ciOutcome } from "../../src/lean/ci.ts";
import type { CiDeps } from "../../src/lean/ci-deps.ts";
import type { PreexistingTierRecord } from "../../src/lean/state-outcome-maps.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { ROOTS, ciLandLog } from "./lean-ci-land-fixture.ts";
import { gitTestEnv } from "./git-test-env.ts";

export interface CiCase {
  /** What `loadConfig` answers; `full` absent means the project configured none. */
  full?: string;
  /** The `.pi/verify-cmd` line the seam answers (the fallback path). */
  verifyCmd?: string;
  /** The `gh pr view` reply (a single-read case; a poll uses `viewAt`). */
  view?: unknown;
  /** The `gh pr checks` reply. */
  checks?: unknown;
  /** Reject the `gh` reads instead of answering them. */
  ghFails?: boolean;
  /** Make the tier run reject (a kill or an un-startable command). */
  tierFails?: unknown;
  /** A tier that runs and exits non-zero (a real red), as a rejected exec. */
  tierExit?: number;
  /** The stream a red tier prints on its run at HEAD, for the #2042 name cases. */
  tierStdout?: string;
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
  /**
   * One `gh pr view` reply PER POLL: the function is called with the head the
   * case's own repo holds and returns either one reply or an array whose entry N
   * answers the Nth read, the last one repeating. A poll case is the whole point
   * — a single `view` cannot say "pending now, passing later", and a constant oid
   * is a head this repo never held (the step would be red before it polled).
   */
  viewAt?: (head: string) => unknown;
  /** One `gh pr checks` reply PER POLL, same rule as `viewAt`. */
  checksSeq?: unknown[];
  /** Reject the Nth `gh pr checks` read with this error (exit 8 lives here). */
  checksThrows?: unknown[];
  /** The wait's bound in ms, so a budget case does not wait 30 real minutes. */
  waitTimeoutMs?: number;
  /** Start the context's clock here (and give the poll a clock that MOVES). */
  clockMs?: number;
  /** The run's whole-cycle deadline, carried on the record the way the engine
   *  persists it. Drives the poll's cycle-clock check. */
  deadlineMs?: number;
  /** The full tier's wall clock, injected. `null` leaves the seam unset so the
   *  step takes `budgets.ci.minutes` through `ciMinutes`, and the case reads
   *  `Ran.tierTimeoutMs` to prove which number it used. A number overrides. */
  tierTimeoutMs?: number | null;
  /** The `budgets.ci` row the injected config carries. The wait bound and the
   *  tier's bound both come from here, so a case can prove which number the
   *  step actually read. A `minutes: 0` row is what the shipped-default rule is
   *  caught by: read literally it is a wait that expired before it started. */
  ciBudget?: Budget;
  /**
   * A `preexistingFailures` record to carry on the newest decided verify, for the
   * #2042 reuse cases: `ci` may reuse `verify`'s proof only when the command it is
   * about to run is byte-identical to the recorded one and that green certified the
   * very head `ci` judges, so the case declares the record and the recorder puts it
   * where production would have written it.
   */
  reuseRecord?: PreexistingTierRecord | Record<string, unknown>;
  /** What the base probe's full-tier run printed, for the re-probe cases. */
  baseTierOutput?: string;
  /** The run's frozen contract, committed at the base AND the run's head and recorded
   *  on the step log (see `lib/lean-ci-land-fixture.ts`'s `frozenFile`). */
  frozenBytes?: { path: string; bytes: string; baseBytes: string };
}

/**
 * A `gh pr view` reply for a poll case: OPEN, CLEAN, and at the head the case's
 * own repo holds — which is the head the gate certified, so the step gets to its
 * polls instead of being red on the first read.
 */
export function viewAt(
  head: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { state: "OPEN", mergeStateStatus: "CLEAN", headRefOid: head, ...over };
}

/**
 * The fixture's OWN git, run for real. See the module doc for why these reads
 * are never scripted.
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

/** What one run of the step left behind, read by the assertions below. */
export interface Ran {
  outcome?: Outcome;
  threw?: Error;
  /** Every command the step asked the executor to run, in order. */
  cmds: string[];
  /** Every `sleep` the poll took, in ms — its waits are observable, not implied. */
  slept: number[];
  /** The wall clock the TIER was run under, in ms, or `undefined` when the tier
   *  never ran. The tier's bound must be its OWN — the same `ci` budget the wait
   *  consumed, given again in full afterwards — and a bound read off a constant
   *  in the test proves nothing about that. */
  tierTimeoutMs?: number;
  /** The oid the fixture's real repo holds, which is the head the PR must match. */
  head: string;
  /** How many times the full tier's command ran — at HEAD, and at the base probe. */
  tierRuns?: number;
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
    ...(c.clockMs === undefined ? {} : { clockMs: c.clockMs }),
    ...(c.frozenBytes === undefined ? {} : { frozenFile: { ...c.frozenBytes } }),
  };
}

/** The Nth element of a sequence, the last one repeating — a poll never runs out. */
function at<T>(seq: T[], n: number): T {
  return seq[Math.min(n, seq.length - 1)] as T;
}

/** Run `ci` on a real verified+published log, with everything else a recorder. */
export async function run(c: CiCase): Promise<Ran> {
  const f = ciLandLog(77, logOpts(c));
  // The engine writes the resolved cycle deadline onto the record; a case that
  // wants the poll to see one sets it here, on the object the handler is given.
  if (c.deadlineMs !== undefined) f.ctx.run = { ...f.ctx.run, deadlineMs: c.deadlineMs };
  const ran: Ran = { cmds: [], slept: [], head: f.head, tierRuns: 0 };
  let viewReads = 0;
  let checksReads = 0;
  // The #2042 reuse cases put `verify`'s disclosure on the newest decided verify —
  // the one field of that record the case is allowed to own. The head it certified
  // stays whatever `logOpts` built, because whether reuse is allowed IS that fact.
  if (c.reuseRecord !== undefined) {
    const v = f.ctx.steps.find((s) => s.state === "verify");
    if (v?.outcome !== undefined)
      v.outcome = { ...v.outcome, preexistingFailures: { full: c.reuseRecord } as never };
  }
  const marker = c.full ?? c.verifyCmd ?? "";
  const deps: CiDeps = {
    exec: async (cmd, o) => {
      ran.cmds.push(cmd);
      if (cmd === marker) {
        // The bound the step asked for, recorded before anything can throw: this
        // is the tier's own wall clock, and the case that cares reads it here.
        ran.tierTimeoutMs = o?.timeout;
        ran.tierRuns = (ran.tierRuns ?? 0) + 1;
        // The base probe runs the SAME command in a throwaway checkout; a case that
        // declares what that run printed owns its stream, exactly as the verify
        // recorder does for `verify`'s own probe. The probe's tree is identified by
        // PATH, not by a counter: a case that reuses a record never reaches a second
        // run, and a counter alone would grade a third HEAD run as the base.
        if (c.baseTierOutput !== undefined && String(o?.cwd ?? "").includes(".baseline-lean-verify-"))
          throw Object.assign(new Error(`Command failed: ${cmd}`), {
            code: 1,
            stdout: c.baseTierOutput,
            stderr: "",
          });
        if (c.tierFails !== undefined) throw c.tierFails;
        if (c.tierExit !== undefined)
          throw Object.assign(new Error(`Command failed: ${cmd}`), {
            code: c.tierExit,
            stdout: c.tierStdout ?? "",
            stderr: "boom from the full tier\n",
          });
        return { stdout: "" };
      }
      if (
        cmd === "git" &&
        c.baseTierOutput !== undefined &&
        String(o?.cwd ?? "") === f.repoRoot &&
        Array.isArray(o?.argv) &&
        o.argv.some((a, i) => a === "worktree" && o.argv?.[i + 1] === "add")
      ) {
        // Only a case that owns the probe's tier output can reach the tier at all, so
        // only such a case gets its `git worktree add` sent to the fixture's REAL git —
        // a checkout the recorder invented would be a tree the cleanup cases could not
        // read back. Every other case keeps this recorder's pre-existing behaviour,
        // which answers a git command the step never asked it to script with an empty
        // success (the poll suite counts reads and depends on that).
        return realGit(String(o?.cwd ?? f.repoRoot), (o?.argv ?? []) as string[]);
      }
      if (cmd.startsWith("gh pr ") && c.ghFails === true)
        throw new Error("gh: could not reach the API");
      if (cmd.startsWith("gh pr view ")) {
        const n = viewReads++;
        if (c.viewAt !== undefined) {
          const built = c.viewAt(f.head);
          return { stdout: JSON.stringify(Array.isArray(built) ? at(built, n) : built) };
        }
        return {
          stdout: JSON.stringify(
            c.view ?? {
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              headRefOid: c.prHead ?? f.head,
            },
          ),
        };
      }
      if (cmd.startsWith("gh pr checks ")) {
        const n = checksReads++;
        if (c.checksThrows !== undefined && n < c.checksThrows.length)
          throw at(c.checksThrows, n);
        if (c.checksSeq !== undefined) return { stdout: JSON.stringify(at(c.checksSeq, n)) };
        return { stdout: JSON.stringify(c.checks ?? [{ name: "ci", bucket: "pass" }]) };
      }
      // The disk re-reads go to the fixture's real repo. The alternative — a
      // scripted answer — is what let a whole class of "green" mean nothing: the
      // step would have been graded against a HEAD nobody read off a disk.
      if (cmd === "git") return realGit(String(o?.cwd ?? f.repoRoot), (o?.argv ?? []) as string[]);
      return { stdout: "" };
    },
    loadConfig: async () => ({
      ...defaultConfig(),
      verify: { ...(c.full === undefined ? {} : { full: c.full }) },
      ...(c.ciBudget === undefined
        ? {}
        : { budgets: { ...defaultConfig().budgets, ci: { ...c.ciBudget } } }),
    }),
    ...(c.verifyCmd === undefined ? {} : { readVerifyCmd: async () => c.verifyCmd }),
    ...(c.tierTimeoutMs === null ? {} : { tierTimeoutMs: c.tierTimeoutMs ?? 5_000 }),
    ...(c.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: c.waitTimeoutMs }),
    // The injected sleep MOVES the clock the wait is bounded by — the same
    // trio `test-forge-ci-watch.ts` drives `ciWatch` with. A sleep that only
    // slept would let the bound never expire and the case hang.
    sleep: async (ms) => {
      ran.slept.push(ms);
      f.tick(ms);
    },
    // The poll's own clock. It is the fixture's clock, so `tick` above and
    // `now` here can never disagree about what time the wait thinks it is.
    now: () => f.ctx.now(),
  };
  try {
    ran.outcome = await ciOutcome(f.ctx, deps);
  } catch (err) {
    ran.threw = err as Error;
  }
  return ran;
}

/** Remove every temp repo this module created. Call at the end of a suite. */
export function cleanUp(): void {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
}
