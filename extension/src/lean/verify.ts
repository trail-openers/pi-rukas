/**
 * lean/verify — the run's own gate: does the frozen contract pass on the tree
 * as it now stands?
 *
 * `build` claims; `verify` checks. Nothing here asks a model what it thinks —
 * every claim the outcome makes is something this step observed: git said the
 * tree was clean, git said the frozen blobs still hash to their records, the
 * canary said the compiler still judges, and the runners exited with the codes
 * they exited with. That is what makes the `green` this step records worth
 * routing on: it is the only `verify` in the pipeline nobody can talk into it,
 * and `engine.ts`'s land gate reads it as the run's own verdict.
 *
 * The order is load-bearing, not stylistic:
 *
 *   1. **ownership and a clean tree** — a dirty tree means somebody wrote into
 *      the worktree without committing, so whatever the tiers then report is a
 *      verdict about bytes no commit holds;
 *   2. **frozen integrity** — a test that was edited is not the test that was
 *      frozen, and a run that reports green on an edited contract has verified
 *      nothing (checked at HEAD *and* on disk; `verify-frozen.ts`);
 *   3. **the toolchain canary** — before any tier is trusted as green, the
 *      pinned compiler is proven to still reject a known type error;
 *   4. **the frozen tests**, every one of them, with the project's runner;
 *   5. **the project tiers** — `verify.fast`, then `verify.full` when set,
 *      falling back to the repo's committed `.pi/verify-cmd`;
 *   6. **the spec's `command` criteria**, LAST among the runs: a preservation
 *      criterion asks whether the code the project tiers just exercised still
 *      holds an old contract, so it is judged on the tree the tiers left behind
 *      rather than the one they started from.
 *
 * Three answers, and the third is the one the engine cares about: `green` and
 * `red` are verdicts about the work, and the machine. A **throw** is
 * infrastructure — an unreadable tree, a killed tier, an un-startable runner —
 * which the engine turns into handed-back rather than a build round, because a
 * result nobody observed is not evidence that the code is wrong.
 *
 * A red reason is clipped to {@link RED_REASON_CLIP}: `build`'s re-entry reads
 * it back out of the step log and pastes it into the developer's prompt, and an
 * unbounded tail from a chatty build would eat the prompt whole.
 */

import { existsSync } from "node:fs";
import { execp } from "../exec.ts";
import { trace } from "../trace.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { porcelain } from "./build-git.ts";
import { frozenFromLog } from "./build.ts";
import { loadWorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { parsePiSpec } from "./spec.ts";
import type { Criterion } from "./spec.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { Outcome, Step } from "./state.ts";
import { type CommandCriteriaOutcome, commandCriteriaOutcome } from "./verify-commands.ts";
import { frozenTamperReason } from "./verify-frozen.ts";
import { recheckAfterRuns } from "./verify-recheck.ts";
import {
  type Executed,
  canaryFailure,
  frozenTestFailure,
  runTier,
  tiersOf,
} from "./verify-steps.ts";
import { type VerifyExec, VerifyInfraError, type VerifyTiers } from "./verify-types.ts";

/**
 * What `verify` reaches outside itself.
 *
 * `loadConfig` is a seam rather than a direct `loadWorkConfig` call for the
 * same reason `build` injects its own: the production form reads `.pi/work.json`
 * at the run's base sha, and a case that wants a tier to exit 1 must not have
 * to rewrite a commit the frozen records were hashed at to ask for one.
 */
export interface VerifyDeps {
  exec: VerifyExec;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<{ verify: VerifyTiers }>;
  /** The committed `.pi/verify-cmd` at HEAD; `undefined` when there is none. */
  readVerifyCmd?: (wt: string, head: string) => Promise<string | undefined>;
  /** Bounds every tier and frozen-test run; a test shortens it to observe a hang. */
  timeoutMs?: number;
  /**
   * The issue body the run's contract lives in. `verifyDeps()` supplies the
   * forge read (`io.ts`'s `fetchIssueBody`); a test injects the text its case
   * needs. An unreadable body is INFRASTRUCTURE, never a verdict: the gate
   * cannot tell which `command` criteria the spec asked for, and reporting a
   * green over criteria it never saw would be the gate claiming a check it did
   * not make. Returning no criteria is correct only when the body parsed and
   * simply holds none.
   */
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
}

/** The step log's newest red reason is pasted into a prompt; that bounds it. */
export const RED_REASON_CLIP = 4096;

/**
 * Is a failed `git show <ref>:<path>` git's own "this commit has no such file"?
 *
 * Two wordings are git's absence answers, and one of them is the reason a
 * path is not readable rather than absent (a file that exists in the tree but
 * never in the commit). Anything else — a timeout, an overflow, a corrupt
 * object — is a git that could not answer, which is never "the project
 * configured nothing".
 */
const ABSENT_IN_COMMIT = /does not exist|exists on disk, but not in/i;

/**
 * Why a failed read of `.pi/verify-cmd` means "there is none", or `undefined`
 * when the read failed for a reason that is not an answer.
 */
function absentVerifyCmd(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: string; message?: string };
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  // Exit 128 is git's "hard" refusal — for this command it only ever means the
  // path is not in the commit; a bad rev or a broken repo would have refused
  // every other git call in the step too. The wording is what decides.
  return e?.code === 128 && ABSENT_IN_COMMIT.test(text);
}

