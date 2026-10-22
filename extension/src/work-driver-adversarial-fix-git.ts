/**
 * work-driver-adversarial-fix-git — the git reads the adversarial fix pass
 * stands on (#1114). Every read returns a result, never a silent empty value:
 * a tree, base or HEAD that cannot be read is a park reason for the pass, not
 * "nothing changed". Split from work-driver-adversarial-fix.ts (AGENTS.md §12).
 */

import { execp } from "./exec.ts";
import type { DriverContext } from "./work-driver-context.ts";

export type FixExec = NonNullable<DriverContext["verifyExecFn"]> | typeof execp;
/** The shell-string executor, used when the driver supplies no `verifyExecFn`. */
export const defaultExec: FixExec = execp;

export type GitRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** What a worktree holds relative to a commit: changed names, the diff, untracked files. */
export interface TreeChanges {
  names: string[];
  diff: string;
  untracked: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * #1698 — the bound on the fix pass's OWN git reads.
 *
 * These are `rev-parse`, `ls-tree` and `diff --name-only`: milliseconds-scale
 * commands. They were first bounded by `verifyTimeoutMs()`, a 10-minute number
 * that belongs to the project's verify command, so a hung read stalled a whole
 * fix pass for ten minutes before anyone could say so. A bound that is 20× the
 * worst case is not a bound, and it is the wrong knob for an operator to turn.
 * The verify tiers keep their own budgets in work-driver-verify-budget.ts; this
 * is the fence's, and it is deliberately a separate constant.
 */
export const GIT_READ_TIMEOUT_MS = 30_000;

/** The bound every fix-pass git read runs under unless the caller overrides it. */
export function gitReadTimeoutMs(): number {
  return GIT_READ_TIMEOUT_MS;
}

async function run(
  execFn: FixExec,
  cmd: string,
  cwd: string,
  timeoutMs?: number,
): Promise<GitRead<string>> {
  try {
    const { stdout } = await execFn(cmd, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    return { ok: true, value: stdout };
  } catch (err) {
    const why = (err as Error).message?.slice(0, 200) ?? String(err);
    return { ok: false, reason: `\`${cmd}\` failed in ${cwd}: ${why}` };
  }
}

const lines = (s: string): string[] => s.split("\n").filter(Boolean);

/** The files tracked at the cycle's base commit. */
export async function trackedPaths(
  execFn: FixExec,
  repoRoot: string,
  baseSha: string | undefined,
): Promise<GitRead<string[]>> {
  if (!baseSha || !SHA_RE.test(baseSha)) {
    return { ok: false, reason: "no valid base SHA is recorded" };
  }
  const r = await run(execFn, `git ls-tree -r --name-only ${baseSha}`, repoRoot);
  return r.ok ? { ok: true, value: lines(r.value) } : r;
}

/**
 * What this cycle already committed between its base and `headSha`: the files
 * its earlier develop rounds changed, INCLUDING files a commit created. Unlike
 * `trackedPaths` (the tree AT base) this sees a file the cycle itself made —
 * #1698: a file the cycle created is never tracked at base, so without this
 * read no finding could ever authorise a fix pass touching it.
 */
export async function committedChanges(
  execFn: FixExec,
  cwd: string,
  baseSha: string,
  headSha: string,
  timeoutMs?: number,
): Promise<GitRead<string[]>> {
  // Named, not "the commits": an operator reading the park has to know which
  // of the two the fence was given was the unusable one, and 12 chars is
  // enough to recognise it in `git log` without dumping a full SHA.
  if (!SHA_RE.test(baseSha)) return notSha("base", baseSha);
  if (!SHA_RE.test(headSha)) return notSha("head", headSha);
  // --no-renames for the same reason `treeChanges` gives: a rename must not
  // hide the source side of a move.
  const r = await run(
    execFn,
    `git diff --name-only --no-renames ${baseSha}..${headSha}`,
    cwd,
    timeoutMs,
  );
  return r.ok ? { ok: true, value: lines(r.value) } : r;
}

/**
 * The one refusal shape for a non-SHA commit argument.
 *
 * `value` comes from driver state, and a state file is a hand-editable file:
 * the field can hold arbitrary text, and this reason is interpolated into a
 * park reason an operator reads — possibly through a terminal. Only a token
 * made of path/SHA-safe characters is echoed, and only its first 12; anything
 * else is reported by shape (`<non-hex, N chars>`), never by content.
 */
const ECHO_SAFE = /^[0-9a-zA-Z._/-]+$/;
function notSha(which: "base" | "head", value: string): GitRead<never> {
  const head = value.slice(0, 12);
  const shown = ECHO_SAFE.test(head) ? `${head}…` : `<non-hex, ${value.length} chars>`;
  return { ok: false, reason: `the ${which} commit is not a SHA: ${shown}` };
}

/** The commit a worktree's HEAD points at. */
export async function headOf(
  execFn: FixExec,
  cwd: string,
  timeoutMs?: number,
): Promise<GitRead<string>> {
  const r = await run(execFn, "git rev-parse HEAD", cwd, timeoutMs);
  if (!r.ok) return r;
  const sha = r.value.trim();
  return SHA_RE.test(sha)
    ? { ok: true, value: sha }
    : { ok: false, reason: "HEAD is not a commit" };
}

/**
 * What a worktree holds relative to `sha`: committed and uncommitted changes
 * to tracked files, plus untracked files. Any failing read fails the whole.
 */
export async function treeChanges(
  execFn: FixExec,
  cwd: string,
  sha: string,
): Promise<GitRead<TreeChanges>> {
  if (!SHA_RE.test(sha)) return { ok: false, reason: "the comparison commit is not a SHA" };
  // --no-renames: a rename lists its source too, so a move from an out-of-fence
  // path onto a declared one cannot pass the fence by naming only the new side.
  const names = await run(execFn, `git diff --name-only --no-renames ${sha}`, cwd);
  if (!names.ok) return names;
  const diff = await run(execFn, `git diff ${sha}`, cwd);
  if (!diff.ok) return diff;
  const untracked = await run(execFn, "git ls-files --others --exclude-standard", cwd);
  if (!untracked.ok) return untracked;
  const extra = lines(untracked.value);
  return {
    ok: true,
    value: {
      names: [...new Set([...lines(names.value), ...extra])],
      diff: diff.value,
      untracked: extra,
    },
  };
}
