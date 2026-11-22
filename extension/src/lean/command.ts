/**
 * lean/command — `/work-lean <issue>`, the phase-1 entry point.
 *
 * Every state the machine routes has a real handler here, and a handler may return only
 * the kinds `machine.ts` lists for its state — `test-lean-machine.ts` fails on any pair
 * the table does not cover. A handler that invented a kind would end the run on the
 * misleading line `no transition for <state> + "…"`, which blames the machine for a bug
 * in the handler.
 *
 * `ready` does three deterministic things:
 *   1. fetch the issue body (the forge adapter, falling back to raw `gh`);
 *   2. `parsePiSpec`, then `readiness` on the result;
 *   3. resolve the mainline sha and load `.pi/work.json` AT that sha.
 * A failure at any of the three is a `fail` outcome, and the `decline` step
 * posts one issue comment naming the rules that failed before the run ends
 * `not-ready`. One comment per run, because the step log guarantees the step
 * that posted it never runs twice.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execp } from "../exec.ts";
import { spawnSpecialist } from "../spawn.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchSpec } from "../types.ts";
import { type CycleBudgetMs, flagBudgetMs } from "../work-driver-deadline.ts";
import { handoffChannel } from "../work-driver-handoff-channel.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { proveBaseSha, unresolvedMainlineRule } from "./base-proof.ts";
import { buildDeps, buildOutcome } from "./build.ts";
import { challengeDeps, challengeOutcome } from "./challenge.ts";
import { leanChildOpts } from "./child-opts.ts";
import { ciLandHandlers, publishHandler } from "./command-post-publish.ts";
import { type Budget, type WorkConfig, loadWorkConfig } from "./config.ts";
import { type LeanHandlers, type RunLeanResult, runLean } from "./engine.ts";
import { fetchIssueBody, mainlineSha, postDerivedSpec } from "./io.ts";
import { reportHandlers } from "./report-handlers.ts";
import { reviewDeps } from "./review-deps.ts";
import { reviewOutcome } from "./review.ts";
import { type LeanSeed, leanSeed } from "./seed.ts";
import { type DeriveDeps, type DeriveDispatch, deriveDeps, traceDerive } from "./spec-derive.ts";
import { specFor } from "./spec-for.ts";
import type { SpecIntake } from "./spec-intake-switch.ts";
import { contractOf } from "./spec-intake.ts";
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import { type SpecifyDeps, specifyOutcome } from "./specify.ts";
import { type DerivedSpec, derivedSpecProblem } from "./state-derived-spec.ts";
import type { Step } from "./state.ts";
import type { BudgetArms, BudgetOpts, DispatchUsageRow } from "./step-budget.ts";
import { oneLine } from "./text-fence.ts";
import { verifyDeps } from "./verify-deps.ts";
import { rosterStartProblem } from "./verify-roster-command.ts";
import { verifyOutcome } from "./verify.ts";
import { leanVersion } from "./version.ts";

// The version stamp lives in `lean/version.ts`, its own leaf: the seed needs it too, and
// importing it from here made the seed depend on this whole handler table. Re-exported because
// a caller that wants the stamp reaches for it where it reaches for the command.
export { leanVersion } from "./version.ts";

// Re-exported so the seed stays a leaf: consumers reach for the run's base here.
export { leanSeed } from "./seed.ts";

/** What `ready` learned: kept for the run's seed and for the not-ready comment. */
interface ReadyFacts {
  /** The cost rows of the child the intake paid for, on whichever verdict records them. */
  dispatches?: DispatchUsageRow[];
  spec?: PiSpec;
  baseSha?: string;
  failedRules: string[];
  /** A derivation FAILED: the issue was not at fault, the model call was, so the
   * handler routes to `handback` rather than `decline` and the run stays retryable.
   */
  infra?: boolean;
  /** The contract the run DERIVED for itself, when its issue carried no block and
   * intake mode is `derive`. Only `ready` mints one, and only through the accessor's
   * own gate — so a record carries a derived spec only because a `ready` validated it.
   */
  derived?: DerivedSpec;
}

/** What one run is started with besides its issue: its trust mode and its spec-intake override. */
export type LeanRunOpts = { headless?: boolean; specIntake?: SpecIntake };

/**
 * What `ready` needs from the outside world, all of it injectable.
 *
 * The step makes five outside calls. A case that wants to drive the posting rule,
 * the derived-record rule or the refusal wording has to answer them, and a case that
 * replaces the whole `ready` handler is judging its own stub instead of the step. So
 * the seam is these fields, all required on the interface, optional at the call site.
 */
