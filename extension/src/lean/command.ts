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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execp } from "../exec.ts";
import { isFullCommitSha, resolveHeadSha } from "../review-head-sha.ts";
import { spawnSpecialist } from "../spawn.ts";
import type { DispatchSpec } from "../types.ts";
import type { WriteFence } from "../write-fence-contract.ts";
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
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import { type SpecifyDeps, specifyOutcome } from "./specify.ts";
import type { Outcome, Step } from "./state.ts";
import { oneLine } from "./text-fence.ts";
import { verifyDeps, verifyOutcome } from "./verify.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The extension version, stamped on every run so a state file reads years later. */
export function leanVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** What `ready` learned: kept for the run's seed and for the not-ready comment. */
export interface ReadyFacts {
  spec?: PiSpec;
  config?: WorkConfig;
  baseSha?: string;
  failedRules: string[];
}

/** What the run is seeded with: the version stamp and the pinned base. */
export interface LeanSeed {
  version: string;
  baseSha: string;
  /** Why the probe failed — carried to `ready`'s rule so the comment says what git did. */
  why?: string;
}

/**
 * What a brand-new run starts knowing: its version and the mainline sha.
 *
 * The base has to be on the record from the first write. `specify`, `build`,
 * `challenge` and `verify` all read `ctx.run.baseSha`, and before this existed
 * nothing ever wrote it — `ready`'s handler deliberately returns only its
 * verdict — so every fresh run carried `""` and `specify` refused with
 * "the run carries no base sha" before a model was billed.
 *
 * It is probed ONCE here and pinned, because the base is a run-start fact: a
 * resume keeps the recorded sha rather than re-resolving a mainline that may
 * have moved. Never throws: a repo whose mainline cannot be resolved seeds
 * `""`, and `ready` refuses the run with the reason (`why`) it deserves.
 */
export async function leanSeed(repoRoot: string): Promise<LeanSeed> {
  const version = leanVersion();
  try {
    const probed = await mainlineSha(repoRoot);
    // A sha that is not a full oid is refused here rather than passed on to be
    // refused by `ready`: the seed is what gets written to the record, so an
    // abbreviated or mixed-case value would become the run's base and every
    // later read would be anchored to a string no equality check can settle.
    // The cause says so plainly, and the catch below keeps its own.
    if (probed.sha !== undefined && isFullCommitSha(probed.sha)) {
      return { version, baseSha: probed.sha };
    }
    return {
      version,
      baseSha: "",
      why:
        probed.why ??
        `mainline resolved to ${JSON.stringify(probed.sha ?? "")}, not a full commit sha`,
    };
  } catch (err) {
    return {
      version,
      baseSha: "",
      why: oneLine(err instanceof Error ? err.message : String(err), 160),
    };
  }
}

/**
 * The `ready` verdict: fetch, parse, judge readiness, load config at the base.
 *
 * `baseSha` is the run's own — the seed's answer, read back off the record
 * (`ctx.run.baseSha`), not a fresh probe — and `seedWhy` is what the seed
 * reports when that answer is empty. The base is pinned when the run starts so
 * a config read, a diff and a verify all mean the same commit.
 *
 * A non-empty base is PROVEN to be a commit before anything reads it. The
 * config loader cannot make that distinction: `gitType`/`gitShow` catch every
 * git failure and report "absent", which for a loader means "no config, use
 * the defaults" — so a base that names no object at all (a stale or hand-edited
 * resumed record, a seeder that passed a literal) used to read as a perfectly
 * ordinary repo with no `.pi/work.json` and go green. Refusing it here is the
 * narrow fix: the base is the one ref every later read of the run is anchored
 * to, so "that is not a commit in this clone" is a `ready` failure, not a
 * default config.
 *
 * The proof is TWO checks, not one, because a resolution that succeeds proves
 * less than it looks like it proves. `base` must first be a FULL lowercase
 * 40-hex oid (`isFullCommitSha`), which is what makes the value an immutable
 * object name rather than a ref: `main`, `HEAD`, `@{0}` and a short prefix all
 * fail that test, and with it the git argument can never be a moving ref or a
 * revision chain — an earlier shape of this gate passed `main^{commit}` to git
 * and was satisfied with any 40-hex answer, so `main^{commit}``touch x``@{0}`
 * resolved to main's tip and the run anchored to a commit it never named.
 * Second, the resolution must come BACK EQUAL to the base: a full sha is
 * content-addressed, so anything that resolves to a different oid was never the
 * object the run was seeded with (a mixed-case or otherwise mangled value). The
 * resolution itself goes through the repo's canonical `resolveHeadSha`, which
 * peels with `^{commit}` (so a non-commit object answers `undefined`) and is
 * bounded like every other identity git read.
 *
 * Never throws. Every failure comes back as `fail` with the rules named,
 * because a run that cannot start still has to say why on the issue.
 */
