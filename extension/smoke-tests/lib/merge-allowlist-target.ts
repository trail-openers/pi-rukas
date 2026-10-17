/**
 * merge-allowlist-target — the stalled-`git` bound (#1417), pulled out of
 * `test-merge-guard-allowlist.ts` for the §12 size cap.
 *
 * It is not a table: it is the one place that proves a `git` which never
 * settles cannot hang the guard. Both the forge detection and the PR read sit
 * on the same stalled-exec seam, so they stay together, and both are driven by
 * one `never`-resolving `execFn`.
 */

import { detectForge } from "../../src/forge-detect.ts";
import type { ExecResult } from "../../src/exec.ts";
import { type MergeExecFn, readMergeTarget, resolvePrNumber } from "../../src/merge-target.ts";
import { assert } from "../merge-guard-helpers.ts";

/** A `git` that never answers: the hang every bound below is measured against. */
const never: MergeExecFn = () => new Promise(() => {});

/**
 * The same stalled `git` on the forge-detection seam.
 *
 * `DetectForgeOpts.execFn` is typed `typeof execp`, whose `ExecResult` makes
 * `stderr` REQUIRED — narrower than `MergeExecFn`, which leaves it optional.
 * Reusing `never` there is a type error, not a behaviour difference: the
 * promise never settles either way, so the timeout path is still what fires.
 */
const neverExecp = (): Promise<ExecResult> => new Promise(() => {});

/** Where the stalled `git` is pretended to run — nowhere, on purpose. */
const NONEXISTENT = "/nonexistent";

/** The exec bound each call is given, so "bounded" is a testable claim. */
const EXEC_TIMEOUT_MS = 50;

/** Wall-clock allowance for a bounded call (ms): the bound plus generous slack. */
const WALL_CLOCK_BOUND_MS = 2000;

/**
 * The environment the two reads below run with: no `PI_ENSEMBLE_FORGE`.
 *
 * That variable is the detectForge hard override — set, detection short-circuits
 * to a forge and the stalled `git` is never reached, so the bound goes
 * unmeasured. `merge-guard-helpers.ts` pins it to `"github"` process-wide for
 * the offline decision matrix, so this suite cannot inherit `process.env`.
 * Passing an env with the key ABSENT is the same effect `delete` has — and
 * `delete` is exactly what this file must not do: assigning `undefined` to a
 * `process.env` key stores the string `"undefined"` (the Bun 1.4 regression
 * `test-env-clear-gate.ts` ratchets out of this tree), and that key would then
 * still be there for the next test in the process. A fresh object with the key
 * unset never had it.
 */
const NO_FORGE_ENV = {};

/**
 * Assert that a `git` which never returns yields "unknown forge" and a
 * refusing merge-target read, both within the wall-clock bound.
 */
export async function assertStalledGitIsBounded() {
  const t0 = performance.now();
  const d = await detectForge(NONEXISTENT, {
    execFn: neverExecp,
    env: NO_FORGE_ENV,
    forgeConfigContent: "",
    allowProbe: false,
    execTimeoutMs: EXEC_TIMEOUT_MS,
  });
  const dt = performance.now() - t0;
  assert(
    d.forge === "unknown" && d.source === "unknown",
    `stalled git → unknown forge (${d.source})`,
  );
  assert(
    dt < WALL_CLOCK_BOUND_MS,
    `stalled git is bounded (${dt.toFixed(0)}ms < ${WALL_CLOCK_BOUND_MS}ms)`,
  );

  const r = await readMergeTarget(never, NONEXISTENT, 17, {
    execFn: neverExecp,
    env: NO_FORGE_ENV,
    forgeConfigContent: "",
    execTimeoutMs: EXEC_TIMEOUT_MS,
  });
  assert(
    !r.ok && /could not determine the forge/.test(r.ok ? "" : r.reason),
    "stalled git → the merge target read refuses",
  );

  // The number-less merge takes the other door: `resolvePrNumber` resolves the
  // PR from the CURRENT branch, and the guard calls it before the target read.
  // Same stalled `git`, same fail-closed answer — an unresolved number must
  // never become "merge whatever is current".
  const t1 = performance.now();
  const n = await resolvePrNumber(never, NONEXISTENT, undefined, {
    execFn: neverExecp,
    env: NO_FORGE_ENV,
    forgeConfigContent: "",
    execTimeoutMs: EXEC_TIMEOUT_MS,
  });
  const dt1 = performance.now() - t1;
  assert(n === undefined, "stalled git → the branch-resolved PR number is undefined (fail-closed)");
  assert(
    dt1 < WALL_CLOCK_BOUND_MS,
    `stalled git is bounded on the number read too (${dt1.toFixed(0)}ms < ${WALL_CLOCK_BOUND_MS}ms)`,
  );
}
