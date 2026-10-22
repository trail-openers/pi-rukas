/**
 * work-develop-paths — the ONE rendering of an uncommitted-path list on the
 * develop paths (#1768).
 *
 * Three readers name the same list — the crash verdict's reason, the unfinished
 * cap's evidence, and the corrective prompt — and a fourth would be a fourth way
 * to say "the child left these behind" with its own truncation rule.
 */

/** How many uncommitted paths get named before the list says "+N more". */
export const SHOWN_PATHS = 10;

/** `a, b, …`, with the tail counted rather than dropped silently. */
export function namePaths(paths: string[]): string {
  if (paths.length === 0) return "none";
  const shown = paths.slice(0, SHOWN_PATHS).join(", ");
  return paths.length > SHOWN_PATHS ? `${shown} (+${paths.length - SHOWN_PATHS} more)` : shown;
}

/** The paragraph a corrective develop pass is given: what is still uncommitted,
 *  and that finishing means COMMITTING. Short on purpose — the child carries its
 *  full original brief, and the driver will not commit for it. */
export function unfinishedPromptSuffix(paths: string[]): string {
  return [
    "",
    "",
    `Your previous pass ended with ${paths.length} uncommitted path(s) and no commit of your own:`,
    namePaths(paths),
    "Finish the work you described as remaining, then COMMIT it. The step is not counted",
    "done until a commit of yours is ahead of your base; the driver will not commit it for you.",
  ].join("\n");
}
