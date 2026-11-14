/**
 * lib/lean-guard-fail-closed-callers — the three force-push sites driven with a
 * mainline that will not answer.
 *
 * `assertPublishableBranch` is shared by `publish`, the review step's fix push and
 * the verified handback's rewind, and each reaches it through ITS OWN exec seam:
 * `publish` passes `deps.exec`, the rewind passes the `VerifyExec` it was handed,
 * and `review` passes `deps.exec` down through `assertReviewEntry`. A guard that
 * grew an exec parameter while two of its three callers went on calling it without
 * one would stay green on the unit-level cases of
 * `test-lean-publish-guard-fail-closed.ts` — the guard would answer its probes from
 * a module-level executor no case can see. So each caller is driven here through one
 * recorder, and each case asserts on what THAT caller's seam observed.
 *
 * The recorder is deliberately a pass-through in front of the caller's real
 * executor rather than a stub: it answers only the guard's own probe command lines,
 * taken from `MAINLINE_PROBE_COMMANDS`, and forwards everything else untouched.
 * Three consequences, each of which is a claim a weaker fake would let a case make
 * falsely:
 *
 *   - every probe is RECORDED before it is answered, including the ones production
 *     makes and the fake has no script for. A script that recorded only what it
 *     answered made the "all three probes were asked" assertion true by construction
 *     and hid the probe nobody answered — which is the exact shape of the fail-open
 *     this guard exists to catch.
 *   - the steps' own git still runs, so origin decides what origin holds. A case
 *     that swallowed the argv form would watch a step that never got anywhere and
 *     report the silence as a refusal.
 *   - the run's branch is a real lean branch at a real head already reachable on
 *     origin, and `head`/`originBranch` are read back to prove it. "Nothing was
 *     pushed" is only an observation about the guard once a pass would have written.
 *
 * `arm` picks which resolution the case drives:
 *
 *   - `"local"` — the clone answers `refs/remotes/origin/HEAD`, so the guard
 *     resolves without asking origin at all. Every legitimate run takes this arm;
 *     the drivers READ the ref back off the clone and throw if it is missing,
 *     because a silent absence would drive the fail-closed arm while the case
 *     reported the legitimate one.
 *   - `"origin"` — both local probes answer nothing (a shallow clone with no `gh`),
 *     and origin's symref probe answers `symref`. This is the arm R2 exists for and
 *     the only one in which the third probe decides anything.
 *   - `"dead"` — nothing answers any of the three. The fail-closed arm.
 */

import { spawnSync } from "node:child_process";
import { execp } from "../../src/exec.ts";
import { rewindToVerified } from "../../src/lean/handback-rewind.ts";
import type { Rewind } from "../../src/lean/handback-rewind.ts";
import { MAINLINE_PROBE_COMMANDS } from "../../src/lean/publish-deps.ts";
import type { ReviewDeps } from "../../src/lean/review.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { runPublish } from "./lean-publish-fixture.ts";
import {
  BRANCH,
  FIXER_ROLE,
  ctxFor,
  depsWith,
  git,
  makeRepo,
  rejectsThenClears,
  result,
  runStep,
  setup,
} from "./lean-review-fixtures.ts";
import {
  BRANCH as HANDBACK_BRANCH,
  ISSUE as HANDBACK_ISSUE,
} from "./lean-verified-handback-fixture.ts";
import { originRefSha, repoWithFixHead } from "./lean-verified-handback-repo.ts";

/** Every probe the `"dead"` arm refuses does so with this, so causes are checkable. */
export const PROBE_CAUSE = "guard-probe-could-not-answer";

/** The three command lines the guard may ask, in the order production asks them. */
export const GUARD_PROBES: readonly string[] = MAINLINE_PROBE_COMMANDS;

/** Which mainline resolution a driver drives. See the module header. */
export type ProbeArm = "local" | "origin" | "dead";

