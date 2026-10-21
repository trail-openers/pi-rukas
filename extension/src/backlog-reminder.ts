/**
 * backlog-reminder — part A of #1730: a private-backlog reminder for the PM session.
 *
 * An operator who keeps their real priority order off-tracker clones a private
 * repository into `<repo>/.backlog/` and maintains `backlog.md` in it. When
 * that file is really there, the PM session is handed ONE short paragraph
 * telling it the backlog exists, where it is, and that its order is not the
 * agent's to change. Nothing else changes: with no `.backlog/` — or a
 * `.backlog/` that is not a clone, or no `backlog.md`, or a `backlog.md` that
 * is a symlink or a directory — nothing is appended, so every session's system
 * prompt is byte-identical to what it was before this module existed.
 *
 * What this module deliberately does NOT do:
 *
 *   - **It never reads the backlog's content.** Part B (the `/start` panel)
 *     renders it. Here the file is only *stated to exist* — `lstat` calls, no
 *     `readFile` — because a reminder costs a few dozen tokens whether the
 *     backlog holds three lines or three thousand, and reading it here would
 *     put private prose into every prompt built by code that has no business
 *     deciding whether to show it.
 *   - **It never runs git.** No `rev-parse --show-toplevel`, no `fetch`, no
 *     `status` against `.backlog/`. The repository root is found by walking the
 *     directory tree (see `repositoryRoot`), and the only thing this code does
 *     to the operator's clone is ask the OS what kind of thing a path is.
 *   - **It never throws, and never blocks a turn.** Every failure is the same
 *     answer as absence: the empty string. The whole probe — traces included —
 *     sits in one `try`, so a reminder that could break a session is not
 *     worth having.
 *   - **It only ever speaks to the PM.** `commands.ts` calls it from the
 *     `before_agent_start` handler, which already returns before doing anything
 *     unless PM mode is armed. Subagent children run `child-guards.ts`, never
 *     this handler, so no developer, explore, ops or reviewer prompt gains a
 *     line from this module.
 *
 * Two properties the first cut got wrong, and which are load-bearing here:
 *
 *   - **Probed per turn, not memoised.** A memoised answer is a stale answer:
 *     an operator who clones the backlog mid-session, or moves it away, should
 *     not have to restart Pi to be heard. What bounds the cost instead is a
 *     wall clock — the probe is raced against `PROBE_BUDGET_MS` and a probe
 *     that has not answered by then is treated as absent. A filesystem `lstat`
 *     on a healthy machine is microseconds, so the budget is a fence around a
 *     hung mount, not a cost saver.
 *   - **Provenance, not mere existence.** `#1730` is about the operator's
 *     *private clone*. A directory someone else committed called `.backlog`,
 *     and a `backlog.md` that is a symlink out of the tree, are neither of
 *     them that — so the clone marker must be present and the file must be a
 *     regular file, or the reminder stays silent.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";

/** Directory an operator clones their private backlog into, relative to the repository root. */
const BACKLOG_DIR = ".backlog";
/** The one file whose presence turns the reminder on. */
const BACKLOG_FILE = "backlog.md";
/** What makes `.backlog` the operator's clone rather than a directory with a familiar name. */
const GIT_MARKER = ".git";
/**
 * How long the probe may take before the turn stops waiting for it. A
 * `lstat` is microseconds; this only covers a hung or networked mount, and it
 * is why dropping the memo costs nothing measurable on a per-turn handler.
 */
const PROBE_BUDGET_MS = 250;
/** How far up from the session directory the repository root may be sought. */
const MAX_ROOT_HOPS = 50;

/**
 * The paragraph appended to the PM's instructions. Exported so the test can
 * assert this exact text landed exactly once rather than pattern-matching a
 * paraphrase — the "exactly once" half is the point (the handler appends per
 * turn, so an accidental second push would double the paragraph every turn).
 */
export const BACKLOG_REMINDER = `# Private backlog

This repository has a private backlog at \`.backlog/backlog.md\` (a separate git repository). Read it before choosing, proposing or starting work; its \`## Now (in order)\` list is the agreed order. Change the order only with the operator's explicit approval, by committing to that repository, never by editing the file without committing. Machine-filed issues go under Triage until promoted.`;

