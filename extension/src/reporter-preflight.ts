/**
 * reporter-preflight — the #893 pre-spawn existence check for the companion
 * reporter extensions (report_research_claim / report_plan_item /
 * report_finding / report_policy).
 *
 * The reporter tools are loaded into children via `--extension <path>`. When
 * the path does not exist (an install that never shipped the companion file,
 * a stale path after a restructure), the child still runs — it just never
 * has the tool — and the parent parses an empty toolUse list, reading "the
 * model never called it" in place of "the reporter was never loaded". The
 * distinction matters: one means the channel is broken, the other means the
 * child had nothing to report. This module makes the missing-path case a
 * named, pre-spawn failure instead of a silent empty result.
 *
 * The stat is injectable (`statReporterPath` takes a `check` fn) so the
 * offline tests can fail the check without touching the real filesystem —
 * the same DI shape as ResearchDeps' execFn/fetchFn.
 */
import { stat } from "node:fs/promises";

/** The named error every caller surfaces verbatim. */
export function reporterMissingError(path: string): string {
  return `reporter extension missing: ${path} — run ./install.sh`;
}

/**
 * Stat the reporter extension path; throw the named error when it is not a
 * regular file. Injectable for tests: pass a rejecting `check` to simulate
 * a missing path without touching the real filesystem.
 */
export async function statReporterPath(
  path: string,
  check: (p: string) => Promise<unknown> = stat,
): Promise<void> {
  try {
    await check(path);
  } catch {
    // Any stat failure (ENOENT or a read-permission problem) is the same
    // operator signal — the reporter file is not usable.
    throw new Error(reporterMissingError(path));
  }
}

/**
 * Which reporter extension a dispatch's `extraArgs` loads, or undefined when
 * the dispatch carries no `--extension` argument (duplicate-risk and
 * marker-line children — those legitimately have no reporter and must not
 * be checked).
 */
export function reporterPathFromArgs(extraArgs: readonly string[] | undefined): string | undefined {
  if (!extraArgs) return undefined;
  const i = extraArgs.indexOf("--extension");
  return i >= 0 ? extraArgs[i + 1] : undefined;
}
