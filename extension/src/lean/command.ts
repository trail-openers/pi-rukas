/**
 * lean/command — `/work-lean <issue>`, the phase-1 entry point.
 *
 * Phase 1 is honest about what it cannot do: `ready`, `specify`, `build`,
 * `challenge`, `verify`, `handback` and `decline` have real handlers, and every
 * other state's stub
 * THROWS "work-lean
 * stage <state> is not built yet". That is the point of the shape. The machine,
 * the step log and the config are real now, and a later phase plugs a handler in
 * without touching any of them — which is the property the old driver never had,
 * and the reason this one is written beside it rather than inside it.
 *
 * The stub throws rather than returning an outcome because the engine's own
 * contract is the outcome vocabulary: a handler may return only the kinds
 * `machine.ts` lists for its state, and `test-lean-machine.ts` fails on any pair
 * the table does not cover. A stub that invented a kind to carry "not built"
 * would be a handler bug by the engine's own definition, and would end the run
 * on the misleading line `no transition for <state> + "…"`. A throw is what the
 * engine already has a path for: the step records `{kind: "error", message}` and
 * the run ends `handed-back` (exit 10) with `handler error at <state>: work-lean
 * stage <state> is not built yet` — the reason an operator actually needs.
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
import type { WriteFence } from "../write-fence-contract.ts";
import { proveBaseSha, unresolvedMainlineRule } from "./base-proof.ts";
import { buildDeps, buildOutcome } from "./build.ts";
import { challengeDeps, challengeOutcome } from "./challenge.ts";
import { leanChildOpts } from "./child-opts.ts";
import { type WorkConfig, loadWorkConfig } from "./config.ts";
import { type LeanHandlers, type RunLeanResult, runLean } from "./engine.ts";
import { handbackOutcome } from "./handback.ts";
import { fetchIssueBody, mainlineSha, postNotReady } from "./io.ts";
import { postHandback } from "./io.ts";
import { HANDLER_STATES, REPORT_FAILED_KIND } from "./machine.ts";
import { publishDeps } from "./publish-deps.ts";
import { publishOutcome } from "./publish.ts";
import { reviewDeps } from "./review-deps.ts";
import { reviewOutcome } from "./review.ts";
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import { type SpecifyDeps, specifyOutcome } from "./specify.ts";
import type { Outcome, Step } from "./state.ts";
import type { BudgetOpts } from "./step-budget.ts";
import { oneLine } from "./text-fence.ts";
import { verifyDeps, verifyOutcome } from "./verify.ts";
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
 * The rules the run's own record says it failed.
 *
 * The newest DECIDED `ready` or `specify` step whose outcome carries
 * `failedRules` — read from the step log, which is the durable record, rather
 * than from a closure that only a live `ready` fills. A run that crashed
 * between `ready` and `decline` resumes with nothing in the closure, and a
 * comment that said "ready never ran" on an issue whose spec had been refused
 * for three named rules would be both wrong and unrecoverable: the step log
 * already records the outcome that decided the verdict, so the comment posts
 * exactly those rules whether this process ran `ready` or not.
 *
 * `specify` is consulted as well as `ready` because it is the other state that
 * can refuse a run (`no-red-test`), and `ready` is asked LAST so its rules
 * shadow an earlier round's — a run whose `ready` passed after an earlier
 * refusal is not a run that posts the old rules.
 */
export function failedRulesFromLog(steps: Step[]): string[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined || step.outcome === undefined) continue;
    if (step.state !== "ready" && step.state !== "specify") continue;
    const rules = step.outcome.failedRules;
    if (Array.isArray(rules) && rules.length > 0) return rules;
  }
  return ["no failed rule was recorded on the step log"];
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

/**
 * The phase-1 handler set.
 *
 * `ready`, `specify`, `build`, `challenge`, `verify`, `handback` and `decline`
 * are real; everything else is a
 * placeholder that ends the run honestly. A stub that pretended to build would
 * be worse than a run that says which stage is missing.
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
  const notBuilt = (state: string) => async (): Promise<Outcome> => {
    throw new Error(`work-lean stage ${state} is not built yet`);
  };
  const handlers: LeanHandlers = {};
  for (const state of HANDLER_STATES) handlers[state] = notBuilt(state);
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
  handlers.publish = (ctx) => publishOutcome(ctx, publishDeps());
  handlers.review = (ctx) => reviewOutcome(ctx, reviewDeps(headless));
  handlers.handback = (ctx) => handbackOutcome(ctx, postHandback);
  handlers.decline = async (ctx) => {
    // From the log, not from a closure: see `failedRulesFromLog`.
    const rules = failedRulesFromLog(ctx.steps);
    try {
      await postNotReady(repoRoot, issue, rules);
      // The comment reached the forge — the typed claim `leanHandoff` reads.
      return { kind: "done", posted: true };
    } catch (err) {
      // NOT `done`: the step log memoizes a completed step forever, so a
      // swallowed throw here would read as "the comment was posted" when it
      // meant "the network dropped". `report-failed` is the kind that records
      // the attempt honestly: the run still ends `not-ready` at exit 11 — the
      // spec refused it whether or not the forge took the comment — and the
      // reason on the record says the comment never went out. It is NOT
      // retried on resume: the step log and the reason are the record.
      return {
        kind: REPORT_FAILED_KIND,
        posted: false,
        reason: `comment not posted: ${(err as Error).message}`,
      };
    }
  };
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
 */
export async function runWorkLean(
  repoRoot: string,
  issue: number,
  opts: { headless?: boolean } = {},
): Promise<{ summary: string; result: RunLeanResult }> {
  const seed = await leanSeed(repoRoot);
  const result = await runLean({
    repoRoot,
    issue,
    handlers: handlersFor(repoRoot, issue, opts, seed),
    seed: { version: seed.version, baseSha: seed.baseSha },
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
