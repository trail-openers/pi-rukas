/**
 * adversarial-fix-guard — the tool-path fence around a fix round (#1104).
 *
 * A fix-developer edits files. The tool path sets `fixFence` (its calling
 * repository) at the tool boundary; the /work driver never does, so this module
 * is inert for it. With a fence, the fix rounds are kept inside workCwd:
 *   1. workCwd must be a worktree of the caller's repository (the same
 *      `--git-common-dir`), checked once, before the first fix round. Otherwise
 *      the round is refused as `invalid-input`. Only `rev-parse` runs against
 *      workCwd — its status and content are never read.
 *   2. around each fix round the caller repository's dirty state is snapshotted
 *      (`git status --porcelain -z -uall`; regular files are content-hashed).
 *      Any change is a `violation` record, which fails the result. A snapshot
 *      that cannot be read is never "clean": the round is refused before it runs,
 *      or a violation is recorded after it. Either way the result is not
 *      approved (`withFixViolations`).
 *   A caller that was never a git repository gets a `note` and no snapshots.
 *
 * Coverage limits, by design: gitignored paths are not covered (status skips
 * them); directories (nested repositories, submodules) and symlinks are
 * reported by name and kind, never by content; only regular files are hashed.
 * Attribution is not verified: any caller-repo change during a round is
 * reported, whoever made it. Writes to paths outside the caller repository are
 * not detected.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { execp } from "./lens-exec.ts";
import type { DispatchResult } from "./types.ts";
import { type ExecFn, resolvePath } from "./worktree.ts";

/** One fence finding. `text` is the body; `renderFenceRecords` adds the label and round. */
export type FenceRecord = {
  kind: "violation" | "note";
  round: number;
  text: string;
};

/** The tool path's fence option: the calling repository the fix rounds must not touch. */
export type FixFence = { callerCwd: string };

/** The outcome of a fix round the fence did not run (no developer was dispatched). */
export type FencedRound<T> =
  | { ran: true; value: T }
  | { ran: false; outcome: "invalid-input" | "infra-failure"; reason: string };

type Identity =
  | { kind: "repo"; top: string; commonDir: string }
  | { kind: "not-repo" }
  | { kind: "unreadable"; reason: string };

type Snapshot =
  | { kind: "repo"; entries: string[] }
  | { kind: "not-repo" }
  | { kind: "unreadable"; reason: string };

/** How the fence applies to this run, resolved once, before the first fix round. */
type Mode =
  | { kind: "off" }
  | { kind: "note"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "check"; callerCwd: string; callerTop: string; workTop: string };

/** Hash at most this many paths per `git hash-object` call (keeps argv far below ARG_MAX). */
const HASH_BATCH = 200;

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).trim().split("\n").at(-1) ?? "unknown error";

/** Classify on the full message: git's "not a git repository" line is not always the last. */
const isNotRepo = (err: unknown): boolean =>
  /not a git repository/i.test(err instanceof Error ? err.message : String(err));

/** One rev-parse call: the worktree toplevel and the shared git dir (no status, no content). */
async function identify(cwd: string, exec: ExecFn): Promise<Identity> {
  try {
    const out = (
      await exec("git", {
        argv: ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
        cwd,
      })
    ).stdout
      .trim()
      .split("\n");
    if (out.length !== 2 || !out[0] || !out[1]) {
      return { kind: "unreadable", reason: "unexpected rev-parse output" };
    }
    return {
      kind: "repo",
      top: resolvePath(out[0]),
      commonDir: resolvePath(out[1]),
    };
  } catch (err) {
    return isNotRepo(err) ? { kind: "not-repo" } : { kind: "unreadable", reason: errorText(err) };
  }
}

/** The status column pair marks a deleted path: it has no content to hash. */
const isDeleted = (line: string): boolean => line.slice(0, 2).includes("D");

