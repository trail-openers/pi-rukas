/**
 * lean/build — the step that dispatches ONE developer to make the frozen
 * acceptance tests pass.
 *
 * Where `specify` is an adversary writing tests nobody has implemented, `build`
 * is a builder writing the implementation against tests that already exist and
 * are already committed. The step itself writes no code and runs no tests:
 * `verify` is a separate step and re-runs the frozen files itself, so a build
 * that claimed "green" would be a builder grading its own homework. What build
 * owns is the boundary around the child — the tree it hands the child, the
 * prompt it gets, and the single commit that comes out the other side.
 *
 * The whole handler is: read the record, prove the tree, dispatch, normalise,
 * commit. In order, because each stage exists so the next one cannot be fooled:
 *
 *   1. **The frozen map comes from the step log**, not from a closure: the
 *      union, in order, of the `frozen` maps of every decided `specify:ok` and
 *      `challenge:new-tests` step. A resumed run sees what a crashed run froze,
 *      and a challenge round's new tests join the contract rather than sitting
 *      beside it.
 *   2. **The worktree must be the run's own** — registered, on the run's
 *      branch, and sitting at the head the frozen records were hashed at.
 *      Checked against that head rather than the base, because `specify` put a
 *      commit on top of the base and that commit IS the contract now.
 *   3. **The preconditions run before the dispatch**, so a model is never paid
 *      to work in a tree the step cannot account for: the frozen map is
 *      non-empty and every frozen blob at that head still hashes to its record.
 *   4. **One child**, role `developer`, fenced to the worktree. A child that
 *      died is infrastructure and throws; it is not a verdict about the work.
 *   5. **Normalise and commit** (`build-normalise.ts`): CAPTURE the child's
 *      files, RESET the tree to `headBefore` — which undoes its commits, its
 *      staging, every frozen edit and every protected-path edit — then REWRITE
 *      the captured bytes and make one provable commit. The git probes live in
 *      `build-git.ts`, the single-descriptor read in `build-capture.ts`, and
 *      the child in `build-dispatch.ts`.
 *   6. A child that produced nothing is `exhausted`, which the table routes —
 *      not a throw, and not a green.
 *
 * The re-entry context is read from the log too: the newest decided `verify:red`
 * reason, else the newest `ci:red`, clipped to 4 KB. That is the difference
 * between a fix round that knows what failed and a second attempt that guesses.
 */

