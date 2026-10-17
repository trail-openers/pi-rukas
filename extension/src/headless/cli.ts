#!/usr/bin/env bun
/**
 * pi-rukas-headless — run /work cycles without an interactive Pi session
 * (headless S4, #1024). Entry point for `bin/pi-rukas-headless` and for
 * `pi-rukas run`, which execs it.
 *
 *   pi-rukas-headless work <issue> [more issues] [--restart]
 *                          [--timeout <minutes>] [--json]
 *   pi-rukas-headless plan | research | agents-md | lens-review …   (S6, #1021)
 *
 * The S6 subcommands run their pipelines on a headless DriverHost: their
 * flags and exit codes are documented in their own modules (plan.ts,
 * research.ts, agents-md.ts, lens-review.ts), and each always prints one JSON
 * document on stdout.
 *
 * stderr: NDJSON v1 progress lines (ndjson.ts), and nothing else: the driver's
 * own plain-text diagnostics are rerouted as `log` lines (stderr.ts, #1370).
 * stdout: one summary line, or with --json exactly one JSON document. The exit code is derived from the
 * state file (exit-code.ts).
 *
 * Ctrl-C (SIGINT) and SIGTERM interrupt the cycle: the driver records
 * `interrupted` at its next step boundary, and every child it started is killed
 * with its process group (exit 21). Interactive /work is unchanged: its
 * children stay in the terminal's group, so Ctrl-C reaches them as before.
 *
 * There is no `--merge`: merge authority comes only from the project's AGENTS.md
 * (judged by the policy judge), as it does for start_work_driver.
 */

import { resourceReport } from "../resource-budget.ts";
import { killLiveProcessGroups } from "../spawn-kill.ts";
import { releaseHeldIntegrationLocks } from "../work-driver-lock.ts";
import { resolveRepoRoot } from "../work-entry.ts";
import { runAgentsMdHeadless } from "./agents-md.ts";
import { readBuildCommit, readBuildVersion } from "./build.ts";
import { buildCapabilities } from "./capabilities.ts";
import { EXIT } from "./exit-code.ts";
import { createVerbHost } from "./host.ts";
import { runLensReviewVerb } from "./lens-review.ts";
import { runPlanVerb } from "./plan.ts";
import { runResearchVerb } from "./research.ts";
import { resultDocument } from "./result.ts";
import { runHeadless } from "./run.ts";
import { type StderrCapture, captureStrayOutput } from "./stderr.ts";
import type { VerbContext, VerbOutcome } from "./verb.ts";

/** The S6 subcommands (#1021), keyed by verb. */
export const SUBCOMMANDS: Record<string, Subcommand> = {
  plan: runPlanVerb,
  research: runResearchVerb,
  "agents-md": runAgentsMdHeadless,
  "lens-review": runLensReviewVerb,
};

type Subcommand = (argv: readonly string[], ctx: VerbContext) => Promise<VerbOutcome>;

/**
 * Run one S6 subcommand: NDJSON on stderr through `write`, the JSON document on
 * stdout. `run` defaults to the verb's entry in SUBCOMMANDS; tests pass one
 * that injects their seams.
 */
export async function runSubcommand(
  verb: string,
  argv: readonly string[],
  repoRoot: string,
  write: (line: string) => void,
  run: Subcommand | undefined = Object.hasOwn(SUBCOMMANDS, verb) ? SUBCOMMANDS[verb] : undefined,
): Promise<number> {
  if (!run) throw new Error(`unknown subcommand "${verb}"`);
  const { exitCode, doc } = await run(argv, { repoRoot, host: createVerbHost(write) });
  const build = { buildCommit: readBuildCommit(), buildVersion: readBuildVersion() };
  process.stdout.write(`${JSON.stringify({ ...build, ...doc })}\n`);
  return exitCode;
}

export interface ParsedArgs {
  issues: number[];
  restart: boolean;
  timeoutMs?: number;
  json: boolean;
}

