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

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { detectForge } from "../../src/forge-detect.ts";
import type { Forge } from "../../src/forge-types.ts";
import type { CiDeps } from "../../src/lean/ci-deps.ts";
import { ciOutcome } from "../../src/lean/ci.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { Budget } from "../../src/lean/config.ts";
import type { PreexistingTierRecord } from "../../src/lean/state-outcome-maps.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { gitTestEnv } from "./git-test-env.ts";
import type { GlCase } from "./lean-ci-gl.ts";
import { ROOTS, ciLandLog } from "./lean-ci-land-fixture.ts";

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
  /**
   * Which forge this run is on. Absent means the GitHub behaviour every existing
   * case drives — the two pinned `gh` reads and gh's bucket-first row grading,
   * byte for byte. `"gitlab"` routes the run through the recorder's glab arm
   * instead: the step issues `glab api /projects/:id/merge_requests/N`,
   * `…/pipelines` and `…/pipelines/<id>/jobs`, and the MR row it reads is the
   * `GL_MR` fixture with `diff_refs.head_sha` set to the head the case's repo
   * really holds, and an `open_pipeline` at that same commit — the step pins the
   * jobs read to the head, so a pipeline at another commit is refused. A GitLab case therefore answers glab and nothing else,
   * and the suite's assertion that no command starts with `gh ` is a witness, not
   * a wish.
   * `"self-hosted"` is the same read after the REAL detection seam: a `.pi/forge`
   * carrying `type=gitlab` and `host=` plus an SSH remote on that host, which is
   * the operator config the known-host table alone would have answered `unknown`.
   * `"none"` is `forgeFor` answering `undefined` — the step must throw and must
   * not fall back to `gh`.
   */
  forge?: "github" | "gitlab" | "self-hosted" | "none";
  /** One MR row PER POLL, the last entry repeating — same rule as `viewAt`. */
  mrAtReads?: (head: string) => unknown[];
  // The three GitLab case fields below are the ones a case may hand straight to
  // the fixture, so their types are `GlCase`'s OWN — declared once in
  // `./lean-ci-gl.ts` and picked from here. `CiCase extends GlCase` is the wrong
  // shape (the GitHub axis has no business naming MR/pipeline fields, and the
  // two axes are mutually exclusive), but re-typing one of these fields in two
  // places is how the recorder went red against its own fixture module: the
  // `as const` job rows of a test case and a `Record<string, unknown>[]`
  // declaration do not agree, and only a typecheck of both files sees it.
  /** The MR row the recorder answers, in place of `GL_MR` (a poll passes a
   *  sequence through `mrAtReads` instead). `diff_refs` is left as given here. */
  mr?: GlCase["mr"];
  /** The job rows the pipeline read answers (snake_case `status`, as GitLab
   *  sends them). Defaults to the two-success `GL_JOBS` fixture. */
  jobs?: GlCase["jobs"];
  /** The same jobs read's SECOND page (`?page=2`), which the step probes when
   *  the first page came back full. `[]` — the default — is a pipeline that
   *  really did fit in one page; `null` says this case must never be asked for
   *  job rows at all. */
  jobsPage2?: GlCase["jobsPage2"];
  /** The MR's pipelines reply. `[]` is the MR with no pipeline at all. */
  pipelines?: GlCase["pipelines"];
  /** The MR reply names no pipeline: no jobs read is made at all. */
  noPipeline?: GlCase["noPipeline"];
  /** The head the MR reply reports, for a case whose MR moved off the head this
   *  repo holds. */
  mrHead?: GlCase["mrHead"];
  /** The commit the MR's pipeline reports it built — `null` for the pipeline
   *  that names no commit, another sha for a tag/schedule pipeline. */
  pipelineSha?: GlCase["pipelineSha"];
  /** The self-hosted host for a `self-hosted` case (default `gitlab.example.com`). */
  glHost?: GlCase["glHost"];
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
   * A `preexistingFailures` record to carry on the newest decided verify. Nothing reuses
   * it — `ci` always pays its own base probe — so what the cases declare with it are the
   * PRE-#2100 step-log shapes (`cmd` plus a `baseNames` set nothing reads) that a resumed
   * run still has to load and still has to buy a full probe.
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
export function viewAt(head: string, over: Record<string, unknown> = {}): Record<string, unknown> {
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
  /** How many GitLab pipeline-job reads the poll issued — the witness for ONE
   *  read per poll (the readiness used to read the same page a second time) and
   *  for the single page-2 probe a full page earns. */
  jobsReads?: number;
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

// The GitLab fixture half — the MR rows, the self-hosted config, the real
// `createForge` — lives in `./lean-ci-gl.ts` and is re-exported so the GitLab
// suite imports its fixtures from the one module it already imports everything
// else from.
export {
  glMrChecking,
  glMrHeadless,
  glMrShortHead,
  SELF_HOST,
  glPrUrl,
  rewritePrUrl,
  writeSelfHosted,
  type GlCase,
} from "./lean-ci-gl.ts";
import {
  SELF_HOST,
  glForge as buildGlForge,
  glPrUrl,
  rewritePrUrl,
  writeSelfHosted,
} from "./lean-ci-gl.ts";

/**
 * Run `ci` on a real verified+published log, with everything else a recorder.
 *
 * The head the run is about is the one the case's repo really holds — the head the
 * verify gate certified — and the GitLab fixture's MR reply, its embedded pipeline
 * and the pipelines row all follow it, because the step pins the jobs read to the
 * head (see `ci-forge-gl.ts`). The head is decided INSIDE `run`, after the fixture
 * repo is built, and handed back on `Ran.head`.
 */
export async function run(c: CiCase): Promise<Ran> {
  const f = ciLandLog(77, logOpts(c));
  // The single head this run is about: the fixture repo's own commit, which is the
  // head the verify step certified. Every forge read the recorder answers — gh's
  // `headRefOid`, the MR's `diff_refs.head_sha`, its embedded pipeline's `sha` and
  // the pipelines row's `sha` — is stamped with it, so the step's head check is a
  // check about the commit the run verified, and a case that wants a disagreement
  // says so in the rows it names (`verifiedHead`, `mr`, `pipelines`).
  const committed = c.verifiedHead ?? f.head;
  // The engine writes the resolved cycle deadline onto the record; a case that
  // wants the poll to see one sets it here, on the object the handler is given.
  if (c.deadlineMs !== undefined) f.ctx.run = { ...f.ctx.run, deadlineMs: c.deadlineMs };
  const ran: Ran = { cmds: [], slept: [], head: committed, tierRuns: 0, jobsReads: 0 };
  let viewReads = 0;
  let checksReads = 0;
  // The legacy-record cases put `verify`'s disclosure on the newest decided verify — the
  // one field of that record the case is allowed to own. The head it certified stays
  // whatever `logOpts` built, because whether a record is about this head IS that fact.
  if (c.reuseRecord !== undefined) {
    const v = f.ctx.steps.find((s) => s.state === "verify");
    if (v?.outcome !== undefined) {
      const carried = { full: c.reuseRecord } as Record<string, PreexistingTierRecord>;
      v.outcome = { ...v.outcome, preexistingFailures: carried };
    }
  }
  const marker = c.full ?? c.verifyCmd ?? "";
  const forgeAxis = c.forge ?? "github";
  const gitlab = forgeAxis === "gitlab" || forgeAxis === "self-hosted";
  // The publish step's URL is the ONE place the step may read the number from, so
  // a GitLab case rewrites it: leaving the GitHub PR URL in place would have the
  // case exercise the parser it was meant to prove.
  if (gitlab) rewritePrUrl(f, glPrUrl());
  // Self-hosted detection is the operator's real config, so it is set up the
  // operator's real way: a `.pi/forge` naming the type and host, plus an SSH
  // remote on that host. A fixture that only set `PI_ENSEMBLE_FORGE` would leave
  // the config-and-remote leg of `detectForge` unexercised — the leg that decides
  // whether a self-hosted project is a GitLab project at all.
  if (forgeAxis === "self-hosted") writeSelfHosted(f.repoRoot, c.glHost ?? SELF_HOST);
  // The forge the step reads through. The GitHub axis answers with a `github`
  // adapter, which is what every existing case already exercised implicitly: it
  // asserted the gh argv and gh graded the rows. Every GitLab axis gets the REAL
  // adapter — `createForge(glDetection(…))` over the exec fake below — so the
  // readiness composition, the pipelines lookup and the job mapping under test
  // are the production ones and the argv is the adapter's pinned form, not a
  // seam shaped to match this suite's own expectations.
  const glForge: Forge | undefined = gitlab
    ? await buildGlForge(c, f.repoRoot, committed, forgeAxis === "self-hosted", (cmd) => {
        ran.cmds.push(cmd);
        if (/\/jobs/.test(cmd) && cmd.startsWith("glab ")) ran.jobsReads = (ran.jobsReads ?? 0) + 1;
      })
    : undefined;
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
        // run, and a counter alone would grade a third HEAD run as the base. The stamp
        // this stub gives the HEAD run is `boom from the <tier>`, written by THIS recorder
        // rather than by the project — so the base run of the same command gets the SAME
        // stamp. Two runs of one tier must print identical residue for the excuse to
        // compare them verbatim, and a stamp the base never printed is a head-only line.
        if (
          c.baseTierOutput !== undefined &&
          String(o?.cwd ?? "").includes(".baseline-lean-verify-")
        )
          throw Object.assign(new Error(`Command failed: ${cmd}`), {
            code: 1,
            stdout: c.baseTierOutput,
            stderr: "boom from the full tier\n",
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
        if (c.checksThrows !== undefined && n < c.checksThrows.length) throw at(c.checksThrows, n);
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
    // The forge seam the step reads the PR/MR through. On the GitHub axis this
    // goes through the SAME detection production uses (`detectForge` on a plain
    // `git init` clone answers `github` via the known-host table only when a
    // remote exists, so the recorder supplies the adapter for that axis) and
    // `"none"` is the forge-less clone: the step must throw rather than fall back
    // to the gh argv. A self-hosted case is the one axis that asks the detector
    // itself, so a broken `.pi/forge` leg fails the case instead of being stubed
    // around.
    forge: async (repoRoot) => {
      if (forgeAxis === "none") return undefined;
      if (gitlab) {
        if (forgeAxis === "self-hosted") {
          const det = await detectForge(repoRoot, {});
          if (det.forge !== "gitlab")
            throw new Error(
              `self-hosted detection answered ${det.forge}/${String(det.host)} for .pi/forge + git@ remote — the case's premise is gone`,
            );
        }
        return glForge;
      }
      return { forge: "github" } as unknown as Forge;
    },
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
