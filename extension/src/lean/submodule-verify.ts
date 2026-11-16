/**
 * lean/submodule-verify — the two ways this step checks its own work, both of which are
 * allowed to be WRONG in only one direction: towards refusing the run.
 *
 * A seeding that reported success without looking is the failure mode this step exists to
 * avoid — the field report was a run that “initialised” its submodules and then tested
 * against an empty `vendor/` directory. So both checks are deliberately pessimistic: an
 * unreadable answer counts as a problem, never as an absence of one.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Whether the tree at `sub` holds `file`, as far as the step is allowed to care.
 *
 * A plain existence check inside the worktree, and the reason it is a function rather than
 * an inline `existsSync` is the `catch`: a path the platform refuses (`ENAMETOOLONG`, an
 * IO error) must not read as "the submodule is empty" — that would throw the run away on a
 * stat failure. But neither may it read as "fine": a step that cannot look is not entitled
 * to call a submodule empty, so the pessimistic answer is `true`, which keeps the note
 * alive and lets the reset's own proof decide.
 */
export function checkoutHolds(wt: string, sub: string, file: string): boolean {
  try {
    return existsSync(path.join(wt, sub, file));
  } catch {
    return true;
  }
}

/**
 * The three places a rejected child's reason can live, in the release's own order. `execp`
 * rejects with an error carrying whatever the child wrote, and the handback an operator reads
 * has to contain it: a `submodule update` that failed because git could not reach a URL says so
 * on stderr, and dropping that line leaves no way to tell a dead network from a broken base.
 */
export function describe(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [e.stdout, e.stderr, e.message]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
}
