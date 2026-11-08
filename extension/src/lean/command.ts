/**
 * lean/command — `/work-lean <issue>`, the phase-1 entry point.
 *
 * Every state the machine routes has a real handler here. That used to be a
 * promise about a later phase: the table shipped with a placeholder per
 * unbuilt state, and the honesty of the shape was that the placeholder threw
 * rather than inventing an outcome kind the table could not route. No state is
 * unbuilt now, so the placeholder and its `work-lean stage <state> is not built
 * yet` sentence went with it — the wiring tests that used to assert a step was
 * not answered by the stub (`test-lean-challenge.ts` (n),
 * `test-lean-specify-bytes.ts`, `test-lean-ci-land-wiring.ts` (p)) assert the
 * positive instead: each step answers with its OWN refusal.
 *
 * What the placeholder taught stays: a handler may return only the kinds
 * `machine.ts` lists for its state, and `test-lean-machine.ts` fails on any pair
 * the table does not cover. A handler that invented a kind would end the run on
 * the misleading line `no transition for <state> + "…"`, which blames the machine
 * for a bug in the handler.
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
import type { DispatchSpec } from "../types.ts";
import { type CycleBudgetMs, flagBudgetMs } from "../work-driver-deadline.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { proveBaseSha, unresolvedMainlineRule } from "./base-proof.ts";
import { buildDeps, buildOutcome } from "./build.ts";
import { challengeDeps, challengeOutcome } from "./challenge.ts";
import { leanChildOpts } from "./child-opts.ts";
import { ciLandHandlers, publishHandler } from "./command-post-publish.ts";
import { type WorkConfig, loadWorkConfig } from "./config.ts";
import { type LeanHandlers, type RunLeanResult, runLean } from "./engine.ts";
import { fetchIssueBody, mainlineSha } from "./io.ts";
import { reportHandlers } from "./report-handlers.ts";
import { reviewDeps } from "./review-deps.ts";
import { reviewOutcome } from "./review.ts";
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import { type SpecifyDeps, specifyOutcome } from "./specify.ts";
import type { Step } from "./state.ts";
import type { BudgetOpts } from "./step-budget.ts";
import { oneLine } from "./text-fence.ts";
import { verifyDeps } from "./verify-deps.ts";
import { verifyOutcome } from "./verify.ts";
import { leanVersion } from "./version.ts";

// The version stamp lives in `lean/version.ts`, its own leaf: the seed needs it
// too, and importing it from here made the seed depend on this whole handler
// table while this table depends on the seed. Re-exported because a caller that
// wants the stamp reaches for it where it reaches for the command.
export { leanVersion } from "./version.ts";

/** What `ready` learned: kept for the run's seed and for the not-ready comment. */
export interface ReadyFacts {
  spec?: PiSpec;
  config?: WorkConfig;
  baseSha?: string;
  failedRules: string[];
}

/** What the run is seeded with, and what the seed learned about the base. */
export type { LeanSeed } from "./seed.ts";

// Re-exported rather than imported-and-returned: `leanSeed` is the run-start
// seam and the suites that pin it (`test-lean-seed-base.ts`,
// `test-lean-base-infra.ts`, `test-lean-seed-infra.ts`) reach it through the
// command module, the way the command itself uses it — the definition lives in
// `lean/seed.ts`, which this line keeps reachable from either name.
export { leanSeed } from "./seed.ts";
import { type LeanSeed, leanSeed } from "./seed.ts";

/**
 * The `ready` verdict: fetch, parse, judge readiness, load config at the base.
 *
 * `baseSha` is the run's own — the seed's answer, read back off the record
 * (`ctx.run.baseSha`), not a fresh probe — and `seedWhy` is what the seed
 * reports when that answer is empty. The base is pinned when the run starts so
 * a config read, a diff and a verify all mean the same commit.
 *
 * A non-empty base is PROVEN to be a commit before anything reads it — see
 * `lean/base-proof.ts`, which owns both rules and the `cat-file -e` second
 * opinion. The config loader cannot make that distinction: `gitType`/`gitShow`
 * catch every git failure and report "absent", which for a loader means "no
 * config, use the defaults" — so a base that names no object at all (a stale or
 * hand-edited resumed record, a seeder that passed a literal) used to read as a
 * perfectly ordinary repo with no `.pi/work.json` and go green.
 *
 * Throws on a git INFRASTRUCTURE fault, and only there. A spec that is not
 * ready, an empty base and a base that names no commit all come back as `fail`
 * with the rules named, because a run that cannot start still has to say why on
 * the issue — but a run whose git could not be asked is not an unready issue,
 * and posting "your base is not a commit" on an issue whose clone merely had a
 * locked index would tell the operator to fix something that is not broken.
 * The throw is what the engine turns into a handler-error handback.
 */