/** What one driver observed on the exec seam its caller owns. */
export interface CallerDrive {
  /** The error the step answered with; `undefined` when it went through. */
  threw?: Error;
  /** The guard's probe command lines that reached this seam, in order. */
  probes: string[];
  /** The argv-form lines of every push this seam saw attempted. */
  pushed: string[];
  /** What origin holds for the run's branch afterwards ("" when it has no such branch). */
  originBranch: string;
  /**
   * What the same reader saw for that branch BEFORE the step ran (`driveRewind` only).
   * Optional because the other two drivers read origin once — after their step, which
   * either pushed or was refused — and inventing a "before" they never took would be a
   * fact with no observation behind it.
   */
  originHeldBefore?: string;
  /** Children the step paid for — a refusal at the entry gate must buy none. */
  dispatches: number;
  /** The head the run would have pushed: the case's own premise, read back. */
  head: string;
  /** The bare origin the case pushes to, for a caller that reads a second ref. */
  origin: string;
  /** What the fake forge recorded (publish only; the other steps post nothing). */
  forgeCalls: number;
}

/** The `ls-remote --symref` reply naming `branch` as origin's HEAD ("" = no answer). */
function symrefReply(branch: string): string {
  if (branch === "") return "";
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4";
  return [`ref: refs/heads/${branch}\tHEAD`, `${sha}\tHEAD`, `${sha}\trefs/heads/${branch}`].join(
    "\n",
  );
}

/** The rejection a refused probe raises: an exit with a cause, never a hang. */
function probeRejection(): Error {
  return Object.assign(new Error(PROBE_CAUSE), { code: 1, killed: false, signal: null });
}

/** The branch a clone's `refs/remotes/origin/HEAD` names, or undefined when it has none. */
function cloneOriginHeadBranch(repoRoot: string): string | undefined {
  const r = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitTestEnv(),
  });
  if (r.status !== 0) return undefined;
  const name = (r.stdout ?? "").trim().replace(/^origin\//, "");
  return name === "" ? undefined : name;
}

/**
 * Wrap a caller's real executor so the guard's probes are answered AND recorded.
 *
 * `real` is what the caller would have used — `execp` for the rewind, the review
 * fixture's env-scrubbed executor for the review step, the publish fixture's
 * recorder for publish — so nothing but the three probe lines is touched, and every
 * argv-form git call still reaches git.
 *
 * A probe is recorded before the arm decides its fate, so a probe production asks and
 * this script has no branch for still shows up in `probes` unanswered. That is the
 * whole reason the tally is asserted beside each refusal.
 */
export function withProbeScript(
  real: VerifyExec,
  opts: { arm: ProbeArm; symref?: string; localHead?: string },
  seen: { probes: string[]; pushes: string[] },
): VerifyExec {
  return (cmd, o) => {
    if (o?.argv === undefined && (GUARD_PROBES as readonly string[]).includes(cmd)) {
      seen.probes.push(cmd);
      if (cmd === GUARD_PROBES[2])
        return Promise.resolve({
          stdout: opts.arm === "origin" ? symrefReply(opts.symref ?? "") : "",
          stderr: "",
        });
      // The two LOCAL probes — `git symbolic-ref` on the clone's own
      // `refs/remotes/origin/HEAD`, and the `gh repo view` fallback it falls through
      // to. On the `"local"` arm both go to the caller's real executor, so the case
      // watches git and the forge CLI actually answer rather than reading strings
      // this script supplied; on every other arm both answer nothing, which is what
      // makes `resolveMainline` come back not-ok with causes. An empty SUCCESS from
      // `gh` would be an answer ("no default branch"), making the resolution ok with
      // an empty name and the guard return without ever asking origin — the fail-open
      // wearing the fail-closed's clothes, which is why "nothing" means a refusal here.
      if (cmd === GUARD_PROBES[0] || cmd === GUARD_PROBES[1])
        return opts.arm === "local" ? real(cmd, o) : Promise.reject(probeRejection());
      // The origin probe is scripted on every arm: on `"origin"` it answers with
      // `symref`, and on the other two it says nothing at all.
      return Promise.resolve({
        stdout: opts.arm === "origin" ? symrefReply(opts.symref ?? "") : "",
        stderr: "",
      });
    }
    if (o?.argv?.includes("push") === true) seen.pushes.push([cmd, ...o.argv].join(" "));
    return real(cmd, o);
  };
}