/**
 * What a live path is for the snapshot. Only regular files are hashed; a path
 * that vanished between `status` and this read is `gone`. Any other lstat
 * failure throws, so the snapshot is unreadable rather than silently partial.
 */
async function kindOf(abs: string): Promise<"file" | "dir" | "link" | "other" | "gone"> {
  try {
    const st = await lstat(abs);
    if (st.isFile()) return "file";
    if (st.isDirectory()) return "dir";
    if (st.isSymbolicLink()) return "link";
    return "other";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw err;
  }
}

/**
 * Snapshot the caller repository's dirty state. Argv form throughout (no shell),
 * so a path name is never re-parsed. Porcelain status records path and state,
 * not content, so a write to an already-dirty file leaves the status line
 * unchanged; the content hashes catch that. All regular files are hashed in
 * batched `hash-object` calls. Any failure is `unreadable`, never a marker.
 */
async function snapshotCaller(cwd: string, exec: ExecFn): Promise<Snapshot> {
  const id = await identify(cwd, exec);
  if (id.kind !== "repo") return id;
  try {
    // -z: NUL-separated, unquoted paths; -uall: every untracked file, not its dir.
    const parts = (
      await exec("git", {
        argv: ["status", "--porcelain", "-z", "-uall"],
        cwd: id.top,
      })
    ).stdout
      .split("\0")
      .filter(Boolean);
    const records: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (line === undefined) break;
      // A rename/copy record is followed by its origin path, which is not a record.
      if (/[RC]/.test(line.slice(0, 2))) i++;
      records.push(line);
    }
    const live = records.filter((line) => !isDeleted(line));
    const kinds = await Promise.all(live.map((line) => kindOf(path.join(id.top, line.slice(3)))));
    const files = live.filter((_, i) => kinds[i] === "file").map((line) => line.slice(3));
    const hashes: string[] = [];
    for (let i = 0; i < files.length; i += HASH_BATCH) {
      const batch = files.slice(i, i + HASH_BATCH);
      const out = (
        await exec("git", {
          argv: ["hash-object", "--", ...batch],
          cwd: id.top,
        })
      ).stdout;
      hashes.push(...out.split("\n").filter(Boolean));
    }
    if (hashes.length !== files.length) {
      throw new Error(`hash-object returned ${hashes.length} ids for ${files.length} files`);
    }
    let k = 0;
    let h = 0;
    const entries = records.map((line) => {
      if (isDeleted(line)) return `${line}\tdeleted`;
      const kind = kinds[k++];
      return kind === "file" ? `${line}\t${hashes[h++]}` : `${line}\t${kind}`;
    });
    return { kind: "repo", entries };
  } catch (err) {
    return { kind: "unreadable", reason: errorText(err) };
  }
}

const describe = (s: Snapshot): string =>
  s.kind === "repo"
    ? "readable"
    : s.kind === "not-repo"
      ? "caller is no longer a repository"
      : s.reason;

/**
 * Resolve the fence once, before the first fix round. An unreadable caller
 * refuses the round (a "not checked" fence never approves). A caller that was
 * never a repository is a note. A workCwd that is not a worktree of the caller's
 * repository is invalid input. A workCwd that IS the caller's worktree has
 * nothing outside it to fence, so the check is off.
 */
async function resolveMode(
  fence: FixFence | undefined,
  workCwd: string,
  exec: ExecFn,
): Promise<Mode> {
  if (!fence) return { kind: "off" };
  const caller = await identify(fence.callerCwd, exec);
  if (caller.kind === "not-repo") {
    return { kind: "note", reason: "caller is not a git repository" };
  }
  if (caller.kind === "unreadable") {
    return {
      kind: "refused",
      reason: `caller-repo fence could not be armed (${caller.reason})`,
    };
  }
  const work = await identify(resolvePath(workCwd), exec);
  if (work.kind !== "repo") {
    return {
      kind: "invalid",
      reason: `workCwd ${workCwd} is not a git worktree`,
    };
  }
  if (work.commonDir !== caller.commonDir) {
    return {
      kind: "invalid",
      reason: `workCwd ${workCwd} is not a worktree of the calling repository (${caller.top})`,
    };
  }
  if (work.top === caller.top) return { kind: "off" };
  return {
    kind: "check",
    callerCwd: fence.callerCwd,
    callerTop: caller.top,
    workTop: work.top,
  };
}