export async function readyOutcome(
  repoRoot: string,
  issue: number,
  base: Pick<LeanSeed, "baseSha" | "why" | "infra">,
): Promise<{ kind: "ok" | "fail"; facts: ReadyFacts }> {
  let body: string;
  try {
    body = await fetchIssueBody(repoRoot, issue);
  } catch (err) {
    return {
      kind: "fail",
      facts: { failedRules: [`could not read the issue: ${(err as Error).message}`] },
    };
  }
  const parsed = parsePiSpec(body);
  if (!parsed.ok) return { kind: "fail", facts: { failedRules: [parsed.reason] } };
  const failed = readiness(parsed.spec);
  if (failed.length > 0) return { kind: "fail", facts: { spec: parsed.spec, failedRules: failed } };
  // The base is the run's, resolved once by `leanSeed` and pinned on the run
  // record: re-probing here would let a `ready` that ran after origin/HEAD
  // moved judge the run against a commit the rest of it never saw.
  if (!base.baseSha) {
    // The refs probed and why each failed are the seed's — see `leanSeed`.
    // A run whose mainline could not be resolved is not ready, and the
    // operator reading the issue comment has to be able to tell "this clone
    // has no origin/HEAD" from "git broke"; when the seed never carried a
    // cause (a resumed run, whose seed this process did not make, or one that
    // carried `""`), ask once. The probe is a git read, so it is guarded: an
    // unguarded throw on THIS path would turn a refusal-with-a-reason into a
    // handler error, and there is no git fact left to verify — the base is
    // already empty whatever the probe says.
    let why = base.why;
    if (!why) {
      try {
        why = (await mainlineSha(repoRoot)).why;
      } catch (err) {
        why = oneLine(err instanceof Error ? err.message : String(err), 160);
      }
    }
    // A seed that FAILED rather than found nothing hands back, it does not
    // refuse — see `LeanSeed.infra`. The run's base could not be established
    // because git could not be asked, which is a fact about this harness and
    // not about the issue; the not-ready comment is the wrong surface for it
    // and the handback (exit 10, no comment) is where an operator looks. This
    // is deliberately symmetric with the non-empty branch below, which lets
    // `proveBaseSha` throw for exactly the same class of fault.
    if (base.infra === true) {
      // CLIPPED because `why` is git's text — a first stderr line, an exec
      // message — being put into a thrown message an operator (and a log
      // renderer) sees verbatim, exactly as `unresolvedMainlineRule` clips the
      // same string on the refusal path. An unbounded `why` here is a second
      // renderer that has to remember the rule the first one states.
      throw new Error(
        `could not seed the run's base: ${oneLine(why ?? "no reason recorded", 160)}`,
      );
    }
    return {
      kind: "fail",
      facts: {
        spec: parsed.spec,
        // Never an empty tail: with no seed cause and no probe cause the rule
        // still names the refs the probe asked for (`NO_MAINLINE_WHY`).
        failedRules: [unresolvedMainlineRule(why)],
      },
    };
  }
  // Non-empty is not enough: prove the base IS the commit before the config
  // read, whose blanket catch would otherwise turn "no such object" into
  // "no config file" and hand the run defaults it never earned. The proof — its
  // two rules, its peel, and the `cat-file -e` second opinion that separates a
  // missing object from a broken git — lives in `lean/base-proof.ts`; it throws
  // on a git fault, which is what this handler's caller turns into a handback.
  // See the cases in `test-lean-seed-base.ts`.
  const proof = await proveBaseSha(repoRoot, base.baseSha);
  if (!proof.ok) {
    // The refused value is deliberately absent from the facts: it is untrusted
    // text from a record this process did not write, it is already inside the
    // rule where it is clipped, and a second copy in the facts is a second
    // place a later renderer has to remember to clip.
    return { kind: "fail", facts: { spec: parsed.spec, failedRules: [proof.rule] } };
  }
  try {
    const config = await loadWorkConfig(execp, repoRoot, base.baseSha);
    return {
      kind: "ok",
      facts: { spec: parsed.spec, config, baseSha: base.baseSha, failedRules: [] },
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
      },
    };
  }
}

