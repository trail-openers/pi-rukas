#!/usr/bin/env bun
/**
 * headless-wedge-entry — a TEST-OWNED entry point that runs the real headless
 * `work` runner with a short wedge bound (#1863 round 1).
 *
 * The shipped CLI has no `--wedge-ms`. A production flag whose only caller is a
 * test is still a test hook, and it lets any caller mislabel a merely slow cycle
 * as `driver-wedged`: the bound is a reporting backstop, not a policy (see
 * `DEFAULT_WEDGE_MS`). The knob therefore lives here, under `smoke-tests/lib/`,
 * and reaches the runner through `main()`'s library parameter — the same
 * parameter `ResultGuaranteeOpts.wedgeMs` is, and no production file learns it
 * exists.
 *
 * The shape the real-CLI test needs: it spawns THIS file, and `main`'s
 * supervise branch re-spawns `process.argv[1]` — which is this file — with
 * `PI_ENSEMBLE_HEADLESS_SUPERVISED=1`. So the supervisor is the harness and the
 * inner child that holds the wedge timer is this file again, calling `main` with
 * the bound. Nothing outside the tests can reach it.
 *
 * argv: [--wedge-ms <n>] <cli args, e.g. work 1863 --json>
 */

import { main } from "../../src/headless/cli.ts";
import { killLiveProcessGroups } from "../../src/spawn-kill.ts";
import { releaseHeldIntegrationLocks } from "../../src/work-driver-lock.ts";

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

const code = await main(argv, wedgeMs).catch((err: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ error: { code: "crash", message: (err as Error).message } })}\n`,
  );
  return 30;
});

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