import { existsSync } from "node:fs";
import { execp } from "../exec.ts";
import { spawnSpecialist } from "../spawn.ts";
import { trace, traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { extractBlockedReport } from "./build-blocked-extract.ts";
import { BLOCKED_MAX_ENTRIES, blockedProved, usableConflicts } from "./build-blocked.ts";
import { dispatchBuilder } from "./build-dispatch.ts";
import { BuildInfraError } from "./build-errors.ts";
import { headSha } from "./build-git.ts";
import { assertFrozenIntact, normaliseBuild } from "./build-normalise.ts";
import type { BuildDispatch, BuildExec } from "./build-types.ts";
import { leanChildOpts } from "./child-opts.ts";
import type { WorkConfig } from "./config.ts";
import { loadWorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { type PiSpec, parsePiSpec } from "./spec.ts";
import { CaptureBudget } from "./specify-capture.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { Outcome, Step } from "./state.ts";
import {
  type BudgetArms,
  type BudgetOpts,
  type BudgetStop,
  armBudget,
  budgetFor,
  budgetVerdictWithRows,
  readDispatched,
} from "./step-budget.ts";

/** The re-entry reason the child is given, clipped so a log dump cannot bloat a prompt. */
const REENTRY_CLIP = 4096;

/** How of the adversary's files a re-entry line names. Beyond it, the count. */
const CHALLENGE_LIST_CLIP = 20;

export interface BuildDeps {
  exec: BuildExec;
  dispatch: BuildDispatch;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /** The aggregate capture ceiling in bytes; absent, the production ceiling applies. */
  captureCeiling?: number;
  /**
   * The bound on each of the driver's re-runs of a reported frozen test. A test
   * shortens it to observe a hang; absent, `runTestFile`'s own ceiling applies.
   */
  blockedTimeoutMs?: number;
  /** See `blockedReport`'s `probe`: a test-only hook into the gate's moment. */
  blockedProbe?: (wt: string) => void;
}

/** The step log's frozen map: every `specify:ok` / `challenge:new-tests`, in order. */
export function frozenFromLog(steps: Step[]): Record<string, string> {
  const frozen: Record<string, string> = {};
  for (const step of steps) {
    if (step.outcome === undefined) continue;
    const decided =
      (step.state === "specify" && step.outcome.kind === "ok") ||
      (step.state === "challenge" && step.outcome.kind === "new-tests");
    if (!decided) continue;
    for (const [rel, sha] of Object.entries(step.outcome.frozen ?? {})) frozen[rel] = sha;
  }
  return frozen;
}

/**
 * The criterion -> tests map, unioned over every step that recorded one.
 *
 * The run-level file quota seeds from here: `MAX_TEST_FILES_PER_CRITERION`
 * bounds what a criterion ENDS UP WITH across the run, and only this map knows
 * what an earlier round already froze for it. Same decided outcomes as
 * `frozenFromLog`, so the two readers of the run's test record cannot disagree.
 */
export function testsFromLog(steps: Step[]): Record<string, string[]> {
  const tests: Record<string, string[]> = {};
  for (const step of steps) {
    if (step.outcome === undefined) continue;
    const decided =
      (step.state === "specify" && step.outcome.kind === "ok") ||
      (step.state === "challenge" && step.outcome.kind === "new-tests");
    if (!decided) continue;
    for (const [id, files] of Object.entries(step.outcome.tests ?? {})) {
      const seen = new Set(tests[id] ?? []);
      for (const f of files) seen.add(f);
      tests[id] = [...seen];
    }
  }
  return tests;
}

/**
 * Why this round exists, in the gate's own words: the newest decided
 * `verify:red` reason, or the newest `ci:red` one, clipped.
 *
 * A build re-entered after a `challenge` round that ADDED tests gets the same
 * treatment from {@link addedByChallengeFromLog} rather than a reason: nobody
 * judged those files, the adversary simply froze them, and a builder that is not
 * told which files are new treats them as the contract it already knew.
 */
export function reentryFromLog(steps: Step[]): string | undefined {
  for (const state of ["verify", "ci"] as const) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step?.state !== state || step.outcome?.kind !== "red") continue;
      const reason = step.outcome.reason ?? step.outcome.message;
      if (typeof reason !== "string" || reason.trim() === "") continue;
      return reason.length > REENTRY_CLIP ? `${reason.slice(0, REENTRY_CLIP)}…` : reason;
    }
  }
  return undefined;
}

/**
 * What the adversary added, in the builder's own brief: the frozen paths of the
 * newest decided `challenge:new-tests` step, or `undefined` when the log holds
 * none.
 *
 * `reentryFromLog` answers "what did the gate complain about", and an adversary
 * that froze a stricter test has complained about nothing yet — it just made the
 * contract bigger. The paths come from the same decided outcomes `frozenFromLog`
 * reads, so the two readers of the run's test record cannot disagree.
 */
export function addedByChallengeFromLog(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "challenge" || step.outcome?.kind !== "new-tests") continue;
    const paths = Object.keys(step.outcome.frozen ?? {});
    if (paths.length === 0) continue;
    const kept = paths.slice(0, CHALLENGE_LIST_CLIP).map((p) => `- \`${p}\``);
    const more =
      paths.length > CHALLENGE_LIST_CLIP
        ? `\n- …and ${paths.length - CHALLENGE_LIST_CLIP} more`
        : "";
    const line = `the adversary's challenge round added these frozen tests:\n${kept.join("\n")}${more}`;
    return line.length > REENTRY_CLIP ? `${line.slice(0, REENTRY_CLIP)}…` : line;
  }
  return undefined;
}

/** The spec, re-read from the forge. A build against a spec nobody re-read is a build against a fiction. */
async function specOf(deps: BuildDeps, repoRoot: string, issue: number): Promise<PiSpec> {
  let body: string;
  try {
    body = await deps.fetchIssueBody(repoRoot, issue);
  } catch (err) {
    throw new BuildInfraError(`could not read the issue: ${(err as Error).message}`);
  }
  const parsed = parsePiSpec(body);
  if (!parsed.ok) throw new BuildInfraError(`the issue's spec is unusable: ${parsed.reason}`);
  return parsed.spec;
}

