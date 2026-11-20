/**
 * lib/lean-publish-fixture — the harness the `lean/publish` smoke tests share.
 *
 * The step's two outside-world claims are git and forge claims, so one is real
 * and the other is observed: a temp repo with a real `origin` (a bare repo on
 * disk, so `git push` really writes refs into it and a case can read the branch
 * back out of it) and a FAKE forge that records every `prList` / `prCreate` call
 * it receives. The push assertions are therefore about the bytes origin holds,
 * not about what a stub said it did. The forge itself lives in
 * `lean-publish-forge.ts` and the shapes origin can start in in
 * `lean-publish-origin.ts`; this file builds the tree and runs the step.
 *
 * The tree is the shape `specify`/`build`/`verify` leave behind: a base commit,
 * an implementation commit on the run's branch, and a step log carrying the
 * frozen tests and (when the case asks) a decided green `verify` naming that
 * head. Cases then break one invariant each — a dirty file, a moved head, a
 * foreign commit already on origin's branch — and the step has to refuse.
 *
 * `runPublish` returns `{outcome, threw, head, forge}` and never throws, so a
 * case asserts on the error's own type and message rather than on a try/catch
 * shape that can swallow the assertion.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { NormalizedPullRequest } from "../../src/forge-types.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { PublishDeps } from "../../src/lean/publish-deps.ts";
import { renderPiSpec } from "../../src/lean/spec.ts";
import type { PiSpec } from "../../src/lean/spec.ts";
import { NO_HOOKS } from "../../src/lean/specify-reset.ts";
import { specifyWorktreePath } from "../../src/lean/specify-tree.ts";
import type { PreexistingTierRecord } from "../../src/lean/state-outcome-maps.ts";
import type { LeanRun, Outcome, Step } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import { netGitEnv } from "../../src/work-driver-net-git.ts";
import { gitTestEnv, writeCloneMainlineRef } from "./git-test-env.ts";
import { originHead } from "./lean-publish-asserts.ts";
import { type FakeForge, fakeForge, fakePr, prWithState } from "./lean-publish-forge.ts";
import { TEST_FILE_CONTENT as TEST, logFor, priorPublishStep } from "./lean-publish-log.ts";
import {
  ORIGIN_ROOTS,
  type OriginStale,
  commitFile,
  seedFastForwardOrigin,
  seedForeignOrigin,
  seedOneCommitStaleOrigin,
  seedOwnPublishOrigin,
  seedStaleOrigin,
} from "./lean-publish-origin.ts";
import type { PublishRemoteSeeds } from "./lean-publish-remote-seeds.ts";
import type { PublishSeams } from "./lean-publish-seams.ts";
import { git, sha } from "./lean-verify-fixture.ts";

export { originHead } from "./lean-publish-asserts.ts";
export type { FakeForge } from "./lean-publish-forge.ts";

/**
 * Temp dirs the publish fixtures made, including the scratch clones the origin
 * builders create. Shared array so every test's cleanup sweep removes them all.
 */
export const ROOTS: string[] = ORIGIN_ROOTS;

/** The default contract: two test criteria, each with one frozen file. */
export function defaultSpec(): PiSpec {
  return {
    problem: "the retry helper backs off on a transient failure",
    size: "S",
    criteria: [
      { id: "AC1", text: "a transient failure is retried", verify: "test" },
      { id: "AC2", text: "the backoff is bounded", verify: "test" },
    ],
  };
}

export interface PublishOpts extends PublishSeams, PublishRemoteSeeds {
  issue: number;
  /** The contract the issue body carries. */
  spec?: PiSpec;
  /** Override the issue body wholesale (an unusable spec, an injected heading). */
  body?: string;
  /** Make the worktree dirty before the step looks. */
  dirty?: boolean;
  /** Commit inside the worktree after the green verify was recorded. */
  commitAfterVerify?: boolean;
  /** Counters the run carries (a `draft` flag from the gate). */
  draft?: boolean;