/**
 * The specify step's dependencies: the outside world, injected.
 *
 * `dispatch` is the only model call the step makes and `exec` the only thing
 * that touches git, so the smoke test drives a real temp repository through
 * both without a child process or a forge.
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
        // Forwarded so the ceiling binds the child, `budgetTurns` included: it is
        // the turns ceiling read as the denominator of the #1991 budget-progress
        // steer, and a seam that forwards the arms key by key must forward that
        // one too or the child is killed at its ceiling never told where it stood.
        childBoundMs: o.childBoundMs,
        signal: o.signal,
        onProgress: o.onProgress,
        budgetTurns: o.budgetTurns,
        // The budget's kill goes through `killProcessTree`, which only reaches
        // the child's tool tree when the child leads its own group.
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
 * `command-post-publish.ts`: `ready`, `specify`, `build`, `challenge`, `verify`,
 * `review`, `handback` and `decline` below, `publish`, `ci` and `land` there. A
 * state the table routes that had no handler would end the run handed-back with
 * "no handler", so the two files together are checked exhaustively by
 * `test-lean-challenge.ts` (n) rather than by a placeholder that kept the shape
 * safe by answering for a step nobody wrote.
 *
 * The step's own `posted`/`reason` on the host channel are stamped by the caller,
 * not left to the step: see `handlers.handback` below.
 *
 * `headless` is the run's mode, threaded from `runWorkLean` to the three
 * dispatching deps builders. It is NOT remembered anywhere: two lean runs in one
 * process each carry their own, so a headless run cannot lend its trust stamp to
 * an interactive one that follows it.
 *
 * `seedWhy` is the seed's reason for having no base, used only to word
 * `ready`'s refusal — see `leanSeed`. `seedInfra` says that reason came from a
 * git INFRASTRUCTURE fault rather than an absent mainline, and with it `ready`
 * hands the run back instead of posting the not-ready comment — see
 * `LeanSeed.infra`. Both are read from the seed the run was given, so a resumed
 * run (which never ran this process's seed) keeps the refusal path.
 *
 * On `PI_ENSEMBLE_HANDOFF_CHANNEL=host` neither reporting step posts (#1920 item
 * 3): the host owns that channel, exactly as `work`'s handoff step declines to
 * post there. The body each step would have sent stays on the step's record, and
 * `headless/work-lean-result.ts` publishes it in the result's `handoff` with
 * `channel: "host"`. The claim `posted` is false because nothing reached the
 * forge — a host must be able to tell a report it still has to deliver from one
 * the forge took.
 */
export function phase1Handlers(
  repoRoot: string,
  issue: number,
  opts: { headless?: boolean; seedWhy?: string; seedInfra?: boolean } = {},
): LeanHandlers {
  const headless = opts.headless === true;
  // Why the seed could not resolve a base, carried in a closure so the `ready`
  // rule can name it. A resumed run never ran this process's seed, so it has
  // no cause to report and `readyOutcome` probes for one on the failure path.
  const seedWhy = opts.seedWhy;
  const seedInfra = opts.seedInfra === true;
  const handlers: LeanHandlers = {};
  handlers.ready = async (ctx) => {
    const { kind, facts } = await readyOutcome(repoRoot, issue, {
      baseSha: ctx.run.baseSha,
      ...(seedWhy ? { why: seedWhy } : {}),
      ...(seedInfra ? { infra: true } : {}),
    });
    // Only the verdict and the rules go on the record. `spec`, `config` and
    // `baseSha` stay out of it — the step log is the durable record of what a
    // run DECIDED, and a parsed document or a loaded config written into it is
    // a second copy of a file that can change underneath a resume, plus a
    // reason line a future reader would mistake for part of the contract.
    // `failedRules` alone is what `decline` posts and what the summary line
    // joins, so nothing is lost by keeping the rest here.
    if (kind === "ok") return { kind };
    return { kind, failedRules: facts.failedRules };
  };
  handlers.specify = (ctx) => specifyOutcome(ctx, specifyDeps(headless));
  handlers.build = (ctx) => buildOutcome(ctx, buildDeps(headless));
  handlers.challenge = (ctx) => challengeOutcome(ctx, challengeDeps(headless));
  handlers.verify = (ctx) => verifyOutcome(ctx, verifyDeps());
  // The two post-publish steps, in the same one-line shape as the ones above:
  // the step body is the algorithm and `<step>Deps()` is the production wiring,
  // so a test drives them by injecting its own recorder and never touches a PR.
  Object.assign(handlers, ciLandHandlers(repoRoot, issue), publishHandler());
  handlers.review = (ctx) => reviewOutcome(ctx, reviewDeps(headless));
  // The two steps that REPORT how the run ended live in `lean/report-handlers.ts`:
  // they are the only handlers that read the host channel, claim `posted`, or send
  // text outside the process.
  Object.assign(handlers, reportHandlers(repoRoot, issue));
  return handlers;
}

