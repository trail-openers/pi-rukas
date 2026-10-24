/**
 * public-hygiene-driver — the public-text check for the driver's OWN in-process
 * publishes (#1788 round 1).
 *
 * The `tool_call` hook cannot see these: a driver write is an in-process exec
 * (`execFn("gh", …)` / `execp(…)`), never a bash tool call, so the guard that
 * refuses an agent's `gh pr edit --body-file` has no chance to. `forge.ts`'s
 * `checkPublicText` covers the writes that go through the forge adapter; this
 * module covers the ones that do not — today the ci tier's disclosure write,
 * which composes a PR body from test names and the cycle's own prose and hands
 * it straight to `gh pr edit`.
 *
 * Public repositories only, by the same rule as everywhere else (#1788 round
 * 1): the repository a driver post targets is resolved first, and a positive
 * private answer skips the check. The resolution never throws — it is a read,
 * and a read that fails means "check", not "let it through".
 *
 * `visibility` is the seam that keeps the offline suite off the network; when a
 * caller supplies neither it nor an executor, no lookup is made and the text is
 * checked, which is the same outcome as a failed lookup.
 */

import { type Target, isRepoTarget, resolveCommandTarget } from "./public-hygiene-target.ts";
import { publicTextRefusal } from "./public-hygiene-text.ts";
import { type VisibilityFn, isPrivateTarget } from "./public-hygiene-visibility.ts";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The refusal for a driver-authored public text, or `undefined` when the text
 * is clean or its repository is positively private.
 *
 * `command` is the shell/argv form the caller is about to run, used only to
 * locate the target repository (a `-R` flag, an api endpoint, the cwd's origin)
 * — never as text to scan. The text itself is judged by the same pure matcher
 * the tool_call guard uses, so driver and agent cannot disagree about what is
 * publishable.
 */
export async function driverPublicTextRefusal(
  label: string,
  text: string,
  command: string,
  cwd: string,
  opts: { exec?: ExecFn; visibility?: VisibilityFn; target?: Target } = {},
): Promise<string | undefined> {
  const target = opts.target ?? (await resolveTarget(command, cwd, opts));
  if (target !== undefined && isRepoTarget(target)) {
    const isPrivate = await isPrivateTarget(target, {
      lookup: opts.visibility,
    }).catch(() => false);
    if (isPrivate) {
      trace(`public-hygiene: driver ${label} skipped — the target repository is private`);
      return undefined;
    }
  }
  return publicTextRefusal(label, text);
}

/** The driver post's repository, or undefined when nothing can name it. */
async function resolveTarget(
  command: string,
  cwd: string,
  opts: { exec?: ExecFn; visibility?: VisibilityFn },
): Promise<Target | undefined> {
  if (opts.exec === undefined) return undefined;
  try {
    return await resolveCommandTarget(command, cwd, opts.exec, {});
  } catch (err) {
    // A target this module could not name is a target it must check, and the
    // trace says only which transport broke — never a path or a repository name
    // that might itself be the private thing.
    const code = (err as { code?: unknown })?.code;
    trace(
      `public-hygiene: driver target unresolved (${typeof code === "string" ? code : "error"}) — checking`,
    );
    return undefined;
  }
}
