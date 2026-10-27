#!/usr/bin/env bun
/**
 * headless-wedge-entry — a TEST-OWNED entry point that runs the real headless
 * `work` runner with a short wedge bound (#1863 round 1).
 *
 * The shipped CLI has no `--wedge-ms`, and `main()` takes no bound parameter
 * either (#1863 round 2): a production knob whose only caller is a test is still
 * a test hook, and it lets any caller mislabel a merely slow cycle as
 * `driver-wedged` — a flag an agent could pass is a flag an agent could pass. The
 * bound is a reporting backstop, not a policy (see `DEFAULT_WEDGE_MS`).
 *
 * So the bound is applied HERE, by the harness, around the real runner
 * (`runHeadless`) through `withResultGuarantee`'s `wedgeMs` option. `main` keeps
 * the one thing only it knows — which stdout sink is the host's — and nothing a
 * caller could use to misreport a slow cycle.
 *
 * The shape the real-CLI test needs: it spawns THIS file, and the supervise branch
 * re-spawns `process.argv[1]` — which is this file — with
 * `PI_ENSEMBLE_HEADLESS_SUPERVISED=1`. So the supervisor is the harness and the
 * inner child that holds the wedge timer is this file again. Nothing outside the
 * tests can reach it.
 *
 * argv: [--wedge-ms <n>] <cli args, e.g. work 1863 --json>
 */

import { main, parseHeadlessArgs } from "../../src/headless/cli.ts";
import { withResultGuarantee } from "../../src/headless/ensure-result.ts";
import { runHeadless } from "../../src/headless/run.ts";
import { captureStrayOutput } from "../../src/headless/stderr.ts";
import { SUPERVISED_ENV, superviseWork } from "../../src/headless/supervise.ts";
import { workPathStdout } from "../../src/headless/work-path-stdout.ts";
import { scrubGitLocation } from "../../src/git-env.ts";
import { killLiveProcessGroups } from "../../src/spawn-kill.ts";
import { releaseHeldIntegrationLocks } from "../../src/work-driver-lock.ts";
import { resolveRepoRoot } from "../../src/work-entry.ts";

const argv = process.argv.slice(2);
let wedgeMs: number | undefined;
const at = argv.indexOf("--wedge-ms");
if (at !== -1) {
  const raw = Number(argv[at + 1]);
  if (!Number.isFinite(raw) || raw < 0) {
    process.stderr.write("headless-wedge-entry: --wedge-ms needs a number >= 0\n");
    process.exit(2);
  }
  wedgeMs = raw;
  // Spliced out: `parseHeadlessArgs` rejects unknown arguments, and the bound is
  // this harness's business, never the runner's.
  argv.splice(at, 2);
}

scrubGitLocation(process.env);

const code = await runWorkVerb(argv).catch((err: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ error: { code: "crash", message: (err as Error).message } })}\n`,
  );
  return 30;
});

/**
 * The `work` verb, with the wedge bound applied by the harness.
 *
 * Mirrors `main`'s work branch rather than calling it, so the bound can be
 * injected at the seam `main` no longer exposes. The three things a run cannot
 * do without are all reproduced: the supervise tier (this process re-spawns
 * itself as the inner child), the stray-output capture that keeps the NDJSON
 * stream on stderr pure, and the ONE work-path stdout writer the result document
 * goes through.
 *
 * Everything else — `--capabilities`, the S6 verbs, a malformed argv — is not
 * what the wedge test exercises and is handed straight back to the shipped CLI,
 * so this harness never drifts from it on those paths.
 */
async function runWorkVerb(cliArgv: string[]): Promise<number> {
  if (cliArgv[0] !== "work") return main(cliArgv);
  const args = parseHeadlessArgs(cliArgv.slice(1));
  if ("error" in args) return main(cliArgv);
  if (process.env[SUPERVISED_ENV] !== "1") {
    // The supervisor tier, identical to the CLI's: it re-spawns THIS file (the
    // child inherits `process.argv[1]`), so the inner run is this harness again
    // and carries the wedge timer.
    return superviseWork({
      repoRoot: await resolveRepoRoot(process.cwd()),
      issues: args.issues,
      json: args.json,
      command: [process.execPath, process.argv[1] as string, ...cliArgv],
    });
  }
  const cap = captureStrayOutput();
  const repoRootPromise = resolveRepoRoot(process.cwd());
  return withResultGuarantee({
    json: args.json,
    repoRoot: () => repoRootPromise,
    issues: args.issues,
    // The RESULT document goes to the real stdout; `cap.write` is for NDJSON.
    // Routing the document through the capture is the #1863 bug that made the
    // supervisor report `crash — exited 30 without a result` for a run that had
    // printed one.
    write: (s) => workPathStdout(s),
    // THE KNOB. Only ever set from here.
    wedgeMs,
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

// The same teardown and drain the CLI's own entry point performs: `process.exit`
// skips pending finallys, and a piped stdout is async on POSIX, so the document
// the test is reading would otherwise be truncated.
releaseHeldIntegrationLocks();
killLiveProcessGroups();
await new Promise<void>((drain) => {
  if (process.stdout.writableLength === 0) return drain();
  process.stdout.write("", () => drain());
});
process.exit(code);