  /** The fake forge's open PRs; `undefined` means "load none". */
  openPrs?: NormalizedPullRequest[];
  /** The verify step to log; omit for a run that never reached a verdict. */
  verify?: { kind: "green" | "red"; head?: string; reason?: string } | undefined;
  /**
   * The `preexistingFailures` the green verify recorded — the #2042 disclosure, so a
   * case can ask what a green whose tier was excused over the base commit still buys.
   */
  preexistingFailures?: Record<string, PreexistingTierRecord>;
  /**
   * The `commandCriteria` the green verify recorded (criterion id -> `passed`).
   * The seam for a body that must print `passed (command)` from the record the
   * step actually writes, rather than from a verdict it never made.
   */
  commandCriteria?: Record<string, string>;
  /** Extra steps appended to the log. */
  extraSteps?: Step[];
  /**
   * Check out a worktree whose branch differs from the run's (a state file that
   *  names the mainline while the tree sits on its own lean ref).
   */
  worktreeBranch?: string;
  /** Seams a case replaces: the approved spec and its check child. */
  depsOver?: Partial<PublishDeps>;
}

export interface PublishRun {
  outcome?: Outcome;
  threw?: Error;
  repoRoot: string;
  wt: string;
  head: string;
  origin: string;
  forge: FakeForge;
  body: string;
  /** The env each git child received, in call order. */
  gitEnvs: NodeJS.ProcessEnv[];
  /** The `--force-with-lease=` argument the step rendered on its push. */
  leaseArg?: string;
  /** The sha origin's run branch held after a stale seed, before the step ran. */
  seededSha?: string;
  /** The head the run's PRIOR publish recorded and origin still holds (republish cases). */
  priorHead?: string;
  /** The worktree's branch name — a republish case needs it to name the ref it asserts on. */
  branch?: string;
}