/** The committed `.pi/verify-cmd` at HEAD, or `undefined` when there is none. */
async function verifyCmdAtHead(
  exec: VerifyExec,
  wt: string,
  head: string,
): Promise<string | undefined> {
  // An ABSENT file is "the project configured nothing"; a read that failed for
  // any other reason is infrastructure and throws, because defaulting a git
  // that would not answer to "no tiers" turns a broken machine into a green.
  // The wrapped rejection also covers an injected `readVerifyCmd` that rejects:
  // the seam is a test's stand-in for this very read, so it earns the same
  // classification — a `VerifyInfraError` it raised itself passes through
  // untouched, anything else is re-thrown with the reader's own wording.
  const ran = await exec("git", {
    argv: [...NO_HOOKS, "show", `${head}:.pi/verify-cmd`],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => {
    if (absentVerifyCmd(err)) return undefined;
    throw toVerifyCmdInfra(err);
  });
  if (ran === undefined) return undefined;
  return (ran.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
}

/**
 * Wrap a failed `.pi/verify-cmd` read as infrastructure.
 *
 * One wording for both readers — the production `git show` above and an injected
 * `deps.readVerifyCmd` — so a test that makes its seam reject cannot observe a
 * different failure class from the one the real read produces. A rejection that
 * is already a `VerifyInfraError` is the reader's own verdict on its machine and
 * keeps its message; anything else is reported as a read that could not answer.
 */
function toVerifyCmdInfra(err: unknown): VerifyInfraError {
  if (err instanceof VerifyInfraError) return err;
  return new VerifyInfraError(
    `could not read .pi/verify-cmd: ${(err as Error)?.message ?? String(err)}`,
  );
}

/** The first failure among the executed checks; an unobservable one THROWS. */
function firstFailure(...ran: Executed[]): string | undefined {
  for (const one of ran) {
    if (one.kind === "infra") throw new VerifyInfraError(one.reason);
    if (one.kind === "fail") return one.reason;
  }
  return undefined;
}

/** Clip a red reason so `build`'s re-entry prompt stays a sane size. */
export function clipReason(reason: string): string {
  if (reason.length <= RED_REASON_CLIP) return reason;
  return `${reason.slice(0, RED_REASON_CLIP)}…`;
}

/**
 * The `verify` step. Returns `green` | `red`; THROWS on infrastructure.
 *
 * `deps.loadConfig` and `deps.readVerifyCmd` are seams: production reads both at
 * HEAD with `git show`, and a test decides what the project configured without
 * editing a commit.
 */
export async function verifyOutcome(ctx: HandlerCtx, deps: VerifyDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const wt = specifyWorktreePath(repoRoot, issue);
  if (!existsSync(wt)) throw new VerifyInfraError(`the worktree ${wt} does not exist`);

  // HEAD, and only HEAD: everything below is a claim about that commit.
  const headRan = await deps
    .exec("git", {
      argv: [...NO_HOOKS, "rev-parse", "HEAD"],
      cwd: wt,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    .catch((err: unknown) => {
      // A git that will not answer about its own HEAD is the machine, not a
      // verdict: swallowing the rejection here collapsed it into the same
      // message as "HEAD holds something that is not a sha" and lost the reason.
      throw new VerifyInfraError(
        `could not read HEAD in ${wt}: ${(err as Error)?.message ?? String(err)}`,
      );
    });
  const head = (headRan?.stdout ?? "").trim();
  // A sha is a sha: `assertSafeRef` below refuses a ref that could be an
  // argument, and `verifiedHead` is later matched against the PR head, so a
  // 7-hex abbreviation or a stray word must not be carried as the commit this
  // step judged.
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new VerifyInfraError(`could not read HEAD in ${wt} (got ${head.slice(0, 40)})`);

  // 1. The tree is ours; nothing in it is uncommitted.
  const branch = specifyBranch(ctx.run.branch, issue);
  try {
    assertSafeRef(branch);
    if (ctx.run.baseSha.trim() !== "") assertSafeRef(ctx.run.baseSha);
  } catch (err) {
    throw new VerifyInfraError((err as Error).message);
  }
  try {
    await assertSpecifyWorktreeOwned(deps.exec, {
      repoRoot,
      wt,
      baseSha: ctx.run.baseSha,
      branch,
      headMustBe: head,
    });
  } catch (err) {
    throw new VerifyInfraError((err as Error).message);
  }
  const dirty = await porcelain(deps.exec, wt).catch((err: unknown) => {
    throw new VerifyInfraError(`could not check the tree is clean: ${(err as Error).message}`);
  });

  // The contract, from the run's own record rather than a closure.
  const frozen = frozenFromLog(ctx.steps);
  if (Object.keys(frozen).length === 0)
    throw new VerifyInfraError("the step log records no frozen acceptance tests to verify");

  // 2. The frozen files are still the frozen files, at HEAD and on disk. This
  // runs BEFORE the clean-tree refusal, because the two dirties are different
  // faults with different owners: an edited acceptance test is the run's own
  // contract having been tampered with — a RED the developer is told about and
  // fixes — while any other uncommitted byte means the tree cannot be judged at
  // all and is infrastructure. Refusing on the porcelain first would report a
  // tampered contract as an infrastructure fault and hand the run back instead
  // of sending it through a build round.
  const tampered = await frozenTamperReason(deps.exec, wt, head, frozen);
  if (tampered !== undefined) return { kind: "red", reason: clipReason(tampered) };

  if (dirty !== "")
    throw new VerifyInfraError(
      `the worktree ${wt} is not clean — refusing to verify uncommitted bytes: ${dirty.slice(0, 500)}`,
    );

  // What the project configured. A config this step cannot read is not a
  // verdict on the work, so it throws rather than defaulting to "no tiers".
  const config = await deps.loadConfig(repoRoot, ctx.run.baseSha).catch((err: unknown) => {
    throw new VerifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const verifyCmd =
    deps.readVerifyCmd === undefined
      ? await verifyCmdAtHead(deps.exec, wt, head)
      : await deps.readVerifyCmd(wt, head).catch((err: unknown) => {
          throw toVerifyCmdInfra(err);
        });

  // 3. The compiler must still judge, before any tier may be trusted as green.
  const tiers = tiersOf(config.verify, verifyCmd);
  const unsound = await canaryFailure(
    tiers.map(([, cmd]) => cmd),
    wt,
    deps.exec,
  );
  if (unsound !== undefined) throw new VerifyInfraError(unsound);

  // 4. The frozen tests, every one of them.
  const tests = await frozenTestFailure(frozen, config.verify.test, wt, deps.exec, deps.timeoutMs);

  // 5. The project's own tiers, fast before full, first failure wins. These run
  // BEFORE the command criteria on purpose: a preservation criterion states that
  // behaviour held before this run and holds after it, and the "after" the gate
  // certifies is the tree the project tiers produced, not the one they started on.
  const tierResults: Executed[] = [];
  for (const [name, cmd] of tiers) {
    const one = await runTier(name, cmd, wt, deps.exec, deps.timeoutMs);
    tierResults.push(one);
    if (one.kind === "fail") break;
  }

  // 6. The spec's `command` criteria — preservation checks the frozen tests do
  // not make. A `command` criterion states behaviour that already held BEFORE
  // this run began, so the only file that can evidence it is one the run's base
  // commit already held, byte for byte: `commandCriteriaOutcome` reads the entry
  // at both `baseSha` and HEAD with `git ls-tree` (regular-file modes only, never
  // a symlink, never a submodule, never a tree, equal blob oids), hashes the
  // WORKING file against the base blob — an index trick like `--assume-unchanged`
  // keeps the porcelain quiet about a rewritten file — and then applies the frozen
  // tier's own on-disk `fileProblem` before anything is spawned. Each runnable one
  // is then executed through the same `verify.test` runner a frozen test uses, at
  // HEAD, in the run's own worktree, in argv form (never a shell), with the
  // driver's scrubbed env, inside a bounded budget.
  //
  // A spec the gate cannot read is infrastructure and THROWS: silently running no
  // criteria would let a broken forge read produce a ready PR over unchecked
  // criteria. Only a body that parsed and holds no `command` criterion is "none".
  const specCriteria = await specCriteriaFor(deps, repoRoot, issue);
  const commands = await commandCriteriaOutcome(
    specCriteria,
    config.verify.test,
    wt,
    ctx.run.baseSha,
    deps.exec,
    deps.timeoutMs,
    verifyChildEnv(),
  );

  const failed = firstFailure(tests, ...tierResults, commandsFailedAsExecuted(commands));
  if (failed !== undefined) return { kind: "red", reason: clipReason(failed) };
  // A command the gate declined to run is not a verdict, but the reason is still
  // worth carrying on a green: the PR body prints it beside the blank cell, and a
  // red's reason line is already dominated by the failing check.

  // The tiers run as shell commands IN the worktree, and the command tier runs
  // test CODE, so between the checks above and this point a tier may have rewritten
  // a frozen test, left bytes uncommitted, rewritten the file it was judged on,
  // committed and moved the head, or taken the tree off its branch. Every licence
  // that licensed this run is read again — and each failure there is the tier's
  // fault, never a verdict a developer is sent to "fix".
  const recheck = await recheckAfterRuns({
    exec: deps.exec,
    wt,
    head,
    branch,
    baseSha: ctx.run.baseSha,
    frozen,
    commands,
    who: "a verify tier",
  });
  if (recheck.kind === "red") return { kind: "red", reason: clipReason(recheck.reason) };

  const note =
    tiers.length === 0 ? " (no project verify command — the frozen tests alone decided)" : "";
  // Rebuilt from the tier's own record rather than spread-cast: `commandCriteria`
  // is what licenses `passed (command)` in the PR body and what `publish` reads to
  // decide a draft, so each entry is written from the value this module computed,
  // not from an object handed back by a call whose result type was asserted.
  const executed = Object.entries(commands.executed);
  const notRunnable = Object.entries(commands.notRunnable);
  return {
    kind: "green",
    reason: `frozen tests and project tiers passed at ${head}${note}`,
    verifiedHead: head,
    ...(executed.length === 0
      ? {}
      : {
          commandCriteria: Object.fromEntries(
            executed.map(([id]) => [id, COMMAND_CRITERION_PASSED]),
          ),
        }),
    ...(notRunnable.length === 0 ? {} : { commandNotRunnable: Object.fromEntries(notRunnable) }),
  };
}

/** The one word a recorded `command` criterion carries — `state-outcome` checks it. */
const COMMAND_CRITERION_PASSED = "passed";

/** `verify`'s dependencies in production form: the real executor and config read. */
export function verifyDeps(): VerifyDeps {
  return {
    exec: (cmd, opts) => execp(cmd, opts ?? {}),
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    fetchIssueBody,
  };
}

/**
 * The spec's criteria, for the `command` tier.
 *
 * A body the gate could not fetch, or one that carries a `pi-spec` block it
 * cannot parse, THROWS: the run does not know which `command` criteria were asked
 * for, and a gate that cannot say that must not report a verdict. What stays
 * non-fatal is the one case that is genuinely "the spec asked for nothing" — a
 * block that parsed and holds no `command` criterion — because a run whose spec
 * has no command criteria is an ordinary run, not a broken machine. A body with
 * NO `pi-spec` block at all is the same ordinary case: `publish` is the step that
 * refuses a contractless issue, and the verify gate has no business inventing a
 * failure the next step already reports in its own words.
 */
async function specCriteriaFor(
  deps: VerifyDeps,
  repoRoot: string,
  issue: number,
): Promise<Criterion[]> {
  const body = await deps.fetchIssueBody(repoRoot, issue).catch((err: unknown) => {
    throw new VerifyInfraError(
      `could not read the issue's spec for the command criteria: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  const parsed = parsePiSpec(body);
  if (!parsed.ok) {
    if (parsed.reason !== "no pi-spec v1 block")
      throw new VerifyInfraError(
        `the issue's spec could not be read for the command criteria: ${parsed.reason}`,
      );
    trace("lean/verify: no command criteria — the issue carries no pi-spec block");
    return [];
  }
  return parsed.spec.criteria;
}

/**
 * A failed `command` criterion as an `Executed` so it routes through the same
 * `firstFailure` as the frozen tests and the tiers: `fail` is a verdict, and an
 * infra result never reaches here because `commandCriteriaOutcome` throws it.
 */
function commandsFailedAsExecuted(outcome: CommandCriteriaOutcome): Executed {
  return outcome.failed === undefined ? { kind: "pass" } : { kind: "fail", reason: outcome.failed };
}

/** The newest decided `verify:red` reason on the log, clipped, for a report. */
export function newestRedVerifyReason(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "verify" || step.outcome?.kind !== "red") continue;
    const reason = step.outcome.reason ?? step.outcome.message;
    if (typeof reason !== "string" || reason.trim() === "") continue;
    return clipReason(reason);
  }
  return undefined;
}
