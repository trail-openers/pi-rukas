/**
 * work-driver-deps-gate — #1146 fail-fast for the develop verify gate.
 *
 * Before the verify command runs in a workstream worktree, check that the
 * worktree has every dependency tree provisioning would have linked: a
 * non-empty, gitignored `node_modules` at `repoRoot` or in a depth-1 package
 * dir (the same locations `provisionWorktree` links and verifies). When one
 * does not resolve, the command is not run and the failure names the path.
 * pi-rukas's own verify command used to run in such a worktree until the
 * 10-min timeout and park with no assertion.
 *
 * Fail-open: an unreadable location never blocks — the verify command runs
 * as it did before, and its own failure (plus `provisionDepsHint`) is the
 * backstop. A location whose ignore status `git check-ignore` cannot give is
 * NAMED as undetermined, never silently dropped. Since #1394 the verdict comes
 * from the ONE shared probe (`ignoredStatus` in `worktree-provision.ts`) that
 * the provisioning path itself uses, computed once per candidate by
 * `missingDepLocations` — this module used to carry its own `checkIgnoreStatus`
 * with its own exit-code table and probe each candidate a second time, so the
 * two could disagree about what "unknown" meant and disagree with provisioning
 * too.
 */
import { traceWarn } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { provisionDepsHint } from "./work-driver-deps-hint.ts";
import type { WorkState } from "./workflow-state.ts";
import { packageDirsAt } from "./worktree-provision-hook.ts";
import { missingDepLocations } from "./worktree-provision-verify.ts";

/** The failure to record instead of running `cmd` in `cwd`, or `undefined` to run it. */
export async function missingDepsFailure(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  state: WorkState,
  repoRoot: string,
  cwd: string,
  cmd: string,
): Promise<string | undefined> {
  try {
    const { missing, faults } = await missingDepLocations(
      repoRoot,
      await packageDirsAt(repoRoot),
      cwd,
      execFn,
    );
    const named: string[] = [];
    for (const m of missing) {
      // Only what provisioning links: a tree that is not gitignored is
      // never linked, so its absence is not a provisioning failure.
      if (m.status === "not-ignored") continue;
      const base = `${m.rel} missing in ${cwd} (source: ${m.source})`;
      // The verdict came from the shared probe, once. `unreadable` is the
      // fourth state — `readdir` faulted, so the probe never ran — and it is
      // named with its errno rather than reported as "missing".
      named.push(
        m.status === "ignored"
          ? base
          : m.status === "git-error"
            ? `${base}; ignore status could not determine (git check-ignore${m.detail ?? " reported a git error"})`
            : `${base}; could not be inspected (${m.fault ?? "probe fault"}, ignore status unknown)`,
      );
    }
    if (named.length === 0) return undefined;
    return `verify command \`${cmd}\` not run — dependencies missing: ${named.join("; ")}${provisionDepsHint(state, cwd)}`;
  } catch (err) {
    // Fail-open is the contract: an unreadable location never blocks, the
    // verify command runs, and its own failure plus `provisionDepsHint` is the
    // backstop. What must NOT stay is silence. The bare `return undefined` made
    // "the gate threw" indistinguishable from "the gate found nothing to
    // report", so a cycle could run a verify command into its 10-minute
    // timeout with no clue that the gate meant to fail it fast had been
    // disabled by a filesystem fault. Same verdict, now audible.
    const detail =
      typeof (err as Error)?.message === "string" && (err as Error).message.trim() !== ""
        ? (err as Error).message
        : String(err);
    traceWarn(
      `worktree: deps gate could not run for ${cwd} — verify command \`${cmd}\` proceeds unchecked (${detail.slice(0, 200)})`,
    );
    return undefined;
  }
}
