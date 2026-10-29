/**
 * headless/files — the `.pi/*` files a cycle reads from the project, for the
 * `--capabilities` answer (#1326). Split out of `inputs.ts` (AGENTS.md §12):
 * the env list there is data at scale and this is a second list with its own
 * shape; keeping them together pushed the module past the size cap.
 *
 * Read it together with `HEADLESS_INPUTS`: `test-headless-inputs.ts` fails
 * when one of these is no longer read anywhere in `src/`, and
 * `test-verify-cmd-no-bare-bunx.ts` scans the `kind: "command"` entries for
 * the launcher-shaped tsc invocations #1414/#1118 refused.
 */

export type FileKind = "command" | "hook" | "config";

export interface HostFile {
  /** Path relative to the project root. */
  path: string;
  kind: FileKind;
  /** What happens when the file is absent. */
  whenAbsent: string;
}

/**
 * The `.pi/*` files a cycle reads from the project as input. Files the
 * driver writes (`.pi/work-state/`, `.pi/decisions.jsonl`, sidecars) are
 * state, not input, and are deliberately absent: they are not a host contract.
 */
export const HEADLESS_FILES: readonly HostFile[] = [
  { path: ".pi/forge", kind: "config", whenAbsent: "forge detected from the git remote" },
  { path: ".pi/permissions.json", kind: "config", whenAbsent: "~/.pi/agent/permissions.json" },
  // #1509 — the per-tier verify budgets a project may declare (#1041). Read
  // like every other `.pi/` config file; an unparseable value is ignored with a
  // trace and the next precedence level answers.
  {
    path: ".pi/smoke-cmd-timeout-ms",
    kind: "config",
    whenAbsent: "smoke tier uses PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS or its default",
  },
  { path: ".pi/smoke-cmd", kind: "command", whenAbsent: "no product smoke gate" },
  { path: ".pi/verify-cmd", kind: "command", whenAbsent: "verify command derived from the repo" },
  {
    path: ".pi/verify-cmd-fast",
    kind: "command",
    whenAbsent: "no fast verify tier",
  },
  {
    path: ".pi/verify-cmd-fast-timeout-ms",
    kind: "config",
    whenAbsent: "fast tier uses PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS or its default",
  },
  { path: ".pi/verify-cmd-full", kind: "command", whenAbsent: "verify-full tier skipped" },
  {
    path: ".pi/verify-timeout-ms",
    kind: "config",
    whenAbsent: "suite tier uses PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS or its default",
  },
  // The lean engine's own config, read at the run's base commit by
  // `loadWorkConfig` (src/lean/config.ts) — never the working tree, so a run
  // cannot be judged by bytes it wrote itself. Absent is the normal state: the
  // engine takes `defaultConfig`, whose shape the whenAbsent text states.
  // `test-headless-inputs.ts` judges this entry against the git reader rather
  // than the filesystem one, because that read goes through `git show`.
  {
    path: ".pi/work.json",
    kind: "config",
    whenAbsent:
      "lean defaults: no fast tier, the full tier from .pi/verify-cmd, no test runner, autoMerge false",
  },
  {
    path: ".pi/worktree-setup",
    kind: "hook",
    whenAbsent: "dependencies are symlinked into each worktree",
  },
];
