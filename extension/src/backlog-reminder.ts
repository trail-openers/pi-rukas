/**
 * backlog-reminder — part A of #1730: a private-backlog reminder for the PM session.
 *
 * An operator who keeps their real priority order off-tracker clones a private
 * repository into `<repo>/.backlog/` and maintains `backlog.md` in it. When that
 * file exists, the PM session is handed ONE short paragraph telling it the
 * backlog exists, where it is, and that its order is not the agent's to change.
 * Nothing else changes: with no `.backlog/` — or a `.backlog/` with no
 * `backlog.md`, or a `.backlog` that is a plain file — nothing is appended, so
 * every session's system prompt is byte-identical to what it was before this
 * module existed.
 *
 * What this module deliberately does NOT do:
 *
 *   - **It never reads the backlog's content.** Part B (the `/start` panel)
 *     renders it. Here the file is only *stated to exist* — one `fs.stat`, no
 *     `readFile` — because a reminder costs a few dozen tokens whether the
 *     backlog holds three lines or three thousand, and reading it here would
 *     put private prose into every prompt built by code that has no business
 *     deciding whether to show it.
 *   - **It never runs git.** No `rev-parse --show-toplevel`, no `fetch`, no
 *     `status` against `.backlog/`. The `.backlog/` tree is a separate clone
 *     the operator owns; the only thing this code does to it is ask the OS
 *     whether a path is a file.
 *   - **It never throws, and never blocks a turn.** Every failure — ENOENT,
 *     ENOTDIR (`.backlog` is a file), EACCES, an unreadable parent — is the
 *     same answer as absence: the empty string. A reminder that can break a
 *     session is not worth having, and the case where it is wrong (a permission
 *     problem on the operator's own clone) is theirs to notice, not ours to
 *     report by failing.
 *   - **It only ever speaks to the PM.** `commands.ts` calls it from the
 *     `before_agent_start` handler, which already returns before doing anything
 *     unless PM mode is armed. Subagent children run `child-guards.ts`, never
 *     this handler, so no developer, explore, ops or reviewer prompt gains a
 *     line from this module.
 *
 * The probe runs **once per session**: the result is memoised by the session
 * directory it was taken for, so the per-turn handler does not re-stat the
 * filesystem on every PM turn. Keying on the directory (rather than one global
 * slot) is what lets a test drive two different temp repos through one
 * module instance without a reset hook.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";

/** Directory an operator clones their private backlog into, relative to the repo. */
const BACKLOG_DIR = ".backlog";
/** The one file whose presence turns the reminder on. */
const BACKLOG_FILE = "backlog.md";

/**
 * The paragraph appended to the PM's instructions. Exported so the test can
 * assert this exact text landed exactly once rather than pattern-matching a
 * paraphrase — the "exactly once" half is the point (the handler appends per
 * turn, so an accidental second push would double the paragraph every turn).
 */
export const BACKLOG_REMINDER = `# Private backlog

This repository has a private backlog at \`.backlog/backlog.md\` (a separate git repository). Read it before choosing, proposing or starting work; its \`## Now (in order)\` list is the agreed order. Change the order only with the operator's explicit approval, by committing to that repository, never by editing the file without committing. Machine-filed issues go under Triage until promoted.`;

/**
 * Memoised probes, keyed by the session directory they were taken for. A
 * session has one directory, so this holds one entry in production; the map
 * shape exists so tests (and a resumed session under a different root) do not
 * need a reset.
 */
const probes = new Map<string, Promise<string>>();

/**
 * The paragraph to append for this session, or `""` when there is no backlog.
 *
 * Callers append the result only when non-empty, so the empty answer means the
 * system prompt comes out exactly as it did before this feature existed.
 */
export function backlogReminderSection(repoRoot: string): Promise<string> {
  const cached = probes.get(repoRoot);
  if (cached) return cached;
  const probe = probeBacklog(repoRoot);
  probes.set(repoRoot, probe);
  return probe;
}

/**
 * One `fs.stat`, every error path collapsed to the empty string.
 *
 * `isFile()` rather than `exists()`: a directory or socket named
 * `backlog.md` is not a backlog an operator is maintaining, and treating one
 * as such would remind the PM to read something that is not prose. A
 * `.backlog` that is itself a plain file makes this stat fail with `ENOTDIR`,
 * which is the same silent no-op.
 */
async function probeBacklog(repoRoot: string): Promise<string> {
  try {
    const target = path.join(repoRoot, BACKLOG_DIR, BACKLOG_FILE);
    const stats = await fs.stat(target);
    if (!stats.isFile()) return "";
  } catch {
    return "";
  }
  trace(`backlog-reminder: .backlog/backlog.md found under ${repoRoot} — PM paragraph appended`);
  return BACKLOG_REMINDER;
}