export async function readyOutcome(
  repoRoot: string,
  issue: number,
  base: { baseSha: string; why?: string },
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
    // cause (a resumed run, whose seed this process did not make), ask once.
    // The probe is a git read, so it is guarded: `readyOutcome`'s contract is
    // that it never throws, and an unguarded throw here would end the run as a
    // handler error instead of the refusal with a reason it is meant to be.
    let why = base.why;
    if (why === undefined) {
      try {
        why = (await mainlineSha(repoRoot)).why;
      } catch (err) {
        why = oneLine(err instanceof Error ? err.message : String(err), 160);
      }
    }
    return {
      kind: "fail",
      facts: {
        spec: parsed.spec,
        failedRules: [`could not resolve the mainline sha${why ? `: ${oneLine(why, 160)}` : ""}`],
      },
    };
  }
  // Non-empty is not enough: prove the base IS the commit before the config
  // read, whose blanket catch would otherwise turn "no such object" into
  // "no config file" and hand the run defaults it never earned. See the
  // jsdoc above and the cases in `test-lean-seed-base.ts`.
  if (!isFullCommitSha(base.baseSha)) return baseRefusal(base.baseSha, "");
  // The canonical resolution: `^{commit}` peeling (so a blob or tag object is
  // not a base) and the bound on the git read both live in `resolveHeadSha`.
  const resolved = await resolveHeadSha(repoRoot, base.baseSha, execp);
  if (resolved !== base.baseSha) return baseRefusal(base.baseSha, "");
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

/** A base the clone has no commit for — the same refusal whether the value is
 * not an oid at all or an oid that resolves to no commit, or to a different
 * one. Clipped with `oneLine`: the value came from a record this process did
 * not necessarily write, and the rule ends up in an issue comment. */
function baseRefusal(baseSha: string, detail: string): { kind: "fail"; facts: ReadyFacts } {
  return {
    kind: "fail",
    facts: {
      baseSha,
      failedRules: [`base sha ${oneLine(baseSha, 80)} is not a commit in this clone${detail}`],
    },
  };
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
    dispatch: (spec: DispatchSpec, o: { writeFence?: WriteFence; extraArgs?: readonly string[] }) =>
      spawnSpecialist(spec, {
        writeFence: o.writeFence,
        extraArgs: o.extraArgs,
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
 * `ready`'s refusal — see `leanSeed`.
 */
export function phase1Handlers(
  repoRoot: string,
  issue: number,
  opts: { headless?: boolean; seedWhy?: string } = {},
): LeanHandlers {
  const headless = opts.headless === true;
  // Why the seed could not resolve a base, carried in a closure so the `ready`
  // rule can name it. A resumed run never ran this process's seed, so it has
  // no cause to report and `readyOutcome` probes for one on the failure path.
  const seedWhy = opts.seedWhy;
  const notBuilt = (state: string) => async (): Promise<Outcome> => {
    throw new Error(`work-lean stage ${state} is not built yet`);
  };
  const handlers: LeanHandlers = {};
  for (const state of HANDLER_STATES) handlers[state] = notBuilt(state);
  handlers.ready = async (ctx) => {
    const { kind, facts } = await readyOutcome(repoRoot, issue, {
      baseSha: ctx.run.baseSha,
      ...(seedWhy ? { why: seedWhy } : {}),
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
  handlers.handback = (ctx) => handbackOutcome(ctx, postHandback);
  handlers.decline = async (ctx) => {
    // From the log, not from a closure: see `failedRulesFromLog`.
    const rules = failedRulesFromLog(ctx.steps);
    try {
      await postNotReady(repoRoot, issue, rules);
      return { kind: "done" };
    } catch (err) {
      // NOT `done`: the step log memoizes a completed step forever, so a
      // swallowed throw here would read as "the comment was posted" when it
      // meant "the network dropped". `report-failed` is the kind that records
      // the attempt honestly: the run still ends `not-ready` at exit 11 — the
      // spec refused it whether or not the forge took the comment — and the
      // reason on the record says the comment never went out. It is NOT
      // retried on resume: the step log and the reason are the record.
      return { kind: REPORT_FAILED_KIND, reason: `comment not posted: ${(err as Error).message}` };
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
 * for a missing base, and that line is invisible from the outside because
 * `runWorkLean` always re-seeds through `leanSeed`.
 */
export function handlersFor(
  repoRoot: string,
  issue: number,
  opts: { headless?: boolean },
  seed: LeanSeed,
): LeanHandlers {
  return phase1Handlers(repoRoot, issue, { ...opts, seedWhy: seed.why });
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