/**
 * The child's blocked report, judged. Returns the outcome's two fields when the
 * driver itself proved the claim, and `undefined` when it did not — in which
 * case the caller continues as though no call were made.
 *
 * Split from `buildOutcome` because the judgement has its own three steps (read,
 * vet the names, re-run them) and its own failure direction: everything here
 * says "not honoured", never "the contract is unsatisfiable".
 */
async function blockedReport(opts: {
  exec: BuildExec;
  wt: string;
  template: string | undefined;
  frozen: Record<string, string>;
  toolUses: unknown[];
  issue: number;
  timeoutMs?: number;
  /**
   * DIAGNOSTIC SEAM, set only by a test through `BuildDeps.blockedProbe`: runs
   * against the child's tree at the instant the blocked gate judges it, after
   * normalisation's reset. It exists so the anti-forgery gate's own refusal can
   * be OBSERVED failing on a deliberate mutant (AGENTS.md §6) rather than
   * asserted from a green test that could not have failed.
   */
  probe?: (wt: string) => void;
}): Promise<{ reason: string; blockedBy: Record<string, string> } | undefined> {
  const extracted = extractBlockedReport(opts.toolUses);
  if (extracted.rows.length === 0) {
    if (extracted.skipped > 0)
      trace(
        `lean build #${String(opts.issue)}: ignored ${String(extracted.skipped)} unreadable report_blocked call(s)`,
      );
    return undefined;
  }
  const paths = usableConflicts(extracted.rows);
  const proved = await blockedProved({
    exec: opts.exec,
    wt: opts.wt,
    template: opts.template,
    frozen: opts.frozen,
    paths,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.probe === undefined ? {} : { probe: opts.probe }),
  });
  if (!proved.honoured) {
    traceWarn(`lean build #${String(opts.issue)}: blocked report ignored — ${proved.why}`);
    return undefined;
  }
  // The map is rebuilt from the entries the gate vetted, and ONLY from those:
  // `blockedProved` refused every name absent from the frozen map, so a second
  // membership test here would be a copy of a rule that just ran — and a copy is
  // how a widening lands on one side only.
  const vetted = new Set(paths);
  const blockedBy: Record<string, string> = {};
  for (const row of extracted.rows) {
    if (Object.keys(blockedBy).length >= BLOCKED_MAX_ENTRIES) break;
    if (!vetted.has(row.path)) continue;
    blockedBy[row.path] = row.reason;
  }
  if (Object.keys(blockedBy).length === 0) return undefined;
  const entries = Object.entries(blockedBy);
  // The cause line leads with the LAST entry the driver re-ran: that is the file
  // it watched come back red, so the sentence names the evidence it holds rather
  // than the first name the child typed. The full map rides on `blockedBy`.
  const last = entries[entries.length - 1];
  return {
    reason: `frozen tests cannot all pass together: ${last?.[0] ?? ""} — ${last?.[1] ?? ""}`,
    blockedBy,
  };
}