export interface ReadyDeps {
  /** The issue body, as the forge answers it. */
  fetchBody: (repoRoot: string, issue: number) => Promise<string>;
  /** The issue's TITLE, read by the deriving child's brief. */
  issueTitle: (repoRoot: string, issue: number) => Promise<string>;
  /** The run's config at its base, for the mode and the child's budget. */
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /** One read-only drafting child, armed with its own budget. */
  dispatch: DeriveDispatch;
  /** The budget arms; `armBudget` in production, injectable so a case can force a stop. */
  arm?: (budget: Budget | undefined) => BudgetArms;
  /** Why the mainline probe failed, for a record whose seed carried no cause. */
  mainlineWhy: (repoRoot: string) => Promise<string | undefined>;
  /** Post the derived contract where an author will read it. */
  post: (repoRoot: string, issue: number, spec: PiSpec, model: string) => Promise<void>;
}

/** Production wiring: the real forge reads, the real config load, the real child. */
export function readyDeps(headless: boolean): ReadyDeps {
  const derive = deriveDeps(headless);
  return {
    fetchBody: fetchIssueBody,
    issueTitle: derive.issueTitle,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    dispatch: derive.dispatch,
    ...(derive.arm === undefined ? {} : { arm: derive.arm }),
    mainlineWhy: async (repoRoot) => (await mainlineSha(repoRoot)).why,
    post: postDerivedSpec,
  };
}

/**
 * The `ready` verdict: fetch, parse, judge readiness, load config at the base.
 *
 * `baseSha` is the run's own — the seed's answer, read back off the record (`ctx.run.baseSha`),
 * not a fresh probe — and `seedWhy` is what the seed reports when that answer is empty. The
 * base is pinned when the run starts so a config read, a diff and a verify all mean the same
 * commit.
 *
 * A non-empty base is PROVEN to be a commit before anything reads it — see
 * `lean/base-proof.ts`. The config loader cannot make that distinction: `gitType`/`gitShow`
 * catch every git failure and report "absent", which for a loader means "use the defaults" — so
 * a base that names no object at all would otherwise read as an ordinary repo with no
 * `.pi/work.json` and go green.
 *
 * Throws on a git INFRASTRUCTURE fault, and only there. A spec that is not ready, an empty base
 * and a base that names no commit all come back as `fail` with the rules named, because a run
 * that cannot start still has to say why on the issue — but a run whose git could not be asked
 * is not an unready issue, and posting "your base is not a commit" on an issue whose clone
 * merely had a locked index would tell the operator to fix something that is not broken.
 * The third kind, `infra`, is the intake's: a fault that is not the author's (a failed
 * derivation, a config that exists and cannot be read), which the machine routes to
 * `handback` rather than `decline`.
 */