/**
 * What ORIGIN holds for one branch, read with `ls-remote` and nothing else.
 *
 * `originRefSha` is the harness's own reader — `git ls-remote . <ref>` run in the
 * bare repo — and it is used here rather than a `rev-parse` of the origin directory
 * because these are the same bytes the rewind's own `ls-remote` reads. A reader that
 * disagreed with the step's reader is a second opinion nobody asked for, and the
 * claim ("origin still holds the head the run pushed") is about origin, not about a
 * local view of it.
 */
function originRefOf(origin: string, branch: string): string {
  const r = spawnSync("git", ["ls-remote", "--", origin, `refs/heads/${branch}`], {
    // No cwd: this read is about a bare repo named by path, and inheriting the
    // suite's cwd would let a stale checkout resolve `origin` for it.
    encoding: "utf8",
    env: gitTestEnv(),
  });
  // A failed read is NOT "the branch is absent" — it is a read that did not happen,
  // and collapsing the two is how a fixture problem becomes a confident wrong claim
  // about origin. The suites that need the absent answer get it from an exit-0 empty
  // reply; anything else has to say so.
  if (r.status !== 0)
    throw new Error(
      `could not read origin's ${branch}: git ls-remote exited ${String(r.status)}: ${(r.stderr ?? "").trim()}`,
    );
  const out = (r.stdout ?? "").trim();
  if (out === "") return "";
  if (out.split("\n").length > 1)
    throw new Error(
      `origin answered ${branch} with more than one row — the read is ambiguous: ${out}`,
    );
  const [sha = ""] = out.split(/\s+/);
  return sha;
}

/** The PUBLISH step, driven through the fixture's own `deps.exec`. */
export async function drivePublish(opts: {
  branch: string;
  arm?: ProbeArm;
  symref?: string;
}): Promise<CallerDrive> {
  const seen = { probes: [] as string[], pushes: [] as string[] };
  const arm = opts.arm ?? "dead";
  const r = await runPublish({
    issue: 7,
    verify: { kind: "green" },
    branch: opts.branch,
    // The tree stays checked out on a real lean ref: only the name the state file
    // names is under test, exactly as `test-lean-publish.ts` (l) does it.
    worktreeBranch: BRANCH,
    noPush: true,
    // The fixture forwards this to the executor its `deps.exec` consults for EVERY
    // call, which is the same object `publishOutcome` hands the guard — so the
    // probes land on the seam this caller actually owns, and every argv-form call
    // the step makes still reaches git.
    execOver: (cmd, o) => {
      if (o?.argv === undefined && (GUARD_PROBES as readonly string[]).includes(cmd)) {
        seen.probes.push(cmd);
        // The clone probe is answered by the FIXTURE's own git, not by this script:
        // the rig writes `refs/remotes/origin/HEAD`, and a script that answered it
        // itself would be reporting a clone that never had to read its own ref.
        if (cmd === GUARD_PROBES[0] && arm === "local") return undefined;
        if (cmd === GUARD_PROBES[2])
          return Promise.resolve({
            stdout: arm === "origin" ? symrefReply(opts.symref ?? "") : "",
            stderr: "",
          });
        // See `withProbeScript`: `gh` must REFUSE wherever the clone did not answer
        // its own ref, or the resolution comes back ok-with-an-empty-name and the
        // guard returns without ever asking origin.
        return arm === "local"
          ? Promise.resolve({ stdout: "", stderr: "" })
          : Promise.reject(probeRejection());
      }
      if (o?.argv?.includes("push") === true) seen.pushes.push([cmd, ...o.argv].join(" "));
      return undefined;
    },
  });
  return {
    threw: r.threw,
    probes: seen.probes,
    pushed: seen.pushes,
    originBranch: originRefOf(r.origin, opts.branch),
    dispatches: 0,
    head: r.head,
    origin: r.origin,
    forgeCalls: r.forge.prCreateCalls.length,
  };
}

/**
 * The REVIEW step, at a run branch whose head is real and already on origin — the
 * fix push would have landed had the guard passed.
 */
