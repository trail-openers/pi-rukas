/**
 * work-driver-commit-hygiene — the driver's commit message is a publish, so the
 * driver checks it before it commits one (#1788 round 2, lens finding 6).
 *
 * `git commit` on its own leaks nothing: it writes to `.git/`. But the very next
 * thing the commit-pr step does is push the commit whose subject and body are
 * the two strings assembled in `work-driver-commit.ts`, and the `tool_call`
 * guard cannot see either of them — the message is composed in process and
 * reaches git inside `integrate()`'s own exec, so there is no shell command for
 * a hook to read. The driver therefore judges its own prose on the way in.
 *
 * It asks on the ONE seam every driver-authored publish uses
 * (`driverPublishCheck`), which resolves the target and applies the same
 * public-only rule the `tool_call` guard applies: a POSITIVE private answer
 * skips, and public, unknown, or a lookup that failed all check. That is the
 * whole reason this is a seam call rather than the pure text checker: a private
 * project must not be blocked from committing its own work.
 *
 * Extracted from `work-driver-commit.ts` because that file is at the 500-line
 * cap and this is a self-contained contract with its own failure message — the
 * split is along the concern, not at an arbitrary line.
 */

import { PublicHygieneError } from "./public-hygiene-config.ts";
import { driverPublicTextCheck, driverPublishCheck } from "./public-hygiene-driver.ts";
import type { VisibilityFn } from "./public-hygiene-visibility.ts";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/** A shell executor, matching the driver's `verifyExecFn`. */
type DriverExec = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Refuse a commit message that would publish private text, or return the
 * failure the commit-pr step should report.
 *
 * Returns `undefined` when the message may be committed — either it is clean,
 * or the target repository is positively private and the guard has no business
 * in a private repository's own commit messages.
 *
 * A refusal is returned as a REASON rather than thrown. The step routes on a
 * discriminated result, and a commit the guard refused is a commit that parks
 * with a reason the operator can act on, not an exception that escapes the
 * step. The reason names the fix: this message derives from the issue title and
 * body, so a private term in it is a private term in the ISSUE, and removing it
 * is an operator action, not something a retry can do.
 */
export async function commitMessageRefusal(
  title: string,
  body: string,
  opts: {
    /** Where `git commit` will run, so the target resolves from the right tree. */
    cwd: string;
    issue: number;
    exec: DriverExec;
    /** The repository root whose paths collapse to `<repo>`; defaults to `cwd`. */
    repoRoot?: string;
  },
): Promise<string | undefined> {
  return (await commitMessageForPublish(title, body, opts)).refusal;
}

/**
 * The commit message the driver should COMMIT, or the refusal.
 *
 * The commit-pr step composes the subject and body from the issue and the
 * workstream list, and the very next thing it does is push them. On the
 * public-or-unknown branch the seam rewrites the host's own paths out of that
 * message (`<repo>/…`, `~/…`), so the caller must commit the returned message
 * rather than the one it built: the message that was judged is the message that
 * goes out, and a message that still classifies after the rewrite is refused
 * exactly as `commitMessageRefusal` refuses it today.
 */
export async function commitMessageForPublish(
  title: string,
  body: string,
  opts: {
    cwd: string;
    issue: number;
    exec: DriverExec;
    /** The repository root; defaults to `cwd`. */
    repoRoot?: string;
    /** The home directory the `~` rewrite is relative to (a test seam). */
    homeDir?: string;
    /** The realpath seam that derives each root's second spelling (a test seam). */
    realpath?: (dir: string) => string;
  },
): Promise<{ refusal?: string; title: string; body: string; rewritten: boolean }> {
  const checked = await driverPublishCheck("commit message", `${title}\n${body}`, {
    command: "git commit",
    cwd: opts.cwd,
    repoRoot: opts.repoRoot ?? opts.cwd,
    homeDir: opts.homeDir,
    realpath: opts.realpath,
    exec: opts.exec as unknown as ExecFn,
  });
  // A conventional-commit subject is one line and the body follows it, so the
  // checked text splits back into the same two git arguments. The split is on
  // the FIRST newline of the CHECKED text, which is where the original newline
  // still is: the rewrite never introduces a newline.
  const nl = checked.text.indexOf("\n");
  const split = nl < 0 ? checked.text.length : nl;
  const parts = {
    title: checked.text.slice(0, split),
    body: checked.text.slice(nl < 0 ? checked.text.length : nl + 1),
    rewritten: checked.rewritten,
  };
  if (checked.refusal !== undefined) {
    const refusal = checked.refusal;
    trace(`work-driver: commit message refused for #${opts.issue}: ${refusal.slice(0, 160)}`);
    return {
      refusal: `${refusal} The commit message is derived from the issue title and body — remove the private term from the issue and restart the cycle.`,
      ...parts,
    };
  }
  return parts;
}

/**
 * The check a forge adapter runs before it posts text it composed itself
 * (#1788 round 2), extracted from `forge.ts` because that file is at the 500-line
 * cap and this is the same contract as the commit-message check above: driver
 * prose, judged on the one driver seam, against the same public-only rule.
 *
 * THROWS `PublicHygieneError` rather than returning a reason, because the
 * adapter's callers already have that error type in their handling
 * (`plan-filing.ts` and `work-driver-commit.ts` report a failed forge write), and
 * the merge path converts it back into its own `{ ok: false, reason }` shape.
 *
 * `target` is the adapter's own slug where it has one, so no command string has
 * to be parsed to work out which repository a `gh pr create` writes to.
 * `timeoutMs` is the bound the adapter was built with: the visibility question is
 * one `gh` call, and inheriting the guard's default while the adapter's own execs
 * time out sooner would make the gate the slowest thing on the path.
 */
export async function forgePublishCheck(
  label: string,
  text: string,
  command: string,
  opts: {
    cwd: string;
    exec: ExecFn;
    visibility?: VisibilityFn;
    target?: { owner: string; repo: string; host?: string };
    timeoutMs?: number;
    /** The repository root whose paths collapse to `<repo>`; defaults to `cwd`. */
    repoRoot?: string;
    /** The home directory the `~` rewrite is relative to (a test seam). */
    homeDir?: string;
    /** The realpath seam that derives each root's second spelling (a test seam). */
    realpath?: (dir: string) => string;
  },
): Promise<{ text: string; rewritten: boolean }> {
  const checked = await driverPublicTextCheck(label, text, command, opts.cwd, {
    exec: opts.exec,
    visibility: opts.visibility,
    target: opts.target,
    timeoutMs: opts.timeoutMs,
    repoRoot: opts.repoRoot,
    homeDir: opts.homeDir,
    realpath: opts.realpath,
  });
  if (checked.refusal !== undefined) throw new PublicHygieneError(checked.refusal);
  return { text: checked.text, rewritten: checked.rewritten };
}