/** The `build` step. Returns `ok` | `exhausted` | `blocked`; THROWS on infrastructure. */
export async function buildOutcome(ctx: HandlerCtx, deps: BuildDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;

  // 1. The contract, read out of the run's own record.
  const frozen = frozenFromLog(ctx.steps);

  // 2. The tree, and the head it is supposed to be at.
  const wt = specifyWorktreePath(repoRoot, issue);
  if (!existsSync(wt)) throw new BuildInfraError(`the worktree ${wt} does not exist`);
  const branch = specifyBranch(ctx.run.branch, issue);
  const base = ctx.run.baseSha;
  try {
    assertSafeRef(branch);
    if (base.trim() !== "") assertSafeRef(base);
  } catch (err) {
    throw new BuildInfraError((err as Error).message);
  }
  const headBefore = await headSha(deps.exec, wt);
  try {
    // Ownership, checked against the head the frozen records were hashed at
    // rather than the base: `specify` committed the tests on top of the base,
    // and a tree sitting anywhere else is not this run's to write into.
    await assertSpecifyWorktreeOwned(deps.exec, {
      repoRoot,
      wt,
      baseSha: base,
      branch,
      headMustBe: headBefore,
    });
  } catch (err) {
    throw new BuildInfraError((err as Error).message);
  }

  // 3. The preconditions, BEFORE the child is paid.
  await assertFrozenIntact(deps.exec, wt, headBefore, frozen);

  // A config the step cannot read is infrastructure: the developer would build
  // without the runner the project named, and that is not a verdict on the work.
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new BuildInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const spec = await specOf(deps, repoRoot, issue);
  const attempt =
    ctx.steps.filter((s) => s.state === "build" && s.outcome !== undefined).length + 1;

  // 4. The builder, under the state's budget (#1883). A breach is a routed
  //    verdict; the child's work goes back with the tree, nothing is committed.
  //    A child that died THROWS, and a throw records no outcome — so the rows
  //    ride on the error and the engine puts them on the error outcome it writes
  //    (see `error-outcome.ts`, #1920 A). Nothing here catches them: the original
  //    error already carries them, and re-wrapping it could only drop them.
  const reentry = reentryFromLog(ctx.steps);
  const added = addedByChallengeFromLog(ctx.steps);
  const budget = armBudget(budgetFor(config, "build"));
  if (budget.warning !== undefined) traceWarn(`lean build #${String(issue)}: ${budget.warning}`);
  const [dispatched, row] = await dispatchBuilder(deps.dispatch, {
    issue,
    spec,
    frozen,
    wt,
    repoRoot,
    attempt,
    testRunner: config.verify.test,
    budget,
    ...(reentry === undefined ? {} : { reentry }),
    ...(added === undefined ? {} : { added }),
  });
  const rows = [row];
  const read = readDispatched(dispatched);
  if ("stop" in read) return budgetVerdictWithRows("build", read.stop, rows);

  // 4b. The child's own "these cannot all pass together", if it made one. The
  //     report is a CLAIM: it is honoured only once the driver has run the named
  //     frozen tests itself on the child's tree and seen one come back red. An
  //     ignored report traces one line and records nothing, and the step
  //     continues its ordinary path — there is no third verdict.
  const blocked = await blockedReport({
    exec: deps.exec,
    wt,
    template: config.verify.test,
    frozen,
    toolUses: read.result.toolUses ?? [],
    issue,
    ...(deps.blockedTimeoutMs === undefined ? {} : { timeoutMs: deps.blockedTimeoutMs }),
    ...(deps.blockedProbe === undefined ? {} : { probe: deps.blockedProbe }),
  });
  if (blocked !== undefined) {
    // No reset and no commit, exactly as the budget stop: the child's work goes
    // back with the tree, and `verify` is not asked to judge a tree this step
    // cannot account for.
    return {
      kind: "blocked",
      reason: blocked.reason,
      blockedBy: blocked.blockedBy,
      dispatches: rows,
    };
  }

  // 5 + 6. Capture, reset, rewrite, commit — or say there was nothing to commit.
  const report = await normaliseBuild({
    exec: deps.exec,
    wt,
    repoRoot,
    branch,
    headBefore,
    frozen,
    attempt,
    issue,
    budget: new CaptureBudget(deps.captureCeiling),
  });
  if (report.files.length === 0)
    return { kind: "exhausted", reason: "the developer produced no change", dispatches: rows };
  const notes = [
    `${report.files.length} file(s) changed`,
    report.restored.length > 0 ? `restored: ${report.restored.join(", ")}` : "",
    report.reverted.length > 0 ? `reverted: ${report.reverted.join(", ")}` : "",
    report.removed.length > 0
      ? `removed: ${report.removed.map((r) => `${r.path} (${r.why})`).join(", ")}`
      : "",
    report.deleted.length > 0 ? `deleted: ${report.deleted.join(", ")}` : "",
  ].filter((s) => s !== "");
  return { kind: "ok", reason: notes.join("; "), dispatches: rows };
}

/** The build step's dependencies: the outside world, injected. */
export function buildDeps(headless: boolean): BuildDeps {
  return {
    exec: (cmd: string, o?: Parameters<ExecFn>[1]) => execp(cmd, o ?? {}),
    dispatch: (
      spec: DispatchSpec,
      o: { writeFence?: WriteFence; extraArgs?: readonly string[] } & BudgetOpts,
    ) =>
      spawnSpecialist(spec, {
        writeFence: o.writeFence,
        extraArgs: o.extraArgs,
        // Forwarded so the ceiling binds the child.
        childBoundMs: o.childBoundMs,
        signal: o.signal,
        onProgress: o.onProgress,
        // The budget's kill goes through `killProcessTree`, which only reaches
        // the child's tool tree when the child leads its own group.
        processGroup: true,
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}
