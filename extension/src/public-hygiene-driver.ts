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
 *
 * ## The seam also REWRITES, and the caller publishes what it returns
 *
 * On the public-or-unknown branch — after the positive-private early return, so
 * a private repository's own prose is never rewritten and never checked — the
 * text's host paths are normalised (`public-hygiene-normalise.ts`): anything
 * under the repository root becomes `<repo>/…` and anything under the CURRENT
 * user's home becomes `~/…`. The CHECK then judges the rewritten text and the
 * caller publishes the same bytes, so "what was judged" and "what was posted"
 * are one string. That is why this seam returns the text rather than only a
 * refusal: a caller that discarded the returned text would post bytes nobody
 * judged. `PI_ENSEMBLE_PUBLIC_HYGIENE=0` disables the check and the rewrite
 * together — the same off switch governs both, so a disabled guard cannot leave
 * a half-applied rewrite that no check was run against.
 */

import { execp } from "./exec.ts";
import { hygieneGuardDisabled } from "./public-hygiene-config.ts";
import { type NormaliseResult, normaliseDriverPublishPaths } from "./public-hygiene-normalise.ts";
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
export interface DriverPublishCheck {
  /** The refusal, or `undefined` when the (rewritten) text may be published. */
  refusal?: string;
  /** The bytes the caller must publish — the judged text, not the input. */
  text: string;
  /** True when a host path was rewritten out of the text. */
  rewritten: boolean;
}

/** Nothing to refuse; the caller publishes the text the seam hands back. */
function checked(text: string, rewritten: boolean): DriverPublishCheck {
  return { text, rewritten };
}

/**
 * The full decision for a driver-authored publish: what to refuse, what to
 * publish, and whether the bytes differ from what the caller composed.
 *
 * `driverPublicTextCheck`'s one entry point. A caller that publishes the text
 * itself — a body file, a commit message, a merge subject — calls this and
 * writes `text` back. `driverPublishRefusal` is the refusal-only projection for
 * a caller whose text is already normalised at its render site.
 */
export async function driverPublishCheck(
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
    /** The repository root whose paths collapse to `<repo>`; defaults to `cwd`. */
    repoRoot?: string;
    /** This cycle's worktree, when the publish composes from one. */
    worktreePath?: string;
    /**
     * The home directory the `~` rewrite is relative to. Production leaves it
     * out and the current user's home answers; the offline suite builds its own
     * scratch home so no test rewrites (or reads) the host's.
     */
    homeDir?: string;
    /** The realpath seam that derives each root's second spelling. */
    realpath?: (dir: string) => string;
  },
): Promise<DriverPublishCheck> {
  return driverPublicTextCheck(label, text, opts.command, opts.cwd, {
    exec: opts.exec,
    visibility: opts.visibility,
    target: opts.target,
    timeoutMs: opts.timeoutMs,
    repoRoot: opts.repoRoot,
    worktreePath: opts.worktreePath,
    homeDir: opts.homeDir,
    realpath: opts.realpath,
  });
}

/**
 * The refusal for a driver-authored public text, discarding the rewrite.
 *
 * For a caller that publishes text it has ALREADY normalised (the handoff body
 * goes through `normaliseDriverPublishPaths` at its render site, and the file on
 * disk must stay the bytes the seam judged). A new call site wants
 * `driverPublishCheck`, which hands back the bytes to publish.
 */
export async function driverPublishRefusal(
  label: string,
  text: string,
  opts: Parameters<typeof driverPublishCheck>[2],
): Promise<string | undefined> {
  return (await driverPublishCheck(label, text, opts)).refusal;
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
/** What a caller may pin about the target and the roots the rewrite collapses. */
export interface DriverTextCheckOpts {
  exec?: ExecFn;
  visibility?: VisibilityFn;
  target?: Target;
  timeoutMs?: number;
  /** The repository root whose paths collapse to `<repo>`; defaults to `cwd`. */
  repoRoot?: string;
  /** This cycle's worktree, when the publish composes from one. */
  worktreePath?: string;
  /** The home directory the `~` rewrite is relative to (a test seam). */
  homeDir?: string;
  /** The realpath seam that derives each root's second spelling (a test seam). */
  realpath?: (dir: string) => string;
}

export async function driverPublicTextCheck(
  label: string,
  text: string,
  command: string,
  cwd: string,
  opts: DriverTextCheckOpts = {},
): Promise<DriverPublishCheck> {
  // The off switch disables the check AND the rewrite: a rewrite that ran
  // against no check would be a silent content change in a disabled guard.
  if (hygieneGuardDisabled()) return checked(text, false);
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
      // A private repository keeps its exact paths: nothing is published, so
      // there is nothing to normalise, and an operator reading a private repo's
      // own comment wants the real path.
      trace(`public-hygiene: driver ${label} skipped — the target repository is private`);
      return checked(text, false);
    }
  }
  const normalised = normaliseDriverPublishPaths(text, {
    repoRoot: opts.repoRoot ?? cwd,
    worktreePath: opts.worktreePath,
    homeDir: opts.homeDir,
    realpath: opts.realpath,
  });
  if (normalised.rewritten) {
    // The trace names the KINDS of root replaced and never a path: a path is
    // the thing this module exists to keep out of a public body, and a trace
    // line reaches the run transcript.
    trace(`public-hygiene: driver ${label} — paths normalised (${normalised.kinds.join(", ")})`);
  }
  const refusal = publicTextRefusal(label, normalised.text);
  return refusal === undefined
    ? checked(normalised.text, normalised.rewritten)
    : { refusal, text: normalised.text, rewritten: normalised.rewritten };
}

/**
 * The refusal for a driver-authored public text, or `undefined` when the text is
 * clean or its repository is positively private. Discards the rewrite; see
 * `driverPublicTextCheck`.
 */
export async function driverPublicTextRefusal(
  label: string,
  text: string,
  command: string,
  cwd: string,
  opts: DriverTextCheckOpts = {},
): Promise<string | undefined> {
  return (await driverPublicTextCheck(label, text, command, cwd, opts)).refusal;
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