/**
 * The paragraph to append for this session, or `""` when there is no backlog
 * to speak of.
 *
 * Callers append the result only when non-empty, so the empty answer means the
 * system prompt comes out exactly as it did before this feature existed. Read
 * live on every call: `PI_ENSEMBLE_BACKLOG_REMINDER=0` is the operator's kill
 * switch and must take effect on the next turn, not the next process.
 */
export async function backlogReminderSection(sessionDir: string): Promise<string> {
  try {
    if (process.env.PI_ENSEMBLE_BACKLOG_REMINDER === "0") return "";
    return await withinBudget(probe(sessionDir), "");
  } catch (err) {
    // One trace for a fault that is NOT the ordinary "there is no backlog"
    // shape — `ENOENT`/`ENOTDIR` are that shape and stay silent. The trace is
    // itself guarded: a diagnostic that cannot be written is not a reason to
    // hand the caller a rejection it has to defend against.
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      try {
        trace(`backlog-reminder: probe of ${sessionDir} failed with ${code} — no reminder`);
      } catch {
        /* the reminder is silent, which is the only promise it has to keep */
      }
    }
    return "";
  }
}

/**
 * The probe proper: find the repository, then check the clone. Any error
 * escapes to `backlogReminderSection`, which is the only place that decides
 * what a failure is worth.
 */
async function probe(sessionDir: string): Promise<string> {
  const root = await repositoryRoot(sessionDir);
  if (!root) {
    trace(`backlog-reminder: no git repository at or above ${sessionDir} — no reminder`);
    return "";
  }
  const clone = path.join(root, BACKLOG_DIR);
  // A clone marker first. `.git` is a directory in a normal clone and a file in
  // a linked worktree; either says the operator cloned something here, while a
  // plain directory called `.backlog` says only that the name was taken.
  if (!(await exists(path.join(clone, GIT_MARKER)))) return "";
  // `lstat`, so a symlink reports as a symlink: a `backlog.md` that points out
  // of the clone is somebody else's file, and this paragraph tells the PM to
  // treat what it finds there as the agreed order.
  const stats = await fs.lstat(path.join(clone, BACKLOG_FILE));
  if (!stats.isFile()) return "";
  trace(`backlog-reminder: .backlog/backlog.md found under ${root} — PM paragraph appended`);
  return BACKLOG_REMINDER;
}

/**
 * The repository root a session was started in — found by walking up, not by
 * running git.
 *
 * The session directory is not the repository root: a `pi` launched inside
 * `extension/` must still see the `<toplevel>/.backlog` the operator cloned.
 * The walk is bounded (`MAX_ROOT_HOPS`) and stops where the path stops
 * changing, so a session under a deep tree or at `/` terminates rather than
 * stat-ing its way to the init directory. A `.git` that is a file counts —
 * that is a linked worktree, and it is still the operator's repository.
 */
async function repositoryRoot(sessionDir: string): Promise<string | undefined> {
  let dir = path.resolve(sessionDir);
  for (let hop = 0; hop < MAX_ROOT_HOPS; hop++) {
    if (await exists(path.join(dir, GIT_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  trace(`backlog-reminder: no repository within ${MAX_ROOT_HOPS} levels above ${sessionDir}`);
  return undefined;
}

/**
 * Is there anything at this path at all?
 *
 * `ENOENT`/`ENOTDIR` are "no" — the path simply is not there, which includes
 * a parent that turned out to be a file. Any other error (`EACCES` on the
 * operator's own clone, `EIO` on a dying disk) is not an answer about
 * existence, so it propagates and the caller names the code once.
 */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/**
 * `work`, or `fallback` if `work` has not answered within the probe budget.
 *
 * The timer is cleared whichever side wins, and the losing side is left to
 * settle on its own — a filesystem call that eventually returns after the turn
 * moved on changes nothing, and cancelling it would mean a handle nobody owns.
 */
async function withinBudget<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PROBE_BUDGET_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
