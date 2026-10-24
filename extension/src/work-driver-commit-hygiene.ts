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
 * (`driverPublishRefusal`), which resolves the target and applies the same
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
import { driverPublicTextRefusal, driverPublishRefusal } from "./public-hygiene-driver.ts";
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
  },
): Promise<string | undefined> {
  const refusal = await driverPublishRefusal("commit message", `${title}\n${body}`, {
    command: "git commit",
    cwd: opts.cwd,
    // The driver's executor and the guard's differ only in optionality of the
    // options bag; the seam passes it straight through to the reads it makes.
    exec: opts.exec as unknown as ExecFn,
  });
  if (refusal === undefined) return undefined;
  trace(`work-driver: commit message refused for #${opts.issue}: ${refusal.slice(0, 160)}`);
  return `${refusal} The commit message is derived from the issue title and body — remove the private term from the issue and restart the cycle.`;
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
export async function forgePublishRefusal(
  label: string,
  text: string,
  command: string,
  opts: {
    cwd: string;
    exec: ExecFn;
    visibility?: VisibilityFn;
    target?: { owner: string; repo: string; host?: string };
    timeoutMs?: number;
  },
): Promise<void> {
  const refusal = await driverPublicTextRefusal(label, text, command, opts.cwd, {
    exec: opts.exec,
    visibility: opts.visibility,
    target: opts.target,
    timeoutMs: opts.timeoutMs,
  });
  if (refusal !== undefined) throw new PublicHygieneError(refusal);
}
