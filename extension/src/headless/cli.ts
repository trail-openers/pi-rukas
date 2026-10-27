#!/usr/bin/env bun
/**
 * pi-rukas-headless — run /work cycles without an interactive Pi session
 * (headless S4, #1024). Entry point for `bin/pi-rukas-headless` and for
 * `pi-rukas run`, which execs it.
 *
 *   pi-rukas-headless work <issue> [more issues] [--restart]
 *                          [--continue-pr] [--timeout <minutes>] [--json]
 *
 * `--continue-pr` (#1468) continues the issue's open pull request instead of
 * stopping on it, so it takes exactly one issue.
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
 * `work` runs as a child of a supervisor (supervise.ts, #1591), so a runner that
 * dies without writing its result still gets one, projected from the state files.
 *
 * There is no `--merge`: merge authority comes only from the project's AGENTS.md
 * (judged by the policy judge), as it does for start_work_driver.
 */

import { scrubGitLocation } from "../git-env.ts";
import { killLiveProcessGroups } from "../spawn-kill.ts";
import { trace } from "../trace.ts";
import { releaseHeldIntegrationLocks } from "../work-driver-lock.ts";
import { resolveRepoRoot } from "../work-entry.ts";
import { runAgentsMdHeadless } from "./agents-md.ts";
import { readBuildCommit, readBuildVersion } from "./build.ts";
import { buildCapabilities } from "./capabilities.ts";
import { withResultGuarantee } from "./ensure-result.ts";
import { EXIT } from "./exit-code.ts";
import { createVerbHost } from "./host.ts";
import { runLensReviewVerb } from "./lens-review.ts";
import { runPlanVerb } from "./plan.ts";
import { runResearchVerb } from "./research.ts";
import { runHeadless } from "./run.ts";
import { type StderrCapture, captureStrayOutput } from "./stderr.ts";
import { SUPERVISED_ENV, superviseWork } from "./supervise.ts";
import type { VerbContext, VerbOutcome } from "./verb.ts";
import { workPathStdout } from "./work-path-stdout.ts";

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
  continuePr: boolean;
  timeoutMs?: number;
  json: boolean;
}

/** Parse argv after the `work` verb. Returns an `error` rather than throwing. */
export function parseHeadlessArgs(argv: string[]): ParsedArgs | { error: string } {
  const issues: number[] = [];
  let restart = false;
  let continuePr = false;
  let json = false;
  let timeoutMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (tok === "--restart") restart = true;
    else if (tok === "--continue-pr") continuePr = true;
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
      // S5 (#1025) — there is deliberately no `--merge` (nor `--sandboxed`), and
      // no `--wedge-ms`: a production flag that exists only so a test can trip
      // the wedge is still a test hook in the shipped CLI, and it lets any
      // caller mislabel a merely slow run as wedged. Tests reach the bound
      // through `ResultGuaranteeOpts.wedgeMs` (see
      // smoke-tests/lib/headless-wedge-entry.ts). A flag an agent could pass is
      // a flag an agent could pass, so the rejection is exact and names the
      // argument.
      return { error: `unknown argument "${tok}"` };
    }
  }
  if (issues.length === 0) return { error: "work needs at least one issue number" };
  if (continuePr && issues.length > 1) return { error: "--continue-pr takes one issue" };
  return { issues, restart, continuePr, timeoutMs, json };
}