/** Build the repo, the worktree and the ctx, then run the step. */
export async function runPublish(o: PublishOpts): Promise<PublishRun> {
  const issue = o.issue;
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-publish-"));
  ROOTS.push(repoRoot);
  const origin = mkdtempSync(path.join(tmpdir(), "lean-publish-origin-"));
  ROOTS.push(origin);
  git(origin, "init", "-q", "--bare");
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "remote", "add", "origin", origin);
  if (o.sshCommand !== undefined) git(repoRoot, "config", "core.sshCommand", o.sshCommand);

  writeFileSync(path.join(repoRoot, "src.ts"), "export const x = 1;\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  const baseSha = git(repoRoot, "rev-parse", "HEAD");
  // Origin's mainline keeps the BASE commit: the fixture must not push a main
  // this repo never had, and `assertPublishableBranch` refuses that name anyway.
  git(repoRoot, "push", "-q", "origin", "main");
  // The clone's own mainline ref, which the publishable-branch guard reads before it
  // asks origin anything (`writeCloneMainlineRef` says why a rig has to write it).
  writeCloneMainlineRef(repoRoot, git);

  const branch = o.branch ?? `lean/issue-${issue}`;
  const checkout = o.worktreeBranch ?? branch;
  const wt = specifyWorktreePath(repoRoot, issue);

  const baseMain = git(repoRoot, "rev-parse", "HEAD");
  commitFile(repoRoot, "docs.ts", "export const docs = 1;\n", "docs: the mainline moved on");

  git(repoRoot, "worktree", "add", "-q", "-B", checkout, wt, baseMain);

  // The implementation + frozen tests, committed in the worktree: this is the
  // head the green verify is a claim about, and the head publish pushes. The
  // rerun's head is THREE commits on the newer main (frozen tests, then two
  // implementation commits), so a stale branch several commits deep is
  // genuinely non-fast-forward rather than a one-commit amend.
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), TEST, { mode: 0o755 });
  writeFileSync(path.join(wt, "tests/AC2-bound.test.sh"), TEST, { mode: 0o755 });
  commitFile(wt, "src.ts", "export const retry = () => 1;\n", "feat: implement the retry helper");
  commitFile(wt, "backoff.ts", "export const cap = 3;\n", "feat: bound the backoff");

  // The republish shape: the run's PRIOR publish pushed one commit of this history and
  // origin has held it ever since, so the CI-fix commit on top is the head about to go
  // out. `priorHead` is a real ancestor of `head`, not an invented sha — which is what
  // lets the case ask whether the step's ancestry read is doing any work.
  if (o.commitAfterVerify === true) {
    writeFileSync(path.join(wt, "later.ts"), "export const later = 1;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "feat: a commit nobody verified");
  }

  // The republish shape: the run's PRIOR publish pushed what the tree held up to here,
  // and the CI-fix commit below is the newer thing `publish` is now being asked to put
  // on top of it. `priorPublish.head` must be the sha this records — a case whose
  // record named some other sha would be testing a fixture, not the step.
  // The sha the run's PRIOR publish recorded, computed HERE rather than supplied: a
  // case cannot make the step's record disagree with the tree the record claims, which
  // is the way a republish fixture would otherwise pass by construction. The case names
  // the PR URL it expects on origin's row; the sha is this fixture's fact, not the
  // case's invention.
  const priorHead = o.priorPublish === undefined ? undefined : git(wt, "rev-parse", "HEAD");
  if (o.priorPublish !== undefined && o.graftForeignHead === true) {
    // The head publish is about to push must NOT descend from what the run published.
    // It is built in a scratch repo with no shared history and grafted onto the run
    // branch, so origin still holds the run's own recorded sha while HEAD sits on
    // someone else's line — git's definitive "not a fast-forward" for the ancestry read.
    const scratch = mkdtempSync(path.join(tmpdir(), "lean-publish-foreign-"));
    ROOTS.push(scratch);
    git(scratch, "init", "-q", "-b", "foreign");
    git(scratch, "remote", "add", "origin", origin);
    writeFileSync(path.join(scratch, "ci-fix.ts"), "export const ciFix = 1;\n");
    git(scratch, "add", "-A");
    git(scratch, "commit", "-q", "-m", "fix: the ci fix, on history this run never made");
    const foreign = git(scratch, "rev-parse", "HEAD");
    // The objects have to be IN this clone before its branch can name them.
    git(wt, "fetch", "-q", scratch, "refs/heads/foreign:refs/heads/lean-foreign-head");
    git(wt, "update-ref", `refs/heads/${checkout}`, foreign, git(wt, "rev-parse", "HEAD"));
    git(wt, "reset", "-q", "--hard", foreign);
  } else if (o.priorPublish !== undefined)
    commitFile(wt, "ci-fix.ts", "export const ciFix = 1;\n", "fix: what the red ci named");
  const head = git(wt, "rev-parse", "HEAD");

  if (o.originStale === "fast-forward") seedFastForwardOrigin({ wt, branch });
  if (o.originStale === "own-publish") {
    if (o.priorPublish === undefined)
      throw new Error(
        'originStale "own-publish" needs priorPublish: origin must sit at the sha the run recorded',
      );
    if (priorHead === undefined) throw new Error("own-publish needs priorPublish");
    seedOwnPublishOrigin({ wt, branch, priorHead });
  }
  if (o.originStale === true || o.originStale === "descendants-reach")
    seedStaleOrigin({
      origin,
      branch,
      baseMain,
      wt,
      issue,
      containsHead: o.originStale === "descendants-reach",
    });
  else if (o.originStale === "stale-branch") seedOneCommitStaleOrigin({ wt, branch });
  // What origin holds once the stale shape is planted: the sha the lease must bind
  // to. Read back from origin rather than returned by the seeders, because origin
  // is the only thing the step's `ls-remote` will see.
  const seeded =
    o.originStale === undefined && o.priorPublish === undefined
      ? undefined
      : originHead(origin, branch);
  // The shape must have actually landed, or a case about a branch at the run's own
  // last-pushed sha would be measuring a branch that is simply absent.
  const seededSha = o.priorPublish !== undefined ? priorHead : seeded;
  if (o.originForeign === true) seedForeignOrigin({ origin, branch });
  // `originForeign` is a SECOND shape on top of the one `originStale`/`priorPublish`
  // planted: it force-moves the ref to a commit from an unrelated repo, which is how a
  // case asks "origin holds something other than the sha the run recorded". The forced
  // form is required — the foreign tip shares no history with what is already there.
  if (o.originAtHead === true) git(wt, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  // Setup pushes THIS run's head onto the run's branch only for a first run, the
  // shape where the step's honest answer is `already on origin` and no write is
  // due. Everything else brings its own shape for the ref and must be left alone:
  // `originStale`/`originForeign` seed a DIFFERENT commit there (and a case that
  // must watch a lease refuse, or read a porcelain back, depends on that commit
  // still being there when the step looks — pushing the head here silently
  // un-seeds it and the step then takes the no-op path it was meant to rule out),
  // and `originAtHead` above already put the head there. `noPush` is how a case
  // that must see the branch ABSENT says so: a refusal that has to land before any
  // write, a stubbed push report, a lease that has to fail against a new branch.
  const setupPushesHead =
    o.noPush !== true &&
    o.originStale === undefined &&
    o.priorPublish === undefined &&
    o.originForeign !== true &&
    o.originAtHead !== true;
  if (setupPushesHead) git(wt, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);

  const steps = [
    ...logFor(issue, o, head),
    ...(o.priorPublish === undefined
      ? []
      : priorPublishStep(issue, o.priorPublish, priorHead ?? "")),
  ];
  if (o.overwritePublishOutcome !== undefined) {
    const idx = steps.map((st) => st.state).lastIndexOf("publish");
    if (idx < 0) throw new Error("overwritePublishOutcome needs a priorPublish record to rewrite");
    const entry = steps[idx];
    if (entry === undefined) throw new Error("overwritePublishOutcome: no publish step");
    steps[idx] = { ...entry, outcome: o.overwritePublishOutcome as unknown as Outcome };
  }
  const run: LeanRun = {
    ...createRun({
      issue,
      version: "0.14.40",
      models: { developer: "model-a", adversary: "model-b" },
      baseSha,
      branch,
    }),
    steps,
    counters: {
      buildAttempts: 1,
      challengeDone: true,
      reviewDone: false,
      ciFixUsed: false,
      draft: o.draft === true,
    },
  };
  const ctx: HandlerCtx = {
    repoRoot,
    issue,
    run,
    steps,
    stepKey: `${issue}:publish:0`,
    now: () => 9,
  };

  const seededRows = (o.openPrs ?? []).map((pr) =>
    o.stateOver === undefined
      ? pr
      : prWithState(pr.number, pr.url, pr.headRefName ?? "", o.stateOver),
  );
  const forge = fakeForge({
    prs: seededRows,
    listThrows: o.listThrows === true,
    viewThrows: o.viewThrows === true,
    ...(o.viewIsDraft === undefined
      ? {}
      : {
          viewIsDraft: new Map(
            Object.entries(o.viewIsDraft).map(([k, v]) => [Number(k), v] as const),
          ),
        }),
    draftThrows: o.draftThrows === true,
    viewThrowsFor: o.viewThrowsFor,
    ...(o.afterDraft === undefined
      ? {}
      : {
          afterDraft: new Map(
            Object.entries(o.afterDraft).map(([k, v]) => [Number(k), v] as const),
          ),
        }),
    ...(o.afterCreate === undefined
      ? {}
      : {
          afterCreate: new Map(
            Object.entries(o.afterCreate).map(([k, v]) => [Number(k), v] as const),
          ),
        }),
  });
  // The race lands between the step's origin read and its lease-bound push: the
  // read happens before the forge is asked, so a ref moved inside `prList` is a
  // ref the lease was not bound to. A separate clone makes origin's ref move.
  const listed = forge.prList;
  forge.prList = async (q) => {
    const rows = await listed(q);
    if (o.moveRemoteDuringPush === true) {
      const other = mkdtempSync(path.join(tmpdir(), "lean-publish-race-"));
      ROOTS.push(other);
      git(other, "init", "-q", "-b", "main");
      git(other, "remote", "add", "origin", origin);
      git(other, "fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
      // Rewind the branch to origin's main behind the step's back: the sha it
      // read is then no longer origin's, and the lease must refuse.
      await deps.exec("git", {
        argv: [
          ...NO_HOOKS,
          "push",
          "-q",
          "--force",
          "origin",
          `refs/remotes/origin/main:refs/heads/${branch}`,
        ],
        cwd: other,
        timeout: 60_000,
      });
    }
    return rows;
  };
  if (o.forgeOver !== undefined) Object.assign(forge, o.forgeOver);
  const spec = o.spec ?? defaultSpec();
  /** The env every git child ran with, so a case can assert on the push's. */
  const seenEnvs: NodeJS.ProcessEnv[] = [];
  const seen: { leaseArg?: string } = {};
  const base: PublishDeps = {
    // The recorder's own executor is installed below, once this object exists for it to
    // forward to; without one the step gets the executor written here.
    //
    // The production seam's env decision is applied HERE rather than inside
    // `publishDeps()` — the fixture injects its own executor, so a push env the
    // fixture never forwarded would be a guarantee no test can observe. Same
    // env (the driver's `netGitEnv`), same condition (`cmd === "git"` and no
    // env supplied by the caller) — INCLUDING the cwd argument, which is what
    // lets the repo's `core.sshCommand` take part in the precedence. Omitting it
    // here would make the fixture observe a different env than production builds.
    exec: (async (cmd, opts) => {
      // The lease is recorded before any override, so a case that substitutes the
      // push still observes the argument the step rendered.
      if (cmd === "git" && opts?.argv?.includes("push") === true)
        seen.leaseArg = opts?.argv?.find((a) => a.startsWith("--force-with-lease="));
      const override = o.execOver?.(cmd, opts);
      if (override !== undefined) return override;
      // Let a case substitute the report: origin still decides, so a printed
      // rejection over a ref that did move is observable rather than taken on trust.
      if (cmd === "git" && opts?.argv?.includes("push") === true && o.pushPorcelain !== undefined)
        return { stdout: o.pushPorcelain, stderr: "" };
      const cwd = opts?.cwd ?? wt;
      // The production seam's rule, restated: `git` with no caller-supplied env gets
      // the driver's net env. The guard's origin probe reaches it in the SHELL form
      // through `runNetGit`, which supplies that env itself, so the `opts?.env ??`
      // ahead of this is what the probe actually runs with — and the probe's own env
      // belongs to the seam, not to the probe.
      const env =
        opts?.env ??
        (cmd === "git" || cmd.startsWith("git ") ? netGitEnv(gitTestEnv(), cwd) : gitTestEnv());
      seenEnvs.push(env);
      return execp(cmd, { ...opts, env, cwd });
    }) as PublishDeps["exec"],
    fetchBody: async () => o.body ?? renderPiSpec(spec),
    forge: async () => (o.execRecorder === undefined ? forge : o.execRecorder.forge(seededRows)),
    issueSpec: async () => undefined,
    specBlock: async () => {
      throw new Error("the fixture has no spec block");
    },
    ...o.depsOver,
  };
  // The recorder is installed with the object above, so it sees each call exactly as
  // the step made it and forwards to the executor written here: a spy, not a stub —
  // origin still decides every ref the cases assert on.
  // The recorder is installed once the base executor exists, so it can forward to it
  // and still see each call exactly as the step made it. `as unknown as`: the recorder is
  // one function and `VerifyExec` is declared as an intersection of two overloads whose
  // answer types differ in optionality only — the cast carries no behaviour, and the
  // wrapper returns an answer for every call it forwards.
  const deps: PublishDeps =
    o.execRecorder === undefined
      ? base
      : {
          ...base,
          exec: o.execRecorder.wrapExec(base) as unknown as PublishDeps["exec"],
        };
  const { publishOutcome } = await import("../../src/lean/publish.ts");
  // Read at spread time, not built now: `shared` is constructed BEFORE the step
  // runs, so a field captured here would always be undefined.
  const shared = { repoRoot, wt, head, origin, forge, branch, gitEnvs: seenEnvs };
  const observed = () => ({
    leaseArg: seen.leaseArg,
    seededSha,
    ...(o.priorPublish === undefined ? {} : { priorHead }),
  });
  try {
    return {
      outcome: await publishOutcome(ctx, deps),
      ...shared,
      ...observed(),
      body: forge.prCreateCalls[0]?.body ?? "",
    };
  } catch (err) {
    return {
      threw: err as Error,
      ...shared,
      ...observed(),
      body: forge.prCreateCalls[0]?.body ?? "",
    };
  }
}