export async function driveReview(opts: {
  branch: string;
  arm?: ProbeArm;
  symref?: string;
  /** Rewrite origin's HEAD to this branch before the step runs. */
  originHead?: string;
}): Promise<CallerDrive> {
  const { repoRoot, origin, baseSha } = makeRepo();
  const head = await setup({
    repoRoot,
    baseSha,
    branch: opts.branch,
    feature: "export const f = 1;\n",
  });
  if (opts.originHead !== undefined) {
    // Point origin's HEAD at the branch under test — the shape a repo takes when the
    // run's branch has become its default. Set on origin itself, because that is the
    // side `ls-remote --symref` answers from.
    git(origin, "symbolic-ref", "HEAD", `refs/heads/${opts.originHead}`);
  }
  const arm = opts.arm ?? "dead";
  const localHead = arm === "local" ? mustHaveCloneHead(repoRoot) : cloneOriginHeadBranch(repoRoot);
  let dispatches = 0;
  const deps: ReviewDeps = depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer will answer"),
    dispatch: async () => {
      dispatches++;
      return result({ role: FIXER_ROLE });
    },
  });
  const seen = { probes: [] as string[], pushes: [] as string[] };
  deps.exec = withProbeScript(deps.exec, { arm, symref: opts.symref, localHead }, seen);
  const { threw } = await runStep(ctxFor(repoRoot, baseSha, opts.branch), deps);
  return {
    threw,
    probes: seen.probes,
    pushed: seen.pushes,
    originBranch: originRefOf(origin, opts.branch),
    dispatches,
    head,
    origin,
    forgeCalls: 0,
  };
}

/**
 * The HANDBACK REWIND over the fixture's real origin, at a run branch whose head is
 * reachable there.
 *
 * The rewind's contract is that it always answers, so a refusal arrives as a
 * `Rewind` with `shipped: false` rather than a throw; `originBranch` is the fact
 * that makes the answer mean something.
 */
export async function driveRewind(opts: {
  /** The branch the rewind is asked to move. "" keeps the rig's own. */
  branch?: string;
  /**
   * Which resolution the case drives. `"local"` is excluded: this rig's clone would
   * need the ref writing, and a written ref would not be the ordinary state a rewind
   * runs in. `"origin"` — both local probes refusing and origin answering — is the
   * legitimate arm these cases use, and it is the same arm `publish`'s (p2) takes.
   */
  arm?: Exclude<ProbeArm, "local">;
  symref?: string;
}): Promise<CallerDrive & { rewind: Rewind; verifiedHead: string }> {
  const repo = repoWithFixHead();
  const arm = opts.arm ?? "dead";
  const seen = { probes: [] as string[], pushes: [] as string[] };
  const exec = withProbeScript(
    (cmd, o) => execp(cmd, { ...(o ?? {}), env: gitTestEnv() }),
    { arm, symref: opts.symref },
    seen,
  );
  // Read origin BEFORE the drive too, with this same reader: the case's claim is a
  // comparison between two readings of one ref, and a post-only reading cannot
  // distinguish "the refusal moved nothing" from "this branch was never there".
  const heldBefore = originRefOf(repo.origin, opts.branch ?? HANDBACK_BRANCH);
  const rewind = await rewindToVerified(
    exec,
    {
      repoRoot: repo.repoRoot,
      issue: HANDBACK_ISSUE,
      run: { branch: opts.branch ?? HANDBACK_BRANCH },
    } as never,
    repo.baseSha,
    { net: true },
  );
  return {
    threw: undefined,
    probes: seen.probes,
    pushed: seen.pushes,
    originBranch: originRefOf(repo.origin, opts.branch ?? HANDBACK_BRANCH),
    originHeldBefore: heldBefore,
    dispatches: 0,
    head: repo.headSha,
    origin: repo.origin,
    forgeCalls: 0,
    rewind,
    verifiedHead: repo.baseSha,
  };
}

/** The clone's `origin/HEAD`, or a throw naming the arm whose premise is missing. */
function mustHaveCloneHead(repoRoot: string): string {
  const localHead = cloneOriginHeadBranch(repoRoot);
  if (localHead === undefined)
    throw new Error(
      `the "local" arm needs the clone's own refs/remotes/origin/HEAD and ${repoRoot} has none`,
    );
  return localHead;
}
