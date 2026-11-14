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
 *
 * A red PROJECT TIER is not taken at its first word: `verify-baseline.ts` re-runs
 * it once at HEAD, and a tier that goes green there counts green with the flake
 * named in the reason. A tier red twice is probed at the run's `baseSha` in a
 * throwaway checkout, and a tier red THERE hands the run back before any build
 * round is billed — a gate that was red before the change existed is not something
 * the change's developer is sent to fix. The probe compares the frozen tests' BYTES
 * against the base commit's — it never runs them there, because the base predates them.
 * Only a base the probe actually SAW red earns the hand-back: a probe that could not
 * tell (`unknown`) is not a colour, so the tier's own red stands and the build-retry
 * path runs exactly as it would with no probe at all.
 * The frozen tests and the `command`
 * criteria keep their first-word verdicts: a frozen test is proven red-and-named at
 * freeze time on purpose, so exempting it would delete the run's only contract check.
 */

import { existsSync } from "node:fs";
import { trace } from "../trace.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { porcelain } from "./build-git.ts";
import { frozenFromLog, testsFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { PreexistingTierRecord } from "./state-outcome-maps.ts";
import type { Outcome, Step } from "./state.ts";
import { baselineRedArm } from "./verify-baseline-arm.ts";
import { preexistingReason } from "./verify-baseline-excuse.ts";
import { baselineUnusableError, flakeReason, probeTierAtBase } from "./verify-baseline.ts";
import { confirmTierRedFrom } from "./verify-baseline.ts";
import { type CommandCriteriaOutcome, commandCriteriaOutcome } from "./verify-commands.ts";
import { type VerifyDeps, clipReason, verifyDeps } from "./verify-deps.ts";
import { defectiveFrozenContract } from "./verify-frozen-defect.ts";
import { frozenTamperReason } from "./verify-frozen.ts";
import {
  commandsFailedAsExecuted,
  specCriteriaFor,
  toVerifyCmdInfra,
  verifyCmdAtHead,
} from "./verify-reads.ts";
import { recheckAfterRuns } from "./verify-recheck.ts";
import { redAttribution } from "./verify-red-attribution.ts";
import { type FrozenClause, composedTierRed, frozenClause } from "./verify-red-reason.ts";
import {
  type Executed,
  TIER_TIMEOUT_MS,
  canaryFailure,
  frozenTestFailure,
  runTier,
  tiersOf,
} from "./verify-steps.ts";
import { tierRunStream } from "./verify-tier-rerun.ts";
import { VerifyInfraError, type VerifyTiers } from "./verify-types.ts";

/** The first failure among the executed checks; an unobservable one THROWS. */
function firstFailure(...ran: Executed[]): string | undefined {
  for (const one of ran) {
    if (one.kind === "infra") throw new VerifyInfraError(one.reason);
    if (one.kind === "fail") return one.reason;
  }
  return undefined;
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

  // 4. The frozen tests, every one of them. The base probe below does NOT run them: it
  // compares their frozen BYTES against the base commit, because the base predates tests
  // this run authored. A tier is only ever excused over a contract the base itself
  // carries, and never over one this run invented.
  const tests = await frozenTestFailure(frozen, config.verify.test, wt, deps.exec, deps.timeoutMs);

  // 5. The project's own tiers, fast before full — the first red tier ends the loop,
  // and its clause is reported BESIDE a red frozen contract rather than behind it,
  // with one
  // re-run and one base probe behind a red, so a tier that was never green in this
  // run's history cannot bill a build round. These run BEFORE the command criteria
  // on purpose: a preservation criterion states that behaviour held before this run
  // and holds after it, and the "after" the gate certifies is the tree the project
  // tiers produced, not the one they started on.
  // `flake` remembers an excused tier so the green it produced says so in its reason.
  const timeoutMs = deps.timeoutMs ?? TIER_TIMEOUT_MS;
  let flake: string | undefined;
  /** A tier excused over a base that already failed the very tests it names. */
  const preexisting: Record<string, PreexistingTierRecord> = {};
  const tierResults: Executed[] = [];
  /** The contract as the pass that ran BEFORE the tiers judged it, for the reason. */
  const frozenClauseForReason: FrozenClause = frozenClause(tests);
  /** Why the tier loop ended on a red the caller still owes the freeze check for. */
  let armRed: string | undefined;
  /**
   * The tier the arm settled, carried out beside its reason.
   *
   * The arm's tier is the one red result this step WITHHOLDS from `tierResults` (so the
   * frozen contract's clause cannot overwrite its reason), which means the attribution
   * below cannot find it among the executed checks.
   */
  let armTier: string | undefined;
  for (const [name, cmd] of tiers) {
    const one = await runTier(name, cmd, wt, deps.exec, deps.timeoutMs);
    if (one.kind === "pass") {
      tierResults.push(one);
      continue;
    }
    if (one.kind === "infra") {
      tierResults.push(one);
      break;
    }
    // One re-run at HEAD. A tier that goes green there saw nothing stable the first
    // time, so it is a flake and the gate does not bill a build round for it.
    // The re-run's OWN stream is kept, because the arm below decides whether this
    // tier's failures are pre-existing by reading what that run printed.
    const rerun = await tierRunStream(deps.exec, cmd, wt, timeoutMs);
    if (!confirmTierRedFrom(rerun.ran)) {
      flake = flakeReason(name, cmd);
      trace(`lean/verify: ${flake}`);
      continue;
    }
    // Red at HEAD twice: was it red BEFORE this run? A tier the base commit already
    // fails cannot be fixed by this run's builder, so the run stops here rather than
    // billing a round that would edit code the spec never named. Only a base the probe
    // OBSERVED red earns that hand-back: `unknown` (a base run that was killed, timed
    // out, overflowed or never started, or a base the contract cannot judge) is not a
    // colour, so the tier's own red below is what stands and the build round is billed.
    const probe = await probeTierAtBase({
      repoRoot,
      baseSha: ctx.run.baseSha,
      issue,
      cmd,
      timeoutMs,
      exec: deps.exec,
      frozen,
    });
    if (probe.status === "unusable") throw baselineUnusableError(probe.reason);
    if (probe.status === "red") {
      // The base is red. The narrower question the arm asks next — are the tier's
      // failures the mainline's OWN, line for line — lives in `verify-baseline-excuse.ts`
      // with the rule it applies; what stays here is the ordering this step owns.
      const arm = await baselineRedArm({
        frozen,
        frozenClause: frozenClauseForReason,
        tests,
        name,
        cmd,
        rerun,
        probe,
        verifyTest: config.verify.test,
        wt,
        repoRoot,
        baseSha: ctx.run.baseSha,
        exec: deps.exec,
        timeoutMs,
        issue,
      });
      if (arm.throwReason !== undefined) throw new VerifyInfraError(arm.throwReason);
      if (arm.red !== undefined) {
        // The hand-back the arm decided is a RED the caller still owes the freeze
        // check for, so it is carried out of the loop rather than returned here: a
        // tier the base already fails can fail on a frozen file this run authored,
        // and the attribution below is what tells those two reds apart.
        armRed = arm.red;
        armTier = name;
        break;
      }
      if (arm.preexisting !== undefined) {
        preexisting[name] = arm.preexisting;
        continue;
      }
      tierResults.push(one);
      break;
    }
    tierResults.push(one);
    // A tier the base did not excuse is a defect the builder can fix, and so is a red
    // contract: both are reported, because a reason that names one buys a round that
    // finds the other. `firstFailure` below still picks this same `one` when there is
    // nothing to compose, so a green contract keeps today's reason byte for byte.
    const composed = composedTierRed(frozenClauseForReason, one.reason);
    if (composed !== undefined) {
      armRed = composed;
      armTier = name;
    }
    break;
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
  // A red PROJECT TIER plus a freeze check that fails ON A FROZEN FILE is not a
  // verdict the builder can act on: the frozen contract is defective, and `build`
  // may not edit a frozen file, so no round this run has left can make the gate
  // green. Attribute it before any red is returned — but only on the evidence
  // that the check was green at HEAD without those files in place, which is what
  // distinguishes a contract this run authored from a gate the mainline already
  // fails. Any other outcome leaves the run exactly as it was: the check never
  // runs on the happy path, and a check that could not run never blocks.
  //
  // A tier the BASELINE ARM settled is a red tier too. It is deliberately absent
  // from `tierResults` — that is what keeps its own reason from being overwritten
  // below by the frozen contract's clause — so reading the tiers alone would let a
  // run whose frozen file the project's gate refuses bill a build round that can
  // never win it, for a tier whose reason already says nobody can fix it.
  const tierRed = armRed !== undefined || tierResults.some((t) => t.kind === "fail");
  if (failed !== undefined && config.verify.freezeCheck !== undefined && tierRed) {
    const defect = await defectiveFrozenContract(
      deps.exec,
      repoRoot,
      issue,
      wt,
      head,
      config.verify.freezeCheck,
      frozen,
    );
    if (defect !== undefined) throw new VerifyInfraError(defect);
  }
  // The arm's decision outranks the first failure: it is the reason this loop
  // stopped on, and the tier it settled is not in `tierResults` to be found again.
  const red = armRed ?? failed;
  if (red !== undefined) {
    const attribution = redAttribution({
      tests,
      tiers: tierResults,
      armTier,
      testsOfRun: testsFromLog(ctx.steps),
      // The `command` renderer's OWN composed string, not a captured stream: an id is
      // attributed from the line this step wrote, never from text the project printed.
      commandsReason: commands.failed,
    });
    return {
      kind: "red",
      reason: clipReason(red),
      ...(attribution === undefined ? {} : { red: attribution }),
    };
  }

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

  // Re-read every licence a SECOND time, after the command criteria. The pass above
  // certified the tree clean while the criteria had not run, so on its own it cannot
  // license a green over a preservation run that rewrote a frozen test, dirtied the
  // tree, committed, or took the worktree off its branch. This pass names the
  // criteria, because they are the only thing that has touched the tree since.
  const afterCommands = await recheckAfterRuns({
    exec: deps.exec,
    wt,
    head,
    branch,
    baseSha: ctx.run.baseSha,
    frozen,
    commands,
    who: "a command criterion",
    when: "the command criteria",
  });
  if (afterCommands.kind === "red")
    return { kind: "red", reason: clipReason(afterCommands.reason) };

  // A command the gate declined to run is not a verdict, but the reason is still
  // worth carrying on a green: the PR body prints it beside the blank cell, and a
  // red's reason line is already dominated by the failing check.
  const note =
    tiers.length === 0 ? " (no project verify command — the frozen tests alone decided)" : "";
  // An excused flake rides in the reason: `publish` prints the verify reason in the
  // PR body's Verification section, so a tier the gate let go on a re-run is
  // disclosed rather than reported as a clean gate nobody observed twice.
  // Rebuilt from the tier's own record rather than spread-cast: `commandCriteria`
  // is what licenses `passed (command)` in the PR body and what `publish` reads to
  // decide a draft, so each entry is written from the value this module computed,
  // not from an object handed back by a call whose result type was asserted.
  const executed = Object.entries(commands.executed);
  const notRunnable = Object.entries(commands.notRunnable);
  // A tier excused over the base commit rides in the reason the same way a flake
  // does, and in its own recorded field besides: the prose warns the reader, the
  // record is what `publish` renders the disclosure from and what `ci` re-reads
  // instead of probing the base a second time.
  const excuseNote =
    Object.keys(preexisting).length === 0
      ? ""
      : ` — ${preexistingReason(Object.keys(preexisting))}`;
  return {
    kind: "green",
    reason: `frozen tests and project tiers passed at ${head}${note}${flake === undefined ? "" : ` — ${flake}`}${excuseNote}`,
    verifiedHead: head,
    ...(Object.keys(preexisting).length === 0 ? {} : { preexistingFailures: preexisting }),
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
