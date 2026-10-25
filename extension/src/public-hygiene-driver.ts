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

import { execp } from "./exec.ts";
import { type Target, isRepoTarget, resolveCommandTarget } from "./public-hygiene-target.ts";
import { publicTextRefusal } from "./public-hygiene-text.ts";
import {
  type RepoTarget,
  type VisibilityFn,
  ghVisibility,
  isPrivateTarget,
} from "./public-hygiene-visibility.ts";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The ONE entry point every driver-authored publish calls.
 *
 * `driverPublicTextRefusal` takes the command string and the directory because
 * that is what a caller whose only knowledge of its target is a `gh` invocation
 * has. Most call sites know more than that — a forge adapter knows its owner,
 * repo and host; a driver step knows its worktree — and an options bag is what
 * lets them say so without each site re-deriving a target from a command string
 * it already understood. Every site ends up here, so every site honours the same
 * public-only gate and none can reach the pure `publicTextRefusal` directly and
 * skip it, which is exactly what the two unconditional call sites this replaced
 * did (#1788 round 2): the forge adapter's `checkPublicText` and the direct-exec
 * merge-subject check both checked every repository, including private ones.
 */
export async function driverPublishRefusal(
  label: string,
  text: string,
  opts: {
    /** The command form the caller is about to run — a locator, never text. */
    command: string;
    /** The directory it runs in. */
    cwd: string;
    exec?: ExecFn;
    visibility?: VisibilityFn;
    /** A target the caller already knows (the forge slug); skips resolution. */
    target?: Target;
    /** Bound on the visibility question; see `driverPublicTextRefusal`. */
    timeoutMs?: number;
  },
): Promise<string | undefined> {
  return driverPublicTextRefusal(label, text, opts.command, opts.cwd, {
    exec: opts.exec,
    visibility: opts.visibility,
    target: opts.target,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * The refusal for a driver-authored public text, or `undefined` when the text is
 * clean or its repository is positively private.
 *
 * `command` is the shell/argv form the caller is about to run, used only to
 * locate the target repository (a `-R` flag, an api endpoint, the cwd's origin)
 * — never as text to scan. The text itself is judged by the same pure matcher
 * the tool_call guard uses, so driver and agent cannot disagree about what is
 * publishable.
 *
 * Prefer `driverPublishRefusal` at a new call site; this is what it delegates to.
 */
export async function driverPublicTextRefusal(
  label: string,
  text: string,
  command: string,
  cwd: string,
  opts: { exec?: ExecFn; visibility?: VisibilityFn; target?: Target; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const target = opts.target ?? (await resolveTarget(command, cwd, opts));
  if (target !== undefined && isRepoTarget(target)) {
    const isPrivate = await isPrivateTarget(target, {
      // The injected resolver answers for any host. Without this the stub a
      // caller passes would be handed to `gh` only for a github.com target, and
      // a target whose host came from anywhere else would be reported public
      // without the caller's own resolver ever being consulted — a "we asked"
      // trace covering a lookup that never happened.
      lookup: opts.visibility ?? ((t) => defaultVisibility(t, opts)),
      // The caller's bound, when it has one. A forge adapter already knows how
      // long it is willing to wait for one command; the visibility question is
      // one command, and inheriting a 10 s default while the adapter's own execs
      // time out at 50 ms would make the gate the slowest thing on the path.
      timeoutMs: opts.timeoutMs,
    }).catch(() => false);
    if (isPrivate) {
      trace(`public-hygiene: driver ${label} skipped — the target repository is private`);
      return undefined;
    }
  }
  return publicTextRefusal(label, text);
}

/**
 * The default visibility resolver for a driver post: `gh`, through whatever
 * executor this call was given. No executor means no question is asked, and
 * `isPrivateTarget` treats the resulting failure as "check".
 */
function defaultVisibility(t: RepoTarget, opts: { exec?: ExecFn; cwd?: string }): Promise<boolean> {
  return ghVisibility(t, opts.exec ?? execp, opts.cwd ?? ".");
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
