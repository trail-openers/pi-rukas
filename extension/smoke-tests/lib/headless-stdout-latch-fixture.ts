/**
 * headless/stdout-latch-fixture — a TEST-OWNED entry point that runs the real
 * headless `work` runner and then attempts a SECOND stdout write (#1863 round 1,
 * stdout ownership).
 *
 * Why a file on disk and not an inline `bun -e` script: `cli.ts`'s supervise
 * branch re-spawns `process.argv[1]`, so the supervisor's child is whatever entry
 * point started the run. An inline script leaves `process.argv[1]` naming the
 * *script*, which is not re-spawnable, and the inner tier never starts. A real
 * path makes the two tiers compose exactly as they do for the shipped CLI.
 *
 * Why the second write comes from THIS process (the supervisor). The latch is
 * process-scoped, and in a supervised run it is the SUPERVISOR that owns the
 * host's stdout: the inner runner's writes go into a pipe, and the supervisor
 * forwards the one document through `workPathStdout`, arming its latch. A second
 * write attempted here, after `main()` returned, is therefore the shape that
 * matters — a document that would be the second one the host reads. If the
 * precondition is not met (nothing armed the latch), the refusal notice says
 * NOT-ARMED and the test reports the case as not tested rather than passing on
 * an empty stream.
 *
 * argv: <cli args, e.g. work 1863 --json> [--extra-stdout]
 */

import {
  isWorkPathStdoutArmed,
  setWorkPathStdoutRefusal,
  workPathStdout,
} from "../../src/headless/work-path-stdout.ts";
import { main } from "../../src/headless/cli.ts";
import { killLiveProcessGroups } from "../../src/spawn-kill.ts";
import { releaseHeldIntegrationLocks } from "../../src/work-driver-lock.ts";

const argv = process.argv.slice(2);
const extra = argv.indexOf("--extra-stdout");
if (extra !== -1) argv.splice(extra, 1);

const code = await main(argv).catch((err: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ error: { code: "crash", message: (err as Error).message } })}\n`,
  );
  return 30;
});

if (extra !== -1) {
  // The precondition: this process put the run's ONE document on the host's
  // stdout, so the latch is armed and anything further is a second document.
  const armedBefore = isWorkPathStdoutArmed();
  // The refusal notice is written to stderr as a plain line rather than left to
  // `trace`, whose output `captureStrayOutput` reshapes into an NDJSON object the
  // host-side assertion could not match on.
  setWorkPathStdoutRefusal((m) => {
    process.stderr.write(`[stdout-latch] ${armedBefore ? "refused" : "NOT-ARMED"}: ${m}\n`);
  });
  workPathStdout(
    `${JSON.stringify({ schemaVersion: 5, exitCode: 0, issues: [], marker: "SECOND" })}\n`,
  );
}

releaseHeldIntegrationLocks();
killLiveProcessGroups();
await new Promise<void>((drain) => {
  if (process.stdout.writableLength === 0) return drain();
  process.stdout.write("", () => drain());
});
process.exit(code);