/** Parse argv after the `work` verb. Returns an `error` rather than throwing. */
export function parseHeadlessArgs(argv: string[]): ParsedArgs | { error: string } {
  const issues: number[] = [];
  let restart = false;
  let json = false;
  let timeoutMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (tok === "--restart") restart = true;
    else if (tok === "--json") json = true;
    else if (tok === "--timeout") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: "--timeout needs minutes > 0" };
      timeoutMs = v * 60_000;
    } else if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (n <= 0) return { error: `invalid issue number "${tok}"` };
      issues.push(n);
    } else {
      // S5 (#1025) — there is deliberately no `--merge` (nor `--sandboxed`).
      // Headless merge authority comes only from AGENTS.md through the policy
      // judge, and trust mode only from PI_ENSEMBLE_SANDBOX_MODE=1 in the
      // image entrypoint. A flag an agent could pass is a flag an agent could
      // pass, so the rejection is exact and names the argument.
      return { error: `unknown argument "${tok}"` };
    }
  }
  if (issues.length === 0) return { error: "work needs at least one issue number" };
  return { issues, restart, timeoutMs, json };
}

/** Set once `work` starts; flushed before the process exits. */
let capture: StderrCapture | undefined;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  // #1306 — `--capabilities` answers before any cycle, repo or network is
  // touched: the whole point is that a caller checks the build it is about
  // to run without paying for a run. It therefore dispatches before
  // resolveRepoRoot, which is the first place a repo is read.
  if (verb === "--capabilities") {
    process.stdout.write(`${JSON.stringify(buildCapabilities())}\n`);
    return EXIT.merged;
  }
  if (verb !== undefined && Object.hasOwn(SUBCOMMANDS, verb)) {
    capture = captureStrayOutput();
    return runSubcommand(verb, rest, await resolveRepoRoot(process.cwd()), capture.write);
  }
  if (verb !== "work") {
    process.stderr.write(
      `usage: pi-rukas-headless work <issue...> [--restart] [--timeout <min>] [--json] | ${Object.keys(SUBCOMMANDS).join(" | ")} … | --capabilities\n`,
    );
    return EXIT.refused;
  }
  const args = parseHeadlessArgs(rest);
  if ("error" in args) {
    process.stdout.write(
      `${JSON.stringify({ error: { code: "bad-arguments", message: args.error } })}\n`,
    );
    return EXIT.refused;
  }
  capture = captureStrayOutput();
  const repoRoot = await resolveRepoRoot(process.cwd());
  const run = await runHeadless({
    repoRoot,
    issues: args.issues,
    restart: args.restart,
    timeoutMs: args.timeoutMs,
    write: capture.write,
  });
  if (args.json) {
    const doc = resultDocument(run, { commit: readBuildCommit(), version: readBuildVersion() });
    // #1325 — the host budget and the limits this run chose.
    process.stdout.write(`${JSON.stringify({ ...doc, resources: resourceReport() })}\n`);
  } else {
    const parts = run.results.map((r) => `#${r.issue} ${r.status} (exit ${r.exitCode})`);
    process.stdout.write(`pi-rukas-headless: ${parts.join(", ") || "nothing ran"}\n`);
    if (run.error) {
      process.stdout.write(`error: ${run.error.code} — ${run.error.message}\n`);
    }
  }
  return run.exitCode;
}

// Run only when executed directly (bun cli.ts ...), never when imported by a test.
const invokedDirectly = process.argv[1]?.endsWith("cli.ts") === true;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .catch((err: unknown) => {
      process.stdout.write(
        `${JSON.stringify({ error: { code: "crash", message: errorMessage(err) } })}\n`,
      );
      return EXIT.crash;
    })
    .then((code) => {
      // process.exit skips every pending finally: release the locks first.
      releaseHeldIntegrationLocks();
      killLiveProcessGroups();
      capture?.flush();
      process.exit(code);
    });
}