export async function readyOutcome(
  repoRoot: string,
  issue: number,
  base: Pick<LeanSeed, "baseSha" | "why" | "infra"> & { specIntake?: SpecIntake },
  deps: ReadyDeps = readyDeps(false),
): Promise<{ kind: "ok" | "fail" | "infra"; facts: ReadyFacts }> {
  const d = deps;
  let body: string;
  try {
    body = await d.fetchBody(repoRoot, issue);
  } catch (err) {
    return {
      kind: "fail",
      facts: { failedRules: [`could not read the issue: ${(err as Error).message}`] },
    };
  }
  const derive: DeriveDeps = {
    issueTitle: d.issueTitle,
    loadConfig: d.loadConfig,
    dispatch: d.dispatch,
    ...(d.arm === undefined ? {} : { arm: d.arm }),
  };
  const contract = await contractOf(repoRoot, issue, body, base, derive);
  // The rows of every child the INTAKE paid for — the drafting child on a contract, and
  // on the `infra` rule the child whose derivation failed: a dead child still spent
  // tokens, and this step's record is the only place the run can still account for them.
  const rows = contract.dispatches ?? [];
  if ("rule" in contract)
    return {
      kind: contract.infra === true ? "infra" : "fail",
      facts: {
        failedRules: [contract.rule],
        ...(contract.infra === true ? { infra: true } : {}),
        ...(contract.dispatches === undefined || contract.dispatches.length === 0
          ? {}
          : { dispatches: contract.dispatches }),
      },
    };
  const parsed = { ok: true as const, spec: contract.spec };
  const failed = readiness(parsed.spec);
  if (failed.length > 0) return { kind: "fail", facts: { spec: parsed.spec, failedRules: failed } };
  // The base is the run's, resolved once by `leanSeed` and pinned on the run record: re-probing
  // here would let a `ready` that ran after origin/HEAD moved judge the run against a commit the
  // rest of it never saw.
  if (!base.baseSha) {
    // The refs probed and why each failed are the seed's — see `leanSeed`. When the seed never
    // carried a cause (a resumed run, or one that carried `""`), ask once. The probe is a git
    // read, so it is guarded: an unguarded throw here would turn a refusal-with-a-reason into a
    // handler error, and there is no git fact left to verify.
    let why = base.why;
    if (!why) {
      try {
        why = (await mainlineSha(repoRoot)).why;
      } catch (err) {
        why = oneLine(err instanceof Error ? err.message : String(err), 160);
      }
    }
    // A seed that FAILED rather than found nothing hands back, it does not refuse — see
    // `LeanSeed.infra`. Deliberately symmetric with the non-empty branch below, which lets
    // `proveBaseSha` throw for the same fault.
    if (base.infra === true) {
      // CLIPPED because `why` is git's text put into a thrown message an operator sees verbatim,
      // exactly as `unresolvedMainlineRule` clips the same string on the refusal path.
      throw new Error(
        `could not seed the run's base: ${oneLine(why ?? "no reason recorded", 160)}`,
      );
    }
    return {
      kind: "fail",
      facts: {
        spec: parsed.spec,
        // Never an empty tail: with no seed cause and no probe cause the rule still names the
        // refs the probe asked for (`NO_MAINLINE_WHY`).
        failedRules: [unresolvedMainlineRule(why)],
      },
    };
  }
  // Non-empty is not enough: prove the base IS the commit before the config read, whose blanket
  // catch would otherwise turn "no such object" into "no config file" and hand the run defaults
  // it never earned. The proof lives in `lean/base-proof.ts`; it throws on a git fault, which
  // this handler's caller turns into a handback.
  const proof = await proveBaseSha(repoRoot, base.baseSha);
  if (!proof.ok) {
    // The refused value is deliberately absent from the facts: it is untrusted text from a record
    // this process did not write, and it is already inside the rule where it is clipped.
    return { kind: "fail", facts: { spec: parsed.spec, failedRules: [proof.rule] } };
  }
  try {
    // A roster that can never get its report is refused HERE, before build spends a budget on it.
    const rosterProblem = rosterStartProblem((await d.loadConfig(repoRoot, base.baseSha)).verify);
    if (rosterProblem !== undefined) throw new Error(rosterProblem);
    return {
      kind: "ok",
      facts: {
        spec: parsed.spec,
        // Only the commit the config was read at goes on the record, so a run names
        // the base it was JUDGED by. The config itself stays off it: every step reads
        // it through the loader at this same commit, so a persisted copy would be a
        // second answer to one question — one a hand edit could change.
        baseSha: base.baseSha,
        failedRules: [],
        ...(contract.derived === undefined ? {} : { derived: contract.derived }),
        ...(rows.length === 0 ? {} : { dispatches: rows }),
      },
    };
  } catch (err) {
    return {
      kind: "fail",
      facts: {
        spec: parsed.spec,
        baseSha: base.baseSha,
        failedRules: [
          `.pi/work.json is unusable: ${oneLine(err instanceof Error ? err.message : String(err), 160)}`,
        ],
        // The child was paid for before this refusal, so its cost rides on the verdict.
        ...(rows.length === 0 ? {} : { dispatches: rows }),
      },
    };
  }
}

/**
 * The specify step's dependencies: the outside world, injected.
 *
 * `dispatch` is the only model call the step makes and `exec` the only thing that touches git,
 * so the smoke test drives a real temp repository through both without a child process.
 */
