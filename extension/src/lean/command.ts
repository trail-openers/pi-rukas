/**
 * lean/command — `/work-lean <issue>`, the phase-1 entry point.
 *
 * Phase 1 is honest about what it cannot do: only `ready` and `decline` have
 * real handlers, and every other state hands back with "work-lean stage
 * <state> is not built yet". That is the point of the shape. The machine, the
 * step log and the config are real now, and a later phase plugs a handler in
 * without touching any of them — which is the property the old driver never
 * had, and the reason this one is written beside it rather than inside it.
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
import { type WorkConfig, loadWorkConfig } from "./config.ts";
import { type LeanHandlers, type RunLeanResult, runLean } from "./engine.ts";
import { fetchIssueBody, mainlineSha, postNotReady } from "./io.ts";
import { HANDLER_STATES, REPORT_FAILED_KIND } from "./machine.ts";
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import type { Step } from "./state.ts";

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

/**
 * The `ready` verdict: fetch, parse, judge readiness, load config at the sha.
 *
 * Never throws. Every failure comes back as `fail` with the rules named,
 * because a run that cannot start still has to say why on the issue.
 */
export async function readyOutcome(
  repoRoot: string,
  issue: number,
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
  const probed = await mainlineSha(repoRoot);
  if (!probed.sha) {
    // The refs probed and why each failed — a run whose mainline could not be
    // resolved is not ready, and the operator reading the issue comment has
    // to be able to tell "this clone has no origin/HEAD" from "git broke".
    const why = probed.why;
    return {
      kind: "fail",
      facts: {
        spec: parsed.spec,
        failedRules: [`could not resolve the mainline sha${why ? `: ${why}` : ""}`],
      },
    };
  }
  try {
    const config = await loadWorkConfig(execp, repoRoot, probed.sha);
    return {
      kind: "ok",
      facts: { spec: parsed.spec, config, baseSha: probed.sha, failedRules: [] },
    };
  } catch (err) {
    return {
      kind: "fail",
      facts: {
        spec: parsed.spec,
        baseSha: probed.sha,
        failedRules: [`.pi/work.json is unusable: ${(err as Error).message}`],
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
 * The phase-1 handler set.
 *
 * `ready` is real; `decline` posts the comment once; everything else is a
 * placeholder that ends the run honestly. A stub that pretended to build would
 * be worse than a run that says which stage is missing.
 */
export function phase1Handlers(repoRoot: string, issue: number): LeanHandlers {
  const notBuilt = (state: string) => async () => ({
    kind: "done",
    reason: `work-lean stage ${state} is not built yet`,
  });
  const handlers: LeanHandlers = {};
  for (const state of HANDLER_STATES) handlers[state] = notBuilt(state);
  handlers.ready = async () => {
    const { kind, facts } = await readyOutcome(repoRoot, issue);
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
 */
export async function runWorkLean(
  repoRoot: string,
  issue: number,
): Promise<{ summary: string; result: RunLeanResult }> {
  const result = await runLean({
    repoRoot,
    issue,
    handlers: phase1Handlers(repoRoot, issue),
    seed: { version: leanVersion() },
  });
  return { summary: summarize(result, issue), result };
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