/** The one-line summary the command prints. */
export function summarize(result: RunLeanResult, issue: number): string {
  const reason = result.run.result?.reason ?? "no result recorded";
  return `work-lean #${issue}: ${result.state} (exit ${result.code}) — ${reason}`;
}

/**
 * Run `/work-lean <issue>` to a terminal state and return the summary line.
 * The command handler prints it; a test calls this directly.
 *
 * `headless` says which run this is: the headless CLI's verb passes `true`, so
 * its children carry the /work-cycle trust stamp that the headless permission
 * path would otherwise deny every tool call on. The interactive command passes
 * nothing — its parent session is already in trust mode and needs no stamp.
 *
 * The run is seeded with the mainline sha (`leanSeed`) so the steps that read
 * `ctx.run.baseSha` have a base. The seed lands only on a NEW run: `runLean`
 * ignores it when a state file exists, which is what keeps a resume on the
 * commit its first round pinned.
 *
 * `timeoutMs` (the headless verb's `--timeout <minutes>`) is the THIRD input to
 * the SAME deadline contract `work` reads (#1920 item 2): the shared reader
 * (`resolveCycleDeadline`) weighs it as a duration BELOW an exported
 * `PI_ENSEMBLE_CYCLE_BUDGET_MS` and below an exported `PI_ENSEMBLE_CYCLE_DEADLINE`,
 * resolves it to an absolute epoch once, and the engine persists that arm on the
 * record. It is passed as a value, not written to `process.env`: the env stays the
 * host's input, and one run's budget cannot arm a later run in the same process.
 */
export async function runWorkLean(
  repoRoot: string,
  issue: number,
  opts: { headless?: boolean; timeoutMs?: number } = {},
): Promise<{ summary: string; result: RunLeanResult }> {
  const seed = await leanSeed(repoRoot);
  const result = await runLean({
    repoRoot,
    issue,
    handlers: handlersFor(repoRoot, issue, opts, seed),
    seed: { version: seed.version, baseSha: seed.baseSha },
    // The flag travels as a VALUE (`flagBudgetMs` mints the brand from the
    // verb's parsed minutes), never as an env write: one run's `--timeout` must
    // not become the deadline of every later dispatch this process makes.
    ...(opts.timeoutMs === undefined
      ? {}
      : { budgetMs: flagBudgetMs(opts.timeoutMs) as CycleBudgetMs }),
  });
  return { summary: summarize(result, issue), result };
}

/**
 * The handler set one run is driven with: the phase-1 handlers plus the seed
 * that run was given. Extracted from `runWorkLean` so the seed → handler thread
 * is testable on its own: `seedWhy` is what lets `ready` quote the git cause
 * for a missing base, and `seedInfra` is what makes `ready` hand the run back
 * instead of posting a not-ready comment for a seed that faulted (see
 * `LeanSeed.infra`). Both lines are invisible from the outside because
 * `runWorkLean` always re-seeds through `leanSeed`.
 */
export function handlersFor(
  repoRoot: string,
  issue: number,
  opts: { headless?: boolean },
  seed: LeanSeed,
): LeanHandlers {
  return phase1Handlers(repoRoot, issue, {
    ...opts,
    seedWhy: seed.why,
    seedInfra: seed.infra,
  });
}

/**
 * Register `/work-lean <issue>`.
 *
 * The argument is a single issue number, and nothing else: the engine is one
 * issue per run, and the phase that adds grouping adds its own argument
 * rather than widening this parser to guess at it.
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