export function specifyDeps(headless: boolean): SpecifyDeps {
  return {
    exec: (cmd, opts) => execp(cmd, opts ?? {}),
    dispatch: (
      spec: DispatchSpec,
      o: { writeFence?: WriteFence; extraArgs?: readonly string[] } & BudgetOpts,
    ) =>
      spawnSpecialist(spec, {
        writeFence: o.writeFence,
        extraArgs: o.extraArgs,
        // Forwarded so the ceiling binds the child, `budgetTurns` included: it is the turns
        // ceiling read as the denominator of the budget-progress steer, and a seam that forwards
        // the arms key by key must forward that one too or the child is killed at its ceiling
        // never told where it stood.
        childBoundMs: o.childBoundMs,
        signal: o.signal,
        onProgress: o.onProgress,
        budgetTurns: o.budgetTurns,
        // The budget's kill goes through `killProcessTree`, which only reaches the child's tool
        // tree when the child leads its own group.
        processGroup: true,
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}

/**
 * The handler set one run is driven with.
 *
 * Every state `machine.ts`'s `HANDLER_STATES` declares gets an entry here or in
 * `command-post-publish.ts`. A state the table routes that had no handler would end the run
 * handed-back with "no handler", so the two files together are checked exhaustively.
 *
 * The step's own `posted`/`reason` on the host channel are stamped by the caller, not left to the
 * step: see `handlers.handback` below.
 *
 * `headless` is the run's mode, threaded from `runWorkLean` to the dispatching deps builders. It
 * is NOT remembered anywhere: two lean runs in one process each carry their own, so a headless
 * run cannot lend its trust stamp to an interactive one that follows it.
 *
 * `seedWhy` is the seed's reason for having no base, used only to word `ready`'s refusal — see
 * `leanSeed`. `seedInfra` says that reason came from a git INFRASTRUCTURE fault rather than an
 * absent mainline, and with it `ready` hands the run back instead of posting the not-ready
 * comment. Both are read from the seed the run was given.
 *
 * On `PI_ENSEMBLE_HANDOFF_CHANNEL=host` neither reporting step posts: the host owns that channel.
 * The body each step would have sent stays on the step's record, and
 * `headless/work-lean-result.ts` publishes it in the result's `handoff`. The claim `posted` is
 * false because nothing reached the forge — a host must tell a report it still has to deliver from
 * one the forge took.
 */
export function phase1Handlers(
  repoRoot: string,
  issue: number,
  opts: LeanRunOpts & { seedWhy?: string; seedInfra?: boolean } = {},
  deps: Partial<ReadyDeps> = {},
): LeanHandlers {
  const headless = opts.headless === true;
  // Why the seed could not resolve a base, carried in a closure so the `ready` rule can name it.
  // A resumed run never ran this process's seed, so it has no cause and `readyOutcome` probes.
  const seedWhy = opts.seedWhy;
  const seedInfra = opts.seedInfra === true;
  const handlers: LeanHandlers = {};
  // The step's outside calls, resolved once per run: a caller that supplied none gets
  // the production wiring built with THIS run's trust stamp, so a headless run cannot
  // lend its stamp to an interactive one that follows it in the same process.
  const d: ReadyDeps = { ...readyDeps(headless), ...deps };
  // The rows of `ready`'s drafting child ride on every verdict (a dead child still cost
  // tokens); a `ready` that billed none records no key. See `DISPATCH_STATES`.
  const rowsField = (facts: ReadyFacts): { dispatches?: DispatchUsageRow[] } =>
    facts.dispatches === undefined || facts.dispatches.length === 0
      ? {}
      : { dispatches: facts.dispatches };
  handlers.ready = async (ctx) => {
    const { kind, facts } = await readyOutcome(
      repoRoot,
      issue,
      {
        baseSha: ctx.run.baseSha,
        ...(seedWhy ? { why: seedWhy } : {}),
        ...(seedInfra ? { infra: true } : {}),
        ...(opts.specIntake ? { specIntake: opts.specIntake } : {}),
      },
      d,
    );
    // Only the verdict and the rules go on the record. `spec` and `config` stay out:
    // the step log is the durable record of what a run DECIDED, and a parsed document
    // or a loaded config in it is a second copy of a file that can change underneath a
    // resume. `failedRules` alone is what `decline` posts. `derivedSpec` is the one
    // exception because it is the only copy: an authored contract can be re-read from
    // the issue, a derived one exists nowhere else.
    if (kind === "ok") {
      // The derived contract is published where it is minted: a `derive` run puts a
      // machine-written acceptance table on a human's issue and the author has to see
      // it before the run spends a build cycle on it. `ready` posts it, and the step
      // log runs it at most once with an outcome, so a resume never re-posts. The host
      // channel owns its delivery, so nothing posts there. A failed post is traced, not
      // fatal: a run is not destroyed over a comment.
      if (facts.derived !== undefined && handoffChannel() !== "host") {
        try {
          await d.post(repoRoot, issue, facts.derived.spec, facts.derived.model);
        } catch (err) {
          traceDerive(issue, "unposted", (err as Error).message);
        }
      }
      return {
        kind,
        // The base sha rides only with a derived contract: every step already reads the
        // run's base off the record the SEED wrote, and this step's `ok` record is one
        // the byte-identity golden pins.
        ...(facts.derived === undefined || facts.baseSha === undefined
          ? {}
          : { baseSha: facts.baseSha }),
        ...(facts.derived === undefined ? {} : { derivedSpec: facts.derived }),
        ...rowsField(facts),
      };
    }
    if (facts.infra === true)
      return { kind: "infra", reason: facts.failedRules.join("; "), ...rowsField(facts) };
    return { kind, failedRules: facts.failedRules, ...rowsField(facts) };
  };
  handlers.specify = (ctx) => specifyOutcome(ctx, specifyDeps(headless));
  handlers.build = (ctx) => buildOutcome(ctx, buildDeps(headless));
  handlers.challenge = (ctx) => challengeOutcome(ctx, challengeDeps(headless));
  handlers.verify = (ctx) => verifyOutcome(ctx, verifyDeps());
  // The two post-publish steps, in the same one-line shape as the ones above: the step body is
  // the algorithm and `<step>Deps()` is the production wiring.
  Object.assign(handlers, ciLandHandlers(repoRoot, issue), publishHandler(headless));
  handlers.review = (ctx) => reviewOutcome(ctx, reviewDeps(headless));
  // The two steps that REPORT how the run ended live in `lean/report-handlers.ts`: the only
  // handlers that read the host channel, claim `posted`, or send text outside the process.
  Object.assign(handlers, reportHandlers(repoRoot, issue));
  return handlers;
}

/** The one-line summary the command prints. */
function summarize(result: RunLeanResult, issue: number): string {
  const reason = result.run.result?.reason ?? "no result recorded";
  return `work-lean #${issue}: ${result.state} (exit ${result.code}) — ${reason}`;
}

/**
 * Run `/work-lean <issue>` to a terminal state and return the summary line.
 * The command handler prints it; a test calls this directly.
 *
 * `headless` says which run this is: the headless CLI's verb passes `true`, so its children carry
 * the /work-cycle trust stamp that the headless permission path would otherwise deny every tool
 * call on. The interactive command passes nothing.
 *
 * The run is seeded with the mainline sha (`leanSeed`) so the steps that read `ctx.run.baseSha`
 * have a base. The seed lands only on a NEW run: `runLean` ignores it when a state file exists,
 * which is what keeps a resume on the commit its first round pinned.
 *
 * `timeoutMs` (the headless verb's `--timeout <minutes>`) is the THIRD input to the SAME deadline
 * contract `work` reads: `resolveCycleDeadline` weighs it as a duration below
 * `PI_ENSEMBLE_CYCLE_BUDGET_MS` and `PI_ENSEMBLE_CYCLE_DEADLINE`, resolves it to an absolute epoch
 * once, and the engine persists that arm on the record. It is passed as a value, not written to
 * `process.env`: one run's budget cannot arm a later run in the same process.
 *
 * `signal` is `start_lean_driver`'s job kill, handed to the engine's step boundaries.
 */
export async function runWorkLean(
  repoRoot: string,
  issue: number,
  opts: LeanRunOpts & { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ summary: string; result: RunLeanResult }> {
  const seed = await leanSeed(repoRoot);
  const result = await runLean({
    repoRoot,
    issue,
    handlers: handlersFor(repoRoot, issue, opts, seed),
    seed: { version: seed.version, baseSha: seed.baseSha },
    // The flag travels as a VALUE (`flagBudgetMs` mints the brand from the verb's parsed
    // minutes), never as an env write: one run's `--timeout` must not become the deadline of every
    // later dispatch this process makes.
    ...(opts.timeoutMs === undefined
      ? {}
      : { budgetMs: flagBudgetMs(opts.timeoutMs) as CycleBudgetMs }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  return { summary: summarize(result, issue), result };
}

/**
 * The handler set one run is driven with: the phase-1 handlers plus the seed that run was given.
 * Extracted from `runWorkLean` so the seed → handler thread is testable on its own.
 */
export function handlersFor(
  repoRoot: string,
  issue: number,
  opts: LeanRunOpts,
  seed: LeanSeed,
): LeanHandlers {
  return phase1Handlers(repoRoot, issue, {
    ...opts,
    seedWhy: seed.why,
    seedInfra: seed.infra,
  });
}

/**
 * Register `/work-lean <issue>`. The argument is a single issue number, and nothing
 * else: the engine is one issue per run.
 */
export function registerWorkLeanCommand(pi: ExtensionAPI): void {
  pi.registerCommand("work-lean", {
    description: "<issue> — run the lean /work engine (pi-spec v1 contract).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim().split(/\s+/)[0] ?? "";
      if (!/^\d+$/.test(arg)) {
        ctx.ui.notify("usage: /work-lean <issue>", "warning");
        return;
      }
      const issue = Number.parseInt(arg, 10);
      const { resolveRepoRoot } = await import("../work-entry.ts");
      const repoRoot = await resolveRepoRoot(ctx.cwd);
      try {
        const { summary } = await runWorkLean(repoRoot, issue);
        ctx.ui.notify(summary, "info");
      } catch (err) {
        ctx.ui.notify(`work-lean #${issue} failed: ${(err as Error).message}`, "error");
      }
    },
  });
}