/** Compare the caller snapshot after a round with the one before it. */
async function checkAfter(
  m: Extract<Mode, { kind: "check" }>,
  before: string[],
  round: number,
  exec: ExecFn,
): Promise<FenceRecord | undefined> {
  const after = await snapshotCaller(m.callerCwd, exec);
  if (after.kind !== "repo") {
    return {
      kind: "violation",
      round,
      text: `caller-repo check not completed (${describe(after)}): not checked, so the round cannot be approved`,
    };
  }
  const b = new Set(before);
  const a = new Set(after.entries);
  const delta = [...after.entries.filter((l) => !b.has(l)), ...before.filter((l) => !a.has(l))];
  if (delta.length === 0) return undefined;
  return {
    kind: "violation",
    round,
    text: `caller repository (${m.callerTop}) changed during the fix round (attribution not verified), outside workCwd (${m.workTop}): ${delta.join("; ")}`,
  };
}

/**
 * The fence for one loop run. `round` runs one fix dispatch under the fence:
 * the check after it runs in `finally`, so a dispatch that throws still has its
 * caller-repo writes recorded. Records accumulate into `records`.
 */
export function createFixFence(
  fence: FixFence | undefined,
  records: FenceRecord[],
  exec: ExecFn = execp,
) {
  let mode: Promise<Mode> | undefined;
  return {
    async round<T>(round: number, workCwd: string, fn: () => Promise<T>): Promise<FencedRound<T>> {
      mode ??= resolveMode(fence, workCwd, exec);
      const m = await mode;
      if (m.kind === "invalid") return { ran: false, outcome: "invalid-input", reason: m.reason };
      if (m.kind === "refused") return { ran: false, outcome: "infra-failure", reason: m.reason };
      if (m.kind === "off") return { ran: true, value: await fn() };
      if (m.kind === "note") {
        try {
          return { ran: true, value: await fn() };
        } finally {
          records.push({
            kind: "note",
            round,
            text: `caller-repo check did not run (${m.reason})`,
          });
        }
      }
      const before = await snapshotCaller(m.callerCwd, exec);
      if (before.kind !== "repo") {
        return {
          ran: false,
          outcome: "infra-failure",
          reason: `caller-repo fence could not be armed before fix round ${round} (${describe(before)})`,
        };
      }
      try {
        return { ran: true, value: await fn() };
      } finally {
        const rec = await checkAfter(m, before.entries, round, exec);
        if (rec) records.push(rec);
      }
    },
  };
}

/** Render fence records as the text the caller and the ledger both see. */
export function renderFenceRecords(records: FenceRecord[]): string[] {
  return records.map(
    (r) => `${r.kind === "violation" ? "VIOLATION" : "note"}: fix round ${r.round} ${r.text}`,
  );
}

/**
 * Prefix a result's text with the recorded fence findings (the ledger sees the
 * same text). A violation fails the result and an approval does not survive it:
 * callers keying on `ok` or `loopOutcome` must not read a breached or unchecked
 * run as clean. Notes leave both alone.
 */
export function withFixViolations(result: DispatchResult, records: FenceRecord[]): DispatchResult {
  if (records.length === 0) return result;
  const breached = records.some((r) => r.kind === "violation");
  return {
    ...result,
    ok: breached ? false : result.ok,
    loopOutcome: breached && result.loopOutcome === "approved" ? "rejected" : result.loopOutcome,
    text: [...renderFenceRecords(records), "", result.text].join("\n"),
  };
}