/** Set once `work` starts; flushed before the process exits. */
let capture: StderrCapture | undefined;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv;
  // #1571 — this process runs the driver without the extension activating:
  // drop an inherited GIT_DIR & co. here too (git-env.ts).
  scrubGitLocation(process.env);
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
      `usage: pi-rukas-headless work <issue...> [--restart] [--continue-pr] [--timeout <min>] [--json] | ${Object.keys(SUBCOMMANDS).join(" | ")} … | --capabilities\n`,
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
  if (process.env[SUPERVISED_ENV] !== "1") {
    // The child re-spawns `process.argv[1]`, so a caller that runs this module
    // through another entry point (a test's wedge harness, a wrapper bin) gets
    // that same entry point as its supervisor's child — nothing here has to
    // know about it, and the CLI carries no test-only hook.
    return superviseWork({
      repoRoot: await resolveRepoRoot(process.cwd()),
      issues: args.issues,
      json: args.json,
      command: [process.execPath, process.argv[1] as string, ...argv],
    });
  }
  const cap = captureStrayOutput();
  capture = cap;
  // #1863 — the RESULT document's sink is the real stdout, not `cap.write`.
  // `captureStrayOutput` exists to keep the NDJSON stream on stderr pure: every
  // line it is handed becomes a `log` line (that is how a stray `trace`/`console`
  // call is kept off stdout). The runner's own result document is not a stray
  // line, and the first shape of this call routed it through that wrapper — so
  // the one document `work --json` owes its host was written to stderr, stdout
  // closed empty, and the supervisor above reported `crash — exited 30 without a
  // result` for a run whose wedge document had in fact been printed. Measured:
  // the wedge fired, `formatResultDocument` returned the JSON, the wrapper's
  // `raw` was the original stderr write, and the supervisor's stdout buffer held
  // zero chunks. Progress NDJSON still goes to `cap.write`; the document does not.
  // The ONE work-path stdout writer. Both tiers call it and the latch is
  // per-process, which is exactly what makes them compose: the inner tier's fd
  // is the PIPE to its supervisor (and that process writes exactly one
  // document), the supervisor's fd is the HOST's (and its latch admits one).
  const writeResult = (s: string) => {
    workPathStdout(s);
  };
  // #1863 — the result document is written by `withResultGuarantee` on EVERY
  // path on which the runner terminates, including a driver whose promise never
  // settles. The field shape: the adversarial round-review child was killed at
  // its run bound, the driver stayed parked on the child's `exit` event (whose
  // only ref'd backing, the child's own libuv handle, had been released), the
  // loop drained, and the runner exited 0 with an EMPTY stdout — leaving the
  // supervisor to report `crash — the runner process exited 0 without a result`
  // for a cycle that had written a state file. The real fix is the bounded exit
  // await in `spawn-exit-await.ts`; this is the contract that holds regardless:
  // exactly one document, and never a silent 0.
  //
  // The guarantee WRAPS the repo resolution rather than sitting after it. The
  // first draft awaited `resolveRepoRoot` here, and when it rejected — which it
  // does for any cwd that is not inside a repository — the rejection escaped
  // the guarantee, the process died with a stack trace, and the supervisor
  // reported `crash` for a failure that had nothing to do with a wedge. The
  // promise `work` returns is never allowed to reject: a throw becomes a wedge
  // document that names it.
  const repoRootPromise = resolveRepoRoot(process.cwd());
  return withResultGuarantee({
    json: args.json,
    // The REAL repo root, read lazily: only the wedge path needs it, and by
    // then the resolution has settled (or is the very thing that failed, and
    // its rejection becomes the wedge document's message). The earlier `""`
    // made the projection name a path inside no repository.
    repoRoot: () => repoRootPromise,
    issues: args.issues,
    write: writeResult,
    // #1863 round 2 — no wedge bound here, and none on `main`'s signature
    // either. A second positional on the production entry point is a test hook
    // wearing a library API: the only caller that ever passed it is the wedge
    // harness, which now composes the guarantee itself (see
    // smoke-tests/lib/headless-wedge-entry.ts). So `main` keeps the one thing
    // only it knows — which stdout sink is the host's — and nothing that a
    // caller could use to make a merely slow cycle report `driver-wedged`.
    work: async () => {
      const repoRoot = await repoRootPromise;
      return runHeadless({
        repoRoot,
        issues: args.issues,
        restart: args.restart,
        continuePr: args.continuePr,
        timeoutMs: args.timeoutMs,
        write: cap.write,
      });
    },
  });
}

// Run only when executed directly (bun cli.ts ...), never when imported by a
// test — and never in the SUPERVISED child. The child's argv[1] is inherited
// from whoever started the run (superviseWork re-spawns `process.argv[1]`), so
// for a run launched through `bun src/headless/cli.ts` the child's argv[1] ALSO
// ends in `cli.ts`, and an argv-only test here makes the child execute this
// block on top of `main`: the run's own document, then a second one from the
// entry path — precisely the double-document this latch exists to refuse.
const invokedDirectly =
  process.argv[1]?.endsWith("cli.ts") === true && process.env[SUPERVISED_ENV] !== "1";
if (invokedDirectly) {
  // The wedge bound is NOT a flag. It is a reporting backstop, and a caller
  // that could pass it could make a merely slow cycle report `driver-wedged`;
  // tests inject it through `ResultGuaranteeOpts.wedgeMs` instead. `main` is
  // exported for exactly that (see smoke-tests/lib/headless-wedge-entry.ts).
  main(process.argv.slice(2))
    .catch((err: unknown) => {
      process.stdout.write(
        `${JSON.stringify({ error: { code: "crash", message: errorMessage(err) } })}\n`,
      );
      return EXIT.crash;
    })
    .then(async (code) => {
      // process.exit skips every pending finally: release the locks first.
      releaseHeldIntegrationLocks();
      killLiveProcessGroups();
      capture?.flush();
      // #1863 — flush stdout before forcing the exit. `process.exit` truncates
      // anything still buffered: piped stdout — which is every host that runs
      // this — is asynchronous on POSIX, so a result document written moments
      // before was silently dropped and the host reported `exited 30 without a
      // result` for a run that HAD printed one. Measured with `| head`, which is
      // how a harness captures a document: the field symptom, reproduced by a
      // one-character change to how the output is read. When stdout is a TTY the
      // write is synchronous and the drain is a no-op.
      await new Promise<void>((drain) => {
        if (process.stdout.writableLength === 0) return drain();
        process.stdout.write("", () => drain());
      });
      process.exit(code);
    });
}
