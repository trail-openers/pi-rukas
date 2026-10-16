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
 * NAMED as undetermined, never silently dropped: exit 0 = ignored (provisioning
 * would link it), exit 1 = not ignored (never linked), anything else = unknown.
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
    const missing = await missingDepLocations(repoRoot, await packageDirsAt(repoRoot), cwd, execFn);
    const named: string[] = [];
    for (const m of missing) {
      // Only what provisioning links: a tree that is not gitignored is
      // never linked, so its absence is not a provisioning failure.
      const status = await checkIgnoreStatus(execFn, repoRoot, m.rel);
      if (status === "not-ignored") continue;
      const base = `${m.rel} missing in ${cwd} (source: ${m.source})`;
      named.push(
        status === "ignored"
          ? base
          : `${base}; ignore status could not determine (git error: ${status.error})`,
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

type IgnoreStatus = "ignored" | "not-ignored" | { error: string };

/** `git check-ignore -q`: exit 0 ignored, exit 1 not ignored, anything else unknown. */
async function checkIgnoreStatus(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  repoRoot: string,
  rel: string,
): Promise<IgnoreStatus> {
  try {
    await execFn("git", {
      cwd: repoRoot,
      argv: ["check-ignore", "-q", "--", rel],
      maxBuffer: 64 * 1024,
    });
    return "ignored";
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 1) return "not-ignored";
    const detail = (err as Error)?.message ?? String(err);
    return { error: `${typeof code === "number" ? `exit ${code}: ` : ""}${detail.slice(0, 160)}` };
  }
}
